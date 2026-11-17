use massion_carrier::daemon::acquire_start_lock;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// Kills the child and reaps it whenever the guard drops - on success and on
/// every assertion failure - so no fixture outlives the test.
struct ChildGuard(i32);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.0, libc::SIGKILL);
            libc::waitpid(self.0, std::ptr::null_mut(), 0);
        }
    }
}

/// Removes the scratch directory on every path.
struct DirGuard(std::path::PathBuf);
impl Drop for DirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Issue #225, two properties of the PRODUCT's start lock:
/// 1. it is exclusive while it is held - a second acquire_start_lock through
///    the product's own call blocks until the first holder releases it;
/// 2. the kernel releases it when the holder PROCESS dies - a real child
///    holding the lock is killed and the next acquire succeeds.
#[test]
fn the_start_lock_is_exclusive_and_dies_with_its_holder() {
    let root = std::env::temp_dir().join(format!("massion-lock-death-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let _dir = DirGuard(root.clone());
    let socket = root.join("daemon.sock");

    // Holder: the product's own acquire in a thread we can tell to release.
    let (held_tx, held_rx) = mpsc::channel::<Result<(), std::io::Error>>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let holder_socket = socket.clone();
    let holder = std::thread::spawn(move || {
        let lock = match acquire_start_lock(&holder_socket) {
            Ok(lock) => lock,
            Err(error) => return held_tx.send(Err(error)).unwrap(),
        };
        held_tx.send(Ok(())).unwrap();
        release_rx.recv().ok();
        drop(lock);
    });
    assert!(held_rx.recv_timeout(Duration::from_secs(10)).expect("the holder thread reports").is_ok(), "the product's lock is acquired");

    // A second acquire through the product's call must NOT return while the
    // holder lives; after the release it must complete promptly.
    let attempt_socket = socket.clone();
    let (acquired_tx, acquired_rx) = mpsc::channel();
    let attempt = std::thread::spawn(move || {
        acquired_tx.send(acquire_start_lock(&attempt_socket))
            .expect("the test is waiting for the second acquisition");
    });
    assert!(
        matches!(acquired_rx.recv_timeout(Duration::from_millis(800)), Err(mpsc::RecvTimeoutError::Timeout)),
        "the start lock must be exclusive while it is held"
    );
    release_tx.send(()).unwrap();
    holder.join().expect("the holder thread finishes");
    let acquired = acquired_rx.recv_timeout(Duration::from_secs(10))
        .expect("the second acquire completes once the holder releases")
        .expect("the second acquire succeeds after the release");
    attempt.join().expect("the acquisition thread finishes");
    drop(acquired);

    // And the kernel releases the lock when the holder PROCESS dies: a real
    // child (not our own call) holds it and is killed mid-hold.
    let lock_path = root.join("daemon.sock.lock");
    let script = "import fcntl,sys,time\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('held',flush=True)\ntime.sleep(3600)\n";
    let mut child = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(&lock_path)
        .stdout(Stdio::piped())
        .spawn()
        .expect("the holder fixture starts");
    let guard = ChildGuard(child.id() as i32);
    let stdout = child.stdout.take().unwrap();
    let (line_tx, line_rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = line_tx.send(line);
    });
    let line = line_rx.recv_timeout(Duration::from_secs(10)).expect("the fixture reports within the bound");
    assert_eq!(line.trim(), "held", "the fixture must hold the lock before it is killed");
    unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGKILL) };
    let reaped = unsafe { libc::waitpid(child.id() as i32, std::ptr::null_mut(), 0) };
    assert_eq!(reaped, child.id() as i32, "the holder process is dead");
    drop(guard);

    let acquired_by_dead = acquire_start_lock(&socket).expect("the lock is released when its holder process dies");
    drop(acquired_by_dead);
}
