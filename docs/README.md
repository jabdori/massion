# Massion documentation

[English](README.md) | [한국어](README.ko.md)

This page defines the role of each public document and the shared product terminology. Code and runtime behavior determine what a particular commit does. Only evidence tied to a date and candidate SHA can support a release claim.

## Where to look

| Question | Document | Responsibility |
|---|---|---|
| What is Massion building? | [`README.md`](../README.md) | Public introduction and pre-release boundary |
| Why does it exist and what must not change? | [`product/constitution.md`](product/constitution.md) | Product purpose and invariants |
| How are system responsibilities divided? | [`architecture/README.md`](architecture/README.md) | Components, data flow, and trust boundaries |
| What experience should the desktop provide? | [`../apps/desktop/DESIGN.md`](../apps/desktop/DESIGN.md) | Visual and interaction language |
| How do I perform an operational task? | [`operations/`](operations/) | Problem-oriented procedures |
| Why was a specific decision made? | ADRs in [`architecture/`](architecture/) and [`superpowers/specs/`](superpowers/specs/) | Decisions and design intent |
| In what order was work attempted? | [`superpowers/plans/`](superpowers/plans/) and [`phases/`](phases/) | Dated plans and retrospectives |
| What was actually verified? | [`evidence/`](evidence/) | Results tied to a date, candidate SHA, and command |

## Status language

- Architecture documents describe responsibility, relationships, and forbidden crossings. They do not use “implemented,” “complete,” or fixed test counts as a status board.
- Product documents define goals and invariants. Product purpose is not reduced to match the current source tree.
- Designs and plans preserve intent and sequence at the time they were written. Old checkboxes and phase statements are not current status.
- Evidence records an execution date, candidate SHA, exact command, and result. It cannot be reused as release proof for another commit.
- “Completed” is reserved for the domain state of Work that passed independent Assurance, or for verification explicitly tied to a candidate SHA.

## Shared terminology

| Meaning | Term | Definition |
|---|---|---|
| A persistent unit delegated by a user | Work | Source of truth for request, execution, decisions, artifacts, and state |
| Quality judgment independent from execution | Assurance | Verification that permits or blocks completion |
| Persistent decisions and outcomes | Records | WorkRecord, ADR, change, and operations records |
| Versioned change based on verified experience | Growth | Suggestion, evaluation, adoption, effect, and rollback |
| Code and document relationships from a Workspace | Knowledge | Indexes, search, relationships, and citations |
| External model and account boundary | Provider | Codex, OpenAI-compatible APIs, local models, and similar sources |
| Agent reasoning and tool execution layer | Runtime | Provider calls, resume, cancellation, and usage |
| Data used to demonstrate product states | Fixture | Render input that is neither user data nor release evidence |

Use the human meaning before an internal identifier. A document may use the English term directly after defining it once.

## Language policy

Public canonical documents are written in English, with a Korean companion using the `.ko.md` suffix. Each pair links to the other at the top. New public documentation follows the same convention.

Dated plans, phase records, and evidence retain their original language to preserve history. They are translated only when an active consumer requires it; the translation must not rewrite the recorded claim.

## Historical records

Do not bulk-rewrite `docs/phases/`, `docs/superpowers/plans/`, or `docs/evidence/` into present tense. They preserve decisions, failures, and verification from their recorded time. When they conflict with current documentation, consult the product constitution, architecture, source code, and the latest evidence tied to the relevant SHA.
