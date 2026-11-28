use super::*;
use std::cell::RefCell;

use std::io::Read;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc;
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
    connect: impl FnOnce() -> Result<Option<DrainConnection>, DrainFailure> + Send + 'static,
) -> Option<(
    Arc<QuitAttempt>,
    mpsc::Receiver<QuitOutcome>,
    JoinHandle<()>,
)> {
    let mut started = None;
    begin_quit(
        quit,
        || false,
        |attempt| {
            let quit = quit.clone();
            let worker_attempt = attempt.clone();
            let (report, completion) = mpsc::channel();
            let worker = thread::Builder::new().spawn(move || {
                run_quit_attempt(&quit, &worker_attempt, connect, |outcome| {
                    report.send(outcome).unwrap();
                });
            })?;
            started = Some((attempt, completion, worker));
            Ok(())
        },
        |_, reason| panic!("test worker failed to start: {reason:?}"),
    );
    started
}

fn hold_connect(
    socket: &Path,
) -> (
    mpsc::Receiver<()>,
    mpsc::Sender<()>,
    mpsc::Receiver<()>,
    impl FnOnce() -> Result<Option<DrainConnection>, DrainFailure>,
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

/// One temporary directory for the nothing-to-drain rows, mirroring
/// Supervisor's own layout so cleanup stays symmetric.
fn nothing_dir(name: &str) -> PathBuf {
    use std::os::unix::fs::DirBuilderExt;
    let dir = std::env::temp_dir().join(format!("mq1-{}-{name}", std::process::id()));
    std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
    dir
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
    let outcome = completion.recv_timeout(Duration::from_secs(5)).unwrap();
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
    finish_quit(
        &quit,
        &attempt,
        Err(DrainFailure::NoAnswer),
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
    let outcome = new_completion.recv_timeout(Duration::from_secs(5)).unwrap();
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
fn connect_start_failure_sends_nothing_and_the_next_selection_exits() {
    let supervisor = Supervisor::new("start");
    let quit = Arc::new(Mutex::new(QuitState::default()));
    let mut exits = Vec::new();
    let mut reported = Vec::new();
    let mut shown = 0;
    begin_quit(
        &quit,
        || false,
        |_| Err(std::io::ErrorKind::WouldBlock.into()),
        |attempt, reason| {
            finish_quit(
                &quit,
                &attempt,
                Err(reason),
                |code| exits.push(code),
                |payload| reported.push(payload),
                || shown += 1,
            );
        },
    );
    supervisor.assert_no_connection();
    assert!(exits.is_empty());
    assert_eq!(
        *quit.lock().unwrap(),
        QuitState::Failed(DrainFailure::StartFailed)
    );
    assert_eq!(
        reported,
        [serde_json::json!({"quitFailure": "quit-start-failed"})]
    );
    assert_eq!(shown, 1);

    let (connecting, release, ready, connect) = hold_connect(&supervisor.socket);
    let (attempt, completion, worker) = start_attempt(&quit, connect).unwrap();
    connecting.recv_timeout(Duration::from_secs(5)).unwrap();
    release.send(()).unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    answer_drain(supervisor.accept());
    supervisor.assert_no_connection();
    finish_quit(
        &quit,
        &attempt,
        completion.recv_timeout(Duration::from_secs(5)).unwrap(),
        |code| exits.push(code),
        |_| panic!("retry failed"),
        || panic!("retry showed the window"),
    );
    assert_eq!(exits, [0]);
    worker.join().unwrap();
}

#[test]
fn quit_handler_recovers_a_poisoned_state_lock() {
    let quit = Mutex::new(QuitState::default());
    assert!(thread::scope(|scope| {
        scope
            .spawn(|| {
                let _guard = quit.lock().unwrap();
                panic!("poison the quit state");
            })
            .join()
            .is_err()
    }));
    assert!(quit.is_poisoned());
    let mut exits = Vec::new();
    begin_quit(
        &quit,
        || false,
        |attempt| {
            assert!(current_quit(&quit, &attempt).is_some());
            finish_quit(
                &quit,
                &attempt,
                Ok(()),
                |code| exits.push(code),
                |_| panic!("poisoned-state quit failed"),
                || panic!("poisoned-state quit showed the window"),
            );
            Ok(())
        },
        |_, _| panic!("poisoned-state quit failed to start"),
    );
    assert_eq!(exits, [0]);
}

#[test]
fn current_quit_rejects_success_decided_after_its_deadline() {
    let attempt = Arc::new(QuitAttempt {
        deadline: Instant::now(),
        restart: false,
    });
    let quit = Mutex::new(QuitState::Waiting(attempt.clone()));
    let mut reported = Vec::new();
    let mut shown = 0;
    finish_quit(
        &quit,
        &attempt,
        Ok(()),
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
    assert_eq!(shown, 1);
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
        begin_quit(
            &state,
            || false,
            |attempt| {
                requests += 1;
                started = Some(attempt);
                Ok(())
            },
            |_, reason| panic!("quit failed to start: {reason:?}"),
        );
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
        begin_quit(
            &state,
            || false,
            |_| {
                requests += 1;
                Ok(())
            },
            |_, reason| panic!("quit retry failed to start: {reason:?}"),
        );
        assert_eq!(requests, 2, "{code}: retry starts a second attempt");
    }
}

#[test]
fn quit_exits_when_no_supervisor_of_ours_is_there_to_drain() {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    for name in ["gone-removed", "gone-stale", "occupied-directory"] {
        let dir = nothing_dir(name);
        let socket = dir.join("daemon.sock");
        match name {
            // A private socket file whose listener is gone: connect is refused.
            "gone-stale" => {
                let listener = UnixListener::bind(&socket).unwrap();
                std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
                drop(listener);
            }
            // A directory at the socket path is not ours; it must be untouched.
            "occupied-directory" => {
                std::fs::DirBuilder::new()
                    .mode(0o700)
                    .create(&socket)
                    .unwrap();
            }
            _ => {}
        }

        // No live supervisor connection: the supervisor is gone, not merely
        // the socket file.
        let quit = Arc::new(Mutex::new(QuitState::default()));
        let path = socket.clone();
        let (attempt, completion, worker) =
            start_attempt(&quit, move || quit_connect(false, Some(path.as_path()))).unwrap();
        let outcome = completion.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            outcome,
            Ok(()),
            "{name}: a quit with nothing of ours to drain is confirmed"
        );
        let mut exits = Vec::new();
        finish_quit(
            &quit,
            &attempt,
            outcome,
            |code| exits.push(code),
            |_| panic!("{name}: a confirmed quit reported a failure"),
            || panic!("{name}: a confirmed quit showed the window"),
        );
        assert_eq!(
            exits,
            [0],
            "{name}: the host exits as after a confirmed drain"
        );
        assert_eq!(*quit.lock().unwrap(), QuitState::Drained);
        if name != "gone-removed" {
            assert!(socket.exists(), "{name}: nothing was removed at the path");
        }
        worker.join().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[test]
fn quit_through_the_connect_step_without_a_stored_socket_exits() {
    // The quit pressed on the cannot-start document while the start is still
    // blocked: no supervisor ever ran, so nothing was stored on either side.
    let state = HostState::default();
    state
        .data_directory_enter_failed
        .store(true, Ordering::SeqCst);
    let stored = state.supervisor_socket.lock().unwrap().clone();
    assert_eq!(stored, None, "the blocked start never stored a socket path");
    assert!(
        state.client.lock().unwrap().is_none(),
        "no client connection was ever made"
    );
    let quit = state.quit.clone();
    let (attempt, completion, worker) =
        start_attempt(&quit, move || quit_connect(false, stored.as_deref())).unwrap();
    let outcome = completion.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        outcome,
        Ok(()),
        "a quit without a stored socket path has nothing to drain"
    );
    let mut exits = Vec::new();
    finish_quit(
        &quit,
        &attempt,
        outcome,
        |code| exits.push(code),
        |_| panic!("a quit without a stored socket reported a failure"),
        || panic!("a quit without a stored socket showed the window"),
    );
    assert_eq!(exits, [0]);
    worker.join().unwrap();
}

#[test]
fn a_live_connection_with_a_gone_socket_keeps_today_s_failure() {
    // A live supervisor connection: the relay client stays open against the
    // supervisor's listener.
    let supervisor = Supervisor::new("live-gone");
    let client = LineClient::connect(&supervisor.socket, |_| {}).unwrap();
    // The accepted peer stays open, so the client connection stays live.
    let _peer = supervisor.accept();
    assert!(!client.is_closed(), "the stored client connection is live");

    let gone = supervisor.socket.with_file_name("removed.sock");
    let quit = Arc::new(Mutex::new(QuitState::default()));
    let path = gone.clone();
    let (attempt, completion, worker) =
        start_attempt(&quit, move || quit_connect(true, Some(path.as_path()))).unwrap();
    let outcome = completion.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        outcome,
        Err(DrainFailure::NotConnected),
        "a live supervisor behind a gone socket is not nothing to drain"
    );
    let mut exits = Vec::new();
    let mut reported = Vec::new();
    let mut shown = 0;
    finish_quit(
        &quit,
        &attempt,
        outcome,
        |code| exits.push(code),
        |payload| reported.push(payload),
        || shown += 1,
    );
    assert!(exits.is_empty(), "the host keeps running as on main");
    assert_eq!(
        reported,
        [serde_json::json!({"quitFailure": "quit-not-connected"})]
    );
    assert_eq!(shown, 1, "the window is shown again as on main");
    worker.join().unwrap();
    assert_eq!(
        completion.try_recv(),
        Err(mpsc::TryRecvError::Disconnected),
        "the worker reported its result exactly once"
    );
}

#[test]
fn accepted_but_silent_drain_fails_reports_and_shows_the_window() {
    let supervisor = Supervisor::new("silent");
    let quit = Arc::new(Mutex::new(QuitState::default()));
    let (connecting, release, ready, connect) = hold_connect(&supervisor.socket);
    let (attempt, completion, worker) = start_attempt(&quit, connect).unwrap();
    connecting.recv_timeout(Duration::from_secs(5)).unwrap();
    release.send(()).unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();

    // The supervisor accepts and never answers; the request is observed
    // before the expiry runs, so the write happened while the attempt was
    // current.
    let mut peer = supervisor.accept();
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut request = [0; 6];
    peer.read_exact(&mut request).unwrap();
    assert_eq!(
        &request, b"drain\n",
        "the silent supervisor got the request"
    );

    // The main-queue timer (start_quit) expires the attempt with NoAnswer.
    let mut reported = Vec::new();
    let mut shown = 0;
    finish_quit(
        &quit,
        &attempt,
        Err(DrainFailure::NoAnswer),
        |_| panic!("an unanswered drain exited"),
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
    assert_eq!(shown, 1, "the window is shown again after the bound");

    // Closing the peer ends the worker's read; the disarmed worker must not
    // report its late result anywhere.
    assert_eq!(completion.try_recv(), Err(mpsc::TryRecvError::Empty));
    drop(peer);
    worker.join().unwrap();
    assert_eq!(
        completion.try_recv(),
        Err(mpsc::TryRecvError::Disconnected),
        "the disarmed worker reported a result"
    );
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
