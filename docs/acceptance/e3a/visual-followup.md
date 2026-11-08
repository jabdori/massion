# Visual-gate correction

The five requested corrections are applied without changing contracts, approved
copy entries, role palette values, member admission or the message command path.

- Structural dividers, cards, list groups and pane/dialog outlines use the quiet
  line role. Inputs, secondary buttons and selected shape radio inputs retain
  strong lines.
- The copy table has no approved interrupted-response sentence; the bare failed
  answer label is hidden until the cards slice supplies the intended treatment.
- Send status follows the composer in the DOM. Both themes measure exactly 6px
  from the form bottom to the status line. The failed-send fixture disconnects
  before Send, then reconnects before capture; its draft and resend action remain,
  and its disconnected badge is hidden. No message POST reaches the fixture host.
- Focus keeps the visual spec's 2px width and uses its muted `fg-4` role instead
  of full foreground. Keyboard focus stays visible in both themes.
- Artboard histograms identify the example Juno hue as `agent-6` in both themes.
  Correct the repeated example fixture identity, while rendering still follows
  each host-provided role; no display-name color override is introduced. Pale
  avatar tile composition remains for the later avatar slice.

Runner coverage: the 16 review states in dark and light, plus both-theme B21-name
for the shared dialog border (34 captures). All have zero infrastructure errors
and zero palette-token mismatches. Existing screen-role, interaction and geometry
gaps remain visible in the raw report. Direct browser checks assert the 6px gap,
retained draft, connected failed-send state, focus color/width, quiet sidebar
border, and Juno's resolved role color. [Measurements](visual-details.json).

The combined 75-screen table replaces only these rerun rows. The other 58 screen
states retain commit e5263db's existing measurements; they were not recaptured.
The fixture host still rejects writes, and actual providers/databases/native
clients are outside this evidence.

| Screen | Dark P / F | Light P / F | Dark pair | Light pair |
| --- | ---: | ---: | --- | --- |
| B2 | 13 / 19 | 13 / 19 | [PNG](pairs/dark/B2.png) | [PNG](pairs/light/B2.png) |
| B2-offline | 14 / 6 | 14 / 6 | [PNG](pairs/dark/B2-offline.png) | [PNG](pairs/light/B2-offline.png) |
| B2-offline-failed | 13 / 9 | 13 / 9 | [PNG](pairs/dark/B2-offline-failed.png) | [PNG](pairs/light/B2-offline-failed.png) |
| B9 | 11 / 27 | 11 / 27 | [PNG](pairs/dark/B9.png) | [PNG](pairs/light/B9.png) |
| B9-restart | 11 / 28 | 11 / 28 | [PNG](pairs/dark/B9-restart.png) | [PNG](pairs/light/B9-restart.png) |
| B9-update | 11 / 27 | 11 / 27 | [PNG](pairs/dark/B9-update.png) | [PNG](pairs/light/B9-update.png) |
| B12 | 13 / 13 | 13 / 13 | [PNG](pairs/dark/B12.png) | [PNG](pairs/light/B12.png) |
| B13 | 14 / 8 | 14 / 8 | [PNG](pairs/dark/B13.png) | [PNG](pairs/light/B13.png) |
| B13-devices | 14 / 6 | 14 / 6 | [PNG](pairs/dark/B13-devices.png) | [PNG](pairs/light/B13-devices.png) |
| B13-general | 14 / 7 | 14 / 7 | [PNG](pairs/dark/B13-general.png) | [PNG](pairs/light/B13-general.png) |
| B13-general-restart | 14 / 9 | 14 / 9 | [PNG](pairs/dark/B13-general-restart.png) | [PNG](pairs/light/B13-general-restart.png) |
| B14 | 18 / 16 | 18 / 16 | [PNG](pairs/dark/B14.png) | [PNG](pairs/light/B14.png) |
| B14-expired | 18 / 16 | 18 / 16 | [PNG](pairs/dark/B14-expired.png) | [PNG](pairs/light/B14-expired.png) |
| B14-restart | 18 / 18 | 18 / 18 | [PNG](pairs/dark/B14-restart.png) | [PNG](pairs/light/B14-restart.png) |
| B14-update | 18 / 16 | 18 / 16 | [PNG](pairs/dark/B14-update.png) | [PNG](pairs/light/B14-update.png) |
| B14-usage | 14 / 20 | 14 / 20 | [PNG](pairs/dark/B14-usage.png) | [PNG](pairs/light/B14-usage.png) |
| B21-name | 15 / 19 | 15 / 19 | [PNG](pairs/dark/B21-name.png) | [PNG](pairs/light/B21-name.png) |
