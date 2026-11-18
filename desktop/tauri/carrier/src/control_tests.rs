use super::*;
use crate::LineClient;
use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

fn drain_with(
    path: &Path,
    read: impl FnOnce(&mut io::Take<UnixStream>, &mut Vec<u8>) -> io::Result<usize>,
) -> Result<(), DrainFailure> {
    DrainConnection::connect(path)?.drain_with(|| Some(()), read)
}

struct Supervisor {
    listener: UnixListener,
    socket: PathBuf,
}

impl Supervisor {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mq1-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let socket = dir.join("daemon.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        listener.set_nonblocking(true).unwrap();
        Self { listener, socket }
    }

    fn accept(&self) -> UnixStream {
        let (peer, _) = self.listener.accept().expect("a new connection to the supervisor");
        // The listener is non-blocking; on macOS the accepted peer inherits
        // that mode. Hand out blocking peers with a read bound so an expired
        // bound fails the test instead of hanging or erroring at once.
        peer.set_nonblocking(false)
            .expect("peer must hand out in blocking mode");
        peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        peer
    }

    fn control_peer(&self, expected_command: &[u8]) -> UnixStream {
        let mut peer = self.accept();
        let mut request = Vec::new();
        peer.read_to_end(&mut request)
            .expect("control request bytes");
        assert_eq!(
            request.as_slice(),
            expected_command,
            "the write side sends and closes after exactly one line"
        );
        peer
    }

    fn reply(&self, answer: &[u8]) -> Result<(), DrainFailure> {
        drain_with(&self.socket, |stream, response| {
            let mut peer = self.control_peer(b"drain\n");
            peer.write_all(answer).unwrap();
            drop(peer);
            stream.read_to_end(response)
        })
    }

    fn status_reply(&self, answer: &[u8]) -> Result<StatusReply, StatusError> {
        query_status_with(&self.socket, STATUS_TIMEOUT, |stream, response| {
            let mut peer = self.control_peer(b"status\n");
            peer.write_all(answer).unwrap();
            drop(peer);
            stream.read_to_end(response)
        })
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        fs::remove_dir_all(self.socket.parent().unwrap()).unwrap();
    }
}

#[test]
fn drain_uses_a_new_half_closed_connection_and_leaves_the_relay_untouched() {
    let supervisor = Supervisor::new();
    let _client = LineClient::connect(&supervisor.socket, |_| {}).unwrap();
    let mut relay = supervisor.accept();
    let mut handshake = [0; 7];
    relay.read_exact(&mut handshake).unwrap();
    assert_eq!(&handshake, b"client\n");

    assert_eq!(
        supervisor.reply(br#"{"status":"drained"}"#),
        Ok(()),
        "complete drained reply succeeds"
    );
    relay.set_nonblocking(true).unwrap();
    assert_eq!(
        relay.read(&mut [0]).map_err(|error| error.kind()),
        Err(io::ErrorKind::WouldBlock),
        "no control bytes on the relay"
    );
}

#[test]
fn drain_reply_failures_are_distinct() {
    let supervisor = Supervisor::new();
    let oversized = vec![b' '; 1025];
    for (answer, expected) in [
        (&br#"{"status":"unsettled"}"#[..], DrainFailure::Unsettled),
        (
            &br#"{"status":"running"}"#[..],
            DrainFailure::UnexpectedStatus,
        ),
        (&br#"{"status":"drained""#[..], DrainFailure::TruncatedReply),
        (&[][..], DrainFailure::Disconnected),
        (&br#"["drained"]"#[..], DrainFailure::InvalidReply),
        (&br#"["unsettled"]"#[..], DrainFailure::InvalidReply),
        (
            &br#"{"status":"drained","extra":true}"#[..],
            DrainFailure::InvalidReply,
        ),
        (
            &br#"{"status":"drained"} {}"#[..],
            DrainFailure::InvalidReply,
        ),
        (
            &br#"{"status":"drained","status":"drained"}"#[..],
            DrainFailure::InvalidReply,
        ),
        (&oversized[..], DrainFailure::InvalidReply),
    ] {
        assert_eq!(
            supervisor.reply(answer),
            Err(expected),
            "{answer:?}: {expected:?}"
        );
    }
}

#[test]
fn drain_wait_requires_eof_and_distinguishes_timeout_from_disconnect() {
    let supervisor = Supervisor::new();
    let drained = br#"{"status":"drained"}"#;
    for (kind, answer, expected) in [
        (
            io::ErrorKind::TimedOut,
            &drained[..],
            DrainFailure::NoAnswer,
        ),
        (io::ErrorKind::WouldBlock, &[][..], DrainFailure::NoAnswer),
        (
            io::ErrorKind::ConnectionReset,
            &drained[..],
            DrainFailure::Disconnected,
        ),
        (io::ErrorKind::Other, &[][..], DrainFailure::TransportError),
    ] {
        let outcome = drain_with(&supervisor.socket, |stream, response| {
            let mut peer = supervisor.control_peer(b"drain\n");
            assert_eq!(
                stream.get_ref().read_timeout().unwrap(),
                Some(DRAIN_TIMEOUT),
                "the socket has the drain inactivity bound"
            );
            peer.write_all(answer).unwrap();
            response.resize(answer.len(), 0);
            stream.read_exact(response)?;
            Err(kind.into())
        });
        assert_eq!(
            outcome,
            Err(expected),
            "{kind:?} with {} response bytes",
            answer.len()
        );
    }
}

#[test]
fn drain_requires_a_private_reachable_socket() {
    let supervisor = Supervisor::new();
    assert_eq!(
        drain(&supervisor.socket.with_file_name("missing")),
        Err(DrainFailure::NotConnected)
    );
    fs::set_permissions(&supervisor.socket, fs::Permissions::from_mode(0o666)).unwrap();
    let outcome = drain_with(&supervisor.socket, |_, _| {
        Err(io::ErrorKind::ConnectionReset.into())
    });
    assert_eq!(
        supervisor.listener.accept().err().map(|error| error.kind()),
        Some(io::ErrorKind::WouldBlock),
        "no connection to the non-private socket"
    );
    assert_eq!(outcome, Err(DrainFailure::NotConnected));
}

#[test]
fn status_query_parses_all_states_and_treats_missing_draining_as_false() {
    let supervisor = Supervisor::new();
    let older_running = supervisor
        .status_reply(br#"{"status":"running","pid":42,"origin":"http://127.0.0.1:8765"}"#)
        .expect("older supervisor reply without draining parses");
    assert_eq!(
        older_running,
        StatusReply {
            status: "running".to_string(),
            pid: Some(42),
            origin: Some("http://127.0.0.1:8765".to_string()),
            draining: false,
            cause: None,
            detail: None,
        }
    );

    let draining_running = supervisor
        .status_reply(
            br#"{"status":"running","pid":42,"origin":"http://127.0.0.1:8765","draining":true}"#,
        )
        .expect("draining reply parses");
    assert!(draining_running.draining);

    let starting = supervisor
        .status_reply(br#"{"status":"starting","pid":42,"origin":"http://127.0.0.1:8765"}"#)
        .expect("starting reply parses");
    assert_eq!(starting.status, "starting");
    assert!(!starting.draining);

    let failed = supervisor
        .status_reply(
            br#"{"status":"failed","pid":42,"origin":"http://127.0.0.1:8765","cause":"database-start","detail":"db exited"}"#,
        )
        .expect("failed reply parses");
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.cause.as_deref(), Some("database-start"));
    assert_eq!(failed.detail.as_deref(), Some("db exited"));
}

#[test]
fn status_query_rejects_malformed_truncated_oversized_empty_and_timed_out_replies() {
    let supervisor = Supervisor::new();
    let oversized = vec![b' '; 1025];
    for (answer, expected) in [
        (&[][..], StatusError::Disconnected),
        (&br#"{"status":"running""#[..], StatusError::TruncatedReply),
        (&br#"["running"]"#[..], StatusError::InvalidReply),
        (&br#"{"origin":"http://127.0.0.1:8765"}"#[..], StatusError::InvalidReply),
        (&br#"{"status":"running","extra":true}"#[..], StatusError::InvalidReply),
        (&br#"{"status":"running"} {}"#[..], StatusError::InvalidReply),
        (
            &br#"{"status":"running","status":"running"}"#[..],
            StatusError::InvalidReply,
        ),
        (
            &br#"{"status":"running","draining":"yes"}"#[..],
            StatusError::InvalidReply,
        ),
        (&oversized[..], StatusError::InvalidReply),
    ] {
        assert_eq!(
            supervisor.status_reply(answer),
            Err(expected),
            "{answer:?}: {expected:?}"
        );
    }

    let timeout_outcome = query_status_with(
        &supervisor.socket,
        Duration::from_secs(5),
        |stream, _| {
            let _peer = supervisor.control_peer(b"status\n");
            assert_eq!(
                stream.get_ref().read_timeout().unwrap(),
                Some(STATUS_TIMEOUT),
                "the status socket timeout is capped at STATUS_TIMEOUT"
            );
            Err(io::ErrorKind::TimedOut.into())
        },
    );
    assert_eq!(timeout_outcome, Err(StatusError::NoAnswer));
    assert_eq!(
        query_status(&supervisor.socket, Duration::ZERO),
        Err(StatusError::NoAnswer)
    );
}

#[test]
fn status_query_distinguishes_not_listening_and_non_private_sockets() {
    let supervisor = Supervisor::new();
    assert_eq!(
        query_status(&supervisor.socket.with_file_name("missing"), STATUS_TIMEOUT),
        Err(StatusError::NotListening)
    );

    let stale = supervisor.socket.with_file_name("stale.sock");
    let stale_listener = UnixListener::bind(&stale).unwrap();
    fs::set_permissions(&stale, fs::Permissions::from_mode(0o600)).unwrap();
    drop(stale_listener);
    assert_eq!(
        query_status(&stale, STATUS_TIMEOUT),
        Err(StatusError::NotListening)
    );

    fs::set_permissions(&supervisor.socket, fs::Permissions::from_mode(0o666)).unwrap();
    assert_eq!(
        query_status(&supervisor.socket, STATUS_TIMEOUT),
        Err(StatusError::NotPrivate)
    );
    assert_eq!(
        supervisor.listener.accept().err().map(|error| error.kind()),
        Some(io::ErrorKind::WouldBlock),
        "no connection to the non-private socket"
    );
}
