# Browser runtime (R-B): ephemeral image boundary

The lead replaced the attempted clean-image guarantee with a non-persistence rule. CSS-drawn values can survive DOM masking, so page images are memory-only live presentation. The journal, Record/artifact and portable backup retain only sanitized structural observations, SHA-256 image hashes and read telemetry. Durable validation refuses screenshot payloads.

## Lifetime and presentation

Images enter a bounded in-memory map only after a confirmed observation commit and an authoritative active-Work check. Storage writes invalidate them before leaving active or changing inputs; completion/uncertain write notification, runtime deadline, feed change, host drain and restart also discard them. A replay does not recapture. Live queries alone merge images into their no-store response; the client never persists them and clears its view on disconnect, navigation or state change.

B15 uses live images while active. B4 payment approval is `waiting`, so it uses sanitized structural text/fields with the domain-only pill. Ended/restarted Work likewise displays structure without an image. B7 page-read activity and R-A named steps remain.

## Verification

- 122 related tests passed plus typecheck; an additional HTTP close/restart test also passed: capture/settle/artifact/acceptance/Record/backup, restart/replay, state/input/feed changes, deadline/drain, tampered image-bearing backup refusal, client clearing and evidence exclusion.
- A PNG carrying a private sentinel is tested against every serialized journal, Record, backup and decoded artifact blob: no image bytes, base64 or sentinel survive; its hash remains.
- The actual CSS primitive fixture still produces different image bytes for different private codes, proving the original counterexample remains real. Live display works, but settle/backup/restart drop the pixels: [in-memory proof](ephemeral-report.json). No PNG is written by that capture path.
- 14 headless interaction states verify active images, waiting structural content, domain pills, tabs, mobile bounds and B7 telemetry. Evidence captures hide the page-image element before screenshotting; only boolean/hash/geometry results and image-excluded app screenshots are retained. Previously checked-in reference/capture PNGs were removed.
- The six affected screen/theme captures have no new, stale or infrastructure diagnostics: [scoped gate](ephemeral-gate.json). Full tests, durable-store integration and all 150 screen/theme contracts remain CI gates on the final head. No contract exception is added for retaining private images.

## Limits

The live owner-visible image may contain CSS-drawn secrets; it is not certified clean. This is precisely why its bytes are absent from every persistence/evidence path. Only fixtures and loopback sites were used; no live third-party site, payment or model call occurred. The optional real adapter remains off by default. No PR merge, tag or release is performed.

## Lifecycle and reflected-format follow-up

Head-specific review reproduced a delayed commit response that could reinsert an image after stop/reactivation, and a narrow-screen navigation path that hid the pane without clearing pixels. Pending captures now carry a one-way invalidation token across the dispatch, and pane-away navigation clears the read and rejects late responses. Both failed before their fixes and pass afterward.

A separate structural privacy finding used invisible format separators inside a reflected code. Matching now removes Unicode format/default-ignorable code points for comparison and maps each match back to original UTF-16 offsets. Five separator classes (including supplementary variation selectors), standalone card/token patterns and a real browser reflection fixture are covered. The 99 affected tests and typecheck pass; no new page PNG is written.

Sensitive metadata now uses NFKC plus format/default-ignorable removal before both sensitive and benign classification. The fullwidth/invisible-separator label, name and autocomplete matrix failed before and passes after; the actual browser fixture pairs an obfuscated Security code label with benign `name=quantity`. All 50 focused browser/privacy tests and typecheck pass, along with the memory-only PNG and CSS-primitive persistence proofs.

The final reflection correction applies NFKC to both observed text and sensitive needles. Grapheme-based source start/end maps cover fullwidth digits in either direction, decomposed accents and compatibility ligature expansion without corrupting adjacent emoji/text. All four durable-journal regressions failed before and pass after; the actual browser fixture adds a fullwidth reflection above the controls. The 54 focused tests, typecheck and memory-only capture proofs pass; reference-page metadata/image hashes are unchanged.

The final default-deny tightening requires every nonempty semantic signal to be explicitly benign; unknown labels/names/autocomplete no longer borrow a benign `quantity` exemption. Stored unmasked fields must also carry a benign label. Unicode decimal digit scripts and bounded numeric grouping/phone punctuation are normalized with source offsets preserved. The reported unknown-label, grouped-code and digit-script cases failed before and pass after; Arabic/Devanagari digits, minus/group separators and an international phone case are covered. All 85 affected tests, typecheck and the actual grouped/Arabic reflection capture pass. Reference page hashes remain unchanged.

Recovery-code grouping now uses the same bounded punctuation/symbol matching as numeric values, while a parallel literal pass preserves punctuation-only passwords. Grouped recovery codes, underscores, slash/symbol separators and mixed-script values failed before and pass after; the real browser fixture includes an independent grouped recovery code. Standalone card/API-key text also handles formatted digits and spaced labels without relying on an input field. All 93 affected tests, typecheck and memory-only capture proofs pass; reference-page hashes remain unchanged.
