use super::*;

const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
const STABLE_CONNECTION: Duration = Duration::from_secs(60);

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
    child: Option<std::process::Child>,
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

impl HostState {
    pub(super) fn install_initial_client(&self, client: LineClient, now: Instant) {
        let mut recovery = self.recovery.lock().unwrap();
        recovery.phase = RecoveryPhase::Watching(now);
        *self.client.lock().unwrap() = Some(client);
    }

    pub(super) fn begin_recovery(&self, ended: &LineClient, now: Instant) -> bool {
        // When needed together, take quit, recovery, and client in that order.
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        let mut recovery = self.recovery.lock().unwrap();
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
    ) -> Option<LineClient> {
        loop {
            let delay = {
                let recovery = self.recovery.lock().unwrap();
                if recovery.phase != RecoveryPhase::Running {
                    return None;
                }
                RETRY_DELAYS[recovery.attempts]
            };
            wait(delay);
            {
                let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
                let mut recovery = self.recovery.lock().unwrap();
                if recovery.phase != RecoveryPhase::Running
                    || !matches!(*quit, QuitState::Idle | QuitState::Failed(_))
                {
                    return None;
                }
                recovery.attempts += 1;
            }
            let outcome = connect().map(|client| (client, now()));
            let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
            let mut recovery = self.recovery.lock().unwrap();
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
                    recovery.phase = RecoveryPhase::Watching(attached_at);
                    *self.client.lock().unwrap() = Some(client.clone());
                    return Some(client);
                }
                Err(error) => {
                    let exhausted = recovery.attempts == RETRY_DELAYS.len();
                    if exhausted {
                        recovery.phase = RecoveryPhase::Exhausted;
                    }
                    drop(recovery);
                    drop(quit);
                    eprintln!("{error}");
                    if exhausted {
                        return None;
                    }
                }
            }
        }
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
        let recovery = self.recovery.lock().unwrap();
        !matches!(
            recovery.phase,
            RecoveryPhase::Running | RecoveryPhase::Exhausted
        ) && self.is_current_client(client)
    }

    pub(super) fn wait_for_retry(&self, delay: Duration) {
        let recovery = self.recovery.lock().unwrap();
        drop(
            self.recovery_changed
                .wait_timeout_while(recovery, delay, |recovery| {
                    recovery.phase == RecoveryPhase::Running
                })
                .unwrap(),
        );
    }

    pub(super) fn cancel_recovery(&self) -> bool {
        let mut recovery = self.recovery.lock().unwrap();
        if recovery.phase == RecoveryPhase::Running {
            recovery.phase = RecoveryPhase::Cancelled;
            self.recovery_changed.notify_all();
        }
        recovery.launch_pending
    }

    pub(super) fn start_recovery_supervisor(
        &self,
        socket: &Path,
        node: &str,
        args: &[String],
        log: &Path,
        wait: Duration,
    ) -> Result<massion_carrier::daemon::SupervisorStart, String> {
        use massion_carrier::daemon;
        let outcome = daemon::ensure_supervisor_with_start(
            socket,
            wait,
            Some(&|| self.check_recovering()),
            || {
                let child = daemon::start_detached_if(node, args, log, None, || {
                    self.authorize_recovery_launch()
                })?;
                let pid = child.id();
                self.recovery.lock().unwrap().child = Some(child);
                Ok(pid)
            },
        );
        self.settle_recovery_launch();
        outcome
    }

    pub(super) fn check_recovering(&self) -> std::io::Result<()> {
        let recovery = self.recovery.lock().unwrap();
        if recovery.phase == RecoveryPhase::Running {
            Ok(())
        } else {
            Err(std::io::ErrorKind::Interrupted.into())
        }
    }

    pub(super) fn authorize_recovery_launch(&self) -> std::io::Result<()> {
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        let mut recovery = self.recovery.lock().unwrap();
        if recovery.phase != RecoveryPhase::Running
            || !matches!(*quit, QuitState::Idle | QuitState::Failed(_))
        {
            return Err(std::io::ErrorKind::Interrupted.into());
        }
        if recovery.live_child_pid()?.is_some() {
            return Err(std::io::ErrorKind::AlreadyExists.into());
        }
        // Quit must wait for this committed launch before checking the socket.
        recovery.launch_pending = true;
        Ok(())
    }

    pub(super) fn settle_recovery_launch(&self) {
        let mut recovery = self.recovery.lock().unwrap();
        recovery.launch_pending = false;
        self.recovery_changed.notify_all();
    }

    pub(super) fn needs_drain_before_relaunch(&self) -> bool {
        let recovery = self.recovery.lock().unwrap();
        recovery.launch_pending || recovery.child.is_some()
    }

    pub(super) fn quit_connect_after_recovery(
        &self,
        attempt: &Arc<QuitAttempt>,
        live_connection: bool,
    ) -> Result<Option<DrainConnection>, DrainFailure> {
        let recovery = self.recovery.lock().unwrap();
        let (recovery, _) = self
            .recovery_changed
            .wait_timeout_while(
                recovery,
                attempt.deadline.saturating_duration_since(Instant::now()),
                |recovery| recovery.launch_pending,
            )
            .unwrap();
        drop(recovery);
        let owned_pid = self.activate_quit_after_launch(attempt)?;
        let path = self
            .supervisor_socket
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if attempt.restart && owned_pid.is_none() {
            return Ok(None);
        }
        let connection = quit_connect(live_connection || owned_pid.is_some(), path.as_deref())?;
        if let (Some(connection), Some(pid)) = (&connection, owned_pid) {
            connection.verify_peer(pid)?;
        }
        Ok(connection)
    }

    pub(super) fn activate_quit_after_launch(
        &self,
        attempt: &Arc<QuitAttempt>,
    ) -> Result<Option<u32>, DrainFailure> {
        let mut quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        let mut recovery = self.recovery.lock().unwrap();
        if !is_current_quit(&quit, attempt)
            || recovery.launch_pending
            || Instant::now() >= attempt.deadline
        {
            return Err(DrainFailure::NoAnswer);
        }
        // A quit pressed during a committed launch becomes active only after the launch settles.
        *quit = QuitState::Waiting(attempt.clone());
        recovery
            .live_child_pid()
            .map_err(|_| DrainFailure::NotConnected)
    }
}

pub(super) fn watch_for_supervisor_eof<Owner: Send + 'static>(
    client: &LineClient,
    owner: Owner,
    state: fn(&Owner) -> &HostState,
    schedule: impl FnOnce(Owner) + Send + 'static,
) {
    client.on_eof(move |ended, ended_at| {
        if state(&owner).begin_recovery(&ended, ended_at) {
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
    ) {
        watch_supervisor(app, client);
    }
}
