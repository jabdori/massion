use super::*;
use crate::LineClient;
use std::cell::{Cell, RefCell};
use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

fn drain_with(
    path: &Path,
    read: impl FnOnce(&mut io::Take<UnixStream>, &mut Vec<u8>) -> io::Result<usize>,
) -> Result<(), DrainFailure> {
    match DrainConnection::connect(path)? {
        Some(connection) => connection.drain_with(|| Some(()), read),
        None => Ok(()),
    }
}

struct Supervisor {
    listener: UnixListener,
    socket: PathBuf,
}

impl Supervisor {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mq1-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let socket = dir.join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        listener.set_nonblocking(true).unwrap();
        Self { listener, socket }
    }

    fn accept(&self) -> UnixStream {
        self.listener
            .accept()
            .expect("a new connection to the supervisor")
            .0
    }

    fn control_peer(&self, expected_command: &[u8]) -> UnixStream {
        let mut peer = self.accept();
        peer.set_nonblocking(false).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut request = Vec::new();
        peer.read_to_end(&mut request)
            .expect("control request bytes");
        assert_eq!(
            request.as_slice(),
            expected_command,
            "the write side sends and closes after exactly one line"
        );
        peer
    }

    fn reply(&self, answer: &[u8]) -> Result<(), DrainFailure> {
        drain_with(&self.socket, |stream, response| {
            let mut peer = self.control_peer(b"drain\n");
            peer.write_all(answer).unwrap();
            drop(peer);
            stream.read_to_end(response)
        })
    }

    fn status_reply(&self, answer: &[u8]) -> Result<StatusReply, StatusError> {
        query_status_with(&self.socket, STATUS_TIMEOUT, |stream, response| {
            let mut peer = self.control_peer(b"status\n");
            peer.write_all(answer).unwrap();
            drop(peer);
            stream.read_to_end(response)
        })
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        fs::remove_dir_all(self.socket.parent().unwrap()).unwrap();
    }
}

#[test]
fn drain_uses_a_new_half_closed_connection_and_leaves_the_relay_untouched() {
    let supervisor = Supervisor::new();
    let _client = LineClient::connect(&supervisor.socket, |_| {}).unwrap();
    let mut relay = supervisor.accept();
    let mut handshake = [0; 7];
    relay.read_exact(&mut handshake).unwrap();
    assert_eq!(&handshake, b"client\n");

    assert_eq!(
        supervisor.reply(br#"{"status":"drained"}"#),
        Ok(()),
        "complete drained reply succeeds"
    );
    relay.set_nonblocking(true).unwrap();
    assert_eq!(
        relay.read(&mut [0]).map_err(|error| error.kind()),
        Err(io::ErrorKind::WouldBlock),
        "no control bytes on the relay"
    );
}

#[test]
fn drain_reply_failures_are_distinct() {
    let supervisor = Supervisor::new();
    let oversized = vec![b' '; 1025];
    for (answer, expected) in [
        (&br#"{"status":"unsettled"}"#[..], DrainFailure::Unsettled),
        (
            &br#"{"status":"running"}"#[..],
            DrainFailure::UnexpectedStatus,
        ),
        (&br#"{"status":"drained""#[..], DrainFailure::TruncatedReply),
        (&[][..], DrainFailure::Disconnected),
        (&br#"["drained"]"#[..], DrainFailure::InvalidReply),
        (&br#"["unsettled"]"#[..], DrainFailure::InvalidReply),
        (
            &br#"{"status":"drained","extra":true}"#[..],
            DrainFailure::InvalidReply,
        ),
        (
            &br#"{"status":"drained"} {}"#[..],
            DrainFailure::InvalidReply,
        ),
        (
            &br#"{"status":"drained","status":"drained"}"#[..],
            DrainFailure::InvalidReply,
        ),
        (&oversized[..], DrainFailure::InvalidReply),
    ] {
        assert_eq!(
            supervisor.reply(answer),
            Err(expected),
            "{answer:?}: {expected:?}"
        );
    }
}

#[test]
fn drain_wait_requires_eof_and_distinguishes_timeout_from_disconnect() {
    let supervisor = Supervisor::new();
    let drained = br#"{"status":"drained"}"#;
    for (kind, answer, expected) in [
        (
            io::ErrorKind::TimedOut,
            &drained[..],
            DrainFailure::NoAnswer,
        ),
        (io::ErrorKind::WouldBlock, &[][..], DrainFailure::NoAnswer),
        (
            io::ErrorKind::ConnectionReset,
            &drained[..],
            DrainFailure::Disconnected,
        ),
        (io::ErrorKind::Other, &[][..], DrainFailure::TransportError),
    ] {
        let outcome = drain_with(&supervisor.socket, |stream, response| {
            let mut peer = supervisor.control_peer(b"drain\n");
            assert_eq!(
                stream.get_ref().read_timeout().unwrap(),
                Some(DRAIN_TIMEOUT),
                "the socket has the drain inactivity bound"
            );
            peer.write_all(answer).unwrap();
            response.resize(answer.len(), 0);
            stream.read_exact(response)?;
            Err(kind.into())
        });
        assert_eq!(
            outcome,
            Err(expected),
            "{kind:?} with {} response bytes",
            answer.len()
        );
    }
}

#[test]
fn drain_with_nothing_of_ours_to_drain_succeeds_and_touches_nothing() {
    let supervisor = Supervisor::new();
    // The socket path does not exist.
    assert_eq!(
        drain(&supervisor.socket.with_file_name("missing")),
        Ok(()),
        "a missing socket path is nothing to drain"
    );

    // A stale socket file: still private, but nothing accepts any more.
    let stale = supervisor.socket.with_file_name("stale.sock");
    let stale_listener = UnixListener::bind(&stale).unwrap();
    fs::set_permissions(&stale, fs::Permissions::from_mode(0o600)).unwrap();
    drop(stale_listener);
    assert_eq!(
        drain(&stale),
        Ok(()),
        "a stale socket file is nothing to drain"
    );
    assert!(
        fs::symlink_metadata(&stale)
            .unwrap()
            .file_type()
            .is_socket(),
        "the stale socket file is left in place"
    );

    // A directory at the socket path is not ours: untouched.
    let directory = supervisor.socket.with_file_name("occupied");
    DirBuilder::new().mode(0o700).create(&directory).unwrap();
    assert_eq!(
        drain(&directory),
        Ok(()),
        "a foreign path is not ours to drain"
    );
    assert!(
        fs::symlink_metadata(&directory).unwrap().is_dir(),
        "the directory stays a directory"
    );
    assert_eq!(
        fs::read_dir(&directory).unwrap().count(),
        0,
        "nothing was written into the directory"
    );

    // Wider permissions: not this user's private socket; no connection is
    // made to it and nothing about it changes.
    fs::set_permissions(&supervisor.socket, fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(
        drain(&supervisor.socket),
        Ok(()),
        "a non-private socket is not ours to drain"
    );
    assert_eq!(
        supervisor.listener.accept().err().map(|error| error.kind()),
        Some(io::ErrorKind::WouldBlock),
        "no connection to the non-private socket"
    );
    let metadata = fs::symlink_metadata(&supervisor.socket).unwrap();
    assert!(
        metadata.file_type().is_socket(),
        "the foreign socket stays a socket"
    );
    assert_eq!(
        metadata.permissions().mode() & 0o777,
        0o666,
        "the foreign socket's permissions are unchanged"
    );
}

#[test]
fn drain_still_fails_when_the_path_cannot_be_read() {
    let root = std::env::temp_dir().join(format!("mq1-{}-unreadable", std::process::id()));
    DirBuilder::new().mode(0o700).create(&root).unwrap();
    let socket = root.join("daemon.sock");
    UnixListener::bind(&socket).unwrap();
    // Without search permission on the parent, the privacy check itself fails
    // with a permission error: something may be there, so it is not claimed
    // as a confirmed drain.
    fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).unwrap();
    let outcome = DrainConnection::connect(&socket);
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    match outcome {
        Err(DrainFailure::NotConnected) => {}
        _ => panic!("an unreadable path stays a failure instead of a claimed drain"),
    }
    fs::remove_dir_all(&root).unwrap();
}

const TEST_BOUND: Duration = Duration::from_secs(5);
const LOOKUP_BOUND: Duration = Duration::from_secs(30);

type SocketLookup = Box<dyn FnOnce(&Path) -> io::Result<bool> + Send>;
type ConnectResult = Result<Option<DrainConnection>, DrainFailure>;

thread_local! {
    static SOCKET_LOOKUP: Cell<Option<SocketLookup>> = const { Cell::new(None) };
    static CONNECT_TIMER: RefCell<Option<ConnectTimer>> = const { RefCell::new(None) };
    static CAPACITY_WAIT: Cell<Option<mpsc::Sender<()>>> = const { Cell::new(None) };
}

pub(super) fn socket_lookup() -> impl FnOnce(&Path) -> io::Result<bool> + Send {
    let lookup = SOCKET_LOOKUP.take();
    move |path| match lookup {
        Some(lookup) => lookup(path),
        None => crate::daemon::socket_is_private(path),
    }
}

struct ConnectTimer {
    now: Instant,
    pending: mpsc::Sender<Instant>,
    advances: mpsc::Receiver<Instant>,
}

pub(super) fn connect_now() -> Instant {
    CONNECT_TIMER.with_borrow(|timer| timer.as_ref().map_or_else(Instant::now, |timer| timer.now))
}

pub(super) struct ConnectReceiver(pub(super) mpsc::Receiver<ConnectResult>);

impl ConnectReceiver {
    pub(super) fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<ConnectResult, mpsc::RecvTimeoutError> {
        CONNECT_TIMER.with_borrow_mut(|timer| {
            let Some(timer) = timer else {
                return self.0.recv_timeout(timeout);
            };
            let expiry = timer.now + timeout;
            while timer.now < expiry {
                timer.pending.send(expiry).unwrap();
                timer.now = timer.advances.recv_timeout(TEST_BOUND).unwrap();
            }
            Err(mpsc::RecvTimeoutError::Timeout)
        })
    }
}

pub(super) fn observe_capacity(active: usize) {
    if active == 2 {
        if let Some(waiting) = CAPACITY_WAIT.take() {
            waiting.send(()).unwrap();
        }
    }
}

fn join_connect<T>(worker: thread::JoinHandle<T>, timeout: Duration) -> T {
    let deadline = Instant::now() + timeout;
    while !worker.is_finished() {
        assert!(Instant::now() < deadline, "connect worker did not finish");
        thread::sleep(Duration::from_millis(1));
    }
    worker.join().unwrap()
}

struct StalledConnect {
    deadline: Instant,
    advance: mpsc::Sender<Instant>,
    waiting: mpsc::Receiver<Instant>,
    resume: mpsc::Sender<()>,
    worker: thread::JoinHandle<(ConnectResult, Instant)>,
}

impl StalledConnect {
    fn start(
        path: &Path,
        connect: impl FnOnce(&Path, Instant, SocketLookup) -> ConnectResult + Send + 'static,
    ) -> Self {
        let path = path.to_owned();
        let (entered, started) = mpsc::channel();
        let (resume, held) = mpsc::channel();
        let (pending, waiting) = mpsc::channel();
        let (advance, advances) = mpsc::channel();
        let start = Instant::now();
        let deadline = start + DRAIN_TIMEOUT;
        let worker = thread::spawn(move || {
            CONNECT_TIMER.replace(Some(ConnectTimer {
                now: start,
                pending,
                advances,
            }));
            let lookup = Box::new(move |_: &Path| {
                entered.send(()).map_err(|_| io::ErrorKind::BrokenPipe)?;
                held.recv_timeout(LOOKUP_BOUND)
                    .map_err(|_| io::ErrorKind::TimedOut)?;
                Ok(false)
            });
            let outcome = connect(&path, deadline, lookup);
            (outcome, connect_now())
        });
        started.recv_timeout(TEST_BOUND).unwrap();
        Self {
            deadline,
            advance,
            waiting,
            resume,
            worker,
        }
    }

    fn expire(self) -> mpsc::Sender<()> {
        self.advance.send(self.deadline).unwrap();
        let (outcome, finished_at) = join_connect(self.worker, TEST_BOUND);
        assert!(matches!(outcome, Err(DrainFailure::NoAnswer)));
        assert_eq!(finished_at, self.deadline);
        self.resume
    }
}

#[test]
fn quit_connect_expires_at_its_deadline_and_retry_connects_during_the_lookup() {
    let supervisor = Supervisor::new();
    let attempt = StalledConnect::start(&supervisor.socket, |path, deadline, lookup| {
        SOCKET_LOOKUP.set(Some(lookup));
        DrainConnection::connect_until(path, deadline)
    });
    assert_eq!(
        attempt
            .waiting
            .recv_timeout(TEST_BOUND)
            .expect("quit connect must wait on its timer while the lookup is blocked"),
        attempt.deadline,
        "quit connect must arm its timer for the attempt deadline"
    );

    attempt
        .advance
        .send(attempt.deadline - Duration::from_nanos(1))
        .unwrap();
    assert_eq!(
        attempt.waiting.recv_timeout(TEST_BOUND).unwrap(),
        attempt.deadline,
        "quit connect must still be waiting just before the deadline"
    );
    assert!(!attempt.worker.is_finished());
    let resume = attempt.expire();

    assert!(
        DrainConnection::connect_until(&supervisor.socket, Instant::now() + TEST_BOUND)
            .unwrap()
            .is_some(),
        "the retry must connect while the first lookup is still blocked"
    );
    let _retry = supervisor.accept();
    resume.send(()).unwrap();
}

#[test]
fn a_queued_retry_connects_when_one_of_two_busy_helpers_becomes_available() {
    static WORKERS: ConnectWorkers = ConnectWorkers::new();
    let supervisor = Supervisor::new();
    let occupy_helper = || {
        StalledConnect::start(&supervisor.socket, |path, deadline, lookup| {
            WORKERS.connect_until(path, deadline, lookup)
        })
        .expire()
    };
    let resume_first = occupy_helper();
    let resume_second = occupy_helper();
    let (entered, third_lookup) = mpsc::channel();
    assert!(matches!(
        WORKERS.connect_until(
            &supervisor.socket,
            Instant::now() + Duration::from_millis(250),
            move |path| {
                entered.send(()).unwrap();
                crate::daemon::socket_is_private(path)
            },
        ),
        Err(DrainFailure::NoAnswer)
    ));
    assert_eq!(
        third_lookup.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    );
    let (waiting, queued) = mpsc::channel();
    let path = supervisor.socket.clone();
    let retry = thread::spawn(move || {
        CAPACITY_WAIT.set(Some(waiting));
        let deadline = Instant::now() + 2 * TEST_BOUND;
        let outcome = WORKERS.connect_until(&path, deadline, crate::daemon::socket_is_private);
        (outcome, Instant::now(), deadline)
    });
    queued
        .recv_timeout(TEST_BOUND)
        .expect("retry must observe both helpers occupied");
    // The observer runs under the capacity mutex, so the first worker cannot
    // return its permit until the retry parks on the condition variable.
    resume_first.send(()).unwrap();
    let (outcome, finished_at, deadline) = join_connect(retry, 3 * TEST_BOUND);
    assert!(
        matches!(outcome, Ok(Some(_))),
        "returning one permit must wake the queued retry"
    );
    assert!(finished_at < deadline);
    let _retry = supervisor.accept();
    resume_second
        .send(())
        .expect("the other lookup must still be blocked");
}

#[test]
fn expired_connect_never_reaches_the_listener() {
    let supervisor = Supervisor::new();
    let mut lookups = 0;
    assert!(matches!(
        DrainConnection::connect_path_until(&supervisor.socket, Instant::now(), |path| {
            lookups += 1;
            crate::daemon::socket_is_private(path)
        }),
        Err(DrainFailure::NoAnswer)
    ));
    assert_eq!(lookups, 0, "an expired attempt must skip the path lookup");
    assert_eq!(
        supervisor.listener.accept().unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

#[cfg(target_os = "linux")]
#[test]
fn full_unix_accept_queue_expires_without_accepting() {
    use std::os::fd::AsRawFd;
    use std::sync::mpsc;
    use std::thread;

    let supervisor = Supervisor::new();
    // Linux allows one queued connection even with a backlog of zero.
    assert_eq!(
        unsafe { libc::listen(supervisor.listener.as_raw_fd(), 0) },
        0
    );
    let _queued = UnixStream::connect(&supervisor.socket).unwrap();
    let path = supervisor.socket.clone();
    let (send, receive) = mpsc::channel();
    let worker = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(250);
        let outcome =
            DrainConnection::connect_path_until(&path, deadline, crate::daemon::socket_is_private);
        send.send((deadline, Instant::now(), outcome)).unwrap();
    });
    let outcome = receive.recv_timeout(Duration::from_secs(5));
    // Closing the listener also wakes a blocking connect if the test regresses.
    drop(supervisor);
    let join_deadline = Instant::now() + Duration::from_secs(5);
    while !worker.is_finished() {
        assert!(
            Instant::now() < join_deadline,
            "connect worker did not finish"
        );
        thread::sleep(Duration::from_millis(1));
    }
    worker.join().unwrap();
    let (deadline, finished_at, outcome) =
        outcome.expect("connect did not return within the test bound");
    assert!(
        matches!(outcome, Err(DrainFailure::NoAnswer)),
        "a full queue must time out without an accept"
    );
    assert!(
        finished_at >= deadline,
        "connect returned before the 250 ms deadline"
    );
    assert!(
        finished_at <= deadline + Duration::from_secs(1),
        "connect overran the 250 ms deadline by more than one second"
    );
}

#[test]
fn status_query_parses_all_states_and_treats_missing_draining_as_false() {
    let supervisor = Supervisor::new();
    let older_running = supervisor
        .status_reply(br#"{"status":"running","pid":42,"origin":"http://127.0.0.1:8765"}"#)
        .expect("older supervisor reply without draining parses");
    assert_eq!(
        older_running,
        StatusReply {
            status: "running".to_string(),
            pid: Some(42),
            origin: Some("http://127.0.0.1:8765".to_string()),
            draining: false,
            cause: None,
            detail: None,
        }
    );

    let draining_running = supervisor
        .status_reply(
            br#"{"status":"running","pid":42,"origin":"http://127.0.0.1:8765","draining":true}"#,
        )
        .expect("draining reply parses");
    assert!(draining_running.draining);

    let starting = supervisor
        .status_reply(br#"{"status":"starting","pid":42,"origin":"http://127.0.0.1:8765"}"#)
        .expect("starting reply parses");
    assert_eq!(starting.status, "starting");
    assert!(!starting.draining);

    let failed = supervisor
        .status_reply(
            br#"{"status":"failed","pid":42,"origin":"http://127.0.0.1:8765","cause":"database-start","detail":"db exited"}"#,
        )
        .expect("failed reply parses");
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.cause.as_deref(), Some("database-start"));
    assert_eq!(failed.detail.as_deref(), Some("db exited"));
}

#[test]
fn status_query_rejects_malformed_truncated_oversized_empty_and_timed_out_replies() {
    let supervisor = Supervisor::new();
    let oversized = vec![b' '; 1025];
    for (answer, expected) in [
        (&[][..], StatusError::Disconnected),
        (&br#"{"status":"running""#[..], StatusError::TruncatedReply),
        (&br#"["running"]"#[..], StatusError::InvalidReply),
        (&br#"{"origin":"http://127.0.0.1:8765"}"#[..], StatusError::InvalidReply),
        (&br#"{"status":"running","extra":true}"#[..], StatusError::InvalidReply),
        (&br#"{"status":"running"} {}"#[..], StatusError::InvalidReply),
        (
            &br#"{"status":"running","status":"running"}"#[..],
            StatusError::InvalidReply,
        ),
        (
            &br#"{"status":"running","draining":"yes"}"#[..],
            StatusError::InvalidReply,
        ),
        (&oversized[..], StatusError::InvalidReply),
    ] {
        assert_eq!(
            supervisor.status_reply(answer),
            Err(expected),
            "{answer:?}: {expected:?}"
        );
    }

    let timeout_outcome = query_status_with(
        &supervisor.socket,
        Duration::from_secs(5),
        |stream, _| {
            let _peer = supervisor.control_peer(b"status\n");
            assert_eq!(
                stream.get_ref().read_timeout().unwrap(),
                Some(STATUS_TIMEOUT),
                "the status socket timeout is capped at STATUS_TIMEOUT"
            );
            Err(io::ErrorKind::TimedOut.into())
        },
    );
    assert_eq!(timeout_outcome, Err(StatusError::NoAnswer));
    assert_eq!(
        query_status(&supervisor.socket, Duration::ZERO),
        Err(StatusError::NoAnswer)
    );
}

#[test]
fn status_query_distinguishes_not_listening_and_non_private_sockets() {
    let supervisor = Supervisor::new();
    assert_eq!(
        query_status(&supervisor.socket.with_file_name("missing"), STATUS_TIMEOUT),
        Err(StatusError::NotListening)
    );

    let stale = supervisor.socket.with_file_name("stale.sock");
    let stale_listener = UnixListener::bind(&stale).unwrap();
    fs::set_permissions(&stale, fs::Permissions::from_mode(0o600)).unwrap();
    drop(stale_listener);
    assert_eq!(
        query_status(&stale, STATUS_TIMEOUT),
        Err(StatusError::NotListening)
    );

    fs::set_permissions(&supervisor.socket, fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(
        query_status(&supervisor.socket, STATUS_TIMEOUT),
        Err(StatusError::NotPrivate)
    );
    assert_eq!(
        supervisor.listener.accept().err().map(|error| error.kind()),
        Some(io::ErrorKind::WouldBlock),
        "no connection to the non-private socket"
    );
}
