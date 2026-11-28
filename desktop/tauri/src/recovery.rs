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
}

#[derive(Default)]
pub(super) struct Recovery {
    pub(super) phase: RecoveryPhase,
    attempts: usize,
    launch_pending: bool,
    spawned: bool,
    unconfirmed_start: bool,
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
        if !matches!(*quit, QuitState::Idle | QuitState::Failed(_)) {
            return false;
        }
        let mut recovery = self.recovery.lock().unwrap();
        let RecoveryPhase::Watching(since) = recovery.phase else {
            return false;
        };
        if !self.is_current_client(ended) {
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
                    recovery.unconfirmed_start = false;
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

    pub(super) fn cancel_recovery(&self) {
        let mut recovery = self.recovery.lock().unwrap();
        if recovery.phase == RecoveryPhase::Running {
            recovery.phase = RecoveryPhase::Inactive;
            self.recovery_changed.notify_all();
        }
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
        let outcome = daemon::ensure_supervisor_with_start(socket, wait, || {
            let pid = daemon::start_detached_if(node, args, log, None, || {
                self.authorize_recovery_launch()
            })?;
            self.note_recovery_spawn();
            Ok(pid)
        });
        self.settle_recovery_launch(outcome.is_ok());
        outcome
    }

    pub(super) fn authorize_recovery_launch(&self) -> std::io::Result<()> {
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        let mut recovery = self.recovery.lock().unwrap();
        if recovery.phase != RecoveryPhase::Running
            || !matches!(*quit, QuitState::Idle | QuitState::Failed(_))
        {
            return Err(std::io::ErrorKind::Interrupted.into());
        }
        // Quit must wait for this committed launch before checking the socket.
        recovery.launch_pending = true;
        Ok(())
    }

    pub(super) fn note_recovery_spawn(&self) {
        let mut recovery = self.recovery.lock().unwrap();
        recovery.spawned = true;
        recovery.unconfirmed_start = true;
    }

    pub(super) fn settle_recovery_launch(&self, confirmed_listening: bool) {
        let mut recovery = self.recovery.lock().unwrap();
        if confirmed_listening {
            recovery.unconfirmed_start = false;
        }
        recovery.launch_pending = false;
        self.recovery_changed.notify_all();
    }

    pub(super) fn needs_drain_before_relaunch(&self) -> bool {
        let recovery = self.recovery.lock().unwrap();
        recovery.launch_pending || recovery.spawned
    }

    pub(super) fn quit_connect_after_recovery(
        &self,
        deadline: Instant,
        live_connection: bool,
    ) -> Result<Option<DrainConnection>, DrainFailure> {
        let recovery = self.recovery.lock().unwrap();
        let (recovery, _) = self
            .recovery_changed
            .wait_timeout_while(
                recovery,
                deadline.saturating_duration_since(Instant::now()),
                |recovery| recovery.launch_pending,
            )
            .unwrap();
        if recovery.launch_pending || Instant::now() >= deadline {
            return Err(DrainFailure::NoAnswer);
        }
        let may_still_be_starting = recovery.unconfirmed_start;
        drop(recovery);
        let path = self
            .supervisor_socket
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        quit_connect(live_connection || may_still_be_starting, path.as_deref())
    }
}

pub(super) fn watch_supervisor(app: &AppHandle, client: LineClient) {
    let app = app.clone();
    client.on_eof(move |ended, ended_at| {
        let state = app.state::<HostState>();
        if !state.begin_recovery(&ended, ended_at) {
            return;
        }
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<HostState>();
            if let Some(client) = state.recover_supervisor(
                |delay| state.wait_for_retry(delay),
                || connect_or_start(&app, true),
                Instant::now,
            ) {
                watch_supervisor(&app, client);
            }
        });
    });
}
