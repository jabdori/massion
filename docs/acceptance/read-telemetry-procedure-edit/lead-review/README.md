# Lead visual review: PR #147

All three visual items are addressed with command-produced state. These captures
supersede the initial review's file-effects, step-note and expanded-flow screenshots.
The fixture producer is `scripts/ui-contracts/read-telemetry-review-fixture.ts`;
the browser driver is `scripts/ui-contracts/verify-read-telemetry-review.mjs`.

## File identity and mobile visibility

The effects card projects repository-relative paths from each original dispatch's
file inputs. It no longer repeats the worker title for these rows. Long paths use
one ellipsized line, retain their complete text/title and take at least 70% of the
row's width. The new real-browser width assertion first caught the mobile common
three-column rule overriding the file layout; the more specific two-column rule
fixes that conflict. Both themes now pass.

The full `Record / None` card is visible in these captures. Its earlier cutoff was
the initial viewport position, not inaccessible content. The driver scrolls the
actual pane and verifies the entire card lies above the sticky checking bar.

- [Dark mobile effects and full empty Record card](dark-effects-mobile.png)
- [Light mobile effects and full empty Record card](light-effects-mobile.png)

## Pending and acknowledged procedure notes

The pending snapshots are retained immediately after the owner message command,
before acknowledgement. The acknowledged snapshots follow the exact assigned
worker's acknowledgement command. The note line in both pane and conversation
shows `pending` or the owning member's name and `acknowledged`; no title or member
name is inferred from an example scenario. The admission-pinned step stays intact.

| State | Dark | Light |
| --- | --- | --- |
| Pending | [PNG](dark-step-pending.png) | [PNG](light-step-pending.png) |
| Acknowledged by member | [PNG](dark-step-acknowledged.png) | [PNG](light-step-acknowledged.png) |

## Record creation and skipping

The existing command producer creates the accepted bundle with its host creation
time, or a failed independent check without any Record. Flow captions explicitly
say `Record created` and `Record skipped` in the product's Korean copy. The driver
checks each displayed time against the retained Record/check observation, scrolls
to the event, and verifies its complete bounds above the sticky checking bar.
Separate mobile card captures prove the Record section itself is fully reachable.

| State / viewport | Dark | Light |
| --- | --- | --- |
| Created, desktop flow | [PNG](dark-record-created-desktop.png) | [PNG](light-record-created-desktop.png) |
| Created, mobile flow | [PNG](dark-record-created-mobile.png) | [PNG](light-record-created-mobile.png) |
| Created, mobile Record card | [PNG](dark-record-created-mobile-card.png) | [PNG](light-record-created-mobile-card.png) |
| Skipped, desktop flow | [PNG](dark-record-skipped-desktop.png) | [PNG](light-record-skipped-desktop.png) |
| Skipped, mobile flow | [PNG](dark-record-skipped-mobile.png) | [PNG](light-record-skipped-mobile.png) |
| Skipped, mobile Record card | [PNG](dark-record-skipped-mobile-card.png) | [PNG](light-record-skipped-mobile-card.png) |

## Validation and scenario rule

- Related tests: 146 passed, zero failed; typecheck passed.
- Seven contract screens in both themes: zero new, stale or infrastructure
  diagnostics. Existing unrelated allowances remain unchanged.
- All eight browser state/theme runs passed; [measured results](report.json).
- `rg -n -i 'churn|pricing|toner|member-(quill|juno)|test step example' src desktop`
  finds no scenario-specific product code (the actual check also includes the
  prototype's Korean step title).
- Removed the pre-existing worker-role string comparison for reading state. The
  generic query now uses pending file-delivery claims. The fixture was extended
  through actual source capture, dispatch and receipt commands so its reading
  state remains supported by data.

No real provider, payment or GitHub-account calls were made. Main integration,
CI and current-head Codex evidence are recorded on PR #147 before its authorized
merge; these local test counts are not added together with CI counts.
