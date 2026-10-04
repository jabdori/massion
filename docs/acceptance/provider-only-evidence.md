# Provider-only candidate evidence

This candidate is reconstructed on local base `eadede380b6f6c0251332db30e7e372061b8d9c3`. Its tree `ffb3b6f08baa73311c09f132dc676cf80e80c723` equals public PR7 head `f232178bfe003ea587e350909f7c941d2020eb46`. The original full experimental stack is preserved separately; this candidate has no correction issuance, consumption or v2 implementation, no new artifact-reader route, and no Domain/Application/Product or backup-format change.

## Included behavior

Native bounded Anthropic Messages and Gemini generateContent adapters; OpenAI/OpenRouter/custom Chat connection presets; explicit session-scoped connection metadata; bounded model discovery and exact manual fallback; role-specific model selection; explicit scope/cap permissions; existing Work preflight and Run; active/pending/unknown configuration locks and no-replay recovery. Host credentials remain behind a caller-supplied resolver. The default CLI supplies neither credentials nor the live gate. Costs and total input-plus-output usage remain unknown; output-token reservations are not money limits.

Neutral `bounded-json.ts` validates plain values without correction dependencies. `chat-request-renderer.ts` preserves the preexisting ordinary Chat request bytes. The existing authoritative Mission store, stateless independent verifier, effect journal, artifact storage and portable restore behavior remain the execution path.

## Fresh validation on this candidate

Pinned Node 24.19.0 and isolated SurrealDB 3.3.0. Strict check: 263 passed, 19 skipped, 0 failed, 282 cases. Actual sequential DB aggregate: 281 passed, 1 opt-in crash/restart skipped, 0 failed, 282 cases. The opt-in crash/restart plus clean backup restore check passed separately (1/1); repeated cases are not added together.

A fresh real Codex IAB session used the disposable in-memory loopback QA host. It saved/discovered the Anthropic native executor, used exact manual Gemini fallback after discovery failure, saved scoped executor/reviewer permissions, and checked without inference. Explicit Run produced fixture-class accepted Record at revision 20; reload preserved it with exactly two model sends. A separate slow Work reached active revision 28; reload kept provider settings locked and owner Cancel available. Cancel recorded revision 29 with pending effect. Revision 30 retained cancelled execution, pending acceptance, unknown usage/effect; reload retained locked configuration with zero Run buttons. The slow executor was sent once and its reviewer was never sent. Original accepted Work remained intact.

The browser host is explicitly synthetic/in-memory; its inherited SurrealDB footer does not establish actual DB evidence. Actual DB tests above are a separate fixture. No real account, API key, OAuth/CLI session, paid provider call or publication occurred. The QA process is stopped after recording evidence.

Independent read-only review found no blocker for the separation, neutral validator, native bounds, exact Chat bytes, and UI recovery locks. Tests include credential/protocol bounds, discovery freshness, active configuration guards, unknown effects, browser reload, concurrency locks, real HTTP fixture UI flow and actual DB portable restore.

Task-local evidence (outside tracked source): `../evidence/provider-only-strict.log`, `../evidence/provider-only-surreal.log`, `../evidence/provider-only-restart.log`, `../evidence/provider-only-browser-accepted.jpg`, `../evidence/provider-only-browser-cancelled.jpg`, `../evidence/provider-only-browser-unknown.jpg`, and `../runtime/provider-only-browser/fixture-events.jsonl`. The task-local candidate JSON records exact base/head/tree and source/log hashes. Public documents contain relative paths only.
