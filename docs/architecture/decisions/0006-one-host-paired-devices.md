# ADR 0006: One host, paired devices and the pinned link

- Status: accepted working design; first slice in review; reversible on measured evidence
- Date: 2026-11-15 (revises the 2026-11-11 draft after the owner's single-host decision)
- Scope: how Massion behaves across the owner's PCs, what a paired device may do, and the first slice: device identity, pairing, per-device grants, the pinned TLS link and its server path. Builds on [ADR 0005](0005-desktop-app-protocol-and-adapter-boundaries.md) (adapter boundaries, protocol version negotiation).

## Context

The owner approved the multi-device design on 2026-11-11 and revised it on 2026-11-15 ("호스트 하나"). Continuity is a core requirement. The analyzed desktop agent products all use one structure: a single host owns the work, and other devices connect to it. Terminology follows the revision: a device is one of the owner's PCs; `host` keeps its existing meaning (the Massion core process) and is never used for a connected PC.

## Decision

1. **One host owns everything.** The organization, conversations, saved logins and Work all live on one host. A paired device connects to that host to view, control and answer approvals; it is a remote window onto the host, not a copy of it. Nothing is synchronized between devices in 1.0. A second Massion installed on another PC is a separate host; it is never merged and not forbidden.
2. **A paired device works live while connected.** While connected it views and instructs the host's Work like a local user. While disconnected it reads the last copy it holds; it can send nothing, and nothing is ever queued. Stopped execution is not auto-resumed on reconnect.
3. **Device identity and pairing.** Each installation has one device key pair, created on first use; the private key lives only in the secret-storage adapter. A pairing offer (code or link) carries public information only: device id, public-key fingerprint and address candidates. Both PCs show the other side's name, key fingerprint and what that device will be allowed to do, and both owners must confirm. A short numeric code is used for manual entry; pairing codes expire and are single-use.
4. **Grants per paired device are additive and stored on the granting host:** view, instruct, answer approvals. Unpairing revokes the grant and deletes the stored device key in one action. The paired-device list on the host is the list of "devices that can control this host"; it is deliberately separate from the existing external-member `DevicesService` list.
5. **The link is mutual TLS 1.3 on Node's built-in `tls`**, with certificates pinned to the keys exchanged at pairing. No custom cryptography, and no unauthenticated or unpinned fallback mode exists. Address candidates (a same-network address and a manually entered address; a relay later as one more candidate type behind the same interface) are tried in order and the link reports which candidate is in use. The listener binds non-loopback interfaces only while pairing is enabled (a live offer exists) or a paired device exists.
6. **Link states and causes:** connected, connecting, offline, connection failed, update needed (protocol range mismatch reuses the existing version negotiation). Failures carry a cause-specific message: refused, not found, timed out, TLS/pin mismatch.
7. **Answering approvals from a paired device is decided, not open:** approvals, including high-risk ones, may be answered from any paired device that holds the answer-approvals grant. The gate is the grant, not the risk class.
8. **A later cloud host is the always-on host.** It is decided as a future paid service operated by the project, and nothing is built for it in 1.0. When the host is off, other devices are read-only and cannot start new Work; a cloud host lifts exactly that.
9. **This slice exposes only an authenticated ping and protocol-version exchange over the link.** Remote access to the core (commands, queries, feed) is the next slice; the confirmation sheet and the grant editor are server-path only until screen contracts exist.

## Not decided

- Relay and mailbox operation details for the later cloud host.
- LAN auto-discovery (mDNS); manual address entry is the 1.0 path.
- The grant-editor and pairing-confirmation screens (server path only in this slice).
- Renaming the external-member `DevicesService` (separate PR after M1).

## Security invariants

1. A pairing offer never carries a secret value; the numeric code is stored hashed and compared in constant time, expires, and is consumed once.
2. A device that changes its key fails pin verification; a revoked (unpaired) device's reconnect is refused because its key is gone.
3. Grants only widen additively through an owner command; removal is unpair.
4. No transport accepts an unauthenticated or unpinned peer; there is no legacy or downgrade mode.
5. The private device key never leaves the secret-storage adapter, the UI, logs or the database.

## Consequences

- The device-link aggregate (offers, peers, grants, connection observations) is durable and journal-validated like the devices aggregate, with its own read path and server routes (`/devices/link/*`).
- Tests run two in-process hosts over loopback with the injected fake secret storage; no real keychain and no real network beyond loopback.
- The project gains its first runtime dependencies: `@peculiar/x509` (+ `reflect-metadata` it requires) because Node's built-in `crypto` cannot mint the X.509 certificate that pins the TLS link to the device key.

## Evidence

- Owner decisions 2026-11-15 (single host, terminology, Q15/Q16 consent) revising the 2026-11-11 multi-device design.
- Reverse-engineering notes of Codex Desktop, Paseo and Claude Desktop (owner-private): one host owns the work; other devices connect to it. Patterns only; no text reproduced.
