use massion_carrier::daemon::acquire_start_lock;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

/// Issue #225: the start lock is held with flock(2), so the KERNEL releases it
/// when the holder PROCESS dies. A starter killed inside the start section
/// cannot deadlock the next start: a real child process holds the lock, is
/// killed, and the next acquire must succeed without anyone cleaning up.
#[test]
fn the_start_lock_is_released_when_the_holder_process_dies() {
    let root = std::env::temp_dir().join(format!("massion-lock-death-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let socket = root.join("daemon.sock");
    let lock_path = root.join("daemon.sock.lock");
    let script = "import fcntl,sys,time\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('held',flush=True)\ntime.sleep(3600)\n";

    let mut child = Command::new("python3")
        .arg("-c")
        .arg(script)
        .arg(&lock_path)
        .stdout(Stdio::piped())
        .spawn()
        .expect("the holder fixture starts");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "held", "the fixture must hold the lock before it is killed");

    // The PRODUCT's lock must be exclusive while its holder lives: an
    // acquisition attempt through acquire_start_lock now must not return
    // (review note 5) - only the holder's death may let it through.
    let attempt = {
        let socket = socket.clone();
        std::thread::spawn(move || acquire_start_lock(&socket))
    };
    std::thread::sleep(std::time::Duration::from_millis(800));
    assert!(!attempt.is_finished(), "the start lock must be exclusive while its holder lives");

    unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGKILL) };
    let reaped = unsafe { libc::waitpid(child.id() as i32, std::ptr::null_mut(), 0) };
    assert_eq!(reaped, child.id() as i32, "the holder process is dead");

    let lock = attempt.join().expect("the acquisition thread completes once the holder dies").expect("the lock is released when its holder process dies");
    drop(lock);
    let _ = std::fs::remove_dir_all(&root);
}
