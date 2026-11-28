use super::*;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::TryLockError;

pub(super) fn is_initial(state: &HostState) -> bool {
    !state.first_document_served.load(Ordering::SeqCst)
}

pub(super) fn relay(
    state: &HostState,
    client: LineClient,
    deadline: Instant,
) -> http::Response<Vec<u8>> {
    let now = Instant::now();
    let first_deadline = now + deadline.saturating_duration_since(now) / 2;
    for (attempt, limit) in [(1, first_deadline), (2, deadline)] {
        let result = client.request_root_until(limit).and_then(|reply| {
            let response = scheme_reply(reply).map_err(|_| CarrierError::Invalid)?;
            if response.status() == 503 && response.body().is_empty() {
                return Err(CarrierError::Busy);
            }
            Ok(response)
        });
        log_attempt(state, attempt, &result);
        match result {
            Ok(mut response) => {
                response.extensions_mut().insert(client);
                return response;
            }
            Err(error) if !state.root_can_use_reply(&client) => {
                if client.closed_without_eof() && state.is_current_client(&client) {
                    return prepare_root_failure(state, true, false, SchemeFailure::ClientClosed);
                }
                // Clean EOF or replacement belongs to supervisor recovery.
                return scheme_request_failure(state, true, false, &client, error);
            }
            Err(_) => {}
        }
    }
    let mut response = unavailable_document(state);
    response.extensions_mut().insert(client);
    response
}

fn unavailable_document(state: &HostState) -> http::Response<Vec<u8>> {
    let path = state
        .daemon_log
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    cannot_start::response(CannotStartReason::ConnectionUnavailable, path.as_deref())
}

fn log_attempt(
    state: &HostState,
    attempt: u8,
    result: &Result<http::Response<Vec<u8>>, CarrierError>,
) {
    let path = state
        .daemon_log
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    if let Some(path) = path {
        let mut entry = serde_json::json!({
            "time": unix_time_ms(),
            "attempt": attempt,
            "result": if result.is_ok() { "answered" } else { "refused" },
        });
        if let Err(error) = result {
            entry["cause"] = Value::from(match error {
                CarrierError::Closed => "closed",
                CarrierError::Timeout => "timeout",
                CarrierError::Busy => "unavailable",
                CarrierError::Invalid => "invalid",
            });
        }
        append_daemon_log_line(&path, serde_json::json!({ "hostRootRelayAttempt": entry }));
    }
}

pub(super) fn serve(
    app: AppHandle,
    request: http::Request<Vec<u8>>,
    respond: impl FnOnce(http::Response<Vec<u8>>) + Send + 'static,
) {
    let deadline = Instant::now() + CLIENT_WAIT;
    let prepare_by = deadline - Duration::from_secs(1);
    let relay_by = prepare_by - Duration::from_millis(100);
    let (send, ready) = mpsc::channel();
    let original_client =
        try_lock(&app.state::<HostState>().client).and_then(|client| client.clone());
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker_app.state::<HostState>();
        let response =
            prepare_scheme_response(&state, SCHEMES[0], request, CLIENT_WAIT, Some(relay_by));
        let _ = send.send(response);
    });
    tauri::async_runtime::spawn_blocking(move || {
        let prepared = receive_until(&ready, prepare_by);
        if let Err(error) = hand_off_until(deadline, move || {
            let state = app.state::<HostState>();
            let response = match prepared {
                Ok(response) => response,
                Err(_) if original_client.is_none() => {
                    respond(preparation_failed(&state, None));
                    return;
                }
                Err(_) => preparation_failed(&state, original_client),
            };
            deliver_scheme_response(&state, true, response, respond);
        }) {
            eprintln!("the initial document hand-off did not finish: {error}");
        }
    });
}

fn try_lock<T>(mutex: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match mutex.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::Poisoned(error)) => Some(error.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

fn preparation_failed(state: &HostState, client: Option<LineClient>) -> http::Response<Vec<u8>> {
    let quit = try_lock(&state.quit).is_some_and(|quit| quit.in_progress());
    let phase = try_lock(&state.recovery).map(|recovery| recovery.phase);
    if quit || phase == Some(RecoveryPhase::Running) {
        return bare_response(503);
    }
    let reason = if phase == Some(RecoveryPhase::Exhausted) {
        CannotStartReason::ConnectionClosed
    } else {
        CannotStartReason::ConnectionUnavailable
    };
    let mut response = cannot_start::response(reason, None);
    if reason == CannotStartReason::ConnectionUnavailable {
        if let Some(client) = client {
            response.extensions_mut().insert(client);
        }
    }
    response
}

fn hand_off_until(
    deadline: Instant,
    hand_off: impl FnOnce() + Send + 'static,
) -> Result<(), RecvTimeoutError> {
    let (send, delivered) = mpsc::channel();
    tauri::async_runtime::spawn_blocking(move || {
        hand_off();
        let _ = send.send(());
    });
    // Tauri consumes the responder. The host can stop waiting for it,
    // but cannot cancel the native call or send a second response.
    receive_until(&delivered, deadline)
}

fn receive_until<T>(receiver: &Receiver<T>, deadline: Instant) -> Result<T, RecvTimeoutError> {
    receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_timeout_preserves_quit_and_recovery_responses() {
        let state = HostState::default();
        for (phase, reason) in [
            (
                RecoveryPhase::Inactive,
                Some(CannotStartReason::ConnectionUnavailable),
            ),
            (RecoveryPhase::Running, None),
            (
                RecoveryPhase::Exhausted,
                Some(CannotStartReason::ConnectionClosed),
            ),
        ] {
            state.recovery.lock().unwrap().phase = phase;
            let expected = reason.map_or_else(
                || bare_response(503),
                |reason| cannot_start::response(reason, None),
            );
            assert_eq!(preparation_failed(&state, None).body(), expected.body());
        }
        *state.quit.lock().unwrap() = QuitState::Waiting(Arc::new(QuitAttempt {
            deadline: Instant::now(),
            restart: false,
        }));
        assert!(preparation_failed(&state, None).body().is_empty());
    }

    #[test]
    fn host_stops_waiting_for_a_blocked_native_handoff() {
        let wait = Duration::from_secs(5);
        let (release, blocked) = mpsc::channel();
        let (entered, started) = mpsc::channel();
        let (completed, finished) = mpsc::channel();
        let (observed, result) = mpsc::channel();
        let caller = std::thread::spawn(move || {
            let result = hand_off_until(Instant::now(), move || {
                entered.send(()).unwrap();
                assert_eq!(blocked.recv_timeout(wait), Ok(()));
                completed.send(()).unwrap();
            });
            observed.send(result).unwrap();
        });
        started.recv_timeout(wait).unwrap();
        assert_eq!(
            result.recv_timeout(wait),
            Ok(Err(RecvTimeoutError::Timeout))
        );
        release.send(()).unwrap();
        finished.recv_timeout(wait).unwrap();
        caller.join().unwrap();
    }
}
