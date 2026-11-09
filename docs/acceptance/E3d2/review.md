# Independent review and corrections

A read-only reviewer inspected the E3d2 diff before publication and reported
three introduced regressions. All three received failing-then-passing client
regressions and were corrected before the final full capture.

| Finding | Trigger | Correction and evidence |
| --- | --- | --- |
| Shared search detached from the document | Open an app, then remove/reset the selected app before clearing its sidebar. | Return the shared search button to its permanent controls before `replaceChildren`; hidden-page renderers cannot take that button. [Client regression](../../../tests/apps-surface.test.ts), [native DOM probe](../../../scripts/ui-contracts/verify-pages.mjs), [both-theme results](native-interactions.json). |
| Results query overwritten by background rendering | Enter a result query, then reread the conversation/Work list. | The Results query owns the main list. Shared sidebar search filters recent sidebar entries and does not overwrite the separate main query. [Client regression](../../../tests/results-schedules-surface.test.ts), [native DOM probe](../../../scripts/ui-contracts/verify-pages.mjs). |
| Generic app row state removed | A non-GitHub app returns a row with both `meta` and `state`. | Keep the original metadata/state string for generic apps; compact numbering/dates and fixed-label localization are GitHub-page changes only. [Client regression](../../../tests/apps-surface.test.ts). |

The reviewer closed those findings. The subsequent integration of merged E3c
retains its header busy avatar/status logic and this slice's activity-profile
navigation in the shared `shellHeading`. JSON source changes are combined by a
three-way object merge; generated tokens are regenerated, not hand-merged.
Integrated focused tests: 97 passed. The reviewer did not independently inspect
the final post-integration full-test or full-capture results; those are recorded
separately in `verification.json`. A new GitHub `@codex review` is requested on
the published PR; this document is not its approval.

A final read-binding regression also proves that an accepted result opens its
original member with an empty/different-feed global Work list. The existing
Results read now includes that immutable member identity, rather than guessing
from the global list. The normal HTTP regression checks the Representative
null identity. No new request or write route is introduced.

The reviewer also inspected the final canonical result-member read binding and
reported no important issues. Its focused client/HTTP and malformed-identity
checks passed using a physical temporary path. The later visual batch only
removes empty owned-page header space, uses the existing profile avatar, hides
the empty Paused group and removes unrelated B9 fixture content.
