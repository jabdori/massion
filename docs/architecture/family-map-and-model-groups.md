# Family map, family check and model groups

- Status: implemented (server side, fixture-class evidence). Settings screens are a later increment.
- Date: 2026-11-05, above `feat/assistant-conversation-turns`
- Decisions: [ADR 0003](decisions/0003-members-internal-teams-model-groups-and-apps.md) §3 and §7, implementation order item 4. Replaces the ADR 0002 invariant 4 rule "a different family for every model check".
- Builds on: [Default execution route and persistent connections](default-route-and-persistent-connections.md), [Configured runtime](configured-runtime.md), [Assistant conversation](assistant-conversation.md), [Growth reflection and model proposals](growth-reflection-and-model-proposals.md#who-checks-a-change)

## Problem

Before this change the only checking rule between models was "the verifier is not the same provider and model as the Representative that wrote the Work title" (`assistant_verifier_same_model`), and a default route refused the same profile or the same provider kind and model for both roles. An owner with one model family could not run a Work at all, and a Record did not say how independent its check was. ADR 0003 §7 replaces the rule: prefer a different family, otherwise check with the same model in a separate run, and record the relation.

## Family map

`src/model-family.ts` holds the host-owned map `(provider, model) → family`. Family is the model's developer.

| Provider kind | Family |
| --- | --- |
| `openai`, `codex-cli` | `openai` |
| `anthropic`, `claude-code-cli` | `anthropic` |
| `gemini` | `google` |
| `zai` | `zhipu` |
| `openrouter` | the vendor prefix of the model ID (`anthropic/…`, `openai/…`, `google/…`, `z-ai/…`, `meta-llama/…`, `mistralai/…`, `deepseek/…`, `qwen/…`, `x-ai/…`) |
| anything else (`compatible`, fixtures) | unknown |

- An unknown family is `null` and counts as the same family as everything (fail closed). A custom compatible endpoint can serve any model under any name, so its model ID is not trusted.
- The map is code. Changing it is a change to the checking rules: an owner decision through review, never a Growth candidate, skill, tool or app.

## Family check on every verdict

`Verdict.check` (optional, so earlier Records stay valid) pins:

```ts
interface CheckFamily {relation: 'deterministic' | 'different-family' | 'same-family'; producers: ModelIdentity[]; checker: ModelIdentity | null}
interface ModelIdentity {provider: string; model: string; family: string | null}
```

- **Producers** are `workProducers(work)`: every distinct executor assignment model of the Work, then the pinned Representative (`assistantSource.representative`) when the Work came from the conversation, since it wrote the title the result is checked against.
- **Checker** is the verifier assignment's model; `null` for a host deterministic oracle.
- `different-family` only when the checker's family and every producer's family are known and none equals the checker's. Otherwise `same-family`, which includes the same model in a separate run.
- The configured runtime computes the families from the map at verify time; the bounded fixture scenario records `deterministic`. The domain checks the pin, not the map: producer and checker identities must equal the Work's assignments and Representative pin, and the relation must follow from the pinned families. One provider and model carries one family inside a pin, so relabelling a producer's own model cannot claim `different-family`. The map is not re-read on replay, so a later map change never rewrites or invalidates an old Record.
- A same-family check can accept a Work. `supportsAutomaticAdoption(check)` is true only for `deterministic` and `different-family`. Today no automatic adoption path exists (Growth adoption is an owner command after a host deterministic evaluation); any later automatic Growth or self-made skill adoption must pass this gate.

### Rules removed

- The run preflight no longer refuses `assistant_verifier_same_model`. A Representative on the verifier model now starts its Work; the Record says `same-family`.
- A default route no longer refuses the same profile or the same provider kind and model for both roles. Executor and verifier stay separate actor identities in separate calls, and self-verification stays refused by actor. Each route view adds `check: 'different-family' | 'same-family'`.

### Same family only when no different family is available

- ADR 0003 §7 prefers a different-family checker. The host asks every model group, the derived default included, through the same choice as `chooseGroupModel`: an available model within the output cap whose family is known and differs from every producer.
- When one exists, a same-family default route is `stale` with `a different family is available for checking` (so `setDefaultRoute` refuses it and `resolveDefault` does not resolve it), and the run preflight refuses a same-family selection with `verifier_family_available`. The preflight producers are the Work producers plus the selected executor, so a Representative-written Work counts the Representative.
- The owner then grants the different-family checker. The host never rewrites a grant or route by itself.
- Unknown families (compatible endpoints, fixtures) never count as a different family, so a single-endpoint setup still checks on the same model.

## Model groups

A model group is a named set of models with a one-line description. It lives in host settings next to the default route (`HostSettingsV3.modelGroups`), saved through the existing compare-and-set path.

```ts
interface ModelGroup {id: string; name: string; description: string; models: ProfilePermission[]} // ≤ 32 groups, 1..16 models
```

- **Default group.** `id: 'default'` is not stored. It is derived from what exists today, so nothing migrates: the Representative route's model, then each default route's executor and verifier. It is listed first and is not editable here; the existing Representative and default route commands still change it. Version 1 and 2 documents load with no other groups.
- **Owner groups.** `POST /model-groups {id, name, description, profileIds, expectedConfigHash}` creates or replaces one group in place and applies at once (an owner setting, ADR 0003 §3). `POST /model-groups/remove {id, expectedConfigHash}` removes it. Each profile must be a currently selected model; its exact `configHash` is pinned. IDs and names are unique; `default` is reserved.
- **View.** `GET /connections` gains `modelGroups`: the default group first, then owner groups, each model with `provider`, `model`, `label`, `family` and `status` (`available` or `unavailable`).
- **Host choice inside a group.** `chooseGroupModel(groupId, {outputTokenCap, producers?})` walks the group in order and keeps a model that is available now (the pinned hash resolves and a live model has the live option) and whose output limit covers the cap. With `producers`, it prefers the first model of a different family and otherwise takes the first remaining one, returning the relation it will have. It names one model or fails with `model_group_missing` or `model_group_unavailable`; it never falls back to another group. It performs no call and grants nothing: a run still needs a grant and the full admission check.

## Q15 discriminator role

Groups may carry `role: 'discriminator'`; omitted roles retain existing behavior. The role persists through the same settings CAS path and is shown by the minimal discriminator model picker in Settings > Connections. `resolveDiscriminator(groupId)` selects a compatible HTTP profile within the host output reservation and returns the typed System One adapter, holding settings until release. It honors the existing live gate; choosing a group never invokes it. These groups do not supply conversation text or count as available checking seats. See [Discriminator slot](discriminator-slot.md) for the shadow-only contract, journal and calibration boundary.

## Invariants

1. The producer never judges its own result: actor identities stay distinct whatever the models.
2. Every model check made by the configured runtime pins producers, checker, families and relation; the domain refuses a pin that does not match the Work.
3. Unknown family is the same family.
4. Same-family checks never support automatic adoption.
5. The family map changes only by code review. No HTTP route, setting, Growth candidate or group edit changes it.
6. Model group edits never change an admitted run, a grant or a default route.

## Acceptance (tests)

`tests/family-map.test.ts`, fixture adapters and `InMemoryHostSettings` only:

- The map: first-party providers, OpenRouter vendor prefixes, unknown compatible and fixture models; relation rules including unknown families.
- Domain: a verdict whose check names the wrong producers or checker, or a relation that does not follow from the families, is refused; a correct one is pinned in the Record.
- Runtime: a run with executor and verifier on the same profile is admitted and accepted, and the Record says `same-family` with both identities; an OpenAI executor and Anthropic verifier (mock HTTP) record `different-family`.
- `supportsAutomaticAdoption` refuses `same-family` and a missing check.
- A same-family route or selection is refused while a group holds an available different family, and allowed again once none is left; a forged pin that gives one model two families is refused.
- Model groups: save, replace, remove, reserved and duplicate IDs, unknown profiles, stale `expectedConfigHash`, survive a restart, a stored unknown field rejects the document, version 2 documents still load; the default group lists the Representative and default route models; the host choice skips unavailable and too-small models, prefers a different family and records `same-family` otherwise.
- HTTP: `/model-groups` and `/model-groups/remove` return the list; a stale hash is refused.

## Out of scope (follow-up)

- Settings screens for groups (B14, B20) and family labels on models.
- Editing the default group in place; changing the models that check through a decision card (ADR 0002 §5, the policy gate).
- Using `chooseGroupModel` for admission: members and teams that pick a group by description (ADR 0003 §2, §3), and per-group grants.
- How the owner is told that checks run on one family (ADR 0003 §7).
- Budget beyond the per-call output limit.
- The route view `check` counts only the executor as producer; a Representative-written Work also counts the Representative (the preflight does). Show the Work-level relation when Q9 shows families.
- A fixture-class verifier may pin `deterministic`; the domain cannot tell a host oracle from a mock HTTP model by evidence class alone.
- The default group description is a host string; Q9 should drop it to match B14.
