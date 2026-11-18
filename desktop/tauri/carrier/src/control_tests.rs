use super::*;
use crate::LineClient;
use std::fs::{self, DirBuilder};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

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
        self.listener
            .accept()
            .expect("a new connection to the supervisor")
            .0
    }

    fn control_peer(&self) -> UnixStream {
        let mut peer = self.accept();
        peer.set_nonblocking(true).unwrap();
        let mut request = [0; 6];
        peer.read_exact(&mut request)
            .expect("control request bytes");
        assert_eq!(&request, b"drain\n", "the one control line");
        assert_eq!(
            peer.read(&mut [0]).ok(),
            Some(0),
            "the write side is closed after exactly one line"
        );
        peer
    }

    fn reply(&self, answer: &[u8]) -> Result<(), DrainFailure> {
        drain_with(&self.socket, |stream, response| {
            let mut peer = self.control_peer();
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
            let mut peer = supervisor.control_peer();
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
