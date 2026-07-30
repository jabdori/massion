# Massion documentation

[English](README.md) | [한국어](README.ko.md)

This page defines the role of each public document and the shared product terminology. Code and runtime behavior determine what a particular commit does. A release claim requires verification tied to its exact candidate SHA.

## Where to look

| Question | Document | Responsibility |
|---|---|---|
| What is Massion building? | [`README.md`](../README.md) | Public introduction and pre-release boundary |
| Why does it exist and what must not change? | [`product/constitution.md`](product/constitution.md) | Product purpose and invariants |
| How are system responsibilities divided? | [`architecture/README.md`](architecture/README.md) | Components, data flow, and trust boundaries |
| What experience should the desktop provide? | [`../apps/desktop/DESIGN.md`](../apps/desktop/DESIGN.md) | Visual and interaction language |
| How do I perform an operational task? | [`operations/`](operations/) | Problem-oriented procedures |
| Why was a specific decision made? | ADRs in [`architecture/`](architecture/) | Decisions and design intent |

## Status language

- Architecture documents describe responsibility, relationships, and forbidden crossings. They do not use “implemented,” “complete,” or fixed test counts as a status board.
- Product documents define goals and invariants. Product purpose is not reduced to match the current source tree.
- Release verification must record its execution date, candidate SHA, exact command, and result. It cannot be reused for another commit.
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
