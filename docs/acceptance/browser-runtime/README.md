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

Caseless canonicalization now precedes both literal and grouped matching. ASCII recovery-code case changes, German sharp-S expansions, dotted-I composition and Greek sigma forms failed before and pass after with original UTF-16 ranges preserved. The live fixture uses a lowercase private recovery value reflected in uppercase. All 98 affected tests, typecheck and actual memory-only capture proofs pass; reference-page hashes remain unchanged.

## Mainline lifecycle/polish integration

Merged main through PR #130 (member/app/connection/device lifecycle and settings) and #136 (visual polish). Both fixture-producer sets and both exception-removal sets remain. Reconnect clears browser images and invalidates settings together. The host drains browser captures alongside the new device/connection services using main's all-settled cleanup.

All 249 related browser, privacy, settings, connection, device, member and Work-room tests pass, as does typecheck. Fourteen affected screen/theme captures have no new/stale/infrastructure diagnostics: [merged gate](lifecycle-polish-merge-gate.json).

Merged PR #138's E2E network/send stabilization after main advanced again. The harness reuses main's native Chrome proxy configuration and removes the duplicate browser-egress helper; HTTP, CONNECT and upgraded connections remain denied, including reset-socket handling. Evidence image exclusion and diagnostic scrubbing are preserved. The 12 affected helper/network tests (including the real headless isolated-frame test) and typecheck pass. Product browser/persistence code is unchanged.

## Exact-origin network correction

A production-adapter HTTPS regression reproduced same-host cross-port requests before the fix. The adapter now installs native scheme/host/effective-port routing before navigation, with an owned deny-only proxy for every other request and implicit loopback bypass disabled. Parser resources, redirects and protocol changes are checked before the target receives a connection. Wildcard/bypass-pattern origins are rejected. TLS verification is unchanged in product code; the generated fixture certificate bypass exists only in the test wrapper.

All 25 affected tests, including the real production-adapter origin test and isolated-frame network test, and typecheck pass. The allowed page and same-origin stylesheet load, and denied target connection counters stay zero. The shared denial server preserves E2E HTTP/CONNECT/Upgrade and reset-socket coverage; browser image persistence code is unchanged.

The live read boundary also validates the durable browser schema, so a legacy image-bearing snapshot is refused after restart rather than copied into the pane. Its regression passes alongside the runtime suite. The origin probe counts actual HTTP-on-TLS errors separately from harmless aborted TLS handshakes.

The owned read context explicitly denies automatic downloads before navigation. The HTTPS probe gives its test browser an observable download directory: the attachment appeared before the guard and the directory stays empty afterward. Product TLS verification is unchanged. The 14 focused origin/adapter/lifecycle tests and typecheck pass, including refusal of legacy image-bearing state on read.

## Procedure/settings mainline integration

Merged main through #139 and #141, preserving telemetry v2, typed result tables, command-produced named steps/messages and newer settings producers. Browser summaries and page-read activity remain additional observations; the browser-only actor restriction remains intact. Shared residual descriptions now refer to the newer producers, and both sides' measured exception removals are retained.

All 372 related browser/privacy/procedure/member/telemetry/table/settings tests and typecheck pass. All 14 live browser interaction states pass. Sixteen affected screen/theme captures have no new, stale or infrastructure diagnostics: [merged gate](procedure-settings-merge-gate.json).

## Origin-only persistence and latest main

Observed addresses now retain only origins. Commands retain a navigation hash for idempotency, so another path cannot reuse a read identity after restart, while reset/magic-link tokens never enter observations, journal commands or portable backups. URL components are treated as private in reflected text/labels too; this can conservatively mask public route words. Fixed fixture source addresses are declared inputs, separate from observed origin-only metadata.

Merged #137 steering continuation and #143 device lifecycle without removing either producer or exception-removal set. The 176 related browser/steering/device/desktop tests and typecheck pass. Twenty-two affected screen/theme captures have no new, stale or infrastructure diagnostics: [merged gate](steering-device-merge-gate.json).

The origin probe now uses the workflow's explicitly selected Chrome and reports only fixed product failure stages plus bounded fixture-only CLI diagnostics. Native origin routing is the sole browser egress policy, consistent with the E2E network approach; iframe and alternate-host probes preserve denial coverage. The local 80-test privacy/origin suite passes. Linux CI remains the final verification.

Merged #142 credential-expiry repair and #144 member producers. Browser summaries coexist with credential-repair facts, and both browser and credential lineage validators/authority guards are retained. All 284 related tests plus 7 credential-repair tests and typecheck pass. Fourteen affected screen/theme captures have no new/stale/infrastructure diagnostics: [merged gate](credential-member-merge-gate.json).
