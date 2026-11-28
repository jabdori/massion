use super::*;

const DEADLINE: Duration = Duration::from_secs(20);
const DOCUMENT_URL: &str = "massion://app/cannot-start";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Initial,
    RetryRequested,
    Retry,
    Drawn,
    Document,
    Superseded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Navigation {
    id: u64,
    deadline: Instant,
    stage: Stage,
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Renavigate(Navigation),
    Document,
}

#[derive(Default)]
pub(super) struct FirstPaintWatch {
    next_id: u64,
    navigation: Option<Navigation>,
}

impl FirstPaintWatch {
    fn start(&mut self, now: Instant, stage: Stage) -> Navigation {
        self.next_id += 1;
        let navigation = Navigation {
            id: self.next_id,
            deadline: now + DEADLINE,
            stage,
        };
        self.navigation = Some(navigation);
        navigation
    }

    fn navigate(&mut self, now: Instant) -> Option<Navigation> {
        if let Some(nav) = &mut self.navigation {
            if nav.stage == Stage::RetryRequested {
                nav.stage = Stage::Retry;
                return None;
            }
        }
        Some(self.start(now, Stage::Initial))
    }

    pub(super) fn supersede_pending(&mut self) {
        if let Some(nav) = &mut self.navigation {
            if matches!(
                nav.stage,
                Stage::Initial | Stage::RetryRequested | Stage::Retry
            ) {
                nav.stage = Stage::Superseded;
            }
        }
    }

    pub(super) fn has_document(&self) -> Option<bool> {
        self.navigation
            .map(|nav| matches!(nav.stage, Stage::Drawn | Stage::Document))
    }

    fn shows_failure_document(&self) -> bool {
        self.navigation
            .is_some_and(|nav| nav.stage == Stage::Document)
    }

    fn retry_failure_document(&mut self) -> Option<u64> {
        let nav = self.navigation.as_mut()?;
        if nav.stage != Stage::Document {
            return None;
        }
        nav.stage = Stage::Superseded;
        Some(nav.id)
    }

    fn drawn(&mut self, id: u64, now: Instant) {
        if let Some(nav) = &mut self.navigation {
            if nav.id == id
                && now < nav.deadline
                && matches!(nav.stage, Stage::Initial | Stage::Retry)
            {
                nav.stage = Stage::Drawn;
            }
        }
    }

    fn expire(&mut self, id: u64, now: Instant, allowed: bool) -> Option<Action> {
        let nav = self.navigation.as_mut()?;
        if !allowed || nav.id != id || now < nav.deadline {
            return None;
        }
        match nav.stage {
            Stage::Initial => Some(Action::Renavigate(self.start(now, Stage::RetryRequested))),
            Stage::RetryRequested | Stage::Retry => {
                nav.stage = Stage::Document;
                Some(Action::Document)
            }
            _ => None,
        }
    }
}

impl HostState {
    pub(super) fn first_paint(&self) -> MutexGuard<'_, FirstPaintWatch> {
        self.first_paint
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn mark_first_paint(&self, id: u64) {
        let now = Instant::now();
        self.first_paint().drawn(id, now);
    }

    fn expire_first_paint(&self, id: u64, now: Instant) -> Option<Action> {
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        self.first_paint().expire(
            id,
            now,
            matches!(*quit, QuitState::Idle | QuitState::Failed(_)),
        )
    }
}

fn is_root(url: &tauri::Url) -> bool {
    is_app_navigation(url) && url.fragment().is_none()
}

pub(super) fn is_document_url(url: &str) -> bool {
    url == DOCUMENT_URL
}

pub(super) fn is_document_request(request: &http::Request<Vec<u8>>) -> bool {
    let uri = request.uri();
    uri.scheme_str() == Some("massion")
        && uri.authority().is_some_and(|value| value == "app")
        && uri
            .path_and_query()
            .is_some_and(|value| value == "/cannot-start")
}

pub(super) fn on_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    let state = app.state::<HostState>();
    if is_document_url(url.as_str()) {
        return state.first_paint().shows_failure_document();
    }
    if is_root(url) {
        let navigation = {
            let mut watch = state.first_paint();
            // A delayed policy callback must not replace the host's failure document.
            if watch.shows_failure_document() {
                return false;
            }
            watch.navigate(Instant::now())
        };
        if let Some(navigation) = navigation {
            schedule_deadline(app.clone(), navigation);
        }
    }
    is_app_navigation(url)
}

fn schedule_deadline(app: AppHandle, navigation: Navigation) {
    if let Err(error) = std::thread::Builder::new().spawn(move || {
        std::thread::sleep(
            navigation
                .deadline
                .saturating_duration_since(Instant::now()),
        );
        let handle = app.clone();
        window_effect("schedule first paint deadline", || {
            app.run_on_main_thread(move || {
                apply_deadline(&handle, navigation.id);
            })
        });
    }) {
        eprintln!("Could not start the first paint watch: {error}");
    }
}

pub(super) fn on_document_commit(window: tauri::WebviewWindow, url: &tauri::Url) {
    if !is_root(url) {
        return;
    }
    let navigation = window.state::<HostState>().first_paint().navigation;
    if let Some(Navigation {
        id,
        stage: Stage::Initial | Stage::Retry,
        ..
    }) = navigation
    {
        // WebKit's paint entry belongs to this committed document. A buffered entry also covers an early paint.
        let script = format!("(() => {{ const observe = () => {{ if (document.querySelector('#health, .cannot-start #technical-details')) new PerformanceObserver((list, observer) => {{ if (list.getEntriesByName('first-contentful-paint').length) {{ observer.disconnect(); void window.__TAURI__.core.invoke('desktop_ready', {{ firstPaint: '{id}' }}).catch(() => {{}}); }} }}).observe({{ type: 'paint', buffered: true }}); }}; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, {{ once: true }}); else observe(); }})();");
        window_effect("observe first contentful paint", || window.eval(script));
    }
}

fn apply_deadline(app: &AppHandle, id: u64) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let state = app.state::<HostState>();
    let Some(action) = state.expire_first_paint(id, Instant::now()) else {
        return;
    };
    let (url, attempt, result, retry) = match action {
        Action::Renavigate(retry) => (APP_URL, 1, "renavigate", Some(retry)),
        Action::Document => (DOCUMENT_URL, 2, "document", None),
    };
    window_effect("navigate after first paint deadline", || {
        window.navigate(url.parse().expect("the host URL parses"))
    });
    if let Some(retry) = retry {
        schedule_deadline(app.clone(), retry);
    }
    let log = state
        .daemon_log
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    if let Some(path) = log {
        let entry = serde_json::json!({ "hostFirstPaintWatch": {
            "time": unix_time_ms(), "attempt": attempt, "result": result,
        }});
        tauri::async_runtime::spawn_blocking(move || append_daemon_log_line(&path, entry));
    }
}

pub(super) fn failure_response(
    state: &HostState,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    if request.method() != http::Method::GET
        || !request.body().is_empty()
        || !state.first_paint().shows_failure_document()
    {
        return bare_response(404);
    }
    let log = state
        .daemon_log
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    cannot_start::response(CannotStartReason::PageNotDrawn, log.as_deref())
}

pub(super) fn retry_document(invoke: tauri::ipc::Invoke<tauri::Wry>) {
    let window = invoke.message.webview();
    let resolver = invoke.resolver;
    let on_error = resolver.clone();
    let handle = window.clone();
    if let Err(error) = handle.run_on_main_thread(move || {
        let state = window.state::<HostState>();
        let active = window.url().is_ok_and(|url| is_document_url(url.as_str()));
        let retry = {
            let quit = state.quit.lock().unwrap_or_else(PoisonError::into_inner);
            if active && matches!(*quit, QuitState::Idle | QuitState::Failed(_)) {
                state.first_paint().retry_failure_document()
            } else {
                None
            }
        };
        let Some(id) = retry else {
            resolver.reject("The first paint document is no longer active");
            return;
        };
        let outcome = window.navigate(APP_URL.parse().expect("the app URL parses"));
        if outcome.is_err() {
            if let Some(nav) = &mut state.first_paint().navigation {
                if nav.id == id && nav.stage == Stage::Superseded {
                    nav.stage = Stage::Document;
                }
            }
        }
        resolver.respond(outcome.map_err(Into::into));
    }) {
        on_error.reject(error.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cannot_start_tests::MockRelay;

    fn retry(action: Option<Action>) -> Navigation {
        let Some(Action::Renavigate(navigation)) = action else {
            panic!("expected one root retry, got {action:?}");
        };
        navigation
    }

    #[test]
    fn missing_paint_retries_once_then_loads_the_host_document() {
        for observes_retry_policy in [false, true] {
            let state = HostState::default();
            if !observes_retry_policy {
                // Recovery can still be waiting when the host needs to show the document.
                state.recovery.lock().unwrap().phase = RecoveryPhase::Running;
            }
            let start = Instant::now();
            let first = state.first_paint().navigate(start).unwrap();
            let deadline = start + Duration::from_secs(20);
            assert_eq!(
                state.expire_first_paint(first.id, deadline - Duration::from_nanos(1)),
                None
            );
            let second = retry(state.expire_first_paint(first.id, deadline));
            if observes_retry_policy {
                assert!(state.first_paint().navigate(deadline).is_none());
            }
            let retry_deadline = deadline + Duration::from_secs(20);
            assert_eq!(state.expire_first_paint(first.id, retry_deadline), None);
            assert_eq!(
                state.expire_first_paint(second.id, retry_deadline - Duration::from_nanos(1)),
                None
            );
            assert_eq!(
                state.expire_first_paint(second.id, retry_deadline),
                Some(Action::Document)
            );
            assert_eq!(state.expire_first_paint(second.id, retry_deadline), None);

            let request = || http::Request::get(DOCUMENT_URL).body(Vec::new()).unwrap();
            assert!(is_document_request(&request()));
            let document = failure_response(&state, request());
            let existing = cannot_start::response(CannotStartReason::ConnectionUnavailable, None);
            assert_eq!(document.status(), existing.status());
            assert_eq!(document.headers(), existing.headers());
            assert_eq!(
                String::from_utf8(document.into_body()).unwrap(),
                String::from_utf8(existing.into_body())
                    .unwrap()
                    .replace("start-connection-unavailable", "start-page-not-drawn")
            );

            assert_eq!(
                state.first_paint().retry_failure_document(),
                Some(second.id)
            );
            assert_eq!(state.first_paint().retry_failure_document(), None);
            let user_retry = state.first_paint().navigate(retry_deadline).unwrap();
            retry(
                state.expire_first_paint(user_retry.id, retry_deadline + Duration::from_secs(20)),
            );
            assert_eq!(failure_response(&state, request()).status(), 404);
        }
    }

    #[test]
    fn only_the_current_paint_can_stop_the_watch() {
        let mut watch = FirstPaintWatch::default();
        let start = Instant::now();
        let deadline = start + Duration::from_secs(20);
        let first = watch.navigate(start).unwrap();
        watch.drawn(first.id, deadline);
        let second = retry(watch.expire(first.id, deadline, true));
        assert!(watch.navigate(deadline).is_none());
        watch.drawn(first.id, deadline);
        assert_eq!(watch.navigation.unwrap().stage, Stage::Retry);
        watch.drawn(second.id, deadline);
        assert_eq!(
            watch.expire(second.id, deadline + Duration::from_secs(20), true),
            None
        );
        assert_eq!(watch.has_document(), Some(true));
    }

    #[test]
    fn quit_and_restart_stop_the_watch() {
        for (quit, allowed) in [
            (QuitState::Idle, true),
            (QuitState::Failed(DrainFailure::NoAnswer), true),
            (QuitState::Queued(QuitAttempt::new(false)), false),
            (QuitState::Waiting(QuitAttempt::new(false)), false),
            (QuitState::Waiting(QuitAttempt::new(true)), false),
            (QuitState::Drained, false),
            (QuitState::Relaunching, false),
        ] {
            let state = HostState::default();
            *state.quit.lock().unwrap() = quit;
            let start = Instant::now();
            let nav = state.first_paint().navigate(start).unwrap();
            let action = state.expire_first_paint(nav.id, start + Duration::from_secs(20));
            assert_eq!(matches!(action, Some(Action::Renavigate(_))), allowed);
        }
    }

    #[test]
    fn recovery_navigation_has_its_own_retry() {
        let state = HostState::default();
        let start = Instant::now();
        let first = state.first_paint().navigate(start).unwrap();
        let deadline = start + Duration::from_secs(20);
        state.recovery.lock().unwrap().phase = RecoveryPhase::Running;
        let second = retry(state.expire_first_paint(first.id, deadline));
        let retry_deadline = deadline + Duration::from_secs(20);

        // The relay may already have prepared HTML while the navigation is still blank.
        state.first_document_served.store(true, Ordering::SeqCst);
        let relay = MockRelay::new();
        let (replacement, _peer) = relay.connect_client();
        let mut recovered_id = None;
        let recovered = state.recover_supervisor(
            |_| {},
            || Ok(replacement.clone()),
            || retry_deadline,
            || {
                assert_eq!(state.expire_first_paint(second.id, retry_deadline), None);
                recovered_id = state
                    .first_paint()
                    .navigate(retry_deadline)
                    .map(|nav| nav.id);
            },
        );
        assert!(recovered.unwrap().same_connection(&replacement));
        let recovered_id = recovered_id.expect("recovery should start a fresh navigation");
        retry(state.expire_first_paint(recovered_id, retry_deadline + Duration::from_secs(20)));
    }
}
