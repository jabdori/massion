# Member memory candidates (R-D)

## Intent and boundaries

ADR 0001–0005 and `docs/product/concepts.md` keep conversation as provenance. A member may propose a bounded named instruction; only its message owner can save or discard that exact candidate. Saving is an explicit owner instruction, not independently evaluated learned-memory adoption. Growth and rule-change decisions are outside this slice.

## Contract

Extend the existing member turn JSON with optional `memory: null | {name, content, sourceWorkId: string | null}`. Representative output cannot carry it. Steering and memory are mutually exclusive. Legacy member outputs remain readable. The host supplies available member Work identities; it captures source Work title, input hash and criteria hash from stored state, never from model text. A general remark may have no source Work; do not fabricate one.

The answered turn owns one immutable version-1 candidate with an ID derived from segment and turn, the member, intake Mission/scope and owner-message hash. A candidate hash covers all proposal fields. The model-response deadline still applies at settlement; an expired or unknown turn produces no candidate. Owner review carries feed, segment revision, candidate identity/version/hash and current target Mission revision. Source Work pins must still match. No text, scope or version can be substituted by the action.

Use the existing segment reducer, command journal and CAS dispatch. An owner `decide-assistant-memory` command records either discard or a save intent through the drain-aware owner store. Only a fresh committed save intent attempts the normal `Application` save-memory command, once, with deterministic identity and the reviewed Mission revision. A replay or unknown intent never resumes the save. Reads reconcile the original save operation; absence remains unknown, without resend. Overlapping identities use lookup after state loading and replay on idempotency conflict, as existing dispatchers do.

Memory adds optional display `name` and exact `sourceWork` (Mission, Work, title, input hash, criteria hash). Old memories remain valid. Save-memory validates supplied metadata and same-Mission source pins. B12 uses the name when supplied, retains content in details, and opens only the exact stored source Work. It never guesses a source from the plain source string or a memory ID.

## Client and integration

Render an inline `기억 후보: {text}` line with the existing save/discard actions, not a bordered card or a duplicate name/content block. Add only memory-specific helpers and one member-reply attachment in the shared conversation panel. Bind buttons to feed, thread, selection, segment revision and immutable candidate hash. Persist an uncertain receipt before sending; refresh is read-only. Per-attempt generation/object tokens prevent late completions from changing another view or newer attempt. Existing eventless pending-turn refresh handles response deadlines; no new candidate expiry policy is introduced. Settings source links capture feed/Mission revision and reject stale cached data.

The lead owns `server.ts`: route POST `/assistant/memory-candidates` through the member chat's `decideMemory`, requiring mutation-feed admission; preserve the existing ownerStore passed to every AssistantService. Conversation GET already delegates to `read`, which includes candidate views. Allow optional `name`/`sourceWork` on explicit-memory HTTP validation if that API is intended to author them. No new route, allow-list, fixture-contract, Growth or rule-change edits are made by this slice.

## Verification

Write meaningful failing tests before implementation: strict member JSON, no automatic save, exact identity/version/hash and source validation, save/discard and cross-thread refusal, overlapping commands, ownerStore drain between reads and commit, ambiguous commit/restart with read-only reconciliation, expired responses, stale feed/thread/cached settings links, and late response generation fencing. Run related local tests and typecheck only; no external models, network tests, commits or pushes. Screen-contract integration belongs to the lead.
