use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

pub fn ask_status(socket: &std::path::Path) -> u32 {
    let mut stream = UnixStream::connect(socket).expect("status connection");
    stream.write_all(b"status\n").unwrap();
    stream.shutdown(std::net::Shutdown::Write).unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    let reply: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    reply["pid"].as_u64().expect("a supervisor pid") as u32
}
