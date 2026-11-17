use massion_carrier::daemon::{ensure_supervisor, SupervisorStart};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Barrier};
use std::time::Duration;

fn make_stale_socket(root: &std::path::Path) -> PathBuf {
    let socket = root.join("daemon.sock");
    // Bind a listener and close it WITHOUT unlinking: the path remains and connects fail.
    let listener = UnixListener::bind(&socket).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    drop(listener);
    assert!(UnixStream::connect(&socket).is_err(), "the fixture socket must be stale");
    socket
}

fn ask_status(socket: &std::path::Path) -> u32 {
    let mut stream = UnixStream::connect(socket).expect("status connection");
    stream.write_all(b"status\n").unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    let reply: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    reply["pid"].as_u64().expect("a supervisor pid") as u32
}

#[test]
fn two_starters_released_together_start_exactly_one_supervisor() {
    let root = std::env::temp_dir().join(format!("massion-start-race-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let socket = make_stale_socket(&root);
    let log = root.join("daemon.log");
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture = manifest.join("tests/fixture_supervisor.mjs");
    let node = massion_carrier::daemon::node_binary().expect("node resolves in a debug build");
    let args = vec![fixture.to_string_lossy().to_string(), socket.to_string_lossy().to_string()];

    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let barrier = Arc::clone(&barrier);
        let socket = socket.clone();
        let args = args.clone();
        let log = log.clone();
        let node = node.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            let outcome = ensure_supervisor(&socket, &node, &args, &log, Duration::from_secs(20), None)
                .expect("both starters must succeed");
            let pid = ask_status(&socket);
            (outcome, pid)
        }));
    }
    let mut started = 0;
    let mut existing = 0;
    let mut pids = Vec::new();
    for handle in handles {
        let (outcome, pid) = handle.join().expect("starter thread");
        match outcome {
            SupervisorStart::Started(_) => started += 1,
            SupervisorStart::Existing => existing += 1,
        }
        pids.push(pid);
    }
    assert_eq!(started, 1, "exactly one starter may launch the supervisor");
    assert_eq!(existing, 1, "the losing starter must find the winner's supervisor");
    assert_eq!(pids[0], pids[1], "both starters must be connected to the same supervisor");

    // The review's reproduction no longer yields two: the winner's socket answers with
    // one pid, and a re-run of the whole start against the now-live socket is Existing.
    assert_eq!(
        ensure_supervisor(&socket, &node, &args, &log, Duration::from_secs(5), None).unwrap(),
        SupervisorStart::Existing
    );
    let live = ask_status(&socket);
    assert_eq!(live, pids[0]);
    unsafe { libc::kill(live as libc::pid_t, libc::SIGTERM) };
    let reaped = unsafe { libc::waitpid(live as i32, std::ptr::null_mut(), 0) };
    assert_eq!(reaped, live as i32);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn long_data_directory_supports_relative_supervisor_start() {
    let root = std::env::temp_dir().join(format!("massion-relative-race-{}", std::process::id()));
    let data_dir = root.join("a".repeat(60)).join("b".repeat(60));
    std::fs::create_dir_all(&data_dir).unwrap();

    // The child owns its cwd so the other tests can keep running in parallel.
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "relative_race_in_data_directory"])
        .current_dir(&data_dir)
        .env("MASSION_DESKTOP_HTML", "fixture/index.html")
        .output();
    std::fs::remove_dir_all(&root).unwrap();
    let result = result.expect("the isolated carrier test should run");
    let stdout = String::from_utf8_lossy(&result.stdout);
    assert!(
        result.status.success() && stdout.contains("relative_race_in_data_directory ... ok"),
        "isolated carrier test did not pass:\n{stdout}\n{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
#[ignore = "invoked by long_data_directory_supports_relative_supervisor_start with its own cwd"]
fn relative_race_in_data_directory() {
    use massion_carrier::daemon::{supervisor_command, SupervisorDirectories};
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::process::Command;

    let data_dir = std::env::current_dir().unwrap();
    let socket = Path::new("daemon.sock");
    let absolute_socket = data_dir.join(socket);
    assert!(absolute_socket.as_os_str().as_bytes().len() > 108);
    let node = massion_carrier::daemon::node_binary().unwrap();
    let result = Command::new(&node)
        .args([
            "-e",
            "const server = require('node:net').createServer(); server.on('error', e => { console.error(e.code); process.exitCode = 1; }); server.listen(process.argv[1], () => server.close());",
        ])
        .arg(&absolute_socket)
        .output()
        .expect("Node should attempt the absolute bind");
    assert_eq!(result.status.code(), Some(1), "the absolute bind must fail");
    assert_eq!(String::from_utf8_lossy(&result.stderr).trim(), "EINVAL");

    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixture_supervisor.mjs");
    let args = vec![fixture.to_str().unwrap().to_string(), socket.to_str().unwrap().to_string()];
    let caller = data_dir.parent().unwrap();
    let directories = SupervisorDirectories { caller, data: &data_dir };
    let command = supervisor_command(&node, Some(directories)).unwrap();
    let html = command.get_envs().find_map(|(name, value)| {
        if name == OsStr::new("MASSION_DESKTOP_HTML") { value } else { None }
    });
    let expected = caller.join("fixture/index.html");
    assert_eq!(html, Some(expected.as_os_str()), "the child environment must name the caller's HTML");
    let barrier = Barrier::new(2);
    let start = || {
        barrier.wait();
        ensure_supervisor(socket, &node, &args, Path::new("daemon.log"), Duration::from_secs(20), Some(directories))
    };
    let outcomes = std::thread::scope(|scope| {
        let first = scope.spawn(start);
        let second = scope.spawn(start);
        [first.join().unwrap(), second.join().unwrap()]
    });

    struct Running(Vec<u32>);
    impl Drop for Running {
        fn drop(&mut self) {
            for &pid in &self.0 {
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGTERM);
                    libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), 0);
                }
            }
        }
    }
    let running = Running(outcomes.iter().filter_map(|outcome| match outcome {
        Ok(SupervisorStart::Started(pid)) => Some(*pid),
        _ => None,
    }).collect());
    assert_eq!(running.0.len(), 1, "exactly one relative start must launch: {outcomes:?}");
    assert_eq!(
        outcomes.iter().filter(|outcome| matches!(outcome, Ok(SupervisorStart::Existing))).count(),
        1,
        "the other start must join by the relative name: {outcomes:?}"
    );
    assert_eq!(ask_status(socket), running.0[0], "the relative carrier connection must reach the winner");
}
