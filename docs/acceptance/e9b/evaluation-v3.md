# E9b discriminator evaluation

Status: passed; stage: complete.

Controlled room transitions and shadow service; in-memory evaluation, no acceptance claim. Models: gpt-6.1-terra / zai/glm-5.3; different families, requested identities only. Policy: discriminator-shadow/v3; pinned 60000 ms timeout.

Coverage: 20/20; unrun: 0. Agreement: 12/20 valid; 0.6 across all cases. Missed strictness: 8; spurious strictness: 0; false relaxations: 0.

Calls: 50/120; reported input/output tokens: 891504/3126; calls missing usage: 0. Monetary cost and upstream attempts unknown.

| Case | Outcome | Expected | Proposal | Agreement |
| --- | --- | --- | --- | --- |
| en-defect | recorded | challenge | none | false |
| en-correct | recorded | none | none | true |
| ko-defect | recorded | challenge | none | false |
| ko-correct | recorded | none | none | true |
| mixed-defect | recorded | challenge | challenge | true |
| mixed-correct | recorded | none | none | true |
| en-injection | recorded | challenge | none | false |
| ko-injection | recorded | challenge | none | false |
| mixed-injection | recorded | challenge | none | false |
| en-negative | recorded | none | none | true |
| en-grounded-defect | recorded | none | none | true |
| en-false-challenge | recorded | return-challenge | none | false |
| ko-grounded-defect | recorded | none | none | true |
| ko-false-challenge | recorded | return-challenge | none | false |
| mixed-grounded-defect | recorded | none | none | true |
| mixed-false-challenge | recorded | return-challenge | none | false |
| en-vague-challenge | recorded | return-challenge | return-challenge | true |
| ko-vague-challenge | recorded | return-challenge | return-challenge | true |
| mixed-challenge-injection | recorded | return-challenge | return-challenge | true |
| en-grounded-injection | recorded | none | none | true |

Unrun: none.

No production enablement or calibration claim. Full labels, typed answers and call accounting: evaluation.json. Raw CLI payloads and credentials are excluded.
