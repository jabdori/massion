use super::*;
use std::process::Child;

const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
const STABLE_CONNECTION: Duration = Duration::from_secs(60);
const TERMINATE_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum RecoveryPhase {
    #[default]
    Inactive,
    Watching(Instant),
    Running,
    Exhausted,
    Cancelled,
}

#[derive(Default)]
pub(super) struct Recovery {
    pub(super) phase: RecoveryPhase,
    attempts: usize,
    launch_pending: bool,
    pub(super) child: Option<Child>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum DrainTarget {
    StoredPath,
    Owned(u32),
    None,
}

impl Recovery {
    fn live_child_pid(&mut self) -> std::io::Result<Option<u32>> {
        let Some(child) = self.child.as_mut() else {
            return Ok(None);
        };
        if child.try_wait()?.is_some() {
            self.child = None;
            Ok(None)
        } else {
            Ok(Some(child.id()))
        }
    }
}

pub(super) fn terminate_child(child: &mut Child, grace: Duration) -> std::io::Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    // This exclusively held child has not been reaped, so its PID cannot be reused.
    if unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    let deadline = Instant::now() + grace;
    loop {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            child.kill()?;
            return child.wait().map(drop);
        }
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}

impl HostState {
    pub(super) fn install_initial_client(&self, client: LineClient, now: Instant) {
        let mut recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        recovery.phase = RecoveryPhase::Watching(now);
        *self.client.lock().unwrap() = Some(client);
    }

    pub(super) fn begin_recovery(
        &self,
        ended: &LineClient,
        now: Instant,
        retry_document: impl FnOnce(),
    ) -> bool {
        // When needed together, take quit, recovery, and client in that order.
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        let mut recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        let RecoveryPhase::Watching(since) = recovery.phase else {
            return false;
        };
        if !self.is_current_client(ended) {
            return false;
        }
        if !matches!(*quit, QuitState::Idle | QuitState::Failed(_)) {
            recovery.phase = RecoveryPhase::Cancelled;
            return false;
        }
        if now.saturating_duration_since(since) > STABLE_CONNECTION {
            recovery.attempts = 0;
        }
        if recovery.attempts == RETRY_DELAYS.len() {
            recovery.phase = RecoveryPhase::Exhausted;
            self.first_paint().supersede_pending();
            drop(recovery);
            drop(quit);
            self.retry_initial_document(retry_document);
            return false;
        }
        recovery.phase = RecoveryPhase::Running;
        true
    }

    pub(super) fn recover_supervisor(
        &self,
        mut wait: impl FnMut(Duration),
        mut connect: impl FnMut() -> Result<LineClient, StartRefusal>,
        mut now: impl FnMut() -> Instant,
        retry_document: impl FnOnce(),
    ) -> Option<LineClient> {
        loop {
            let delay = {
                let recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
                if recovery.phase != RecoveryPhase::Running {
                    return None;
                }
                RETRY_DELAYS[recovery.attempts]
            };
            wait(delay);
            let attempt = {
                let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
                let mut recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
                if recovery.phase != RecoveryPhase::Running
                    || !matches!(*quit, QuitState::Idle | QuitState::Failed(_))
                {
                    return None;
                }
                recovery.attempts += 1;
                recovery.attempts
            };
            let outcome = connect().map(|client| (client, now()));
            let log_path = self
                .daemon_log
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if let Some(path) = log_path {
                let mut entry = serde_json::json!({
                    "time": unix_time_ms(),
                    "attempt": attempt,
                    "result": if outcome.is_ok() { "connected" } else { "refused" },
                });
                if let Err(StartRefusal::SupervisorFailed(Some(cause))) = &outcome {
                    entry["cause"] = Value::from(cause.as_str());
                }
                append_daemon_log_line(&path, serde_json::json!({ "hostRecoveryAttempt": entry }));
            }
            let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
            let mut recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
            if recovery.phase != RecoveryPhase::Running {
                drop(recovery);
                drop(quit);
                if let Ok((client, _)) = outcome {
                    client.disconnect();
                }
                return None;
            }
            match outcome {
                Ok((client, attached_at)) => {
                    let mut stored = self.client.lock().unwrap_or_else(PoisonError::into_inner);
                    let mut watch = self.first_paint();
                    recovery.phase = RecoveryPhase::Watching(attached_at);
                    *stored = Some(client.clone());
                    watch.supersede_pending();
                    drop(watch);
                    drop(stored);
                    drop(recovery);
                    drop(quit);
                    self.retry_initial_document(retry_document);
                    return Some(client);
                }
                Err(error) => {
                    let exhausted = recovery.attempts == RETRY_DELAYS.len();
                    if exhausted {
                        recovery.phase = RecoveryPhase::Exhausted;
                        self.first_paint().supersede_pending();
                    }
                    drop(recovery);
                    drop(quit);
                    eprintln!("{error}");
                    if exhausted {
                        self.retry_initial_document(retry_document);
                        return None;
                    }
                }
            }
        }
    }

    fn retry_initial_document(&self, navigate: impl FnOnce()) {
        if self.prepare_initial_document_retry(|_| ()).is_some() {
            navigate();
        }
    }

    fn prepare_initial_document_retry<T>(
        &self,
        prepare: impl FnOnce(&mut first_paint::FirstPaintWatch) -> T,
    ) -> Option<T> {
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        let recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        let ready = matches!(*quit, QuitState::Idle | QuitState::Failed(_))
            && match recovery.phase {
                RecoveryPhase::Exhausted => true,
                RecoveryPhase::Watching(_) => self
                    .client
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                    .is_some_and(|client| !client.is_closed() || client.closed_without_eof()),
                _ => false,
            };
        let mut watch = self.first_paint();
        let has_document = watch.has_document()
            .unwrap_or_else(|| self.first_document_served.load(Ordering::SeqCst));
        (ready && !has_document).then(|| prepare(&mut watch))
    }

    pub(super) fn is_current_client(&self, client: &LineClient) -> bool {
        self.client
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|stored| stored.same_connection(client))
    }

    pub(super) fn has_live_client(&self) -> bool {
        self.client
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .is_some_and(|client| !client.is_closed())
    }

    pub(super) fn root_can_use_reply(&self, client: &LineClient) -> bool {
        let recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        !matches!(
            recovery.phase,
            RecoveryPhase::Running | RecoveryPhase::Exhausted
        ) && self.is_current_client(client)
            && !client.is_closed()
    }

    pub(super) fn wait_for_retry(&self, delay: Duration) {
        let recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        drop(
            self.recovery_changed
                .wait_timeout_while(recovery, delay, |recovery| {
                    recovery.phase == RecoveryPhase::Running
                })
                .unwrap_or_else(PoisonError::into_inner),
        );
    }

    pub(super) fn cancel_recovery(&self) -> bool {
        let mut recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        if recovery.phase == RecoveryPhase::Running {
            recovery.phase = RecoveryPhase::Cancelled;
            self.recovery_changed.notify_all();
        }
        recovery.launch_pending
    }

    pub(super) fn start_recovery_supervisor(
        &self,
        socket: &Path,
        wait: Duration,
        start: impl FnOnce(&mut dyn FnMut() -> std::io::Result<()>) -> std::io::Result<Child>,
    ) -> Result<massion_carrier::daemon::SupervisorStart, String> {
        use massion_carrier::daemon;
        let mut reserved = false;
        let mut child = None;
        let outcome = daemon::ensure_supervisor_with_start(
            socket,
            wait,
            Some(&|| self.check_recovering()),
            || {
                let started = start(&mut || {
                    self.authorize_recovery_launch()?;
                    reserved = true;
                    Ok(())
                })?;
                let pid = started.id();
                child = Some(started);
                Ok(pid)
            },
        );
        if reserved {
            match (outcome.is_err(), child) {
                (true, Some(child)) => self.stop_recovery_child(child).map_err(|error| {
                    format!("The non-listening supervisor could not be stopped: {error}")
                })?,
                (_, child) => self.settle_recovery_launch(child),
            }
        }
        outcome
    }

    pub(super) fn check_recovering(&self) -> std::io::Result<()> {
        let recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        if recovery.phase == RecoveryPhase::Running {
            Ok(())
        } else {
            Err(std::io::ErrorKind::Interrupted.into())
        }
    }

    pub(super) fn authorize_recovery_launch(&self) -> std::io::Result<()> {
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        let mut recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        if recovery.phase != RecoveryPhase::Running
            || !matches!(*quit, QuitState::Idle | QuitState::Failed(_))
        {
            return Err(std::io::ErrorKind::Interrupted.into());
        }
        if recovery.launch_pending || recovery.live_child_pid()?.is_some() {
            return Err(std::io::ErrorKind::AlreadyExists.into());
        }
        // Quit must wait for this committed launch before checking the socket.
        recovery.launch_pending = true;
        Ok(())
    }

    pub(super) fn settle_recovery_launch(&self, child: Option<Child>) {
        let mut recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        recovery.child = child;
        recovery.launch_pending = false;
        self.recovery_changed.notify_all();
    }

    fn stop_recovery_child(&self, mut child: Child) -> std::io::Result<()> {
        let outcome = terminate_child(&mut child, TERMINATE_GRACE);
        self.settle_recovery_launch(outcome.is_err().then_some(child));
        outcome
    }

    pub(super) fn needs_drain_before_relaunch(&self) -> bool {
        let recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        recovery.launch_pending || recovery.child.is_some()
    }

    pub(super) fn quit_connect_after_recovery(
        &self,
        attempt: &Arc<QuitAttempt>,
        live_connection: bool,
    ) -> Result<Option<DrainConnection>, DrainFailure> {
        let recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        let (recovery, _) = self
            .recovery_changed
            .wait_timeout_while(
                recovery,
                attempt.deadline.saturating_duration_since(Instant::now()),
                |recovery| recovery.launch_pending,
            )
            .unwrap_or_else(PoisonError::into_inner);
        drop(recovery);
        let target = self.activate_quit_after_launch(attempt)?;
        let path = self
            .supervisor_socket
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        match target {
            DrainTarget::StoredPath => quit_connect(live_connection, path.as_deref()),
            DrainTarget::None => Ok(None),
            DrainTarget::Owned(pid) => {
                if let Some(connection) =
                    path.as_deref().map_or(Ok(None), DrainConnection::connect)?
                {
                    connection.verify_peer(pid)?;
                    return Ok(Some(connection));
                }
                let child = {
                    let _quit = current_quit(&self.quit, attempt).ok_or(DrainFailure::NoAnswer)?;
                    let mut recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
                    let child = recovery
                        .child
                        .take_if(|child| child.id() == pid)
                        .ok_or(DrainFailure::NotConnected)?;
                    // Keep subsequent quit and start decisions behind the child cleanup.
                    recovery.launch_pending = true;
                    child
                };
                self.stop_recovery_child(child)
                    .map_err(|_| DrainFailure::NotConnected)?;
                Ok(None)
            }
        }
    }

    pub(super) fn activate_quit_after_launch(
        &self,
        attempt: &Arc<QuitAttempt>,
    ) -> Result<DrainTarget, DrainFailure> {
        let mut quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        let mut recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        if !is_current_quit(&quit, attempt)
            || recovery.launch_pending
            || Instant::now() >= attempt.deadline
        {
            return Err(DrainFailure::NoAnswer);
        }
        // A quit pressed during a committed launch becomes active only after the launch settles.
        let only_owned =
            attempt.restart || recovery.child.is_some() || matches!(*quit, QuitState::Queued(_));
        *quit = QuitState::Waiting(attempt.clone());
        match recovery
            .live_child_pid()
            .map_err(|_| DrainFailure::NotConnected)?
        {
            Some(pid) => Ok(DrainTarget::Owned(pid)),
            None if only_owned => Ok(DrainTarget::None),
            None => Ok(DrainTarget::StoredPath),
        }
    }
}

pub(super) fn watch_for_supervisor_eof<Owner: Send + 'static>(
    client: &LineClient,
    owner: Owner,
    state: fn(&Owner) -> &HostState,
    schedule: impl FnOnce(Owner) + Send + 'static,
    retry_document: impl FnOnce(&Owner) + Send + 'static,
) {
    client.on_eof(move |ended, ended_at| {
        if state(&owner).begin_recovery(&ended, ended_at, || retry_document(&owner)) {
            schedule(owner);
        }
    });
}

pub(super) fn watch_supervisor(app: &AppHandle, client: LineClient) {
    watch_for_supervisor_eof(
        &client,
        app.clone(),
        |app| app.state::<HostState>().inner(),
        |app| {
            let scheduled_at = Instant::now();
            let worker_app = app.clone();
            // Waiting requests use the blocking pool, so recovery needs its own worker.
            if std::thread::Builder::new()
                .spawn(move || run_recovery(&worker_app, scheduled_at))
                .is_err()
            {
                tauri::async_runtime::spawn_blocking(move || run_recovery(&app, scheduled_at));
            }
        },
        navigate_to_initial_document,
    );
}

fn run_recovery(app: &AppHandle, scheduled_at: Instant) {
    let state = app.state::<HostState>();
    let mut first_wait = Some(scheduled_at);
    if let Some(client) = state.recover_supervisor(
        |delay| {
            let elapsed = first_wait
                .take()
                .map_or(Duration::ZERO, |start| start.elapsed());
            state.wait_for_retry(delay.saturating_sub(elapsed));
        },
        || connect_or_start(app, true),
        Instant::now,
        || navigate_to_initial_document(app),
    ) {
        watch_supervisor(app, client);
    }
}

fn navigate_to_initial_document(app: &AppHandle) {
    let handle = app.clone();
    window_effect("schedule initial document navigation", || {
        app.run_on_main_thread(move || {
            let state = handle.state::<HostState>();
            let Some(window) = handle.get_webview_window(WINDOW_LABEL) else { return };
            if let Some(navigation) = state.prepare_initial_document_retry(|watch| watch.start_root(Instant::now())) {
                window_effect("navigate to the initial document", || {
                    first_paint::navigate_root(window.as_ref(), navigation)
                });
            }
        })
    });
}
