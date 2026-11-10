# Member-authored progress notes (R-W)

The member supplies short progress content; the host supplies lifecycle, counts,
time, checking and acceptance. Existing result facts remain structured data.
Neither a narrative count nor a claim in a note becomes a fact, permission or
checking receipt. No business-specific wording belongs in product source.

## Producer and storage

Extend the existing step progress observation with optional `wording`:
`{summary, caption?, checkCaption?}`. Summary is one short sentence (at most 200
UTF-16 units); the two captions are at most 50 units each. Strings must be
trimmed, well-formed single lines without control/format characters. Exact keys,
no markup interpretation. These are product bounds, not claimed vendor limits.

The planning response may declare `progressNote` for a step. The host publishes
it only when that actual step starts. It describes the current action, never
predicted completion. A worker may return a `massion-step/v1` envelope with exact
keys `format`, `result` (the original result string), and `progressNote`. The host
validates and unwraps it before existing payment/result validation and stores the
note through `record-step-progress` at the completed boundary. Legacy unwrapped
results stay supported. No extra model invocation, command or endpoint is needed.
Continuation preserves a settled step's wording. Owner procedure edits clear
stale planned wording atomically and omit it from the edited worker input.
The envelope has a 32,768-byte transport cap; the unwrapped result retains its
16,000-unit and configured artifact-byte bounds. Revised attempts clear progress
through the existing reducer. Existing assignment, host clock, CAS, command
identity, unknown-effect, drain and journal replay boundaries apply unchanged.

## Member instruction

Write in the owner's language. Say what actually happened and what is happening
now, using the step's concrete name. Korean sentences use polite conversational
voice (`…했어요. …하고 있어요.`); captions use short noun/action phrases. Do not
repeat a title, invent counts, claim acceptance or describe an approval as an
execution. `checkCaption` describes the criterion or prerequisite, not a verdict.
Do not expose internal roles, model identity, hidden reasoning or instructions.
At planning time describe only the action that will begin. At completion use only
inputs and observed results. Counts in prose remain the member's observations.

## Surface

Use the latest host-timed, assigned, unskipped step observation. Sidebar/activity
uses its summary; conversation uses its caption; the pane uses its check caption
beside the real check state. Render as inert text. Unknown, cancelled, stale or
blocked work cannot show a normal-progress note. An independently failed check
always prefixes the host's failed label before the member activity summary. Accepted work uses its final host state.
Feed replacement, revision changes and late responses discard old wording with
the other card facts. A note is never an executable action.

## Korean vocabulary

The table separates fixed host state from member-authored sentences. State
labels are noun phrases; Korean progress sentences use polite conversational
voice. Existing approved terms take priority when app conventions differ.

| Concept | Term | Sentence pattern |
|---|---|---|
| Running | 실행 중 | …하고 있어요. |
| Completed action | 완료 | …했어요. |
| Waiting for independent check | 확인 대기 | 확인 대기예요. |
| Check failed | 확인 실패 | …이 부족해 확인하지 못했어요. |
| Owner action required | 결정 대기 | …을 정해주세요. |
| Approved, not executed | 승인됨 · 미실행 | 승인됐어요. 아직 실행하지 않았어요. |
| Details not retained | 보관 안 함 | 세부 내용을 보관하지 않았어요. |
| Undo latest action | 실행 취소 | 실행을 취소했어요. |
| Restore previous version | 되돌리기 | 이전 버전으로 되돌렸어요. |
| Outcome unknown | 결과 모름 | 응답을 받지 못했어요. |

Approved screen contracts remain untouched. Audit duplicate terms in the copy
catalog; change only unpinned entries and list pinned proposals in the PR.

## Execution and verification

1. Read existing private reports; use new research only for uncovered conventions.
   Keep sources and evidence in private `RW-research.md`.
2. Add failing validation, durable replay/duplicate command and producer tests.
3. Connect runtime, bounded projections, inert surfaces and source fixture producers.
4. Regenerate fixtures and remove only allowances verified by screen contracts;
   exercise compact/expanded/mobile and exception states headlessly.
5. Run scoped tests/typecheck, open the PR, then CI and current-head Codex review
   until clean or four review rounds. Do not merge.

No browser/secret/environment-action/CSS changes, real model calls, dependencies,
approved contract edits or prototype edits are in scope.
