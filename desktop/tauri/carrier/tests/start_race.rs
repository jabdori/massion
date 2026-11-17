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
