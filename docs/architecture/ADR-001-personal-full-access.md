# ADR-001 — Personal Full-Access Execution

[English](ADR-001-personal-full-access.md) | [한국어](ADR-001-personal-full-access.ko.md)

> **Status:** Accepted
> **Decision date:** 2026-07-25
> **Scope:** Personal macOS v1

## Context

`review` and `automatic` both preserve active policy, mandatory approvals, and Workspace execution boundaries. Personal users also need an explicit mode comparable to the dangerous bypass offered by Codex and Claude Code when they choose to run under their own macOS and Provider authority.

## Decision

Massion defines three organization autonomy modes.

- `review`: adds user review to non-read actions.
- `automatic`: the default. Actions allowed by active policy run automatically while policy denial, mandatory approval, and Workspace boundaries remain in force.
- `full-access`: after a warning and explicit user decision, bypasses Massion approval prompts, Governance denials and approval requirements, and the Workspace execution sandbox. The executor uses authority already granted to the current macOS user.

Full access does not:

- bypass macOS accounts, ACLs, SIP, or Provider restrictions;
- create a capability that is not installed or exposed to the executor;
- remove input, tenant, revision, checksum, idempotency, or completion checks; or
- automatically index a home directory beyond the selected knowledge context.

The choice persists across restart. It is not exposed as an agent tool. The user leaves full access by lowering the autonomy mode or stopping the active Work.

Stopping is Work-scoped. The escape path is not a duplicate global stop button: execution is stopped where it is visible, with `Esc` or the Work input's stop action. Lowering autonomy to `review` prevents new autonomous Work from proceeding without a decision.

## Consequences

- Governance, subscription execution policy, and Codex and Claude connectors use the same mode and revision.
- Codex maps full access to `danger-full-access` with approval policy `never`; Claude maps it to `bypassPermissions` and non-sandboxed execution. An adapter that cannot provide the requested authority reports a limited mode instead of claiming full access.
- Work, Execution, Tool, Growth, and Effect events remain recorded where the OS boundary permits it.
- Growth may adopt allowed Prompt, Memory, Policy, or Organization versions without an additional action-level approval, but independent evaluation, source and target checksums, effect measurement, exposure stop, and rollback remain mandatory.

Detailed contracts and acceptance are defined in the [full-access design](../superpowers/specs/2026-07-25-full-access-permission-design.md).
