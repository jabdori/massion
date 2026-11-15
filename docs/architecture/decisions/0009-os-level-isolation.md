# ADR 0009: OS-level isolation for code Massion did not write

> [!NOTE]
> **In short**
> - Code that Massion did not write (an app's handler, a result checked by the calculation oracle) runs in a child process behind an operating-system sandbox that denies by default.
> - Node's permission flags stay as an inner limit. They are not the security boundary.
> - Where the OS mechanism is missing or does not hold, the child is not started.
> - Three conditions order the work that follows: reads are narrowed at the OS level before members' own extensions or hooks run; Linux gets its sandbox before any Linux release; every result records whether it was produced behind the wall.

- Status: accepted for macOS; first slice implemented
- Date: 2026-11-16
- Scope: how the two child processes that run foreign code are confined (the app worker of [Apps runtime v1](../apps.md) and the calculation oracle of the execution path), on which platforms, what happens when confinement is unavailable, and what must be closed before later work. Builds on [ADR 0003](0003-members-internal-teams-model-groups-and-apps.md) §4 and [ADR 0005](0005-desktop-app-protocol-and-adapter-boundaries.md) §3 (the execution adapter refuses when unavailable).

## Context

Two places run code that Massion did not write.

- **The app worker** runs an installed app's handler script.
- **The calculation oracle** is a fixed host program, but it loads the executor's result as a JavaScript module and calls it. When a model wrote that result, model-written code is executed.

Both were confined with Node's permission model (`--permission`). Node's documentation states that this model does not protect against malicious code. On Node 24 the worker was additionally wrapped on macOS in a sandbox profile that allowed everything except the network; the oracle had no OS confinement at all.

The owner decided on 2026-11-16 that 1.0 includes OS-level isolation. It is the wall that members' own extensions and hooks need before they can exist.

## Decision

### 1. One function, default deny

Both children start through one function that wraps the Node command. On macOS it uses `sandbox-exec` with a profile that denies by default and allows only:

1. executing the host's own Node binary (canonical path, named literally),
2. reading files,
3. reading system parameters, without which Node does not start.

Writing, the network, executing any other program and forking are refused by the operating system. The child talks to its parent over inherited pipes only.

### 2. Layers

The OS sandbox is the boundary. Node's permission flags and the worker's restricted read list stay as an inner limit. They are kept because the profile still allows reading any file (section 4, condition A); they are not relied on against hostile code.

### 3. Fail closed, and say so

- If the mechanism is missing, or a start-up self-check shows that writing, connecting or executing another program is not refused, the child is not started. The app worker reports that the sandbox is unavailable; the oracle fails its check. Nothing falls back to a weaker confinement on macOS.
- Every oracle run records whether it ran behind the OS wall. A record without that field is read as not confined. A result produced without the wall is never indistinguishable from one produced inside it.

### 4. Conditions on later work

- **A. Reads.** The profile allows reading every file, because a narrower list made Node abort in measurement. Narrowing reads at the OS level is closed **before** members' own extensions (D) or hooks (B) run foreign code. Until then the only read limit is Node's, which is not a boundary.
- **B. Linux.** On Linux the app worker is unavailable, and the oracle runs with Node's flags only, recorded as not confined. Because the oracle executes model-written code, this is a real risk, accepted only because Linux is not a release target for 1.0 and CI runs there. An OS sandbox for Linux (unprivileged user namespaces) is closed **before** any Linux release artifact is published.
- **C. Windows** is not a release target. Both features are unavailable there.
- **D. A signed build.** Whether `sandbox-exec` behaves the same inside a signed, notarised app is checked on the first such build.

### 5. `sandbox-exec` is deprecated

Apple's manual marks `sandbox-exec` as deprecated without a removal date, and offers the App Sandbox instead, for which no way to confine an arbitrary child with a custom profile was found. Other products that confine child processes on macOS use the same mechanism. Massion uses it behind the one function of section 1, and the self-check of section 3 turns the features off on a system where it no longer confines.

## Invariants

1. On macOS neither child starts outside the default-deny profile.
2. Unavailable means not started, never started weaker.
3. Whether a run was OS-confined is recorded and never assumed.
4. Node's permission model is never described as the boundary.

## Alternatives

- **Node's permission model alone.** Rejected: its own documentation excludes hostile code.
- **A sandbox library as a dependency.** Not chosen. The need is one profile string; the published runtime examined allows process execution and forking, which these children must not have.
- **Turn the oracle off on Linux until its sandbox exists.** Not chosen. It would remove the verification that CI runs today, which is a weakening of checks; nothing gets worse by keeping today's behaviour and recording it honestly.
- **Narrow reads now.** Not possible yet: the minimal read list that lets Node start is not known. Condition A.

## Consequences

- A macOS CI job runs the isolation tests; existing jobs are unchanged.
- The Bun question (ADR 0005, "What is not decided") can be measured again once isolation no longer depends on Node's flags, which requires condition A.

Revisit when a macOS version ships without `sandbox-exec`, when condition A or B is closed, or when a third place starts running foreign code.
