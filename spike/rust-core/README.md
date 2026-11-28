# Massion Rust core spike

The executable embeds SurrealDB 4.0.1 and serves the protocol v1 Mission-create path on loopback. It links the existing TypeScript storage queries at build time. Run only on disposable fixture copies. The checkout must be the `spike/rust-core` worktree and requires Rust 1.97.1 or a compatible toolchain, Python 3, the packaged Node 24.19.0 and SurrealDB 4.0.1.

```sh
python3 spike/rust-core/build.py
node spike/rust-core/verify.mjs all
node spike/rust-core/verify.mjs measure
```

The caller may select `P1`, `P2`, `P3`, or `P4` individually. Set `MASSION_SPIKE_RUNTIME` to the existing 0.9.0 app's `Contents/MacOS` directory if it differs from the local default in `verify.mjs`. To run P2 on the second approved fixture, set `MASSION_SPIKE_FIXTURE=2026-11-19-tauri-a1e98ec`. The harness removes its working copies on exit and only prints summary evidence. P2 uses the existing TypeScript server factory with its scheduler disabled. The measurement launches the unmodified Node entry point with a local fixture manifest and no live providers. The external database uses the existing TLS pinning code.

Run `build.py` with an absent target for the clean build and again with a warm target after changing the crate to measure an incremental rebuild. It checks disk space before and during Cargo. When finished, delete the target folder `~/orca/workspaces/massion/.rust-spike-target`.

The binary accepts `serve <database-directory> <port>` and `export <database-directory>`. Create the database directory under the checkout's `.runtime` first. The export dumps the full test journal, snapshots and stored rows from a stopped copy. The `--pause-before-commit` serve option is for P4. The write is deliberately held inside a live SDK transaction after its SQL has returned, so the harness can send SIGKILL before commit. The HTTP server has the host and origin restrictions of the local development workbench. Use only disposable copies and a trusted local machine.

## Source contract

| Contract | TypeScript reference |
|---|---|
| Mission form fields and transport | `src/workbench.ts:1583–1590`, `src/client-protocol.ts:8–42,71–87` |
| Version negotiation and correlated replies | `src/protocol.ts:24–39`, `src/server.ts:135–183` |
| Mission creation, owner and expected revision 0 | `src/server.ts:81–92,267–272`, `src/product.ts:22–25`, `src/application.ts:15–20`, `src/domain.ts:180–182,214–218` |
| UTF-16 key order, JavaScript numbers and SHA-256 | `src/domain.ts:155–162`, `src/storage.ts:179–216` |
| Native query reuse and persisted identity | `src/storage.ts:361–377,453–489,545,556–584,651–716,825–844,879–891` |
| Feed identity, contiguous cursors, and event IDs | `src/storage.ts:155–177,774–781`, `src/server.ts:153–162,265–266`, `src/protocol-feed.ts:13–46` |

The spike implements the protocol envelopes used by Mission creation and the `/read-state` and `/events` queries. Inputs with isolated UTF-16 surrogate escapes are rejected during Rust JSON decoding. This edge case is outside the verified screen path. The spike does not implement managed desktop authentication, other domain commands, applications, or provider execution.
