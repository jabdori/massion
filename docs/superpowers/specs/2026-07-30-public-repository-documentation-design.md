# Public Repository Documentation Consistency Design

[English](2026-07-30-public-repository-documentation-design.md) | [한국어](2026-07-30-public-repository-documentation-design.ko.md)

> Source baseline: `51a39660f1b6a00a1f79027a4f39a6b0e5061394`
> Audience: people visiting or contributing to Massion for the first time

## Purpose

The public repository must immediately identify Massion as an actively developed pre-release AgentOS. Product intent, architecture, historical plans, and verification evidence have separate responsibilities so that an architectural statement or old test count cannot be mistaken for current release status.

## Documentation contract

- Public canonical documents are English files. Korean companions use `.ko.md` beside them, and each pair links to the other.
- The repository README owns the product introduction and public release boundary.
- The product constitution owns purpose and invariants.
- Architecture owns components, responsibility, data flow, and trust boundaries—not implementation status.
- Dated designs and plans preserve their original intent and sequence.
- Evidence owns results tied to a date, candidate SHA, and exact command.

Architecture and product documents do not use “implemented,” “complete,” or fixed test counts as a status board. “Completed” remains valid as a Work domain state after independent Assurance.

## Shared terms

Work is the persistent unit of delegation. Assurance is quality judgment independent from execution. Records preserve decisions and outcomes. Growth is versioned improvement based on evidence and effect measurement. Knowledge represents Workspace sources and relationships. Provider is the external model and account boundary. Runtime performs agent reasoning and tool execution. Fixture data demonstrates product states without becoming user data or release evidence.

## README images

Render the browser fixture from the source baseline at 1440×900 and capture:

1. the Work collaboration surface; and
2. the Organization surface showing persistent and temporary responsibility;
3. the Knowledge surface connecting Work, files, and documents; and
4. the Growth surface showing evidence, counter-evidence, adoption, and rollback.

Store both images under `docs/assets/readme/`. Their caption must identify them as fixture renders, not evidence of a real Provider run or public release. Do not expose secrets, personal paths, or account identifiers.

## Scope and preservation

This change covers the repository entry points, documentation map, architecture overview, product constitution, desktop documentation, README images, and MIT license declaration. Dated phase records and evidence remain historical records and are not bulk-rewritten.

## Acceptance criteria

- The README immediately states that no stable public build exists.
- Public canonical documents are English and have linked `.ko.md` companions.
- Architecture diagrams communicate responsibility and flow without implementation-status colors.
- All four README images resolve through relative GitHub Markdown paths.
- The root contains the standard MIT license text, and README links to it without duplicating rights guidance.
- Modified Markdown passes Prettier and `git diff --check`.
