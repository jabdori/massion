use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

fn cargo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn detached_supervisor_survives_the_host_and_answers_status() {
    let root = std::env::temp_dir().join(format!("massion-carrier-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let socket = root.join("daemon.sock");
    let log = root.join("daemon.log");
    let _ = std::fs::remove_file(&socket);

    let node = massion_carrier::daemon::node_binary().expect("node resolves in a debug build");
    let fixture = cargo_root().join("tests/fixture_supervisor.mjs");
    let args = vec![fixture.to_string_lossy().to_string(), socket.to_string_lossy().to_string()];
    let pid = massion_carrier::daemon::start_detached(&node, &args, &log).expect("supervisor starts detached");

    assert!(massion_carrier::daemon::wait_for_socket(&socket, Duration::from_secs(15)), "socket never answered");
    unsafe { assert_eq!(libc::kill(pid as libc::pid_t, 0), 0, "the detached supervisor died with its host") };

    let mut stream = UnixStream::connect(&socket).expect("status connection");
    stream.write_all(b"status\n").unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    let reply: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(reply["status"], "running");
    assert_eq!(reply["pid"].as_u64(), Some(u64::from(pid)));

    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    let reaped = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), 0) };
    assert_eq!(reaped, pid as i32, "supervisor did not stop on SIGTERM");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_socket_check_refuses_non_sockets_and_group_or_other_access() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("massion-carrier-mode-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("not-a-socket");
    std::fs::write(&file, b"x").unwrap();
    assert_eq!(massion_carrier::daemon::socket_is_private(&file).unwrap(), false);

    let socket = root.join("daemon.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let _ = listener;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(massion_carrier::daemon::socket_is_private(&socket).unwrap(), false);
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(massion_carrier::daemon::socket_is_private(&socket).unwrap(), true);
    let _ = std::fs::remove_dir_all(&root);
}
