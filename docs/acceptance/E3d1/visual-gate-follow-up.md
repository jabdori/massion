# PR109: A1–A8 visual follow-up

Final main confirmation: the generated tokens and source/copy checks pass. All 32 final pairs were recaptured and inspected; the final B13 borders match the golden values below. Actual durable-store aggregate: 1,902 passes, 33 ordinary CI browser skips, zero failures; amd64 relation recheck: 13 passes. See `verification.json` and `ci-follow-up.md`. The intermediate worker measurements below are preserved as investigation history.

Approved original HTML is authoritative. Source directory:
`/private/tmp/claude-501/-Users-code-massion/dc2d9a0d-e0f8-420f-84fc-beec74d770c3/scratchpad/proto/render/`.
Read B13, B13-general, B19, B19-juno, B20, B20-coding, B14 and B23
`.dc.html` files and compared the pinned PNGs in `docs/product/screens/artboards/`.
This is a Settings-only correction, not a redesign or a producer-status audit.

| Feedback | Change and provenance |
| --- | --- |
| A1 | Hide the entire Advanced navigation button initially and after clearing search. Matching local section search reveals its existing label and technical controls. Remove the icon-only width/top-margin rule. No new navigation or write path. |
| A2 | Add Settings-specific dynamic copy `설치됨 {count}` / `직접 만든 앱 {count}`. Render each number in its own span with B23's 8px gap, weight 400 and `--fg-4`. Retain original copy entries for other consumers. |
| A3 | B19/B19-juno: page top 32px, back-link line 20px/font 12px and bottom gap 14px; avatar 44px/radius 11px/initial 18px; name 22px with 30px line; Message height 28px/font 12px/horizontal padding 12px. Reserve the approved 50px header footprint (30px title + 20px subtitle) without inventing the missing status subtitle. |
| A4 | Explicitly select the unknown dash option. Set 30px input/select controls to vertical padding 0 and horizontal padding 10px: inherited 10px vertical padding had clipped the select text. Keep native disabled semantics and set disabled text fill. Version remains a small, right-aligned monospace dash rather than an invented build number. |
| A5 | Group member buttons now append avatar, name wrapper, then an aria-hidden trailing chevron. Preserve admitted avatar shape and `shellBusyAvatar`'s recorded running state. Fix Settings-only CSS specificity so busy initials remain hidden and member avatars retain their approved size. |
| A6 | B20/B20-coding: show current-order indices 1/2, retain the existing reorder/remove/CAS handlers, and show `‹ 연결`. Display recorded provider label under the model and family at the trailing edge. |
| A7 | Add an aria-hidden chevron to existing disabled Default model selectors. Prefix `구독 ·` only for an actual CLI provider kind, using the runtime profile first and recorded model provider as fallback. Keep unavailable selection behavior and unverified connection status. |
| A8 | Replace the universal 56px minimum row with measured padding: normal Settings 12px, General 14px, member detail 11px, group model 10px. Use 20px text lines, no extra 2px text gap, 22px procedure chips, and the approved group-form label width. Restore 32px list avatars, 24px group-member avatars and the original small reorder/remove targets. |

Changed consumers: Settings rendering/search in `src/settings-panel.ts`,
Settings list headings/styles in `src/apps-panel.ts`, their two surface tests,
and additive copy/measurement entries. `settingsLoad` was compared byte for byte
with its pre-edit body and is unchanged. App pages, rail/Work functions,
fixtures, checker, scripts and generated tokens were not edited.

## Token generation handoff

Main must run `node scripts/generate-ui-tokens.mjs` before final checks/captures.
The generated file was intentionally left untouched. Added numeric source keys
under `visual.json` → `shell.settings` (all values become px):

| Source key | Value | Approved HTML provenance |
| --- | ---: | --- |
| `row_padding_y` | 12 | B13 row / B20 form row |
| `general_row_padding_y` | 14 | B13-general row |
| `member_padding_top` | 32 | B19/B19-juno main padding |
| `member_back_gap` | 14 | B19/B19-juno back link |
| `member_avatar_radius` | 11 | B19/B19-juno avatar |
| `member_row_padding_y` | 11 | B19/B19-juno card rows |
| `action_height` | 28 | Member/connection/group actions |
| `procedure_chip_height` | 22 | B19/B19-juno procedure chips |
| `group_back_gap` | 6 | B20/B20-coding back link |
| `model_index_width` | 14 | B20/B20-coding drag/index columns |
| `model_row_padding_y` | 10 | B20/B20-coding model rows; B14 route rows |
| `group_member_avatar` | 24 | B20/B20-coding member row |
| `group_member_radius` | 7 | B20/B20-coding member avatar |
| `group_member_initial` | 11 | B20-coding member initial |
| `default_heading_top` | 13 | B14 Default group heading |
| `default_model_indent` | 28 | B14 Default model left padding |
| `heading_tracking` | -0.22 | Approved 22px heading × -0.01em |
| `row_avatar` | 32 | B13 member list avatar |
| `member_header_height` | 50 | B19/B19-juno title 30px + subtitle 20px |

Tokens use the existing generator's mapping, e.g.
`member_header_height` → `--settings-member-header-height`.
`feedback_source` records measurement provenance and is not emitted as CSS.
Added copy keys: `ui.settings.installed-count`,
`ui.settings.self-made-count`, `ui.settings.subscription`.

## Verification and limits

- Extended existing behavior tests first; observed five failures before the
  initial implementation. The separate count-span assertion also failed before
  the count styling follow-up.
- Final `node --test tests/settings-surface.test.ts tests/apps-surface.test.ts`:
  **31 passed, 0 failed**. Includes search-only Advanced access, real group
  member DOM order/running labels, dash selection, CLI-only subscription copy,
  plus existing CAS overlap, lost response, stale reads and app command guards.
- Final `npm run typecheck`: passed. `git diff --check`: passed.
- Direct existing copy lint: 28 files, 0 findings, 0 blocking.
- `node scripts/check.mjs`: runtime syntax stage passed; generated-token check
  failed with `UI tokens are out of date`. This remains pending main's generator
  run; it is not a successful aggregate-check claim.
- Exactly one isolated headless agent-browser batch, own session
  `massion-e3d1-feedback-cf6c14b9df1f`: B13, B13-general,
  B13-general-restart, B19, B19-juno, B20, B20-coding, B14 and B23 in dark and
  light, **18 captures, 0 batch errors**. Existing fixture hosts only, no product
  writes. Unknown selects rendered visible dashes in both themes; Advanced
  search/open/clear worked; group indices, back copy and child order passed.
- Browser preview injected numeric `visual.shell.settings` values into the
  document root; it did not regenerate or write `src/ui-tokens.ts`.
  Raw evidence: `/tmp/e3d1-feedback-browser/measurements.json`,
  `/tmp/e3d1-feedback-browser/<screen>-<theme>.png` and `.txt`.

Observed browser geometry at 1440×900, identical between themes:

| Surface | Observed geometry |
| --- | --- |
| B13-general / restart | First card x550/y94/w640/h227; control rows 59px, version row 48px; selects padding `0px 10px`, selected `—` |
| B19 / juno, before final footprint correction | Back x550/y32/h20; header y66/h44; avatar 44×44; title 22px/30px; Message h28/font12; first card y166 |
| B20 / coding | Back x550/y44/h20; first form card y120/h111; models card y287/h168; member card y511/h50 |
| B14 | First model-group card y130/w640; CLI route subtitles contain `구독 ·` without login-success copy |
| B23 | Installed card y122/h66; self-made card y244/h66; heading text contains `설치됨 1` / `직접 만든 앱 1` |

The single batch exposed CSS cascade details. After it, narrow source corrections
restored 32px busy list avatars, hid busy initials in the 24px group avatar,
reserved the approved 50px member header (expected first card y172), split app
counts for the exact 8px gap, and removed inherited padding from 14px reorder
controls (the capture's model text was 10px too far right). The Add model action
also now uses the approved unbordered padding. These final source corrections
passed the focused tests/typecheck/copy lint; **they were not recaptured**, to
respect the one-batch limit. Main's final regenerated-token pairs must verify
them. Existing unsupported status/producer content remains main's A9 audit.

Main retains CI, real SurrealDB, aggregate checks, all 150 contract/theme runs
and all 32 Settings pairs. No budgets were changed; no commit or push was made.

Browser styling reference checked during investigation:
[MDN select](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/select)
and [text fill](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/-webkit-text-fill-color).

## Final measured B13 row footprint

The golden B13 card borders are y94/159/224/289; the first follow-up capture was y94/151/208/265 because unsupported metadata left each text column one line tall. Preserve the approved two 20px text lines with `member_list_text_height: 40` for the member-list text column only. This reserves the row footprint without inventing last-active times, Work/schedule counts or new labels. B19-juno supported card borders already match y172/215/258/301/358/403/460/523; B20 borders match y120/175/230/287/348/409/454/511/560. Values were read from the supplied PNGs and the final native CSS padding remains the source measurement.
