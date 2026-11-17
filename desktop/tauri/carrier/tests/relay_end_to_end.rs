use massion_carrier::LineClient;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

/// The real relay, through the real supervisor (daemon-runner.mjs), with the
/// fake core shared with the JS tests (desktop/tests/fixtures/feed-core.mjs),
/// connected through the real carrier: one subscription id travels the whole
/// path in the exact message shape desktop/tauri-client.js parses, close
/// really unsubscribes, and five subscribe/close cycles stay under the
/// four-subscription limit.
#[test]
fn subscription_id_and_shape_travel_the_whole_path() {
    let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let origin = format!("http://127.0.0.1:{}", port);

    let root = std::env::temp_dir().join(format!("massion-relay-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let socket = root.join("daemon.sock");
    let log = root.join("daemon.log");
    let _ = std::fs::remove_file(&socket);
    // The fixture writes its state beside the test's working directory (the
    // environment allow-list carries no test names to the child).
    let state = PathBuf::from("feed-core-state.log");
    let _ = std::fs::remove_file(&state);

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let runner = manifest.join("../../daemon-runner.mjs");
    let fixture = manifest.join("../../tests/fixtures/feed-core.mjs");
    let node = massion_carrier::daemon::node_binary().expect("node resolves in a debug build");
    let args = vec![
        runner.to_string_lossy().to_string(),
        socket.to_string_lossy().to_string(),
        fixture.to_string_lossy().to_string(),
        origin,
    ];
    let pid = massion_carrier::daemon::start_detached(&node, &args, &log, None).expect("supervisor starts detached");

    assert!(massion_carrier::daemon::wait_for_socket(&socket, Duration::from_secs(20)), "socket never answered");
    assert!(massion_carrier::daemon::socket_is_private(&socket).unwrap(), "the socket must stay user-private");
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(text) = std::fs::read_to_string(&state) {
            if text.contains("\"start\"") {
                break;
            }
        }
        assert!(std::time::Instant::now() < deadline, "the fake core never started");
        std::thread::sleep(Duration::from_millis(100));
    }

    let (events, receiver) = mpsc::channel::<String>();
    let client = LineClient::connect(&socket, move |line| {
        let _ = events.send(line.to_string());
    })
    .expect("client connection");

    let events_path = "/protocol/events?version=1&requestId=r&generation=1&after=0";
    let reply = client.request_as_timed("s-1", "GET", events_path, None, None, Duration::from_secs(10)).expect("subscribe reply");
    assert!((200..300).contains(&reply.status), "subscribe refused: {}", reply.status);

    let line = receiver.recv_timeout(Duration::from_secs(10)).expect("a feed event");
    let value: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["event"], "message");
    assert_eq!(value["subscription"], "s-1", "the event carries the id the client registered");
    assert_eq!(value["lastEventId"], "[\"feed\",0]");
    assert_eq!(value["data"], "{\"connected\":true}");

    client.send_close("s-1").expect("close sent");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(text) = std::fs::read_to_string(&state) {
            if text.contains("\"closed\"") {
                break;
            }
        }
        assert!(std::time::Instant::now() < deadline, "the relay never closed the core stream");
        std::thread::sleep(Duration::from_millis(100));
    }

    for cycle in 1..=5u32 {
        let id = format!("sub-{}", cycle);
        let reply = client
            .request_as_timed(&id, "GET", events_path, None, None, Duration::from_secs(10))
            .unwrap_or_else(|error| panic!("cycle {} failed: {:?}", cycle, error));
        assert!((200..300).contains(&reply.status), "cycle {} hit the subscription limit: {}", cycle, reply.status);
        client.send_close(&id).expect("close sent");
        std::thread::sleep(Duration::from_millis(100));
    }

    drop(client);
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    let reaped = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), 0) };
    assert_eq!(reaped, pid as i32);
    let _ = std::fs::remove_file(&state);
    let _ = std::fs::remove_dir_all(&root);
}
