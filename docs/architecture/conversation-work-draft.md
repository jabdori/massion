# Owner conversation → reviewed new Work

## Purpose and bounded decision

COL-01/SUR-01 distinguish saved discussion from execution responsibility. WRK-01 and issue #4 require owner-authored bounded Work and exact inspectable provenance. Above PR57, one explicitly selected stored owner message can seed a private new Work title. The owner reviews the original literal message, edits the proposed title and budget, and explicitly saves through existing Work admission. This adopts a bounded conversation-to-Work choice; it does not interpret a whole discussion, answer a question or automate staffing.

Select exactly one message from an existing same-Mission Work. Store an immutable provenance pin on the new Work: original Work/conversation/message identity and message hash, complete original owner message, and admitting owner. Original text is provenance rather than a second implicit instruction: the edited Work title and existing Mission criteria/constraints govern the requested task. Carry the pin through input binding, independent verifier task data, accepted Record and portable lineage. Selecting a message from accepted/cancelled/unknown Work neither changes that source nor permits its retry; admission of the separate new Work is the existing owner capability, and cannot settle any old outcome.

## Acceptance before implementation

- Native owner selection → exact original review → private editable title/budget → explicit save admits one distinct fresh Work with exact provenance and current criteria/memory/organization pins. No runtime/adapter invocation before separate explicit Run.
- Private Cancel performs zero writes and retains original message/Work/Record. No automatic draft selection, save, rebase, retry or restart continuation.
- CAS/feed changes invalidate review; explicit current-state review is required. Pending/unknown receipts block resubmission. Exact late receipt clears only its submitted draft, retaining newer private edits and Mission isolation.
- Server rejects missing/cross-thread/forged/changed message hash and extra selection fields without mutation; caller input is captured before asynchronous reads. Replay preserves original admission; changed-payload identity conflicts.
- Original message/Work/Record remain byte-equivalent, including unrelated unknown effects. Fresh clients, normal HTTP/CLI, actual disposable DB and portable lineage retain pin. Tampered provenance fails validation.
- Affected regression, native headless keyboard/visual verification, independent review, small Draft and exact-head CI are separate evidence. Controlled fixtures are not live quality or full accessibility certification.

No new execution grant, scheduler, model call, conversation authority, unknown reconciliation, automatic action, remote auth or platform installation.
