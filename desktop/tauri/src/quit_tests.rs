use super::*;
use std::cell::RefCell;

use std::io::Read;
use std::os::unix::net::{UnixListener, UnixStream};
use std::thread::{self, JoinHandle};

struct Supervisor {
    listener: UnixListener,
    socket: PathBuf,
}

impl Supervisor {
    fn new(name: &str) -> Self {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let dir = std::env::temp_dir().join(format!("mq1-{}-{name}", std::process::id()));
        std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let socket = dir.join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        listener.set_nonblocking(true).unwrap();
        Self { listener, socket }
    }

    fn accept(&self) -> UnixStream {
        self.listener
            .accept()
            .expect("supervisor accepted a connection")
            .0
    }

    fn assert_no_connection(&self) {
        assert_eq!(
            self.listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    fn accepted_connections(&self) -> Vec<UnixStream> {
        let mut peers = Vec::new();
        loop {
            match self.listener.accept() {
                Ok((peer, _)) => peers.push(peer),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return peers,
                Err(error) => panic!("supervisor accept failed: {error}"),
            }
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        std::fs::remove_dir_all(self.socket.parent().unwrap()).unwrap();
    }
}

fn start_attempt(
    quit: &Arc<Mutex<QuitState>>,
    connect: impl FnOnce() -> Result<DrainConnection, DrainFailure> + Send + 'static,
) -> Option<(
    Arc<QuitAttempt>,
    mpsc::Receiver<QuitOutcome>,
    JoinHandle<()>,
)> {
    let mut started = None;
    begin_quit(quit, |attempt| {
        let quit = quit.clone();
        let worker_attempt = attempt.clone();
        let (report, completion) = mpsc::channel();
        let worker = thread::spawn(move || {
            run_quit_attempt(&quit, &worker_attempt, connect, |outcome| {
                report.send(outcome).unwrap();
            })
        });
        started = Some((attempt, completion, worker));
    });
    started
}

fn hold_connect(
    socket: &Path,
) -> (
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
    mpsc::Receiver<()>,
    impl FnOnce() -> Result<DrainConnection, DrainFailure>,
) {
    let socket = socket.to_path_buf();
    let (entered, connecting) = mpsc::channel();
    let (release, held) = mpsc::channel();
    let (connected, ready) = mpsc::channel();
    (connecting, release, ready, move || {
        entered.send(()).unwrap();
        held.recv_timeout(Duration::from_secs(5)).unwrap();
        let connection = DrainConnection::connect(&socket);
        connected.send(()).unwrap();
        connection
    })
}

fn answer_drain(mut peer: UnixStream) {
    use std::io::Write;
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut request = Vec::new();
    peer.read_to_end(&mut request).unwrap();
    assert_eq!(request, b"drain\n");
    peer.write_all(br#"{"status":"drained"}"#).unwrap();
}

#[test]
fn duplicate_selection_sends_one_accepted_request_and_early_completion_exits_once() {
    let supervisor = Supervisor::new("early");
    let quit = Arc::new(Mutex::new(QuitState::default()));
    let (connecting, release, ready, connect) = hold_connect(&supervisor.socket);
    let (attempt, completion, worker) = start_attempt(&quit, connect).unwrap();
    connecting.recv_timeout(Duration::from_secs(5)).unwrap();
    let socket = supervisor.socket.clone();
    let (connected, second_ready) = mpsc::channel();
    let duplicate = start_attempt(&quit, move || {
        let connection = DrainConnection::connect(&socket);
        connected.send(()).unwrap();
        connection
    });
    release.send(()).unwrap();
    let mut exits = Vec::new();
    assert!(exits.is_empty(), "there is no exit while waiting");
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    if duplicate.is_some() {
        second_ready.recv_timeout(Duration::from_secs(5)).unwrap();
    }
    let mut peers = supervisor.accepted_connections();
    assert_eq!(
        peers.len(),
        1,
        "the supervisor accepted one request connection"
    );
    answer_drain(peers.pop().unwrap());
    let outcome = wait_for_quit(&attempt, |remaining| completion.recv_timeout(remaining));
    finish_quit(
        &quit,
        &attempt,
        outcome,
        |code| exits.push(code),
        |_| panic!("unexpected failure"),
        || panic!("unexpected show"),
    );
    assert_eq!(exits, [0], "success requests one normal exit");
    let socket = supervisor.socket.clone();
    assert!(
        start_attempt(&quit, move || DrainConnection::connect(&socket)).is_none(),
        "a queued selection cannot restart an accepted quit"
    );
    supervisor.assert_no_connection();
    worker.join().unwrap();
}

#[test]
fn expiry_during_connect_allows_retry_and_disarms_the_old_worker() {
    let supervisor = Supervisor::new("expiry");
    let quit = Arc::new(Mutex::new(QuitState::default()));
    let (connecting, release, ready, connect) = hold_connect(&supervisor.socket);
    let (attempt, completion, worker) = start_attempt(&quit, connect).unwrap();
    connecting.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(completion.try_recv(), Err(mpsc::TryRecvError::Empty));
    supervisor.assert_no_connection();

    let mut reported = Vec::new();
    let mut shown = 0;
    let expiry = wait_for_quit(&attempt, |_| Err(mpsc::RecvTimeoutError::Timeout));
    finish_quit(
        &quit,
        &attempt,
        expiry,
        |_| panic!("expired quit exited"),
        |payload| reported.push(payload),
        || shown += 1,
    );
    assert_eq!(
        *quit.lock().unwrap(),
        QuitState::Failed(DrainFailure::NoAnswer)
    );
    assert_eq!(
        reported,
        [serde_json::json!({"quitFailure": "quit-no-answer"})]
    );
    assert_eq!(shown, 1, "expiry requests that the window be shown");

    let (retrying, release_retry, retry_ready, connect_retry) = hold_connect(&supervisor.socket);
    let (retry, new_completion, new_worker) = start_attempt(&quit, connect_retry).unwrap();
    retrying.recv_timeout(Duration::from_secs(5)).unwrap();
    release_retry.send(()).unwrap();
    retry_ready.recv_timeout(Duration::from_secs(5)).unwrap();
    answer_drain(supervisor.accept());
    supervisor.assert_no_connection();

    release.send(()).unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut stale_peer = supervisor.accept();
    stale_peer.set_nonblocking(false).unwrap();
    assert_eq!(
        stale_peer.read(&mut [0; 6]).unwrap(),
        0,
        "the old worker sent bytes after expiry"
    );
    worker.join().unwrap();
    assert_eq!(
        completion.try_recv(),
        Err(mpsc::TryRecvError::Disconnected),
        "the old worker reported a result"
    );

    // A result already queued for the main thread must also lose to expiry.
    finish_quit(
        &quit,
        &attempt,
        Ok(()),
        |_| panic!("stale completion exited"),
        |_| panic!("stale failure"),
        || panic!("stale show"),
    );
    assert!(is_current_quit(&quit.lock().unwrap(), &retry));
    let outcome = wait_for_quit(&retry, |remaining| new_completion.recv_timeout(remaining));
    let mut exits = Vec::new();
    finish_quit(
        &quit,
        &retry,
        outcome,
        |code| exits.push(code),
        |_| panic!("retry failed"),
        || panic!("retry showed the window"),
    );
    assert_eq!(exits, [0]);
    new_worker.join().unwrap();
}

#[test]
fn quit_failure_is_tagged_reported_and_shown_and_can_retry() {
    for (reason, code) in [
        (DrainFailure::NotConnected, "quit-not-connected"),
        (DrainFailure::NoAnswer, "quit-no-answer"),
        (DrainFailure::Disconnected, "quit-disconnected"),
        (DrainFailure::TransportError, "quit-transport-error"),
        (DrainFailure::Unsettled, "quit-unsettled"),
        (DrainFailure::UnexpectedStatus, "quit-unexpected-status"),
        (DrainFailure::TruncatedReply, "quit-truncated-reply"),
        (DrainFailure::InvalidReply, "quit-invalid-reply"),
    ] {
        let state = Mutex::new(QuitState::default());
        let mut requests = 0;
        let mut exits = 0;
        let mut shown = 0;
        let mut reported = Vec::new();
        let mut started = None;
        begin_quit(&state, |attempt| {
            requests += 1;
            started = Some(attempt);
        });
        finish_quit(
            &state,
            &started.unwrap(),
            Err(reason),
            |_| exits += 1,
            |payload| reported.push(payload),
            || shown += 1,
        );
        assert_eq!(exits, 0, "{code}: keep the host running");
        assert_eq!(
            *state.lock().unwrap(),
            QuitState::Failed(reason),
            "{code}: store the reason"
        );
        assert_eq!(
            reported,
            [serde_json::json!({"quitFailure": code})],
            "{code}: report the reason to the screen"
        );
        assert_eq!(shown, 1, "{code}: show the window");
        begin_quit(&state, |_| requests += 1);
        assert_eq!(requests, 2, "{code}: retry starts a second attempt");
    }
}

#[test]
fn close_prevents_destruction_and_hides_the_window() {
    let actions = RefCell::new(Vec::new());
    hide_on_close(
        || actions.borrow_mut().push("prevent"),
        || {
            actions.borrow_mut().push("hide");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(actions.into_inner(), ["prevent", "hide"]);
}

#[test]
fn reveal_window_requests_show_unminimize_and_focus_in_order() {
    let actions = RefCell::new(Vec::new());
    reveal_window(
        || {
            actions.borrow_mut().push("show");
            Ok(())
        },
        || {
            actions.borrow_mut().push("unminimize");
            Ok(())
        },
        || {
            actions.borrow_mut().push("focus");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(actions.into_inner(), ["show", "unminimize", "focus"]);
}

#[test]
fn tracked_notification_click_requests_window_reveal() {
    let state = HostState::default();
    state
        .notification_keys
        .lock()
        .unwrap()
        .insert(7, "mission".into());
    let mut revealed = false;
    notification_clicked(&state, Some(7), || revealed = true);
    assert!(revealed, "a tracked notification click reveals the window");
    notification_clicked(&state, Some(8), || {
        panic!("untracked click revealed the window")
    });
}
