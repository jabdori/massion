# E9b discriminator evaluation

Status: failed; stage: incomplete.

Controlled room transitions and shadow service; in-memory evaluation, no acceptance claim. Models: gpt-6.1-terra / zai/glm-5.3; different families, requested identities only. Policy: discriminator-shadow/v2; unchanged 2000 ms timeout.

Coverage: 0/20; unrun: 19. Agreement: 0/0 valid; 0 across all cases. Missed strictness: 0; spurious strictness: 0; false relaxations: 0.

Calls: 2/120; reported input/output tokens: 15983/26; calls missing usage: 1. Monetary cost and upstream attempts unknown.

| Case | Outcome | Expected | Proposal | Agreement |
| --- | --- | --- | --- | --- |
| en-defect | timeout | challenge | none | false |

Unrun: en-correct, ko-defect, ko-correct, mixed-defect, mixed-correct, en-injection, ko-injection, mixed-injection, en-negative, en-grounded-defect, en-false-challenge, ko-grounded-defect, ko-false-challenge, mixed-grounded-defect, mixed-false-challenge, en-vague-challenge, ko-vague-challenge, mixed-challenge-injection, en-grounded-injection.

No production enablement or calibration claim. Full labels, typed answers and call accounting: evaluation.json. Raw CLI payloads and credentials are excluded.
