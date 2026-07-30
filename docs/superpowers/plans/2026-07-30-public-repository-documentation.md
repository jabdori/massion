# Public Repository Documentation Consistency Plan

[English](2026-07-30-public-repository-documentation.md) | [한국어](2026-07-30-public-repository-documentation.ko.md)

> Source baseline: `51a39660f1b6a00a1f79027a4f39a6b0e5061394`

## Goal

Present Massion accurately as a pre-release AgentOS through English canonical documentation with Korean companions. Separate product intent, architecture responsibility, historical records, and candidate-bound verification evidence.

## Work sequence

1. Define documentation ownership, language policy, and shared terminology in `docs/README.md` and `docs/README.ko.md`.
2. Rewrite the public README pair around product value and the current release boundary; remove fixed test counts and rights guidance.
3. Rewrite the architecture overview and desktop documents around responsibility, flow, and trust boundaries.
4. Preserve dated history while adding English/Korean pairs only for the current public documents changed by this work.
5. Render Work, Organization, Knowledge, and Growth fixture screens at 1440×900 into `docs/assets/readme/`.
6. Add the standard MIT license text, declare `MIT` in `package.json`, and link the license from both READMEs.
7. Format the changed documents, validate links and images, inspect the rendered screenshots, and run repository documentation checks.
8. Commit the verified documentation snapshot, fast-forward `main`, and push `origin/main` without touching ongoing uncommitted feature work.

## Verification

- No implementation-status legend or fixed test count remains in the public README or architecture overview.
- Every new English/Korean public document pair links in both directions.
- All four README image files exist, decode successfully, and contain no account or secret data.
- Prettier, repository documentation checks, and `git diff --check` pass.
- The final commit contains documentation, images, `LICENSE`, and package license metadata only.
