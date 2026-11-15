# Contributing

Thank you for helping. Massion is strict about a few things because earlier versions failed without them; [how Massion got here](docs/product/story.md) explains why.

## Before you open a pull request

- Use English for repository artifacts and Conventional Commits.
- Keep changes reviewable.
- Do not import archived runtime data or copy abandoned implementation without explicit provenance review.

## Testing and reporting

- Run the final candidate's aggregate checks and report passed, failed and not-run stages separately.
- Fixture evidence is never real-provider evidence.
- A changed file after testing requires the affected checks again.
- Do not merge, publish credentials, release or deploy as part of a local test.

## Rules every change keeps

| Area | Rule |
| --- | --- |
| **Ownership** | UI, providers, SDKs and external assistants submit application commands; they do not own Work truth. |
| **Effects** | Persist intent before effects. Unknown outcome is not failure and does not authorize replay. |
| **Evidence** | Preserve criteria, artifact versions, identity and authority at evidence boundaries. Never substitute a model's "done" for independent acceptance. |
| **Storage** | Retain atomic state/event/audit/outbox commit, CAS revisions, command identity readback and backup/restart evidence. |
| **Checks** | Preserve executor/verifier independence and current-byte verification. |
| **Growth** | Retain measured evaluation, adoption lineage, later effect and safe revert. |

> [!WARNING]
> The controlled execution module accepts only known fixture bytes. Do not expand it into an arbitrary code runner or call a CLI agent using platform credentials. Actual providers, external packages, persistent access, VM infrastructure and deployment need their own authorized integration and tests.

New here? Start with the [documentation map](docs/README.md).
