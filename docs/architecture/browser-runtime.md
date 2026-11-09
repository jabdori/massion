# Browser session and page snapshots (R-B)

## Ephemeral image boundary (lead decision, 2026-11-10)

A page image cannot be proven free of secrets: CSS geometry can encode a value without text or image resources. Images are therefore live presentation only. They are captured through CDP into process memory, never a screenshot file. A running Work may show them in its browser pane; images are never part of a command, journal, Record, artifact, portable backup, log, client persistent storage or acceptance/E2E evidence.

Only sanitized structural observations, SHA-256 image hashes and page-read telemetry persist. Every field is masked unless its meaning is explicitly benign, with sensitive label/name/autocomplete markers overriding that allowance. All associated and accessible labels participate. Addresses exclude credentials, query and fragment. Bounds, idempotency, current-feed/revision/input checks and drain admission remain enforced. Durable validation rejects image-bearing observations rather than accepting a legacy pixel payload.

The browser service owns a bounded in-memory image map, keyed by feed, Mission, Work and read identity. Images enter only after a confirmed observation commit and a fresh active-state check. Storage write invalidation drops images before a Work leaves execution `active`, changes inputs or is replaced; runtime deadlines, host drain and restart also drop them. A store without lifecycle notifications cannot retain images. Reads recheck authoritative state. Restart/replay cannot regenerate a screenshot as a side effect.

Only the live browser query merges the transient image into its response; responses use no-store headers. Other mission, Record, artifact and backup paths see structural data and hashes only. The pane clears its memory/DOM on authoritative state changes, disconnect, deadline or navigation. Inactive/restarted Work shows only sanitized structural metadata. In particular, B4 payment approval is `waiting`, so it uses the structural view; only actively executing B15 displays a live image.

The page pane keeps one tab strip and a domain-only pill, and B7 keeps page counts without replacing R-A named steps. Reference HTML/CSS is local and reproducible, but captured page PNGs are no longer assets or evidence. Test fixtures generate live images only in memory; evidence screenshots exclude the image element while assertions still inspect the live rendering.

## Verification

Exercise capture, active read, settle, acceptance/Record, artifact, portable backup and restart. Search serialized journal/backup/Record/artifact bytes for the image bytes/base64 and a CSS-drawn sentinel: none may persist, only the hash. Assert inactive/deadline/drain/feed-change paths cannot return images and reactivation cannot revive them. Verify live rendering headlessly without saving page pixels, then run related tests/typecheck and the extra authorized CI/Codex loop. No real site, payment, submission, tag or PR merge.

The optional real adapter still requires exact HTTPS origins and a fresh script-disabled headless session. Existing DOM masking and paint suppression are defense in depth, not a confidentiality proof. The live owner-visible image can contain CSS-drawn secrets; non-persistence is the enforced boundary.
