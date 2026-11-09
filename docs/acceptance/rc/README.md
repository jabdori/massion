# Settings lifecycle (R-C)

This is the bounded connection, app, member and admitted-device lifecycle slice
allowed by CODEX-BRIEF. It does not claim all B13/B14/B19/B23 capabilities exist.
The implementation follows [the design](../../architecture/settings-lifecycle.md),
ADRs 0001–0005 and the existing owner decision path from PR #120.

## Implemented

- Durable connection rechecks and direct secret-slot key replacement, with
  original-command replay and no secret bytes or secret hashes in the journal.
  Metadata-only slot presence distinguishes missing, saved and unknown.
- Trusted host observations for expiry, updates and restart requirements; CLI
  status/discovery remains distinct from verified model execution.
- Explicit app member bindings, storage/expiry observations and reconnect through
  the existing decision and masked token panel. Historical completion events keep
  their original replay; unknown token writes remain fenced after restart.
- Member metadata, archive and unarchive, retaining original identity, history and
  ongoing Work. New messages, steering and routing exclude archived identities.
- Remote device read/connect/disconnect through existing external-member
  admissions. A connection never resends a handoff or settles its unknown Work.
- Scoped Settings reads and single-send controls; database replacement clears
  stale cached controls. Production readers generate the new screen fixtures.

## Verification

- Node 24.21.0 focused aggregate: **369 passed, 0 failed, 3 skipped**. The skipped
  cases require actual SurrealDB restore/CLI infrastructure. The documented local
  `portable inventory order is stable across English and Turkish process locales`
  failure was reproduced in the first run, then explicitly excluded from the
  final related run. Full-suite and full-screen execution remains with CI under
  the owner's local verification budget.
- `npm run typecheck`, `node scripts/check.mjs` and `git diff --check`: passed.
  Copy lint and the scoped design detector reported zero findings.
- [22 screen/theme captures](report.md): **670/708** required elements, 38 retained
  contract diagnostics, **zero geometry/token failures and zero infrastructure
  errors**. Both themes were compared with all 11 artboards using the committed
  PNG pairs. These are fixture observations, not live-provider evidence.
- [Browser interaction](interaction/report.json), against the actual local host:
  recheck, masked key storage, member archive/restore, bound app display and token
  reconnect. Eight state/theme screenshots are retained in `interaction/`. No outside network
  adapter is installed and secret bytes are absent from the operation journal.
- The HTTP regression exercises external admission, overlapping device connects
  and disconnect while preserving the original arrival-only unknown Work.

Run the interactive assertions with:

```sh
node scripts/ui-contracts/verify-settings-lifecycle.mjs
```

The approved screen contracts, matching algorithm, geometry and text budgets were
not relaxed. The allow-list loses **100 resolved occurrences**. Two remaining restart-gap occurrences describe a host-observed requirement
without an executor. Its matching action is disabled; missing member-bound
producers retain their capability diagnostics instead of placeholder cards.

## Remaining

| Screen | Retained evidence and follow-up |
| --- | --- |
| B13 | The recorded background has no active Juno Work. Actual metadata and archive exist; a working status is not fabricated. Regenerated members use host-assigned IDs and palette order. |
| B14-restart | Host observation produces the required state. Executing an update/restart needs an actual maintenance adapter; the matching action is disabled until a restart executor exists. |
| B19, B19-juno | Skill records lack builtin provenance. Mission memory and the current Representative-only briefing have no member binding. Member memory editing and member schedules need their own producers; sections without a member-bound producer are omitted. The earlier missing memory occurrences retain the dependent recent-improvement order diagnostic. Explicit member app bindings and archive are implemented. |
| B23 | GitHub is the only bundled installable recommendation and is already installed. The six other packages do not exist; no fake catalog or install controls are added. |

Real keychain access, providers, remote devices, payments, deployments and merges
were not executed. Saved means stored, not authenticated. Expiry requires trusted
host evidence tied to the current credential. Unknown writes require inspection,
never another effect attempt. Member archive and Work admission do not share a
cross-aggregate transaction; an already admitted Work retains its original pin.

## Review corrections

The first Codex head review identified two reproduced regressions. Device commands
now retain the HTTP admission's original feed and recheck it after reading the
admission, before invocation and before settlement; claim/settlement commits also
use that feed's storage fence. Replacement at each boundary makes no claim in the
new database and cannot dispatch from the old admission. Self-made app reconnect
opens its owning member's conversation, where the existing app decision is read.
Both tests failed before the fixes; 30 focused device, HTTP and app-surface tests
then passed, along with typecheck and syntax/copy checks.

The first CI head passed full durable-store verification and all 150 screen/theme
captures. The corrected head also passed code/security review without findings
and all screen captures. E2E exposed the browser tooling failure documented in
[the E9a2 follow-up](../../architecture/e2e-decisions-apps-desktop.md). The narrow
local browser-pin experiment passed, but the complete Linux E2E still failed in
its MCP snapshot after eight passing subtests. The ineffective CI changes were
reverted, keeping domain restrictions and the opaque app sandbox unchanged.
The final review loop reports this remaining failure rather than claiming a
complete E2E pass. Member memory/schedules, builtin provenance, restart execution
and the absent recommendation packages remain the capability follow-ups above.

## Main integration after the fourth review

At the owner's request, merge `origin/main` at `156305d` (PR #132). It waits for
existing isolated-frame readiness before the MCP capture and retries only the
specific browser network-control context error once. Other failures remain fatal;
app sandbox, domain restrictions and product command handling are unchanged.
The previous R-C final head passed all 13 E2E tests with the original browser.
The new merge head's complete CI/review result is tracked on PR #130; the earlier
failure notes above describe the intermediate browser experiments.

The post-main review found that a proved pre-write key refusal lacked its HTTP
outcome tag. The server now emits the explicit rejection signal already recognized
by Settings, preserving deliberate retries without treating ambiguous writes as
failures. The HTTP regression failed before the fix; 31 related lifecycle, HTTP
and client tests then passed, including post-write uncertainty and reload behavior.

## Owner visual gate

Correct the devices title/action alignment, device icons/status dots, maintenance
subline/action pairs, member identity/metadata grouping, archived avatar/date/
accepted-Work count and weekday formatting. Fixture member names are Korean.
Remove the uncontracted native-checkbox app editor, expose reconnect only for
missing/expired storage, and show actual approved version history/rollback.
The real uninstalled catalog remains the only recommendation source.

Recapture all 11 affected screens in both themes. Measurements have zero token/
geometry or infrastructure failures. The actual-host interaction report now
records eight states/theme checks. Reconnect foreground/background contrast is
16.46:1 in dark and 17.50:1 in light, above 4.5:1. No secret bytes enter the journal.

The existing B19 fixture Mission memory arrays are empty; MembersService.read()
provides no member memory binding, and SkillsService.read() distinguishes owner
from member authors without builtin provenance. These residuals remain documented
instead of reclassifying owner instructions or unrelated Mission memory.
