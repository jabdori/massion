# Real-model smoke

Status: passed; stage: complete.
Started: 2026-11-09T16:06:19.668Z; duration: 22771 ms.
Calls: 4/8; cap reached: false.
Model identities: requested, not independently attested. CLI transport/stream retries are disabled; the cap counts single-shot CLI invocations. Upstream service-internal attempts are not observable.

| Call | Role | Model | Input tokens | Output tokens | Duration ms | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | representative | gpt-6.1-terra | 18451 | 13 | 4193 | completed (bounded_text_completion; no diagnostic) |
| 2 | representative | gpt-6.1-terra | 18488 | 48 | 4448 | completed (bounded_text_completion; no diagnostic) |
| 3 | executor | gpt-6.1-terra | 18550 | 7 | 3946 | completed (bounded_text_completion; no diagnostic) |
| 4 | checker | zai/glm-5.3 | 19949 | 172 | 7993 | completed (bounded_text_completion; no diagnostic) |

Direct answer: true.
Verdicts: passed / different-family.
Readback: 7f2f0b973e7609b76cc531fa80b6cc710ede65779dd311637f5698cd6db8153f (8 bytes).
Unknown outcomes: none.
Host drain: drained.
