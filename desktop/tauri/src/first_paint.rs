use super::*;

const DEADLINE: Duration = Duration::from_secs(20);
const DOCUMENT_URL: &str = "massion://app/cannot-start";
const ROUND_QUERY: &str = "__massion_round=";

pub(super) const PAINT_SCRIPT: &str = r#"(() => {
    const round = new URLSearchParams(window.location.search).get('__massion_round');
    if (!round) return;
    const observe = () => {
        if (!document.querySelector('#health, .cannot-start #technical-details')) return;
        new PerformanceObserver((list, observer) => {
            if (!list.getEntriesByName('first-contentful-paint').length) return;
            observer.disconnect();
            void window.__TAURI__.core.invoke('desktop_ready', { firstPaint: round }).catch(() => {});
        }).observe({ type: 'paint', buffered: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
    else observe();
})();"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Initial,
    Retry,
    Drawn,
    DocumentRequested,
    Document,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Navigation {
    id: u64,
    deadline: Instant,
    stage: Stage,
    superseded: bool,
}

impl Navigation {
    fn url(self, base: &str) -> tauri::Url {
        format!("{base}?{ROUND_QUERY}{}", self.id)
            .parse()
            .expect("the host URL parses")
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Renavigate(Navigation),
    Document(Navigation),
    Rearm(Navigation),
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
            superseded: false,
        };
        self.navigation = Some(navigation);
        navigation
    }

    pub(super) fn start_root(&mut self, now: Instant) -> Navigation {
        self.start(now, Stage::Initial)
    }

    pub(super) fn supersede_pending(&mut self) {
        if let Some(nav) = &mut self.navigation {
            if matches!(
                nav.stage,
                Stage::Initial | Stage::Retry | Stage::DocumentRequested
            ) {
                nav.superseded = true;
            }
        }
    }

    pub(super) fn is_superseded(&self) -> bool {
        self.navigation.is_some_and(|nav| nav.superseded)
    }

    fn rearm_superseded(&mut self) -> Option<Action> {
        let nav = self.navigation.as_mut()?;
        if !nav.superseded {
            return None;
        }
        nav.superseded = false;
        Some(match nav.stage {
            Stage::DocumentRequested => Action::Document(*nav),
            _ => Action::Rearm(*nav),
        })
    }

    pub(super) fn failure_document_drawn(&self) -> bool {
        self.navigation
            .is_some_and(|nav| nav.stage == Stage::Document)
    }

    fn allows_root_round(&self, id: u64) -> bool {
        self.navigation.is_some_and(|nav| {
            nav.id == id
                && !nav.superseded
                && matches!(nav.stage, Stage::Initial | Stage::Retry | Stage::Drawn)
        })
    }

    fn allows_failure_round(&self, id: u64) -> bool {
        self.navigation.is_some_and(|nav| {
            nav.id == id
                && !nav.superseded
                && matches!(nav.stage, Stage::DocumentRequested | Stage::Document)
        })
    }

    fn retry_failure_document(
        &mut self,
        id: u64,
        now: Instant,
    ) -> Option<(Navigation, Navigation)> {
        let nav = self.navigation?;
        if !self.allows_failure_round(id) {
            return None;
        }
        Some((nav, self.start_root(now)))
    }

    fn drawn(&mut self, id: u64) {
        if let Some(nav) = &mut self.navigation {
            if nav.id == id {
                match nav.stage {
                    Stage::Initial | Stage::Retry => {
                        nav.stage = Stage::Drawn;
                        nav.superseded = false;
                    }
                    Stage::DocumentRequested if !nav.superseded => nav.stage = Stage::Document,
                    _ => {}
                }
            }
        }
    }

    fn expire(&mut self, id: u64, now: Instant, allowed: bool) -> Option<Action> {
        let nav = self.navigation?;
        if !allowed || nav.superseded || nav.id != id || now < nav.deadline {
            return None;
        }
        match nav.stage {
            Stage::Initial => Some(Action::Renavigate(self.start(now, Stage::Retry))),
            Stage::Retry => Some(Action::Document(self.start(now, Stage::DocumentRequested))),
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
        self.first_paint().drawn(id);
    }

    fn expire_first_paint(&self, id: u64, now: Instant) -> Option<Action> {
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        self.first_paint().expire(
            id,
            now,
            matches!(*quit, QuitState::Idle | QuitState::Failed(_)),
        )
    }

    fn resume_first_paint(&self, now: Instant) -> Option<Action> {
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        if !matches!(*quit, QuitState::Failed(_)) {
            return None;
        }
        let mut watch = self.first_paint();
        let navigation = watch.navigation?;
        if navigation.superseded {
            if self.first_document_served.load(Ordering::SeqCst) {
                return watch.rearm_superseded();
            }
            return Some(Action::Renavigate(watch.start_root(now)));
        }
        watch.expire(navigation.id, now, true)
    }

    fn rearm_served_root(&self) -> Option<Action> {
        let quit = self.quit.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(*quit, QuitState::Idle | QuitState::Failed(_))
            && self.first_document_served.load(Ordering::SeqCst)
        {
            self.first_paint().rearm_superseded()
        } else {
            None
        }
    }
}

fn parse_round(query: &str) -> Option<u64> {
    let digits = query.strip_prefix(ROUND_QUERY)?;
    if digits.starts_with('0') || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

pub(super) fn root_round(url: &str) -> Option<u64> {
    let (base, query) = url.split_once('?')?;
    let origin = base.strip_suffix('/')?;
    if !APP_ORIGINS.contains(&origin) {
        return None;
    }
    parse_round(query.split('#').next()?)
}

pub(super) fn document_round(url: &str) -> Option<u64> {
    let (base, query) = url.split_once('?')?;
    if base != DOCUMENT_URL {
        return None;
    }
    parse_round(query)
}

pub(super) fn strip_root_round(request: &mut http::Request<Vec<u8>>) {
    if request.method() == http::Method::GET
        && request.body().is_empty()
        && request.uri().path() == "/"
        && request.uri().query().is_some()
        && root_round(&request.uri().to_string()).is_some()
    {
        let mut parts = request.uri().clone().into_parts();
        parts.path_and_query = Some(http::uri::PathAndQuery::from_static("/"));
        *request.uri_mut() = http::Uri::from_parts(parts).expect("the root URI parses");
    }
}

pub(super) fn initial_url(app: &AppHandle) -> tauri::Url {
    let navigation = app
        .state::<HostState>()
        .first_paint()
        .start_root(Instant::now());
    schedule_deadline(app.clone(), navigation);
    navigation.url(APP_URL)
}

pub(super) fn on_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    let state = app.state::<HostState>();
    if let Some(id) = document_round(url.as_str()) {
        return state.first_paint().allows_failure_round(id);
    }
    if let Some(id) = root_round(url.as_str()) {
        return state.first_paint().allows_root_round(id);
    }
    if !is_app_navigation(url) {
        return false;
    }
    if url.fragment().is_some() {
        return true;
    }

    // The workbench can replace its address with a bare root after losing the connection.
    let navigation = {
        let mut watch = state.first_paint();
        if watch.navigation.is_some_and(|nav| {
            !nav.superseded && matches!(nav.stage, Stage::DocumentRequested | Stage::Document)
        }) {
            return false;
        }
        watch.start_root(Instant::now())
    };
    let base = format!("{}/", url.as_str().trim_end_matches('/'));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let handle = app.clone();
        window_effect("schedule the tagged root navigation", || {
            app.run_on_main_thread(move || {
                if !handle
                    .state::<HostState>()
                    .first_paint()
                    .allows_root_round(navigation.id)
                {
                    return;
                }
                window_effect("navigate to the tagged root", || {
                    if let Some(window) = handle.get_webview_window(WINDOW_LABEL) {
                        navigate_root_to(window.as_ref(), navigation, &base)?;
                    }
                    Ok(())
                });
            })
        });
    });
    false
}

pub(super) fn navigate_root(window: &tauri::Webview, navigation: Navigation) -> tauri::Result<()> {
    navigate_root_to(window, navigation, APP_URL)
}

fn navigate_root_to(
    window: &tauri::Webview,
    navigation: Navigation,
    base: &str,
) -> tauri::Result<()> {
    let result = window.navigate(navigation.url(base));
    schedule_deadline(window.app_handle().clone(), navigation);
    result
}

fn schedule_deadline(app: AppHandle, navigation: Navigation) {
    schedule_deadline_worker(
        move || {
            std::thread::sleep(
                navigation
                    .deadline
                    .saturating_duration_since(Instant::now()),
            );
            let handle = app.clone();
            window_effect("schedule first paint deadline", || {
                app.run_on_main_thread(move || {
                    apply_watch_action(&handle, |state| {
                        state.expire_first_paint(navigation.id, Instant::now())
                    });
                })
            });
        },
        |worker| std::thread::Builder::new().spawn(worker).map(drop),
        |worker| {
            tauri::async_runtime::spawn_blocking(worker);
        },
    );
}

fn schedule_deadline_worker<F: FnOnce() + Clone>(
    worker: F,
    spawn: impl FnOnce(F) -> std::io::Result<()>,
    fallback: impl FnOnce(F),
) {
    if let Err(error) = spawn(worker.clone()) {
        eprintln!("Could not start the first paint watch thread: {error}");
        fallback(worker);
    }
}

fn apply_watch_action(app: &AppHandle, decide: impl FnOnce(&HostState) -> Option<Action>) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let state = app.state::<HostState>();
    let Some(action) = decide(&state) else {
        return;
    };
    window_effect("navigate after first paint deadline", || {
        let (attempt, result) = match action {
            Action::Rearm(navigation) => {
                schedule_deadline(app.clone(), navigation);
                return Ok(());
            }
            Action::Renavigate(retry) => {
                navigate_root(window.as_ref(), retry)?;
                (1, "renavigate")
            }
            Action::Document(document) => {
                if !state.first_paint().allows_failure_round(document.id) {
                    return Ok(());
                }
                window.navigate(document.url(DOCUMENT_URL))?;
                (2, "document")
            }
        };
        let log = state
            .daemon_log
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(path) = log {
            let entry = serde_json::json!({ "hostFirstPaintWatch": {
                "time": unix_time_ms(), "attempt": attempt, "result": result,
            }});
            tauri::async_runtime::spawn(async move { append_daemon_log_line(&path, entry) });
        }
        Ok(())
    });
}

pub(super) fn rearm_served_root(app: &AppHandle) {
    apply_watch_action(app, HostState::rearm_served_root);
}

pub(super) fn resume_after_failed_quit(app: &AppHandle) {
    let handle = app.clone();
    window_effect("resume first paint watch after a failed quit", || {
        app.run_on_main_thread(move || {
            apply_watch_action(&handle, |state| state.resume_first_paint(Instant::now()));
        })
    });
}

pub(super) fn failure_response(
    state: &HostState,
    id: u64,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    if request.method() != http::Method::GET || !request.body().is_empty() {
        return bare_response(404);
    }
    let log = state
        .daemon_log
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let response = cannot_start::response(CannotStartReason::PageNotDrawn, log.as_deref());
    if state.first_paint().allows_failure_round(id) {
        response
    } else {
        bare_response(404)
    }
}

pub(super) fn retry_document(invoke: tauri::ipc::Invoke<tauri::Wry>, id: u64) {
    let window = invoke.message.webview();
    let resolver = invoke.resolver;
    let on_error = resolver.clone();
    let handle = window.clone();
    if let Err(error) = handle.run_on_main_thread(move || {
        let state = window.state::<HostState>();
        let active = window
            .url()
            .ok()
            .and_then(|url| document_round(url.as_str()))
            == Some(id);
        let retry = {
            let quit = state.quit.lock().unwrap_or_else(PoisonError::into_inner);
            if active && matches!(*quit, QuitState::Idle | QuitState::Failed(_)) {
                state
                    .first_paint()
                    .retry_failure_document(id, Instant::now())
            } else {
                None
            }
        };
        let Some((document, navigation)) = retry else {
            resolver.reject("The first paint document is no longer active");
            return;
        };
        let outcome = navigate_root(&window, navigation);
        if outcome.is_err() {
            let mut watch = state.first_paint();
            if watch.navigation == Some(navigation) {
                watch.navigation = Some(document);
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
    fn only_the_reserved_root_query_is_stripped() {
        let mut watch = FirstPaintWatch::default();
        let round = watch.start_root(Instant::now());
        let mut root = round.url(APP_URL);
        root.set_fragment(Some("mission=one"));
        assert_eq!(root_round(root.as_str()), Some(round.id));
        assert!(is_app_navigation(&root));
        assert!(sender_allowed(root.as_str()));

        root.set_fragment(None);
        let mut request = http::Request::get(root.as_str()).body(Vec::new()).unwrap();
        strip_root_round(&mut request);
        assert_eq!(request.uri(), APP_URL);
        assert!(is_root_app_get("massion", &request));

        for url in [
            "massion://app/?__massion_round=0",
            "massion://app/?__massion_round=1&extra=2",
            "massion://app:1234/?__massion_round=1",
            "massion://app/protocol/connect?__massion_round=1",
            "massion-app://document/?__massion_round=1",
            "massion://app/?ordinary=1",
        ] {
            assert!(!is_app_navigation(&url.parse().unwrap()), "{url}");
            assert!(!sender_allowed(url), "{url}");
            let mut request = http::Request::get(url).body(Vec::new()).unwrap();
            strip_root_round(&mut request);
            assert_eq!(request.uri(), url);
        }
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
            let first = state.first_paint().start_root(start);
            let deadline = start + Duration::from_secs(20);
            assert_eq!(
                state.expire_first_paint(first.id, deadline - Duration::from_nanos(1)),
                None
            );
            let second = retry(state.expire_first_paint(first.id, deadline));
            if observes_retry_policy {
                assert!(state.first_paint().allows_root_round(second.id));
            }
            let retry_deadline = deadline + Duration::from_secs(20);
            assert_eq!(state.expire_first_paint(first.id, retry_deadline), None);
            assert_eq!(
                state.expire_first_paint(second.id, retry_deadline - Duration::from_nanos(1)),
                None
            );
            let Some(Action::Document(fallback)) =
                state.expire_first_paint(second.id, retry_deadline)
            else {
                panic!("the second deadline must open the failure document");
            };
            assert_eq!(state.expire_first_paint(second.id, retry_deadline), None);

            let fallback_url = fallback.url(DOCUMENT_URL);
            let request = || {
                http::Request::get(fallback_url.as_str())
                    .body(Vec::new())
                    .unwrap()
            };
            assert_eq!(document_round(fallback_url.as_str()), Some(fallback.id));
            assert!(!state.first_paint().failure_document_drawn());
            let document = failure_response(&state, fallback.id, request());
            let existing = cannot_start::response(CannotStartReason::ConnectionUnavailable, None);
            assert_eq!(document.status(), existing.status());
            assert_eq!(document.headers(), existing.headers());
            assert_eq!(
                String::from_utf8(document.into_body()).unwrap(),
                String::from_utf8(existing.into_body())
                    .unwrap()
                    .replace("start-connection-unavailable", "start-page-not-drawn")
            );

            state.first_paint().drawn(second.id);
            assert!(!state.first_paint().failure_document_drawn());
            if observes_retry_policy {
                state.first_paint().drawn(fallback.id);
                assert!(state.first_paint().failure_document_drawn());
            }
            let (_, user_retry) = state
                .first_paint()
                .retry_failure_document(fallback.id, retry_deadline)
                .unwrap();
            assert_eq!(
                state
                    .first_paint()
                    .retry_failure_document(fallback.id, retry_deadline),
                None
            );
            retry(
                state.expire_first_paint(user_retry.id, retry_deadline + Duration::from_secs(20)),
            );
            assert_eq!(
                failure_response(&state, fallback.id, request()).status(),
                404
            );
        }
    }

    #[test]
    fn only_the_current_paint_can_stop_the_watch() {
        let mut watch = FirstPaintWatch::default();
        let start = Instant::now();
        let deadline = start + Duration::from_secs(20);
        let first = watch.start_root(start);
        let second = retry(watch.expire(first.id, deadline, true));
        assert!(watch.allows_root_round(second.id));
        watch.drawn(first.id);
        assert_eq!(watch.navigation.unwrap().stage, Stage::Retry);
        watch.drawn(second.id);
        assert_eq!(
            watch.expire(second.id, deadline + Duration::from_secs(20), true),
            None
        );
        assert_eq!(watch.navigation.unwrap().stage, Stage::Drawn);
    }

    #[test]
    fn paint_before_the_deadline_action_preserves_the_current_document() {
        let mut watch = FirstPaintWatch::default();
        let now = Instant::now();
        let round = watch.start_root(now - Duration::from_secs(20));
        watch.drawn(round.id);
        assert_eq!(watch.expire(round.id, now, true), None);
    }

    #[test]
    fn deadline_worker_uses_the_fallback_only_if_the_thread_fails() {
        use std::cell::Cell;
        for thread_started in [true, false] {
            let fired = Cell::new(0);
            let fallback_called = Cell::new(false);
            schedule_deadline_worker(
                || fired.set(fired.get() + 1),
                |work| {
                    if thread_started {
                        work();
                        Ok(())
                    } else {
                        Err(std::io::Error::other("injected thread start failure"))
                    }
                },
                |work| {
                    fallback_called.set(true);
                    work();
                },
            );
            assert_eq!(fallback_called.get(), !thread_started);
            assert_eq!(fired.get(), 1);
        }
    }

    #[test]
    fn a_failed_quit_rearms_the_round_superseded_by_recovery() {
        let state = HostState::default();
        let start = Instant::now();
        let old = state.first_paint().start_root(start);
        state.recovery.lock().unwrap().phase = RecoveryPhase::Running;
        let relay = MockRelay::new();
        let (replacement, _peer) = relay.connect_client();
        let attempt = QuitAttempt::new(false);
        let now = start + Duration::from_secs(30);
        state
            .recover_supervisor(
                |_| {},
                || Ok(replacement.clone()),
                || start + Duration::from_secs(1),
                || {
                    assert!(state.first_paint().is_superseded());
                    *state.quit.lock().unwrap() = QuitState::Queued(attempt.clone());
                    assert!(state
                        .prepare_initial_document_retry(|watch| watch.start_root(now))
                        .is_none());
                    assert_eq!(state.expire_first_paint(old.id, now), None);
                    assert_eq!(state.resume_first_paint(now), None);
                },
            )
            .unwrap();
        let mut resumed = None;
        finish_quit(
            &state.quit,
            &attempt,
            Err(DrainFailure::NoAnswer),
            |_| panic!("the quit failed"),
            |_| {},
            || resumed = state.resume_first_paint(now),
        );
        let root = retry(resumed);
        assert_ne!(old.id, root.id);
        assert_eq!(
            state.expire_first_paint(root.id, now + Duration::from_secs(19)),
            None
        );
        retry(state.expire_first_paint(root.id, now + Duration::from_secs(20)));
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
            let nav = state.first_paint().start_root(start);
            let action = state.expire_first_paint(nav.id, start + Duration::from_secs(20));
            assert_eq!(matches!(action, Some(Action::Renavigate(_))), allowed);
        }
    }

    #[test]
    fn recovery_preserves_the_deadline_of_a_served_root() {
        let state = HostState::default();
        let start = Instant::now();
        let first = state.first_paint().start_root(start);
        let request = http::Request::get(APP_URL).body(Vec::new()).unwrap();
        let response = scheme_response_for_state(&state, "massion", request, Duration::ZERO);
        assert!(!response.body().is_empty());
        assert!(state.first_document_served.load(Ordering::SeqCst));

        state.recovery.lock().unwrap().phase = RecoveryPhase::Running;
        let relay = MockRelay::new();
        let (replacement, _peer) = relay.connect_client();
        state
            .recover_supervisor(
                |_| {},
                || Ok(replacement.clone()),
                || start + Duration::from_secs(1),
                || {
                    assert!(
                        state
                            .prepare_initial_document_retry(|watch| watch.start_root(start))
                            .is_none(),
                        "a delivered root must not be re-navigated by recovery"
                    );
                },
            )
            .unwrap();

        let deadline = start + Duration::from_secs(20);
        assert_eq!(
            state.expire_first_paint(first.id, deadline - Duration::from_nanos(1)),
            None
        );
        retry(state.expire_first_paint(first.id, deadline));
    }

    #[test]
    fn a_root_served_before_the_queued_recovery_navigation_keeps_its_round() {
        let state = HostState::default();
        let start = Instant::now();
        let first = state.first_paint().start_root(start);
        state.recovery.lock().unwrap().phase = RecoveryPhase::Running;
        let relay = MockRelay::new();
        let (replacement, _peer) = relay.connect_client();
        state
            .recover_supervisor(
                |_| {},
                || Ok(replacement.clone()),
                || start + Duration::from_secs(1),
                || {
                    assert!(state.first_paint().is_superseded());
                    state.first_document_served.store(true, Ordering::SeqCst);
                    assert!(state
                        .prepare_initial_document_retry(|watch| watch.start_root(start))
                        .is_none());
                    assert_eq!(state.rearm_served_root(), Some(Action::Rearm(first)));
                },
            )
            .unwrap();
        let deadline = start + Duration::from_secs(20);
        assert_eq!(
            state.expire_first_paint(first.id, deadline - Duration::from_nanos(1)),
            None
        );
        retry(state.expire_first_paint(first.id, deadline));
    }

    #[test]
    fn recovery_navigation_has_its_own_retry() {
        let state = HostState::default();
        let start = Instant::now();
        let first = state.first_paint().start_root(start);
        let deadline = start + Duration::from_secs(20);
        state.recovery.lock().unwrap().phase = RecoveryPhase::Running;
        let second = retry(state.expire_first_paint(first.id, deadline));
        let retry_deadline = deadline + Duration::from_secs(20);

        let relay = MockRelay::new();
        let (replacement, _peer) = relay.connect_client();
        let mut recovered_id = None;
        let recovered = state.recover_supervisor(
            |_| {},
            || Ok(replacement.clone()),
            || retry_deadline,
            || {
                assert_eq!(state.expire_first_paint(second.id, retry_deadline), None);
                recovered_id = Some(state.first_paint().start_root(retry_deadline).id);
            },
        );
        assert!(recovered.unwrap().same_connection(&replacement));
        let recovered_id = recovered_id.expect("recovery should start a fresh navigation");
        retry(state.expire_first_paint(recovered_id, retry_deadline + Duration::from_secs(20)));
    }

    #[test]
    fn recovery_wins_before_the_failure_document_is_visible() {
        let state = HostState::default();
        let start = Instant::now();
        let first = state.first_paint().start_root(start);
        let deadline = start + Duration::from_secs(20);
        let second = retry(state.expire_first_paint(first.id, deadline));
        let retry_deadline = deadline + Duration::from_secs(20);
        let Some(Action::Document(fallback)) = state.expire_first_paint(second.id, retry_deadline)
        else {
            panic!("the second deadline must request the failure document");
        };
        assert!(state.first_paint().allows_failure_round(fallback.id));

        state.recovery.lock().unwrap().phase = RecoveryPhase::Running;
        let relay = MockRelay::new();
        let (replacement, _peer) = relay.connect_client();
        let mut root_navigation = None;
        state
            .recover_supervisor(
                |_| {},
                || Ok(replacement.clone()),
                || retry_deadline,
                || {
                    assert!(!state.first_paint().allows_failure_round(fallback.id));
                    let request = http::Request::get(fallback.url(DOCUMENT_URL).as_str())
                        .body(Vec::new())
                        .unwrap();
                    assert_eq!(failure_response(&state, fallback.id, request).status(), 404);
                    root_navigation = Some(state.first_paint().start_root(retry_deadline));
                },
            )
            .unwrap();
        let root = root_navigation.expect(
            "recovery must navigate to the root before the failure document becomes visible",
        );
        retry(state.expire_first_paint(root.id, retry_deadline + Duration::from_secs(20)));
    }
}
