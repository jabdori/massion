# Static validation follow-up — 2026-10-03

The compiler gate is now implemented and executed, rather than inferred from Node's type stripping.

- Official npm packages pinned in the lockfile: TypeScript **7.0.2**, `@types/node` **24.19.1**.
- Local installation only, with dependency lifecycle scripts disabled.
- `npm run typecheck`: passes with strict checking, `noUncheckedIndexedAccess`, explicit Node types and no emit.
- `npm run check`: static types and runtime syntax pass; **86 tests pass, 6 actual-store tests skip** without an opted-in database.
- Full disposable SurrealDB aggregate with crash/restore: **92 pass, 0 fail, 0 skip**.

The first real compiler run found an overly broad domain-artifact type at the controlled execution boundary and insufficient array narrowing in tests. The boundary now validates/narrows code/document fixture artifacts before invoking fixture checks; tests make their existence assumptions explicit. No compiler strictness was disabled.

CI now installs the pinned lockfile using `npm ci --ignore-scripts --no-audit --no-fund` and runs the type gate before the runtime suite. This does not turn JavaScript/DOM harness results into real browser evidence, establish live provider execution, or close the product's other integration gates.
