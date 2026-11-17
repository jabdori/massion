use massion_carrier::daemon::{acquire_start_lock, start_detached};
use std::path::PathBuf;
use std::time::Duration;

/// The start lock's file descriptor is NOT inherited by the detached supervisor:
/// Rust opens files close-on-exec, so dropping the lock in the starter releases it
/// even while the child is still alive. If the descriptor were inherited, the child
/// would hold the lock for its whole lifetime and every later start would block.
#[test]
fn the_start_lock_is_not_inherited_by_the_detached_child() {
    let root = std::env::temp_dir().join(format!("massion-lock-inherit-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let socket = root.join("daemon.sock");
    let log = root.join("daemon.log");
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture = manifest.join("tests/fixture_supervisor.mjs");
    let node = massion_carrier::daemon::node_binary().expect("node resolves in a debug build");

    // Hold the lock the way ensure_supervisor does.
    let lock = acquire_start_lock(&socket).expect("the first holder acquires the lock");

    // Start a child the way start_detached does while the lock is held.
    let args = vec![fixture.to_string_lossy().to_string(), socket.to_string_lossy().to_string()];
    let pid = start_detached(&node, &args, &log).expect("the child starts");

    // Drop the lock; a second acquire must succeed IMMEDIATELY while the child lives.
    drop(lock);
    let second = acquire_start_lock(&socket).expect("a second acquire succeeds after the first holder drops the lock, even while the child lives");
    drop(second);

    // Clean up the child.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    let reaped = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), 0) };
    assert_eq!(reaped, pid as i32);
    let _ = std::fs::remove_dir_all(&root);
}
