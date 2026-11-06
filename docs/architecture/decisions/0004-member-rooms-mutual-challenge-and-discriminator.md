# ADR 0004: Member rooms, mutual challenge and the discriminator

- Status: accepted working design; not implemented; reversible on measured evidence
- Date: 2026-11-07
- Scope: how members, team leads and workers talk to each other inside a Work, how they challenge each other, who speaks next, when talk stops, what the owner sees, and where a discriminator model sits between turns. Builds on [ADR 0003](0003-members-internal-teams-model-groups-and-apps.md) §2 (internal teams), §3 (model groups), §6 (collapsed single-step Work) and §7 (checks with one family), and answers its open question on the member-to-member message cap. See [Changes to ADR 0002 and ADR 0003](#changes-to-adr-0002-and-adr-0003).

Each rule below is marked **Owner** (asked for by the owner on 2026-11-06/07) or **Proposal** (this ADR's design, to be measured). Owner covers only the room, mutual challenge, owner first, and the discriminator's role and slot. Every number is an initial default to be measured, not a fact.

## Context

Today agents never talk to each other. The host passes one artifact down a fixed line:

- The configured runtime delegates an executor task and a verifier task, runs the executor, writes the artifact, then puts the artifact text into the verifier prompt (`src/configured-runtime.ts:196-212`). The host checks every verifier quote against the artifact text (`:218`) and accepts on a pass (`:224`).
- Organization responsibilities are exactly executor and verifier (`src/domain.ts:143-152`); the `Role` type also has owner, representative, evaluator and assistant (`:17`). A task tree exists: `delegate` adds a task under a `parentId`, by the Representative only (`:296-299`). `publish-artifact` is executor-only and requires the version to advance (`:318`). The Work budget is one limit with `unit?:'output-tokens'` (`:57`), plus a run deadline.
- Work-room messages are owner-only: `append-work-message` requires the owner, and a stored message has `role: 'owner'` (`src/domain.ts:225-228`, `:64`). Work questions are owner-only and only before the Work starts (`:218-219`).
- Members have a 1:1 conversation only and start no Work (`MEMBER_INSTRUCTION`, `src/assistant-service.ts:45`; the proposal is dropped, `:224`).
- Whether a request is answered directly or becomes Work is the Representative's model output. It is parsed strictly (`src/assistant-service.ts:36`), but no host rule checks the choice.
- The family rule is in [Family map and model groups](../family-map-and-model-groups.md).

On 2026-11-06/07 the owner asked for mutual, aggressive communication between members, "like Grok Bot". Research of the same days ([Evidence](#evidence)) found:

- Grok Bot's documented design routes work; it does not make bots attack each other. Bots pick who replies, hand work between bots and keep one owner per stage. There is no documented cap on bot-to-bot messages; usage limits act as one. Unverified third-party reports suggest that critique between bots appears where users create a reviewer or "devil's advocate" bot, and that failures are two bots trading edits without end or thanking each other in a loop.
- "Aggressive" in the earlier jabtang plans meant self-restructuring automation and strict developer-side review, not agents arguing.
- The only earlier design with agents challenging each other is the 2026-07-10 product design §5.2: typed messages (`question`, `answer`, `proposal`, `challenge`, `review_request`, `change_request`, `evidence`, `decision`, `handoff`, `status`), a coordinator that controls turns, concurrency, budgets, rounds and termination, no forced interruption between agents, and an owner who can always speak, pause and stop.
- In Khan et al. 2024, debate improved accuracy with assigned opposing sides and a separate judge. Gains level off after a few rounds (Du et al.). Free debate can turn right answers into wrong ones through conformity (Wynn et al. 2025). Majority voting at equal cost explains most reported debate gains (Choi et al. 2025).
- Jev (TypeSafe) is a discriminative "decision model": a typed question (`choice`, `score`, `noul`, `box`) about a given state returns a probability distribution and a confidence, never text. Several open-weight servers say they implement the same `/v1/systemone` API; their accuracy figures are self-reported. TypeSafe docs, as quoted by opencodex, say it is most accurate in English and weak on adversarial input. No source uses such a model between agents; that use is the owner's idea.

## Decision

### 1. A Work with several producers is a room (Owner: room; Proposal: scope and board)

- Rooms, challengers and the discriminator apply only to Work with two or more producing participants, the checking seat excluded. Single-step Work keeps the fixed executor → verifier line and the collapsed line of ADR 0003 §6.
- A room extends the Work room of ADR 0003 §2; it is not a new conversation. It holds:
  1. **Messages.** Each has a kind from the ten in the 2026-07-10 design, an author identity, a host ordinal and optional `replyTo`, `to`, `issueId` and evidence references (quote, Record, artifact version, test output).
  2. **A shared board.** The task list (the Work's task tree), the issue list (`open`, `resolved`, `escalated`) and the current artifact version. The board, not the message flow, is the state that turns, stalls and termination read.
- **Board keeper.** The team lead of the member that opened the Work, or of the Representative's team, keeps the board. Other team leads change only their own subtree of tasks.
- **Direct messages** between participants are allowed only inside a Work, stored in the room as "A → B" events. There is no hidden channel. The owner's 1:1 conversations are unchanged (ADR 0003 §1).
- **Message accounting.** Agent room messages, direct messages, returned challenges and refused challenges count toward the message cap. Owner messages and discriminator records do not.
- **Speaker context.** A speaker gets the board, the messages addressed to it, the open issues it is party to and the last k messages, never the whole room.

### 2. Hierarchy decides authority, not who may speak (Proposal, on ADR 0003 §2)

| Inside (hidden) | In the room | Authority |
|---|---|---|
| Representative | Opens the Work, assigns members, reports the outcome to the owner | Assigns members to a Work |
| Member (department head) | Speaks; proposes, challenges and answers as a peer of other members | Directs its own team only |
| Team lead (per Work) | The board keeper keeps the board; every team lead splits and replans its own subtree | Changes the plan of its member's part; never resolves an issue raised against it |
| Workers | Run one task each; report to their team lead | Their task's effects, within assigned permissions |

- Members challenge each other as equals. A member cannot assign tasks to another member's team; it can only challenge or send a `change_request`.
- Titles stay hidden on the surface (ADR 0003 §1).
- No agent approves another agent's outside effect, and no agent accepts a result (section 7).

### 3. Challenge protocol (Owner: mutual challenge; Proposal: rules)

1. **Challenger.** Each room has one designated challenger: a member, or a worker outside the producing team when only one member takes part. The host picks it from a different model group than the producer when one exists, and from a different family when possible. Same-model challenge is allowed when nothing else is available, by analogy with ADR 0003 §7, and is recorded as such. A challenge is not a check: it is never a verdict and does not count toward the family relation of any check. The challenger and the checking seat are distinct identities.
2. **What the challenger sees.** The artifact, the criteria and the board, not the producer's rationale messages. A challenger never challenges its own or its team's output; those go to a second challenger or straight to the checking seat.
3. **When.** The mandatory challenge applies once per Work, to the version first offered for checking. Later versions and other proposals get optional challenges only; moment 2 may require one but never skip one.
4. **Grounds.** A `challenge` names a specific defect and its evidence. The host checks every cited quote and reference first: each quote must exist verbatim in the current artifact version, after Unicode NFC and whitespace collapsing (the same rule applies to verifier quotes). A challenge that fails any check, or has no grounds, is returned to its author. Moment 3 runs only on challenges that pass and can only return them, never admit them.
5. **Issues.** Each admitted challenge opens an issue. At most 3 issues may be open at once and at most 8 over the Work; a challenge past either limit is refused.
6. **Replies.** The challenged party answers with `answer` and counter-evidence, accepts as a `change_request` it then carries out, or escalates. Challenge and reply are one round; at most 2 rounds per issue, then the issue is escalated.
7. **Resolution.** An issue is resolved only by its opener withdrawing it with a stated reason, by a host deterministic check of the cited evidence, or by escalation. The challenged side and its team lead cannot resolve it. **Escalated** means handed to the checking seat with the issue attached as an open criterion note; the room stops arguing it.
8. **Sycophancy flag.** A position change counts as evidence-backed if its message cites an evidence reference not previously cited on that issue, or a quote-checked challenge on that issue (the challenge is the new evidence for the position it challenges). Otherwise the host flags it and the issue stays open (after Free-MAD and Wynn et al.). The discriminator may only add flags, never remove a host flag.
9. **No confused deputy.** An effect whose task traces back to another agent's message is checked against the intersection of the requester's and the performer's permissions. If it is an ADR 0002 §5 kind, the owner decides it. Message text never adds a permission; delegated tasks carry the Work's grants.

### 4. Interruption (Owner: owner first; Proposal: rest)

- **Owner:** may write, pause or stop at any time. Owner messages go first. Stop is immediate; effects already made are not undone. An effect in flight at a stop, preemption or cap is recorded unknown and never resent (ADR 0002 §8, §12).
- **Members and workers:** cannot preempt another speaker. They interrupt only by posting a `challenge` or `change_request` addressed to someone, which the addressee handles after its current turn.
- **Host:** preempts on a hard cap, budget, deadline, host drain or policy gate.

### 5. Turn selection and termination (Proposal)

**Turns.** After every turn the host decides the next speaker in one place (as in AutoGen's selector group chat):

- Host-computed candidates: the addressee of the last message, parties to open issues, the challenger after a version first offered for checking, and assignees of ready tasks.
- The same speaker does not speak twice in a row unless it is the only candidate.
- The discriminator orders the candidates (section 6, moment 1). The fallback order is addressee, open-issue party, challenger, board keeper.
- Before a turn starts the host reserves its estimated tokens and cost and refuses the turn when the remaining budget is smaller. Parallel turns reserve separately.
- Turn selection orders room talk only. Tasks with nothing blocking them still run in parallel (ADR 0003 §2).

**Counters.** Room counters belong to the root Work and include every delegated subtree. A replan, a new issue and an owner pause never reset them. A Work opened during a room never inherits or resets its counters.

**Termination.** Both kinds are required:

- **Content end:** every board task is settled, every issue is resolved or escalated, and the checking seat has judged the latest version.
- **Hard caps**, any one of which closes the room: 25 counted messages; 4 artifact versions; 2 rounds per issue; the issue limits; the Work's budgets; a stall counter of 3.
- **Stall.** A turn window with no board change. Only settling a task or issue for the first time, or a new artifact version, is a board change. Reopening, or opening and closing in the same window, is not. A version whose content hash equals any earlier version of the Work is a stall. At the first stall cap the board keeper replans once; the second closes the room.
- **On any hard cap** the room closes and the latest published version goes to the checking seat if budget remains. Otherwise the result is shown as "This result was not checked." (ADR 0002 §8).

### 6. The discriminator moderates between turns (Owner: role and slot; Proposal: questions and numbers)

The discriminator is the room's moderator. It never writes a message. At fixed moments the host sends it a typed question about host-assembled state and gets back probabilities and a confidence.

**Stricter only.** A discriminator output can only make the outcome stricter than the fixed rules: add a challenge, a stall, a sycophancy flag or return a challenge. It never removes a challenge, a stall, a flag or a card the fixed rules produce. Moment 1 only orders host-computed candidates and never changes a cap.

| # | Moment | Question (kind) | Applied when above threshold | Otherwise |
|---|---|---|---|---|
| 1 | Next speaker | Which candidate should speak now? (`choice` over host candidates) | Give that candidate the turn | Fixed order in section 5 |
| 2 | Challenge worth it | Does this version have a defect a reviewer can name with evidence? (`noul`) | Yes: require an optional challenge | Fixed rules |
| 3 | Real grounds | Does this host-passed challenge name a specific defect? (`noul`) | No: return it for rewrite | Admit it |
| 4 | Position change | Evidence, agreement or unclear? (`choice`) | Agreement: add a sycophancy flag | Host flag rule only |
| 5 | Stall | Did the last turns add evidence, a change or a resolved issue? (`noul`) | No: count a stall. Yes: no extra stall; the deterministic rule still applies | Deterministic rule |
| 6 | Owner note | Does this need the owner's judgment? (`noul`) | Attach a note to an exception card that the fixed rules already create; never a new card kind | Nothing |

**Input.** Agent text reaches the discriminator only as quoted, length-bounded fields, each marked with its author, in the original language and never machine-translated. Where a host feature answers the question (board deltas, issue states, quote-check results, ordinals), it is sent instead of text. Moments 1 and 5 use host features only unless the measurement shows text improves them. A hosted discriminator follows the same data rules as other hosted models in model groups; the state sent is the host-assembled minimum for that moment.

**Output and record.** The model output is `{kind, options, distribution, confidence}`: exact keys, `options` equal to those sent, probabilities in [0, 1] summing to 1 within a host tolerance, no text field. Anything else is invalid. The host commits one record before applying it: `questionId = (workId, turnOrdinal, moment, questionVersion)`, the input hash (board revision and included message ordinals), model, threshold version, raw output, latency, host decision (`applied`, `below-threshold`, `invalid`, `timeout`) and host time.

**Replay.** Replay and restore read the recorded decision and never call the model again. Turn selection and stall counting are pure functions of the board revision and committed records. If a crash falls between call and commit, the host may ask again under the same `questionId`; only the first committed record counts. The discriminator has no outside effect, so this is not an effect replay under ADR 0001. An agent turn in flight at a crash is not replayed; it is recorded as an interrupted turn and counts toward the message cap.

**Bounds.** Each call has a host timeout (2 s), recorded as `timeout`. The host never retries within a turn. After 3 failures in a Work, the Work runs on fixed rules for the rest of its life, and one record says so. Discriminator calls, tokens and cost count toward the Work budget, with their own cap of 60 calls per Work.

**Thresholds and calibration.** Thresholds are host constants pinned per Work, never an owner setting. Each is set per moment and per language from a held-out calibration set so that precision on the applied side is at least T; expected calibration error is reported per moment and language. A moment whose calibration cannot be measured stays on fixed rules. Changing the moment 3 or moment 6 threshold is the second kind of decision in ADR 0002 §5; the others are versioned host defaults. Until a moment passes, the discriminator runs in shadow mode for it: recorded, never applied.

**Korean.** Evaluation sets include Korean, English and mixed room text, with at least N labeled items per moment and language, and injected text that tries to steer the answer. A moment is enabled per language, and only if injection changes its accuracy by no more than X. Below threshold in Korean, Korean rooms use fixed rules for that moment even if English passes.

**Never a check.** A discriminator output is never a verdict, an evaluation or an acceptance, and does not count toward the family relation of any check.

**Model group (Proposal).** The discriminator comes from a model group whose role is `discriminator` (ADR 0003 §3): hosted Jev, local open-weight decision models or owner-fine-tuned models. The host picks inside the group by availability, budget and family, and records which model answered. Editing this group is an ordinary owner setting, because it never checks.

**Owner-specific fine-tuning (Proposal).** A discriminator tuned on the owner's decisions is a Growth candidate. Training data includes only owner decisions on items raised by a fixed rule, not by moment 6, and each item records the agent messages the owner saw, so agent-steered items can be excluded. It is adopted only after a held-out comparison with the current discriminator, judged by a host evaluator or a different-family model; a same-family judgment never supports adoption (ADR 0003 §7). Adoption is listed with revert.

**Evaluation before default (Proposal).** Four arms on the same held-out Work set at equal cost: (A) today's executor → verifier line with the extra budget spent on verify-and-retry rounds; (B) majority vote over repeated producer runs; (C) rooms on fixed rules; (D) rooms with the discriminator. Rooms stay on only if C beats A and B. The discriminator is enabled per moment only if D beats C for that moment, and only if it also beats a general model asked the same typed question with output constrained to one option token and probabilities read from logprobs, at equal cost. Measures: first-check pass rate, later revert rate, messages and tokens per accepted Work, flips from right to wrong, owner cards. Thresholds, metrics and the minimum number of Works are fixed before the run. Challenge precision (the share of challenges that led to a change the checking seat later confirmed) is recorded per challenger seat.

### 7. What stays with the host (Proposal)

Neither agents nor the discriminator hold these:

1. Hard caps: messages, versions, rounds, issues, budgets, the stall counter.
2. Owner pause and stop.
3. Approval of outside effects. Agents cannot approve each other; ADR 0002 §5 decisions stay with the owner.
4. Permissions per identity, from the hierarchy and roles (section 3.9).
5. Write leases on shared artifacts. Only the lease holder writes the next version. A lease is bound to a run ID. It is released when a version is committed, or when the run expires, drains or is stopped with no write in flight. A write in flight at that point marks the lease unknown and blocks further writes until it is reconciled read-only.
6. Provenance. Agent-written text is marked with its author and is never owner input, a grant or a task input by itself (ADR 0002 invariant 6).
7. Journal persistence. Every room message, direct message and discriminator record is a Work event that survives restart (section 6, Replay).
8. Final acceptance by the existing checking seat: verdict bound to the artifact hash and criteria, quotes checked against the artifact text, family relation recorded. The producer set of a version is every model whose message was accepted into it: lease holders and authors of carried-out `change_request`s. The family relation is computed against that whole set. The checking seat holds no room assignment, sends no room messages, and receives only the artifact version, criteria, escalated issue notes and execution evidence, as at `src/configured-runtime.ts:212`.
9. Unknown outcomes. A task with an effect whose outcome is unknown is blocked until reconciled. Replan, `change_request` and a new artifact version never re-issue it (ADR 0002 §8, §12).

### 8. What the owner sees (Proposal)

- The room shows the Representative's and members' messages under their names. Team-lead and worker messages are folded under their member's name, with a role chip where ADR 0003 already shows one.
- Challenges and replies show as they are. Seeing members disagree is the point.
- Direct messages show as one "A → B" line that opens the text.
- The discriminator has no name and no line on the surface. Its records sit in the full log under "How it was done".
- Only the cards of ADR 0002 §8 reach the owner: a §5 decision card, an unknown outcome, or "This result was not checked." Exception cards from one Work are combined into one. Normal talk, escalated issues included, stays quiet.

### 9. Mapping onto today's domain (Proposal; not implemented)

| Need | Today | Change needed |
|---|---|---|
| Agent room messages | `append-work-message`, owner only, `role: 'owner'` | New `append-room-message {workId, messageId, kind, replyTo, to?, issueId?, evidence[], text}`. Actor must hold a room assignment. Stored with an agent role. The owner command stays unchanged |
| Issues | None | `open-issue`, `answer-issue`, `resolve-issue` (opener or host only), `escalate-issue`. The transitions refuse a third round and the issue limits |
| Caps and stalls | One output-token budget and a run deadline | Room counters in the root Work; turn reservations; transitions refuse past a cap; stall counter updated by the host actor only. Time and cost budgets per Work are new |
| Board tasks | `delegate` by the Representative, `parentId` tree | Allow a team lead's host actor to delegate under its member's subtree; same task tree |
| Roles | Organization responsibilities exactly executor and verifier (ORG-01) | Widen the organization version to members, team lead, workers and challenger (already required by ADR 0003). The checking seat stays a separate identity |
| Artifact writes | `publish-artifact`, executor only, version must advance | `claim-artifact-lease` and `release-artifact-lease` bound to a version and a run ID; widen the `publish-artifact` role check to the lease holder; record each version's producer set |
| Discriminator | None | `record-moderation` by a host actor with the record fields in section 6; a `discriminator` model-group role |
| Owner cards | `ask-work-question`, owner only and before start | None new. Existing decision and exception cards through the policy gate; the owner's answer is an owner room message |
| Acceptance | `verify` then `accept` | Unchanged, plus the producer set in the family relation |

## Invariants at the boundaries

1. ADR 0001 is unchanged. Rooms, messages, issues and discriminator records are product-owned Work state, committed atomically with the journal.
2. No agent message is owner input, a permission or an effect receipt.
3. No agent and no discriminator output accepts a result or approves an outside effect.
4. Every hard cap is enforced by a host transition, not by an agent's or the discriminator's choice.
5. A discriminator output that is invalid, timed out or below threshold changes nothing beyond what the fixed rules do.
6. Owner stop and pause take effect regardless of room state.
7. A task with an effect whose outcome is unknown is blocked until reconciled. Replan, `change_request` and a new artifact version never re-issue it. An effect in flight at a stop, preemption or cap is recorded unknown and never resent.
8. A discriminator output only makes the outcome stricter than the fixed rules; it never removes a challenge, stall, flag or card.

## What is not decided

- Values of T, N, X and k, the stall window size, and the challenge-precision level below which a challenger seat is replaced.
- The default discriminator. It waits for the measurement in section 6, Korean accuracy included.
- Where owner fine-tuning runs (owner's machine or a cloud service), what data leaves the machine, and the training data retention rule.
- Whether the discriminator should also check the Representative's direct-answer-or-Work choice, which ADR 0003 §6 left open.
- Whether the discriminator must come from a different family than the room's producers.
- How the owner is told that a room ran on one family, as in ADR 0003 §7.

## Alternatives and replacement criteria

- **Free debate until consensus.** Rejected. Conformity turns right answers wrong and talk does not end on its own (Wynn et al.). Revisit if measured flips from right to wrong are no higher than in the challenge protocol.
- **Keep the fixed executor → verifier line only.** Kept for single-step Work, as arm A, and as the final check. Revisit rooms if C does not beat A and B; then rooms stay off by default.
- **A general model with constrained one-token output.** The real cheaper alternative to a decision model; it is a required baseline in section 6. An LLM moderator that writes reasons is not chosen: its output must be parsed again and costs a generation per turn.
- **Let the discriminator decide directly.** Rejected. Thresholds and fallbacks stay in host code so a wrong or unavailable model cannot widen what happens.

## Changes to ADR 0002 and ADR 0003

- **ADR 0002 §9.** "Messages between members have an internal cap, invisible to the owner" now reads: the cap is internal and invisible; the messages themselves are visible in the room (section 8).
- **ADR 0003 §2.** The Work room's "messages between participants" are the typed messages, board and direct messages of section 1. The board keeper keeps the board.
- **ADR 0003 §3.** Model groups gain the role `discriminator`.
- **ADR 0003 Consequences.** The open "member-to-member message cap" is answered by section 5.

ADR 0002 §8 is not amended: rooms add no new card kind.

## Consequences

- Rooms need the widened organization version (ADR 0003 consequences) and members' Work path (ADR 0003 implementation step 7) first.
- Order after that: (1) room messages, issues and caps on fixed rules only; (2) challenger selection and quote-checked grounds; (3) the `discriminator` model group in shadow mode; (4) the measurement in section 6; (5) the discriminator applied per moment and language where it passed.
- Each room costs more model calls than the fixed line. Reservations, budgets and caps bound it; the equal-cost comparison decides whether it stays on.

Revisit this ADR when rooms fail the equal-cost baselines, when Korean accuracy cannot reach the thresholds, or when sycophancy flags do not lower right-to-wrong flips. Record the evidence and the replacement.

## Evidence

Research notes of 2026-11-06/07 (owner-private scratchpad). Sources:

- Grok Bot: [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot), [Designing Grok Bot](https://x.ai/news/designing-grok-bot), [Team bots](https://x.ai/news/team-bots), [Chat and collaboration docs](https://docs.x.ai/grok-bot/chat-and-collaboration). Unverified third-party reports: [ando.so](https://www.ando.so/blog/running-multiple-grok-bots-across-a-team), [readmultiplex](https://readmultiplex.com/grokbot-rocks/).
- Earlier designs (local archive): `pi-dev/massion/docs/product/2026-07-10-complete-product-design.md` §5.2; `pi-dev/docs/plans/2026-04-01-jabtang-go-aggressive-automation.md`; `pi-dev/docs/plans/2026-03-27-jabtang-organization-model-reframing.md`.
- Debate: Khan et al. 2024, [Debating with more persuasive LLMs leads to more truthful answers](https://arxiv.org/abs/2402.06782); Du et al., [Improving factuality and reasoning through multiagent debate](https://arxiv.org/abs/2305.14325); Wynn, Satija, Hadfield 2025, [Talk isn't always cheap](https://arxiv.org/abs/2509.05396); Cui et al. 2025, [Free-MAD](https://arxiv.org/abs/2509.11035); Choi, Zhu, Li 2025, [Debate or vote](https://arxiv.org/abs/2508.17536).
- Orchestration: [AutoGen selector group chat](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html); Magentic-One stall counter and replanning, [arXiv 2411.04468](https://arxiv.org/abs/2411.04468) (exact threshold not re-checked); [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams).
- Discriminator: [TypeSafe, Introducing System One models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev); [TypeSafe docs](https://docs.typesafe.ai) (English-first accuracy and weakness on numbers, dates and adversarial input are from the docs as quoted by opencodex, not re-checked); [Simon Willison](https://simonwillison.net/2026/Sep/21/jev/); [Google Codelab](https://codelabs.developers.google.com/codelabs/discriminative-models?hl=ko) (thresholds applied in plain code); JEV-as-a-Judge, [arXiv 2609.26550](https://arxiv.org/abs/2609.26550) (confidence cascade); LLM-as-Jev, [arXiv 2610.02076](https://arxiv.org/html/2610.02076v2) (open LLMs as decision models, LoRA cautions); open-weight list, [Hugging Face collection](https://huggingface.co/collections/Ferr0/open-jev-typed-decision-models) (self-reported accuracy). Vendor speed, cost and calibration claims are unverified. No product or paper on per-owner fine-tuned decision models was found.
