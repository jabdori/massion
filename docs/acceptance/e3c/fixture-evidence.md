# E3c fixture evidence

## Scope and readiness

The nine B7/B8 fixtures are ready for the main agent's 18-state dark/light capture. Fixture JSON is frozen after the checks below. This sidecar changes only `scripts/ui-contracts/fixtures/B7*.json`, `B8*.json` and this document. Production UI, tests, contracts, checker behavior, baseline classification and the final residual ledger belong to the main agent. B4 and all other fixtures are untouched.

No commits, external network requests or provider invocations were made. The original-fixture baseline completed before fixture writes: `/private/tmp/e3c-baseline.log` contains `Report: /Users/code/orca/workspaces/massion/e3c-work-pane/.runtime/e3c-before/report.md`.

## Supported repairs

The original fixtures failed `validateAssistantSource` for every Work because they had no source pin. Replacement states were built with `Application` and `AssistantConversation` commands in an in-memory store, following the existing [accepted-text fixture](../../../tests/support/record-artifact-fixture.ts#L11) and [bounded runtime task/assignment sequence](../../../src/configured-runtime.ts#L222). The JSON contains results of production readers, rather than additional read schemas.

| Data | Repair and producing source |
| --- | --- |
| Conversation ownership | Complete owner-message pin, canonical message hash, deterministic message/turn/Work/run IDs, and the existing Quill and Juno member identities. [Source schema and ID builders](../../../src/assistant-conversation.ts#L35); [exact source validation](../../../src/assistant-conversation.ts#L123); [host admission](../../../src/assistant-service.ts#L246). |
| Exact Work reads | The Mission snapshot and read-state snapshot agree; list and conversation rows use the actual Mission revision, member, execution, acceptance, durable start/end, uncertainty and task counts. Serialized from [conversation reads](../../../src/assistant-service.ts#L282) and [Work-list reads](../../../src/assistant-service.ts#L300). All retained Works have matching source turns, so the Representative history now includes their actual fixture admission messages. |
| Runtime ownership | Bounded original host/dispatch/start/deadline, pinned criteria/input hashes and output-token budget. Ownership query results use the frozen fixture clock and retain `replayPermitted:false`. [Run schema](../../../src/domain.ts#L40); [activation](../../../src/domain.ts#L277); [ownership reader](../../../src/runtime-lifetime.ts#L25). Host and grant names are data-only fixture identities, not proof of a live dispatch or authorization. |
| Tasks and attempts | One root plus executor/verifier children, with the runtime's three assignments, actual queued/active/settled status and settled results. Removed the unsupported synthetic business-step counts. The host counts only child tasks for conversation progress. [Task/result shapes](../../../src/domain.ts#L29); [attempt shape](../../../src/domain.ts#L36); [runtime delegation](../../../src/configured-runtime.ts#L222); [progress projection](../../../src/assistant-service.ts#L34). |
| Criteria and check | Preserve the existing pinned acceptance description and version. Preserve known passed/failed fixture verdicts and independent actor assignments; add the actual family-check shape. The provider name `fixture` has no known family, so `familyCheck` returns `same-family` with null families. Model names alone do not establish different-family checking. [Verification binding](../../../src/domain.ts#L330); [family map and projection](../../../src/model-family.ts#L4). |
| Known accepted result | B7-done/B8-done contain a fixture text artifact, successful effects, settled attempt results and a recomputed accepted-record checksum including source and ownership. Artifact and snapshot paths agree. Serialized through [the accepted-artifact reader](../../../src/record-artifact.ts#L17), including its exact-byte/hash checks. The old illustrative order/amount text was replaced by the existing fixture title and existing fixture result text; it is not purchase evidence. |
| Known failed result | B7-fail/B8-fail retain failed Assurance with no Record. Full Work binding, original run input/criteria hashes, settled effects and tasks make [the rejected-artifact reader](../../../src/rejected-text.ts#L14) succeed. The returned verdict/input fields now match that reader exactly. |
| Unknown result | B7-unknown/B8-unknown retain an unknown effect, null measured usage, deadline interruption, no verdict/Record/recovery and no replay. The unknown target is the fixture text-provider identity; no payment response or payment approval is fabricated. The existing [payment-specific exception projection](../../../src/assistant-service.ts#L36) therefore has `fact:null`. |
| Owner discussion | Churn has one owner-authored “기업 고객은 따로 봐 줘.” message appended through [the existing Work-discussion command](../../../src/domain.ts#L235). It retains the real owner-only role, ordinal, reply and conversation identity. No model reply or timestamp was added to this entity. [Discussion validation](../../../src/work-conversation.ts#L10). |
| Member conversation | The existing member-conversation GET routes return separate member discussion from actual `AssistantService.read()`; the member reply has no Work proposal, admission outcome or attached execution result. This follows [the HTTP member wrapper](../../../src/server.ts#L135) and [member-turn restriction](../../../src/assistant-service.ts#L324). Text comes from the existing B18 fixture. Three separate exchanges reuse approved B18 owner/reply text, with no member Work proposals or attached execution outcomes. B7-churn, B7-fail and B8-fail open Quill and then the exact Work sidebar row. |
| Juno ownership and unread | PR #84 is admitted with Juno pinned through the same source/task/assignment commands. B7/B8 and the done/fail/unknown variants reuse the existing accepted PR #84 text from B16, so Juno is idle with unseen Work. B7-churn reuses B18's active PR #84, so Juno is busy and its unread indicator stays suppressed. No file-read telemetry fields or new external outcomes were added. [Existing unread/busy rules](../../../src/surface-shell.ts#L70); [member Work admission](../../../src/assistant-service.ts#L238). |
| Member steering scope | Generic confirmed steering is supported through the existing confirmation path. In the final B7-churn/B7-fail correction and inherited B8-fail, both the enterprise and preference exchanges are plain discussion: neither emits a steering line or claims an applied Work change. The earlier pricing-format member steer was removed from these reads so it cannot consume the enterprise steering position. No confirmed churn line or resume was fabricated. [Confirmation path](../../../src/assistant-service.ts#L197); [existing steer line](../../../src/assistant-conversation-panel.ts#L89). |
| Rail and setup | Reuse B18's installed GitHub rail descriptor and approved square member shapes. Update all ready/setup selectors and artifact query identities for generated Work IDs. The same query data serves compact and wide views; B8 variants reuse the corresponding B7 fixture through [existing fixture inheritance](../../../scripts/ui-contracts/fixture-host.ts#L27). B7-done, B7-fail and B7-unknown enable the existing activity toggle after opening the exact Work, as do their wide variants. No product commands are needed for setup. |

The pricing Work retains its existing owner-authored instruction and waiting state. The final affected member reads make no steering claim for the preference exchange. Its run input hash intentionally binds the input before that instruction; steering does not rewrite the original run pin. [Input hash](../../../src/domain.ts#L169), [steering command](../../../src/domain.ts#L337).

## Capabilities intentionally absent

These are producing-path limitations, not remaining fixture repairs. The main agent owns their exact contract occurrences and residual classification.

| Requested artboard fact | Why it remains absent |
| --- | --- |
| Named shopping/research procedures, five business steps and per-step times | A task stores only ID, parent, status and optional result; it has no title/start/end fields. The current runtime creates the root and two text-processing children. [Task schema](../../../src/domain.ts#L29); [delegation and assignments](../../../src/configured-runtime.ts#L222). Root run times must not be repeated as individual step times. |
| Browser visits, page/file-read counts, business-record counts and tool activity | The current producer asks for bounded text and performs artifact storage plus independent text review. It does not request browser tools or record page telemetry. [Executor prompt](../../../src/configured-runtime.ts#L226), [artifact production](../../../src/configured-runtime.ts#L234), [verifier prompt](../../../src/configured-runtime.ts#L238). Generic effect strings are not structured browser telemetry. |
| Payment approval/history, amount/currency slots, order receipts and payment send-count guarantees | The supported runtime invokes text producers, writes text and verifies text. [Effect schema](../../../src/domain.ts#L28) has no payment amount, owner approval, order ID, currency or send-count fields. The existing payment-specific exception projection recognizes literal retained strings but does not produce a payment transaction. [Projection](../../../src/assistant-service.ts#L36); [text execution and review](../../../src/configured-runtime.ts#L225). No payment strings were inserted to force matches. |
| Independent check of an actual purchase or vendor order | Accepted Records pin artifact, verdict, effect and assignment evidence; they do not turn a text description into a vendor receipt. [Accepted Record schema](../../../src/domain.ts#L35), [acceptance command](../../../src/domain.ts#L333). Done fixtures prove the known fixture text result only. |
| Dedicated handoff or criteria-fix timestamp | `AssistantSource` has no `at`, and criteria contain version/description/oracle only. A conversation turn exposes its own recorded start as `at`; that is available for conversation display, not a distinct handoff/criteria event. [Source schema](../../../src/assistant-conversation.ts#L35); [criteria schema](../../../src/domain.ts#L20); [turn-time projection](../../../src/assistant-service.ts#L284). No `assistantSource.at` was added. |
| Model replies in the Work owner-discussion entity | Work discussion accepts owner messages only and stores no message times. Member replies live in the separate member conversation. The generic steering path is supported; final affected exchanges are plain replies, and only the exact confirmed-steer-plus-continuation combination below is unavailable. [Owner-message append](../../../src/domain.ts#L235), [discussion validation](../../../src/work-conversation.ts#L15), [steering confirmation](../../../src/assistant-conversation.ts#L98). |
| Subscription-CLI connection provenance and monetary budget | The retained assignments are explicitly `evidenceClass:fixture`, provider `fixture`, mode `mock-http`. Their budget is `output-tokens`, not a currency amount or evidence of a real CLI connection. [Model and budget schemas](../../../src/domain.ts#L25), [runtime activation](../../../src/domain.ts#L277). |

## Requested chronology reconstruction: actual transition blocker

The final chronology request is reproduced by the checked-in read-only probe [steering-continuation.mjs](steering-continuation.mjs). It reconstructs the affected Quill paths with `Application`, `AssistantConversation` and `AssistantService.confirmSteer`, not edited projection timestamps. Run it from the repository root:

```sh
node docs/acceptance/e3c/steering-continuation.mjs
```

All times below are November 5, 2026, Asia/Seoul. The command-derived Representative source messages have churn ordinal 1 and pricing ordinal 3, with their canonical message hashes.

| Host-clock event | Observed result |
| --- | --- |
| 09:40 churn admission; 09:41 member intro | Both commands commit in the requested source order. |
| 09:52 enterprise instruction explicitly confirmed on active churn | The exact churn steering is recorded. Its Work becomes `waiting`. |
| 10:30 pricing admission; 10:41 preference exchange | Both commit after the first two member exchanges. The pricing format preference can be explicitly confirmed on pricing. |
| 11:20 existing failed churn review | The existing failed verdict commits, and the 09:52 historical churn steering still reads `recorded`. Churn execution remains `waiting`. |
| Settle the failed verifier task | Rejected with `Owner steering must be resolved before task progression`. |
| Read the exact failed candidate | The existing production reader returns 409. The retained run input hash also differs from the current instruction-bearing Work input. |

The limitation is the requested **combination** of confirmed churn steering with later active/settled execution and a successful rejected-artifact read. Generic steering, the specified admission order, the three member exchanges and their actual host-clock times are supported and were reproduced; they must not be classified as unavailable fixture facts. [Steering sets waiting](../../../src/domain.ts#L337); [task progression refuses waiting](../../../src/domain.ts#L310); [configured runtime rejects steered execution](../../../src/configured-runtime.ts#L180); [failed-candidate reader requires settled execution and matching run input](../../../src/rejected-text.ts#L14).

The probe exits successfully only after asserting those exact results for B7-churn and B7-fail. The probe has no write mode or fixture writer. No B7/B8 JSON was changed in this chronology attempt, and no fake resume, prior failure, input-hash rewrite or model outcome was introduced. A producing transition or a revised final-state requirement is needed before applying that combined scenario; B8-fail continues inheriting the unchanged B7-fail.

## Final supported minimal alternative

The final fixtures use plain replies after the command-level blocker was reproduced. The saved ignored builder is `.runtime/e3c-plain-member-fixtures.mjs`. It rebuilds the three existing exchanges through `applyAssistant` and serializes the actual `AssistantService.read()` member response, with no Work proposal, admission outcome or steering fields.

Only `B7-churn.json` and `B7-fail.json` were written in this final correction; B8-fail inherits the latter. Both enterprise and preference exchanges remain plain discussion. All three supported replies and their Copy controls remain in order. Missing confirmed enterprise steering is reported directly as the unsupported **confirmed steering followed by continued active/settled execution** combination, not as an unsupported generic exchange or Copy control.

The builder asserts that every route except the two member-conversation query forms is unchanged. Existing active/settled Work states, owner-authored pricing waiting state, source ordinals/hashes, run input pins, accepted-record checksums and successful artifact readers are preserved. This fallback retains the existing fixture clocks and admission order; it does not claim the optional 09:40/10:30 chronology rewrite was applied or classify chronology itself as unsupported. No other screen, production source or checker was changed by this correction. JSON was frozen after the checks below.

## Verification

Node 24.21.0 at `/Users/code/.local/share/mise/installs/node/24.21.0/bin/node` was used. Checks were repeated after the final JSON changes and B8 inheritance.

- Existing fixture tests: **4 passed, 0 failed**. The metadata test loads all 75 approved states; snapshot tests retain accepted/failed/unknown behavior and immutable-record consistency. Command:

```sh
PATH=/Users/code/.local/share/mise/installs/node/24.21.0/bin:$PATH node --test --test-name-pattern='^(every approved screen|started Work snapshots|state variants|approved example members)' tests/ui-contract-fixtures.test.ts
```

- Actual inline client with the existing `tests/support/workbench-client.ts` DOM harness: **9 setup flows passed**, including generated-ID readiness selectors, the churn/fail member switches and exact Work rows, done/fail/unknown activity toggles, three plain member replies and Copy controls without a substitute steering line in the final affected states, every wide-view step, and the corrected Juno states. **Zero missing reads and zero product writes**. This checks client behavior, not browser layout.
- Actual sidebar rows: B7 shows Juno idle/unread, B7-churn shows busy with unread suppressed, and B7-done/fail/unknown show idle/unread. All five assertions passed against the rendered client DOM harness.
- Persisted JSON integrity and actual reader replay: **9 screens, 33 Work snapshots, 10 accepted results, 2 failed results and 2 unknown results passed**. Accepted checksum corruption and rejected-binding corruption each fail with the existing 409 guard.
- Scoped `git diff --check`: passed.
- Browser screenshots, mobile layout, aggregate production tests and before/after contract metrics are the main agent's verification work. This document makes no visual-fidelity or real-provider claim.

The following read-only assertion command reproduces the persisted-data checks without providers, sockets or new files:

```sh
PATH=/Users/code/.local/share/mise/installs/node/24.21.0/bin:$PATH node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadFixture} from './scripts/ui-contracts/fixture-host.ts';
import {hash,workInputHash,workProducers} from './src/domain.ts';
import {assistantRunId,validateAssistantSource} from './src/assistant-conversation.ts';
import {familyCheck} from './src/model-family.ts';
import {validateConversations} from './src/work-conversation.ts';
import {validateRuntimeOwnership,validateRuntimeInterruption,readRuntimeOwnership} from './src/runtime-lifetime.ts';
import {readRecordArtifact} from './src/record-artifact.ts';
import {readRejectedText} from './src/rejected-text.ts';
let works=0,accepted=0,rejected=0,unknown=0;
for(const screen of ['B7','B7-churn','B7-done','B7-fail','B7-unknown','B8','B8-done','B8-fail','B8-unknown']){
 const f=await loadFixture(screen),state=f.routes['/read-state?mission=intake'].body;
 assert.deepEqual(state.snapshot,f.routes['/missions/intake'].body);
 const store={readState:async()=>structuredClone(state)};
 validateConversations(state.snapshot.value);
 for(const w of state.snapshot.value.works){
  works++;validateAssistantSource(w.assistantSource,w.id);validateRuntimeOwnership(w.runtimeRun.ownership);validateRuntimeInterruption(w);
  assert.ok(!Object.hasOwn(w.assistantSource,'at'));
  assert.equal(w.runtimeRun.id,assistantRunId(w.assistantSource.turnId));
  assert.equal(w.runtimeRun.criteriaHash,hash(w.criteria));
  assert.equal(w.runtimeRun.inputHash,workInputHash({...w,instructions:[]}));
  const row=f.routes['/assistant/works'].body.works.find(x=>x.workId===w.id);
  assert.equal(row.missionRevision,state.snapshot.revision);
  assert.equal(row.startedAt,w.runtimeRun.ownership.startedAt);
  assert.equal(row.endedAt,w.endedAt??null);
  const turn=f.routes['/assistant/conversation'].body.turns.find(t=>t.id===w.assistantSource.turnId);
  assert.equal(turn.work.workId,w.id);
  assert.equal(turn.work.steps.total,2);
  assert.equal(turn.work.steps.done,w.tasks.filter(t=>t.parentId!==null&&t.status==='settled').length);
  for(const task of w.tasks)assert.ok(Object.keys(task).every(k=>['id','parentId','status','result'].includes(k)));
  const realNow=Date.now;
  try{Date.now=()=>f.now;const ownership=await readRuntimeOwnership(store,'intake',w.id,state.feedId,()=>false);ownership.currentHostSessionId='host:e3c-reader';assert.deepEqual(ownership,f.routes['/missions/intake/run-ownership?work='+w.id].body);}
  finally{Date.now=realNow;}
  if(w.record||w.acceptance==='failed'){
   const response=Object.entries(f.routes).find(([path,entry])=>path.includes(w.record?'/record-artifact?':'/rejected-artifact?')&&entry.body.workId===w.id)[1].body;
   const reader={read:async()=>response.content};
   assert.equal(createHash('sha256').update(response.content).digest('hex'),w.artifact.sha256);
   assert.deepEqual(w.verdict.check,familyCheck(workProducers(w),w.assignments.find(a=>a.role==='verifier').model));
   if(w.record){
    accepted++;assert.equal(w.record.artifactSnapshot.path,w.artifact.path);
    const input={recordId:w.record.id,artifactVersion:1,artifactSha256:w.artifact.sha256,feedId:state.feedId};
    assert.deepEqual(await readRecordArtifact(store,reader,'intake',w.id,input),response);
    const broken=structuredClone(state);broken.snapshot.value.works.find(x=>x.id===w.id).record.checksum='0'.repeat(64);
    await assert.rejects(readRecordArtifact({readState:async()=>broken},reader,'intake',w.id,input),e=>e.status===409);
   }else{
    rejected++;const input={binding:hash(w),artifactVersion:1,artifactSha256:w.artifact.sha256,feedId:state.feedId};
    assert.deepEqual(await readRejectedText(store,reader,'intake',w.id,input),response);
    await assert.rejects(readRejectedText(store,reader,'intake',w.id,{...input,binding:'0'.repeat(64)}),e=>e.status===409);
   }
  }
  if(w.effects.some(e=>e.status==='unknown')){
   unknown++;assert.equal(w.record,undefined);assert.equal(w.verdict,undefined);assert.equal(w.runtimeRecovery,undefined);
   assert.equal(w.budget.measured,null);assert.equal(row.exception.fact,null);
   assert.ok(w.effects.every(e=>e.target!=='결제 요청'));
  }
 }
 for(const member of f.routes['/assistant/conversation'].body.members){
  const route=f.routes['/assistant/conversation?member='+member.id].body;
  assert.equal(route.member.id,member.id);
  assert.ok(route.turns.every(t=>!t.proposal&&!t.work&&!t.outcome));
  if(member.id==='member-quill'){
   assert.equal(route.turns.length,3);
   if(['B7-churn','B7-fail','B8-fail'].includes(screen))assert.ok(route.turns.every(t=>!t.steer));
   else{
    const steering=route.turns[2].steer,target=state.snapshot.value.works.find(w=>w.id===steering.workId);
    assert.equal(steering.status,'recorded');assert.equal(steering.missionId,'intake');
    assert.equal(target.title,'경쟁사 가격');assert.equal(target.execution,'waiting');
    assert.equal(target.instructions.at(-1).text,route.segment.messages.find(m=>m.id===route.turns[2].messageId).text);
   }
  }
 }
 console.log(screen+': persisted fixture integrity and production readers passed');
}
console.log(JSON.stringify({screens:9,works,accepted,rejected,unknown}));
JS
```
