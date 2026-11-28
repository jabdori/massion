use super::*;
use std::sync::mpsc::{self, Receiver};

pub(super) fn is_initial(state: &HostState) -> bool {
    !state.first_document_served.load(Ordering::SeqCst)
}

pub(super) fn relay(
    state: &HostState,
    client: LineClient,
    deadline: Instant,
) -> http::Response<Vec<u8>> {
    let now = Instant::now();
    let retry_at = now + deadline.saturating_duration_since(now) / 2;
    let (send, ready) = mpsc::channel();
    let mut pending = [None, None];
    let mut outcomes = [None, None];
    let mut started = 0;
    let mut accepted = None;
    let mut expired = false;
    loop {
        if started == 0 || (started == 1 && (pending[0].is_none() || Instant::now() >= retry_at)) {
            let attempt = started;
            started += 1;
            let send = send.clone();
            match client.begin_root_request(deadline, move |result| {
                let _ = send.send((attempt, Instant::now(), result));
            }) {
                Ok(request) => pending[attempt] = Some(request),
                Err(error) => outcomes[attempt] = Some(Err(error)),
            }
        }
        if pending.iter().all(Option::is_none) {
            if started == 2 || !state.root_can_use_reply(&client) {
                break;
            }
            continue;
        }
        let limit = if started == 1 { retry_at } else { deadline };
        match receive_until(&ready, limit) {
            Ok((attempt, arrived, result)) if arrived <= deadline => {
                pending[attempt] = None;
                match result.and_then(root_reply) {
                    Ok(response) => {
                        outcomes[attempt] = Some(Ok(()));
                        accepted = Some(response);
                        break;
                    }
                    Err(error) => {
                        outcomes[attempt] = Some(Err(error));
                        if !state.root_can_use_reply(&client) {
                            break;
                        }
                    }
                }
            }
            Ok(_) | Err(_) if started == 2 => {
                expired = true;
                break;
            }
            Ok(_) | Err(_) => {}
        }
    }
    drop(pending);
    for (index, outcome) in outcomes.into_iter().take(started).enumerate() {
        log_attempt(state, index + 1, outcome, expired);
    }
    let mut response = accepted
        .unwrap_or_else(|| start_failure_response(state, CannotStartReason::ConnectionUnavailable));
    response
        .extensions_mut()
        .insert(RootReplySource::Relay(client));
    response
}

fn root_reply(
    reply: massion_carrier::socket::Reply,
) -> Result<http::Response<Vec<u8>>, CarrierError> {
    let response = scheme_reply(reply).map_err(|_| CarrierError::Invalid)?;
    if matches!(response.status().as_u16(), 200 | 503) && response.body().is_empty() {
        return Err(CarrierError::Busy);
    }
    Ok(response)
}

fn log_attempt(
    state: &HostState,
    attempt: usize,
    outcome: Option<Result<(), CarrierError>>,
    expired: bool,
) {
    let path = state
        .daemon_log
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    if let Some(path) = path {
        let (result, cause) = match outcome {
            Some(Ok(())) => ("answered", None),
            Some(Err(CarrierError::Closed)) => ("refused", Some("closed")),
            Some(Err(CarrierError::Busy)) => ("refused", Some("unavailable")),
            Some(Err(CarrierError::Invalid)) => ("refused", Some("invalid")),
            Some(Err(CarrierError::Timeout)) => ("refused", Some("timeout")),
            None if expired => ("refused", Some("timeout")),
            None => ("superseded", None),
        };
        let mut entry = serde_json::json!({
            "time": unix_time_ms(),
            "attempt": attempt,
            "result": result,
        });
        if let Some(cause) = cause {
            entry["cause"] = Value::from(cause);
        }
        append_daemon_log_line(&path, serde_json::json!({ "hostRootRelayAttempt": entry }));
    }
}

type Work = Box<dyn FnOnce() + Send>;

// The scheme handler and tests enter here before the first-root decision.
pub(super) fn dispatch<Owner: Clone + Send + 'static>(
    owner: Owner,
    state: fn(&Owner) -> &HostState,
    request: http::Request<Vec<u8>>,
    wait: Duration,
    prepare_on: impl Fn(Work),
    respond: impl FnOnce(http::Response<Vec<u8>>) + Send + 'static,
    on_timeout: impl FnOnce(&Owner) + Send + 'static,
) {
    let scheme = SCHEMES[0];
    let root = is_root_app_get(scheme, &request);
    if !root || !is_initial(state(&owner)) {
        prepare_on(Box::new(move || {
            let state = state(&owner);
            let response = prepare_scheme_response(state, scheme, request, wait, None);
            deliver_scheme_response(state, root, response, None, respond);
        }));
        return;
    }

    let now = Instant::now();
    let deadline = now + wait;
    let prepare_by = deadline - Duration::from_secs(1).min(wait / 4);
    let relay_by = prepare_by - Duration::from_millis(100).min(wait / 8);
    let handoff_retry = state(&owner).initial_handoff_retried.load(Ordering::SeqCst);
    let (send, ready) = mpsc::channel();
    if !handoff_retry {
        let worker = owner.clone();
        prepare_on(Box::new(move || {
            if Instant::now() >= relay_by {
                return;
            }
            let response =
                prepare_scheme_response(state(&worker), scheme, request, wait, Some(relay_by));
            let _ = send.send(response);
        }));
    } else {
        drop(send);
    }

    let worker = owner.clone();
    let watch = move || {
        let prepared = receive_until(&ready, prepare_by);
        let (finished, delivered) = mpsc::channel();
        let handoff_worker = worker.clone();
        let _ = std::thread::Builder::new().spawn(move || {
            let state = state(&handoff_worker);
            let response = prepared.unwrap_or_else(|_| preparation_failed(state));
            deliver_scheme_response(
                state,
                true,
                response,
                Some((deadline, handoff_retry)),
                |response| {
                    respond(response);
                    let _ = finished.send(());
                },
            );
        });
        // The native responder is one-shot and can block. A new navigation
        // owns a different responder, so this worker never joins the old call.
        if receive_until(&delivered, deadline).is_err() && !handoff_retry {
            on_timeout(&worker);
        }
    };
    if let Err(error) = std::thread::Builder::new().spawn(watch) {
        eprintln!("the initial document hand-off did not finish: {error}");
    }
}

fn preparation_failed(state: &HostState) -> http::Response<Vec<u8>> {
    let quit = state.quit.lock().unwrap_or_else(PoisonError::into_inner);
    let recovery = state
        .recovery
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let client = state
        .client
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let terminal = recovery.phase == RecoveryPhase::Exhausted
        || (recovery.phase == RecoveryPhase::Cancelled && matches!(*quit, QuitState::Failed(_)));
    if !matches!(*quit, QuitState::Idle | QuitState::Failed(_))
        || recovery.phase == RecoveryPhase::Running
    {
        return bare_response(503);
    }
    drop(recovery);
    drop(quit);
    if terminal {
        return start_failure_response(state, CannotStartReason::ConnectionClosed);
    }
    let Some(client) = client else {
        return prepare_root_failure(state, true, false, SchemeFailure::NoClient);
    };
    let (reason, source) = if client.closed_without_eof() {
        (
            CannotStartReason::ConnectionClosed,
            RootReplySource::Stopped(client),
        )
    } else {
        (
            CannotStartReason::ConnectionUnavailable,
            RootReplySource::Relay(client),
        )
    };
    let mut response = start_failure_response(state, reason);
    // Delivery rechecks whether this same connection is open, stopped, or stale.
    response.extensions_mut().insert(source);
    response
}

fn receive_until<T>(
    receiver: &Receiver<T>,
    deadline: Instant,
) -> Result<T, mpsc::RecvTimeoutError> {
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
            assert_eq!(preparation_failed(&state).body(), expected.body());
        }
        *state.quit.lock().unwrap() = QuitState::Waiting(Arc::new(QuitAttempt {
            deadline: Instant::now(),
            restart: false,
        }));
        assert!(preparation_failed(&state).body().is_empty());
    }

    #[test]
    fn a_timed_out_handoff_cannot_record_an_old_document_after_navigation_retries() {
        let state = HostState::default();
        let mut retried = false;
        deliver_scheme_response(&state, true, preparation_failed(&state), None, |_| {
            state.retry_document(true, || retried = true)
        });
        assert!(retried);
        assert!(
            is_initial(&state),
            "the abandoned responder cannot finish the new navigation"
        );
    }
}
