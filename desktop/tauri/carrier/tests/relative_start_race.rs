use massion_carrier::daemon::{ensure_supervisor, SupervisorStart};
use std::path::PathBuf;
use std::sync::Barrier;
use std::time::Duration;

mod support;
use support::ask_status;

#[test]
fn long_data_directory_supports_relative_supervisor_start() {
    let root = std::env::temp_dir().join(format!("massion-relative-race-{}", std::process::id()));
    let data_dir = root.join("a".repeat(60)).join("b".repeat(60));
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir_all(&data_dir).unwrap();

    // This test target is separate so the spawn cannot inherit the stale-socket fixture's listener.
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "relative_race_in_data_directory"])
        .current_dir(&data_dir)
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
    let barrier = Barrier::new(2);
    let start = || {
        barrier.wait();
        ensure_supervisor(socket, &node, &args, Path::new("daemon.log"), Duration::from_secs(20), None)
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
