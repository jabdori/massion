# First real-model smoke

Owner-authorized live evidence only. Run from the checkout with Node 24.19+
(24.x), SurrealDB 3.3.0, local `codex` and an already configured local OpenCodeX
router that can serve both requested models:

```sh
MASSION_SURREAL_BINARY=/absolute/path/to/surreal \
MASSION_SMOKE_ROUTER_URL=http://127.0.0.1:10100/v1 \
  node scripts/smoke-real-model.ts
```

Choose the existing router's actual loopback port. Only an explicit canonical
`http://127.0.0.1:PORT/v1` is accepted. No router setup, account enrollment or
credential search is performed. The smoke uses a transient custom Codex provider
(`smoke`, Responses protocol, no CLI credential binding, transport/stream retries
zero) pointing to that router. The router owns its already-authorized upstream
credentials. User configuration stays ignored; tools stay disabled by the existing
CLI adapter. No secret values enter arguments, reports or logs.

The script starts an owned disposable SurrealDB with the same loopback isolation
flags as `with-surreal.py` / install-smoke, initializes the schema and starts the
real `createWorkbench` host with durable settings and sealed artifacts. The public
v1 protocol configures one live grant/default route and a Representative route:
`gpt-6.1-terra` for Representative/execution and `zai/glm-5.3` for checking, both
through local Codex at low effort. The host-owned family map recognizes `zai/`
as Zhipu, including through Codex; compatible endpoints stay unknown.

One owner question gets a direct answer. A second request asks for a tiny checked
text artifact. The normal conversation path admits and runs Work. Only an accepted
real-provider Record with a different-family check and exact artifact readback
passes. No direct domain writes or invented acceptance.

## Bounds and reports

Eight single-shot CLI invocations maximum, reserved synchronously before dispatch
(normally four). No automatic retries of calls, mutations or unknown outcomes. A
cap or uncertain CLI outcome fences later dispatches. CLI transport/stream retries
are disabled; service-internal attempts behind the local router are not observable.
The adapter checks reported output usage against 2,048 tokens; this is not a
provider-side monetary limit. Reported tokens remain available even for uncertain
outcomes; missing usage stays null. Codex JSONL supplies requested model identity,
not independent model attestation.

Private JSON and Markdown reports under `.runtime/smoke/run-*` checkpoint intent
before each call and retain models, roles, durations, reported tokens, safe failure
categories, verdicts, readback hashes and unknown outcomes. Raw CLI output, stderr,
prompts, environment values and provider error text are never logged or saved.
SIGINT/SIGTERM or the four-minute deadline drains the host and aborts in-flight
CLI work. The owned database is stopped and removed; reports and sealed artifacts
remain. This synthetic smoke is not a quality evaluation or persistent install.

## Verification and evidence

Fixture tests in `tests/smoke-real-model.test.ts` cover concurrent cap enforcement,
unknown fencing, output-cap overflow, usage, durations and private report files.
`tests/family-map.test.ts` covers routed families and unknown prefixes.

On 2026-11-09 (KST), Node 24.21.0, SurrealDB 3.3.0, Codex 0.167.0 and an existing
OpenCodeX 2.81.0 loopback router completed the path: four calls in 21,786 ms,
75,094 reported input tokens, 252 output tokens, a passed different-family verdict,
accepted real-provider Record, exact eight-byte `SMOKE_OK` readback and drained
shutdown. No unknown outcomes. Report: `.runtime/smoke/run-IXh9MM/report.json`
and sibling `report.md` (private, Git-ignored); the PR carries the summary.

Earlier isolated attempts are retained as failures: a rejected built-in retry
configuration and two native-Codex attempts bypassing the router. Their unknown
checker outcomes were never replayed or promoted to acceptance. Each attempt used
a separate disposable database and report directory.
