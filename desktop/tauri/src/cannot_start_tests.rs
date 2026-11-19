use super::*;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::AtomicU64;

static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new(tag: &str) -> Self {
        use std::os::unix::fs::DirBuilderExt;
        let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let dir_name = if tag.is_empty() {
            format!("mcs-{}-{id}", std::process::id())
        } else {
            format!("mcs-{}-{id}-{tag}", std::process::id())
        };
        let path = std::env::temp_dir().join(dir_name);
        std::fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

struct MockRelay {
    _dir: TestDir,
    socket: PathBuf,
    listener: UnixListener,
}

impl MockRelay {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = TestDir::new("");
        let socket = dir.path().join("d.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            _dir: dir,
            socket,
            listener,
        }
    }

    fn connect_client(&self) -> (LineClient, UnixStream) {
        let client = LineClient::connect(&self.socket, |_| {}).unwrap();
        let (peer, _) = self.listener.accept().unwrap();
        // A relay fake whose request never arrives must fail within the
        // file's usual bound, not block a later join forever (#307).
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        peer.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut kind = String::new();
        reader.read_line(&mut kind).unwrap();
        assert_eq!(kind, "client\n");
        (client, peer)
    }

    fn read_request(reader: &mut BufReader<UnixStream>) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(line.trim_end()).unwrap()
    }

    fn write_reply(
        peer: &mut UnixStream,
        id: &str,
        status: u16,
        headers: Value,
        body: Option<&str>,
    ) {
        let payload = serde_json::json!({
            "id": id,
            "status": status,
            "headers": headers,
            "body": body,
        });
        writeln!(peer, "{}", payload).unwrap();
        peer.flush().unwrap();
    }

    fn write_error(peer: &mut UnixStream, id: &str, code: &str) {
        let payload = serde_json::json!({
            "id": id,
            "error": { "code": code, "message": "failed" }
        });
        writeln!(peer, "{}", payload).unwrap();
        peer.flush().unwrap();
    }
}

fn get_request(url: &str) -> http::Request<Vec<u8>> {
    http::Request::builder()
        .method("GET")
        .uri(url)
        .body(Vec::new())
        .unwrap()
}

fn post_request(url: &str, body: &str) -> http::Request<Vec<u8>> {
    http::Request::builder()
        .method("POST")
        .uri(url)
        .body(body.as_bytes().to_vec())
        .unwrap()
}

fn assert_empty_503(response: &http::Response<Vec<u8>>) {
    assert_eq!(response.status(), 503);
    assert!(response.body().is_empty(), "expected empty 503 body");
    assert!(
        response.headers().get("Content-Type").is_none(),
        "empty 503 must not carry a document Content-Type"
    );
}

fn assert_cannot_start_response(
    response: &http::Response<Vec<u8>>,
    expected_code: &str,
    expected_log_escaped: Option<&str>,
) {
    assert_eq!(response.status(), 503);
    assert_eq!(
        response
            .headers()
            .get("Content-Type")
            .and_then(|v| v.to_str().ok()),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        response
            .headers()
            .get("Cache-Control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(
        response
            .headers()
            .get("X-Content-Type-Options")
            .and_then(|v| v.to_str().ok()),
        Some("nosniff")
    );
    assert_eq!(
        response
            .headers()
            .get("Content-Security-Policy")
            .and_then(|v| v.to_str().ok()),
        Some(cannot_start::CONTENT_SECURITY_POLICY)
    );
    let body = String::from_utf8(response.body().clone()).unwrap();
    assert!(body.contains(cannot_start::TITLE), "missing title");
    assert!(body.contains(cannot_start::MESSAGE), "missing message");
    assert!(
        body.contains(cannot_start::RETRY_LABEL),
        "missing retry label"
    );
    assert!(
        body.contains(cannot_start::DETAILS_LABEL),
        "missing details label"
    );
    assert!(
        body.contains(cannot_start::COPY_LABEL),
        "missing copy label"
    );
    assert!(
        body.contains(expected_code),
        "missing reason code {expected_code}"
    );
    assert!(!body.contains("문제 신고"));
    assert!(!body.contains("http://"));
    assert!(!body.contains("https://"));
    match expected_log_escaped {
        Some(path) => assert!(body.contains(path), "missing log path {path}"),
        None => assert!(
            !body.contains("daemon.log"),
            "unexpected daemon.log path when file does not exist"
        ),
    }
}

fn wait_until_closed(client: &LineClient) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !client.is_closed() {
        assert!(
            Instant::now() < deadline,
            "client did not observe peer close"
        );
        std::thread::yield_now();
    }
}

#[test]
fn decide_root_failure_table_covers_every_combination() {
    let mut rows = 0usize;
    for is_root_app_get in [false, true] {
        for quit_in_progress in [false, true] {
            for failure in [
                SchemeFailure::NoClient,
                SchemeFailure::ClientClosed,
                SchemeFailure::Other,
            ] {
                for data_directory_enter_failed in [false, true] {
                    rows += 1;
                    let actual = decide_root_failure(
                        is_root_app_get,
                        quit_in_progress,
                        failure,
                        data_directory_enter_failed,
                    );
                    let expected = if !is_root_app_get || quit_in_progress {
                        RootFailureAction::Empty503
                    } else {
                        match failure {
                            SchemeFailure::NoClient => RootFailureAction::CannotStart(
                                if data_directory_enter_failed {
                                    CannotStartReason::DataDirectoryEnterFailed
                                } else {
                                    CannotStartReason::ConnectionUnavailable
                                },
                            ),
                            SchemeFailure::ClientClosed => {
                                RootFailureAction::CannotStart(CannotStartReason::ConnectionClosed)
                            }
                            SchemeFailure::Other => RootFailureAction::Empty503,
                        }
                    };
                    assert_eq!(
                        actual, expected,
                        "mismatch for ({is_root_app_get}, {quit_in_progress}, {failure:?}, {data_directory_enter_failed})"
                    );
                }
            }
        }
    }
    assert_eq!(rows, 24);
}

#[test]
fn no_stored_connection_serves_cannot_start_with_unavailable_code() {
    let state = HostState::default();
    for url in ["massion://app/", "massion://localhost/"] {
        let started = Instant::now();
        let response = scheme_response_for_state(&state, "massion", get_request(url), CLIENT_WAIT);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cannot-start path must not wait 30 seconds"
        );
        assert_cannot_start_response(&response, "start-connection-unavailable", None);
    }
}

#[test]
fn already_closed_connection_serves_cannot_start_at_once() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    drop(peer);
    wait_until_closed(&client);

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);

    let started = Instant::now();
    let response = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        CLIENT_WAIT,
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "already-closed root GET must not poll for 30 seconds"
    );
    assert_cannot_start_response(&response, "start-connection-closed", None);
}

#[test]
fn closed_while_pending_serves_cannot_start() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer);
        let request = MockRelay::read_request(&mut reader);
        assert_eq!(request["path"], "/");
        // 회신 없이 소켓을 닫아 대기 중인 요청이 Closed를 받게 한다.
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);

    let response = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        CLIENT_WAIT,
    );
    server.join().unwrap();
    assert_cannot_start_response(&response, "start-connection-closed", None);
}

#[test]
fn closed_connection_after_normal_document_serves_cannot_start() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut writer = peer;
        let first = MockRelay::read_request(&mut reader);
        assert_eq!(first["path"], "/");
        MockRelay::write_reply(
            &mut writer,
            first["id"].as_str().unwrap(),
            200,
            serde_json::json!({"Content-Type": "text/html; charset=utf-8"}),
            Some("<!doctype html><html><body>app</body></html>"),
        );
        let second = MockRelay::read_request(&mut reader);
        assert_eq!(second["path"], "/");
        // 두 번째 요청 도중 연결을 닫아 정상 문서 인도 뒤의 단절을 재현한다.
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);

    // 정상 문서를 한 번 넘긴 뒤에도 판정은 상태 없이 조건만 본다(수용된 한계).
    let first = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        CLIENT_WAIT,
    );
    assert_eq!(first.status(), 200);

    let second = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        Duration::from_millis(1),
    );
    server.join().unwrap();
    assert_cannot_start_response(&second, "start-connection-closed", None);

    let third = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        Duration::from_millis(1),
    );
    assert_cannot_start_response(&third, "start-connection-closed", None);
}

#[test]
fn non_root_api_and_published_document_requests_stay_empty_503() {
    let state = HostState::default();
    let doc_url = format!("massion-app://document/{}", "a".repeat(64));
    for (scheme, request) in [
        ("massion", get_request("massion://app/other")),
        ("massion", get_request("massion://app/?q=1")),
        ("massion", post_request("massion://app/", "")),
        ("massion", post_request("massion://app/protocol/connect", "{}")),
        ("massion", get_request("massion://app/desktop/settings")),
        ("massion-app", get_request(&doc_url)),
    ] {
        let response = scheme_response_for_state(&state, scheme, request, Duration::from_millis(1));
        assert_empty_503(&response);
    }
}

#[test]
fn relay_replies_pass_through_except_refused_header_stays_empty_503() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut writer = peer;
        for (expected_path, status, headers, body) in [
            ("/", 503u16, serde_json::json!({"Content-Type": "text/plain"}), Some("relay busy")),
            ("/?q=1", 200, serde_json::json!({"Content-Type": "text/html"}), Some("body")),
            ("/", 500, serde_json::json!({"Content-Type": "text/plain"}), Some("body")),
            ("/", 404, serde_json::json!({"Content-Type": "text/plain"}), Some("body")),
            ("/", 302, serde_json::json!({"Location": "/other"}), Some("body")),
            ("/", 200, serde_json::json!({"X-Bad": "bad\nheader"}), Some("body")),
            ("/", 200, serde_json::json!({"Content-Type": "text/html; charset=utf-8"}), None),
            ("/", 200, serde_json::json!({"Content-Type": "text/html; charset=utf-8"}), Some("")),
            ("/", 201, serde_json::json!({"Content-Type": "text/html; charset=utf-8"}), Some("<!doctype html>")),
        ] {
            let req = MockRelay::read_request(&mut reader);
            assert_eq!(req["path"], expected_path);
            MockRelay::write_reply(&mut writer, req["id"].as_str().unwrap(), status, headers, body);
        }
        let last = MockRelay::read_request(&mut reader);
        MockRelay::write_error(&mut writer, last["id"].as_str().unwrap(), "upstream");
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);

    let relay_503 =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_eq!(relay_503.status(), 503);
    assert_eq!(relay_503.body(), b"relay busy");

    // 쿼리가 붙은 경로는 그대로 중계로 전달되고 상태는 되돌아온다.
    assert_eq!(
        scheme_response_for_state(&state, "massion", get_request("massion://app/?q=1"), CLIENT_WAIT)
            .status(),
        200
    );
    for expected_status in [500u16, 404, 302] {
        assert_eq!(
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT)
                .status(),
            expected_status
        );
    }
    // 줄바꿈이 든 문자열 헤더는 HTTP 응답 생성 단계에서 거절돼 빈 503이 된다.
    let refused_header =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_empty_503(&refused_header);
    // 본문이 없거나 빈 유효한 200과 201은 상태 그대로 전달된다.
    for expected_status in [200u16, 200, 201] {
        assert_eq!(
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT)
                .status(),
            expected_status
        );
    }

    let invalid =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_empty_503(&invalid);

    server.join().unwrap();
}

#[test]
fn quit_in_progress_keeps_empty_503_and_failed_quit_serves_cannot_start() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer);
        let req = MockRelay::read_request(&mut reader);
        assert_eq!(req["path"], "/");
        // 종료 시도가 진행 중일 때 요청 도중 연결을 닫아도 빈 503이어야 한다.
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client.clone());
    let attempt = Arc::new(QuitAttempt {
        deadline: Instant::now() + DRAIN_TIMEOUT,
    });
    *state.quit.lock().unwrap() = QuitState::Waiting(attempt);

    let during_quit =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    server.join().unwrap();
    assert_empty_503(&during_quit);

    let no_client_state = HostState::default();
    let attempt2 = Arc::new(QuitAttempt {
        deadline: Instant::now() + DRAIN_TIMEOUT,
    });
    *no_client_state.quit.lock().unwrap() = QuitState::Waiting(attempt2);
    let during_quit_no_client = scheme_response_for_state(
        &no_client_state,
        "massion",
        get_request("massion://app/"),
        Duration::from_millis(1),
    );
    assert_empty_503(&during_quit_no_client);

    wait_until_closed(&client);
    *state.quit.lock().unwrap() = QuitState::Failed(DrainFailure::NoAnswer);
    let after_failed_quit =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&after_failed_quit, "start-connection-closed", None);
}

#[test]
fn data_directory_refusal_serves_cannot_start_with_its_code() {
    let state = HostState::default();
    state
        .data_directory_enter_failed
        .store(true, Ordering::SeqCst);

    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "data-directory-enter-failed", None);
}

#[test]
fn daemon_log_path_is_shown_only_when_file_exists_and_is_html_escaped() {
    let dir = TestDir::new("log-&<\"'>");
    let log = dir.path().join("daemon.log");
    let state = HostState::default();
    *state.daemon_log.lock().unwrap() = Some(log.clone());

    let missing =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&missing, "start-connection-unavailable", None);

    std::fs::write(&log, "boom\n").unwrap();
    let present =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    let escaped = log
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;");
    assert_cannot_start_response(
        &present,
        "start-connection-unavailable",
        Some(escaped.as_str()),
    );

    std::fs::remove_file(&log).unwrap();
    let removed =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&removed, "start-connection-unavailable", None);
}

#[test]
fn cannot_start_document_matches_copy_table() {
    let table: Value =
        serde_json::from_str(include_str!("../../../docs/product/screens/copy.ko.json")).unwrap();
    assert_eq!(
        table["ui.desktop.cannot-start.title"]["ko"].as_str(),
        Some(cannot_start::TITLE)
    );
    assert_eq!(
        table["ui.desktop.cannot-start.message"]["ko"].as_str(),
        Some(cannot_start::MESSAGE)
    );
    assert_eq!(
        table["ui.desktop.cannot-start.details"]["ko"].as_str(),
        Some(cannot_start::DETAILS_LABEL)
    );
    assert_eq!(
        table["conversation.button.07"]["ko"].as_str(),
        Some(cannot_start::RETRY_LABEL)
    );
    assert_eq!(
        table["conversation.button.10"]["ko"].as_str(),
        Some(cannot_start::COPY_LABEL)
    );

    let html = cannot_start::render_html(CannotStartReason::ConnectionUnavailable, None);
    let title = table["ui.desktop.cannot-start.title"]["ko"].as_str().unwrap();
    let message = table["ui.desktop.cannot-start.message"]["ko"]
        .as_str()
        .unwrap();
    let retry = table["conversation.button.07"]["ko"].as_str().unwrap();
    let details = table["ui.desktop.cannot-start.details"]["ko"]
        .as_str()
        .unwrap();
    let copy = table["conversation.button.10"]["ko"].as_str().unwrap();
    let message_tag = format!("<p class=\"message\">{message}</p>");
    let retry_tag = format!(
        "<div class=\"actions\"><button id=\"retry-launch\" type=\"button\" class=\"retry-button\">{retry}</button></div>"
    );
    let details_tag = "<details class=\"details\">";
    for expected in [
        format!("<title>{title}</title>"),
        format!("<h1>{title}</h1>"),
        message_tag.clone(),
        retry_tag.clone(),
        format!("<summary>{details}</summary>"),
        format!("<button id=\"copy-details\" type=\"button\" class=\"copy-button\">{copy}</button>"),
    ] {
        assert!(html.contains(&expected), "document missing exact element {expected}");
    }
    let message_pos = html.find(&message_tag).unwrap();
    let retry_pos = html.find(&retry_tag).unwrap();
    let details_pos = html.find(details_tag).unwrap();
    assert!(
        message_pos < retry_pos && retry_pos < details_pos,
        "retry button must sit between message and details"
    );
    assert!(!html.contains("문제 신고"));
}

struct GateSlot {
    arrived: (Mutex<bool>, std::sync::Condvar),
    released: (Mutex<bool>, std::sync::Condvar),
    response: Mutex<Option<http::Response<Vec<u8>>>>,
}

impl GateSlot {
    fn new() -> Self {
        Self {
            arrived: (Mutex::new(false), std::sync::Condvar::new()),
            released: (Mutex::new(false), std::sync::Condvar::new()),
            response: Mutex::new(None),
        }
    }

    fn pause_before_handover(&self) {
        {
            let (lock, cv) = &self.arrived;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
        let (lock, cv) = &self.released;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = cv.wait(released).unwrap();
        }
    }

    fn wait_arrived(&self) {
        let (lock, cv) = &self.arrived;
        let mut arrived = lock.lock().unwrap();
        while !*arrived {
            let (guard, timeout) = cv
                .wait_timeout(arrived, Duration::from_secs(5))
                .unwrap();
            arrived = guard;
            assert!(!timeout.timed_out(), "gate never arrived within 5 seconds");
        }
    }

    fn release(&self) {
        let (lock, cv) = &self.released;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }

    fn respond(&self, response: http::Response<Vec<u8>>) {
        *self.response.lock().unwrap() = Some(response);
    }

    fn take(&self) -> http::Response<Vec<u8>> {
        self.response
            .lock()
            .unwrap()
            .take()
            .expect("responder slot must have received a response")
    }
}

struct ReleaseOnDrop<'a>(&'a GateSlot);

impl Drop for ReleaseOnDrop<'_> {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[test]
fn blocked_responder_does_not_wait_on_the_quit_lock() {
    // 저장된 연결 없음: 즉시 시작 실패 문서가 나오는 경로로 응답기를 막는다.
    let state = HostState::default();
    let gate = GateSlot::new();

    std::thread::scope(|scope| {
        let _release_all = ReleaseOnDrop(&gate);
        let handle = scope.spawn(|| {
            respond_scheme_response(
                &state,
                "massion",
                get_request("massion://app/"),
                CLIENT_WAIT,
                |response| {
                    gate.pause_before_handover();
                    gate.respond(response);
                },
            );
        });

        // 응답기 안에 들어왔다는 신호: 이 시점에 종료 잠금을 잡아도 인도 경로가
        // 그 잠금을 기다리거나 쥐고 있어서는 안 된다.
        gate.wait_arrived();
        let quit_guard = state
            .quit
            .try_lock()
            .expect("respond must not be called while the quit lock is held");
        gate.release();
        handle
            .join()
            .unwrap_or_else(|_| panic!("hand-over must not wait on the quit lock"));
        drop(quit_guard);
        assert_cannot_start_response(&gate.take(), "start-connection-unavailable", None);
    });
}

#[test]
fn app_host_with_port_userinfo_or_other_scheme_never_serves_cannot_start() {
    let doc_path = format!("/{}", "a".repeat(64));
    let doc_url = format!("massion-app://localhost{doc_path}");
    let no_client = HostState::default();
    for (scheme, url) in [
        ("massion", "massion://app:8080/"),
        ("massion", "massion://localhost:3000/"),
        ("massion", "massion://user@app/"),
        ("massion", "massion://user@localhost/"),
        ("massion", "http://app/"),
        ("massion-app", doc_url.as_str()),
    ] {
        let response =
            scheme_response_for_state(&no_client, scheme, get_request(url), Duration::from_millis(1));
        assert_empty_503(&response);
    }

    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut writer = peer;
        for expected_path in ["/", "/", "/", doc_path.as_str()] {
            let req = MockRelay::read_request(&mut reader);
            assert_eq!(req["path"], expected_path);
            MockRelay::write_reply(
                &mut writer,
                req["id"].as_str().unwrap(),
                200,
                serde_json::json!({"Content-Type": "text/html; charset=utf-8"}),
                Some("<!doctype html><html><body>app</body></html>"),
            );
        }
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client.clone());
    for (scheme, url) in [
        ("massion", "massion://app:8080/"),
        ("massion", "massion://user@app/"),
        ("massion", "http://app/"),
        ("massion-app", doc_url.as_str()),
    ] {
        let response =
            scheme_response_for_state(&state, scheme, get_request(url), CLIENT_WAIT);
        assert_eq!(response.status(), 200);
    }

    server.join().unwrap();
    wait_until_closed(&client);
    for (scheme, url) in [
        ("massion", "massion://app:8080/"),
        ("massion", "massion://user@app/"),
        ("massion", "http://app/"),
    ] {
        let response =
            scheme_response_for_state(&state, scheme, get_request(url), Duration::from_millis(1));
        assert_empty_503(&response);
    }
    let real_root =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&real_root, "start-connection-closed", None);
}

#[test]
fn oversized_and_non_utf8_replies_stay_empty_503_not_cannot_start() {
    let relay_over = MockRelay::new();
    let (client_over, peer_over) = relay_over.connect_client();
    let server_over = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer_over.try_clone().unwrap());
        let mut writer = peer_over;
        let _ = MockRelay::read_request(&mut reader);
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..5 {
            let _ = writer.write_all(&chunk);
        }
        let _ = writer.flush();
    });

    let state_over = HostState::default();
    *state_over.client.lock().unwrap() = Some(client_over);
    let over_response =
        scheme_response_for_state(&state_over, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_empty_503(&over_response);
    assert!(
        state_over
            .client
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_closed(),
        "oversized reply must tear down the damaged connection"
    );
    // The product shuts the socket down when the reader thread ends, so the
    // server's blocked write returns while the host state still owns the
    // connection (no drop in the test).
    server_over.join().unwrap();

    let relay_utf8 = MockRelay::new();
    let (client_utf8, peer_utf8) = relay_utf8.connect_client();
    let server_utf8 = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer_utf8.try_clone().unwrap());
        let mut writer = peer_utf8;
        let _ = MockRelay::read_request(&mut reader);
        writer.write_all(b"{\"id\":\"c-0\",\"body\":\"\xff\"}\n").unwrap();
        writer.flush().unwrap();
    });

    let state_utf8 = HostState::default();
    *state_utf8.client.lock().unwrap() = Some(client_utf8);
    let utf8_response =
        scheme_response_for_state(&state_utf8, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_empty_503(&utf8_response);
    server_utf8.join().unwrap();
}

#[test]
fn non_fast_path_validation_keeps_main_wait_order_and_statuses() {
    let wait = Duration::from_millis(120);
    let non_utf8 = || {
        http::Request::builder()
            .method("GET")
            .uri("massion://app/")
            .body(vec![0xff])
            .unwrap()
    };

    let no_client = HostState::default();
    for (scheme, request) in [
        ("massion", get_request("massion://evil/")),
        ("massion-app", get_request("massion-app://document/short")),
        ("massion", non_utf8()),
    ] {
        let started = Instant::now();
        let response = scheme_response_for_state(&no_client, scheme, request, wait);
        assert!(
            started.elapsed() >= wait,
            "non-fast-path request without client must enter wait_client_in_state"
        );
        assert_empty_503(&response);
    }

    let closed_relay = MockRelay::new();
    let (closed_client, closed_peer) = closed_relay.connect_client();
    drop(closed_peer);
    wait_until_closed(&closed_client);
    let closed_state = HostState::default();
    *closed_state.client.lock().unwrap() = Some(closed_client);
    for (scheme, request) in [
        ("massion", get_request("massion://evil/")),
        ("massion-app", get_request("massion-app://document/short")),
        ("massion", non_utf8()),
    ] {
        let started = Instant::now();
        let response = scheme_response_for_state(&closed_state, scheme, request, wait);
        assert!(
            started.elapsed() >= wait,
            "non-fast-path request with closed client must enter wait_client_in_state"
        );
        assert_empty_503(&response);
    }

    // 빠른 경로는 여전히 즉시 자체 문서를 반환한다.
    let fast_started = Instant::now();
    let fast_response =
        scheme_response_for_state(&closed_state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert!(fast_started.elapsed() < Duration::from_secs(2));
    assert_cannot_start_response(&fast_response, "start-connection-closed", None);

    // 열린 연결이 있으면 main과 똑같이 404/404/400을 반환한다.
    let open_relay = MockRelay::new();
    let (open_client, _open_peer) = open_relay.connect_client();
    let open_state = HostState::default();
    *open_state.client.lock().unwrap() = Some(open_client);
    assert_eq!(
        scheme_response_for_state(&open_state, "massion", get_request("massion://evil/"), CLIENT_WAIT)
            .status(),
        404
    );
    assert_eq!(
        scheme_response_for_state(
            &open_state,
            "massion-app",
            get_request("massion-app://document/short"),
            CLIENT_WAIT
        )
        .status(),
        404
    );
    assert_eq!(
        scheme_response_for_state(&open_state, "massion", non_utf8(), CLIENT_WAIT).status(),
        400
    );
}

fn read_control_line(peer: &mut UnixStream) -> String {
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(peer, &mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}

fn bind_private_socket(dir: &Path) -> (PathBuf, UnixListener) {
    use std::os::unix::fs::PermissionsExt;
    let socket = dir.join(DAEMON_SOCKET_NAME);
    let listener = UnixListener::bind(&socket).unwrap();
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    (socket, listener)
}

// Binds the given socket path (0600) so a launch closure can make
// ensure_supervisor's probe succeed and take the Existing branch without a
// real spawn.
fn bind_existing_socket(socket: &Path) -> UnixListener {
    use std::os::unix::fs::PermissionsExt;
    let listener = UnixListener::bind(socket).unwrap();
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    listener
}

// Bounded accept: when the product stops connecting, the test must fail
// within the bound instead of hanging. The blocking accept runs on a helper
// thread (on timeout the thread is left waiting on its own test socket, which
// dies with the process), so the listener and the peer keep blocking mode on
// every platform.
fn accept_bounded(listener: &UnixListener, wait: Duration) -> std::os::unix::net::UnixStream {
    let handle = listener
        .try_clone()
        .expect("listener must be cloneable for a bounded accept");
    let (accepted_tx, accepted_rx) = std::sync::mpsc::channel::<std::io::Result<UnixStream>>();
    std::thread::spawn(move || {
        let _ = accepted_tx.send(handle.accept().map(|(peer, _)| peer));
    });
    match accepted_rx.recv_timeout(wait) {
        Ok(Ok(peer)) => peer,
        Ok(Err(error)) => panic!("accept failed: {error}"),
        Err(_) => panic!("no connection arrived within {wait:?}"),
    }
}

// Mock of the fresh supervisor that rises after the old one is gone: running
// on status, a 200 document after the client handshake, exit on drain.
const FRESH_SUPERVISOR_RUNNER: &str = r#"
            process.umask(0o077);
            const server = require('node:net').createServer(peer => {
                peer.on('error', () => {});
                let buf = '';
                let clientMode = false;
                peer.on('data', chunk => {
                    buf += chunk;
                    for (;;) {
                        const nl = buf.indexOf('\n');
                        if (nl === -1) break;
                        const line = buf.slice(0, nl);
                        buf = buf.slice(nl + 1);
                        if (!clientMode) {
                            if (line === 'status') {
                                peer.end(JSON.stringify({status:'running', pid:process.pid, origin:'http://127.0.0.1:8765'}));
                                return;
                            }
                            if (line === 'drain') {
                                server.close();
                                peer.end('{"status":"drained"}', () => process.exit(0));
                                return;
                            }
                            if (line === 'client') {
                                clientMode = true;
                                continue;
                            }
                            peer.destroy();
                            return;
                        }
                        if (!line) continue;
                        const req = JSON.parse(line);
                        peer.write(JSON.stringify({
                            id: req.id,
                            status: 200,
                            headers: {'Content-Type': 'text/html; charset=utf-8'},
                            body: 'fresh',
                        }) + '\n');
                    }
                });
            });
            server.listen(process.argv[2]);
            setTimeout(() => process.exit(1), 10000).unref();
            "#;

// A supervisor that accepts connections but never answers status: proves that
// silence from a NEW supervisor refuses at once.
const SILENT_SUPERVISOR_RUNNER: &str = r#"
            process.umask(0o077);
            const server = require('node:net').createServer(peer => {
                peer.on('error', () => {});
                peer.on('data', () => {});
            });
            server.listen(process.argv[2]);
            setTimeout(() => process.exit(0), 1500).unref();
            "#;

// Reads the handshake through the reader that must also read every later
// line of this connection: a BufReader over-reads, and dropping it after
// the handshake would discard request bytes it already buffered.
fn read_client_handshake(peer: UnixStream) -> BufReader<UnixStream> {
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(peer);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert_eq!(line, "client\n");
    reader
}

#[test]
fn decide_status_table_covers_every_combination() {
    let mut rows = 0usize;
    for origin in [
        Some(DEFAULT_DAEMON_ORIGIN),
        Some("http://127.0.0.1:9999"),
        None,
    ] {
        for status in ["running", "starting", "failed", "drained", "unknown"] {
            for draining in [false, true] {
                for cause in [None, Some("database-start"), Some("bad\ncause")] {
                    rows += 1;
                    let reply = StatusReply {
                        status: status.to_string(),
                        pid: Some(1),
                        origin: origin.map(str::to_string),
                        draining,
                        cause: cause.map(str::to_string),
                        detail: None,
                    };
                    let actual = decide_status(&reply, DEFAULT_DAEMON_ORIGIN);
                    // The expectation states the behaviour, not a copy of the
                    // product match:
                    // - wrong or missing origin: refuse without a cause
                    // - failed: refuse with the cause only when it is valid
                    //   (<= 64 bytes ASCII)
                    // - draining: ask again within the same bound, but only
                    //   for running or starting (failed refuses either way)
                    // - running/starting (not draining): attach
                    // - anything else (drained, unknown): refuse without a
                    //   cause
                    let expected = if origin != Some(DEFAULT_DAEMON_ORIGIN) {
                        StatusDecision::Refuse(None)
                    } else {
                        match status {
                            "failed" => StatusDecision::Refuse(match cause {
                                Some("database-start") => Some("database-start".to_string()),
                                _ => None,
                            }),
                            "running" | "starting" if draining => StatusDecision::RetryDraining,
                            "running" | "starting" => StatusDecision::Attach,
                            _ => StatusDecision::Refuse(None),
                        }
                    };
                    assert_eq!(
                        actual, expected,
                        "mismatch for ({origin:?}, {status}, {draining}, {cause:?})"
                    );
                }
            }
        }
    }
    assert_eq!(rows, 90);
    assert_eq!(expected_daemon_origin_from(None), DEFAULT_DAEMON_ORIGIN);
    assert_eq!(
        expected_daemon_origin_from(Some("http://127.0.0.1:9000/")),
        "http://127.0.0.1:9000"
    );
}

#[test]
fn status_running_with_missing_draining_field_attaches_and_serves() {
    let dir = TestDir::new("status-running");
    let (_socket, listener) = bind_private_socket(dir.path());
    let server = std::thread::spawn(move || {
        let mut status_peer = accept_bounded(&listener, Duration::from_secs(5));
        assert_eq!(read_control_line(&mut status_peer), "status\n");
        // Older supervisor: no "draining" field in the JSON object.
        writeln!(
            status_peer,
            "{}",
            serde_json::json!({
                "status": "running",
                "pid": 100,
                "origin": DEFAULT_DAEMON_ORIGIN,
            })
        )
        .unwrap();
        drop(status_peer);

        let relay_peer = accept_bounded(&listener, Duration::from_secs(5));
        let mut reader = read_client_handshake(relay_peer);
        let req = MockRelay::read_request(&mut reader);
        assert_eq!(req["path"], "/");
        MockRelay::write_reply(
            reader.get_mut(),
            req["id"].as_str().unwrap(),
            200,
            serde_json::json!({"Content-Type": "text/html; charset=utf-8"}),
            Some("<!doctype html><html><body>ok</body></html>"),
        );
    });

    let state = HostState::default();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        START_WAIT,
        &state.supervisor_socket,
        |_| panic!("running supervisor must not launch a second one"),
        |_| {},
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_eq!(response.status(), 200);
    assert_eq!(response.body(), b"<!doctype html><html><body>ok</body></html>");
    drop(state);
    server.join().unwrap();
}

#[test]
fn status_starting_attaches_at_once() {
    let dir = TestDir::new("status-starting-attach");
    let (_socket, listener) = bind_private_socket(dir.path());
    let server = std::thread::spawn(move || {
        let mut status_peer = accept_bounded(&listener, Duration::from_secs(5));
        assert_eq!(read_control_line(&mut status_peer), "status\n");
        writeln!(
            status_peer,
            "{}",
            serde_json::json!({
                "status": "starting",
                "pid": 101,
                "origin": DEFAULT_DAEMON_ORIGIN,
            })
        )
        .unwrap();
        drop(status_peer);

        // The relay client must be the next connection: a second status query
        // here would mean the starting wait came back and fails the handshake.
        let relay_peer = accept_bounded(&listener, Duration::from_secs(5));
        let mut reader = read_client_handshake(relay_peer);
        let req = MockRelay::read_request(&mut reader);
        assert_eq!(req["path"], "/");
        MockRelay::write_reply(
            reader.get_mut(),
            req["id"].as_str().unwrap(),
            200,
            serde_json::json!({"Content-Type": "text/html; charset=utf-8"}),
            Some("starting-attached"),
        );
    });

    let state = HostState::default();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        START_WAIT,
        &state.supervisor_socket,
        |_| panic!("starting supervisor must not launch a second one"),
        |_| {},
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_eq!(response.status(), 200);
    assert_eq!(response.body(), b"starting-attached");
    drop(state);
    server.join().unwrap();
}

#[test]
fn status_failed_with_cause_refuses_immediately_and_shows_both_codes() {
    let dir = TestDir::new("status-failed");
    let log = dir.path().join("daemon.log");
    std::fs::write(&log, "failed\n").unwrap();
    let (_socket, listener) = bind_private_socket(dir.path());
    let (checked_tx, checked_rx) = std::sync::mpsc::channel::<()>();
    let server = std::thread::spawn(move || {
        let mut peer = accept_bounded(&listener, Duration::from_secs(5));
        assert_eq!(read_control_line(&mut peer), "status\n");
        writeln!(
            peer,
            "{}",
            serde_json::json!({
                "status": "failed",
                "pid": 103,
                "origin": DEFAULT_DAEMON_ORIGIN,
                "cause": "database-start",
                "detail": "the database exited",
            })
        )
        .unwrap();
        drop(peer);
        // Check after the product returns, so "must not ask again or attach"
        // can actually fail.
        checked_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("caller must return");
        listener.set_nonblocking(true).unwrap();
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "failed start must not poll again or attach"
        );
    });

    let state = HostState::default();
    *state.daemon_log.lock().unwrap() = Some(log.clone());
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        START_WAIT,
        &state.supervisor_socket,
        |_| panic!("failed supervisor must not trigger launch"),
        |_| {},
    );
    let elapsed = started.elapsed();
    let _ = checked_tx.send(());
    server.join().unwrap();

    assert!(elapsed < Duration::from_secs(2));
    assert_eq!(
        outcome.as_ref().err(),
        Some(&StartRefusal::SupervisorFailed(Some(
            "database-start".to_string()
        )))
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    let log_str = log.to_string_lossy().into_owned();
    assert_cannot_start_response(&response, "start-connection-unavailable", Some(&log_str));
    let body = String::from_utf8(response.body().clone()).unwrap();
    assert!(
        body.contains(&format!(
            "start-connection-unavailable\ndatabase-start\n{log_str}"
        )),
        "expected existing code, failed cause, and log path together in details, got: {body}"
    );
}

struct DrainSocketOnDrop(PathBuf);
impl Drop for DrainSocketOnDrop {
    fn drop(&mut self) {
        let _ = massion_carrier::control::drain(&self.0);
    }
}

#[test]
fn status_draining_polls_again_and_starts_once_old_supervisor_is_gone() {
    for unlink_old_socket in [false, true] {
        let dir = TestDir::new(if unlink_old_socket {
            "draining-enoent"
        } else {
            "draining-econnrefused"
        });
        let (socket, listener) = bind_private_socket(dir.path());
        let _drain_guard = DrainSocketOnDrop(socket.clone());
        let runner = dir.path().join("runner.cjs");
        std::fs::write(&runner, FRESH_SUPERVISOR_RUNNER).unwrap();

        let old_socket = socket.clone();
        let old_supervisor = std::thread::spawn(move || {
            let mut peer = accept_bounded(&listener, Duration::from_secs(5));
            assert_eq!(read_control_line(&mut peer), "status\n");
            // Drop the listener (and optionally unlink) before sending the reply so
            // the next status poll deterministically observes ECONNREFUSED or ENOENT.
            drop(listener);
            if unlink_old_socket {
                std::fs::remove_file(&old_socket).unwrap();
            }
            writeln!(
                peer,
                "{}",
                serde_json::json!({
                    "status": "running",
                    "pid": 104,
                    "origin": DEFAULT_DAEMON_ORIGIN,
                    "draining": true,
                })
            )
            .unwrap();
        });

        let state = HostState::default();
        let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let launch_count = Arc::clone(&launches);
        let outcome = connect_supervisor_within(
            dir.path(),
            false,
            DEFAULT_DAEMON_ORIGIN,
            START_WAIT,
            &state.supervisor_socket,
            |sock| {
                launch_count.fetch_add(1, Ordering::SeqCst);
                let node = massion_carrier::daemon::node_binary()?;
                Ok((
                    node,
                    vec![
                        runner.to_string_lossy().to_string(),
                        sock.to_string_lossy().to_string(),
                    ],
                ))
            },
            |_| {},
        );
        old_supervisor.join().unwrap();
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        record_connect_outcome(&state, outcome);
        let response =
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
        assert_eq!(response.status(), 200);
        assert_eq!(response.body(), b"fresh");
    }
}

#[test]
fn status_disconnect_after_seen_draining_starts_a_fresh_supervisor() {
    let dir = TestDir::new("draining-disconnect");
    let (socket, listener) = bind_private_socket(dir.path());
    let _drain_guard = DrainSocketOnDrop(socket.clone());
    let runner = dir.path().join("runner.cjs");
    std::fs::write(&runner, FRESH_SUPERVISOR_RUNNER).unwrap();

    let old_supervisor = std::thread::spawn(move || {
        let mut peer = accept_bounded(&listener, Duration::from_secs(5));
        assert_eq!(read_control_line(&mut peer), "status\n");
        writeln!(
            peer,
            "{}",
            serde_json::json!({
                "status": "running",
                "pid": 108,
                "origin": DEFAULT_DAEMON_ORIGIN,
                "draining": true,
            })
        )
        .unwrap();
        drop(peer);

        // A close without an answer after draining was seen must read as
        // "gone": close the peer without replying, then close the listener so
        // the next question is NotListening.
        let mut peer = accept_bounded(&listener, Duration::from_secs(5));
        assert_eq!(read_control_line(&mut peer), "status\n");
        drop(peer);
        drop(listener);
    });

    let state = HostState::default();
    let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let launch_count = Arc::clone(&launches);
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        START_WAIT,
        &state.supervisor_socket,
        |sock| {
            launch_count.fetch_add(1, Ordering::SeqCst);
            let node = massion_carrier::daemon::node_binary()?;
            Ok((
                node,
                vec![
                    runner.to_string_lossy().to_string(),
                    sock.to_string_lossy().to_string(),
                ],
            ))
        },
        |_| {},
    );
    old_supervisor.join().unwrap();
    assert_eq!(launches.load(Ordering::SeqCst), 1);
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_eq!(response.status(), 200);
    assert_eq!(response.body(), b"fresh");
    drop(state);
}

#[test]
fn status_draining_past_wait_serves_cannot_start_unavailable() {
    let dir = TestDir::new("draining-timeout");
    let (_socket, listener) = bind_private_socket(dir.path());
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    listener.set_nonblocking(true).unwrap();
    // The loop ends at its own bound as well as on the stop signal, so a
    // caller that never returns (or a dropped sender) fails this test with
    // the rounds it saw instead of hanging the join below (#307).
    let supervisor_bound = Duration::from_secs(5);
    let server = std::thread::spawn(move || {
        let started = Instant::now();
        let mut rounds_seen = 0usize;
        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            if started.elapsed() >= supervisor_bound {
                panic!(
                    "draining supervisor still answering after {:?}, {} rounds answered",
                    supervisor_bound,
                    rounds_seen
                );
            }
            match listener.accept() {
                Ok((mut peer, _)) => {
                    peer.set_nonblocking(false).unwrap();
                    assert_eq!(read_control_line(&mut peer), "status\n");
                    rounds_seen += 1;
                    let _ = writeln!(
                        peer,
                        "{}",
                        serde_json::json!({
                            "status": "running",
                            "pid": 105,
                            "origin": DEFAULT_DAEMON_ORIGIN,
                            "draining": true,
                        })
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("accept failed: {error}"),
            }
        }
    });

    let state = HostState::default();
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_millis(250),
        &state.supervisor_socket,
        |_| panic!("must not launch while old supervisor is still draining"),
        |_| {},
    );
    let elapsed = started.elapsed();
    let _ = stop_tx.send(());
    server.join().unwrap();

    assert!(outcome.is_err());
    assert!(elapsed < Duration::from_secs(2));
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "start-connection-unavailable", None);
}
#[test]
fn a_late_socket_after_a_long_draining_wait_still_attaches() {
    let dir = TestDir::new("drain-then-late-socket");
    let (socket, listener) = bind_private_socket(dir.path());
    let _drain_guard = DrainSocketOnDrop(socket.clone());
    // The old supervisor answers draining for 3.5 s counted from the FIRST
    // status question it receives (not from the thread's start, so a runner
    // stalled before that question cannot shorten the drain the product
    // sees) and only then disappears; the fresh supervisor opens its socket
    // 2500 ms into its own 5-second start bound. A shared deadline has at
    // most 1.5 s left; the dedicated start bound still attaches. The hold is
    // a deadline, not a round count, and the thread always ends at one of its
    // two bounds, so the join below fails with the rounds it saw instead of
    // hanging (#307).
    let drain_hold = Duration::from_millis(3500);
    let supervisor_bound = Duration::from_secs(5);
    let old_supervisor = std::thread::spawn(move || {
        let started = Instant::now();
        let mut rounds_seen = 0usize;
        let mut draining_since: Option<Instant> = None;
        listener
            .set_nonblocking(true)
            .expect("listener must accept non-blocking mode");
        loop {
            if draining_since.is_none() && started.elapsed() >= supervisor_bound {
                panic!("no status question within {supervisor_bound:?}");
            }
            if let Some(since) = draining_since {
                if since.elapsed() >= drain_hold {
                    drop(listener);
                    return rounds_seen;
                }
            }
            match listener.accept() {
                Ok((mut peer, _)) => {
                    peer.set_nonblocking(false).unwrap();
                    assert_eq!(read_control_line(&mut peer), "status\n");
                    rounds_seen += 1;
                    draining_since.get_or_insert_with(Instant::now);
                    let _ = writeln!(
                        peer,
                        "{}",
                        serde_json::json!({
                            "status": "running",
                            "pid": 110,
                            "origin": DEFAULT_DAEMON_ORIGIN,
                            "draining": true,
                        })
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("accept failed: {error}"),
            }
        }
    });
    let late_runner = FRESH_SUPERVISOR_RUNNER.replace(
        "server.listen(process.argv[2]);",
        "setTimeout(() => server.listen(process.argv[2]), 2500);",
    );
    let runner = dir.path().join("late-runner.cjs");
    std::fs::write(&runner, late_runner).unwrap();

    let state = HostState::default();
    let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let launch_count = Arc::clone(&launches);
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_secs(5),
        &state.supervisor_socket,
        |sock| {
            launch_count.fetch_add(1, Ordering::SeqCst);
            let node = massion_carrier::daemon::node_binary()?;
            Ok((
                node,
                vec![
                    runner.to_string_lossy().to_string(),
                    sock.to_string_lossy().to_string(),
                ],
            ))
        },
        |_| {},
    );
    let rounds_seen = old_supervisor.join().unwrap();
    assert!(
        rounds_seen >= 1,
        "the old supervisor answered {rounds_seen} status questions, so the draining wait never started"
    );
    assert_eq!(launches.load(Ordering::SeqCst), 1);
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_eq!(response.status(), 200);
    assert_eq!(response.body(), b"fresh");
    drop(state);
}

#[test]
fn ordinary_start_runs_once_and_a_supervisor_that_dies_is_refused() {
    let dir = TestDir::new("start-once-dies");
    let socket = dir.path().join(DAEMON_SOCKET_NAME);
    let _drain_guard = DrainSocketOnDrop(socket.clone());
    let die_runner = FRESH_SUPERVISOR_RUNNER.replace(
        "server.listen(process.argv[2]);",
        "server.listen(process.argv[2], () => { server.close(); process.exit(0); });",
    );
    let runner = dir.path().join("die-runner.cjs");
    std::fs::write(&runner, die_runner).unwrap();

    let state = HostState::default();
    let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let launch_count = Arc::clone(&launches);
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_secs(1),
        &state.supervisor_socket,
        |sock| {
            launch_count.fetch_add(1, Ordering::SeqCst);
            let node = massion_carrier::daemon::node_binary()?;
            Ok((
                node,
                vec![
                    runner.to_string_lossy().to_string(),
                    sock.to_string_lossy().to_string(),
                ],
            ))
        },
        |_| {},
    );
    let elapsed = started.elapsed();
    assert_eq!(
        launches.load(Ordering::SeqCst),
        1,
        "the ordinary start runs exactly once per call"
    );
    assert!(outcome.is_err());
    assert!(
        elapsed < Duration::from_secs(5),
        "must end bounded, took {elapsed:?}"
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "start-connection-unavailable", None);
}

#[test]
fn a_supervisor_that_dies_after_existing_is_refused_without_a_restart() {
    let dir = TestDir::new("existing-then-gone");
    let socket = dir.path().join(DAEMON_SOCKET_NAME);
    let _drain_guard = DrainSocketOnDrop(socket.clone());
    // The runner would record its own spawn in this file; the Existing branch
    // must never run it, so the file has to stay absent.
    let marker = dir.path().join("spawned.count");
    let die_runner = FRESH_SUPERVISOR_RUNNER.replace(
        "server.listen(process.argv[2]);",
        "require('node:fs').appendFileSync(process.argv[3], 'spawned\\n'); server.listen(process.argv[2], () => { server.close(); process.exit(0); });",
    );
    let runner = dir.path().join("die-runner.cjs");
    std::fs::write(&runner, die_runner).unwrap();

    let state = HostState::default();
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_secs(2),
        &state.supervisor_socket,
        |sock| {
            // Open the socket first so the start reports Existing; the probe
            // connection carries no data, and the listener is closed before
            // the status ask that follows.
            let listener = bind_existing_socket(sock);
            let existing_socket = sock.to_path_buf();
            let runner_path = runner.clone();
            let marker_path = marker.clone();
            std::thread::spawn(move || {
                // The probe carries no data and closes at once; the status
                // ask that follows is closed without an answer, so the call
                // ends through the step-3 silence refusal deterministically.
                drop(accept_bounded(&listener, Duration::from_secs(5)));
                drop(accept_bounded(&listener, Duration::from_secs(5)));
            });
            let node = massion_carrier::daemon::node_binary()?;
            Ok((
                node,
                vec![
                    runner_path.to_string_lossy().to_string(),
                    existing_socket.to_string_lossy().to_string(),
                    marker_path.to_string_lossy().to_string(),
                ],
            ))
        },
        |_| {},
    );
    let elapsed = started.elapsed();
    assert_eq!(
        outcome.as_ref().err(),
        Some(&StartRefusal::Other(
            "The supervisor did not answer status".to_string()
        )),
        "a supervisor that is gone after Existing must refuse without a restart"
    );
    assert!(
        !marker.exists(),
        "no supervisor may be spawned once another starter's socket was seen"
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "must end bounded, took {elapsed:?}"
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "start-connection-unavailable", None);
}

#[test]
fn an_existing_supervisor_that_answers_draining_serves_the_document_without_asking_again() {
    let dir = TestDir::new("existing-draining");
    let socket = dir.path().join(DAEMON_SOCKET_NAME);
    let _drain_guard = DrainSocketOnDrop(socket.clone());
    let state = HostState::default();
    let (checked_tx, checked_rx) = std::sync::mpsc::channel::<()>();
    let (server_done_tx, server_done_rx) = std::sync::mpsc::channel::<()>();
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_secs(2),
        &state.supervisor_socket,
        |sock| {
            let listener = bind_existing_socket(sock);
            std::thread::spawn(move || {
                // The probe carries no data and closes at once; take it and
                // drop it so the status ask is the next connection.
                drop(accept_bounded(&listener, Duration::from_secs(5)));
                let mut status_peer = accept_bounded(&listener, Duration::from_secs(5));
                assert_eq!(read_control_line(&mut status_peer), "status\n");
                writeln!(
                    status_peer,
                    "{}",
                    serde_json::json!({
                        "status": "running",
                        "pid": 111,
                        "origin": DEFAULT_DAEMON_ORIGIN,
                        "draining": true,
                    })
                )
                .unwrap();
                drop(status_peer);
                // Check after the product returns, so "no second ask" can fail.
                checked_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("caller must return");
                listener.set_nonblocking(true).unwrap();
                assert_eq!(
                    listener.accept().unwrap_err().kind(),
                    std::io::ErrorKind::WouldBlock,
                    "a draining answer after the ordinary start must not be asked again"
                );
                drop(listener);
                let _ = server_done_tx.send(());
            });
            let node = massion_carrier::daemon::node_binary()?;
            Ok((node, vec!["-e".to_string(), "process.exit(1)".to_string()]))
        },
        |_| {},
    );
    let elapsed = started.elapsed();
    let _ = checked_tx.send(());
    server_done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("server thread must finish");
    assert_eq!(
        outcome.as_ref().err(),
        Some(&StartRefusal::Other("The supervisor is not ready".to_string())),
        "a draining Existing supervisor must refuse without returning to the draining wait"
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "must end bounded, took {elapsed:?}"
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "start-connection-unavailable", None);
}

#[test]
fn new_supervisor_that_does_not_answer_after_draining_is_refused() {
    let dir = TestDir::new("silent-new-supervisor");
    let (socket, listener) = bind_private_socket(dir.path());
    let _drain_guard = DrainSocketOnDrop(socket.clone());
    let runner = dir.path().join("silent-runner.cjs");
    std::fs::write(&runner, SILENT_SUPERVISOR_RUNNER).unwrap();

    let old_supervisor = std::thread::spawn(move || {
        let mut peer = accept_bounded(&listener, Duration::from_secs(5));
        assert_eq!(read_control_line(&mut peer), "status\n");
        writeln!(
            peer,
            "{}",
            serde_json::json!({
                "status": "running",
                "pid": 109,
                "origin": DEFAULT_DAEMON_ORIGIN,
                "draining": true,
            })
        )
        .unwrap();
        drop(peer);
        drop(listener);
    });

    let state = HostState::default();
    let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let launch_count = Arc::clone(&launches);
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        START_WAIT,
        &state.supervisor_socket,
        |sock| {
            launch_count.fetch_add(1, Ordering::SeqCst);
            let node = massion_carrier::daemon::node_binary()?;
            Ok((
                node,
                vec![
                    runner.to_string_lossy().to_string(),
                    sock.to_string_lossy().to_string(),
                ],
            ))
        },
        |_| {},
    );
    let elapsed = started.elapsed();
    old_supervisor.join().unwrap();
    assert_eq!(launches.load(Ordering::SeqCst), 1);
    assert_eq!(
        outcome.as_ref().err(),
        Some(&StartRefusal::Other(
            "The supervisor did not answer status".to_string()
        )),
        "silence from the new supervisor must refuse at once, not re-spend the drain bound"
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "silence from the new supervisor must refuse at once instead of re-spending the drain bound, took {elapsed:?}"
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "start-connection-unavailable", None);
}

#[test]
fn status_no_answer_or_malformed_refuses_immediately_with_cannot_start() {
    for (tag, reply_bytes) in [
        ("eof", &b""[..]),
        ("malformed-json", &b"not-json"[..]),
        ("missing-status", &br#"{"origin":"http://127.0.0.1:8765"}"#[..]),
        (
            "bad-draining-type",
            &br#"{"status":"running","draining":"yes","origin":"http://127.0.0.1:8765"}"#[..],
        ),
        (
            "unknown-status",
            &br#"{"status":"paused","origin":"http://127.0.0.1:8765"}"#[..],
        ),
    ] {
        let dir = TestDir::new(tag);
        let (_socket, listener) = bind_private_socket(dir.path());
        let payload = reply_bytes.to_vec();
        let (checked_tx, checked_rx) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let mut peer = accept_bounded(&listener, Duration::from_secs(5));
            assert_eq!(read_control_line(&mut peer), "status\n");
            let _ = peer.write_all(&payload);
            drop(peer);
            // Check after the product returns, so "must not ask again or
            // attach" can actually fail.
            checked_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("caller must return");
            listener.set_nonblocking(true).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock,
                "{tag}: must not ask again or attach"
            );
        });

        let state = HostState::default();
        let outcome = connect_supervisor_within(
            dir.path(),
            false,
            DEFAULT_DAEMON_ORIGIN,
            START_WAIT,
            &state.supervisor_socket,
            |_| panic!("{tag}: must not launch"),
            |_| {},
        );
        let _ = checked_tx.send(());
        server.join().unwrap();
        assert!(outcome.is_err(), "{tag}: expected refusal");
        record_connect_outcome(&state, outcome);
        let response =
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
        assert_cannot_start_response(&response, "start-connection-unavailable", None);
    }

    // Silent hang (no answer within remaining wait): fails inside bound without attaching.
    let dir = TestDir::new("silent-timeout");
    let (_socket, listener) = bind_private_socket(dir.path());
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let server = std::thread::spawn(move || {
        let mut peer = accept_bounded(&listener, Duration::from_secs(5));
        assert_eq!(read_control_line(&mut peer), "status\n");
        let _ = done_rx.recv_timeout(Duration::from_secs(5));
    });
    let state = HostState::default();
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_millis(120),
        &state.supervisor_socket,
        |_| panic!("silent-timeout: must not launch"),
        |_| {},
    );
    let elapsed = started.elapsed();
    let _ = done_tx.send(());
    server.join().unwrap();
    assert!(outcome.is_err());
    assert!(elapsed < Duration::from_secs(2));
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "start-connection-unavailable", None);
}

#[test]
fn status_wrong_or_missing_origin_refuses_immediately_with_cannot_start() {
    for (tag, reply) in [
        (
            "wrong-origin",
            serde_json::json!({"status": "running", "pid": 106, "origin": "http://127.0.0.1:9999"}),
        ),
        (
            "missing-origin",
            serde_json::json!({"status": "running", "pid": 106}),
        ),
    ] {
        let dir = TestDir::new(tag);
        let (_socket, listener) = bind_private_socket(dir.path());
        let (checked_tx, checked_rx) = std::sync::mpsc::channel::<()>();
        let server = std::thread::spawn(move || {
            let mut peer = accept_bounded(&listener, Duration::from_secs(5));
            assert_eq!(read_control_line(&mut peer), "status\n");
            writeln!(peer, "{}", reply).unwrap();
            drop(peer);
            // Check after the product returns, so "must not ask again or
            // attach" can actually fail.
            checked_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("caller must return");
            listener.set_nonblocking(true).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock,
                "{tag}: must not ask again or attach"
            );
        });

        let state = HostState::default();
        let outcome = connect_supervisor_within(
            dir.path(),
            false,
            DEFAULT_DAEMON_ORIGIN,
            START_WAIT,
            &state.supervisor_socket,
            |_| panic!("{tag}: must not launch"),
            |_| {},
        );
        let _ = checked_tx.send(());
        server.join().unwrap();
        assert!(outcome.is_err(), "{tag}: expected refusal");
        record_connect_outcome(&state, outcome);
        let response =
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
        assert_cannot_start_response(&response, "start-connection-unavailable", None);
    }
}

#[test]
fn status_query_holds_no_host_or_start_lock_while_waiting() {
    let dir = TestDir::new("status-locks");
    let (socket, listener) = bind_private_socket(dir.path());
    let state = HostState::default();
    let gate = GateSlot::new();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();

    std::thread::scope(|scope| {
        let _release = ReleaseOnDrop(&gate);
        // The server thread must own the channel receiver: a
        // std::sync::mpsc::Receiver cannot be shared between threads (!Sync),
        // so capturing it by reference would not compile.
        let gate_ref = &gate;
        let server = scope.spawn(move || {
            let mut status_peer = accept_bounded(&listener, Duration::from_secs(5));
            assert_eq!(read_control_line(&mut status_peer), "status\n");
            gate_ref.pause_before_handover();
            writeln!(
                status_peer,
                "{}",
                serde_json::json!({
                    "status": "running",
                    "pid": 107,
                    "origin": DEFAULT_DAEMON_ORIGIN,
                })
            )
            .unwrap();
            drop(status_peer);
            let relay_peer = accept_bounded(&listener, Duration::from_secs(5));
            // The reader owns the peer; holding it keeps the connection open.
            let _relay_reader = read_client_handshake(relay_peer);
            let _ = done_rx.recv_timeout(Duration::from_secs(5));
        });

        let caller = scope.spawn(|| {
            connect_supervisor_within(
                dir.path(),
                false,
                DEFAULT_DAEMON_ORIGIN,
                Duration::from_secs(5),
                &state.supervisor_socket,
                |_| panic!("must not launch"),
                |_| {},
            )
        });

        gate.wait_arrived();
        assert!(
            state.supervisor_socket.try_lock().is_ok(),
            "supervisor_socket lock must not be held across status query"
        );
        // The start lock must also be free: a helper thread takes it with a
        // bounded hand-back, so a held lock fails this check instead of
        // hanging it (flock blocks rather than erroring).
        let (lock_tx, lock_rx) = std::sync::mpsc::channel::<()>();
        let lock_socket = socket.clone();
        std::thread::spawn(move || {
            let lock = massion_carrier::daemon::acquire_start_lock(&lock_socket)
                .expect("start lock must be acquirable");
            drop(lock);
            let _ = lock_tx.send(());
        });
        lock_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("start lock must not be held across the status query");

        gate.release();
        let client = caller.join().unwrap().expect("status running attaches");
        drop(client);
        let _ = done_tx.send(());
        server.join().unwrap();
    });
}

#[test]
fn decide_relaunch_table_covers_every_combination() {
    let attempt = Arc::new(QuitAttempt {
        deadline: Instant::now() + DRAIN_TIMEOUT,
    });
    let cases = [
        ("idle", QuitState::Idle),
        ("waiting", QuitState::Waiting(attempt)),
        ("failed", QuitState::Failed(DrainFailure::NoAnswer)),
        ("drained", QuitState::Drained),
        ("relaunching", QuitState::Relaunching),
    ];
    let mut rows = 0usize;
    for (name, state) in &cases {
        for live_connection in [false, true] {
            for binary_available in [false, true] {
                rows += 1;
                let actual = decide_relaunch(state, live_connection, binary_available);
                let expected = if live_connection {
                    RelaunchDecision::Refuse(RelaunchRefusal::LiveConnection)
                } else {
                    match state {
                        QuitState::Waiting(_) => {
                            RelaunchDecision::Refuse(RelaunchRefusal::QuitInProgress)
                        }
                        QuitState::Drained => {
                            RelaunchDecision::Refuse(RelaunchRefusal::AlreadyDrained)
                        }
                        QuitState::Relaunching => {
                            RelaunchDecision::Refuse(RelaunchRefusal::AlreadyRequested)
                        }
                        QuitState::Idle | QuitState::Failed(_) => {
                            if binary_available {
                                RelaunchDecision::Relaunch
                            } else {
                                RelaunchDecision::Refuse(RelaunchRefusal::BinaryUnavailable)
                            }
                        }
                    }
                };
                assert_eq!(
                    actual, expected,
                    "mismatch for ({name}, live={live_connection}, binary={binary_available})"
                );
            }
        }
    }
    assert_eq!(rows, 20);
}

#[test]
fn relaunch_calls_request_restart_once_with_no_lock_held() {
    let state = HostState::default();
    let mut restarts = 0usize;
    let outcome = request_relaunch(&state.quit, false, true, || {
        let guard = state
            .quit
            .try_lock()
            .expect("quit lock must be released before calling request_restart");
        assert_eq!(*guard, QuitState::Relaunching);
        drop(guard);
        restarts += 1;
    });
    assert_eq!(outcome, Ok(()));
    assert_eq!(restarts, 1);
    assert_eq!(*state.quit.lock().unwrap(), QuitState::Relaunching);
}

#[test]
fn second_relaunch_press_after_first_is_refused_without_restarting() {
    let state = HostState::default();
    let mut restarts = 0usize;
    assert_eq!(
        request_relaunch(&state.quit, false, true, || {
            restarts += 1;
        }),
        Ok(())
    );
    assert_eq!(
        request_relaunch(&state.quit, false, true, || {
            restarts += 1;
        }),
        Err(RelaunchRefusal::AlreadyRequested)
    );
    assert_eq!(restarts, 1);
}

#[test]
fn relaunch_refuses_before_restart_when_current_binary_is_unavailable_and_allows_retry() {
    let state = HostState::default();
    let mut restarts = 0usize;
    assert_eq!(
        request_relaunch(&state.quit, false, false, || {
            restarts += 1;
        }),
        Err(RelaunchRefusal::BinaryUnavailable)
    );
    assert_eq!(restarts, 0);
    assert_eq!(*state.quit.lock().unwrap(), QuitState::Idle);
    assert_eq!(
        request_relaunch(&state.quit, false, true, || {
            restarts += 1;
        }),
        Ok(())
    );
    assert_eq!(restarts, 1);
}

#[test]
fn relaunch_during_quit_in_progress_or_drained_does_not_relaunch() {
    let attempt = Arc::new(QuitAttempt {
        deadline: Instant::now() + DRAIN_TIMEOUT,
    });
    for (initial, expected_err) in [
        (
            QuitState::Waiting(attempt.clone()),
            RelaunchRefusal::QuitInProgress,
        ),
        (QuitState::Drained, RelaunchRefusal::AlreadyDrained),
    ] {
        let state = HostState::default();
        *state.quit.lock().unwrap() = initial;
        let mut restarts = 0usize;
        assert_eq!(
            request_relaunch(&state.quit, false, true, || {
                restarts += 1;
            }),
            Err(expected_err)
        );
        assert_eq!(restarts, 0);
    }

    let state = HostState::default();
    *state.quit.lock().unwrap() = QuitState::Waiting(attempt);
    assert!(state.quit_in_progress());
    assert_eq!(
        request_relaunch(&state.quit, false, true, || panic!("must not relaunch during quit")),
        Err(RelaunchRefusal::QuitInProgress)
    );
    assert!(
        state.quit_in_progress(),
        "refused relaunch must leave the active quit attempt intact"
    );
}

#[test]
fn relaunch_after_failed_quit_is_allowed() {
    let state = HostState::default();
    *state.quit.lock().unwrap() = QuitState::Failed(DrainFailure::NoAnswer);
    let mut restarts = 0usize;
    assert_eq!(
        request_relaunch(&state.quit, false, true, || {
            restarts += 1;
        }),
        Ok(())
    );
    assert_eq!(restarts, 1);
}

#[test]
fn quit_after_relaunch_does_not_start_drain() {
    let state = HostState::default();
    let mut restarts = 0usize;
    assert_eq!(
        request_relaunch(&state.quit, false, true, || {
            restarts += 1;
        }),
        Ok(())
    );
    let mut drains = 0usize;
    begin_quit(
        &state.quit,
        |_| {
            drains += 1;
            Ok(())
        },
        |_, _| panic!("must not fail when quit did not start"),
    );
    assert_eq!(restarts, 1);
    assert_eq!(drains, 0);
    assert_eq!(*state.quit.lock().unwrap(), QuitState::Relaunching);
}

#[test]
fn relaunch_command_with_live_connection_is_refused_and_touches_nothing() {
    let dir = TestDir::new("relaunch-live-connection");
    let (socket, listener) = bind_private_socket(dir.path());
    listener.set_nonblocking(true).unwrap();
    let pid_file = dir.path().join("daemon.sock.pid");
    let log_file = dir.path().join("daemon.log");
    std::fs::write(&pid_file, "{\"pid\":999}\n").unwrap();
    std::fs::write(&log_file, "running\n").unwrap();

    let relay = MockRelay::new();
    let (client, _peer) = relay.connect_client();

    let state = HostState::default();
    *state.supervisor_socket.lock().unwrap() = Some(socket.clone());
    *state.daemon_log.lock().unwrap() = Some(log_file.clone());
    *state.client.lock().unwrap() = Some(client.clone());

    let mut restarts = 0usize;
    assert_eq!(
        relaunch_command(&state, true, || {
            restarts += 1;
        }),
        Err(RelaunchRefusal::LiveConnection)
    );
    assert_eq!(restarts, 0, "a live connection must not restart the host");
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "the refusal must not connect to or drain the supervisor"
    );
    assert!(socket.exists(), "supervisor socket must remain");
    assert!(pid_file.is_file(), "supervisor pid file must remain");
    assert!(log_file.is_file(), "supervisor log file must remain");
    assert!(!client.is_closed(), "the refusal must not tear down the client");
    assert_eq!(
        *state.quit.lock().unwrap(),
        QuitState::Idle,
        "a refusal must leave the quit state untouched"
    );
}

#[test]
fn relaunch_command_without_live_connection_leaves_supervisor_socket_and_files_untouched() {
    let dir = TestDir::new("relaunch-no-connection");
    let (socket, listener) = bind_private_socket(dir.path());
    listener.set_nonblocking(true).unwrap();
    let pid_file = dir.path().join("daemon.sock.pid");
    let log_file = dir.path().join("daemon.log");
    std::fs::write(&pid_file, "{\"pid\":999}\n").unwrap();
    std::fs::write(&log_file, "running\n").unwrap();

    // The cannot-start state: no stored client at all.
    let state = HostState::default();
    *state.supervisor_socket.lock().unwrap() = Some(socket.clone());
    *state.daemon_log.lock().unwrap() = Some(log_file.clone());

    let mut restarts = 0usize;
    assert_eq!(
        relaunch_command(&state, true, || {
            restarts += 1;
        }),
        Ok(())
    );
    assert_eq!(restarts, 1);
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "relaunch must not connect to or drain the supervisor"
    );
    assert!(socket.exists(), "supervisor socket must remain");
    assert!(pid_file.is_file(), "supervisor pid file must remain");
    assert!(log_file.is_file(), "supervisor log file must remain");
}

#[test]
fn relaunch_command_with_closed_connection_is_accepted() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    drop(peer);
    wait_until_closed(&client);

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);
    let mut restarts = 0usize;
    assert_eq!(
        relaunch_command(&state, true, || {
            restarts += 1;
        }),
        Ok(())
    );
    assert_eq!(restarts, 1);
}

#[test]
fn relaunch_command_stays_in_the_command_path_and_reads_the_connection() {
    // The tauri command wrapper itself cannot run in a unit test, so this pins
    // the two reachable facts: the wrapper delegates to relaunch_command, and
    // that function reads the stored connection and refuses while it is live.
    let lib_src = include_str!("lib.rs");
    assert!(
        lib_src.matches("relaunch_command(").count() >= 2,
        "desktop_relaunch must keep delegating to relaunch_command"
    );

    let relay = MockRelay::new();
    let (client, _peer) = relay.connect_client();
    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);
    let mut restarts = 0usize;
    assert_eq!(
        relaunch_command(&state, true, || {
            restarts += 1;
        }),
        Err(RelaunchRefusal::LiveConnection)
    );
    assert_eq!(restarts, 0);
}

#[test]
fn relaunch_command_is_registered_behind_guarded_invoke_and_manifest() {
    let lib_src = include_str!("lib.rs");
    assert!(lib_src.contains("fn guarded_invoke"));
    assert!(lib_src.contains("desktop_relaunch,"));
    assert!(lib_src.contains("fn desktop_relaunch(app: AppHandle) -> Result<(), String>"));
    assert!(lib_src.contains("app.request_restart()"));
    let build_src = include_str!("../build.rs");
    assert!(build_src.contains("\"desktop_relaunch\""));
}

// TEMPORARY evidence for issue #307; a later commit reverts this block.
// Twenty sequential rounds of every test of this file, each timed, so CI
// measures the widened late-socket test directly. (While the mutation of
// the previous push was present this list omitted exactly the one test that
// mutation exists to fail; with the mutation reverted, the target is back
// in the list.)
#[test]
fn temporary_this_file_twenty_times() {
    let tests: [(&str, fn()); 42] = [
        (
            "decide_root_failure_table_covers_every_combination",
            decide_root_failure_table_covers_every_combination,
        ),
        (
            "no_stored_connection_serves_cannot_start_with_unavailable_code",
            no_stored_connection_serves_cannot_start_with_unavailable_code,
        ),
        (
            "already_closed_connection_serves_cannot_start_at_once",
            already_closed_connection_serves_cannot_start_at_once,
        ),
        (
            "closed_while_pending_serves_cannot_start",
            closed_while_pending_serves_cannot_start,
        ),
        (
            "closed_connection_after_normal_document_serves_cannot_start",
            closed_connection_after_normal_document_serves_cannot_start,
        ),
        (
            "non_root_api_and_published_document_requests_stay_empty_503",
            non_root_api_and_published_document_requests_stay_empty_503,
        ),
        (
            "relay_replies_pass_through_except_refused_header_stays_empty_503",
            relay_replies_pass_through_except_refused_header_stays_empty_503,
        ),
        (
            "quit_in_progress_keeps_empty_503_and_failed_quit_serves_cannot_start",
            quit_in_progress_keeps_empty_503_and_failed_quit_serves_cannot_start,
        ),
        (
            "data_directory_refusal_serves_cannot_start_with_its_code",
            data_directory_refusal_serves_cannot_start_with_its_code,
        ),
        (
            "daemon_log_path_is_shown_only_when_file_exists_and_is_html_escaped",
            daemon_log_path_is_shown_only_when_file_exists_and_is_html_escaped,
        ),
        (
            "cannot_start_document_matches_copy_table",
            cannot_start_document_matches_copy_table,
        ),
        (
            "blocked_responder_does_not_wait_on_the_quit_lock",
            blocked_responder_does_not_wait_on_the_quit_lock,
        ),
        (
            "app_host_with_port_userinfo_or_other_scheme_never_serves_cannot_start",
            app_host_with_port_userinfo_or_other_scheme_never_serves_cannot_start,
        ),
        (
            "oversized_and_non_utf8_replies_stay_empty_503_not_cannot_start",
            oversized_and_non_utf8_replies_stay_empty_503_not_cannot_start,
        ),
        (
            "non_fast_path_validation_keeps_main_wait_order_and_statuses",
            non_fast_path_validation_keeps_main_wait_order_and_statuses,
        ),
        (
            "decide_status_table_covers_every_combination",
            decide_status_table_covers_every_combination,
        ),
        (
            "status_running_with_missing_draining_field_attaches_and_serves",
            status_running_with_missing_draining_field_attaches_and_serves,
        ),
        (
            "status_starting_attaches_at_once",
            status_starting_attaches_at_once,
        ),
        (
            "status_failed_with_cause_refuses_immediately_and_shows_both_codes",
            status_failed_with_cause_refuses_immediately_and_shows_both_codes,
        ),
        (
            "status_draining_polls_again_and_starts_once_old_supervisor_is_gone",
            status_draining_polls_again_and_starts_once_old_supervisor_is_gone,
        ),
        (
            "status_disconnect_after_seen_draining_starts_a_fresh_supervisor",
            status_disconnect_after_seen_draining_starts_a_fresh_supervisor,
        ),
        (
            "status_draining_past_wait_serves_cannot_start_unavailable",
            status_draining_past_wait_serves_cannot_start_unavailable,
        ),
        (
            "a_late_socket_after_a_long_draining_wait_still_attaches",
            a_late_socket_after_a_long_draining_wait_still_attaches,
        ),
        (
            "ordinary_start_runs_once_and_a_supervisor_that_dies_is_refused",
            ordinary_start_runs_once_and_a_supervisor_that_dies_is_refused,
        ),
        (
            "a_supervisor_that_dies_after_existing_is_refused_without_a_restart",
            a_supervisor_that_dies_after_existing_is_refused_without_a_restart,
        ),
        (
            "an_existing_supervisor_that_answers_draining_serves_the_document_without_asking_again",
            an_existing_supervisor_that_answers_draining_serves_the_document_without_asking_again,
        ),
        (
            "new_supervisor_that_does_not_answer_after_draining_is_refused",
            new_supervisor_that_does_not_answer_after_draining_is_refused,
        ),
        (
            "status_no_answer_or_malformed_refuses_immediately_with_cannot_start",
            status_no_answer_or_malformed_refuses_immediately_with_cannot_start,
        ),
        (
            "status_wrong_or_missing_origin_refuses_immediately_with_cannot_start",
            status_wrong_or_missing_origin_refuses_immediately_with_cannot_start,
        ),
        (
            "status_query_holds_no_host_or_start_lock_while_waiting",
            status_query_holds_no_host_or_start_lock_while_waiting,
        ),
        (
            "decide_relaunch_table_covers_every_combination",
            decide_relaunch_table_covers_every_combination,
        ),
        (
            "relaunch_calls_request_restart_once_with_no_lock_held",
            relaunch_calls_request_restart_once_with_no_lock_held,
        ),
        (
            "second_relaunch_press_after_first_is_refused_without_restarting",
            second_relaunch_press_after_first_is_refused_without_restarting,
        ),
        (
            "relaunch_refuses_before_restart_when_current_binary_is_unavailable_and_allows_retry",
            relaunch_refuses_before_restart_when_current_binary_is_unavailable_and_allows_retry,
        ),
        (
            "relaunch_during_quit_in_progress_or_drained_does_not_relaunch",
            relaunch_during_quit_in_progress_or_drained_does_not_relaunch,
        ),
        (
            "relaunch_after_failed_quit_is_allowed",
            relaunch_after_failed_quit_is_allowed,
        ),
        (
            "quit_after_relaunch_does_not_start_drain",
            quit_after_relaunch_does_not_start_drain,
        ),
        (
            "relaunch_command_with_live_connection_is_refused_and_touches_nothing",
            relaunch_command_with_live_connection_is_refused_and_touches_nothing,
        ),
        (
            "relaunch_command_without_live_connection_leaves_supervisor_socket_and_files_untouched",
            relaunch_command_without_live_connection_leaves_supervisor_socket_and_files_untouched,
        ),
        (
            "relaunch_command_with_closed_connection_is_accepted",
            relaunch_command_with_closed_connection_is_accepted,
        ),
        (
            "relaunch_command_stays_in_the_command_path_and_reads_the_connection",
            relaunch_command_stays_in_the_command_path_and_reads_the_connection,
        ),
        (
            "relaunch_command_is_registered_behind_guarded_invoke_and_manifest",
            relaunch_command_is_registered_behind_guarded_invoke_and_manifest,
        ),
    ];
    for round in 1..=20 {
        for (name, test) in tests {
            let started = Instant::now();
            test();
            eprintln!("cannot_start_tests {name} took {:?}", started.elapsed());
        }
        eprintln!("cannot_start_tests round {round}/20 complete");
    }
}
