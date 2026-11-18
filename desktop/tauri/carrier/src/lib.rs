//! The bytes-between-the-webview-and-the-daemon half of the Tauri host.
//!
//! This crate carries lines only: it connects to the supervisor's user-only
//! socket, starts the supervisor detached when nothing answers, and forwards
//! one JSON object per line both ways (plans/2026-11-16-tauri-move-design.md
//! section 2). No core address, secret, HTTP client or authentication logic
//! lives here. It has no webview dependency so its tests run anywhere.

pub mod control;
pub mod daemon;
pub mod socket;

pub use socket::{LineClient, Reply, CarrierError};
