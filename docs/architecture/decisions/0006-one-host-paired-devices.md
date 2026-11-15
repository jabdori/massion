# ADR 0006: One host, paired devices and the pinned link

- Status: accepted working design; first slice in review; reversible on measured evidence
- Date: 2026-11-15 (revises the 2026-11-11 draft after the owner's single-host decision; pairing redesigned the same day, decisions 3 and 5)
- Scope: how Massion behaves across the owner's PCs, what a paired device may do, and the first slice: device identity, pairing, per-device grants, the pinned TLS link and its server path. Builds on [ADR 0005](0005-desktop-app-protocol-and-adapter-boundaries.md) (adapter boundaries, protocol version negotiation).

## Context

The owner approved the multi-device design on 2026-11-11 and revised it on 2026-11-15 ("호스트 하나"). Continuity is a core requirement. The analyzed desktop agent products all use one structure: a single host owns the work, and other devices connect to it. Terminology follows the revision: a device is one of the owner's PCs; `host` keeps its existing meaning (the Massion core process) and is never used for a connected PC.

## Decision

1. **One host owns everything.** The organization, conversations, saved logins and Work all live on one host. A paired device connects to that host to view, control and answer approvals; it is a remote window onto the host, not a copy of it. Nothing is synchronized between devices in 1.0. A second Massion installed on another PC is a separate host; it is never merged and not forbidden.
2. **A paired device works live while connected.** While connected it views and instructs the host's Work like a local user. While disconnected it reads the last copy it holds; it can send nothing, and nothing is ever queued. Stopped execution is not auto-resumed on reconnect.
3. **Device identity and pairing.** Each installation has one device key pair, created on first use; the private key lives only in the secret-storage adapter. Pairing takes one action on each PC and no account or relay:
   - On the PC to be controlled, the owner opens Add. It shows a six-digit code, this PC's address and the time left. New pairing is accepted only while that window is open.
   - On the connecting PC, the owner opens Add, gives the other PC's address and enters the code.
   - The code is never sent. The two sides run SRP-6a (RFC 5054, the 3072-bit group, SHA-256) with the code as the password, over a TLS 1.3 connection whose certificates are not yet trusted. The confirmation each side sends is keyed from the SRP secret and covers both device public keys as that side saw them on the connection, so a party in the middle that does not know the code cannot complete it and cannot test the code later from what it recorded. Each connection gets one guess; five wrong guesses or five minutes end the code (initial defaults).
   - On success both sides pin the other's public key. The owner sees no fingerprint and confirms nothing further: showing the code is the approval, because only someone at that PC can read it. While a device is attaching, the code window shows its name and states that the device entering the code will control this PC.
   - The code and the SRP verifier exist in memory only. A restart ends an open pairing window.
   - Why SRP: sending the code to the other side requires knowing beforehand that it is the right machine, which forced the owner to move a long fingerprint between PCs. Comparing a number derived from both keys needs a confirmation on both PCs and lets anyone on the network start it. SRP is built from Node's own modular arithmetic and hashes with no hand-written group operations; CPace and SPAKE2 would have needed curve arithmetic Node does not expose.
   - Not covered in 1.0: pairing with a host whose screen the owner cannot see.
4. **Grants per paired device are additive and stored on the granting host:** view, instruct, answer approvals. Unpairing revokes the grant and deletes the stored device key in one action. The paired-device list on the host is the list of "devices that can control this host"; it is deliberately separate from the existing external-member `DevicesService` list.
5. **The link is mutual TLS 1.3 on Node's built-in `tls`**, with certificates pinned to the keys exchanged at pairing. No custom cryptography, and no unauthenticated or unpinned fallback mode exists. The connecting PC is given an address (a name or an IP, with a fixed default port); a relay could later be one more way to reach a host behind the same interface. The link reports the address in use. The listener binds non-loopback interfaces only while a pairing window is open or a paired device exists; with paired devices and no open window it serves their reconnections and answers no pairing request.
6. **Link states and causes:** connected, connecting, offline, connection failed, update needed (protocol range mismatch reuses the existing version negotiation). Failures carry a cause-specific message: refused, not found, timed out, TLS/pin mismatch.
7. **Answering approvals from a paired device is decided, not open:** approvals, including high-risk ones, may be answered from any paired device that holds the answer-approvals grant. The gate is the grant, not the risk class.
8. **A later cloud host is the always-on host.** It is decided as a future paid service operated by the project, and nothing is built for it in 1.0. When the host is off, other devices are read-only and cannot start new Work; a cloud host lifts exactly that.
9. **This slice exposes only an authenticated ping and protocol-version exchange over the link.** Remote access to the core (commands, queries, feed) is the next slice; the confirmation sheet and the grant editor are server-path only until screen contracts exist.

## Not decided

- Relay and mailbox operation details for the later cloud host.
- Finding nearby devices on the same network. It is planned as a convenience on top of address entry: it only fills in the address and is never trusted; the host answers only while its pairing window is open.
- The grant editor. Pairing turns all three grants on; the device-add screens are approved and are built in a later slice.
- Renaming the external-member `DevicesService` (separate PR after M1).

## Security invariants

1. The pairing code is never transmitted or stored. Knowledge of it is proven with SRP-6a; a wrong proof is counted, each connection gets one attempt, and the code ends after five wrong attempts, on expiry or when its window closes.
2. A device that changes its key fails pin verification; a revoked (unpaired) device's reconnect is refused because its key is gone.
3. Grants only widen additively through an owner command; removal is unpair.
4. No transport accepts an unauthenticated or unpinned peer; there is no legacy or downgrade mode.
5. The private device key never leaves the secret-storage adapter, the UI, logs or the database.

## Consequences

- The device-link aggregate (peers, grants, connection observations) is durable and journal-validated like the devices aggregate, with its own read path and server routes (`/devices/link/*`).
- Tests run two in-process hosts over loopback with the injected fake secret storage; no real keychain and no real network beyond loopback.
- The project gains its first runtime dependencies: `@peculiar/x509` (+ `reflect-metadata` it requires) because Node's built-in `crypto` cannot mint the X.509 certificate that pins the TLS link to the device key.

## Evidence

- Owner decisions 2026-11-15 (single host, terminology, Q15/Q16 consent) revising the 2026-11-11 multi-device design.
- Reverse-engineering notes of Codex Desktop, Paseo and Claude Desktop (owner-private): one host owns the work; other devices connect to it. Patterns only; no text reproduced.
