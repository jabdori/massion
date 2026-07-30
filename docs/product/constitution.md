# Massion Product Constitution

[English](constitution.md) | [한국어](constitution.ko.md)

> **Role:** Highest-level source of truth for product identity
> **Audience:** People who design or review the product, architecture, surfaces, and AgentOS
> **Change rule:** Changes to product identity or invariants require user approval and an Architecture Decision Record (ADR).

## 1. Responsibility of this document

This document defines why Massion exists and what the product must preserve. A change in framework, database, UI, or package structure must not silently redefine the product.

Documentation and source code have distinct responsibilities:

1. This constitution owns product purpose, principles, invariants, and boundaries.
2. [`docs/architecture/README.md`](../architecture/README.md) explains system responsibilities and data and trust boundaries.
3. ADRs and dated designs preserve the context and choice behind a decision.
4. Source code defines the behavior of a particular commit.
5. [`docs/evidence/`](../evidence/) records verification tied to a candidate SHA.

When the source does not satisfy this direction, the difference is a product gap. The constitution is not reduced to match current code, and it is not evidence that an absent behavior exists.

## 2. One-sentence definition

Massion is a local AgentOS where a user delegates a mission, agents divide responsibility like an accountable organization, and persistent Work evolves organization, memory, and policy only through user-chosen authority, assurance, and records.

> People direct. The organization takes responsibility. Evidence informs judgment. Records preserve memory. Only verified experience changes the next organization.

## 3. Product sovereignty

The human user is the final authority of the AgentOS. The Representative is the default entry point that receives requests and coordinates the organization; it does not replace human authority.

The user must be able to decide:

- which Work to start or stop;
- which Workspace and files to trust;
- which Provider accounts to connect;
- which actions to automate or review; and
- which Organization, Prompt, Memory, or Policy version to adopt or revert.

## 4. Product invariants

### 4.1 Operate an organization, not a single AI

An agent is not a disposable prompt. It is an organizational member with responsibility and authority. The organization divides work, hands it off, challenges results, and attaches every outcome to one Work lineage.

The durable responsibility language is:

- **Representative:** request intake, coordination, and final response;
- **Context & Strategy:** intent, risk, plan, and completion criteria;
- **Evidence & Research:** code, documents, external evidence, and citations;
- **Governance:** policy, authority, and human decisions;
- **Delivery Coordination:** task decomposition, assignment, and specialist execution;
- **Assurance:** quality judgment independent from execution;
- **Records:** decisions, outcomes, changes, and operational records; and
- **Growth:** suggestion, evaluation, adoption, effect, and rollback.

Department names may change. These responsibilities may not be skipped.

### 4.2 The organization is a versioned operating structure

The organization is not a static chart. It is persistent state that may be created, activated, moved, split, merged, disabled, and recovered according to evidence from real Work.

An organizational change follows this order:

1. Inspect the request and available capabilities.
2. Decide whether the existing organization can handle it.
3. Propose the missing responsibility, team, or specialist.
4. Review impact, authority, and rollback conditions.
5. Apply only an allowed change as a new Organization Version.

Creating more organization is never a goal by itself.

### 4.3 Work and events are the source of truth

Conversation is an interface for requests, collaboration, and intervention. Persistent Work and versioned events are the source of truth for execution and recovery.

Work owns:

- user intent;
- Workspace, context, organization, policy, Prompt, and Memory versions;
- plan, completion criteria, and tasks;
- agents and assignments;
- collaboration rooms and structured messages;
- execution, tool use, artifacts, and usage;
- approvals, decisions, assurance, and records;
- failure, blocking, cancellation, and recovery conditions; and
- causal links into Growth.

The same Work must survive a change in surface or model.

### 4.4 Execution engines reason; Massion owns policy

VoltAgent and Provider SDKs perform inference, tool calls, and execution resume. Massion owns:

- responsibility and authority;
- the binding between requests, Work, and organization;
- requirements for strategy, evidence, approval, and assurance;
- the definition of completion; and
- adoption of memory, organization, and policy changes.

No framework or Provider becomes the public product contract.

### 4.5 Completion is not a model claim

A successful response, an existing artifact, or one passing test is not sufficient. Completion requires:

- explicit completion criteria;
- Assurance separated from the executing actor;
- a judgment that preserves failures and evidence;
- atomic Records finalization; and
- lineage that converges to the same conclusion after restart.

Recoverable conditions, such as exhausted model candidates, remain `blocked` instead of being disguised as success or terminal failure.

### 4.6 Automation and full access begin with a human decision

Normal execution preserves policy, mandatory approval, Workspace boundaries, and audit. Automatic execution reduces interruption within an allowed scope; it does not remove controls.

Full access may use the current OS user's authority only after an explicit warning and user decision. It does not remove schema, revision, checksum, idempotency, completion assurance, Growth effect measurement, or rollback.

Stopping belongs where execution is visible: inside Work. A duplicate global danger switch is not a substitute for immediately stopping the active Work.

### 4.7 Providers do not own product state

Organization, Work, Records, approval, cancellation, and diagnosis remain available in limited mode when model accounts or networks are unavailable. Provider sessions, transcripts, and quotas cannot replace Massion's persistent state.

Model selection occurs within candidates that satisfy capability, data policy, budget, evaluation, and account health. Users manage Provider and budget boundaries rather than manually assembling internal model routes for every Work.

### 4.8 Growth is conservative, evidence-based change

Growth is not a model immediately rewriting itself. It preserves:

- causal Work, Event, and Evidence;
- target and before/after versions;
- independent signals and counter-evidence;
- evaluation and human or policy decision;
- measured effects in later Work; and
- rollback when outcomes regress.

A new version applies only to subsequent Work and never rewrites past lineage.

### 4.9 Separate the authority of knowledge and memory

Knowledge explains code, documents, relationships, and sources in a Workspace. Memory is persistent context explicitly supplied by the user or adopted from verified experience.

- Knowledge is bound to a Repository and IndexVersion.
- Citations point to source revision, file, document, or symbol.
- Personal memory applies to later Work and can be disabled.
- A transient model transcript never becomes organizational fact or permanent memory by itself.

### 4.10 Extensions add capability without taking over the OS

Extensions may contribute tools, skills, integrations, and specialist execution. They do not directly own the Core process, database, or credentials.

Extension execution requires artifact provenance, manifest, permissions, approval, bounded RPC, audit, and lifecycle lineage. Disable, update, and rollback do not rewrite historical Work.

### 4.11 Local first

The first product boundary is a personal macOS arm64 desktop operated by one user on their own Mac. Data and Provider accounts remain within the user's local boundary, and the application window does not own the daemon lifecycle.

Local-first operation does not remove security, recovery, or audit responsibilities. It makes installation, authority, backup and restore, restart, and secret storage explicit product responsibilities.

### 4.12 Organization is not bureaucracy

Simple requests should not be forced through unnecessary meetings, approvals, or documents. Responsibility grows only with risk, uncertainty, impact, and required expertise.

Good organizational operation is measured by whether:

- the user can understand the current state and next action;
- responsibility and decision evidence are traceable;
- failure and restart converge correctly; and
- verified value exceeds coordination cost.

## 5. Product model

| Concept | Meaning |
|---|---|
| Organization | Versioned responsibilities, relationships, authority, and capability |
| Work | Persistent unit from user request through execution, assurance, records, and Growth |
| Collaboration Room | Structured user-agent collaboration bound to one Work |
| Decision | Human or policy judgment over execution, organization, authority, or adoption |
| Artifact | Document, code, patch, or report produced by Work; not proof of completion |
| Assurance | Independent judgment against completion criteria |
| Records | Persistent decisions, assurance, outcomes, and operational change |
| Growth | Versioned suggestion, evaluation, adoption, effect, and rollback |

## 6. Product surfaces

| Surface | Question it must answer |
|---|---|
| Home | What needs attention or a decision now? |
| Work | Where is this Work, and what is it waiting for? |
| Knowledge | What does the organization know about this Workspace, and from which sources? |
| Organization | Who is responsible for what, and how are they related? |
| Growth | What was learned, and what should change? |
| Extensions | Which capabilities can be added to the organization? |
| Providers | Which model supply and accounts are available? |
| Budget | Which model was selected, why, and what did it cost? |
| Settings | Which persistent boundaries did the user choose? |

The global inbox is not another domain. It is an entry point for states that require human attention and opens over the current surface. Surfaces share Application state and Work lineage without duplicating each other's responsibility.

## 7. What Massion is not

- a generic model-selection chat client;
- a launcher that merely starts several agent processes;
- automation that accepts a model's final sentence as completion;
- a central proxy that owns user Provider accounts and data;
- self-modification without evidence and effect measurement; or
- a marketplace that treats installation count as organizational capability.

## 8. Product decision test

A new feature, surface, or architecture must answer yes to these questions:

1. Does it make organizational responsibility clearer?
2. Can the user control the organization and stop execution?
3. Is the result bound to persistent Work and causal lineage?
4. Does it preserve required strategy, evidence, assurance, and records?
5. Does it avoid forcing unnecessary process on simple Work?
6. Can authority be chosen and revoked while preserving available audit and rollback?
7. Does it avoid turning a model, Provider, or framework into product identity?
8. Is learned behavior backed by real evidence and effect measurement?
9. Does an Extension remain below OS Core authority?
10. Does it preserve the distinct AgentOS product instead of collapsing into a generic SaaS screen?

If any answer lacks evidence, revisit the product design before implementation.

## 9. Release acceptance

The first public release must prove one vertical flow on the same candidate SHA:

```text
User Mission
→ Representative creates Work
→ Workspace knowledge and evidence
→ strategy, tasks, and specialist assignment
→ Provider and model selection with budget lineage
→ execution, collaboration, and human decisions
→ independent Assurance and Records
→ Growth suggestion, evaluation, and decision
→ later Work effect or rollback
```

The same candidate must cover limited mode, authentication failure, cancellation, blocking and resume, abnormal restart, Workspace trust, backup and restore, keyboard and screen-reader access, signing, notarization, Gatekeeper, and clean-Mac installation and removal.

Individual screens, fixtures, package tests, and ad hoc builds cannot replace this acceptance flow. Results are judged only by evidence tied to the candidate SHA.

## 10. Lineage

Massion has used several execution foundations while preserving the goal of accountable organizational AI:

- `claude-agent-bootstrap`: demonstrated organization through representatives, departments, and specialists;
- TypeScript Jabtang: expanded persistent organization, Work, approval, memory, and Growth;
- Go and Eino Jabtang-go: separated OS capabilities, organization graph, execution graph, and Runtime Truth; and
- TypeScript and VoltAgent Massion: changed the execution ecosystem while strengthening Work, Assurance, Records, Extensions, and local operation.

This lineage does not require loyalty to a framework. It preserves the principle that people direct, the organization takes responsibility, and only verified experience changes the next organization.
