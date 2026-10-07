# Explicit owner-message Work draft evidence

Base: PR57 `829e653697509a1272b6103f424d996ed932abe4`. Scope and acceptance were recorded before implementation in [the design](../architecture/conversation-work-draft.md).

One exact stored message seeds an editable private task. Server capture resolves its same-Mission original hash and stores literal immutable provenance; edited title/current Mission pins remain the requested task. Input hashes, executor/verifier task data, Record and portable lineage retain this evidence. Old owner discussions, Work, unknown reservations and Records remain unchanged. No new runtime authority or automatic execution exists.

Native headless Chrome with normal CLI, actual disposable SurrealDB and a 390px viewport verified keyboard selection/edit/review/private Cancel/save/reload. Cancel journal was exact, original Works exact, provider invocations zero, reload drafts empty; 390/1280 layouts had no horizontal overflow. It is bounded native Chrome evidence, not screen-reader/other-platform certification.

Initial affected actual gate: 51 total, 50 pass, 0 fail, 1 existing browser-conditional skip. First expanded gate: 70 total, 67 pass, 3 test expectation failures, 0 skips. A configured runtime returns `settled` after accepted Record, and a wrong-feed ACK can legitimately reconcile through the original unchanged database receipt; expectations were corrected without bypassing gates. The failed logs remain. Independent review found missing client sequence/prerequisite hash provenance; corrected shared client helper and added client/server hash equality regression. Independent source re-review found no further confirmed defects.

A subsequent 73-test gate had 72 pass and one actual feed-replacement harness timeout: simulated reconnect timers were not advanced while waiting. The driver now ticks until fresh read recovery; no production recovery behavior was relaxed.

Final affected local gate: 73/73 pass, 0 fail, 0 skip, including actual DB and normal CLI/native Chrome. Strict typecheck, runtime syntax and whitespace checks pass. Exact published head and separate CI counts are supplied in the Draft report. No historical counts are summed. Actual live-model quality, general conversation interpretation, scheduler/recovery/remote auth and full issue #4 acceptance remain open.

The initial published candidate `5e0978b` had unit CI 942 total / 689 pass / 1 fail / 252 conditional skips; actual-store step did not run. An empty panel eagerly consumed a UUID, shifting the existing ordinary Work admission identity test. Generate private identity only on deliberate original-message selection; idle rendering now consumes none. Affected new path plus existing workbench local gate after correction: 77/77 pass, 0 fail, 0 skip, including actual DB/normal CLI/Chrome. Initial CI evidence remains retained; final exact-head CI is reported separately.
