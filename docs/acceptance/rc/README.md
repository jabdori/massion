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
  reconnect. Nine state/theme screenshots are retained in `interaction/`. No outside network
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
records nine states/theme checks. Reconnect foreground/background contrast is
16.46:1 in dark and 17.65:1 in light, above 4.5:1. No secret bytes enter the journal.

The existing B19 fixture Mission memory arrays are empty; MembersService.read()
provides no member memory binding, and SkillsService.read() distinguishes owner
from member authors without builtin provenance. These residuals remain documented
instead of reclassifying owner instructions or unrelated Mission memory.

## Monthly-budget main integration

Merge main `18c6558` (PR #117) after the owner update. Resolve the shared Settings,
server, portable-backup and lineage boundaries by preserving both features. The
semantic allow-list merge retains all 20 E8 removals, keeps the R-C producer
reasons, and has 684 unique entries. No resolved budget exception is resurrected.
Keep the monthly reconciliation task in host drain/startup and decision/usage
routes alongside connection/device ownership and archived-member admission fences.

Use actual started Work for the working indicator, so budget-waiting Work is not
called active. Honor the protocol's explicit unsent marker without unlocking
ambiguous effects. Both regressions failed before their minimal integration fixes.
Related integration checks: 70 passed, 0 failed, 3 DB cases skipped; runtime/drain/
member checks: 134 passed, 0 failed, 10 environment skips. Typecheck passed. The
three E8 screens recaptured in both themes pass 176/176 required matches with
zero geometry, gaps or infrastructure errors. Actual-host interaction assertions
still pass, including both reconnect contrast measurements and secret redaction.
See `main-budget-integration.json`; full-suite and all-screen checks remain CI-owned.

## Late review follow-up

Reproduce a held key write across shutdown: the old HTTP route returned unknown
while the host still reported drained. Propagate that result into the existing
host-unsettled flag. Reproduce a second pending Work for the same device with a
different unapproved adapter: connectivity retains the entire approved binding,
so disconnect still targets the admitted adapter and the new Work remains unsent.
Both real HTTP tests failed before the fixes. Also fence the shared app read at
the outer HTTP feed boundary, so a new-database view cannot carry the prior feed.

App secret presence now uses the existing optional metadata-only slot probe.
Deletion or restore to a host without that slot projects missing despite an old
saved receipt; pending connections remain unknown regardless of physical presence.
Feed/revision checks discard late metadata, and the bounded read wrapper aborts
an uncooperative probe during drain without accepting its late answer. The old
receipt and journal replay remain unchanged. All 91 affected app, lifecycle,
HTTP and device tests pass; typecheck passes. No secret value reads are added.

The actual-host browser flow additionally deletes a just-saved in-memory app
slot: Settings shows reconnect again while the stored app receipt remains saved.
Nine state/theme captures and the unchanged secret-redaction assertion are in
`interaction/report.json`; this is controlled fixture evidence, not Keychain access.

## Work-telemetry main integration

Merge main `2db6dd2` (PR #129) with its Work timestamps, progress, independent
check metadata and replay validators intact. Resolve only the shared allow-list:
keep both branches' deletions, retain all 30 upstream remapped identities, and
preserve R-C producer reasons. Main has 630 entries; the merged list has 530.
The upstream reduction is 154 net entries, without resurrecting R-C's 100 removals.

Typecheck passes. The 153 related telemetry, room, member, budget, backup,
app-presence and lifecycle HTTP/structure tests pass without skips. Re-capture
all 22 R-C screen/theme pairs: 670/708 required matches, zero geometry/token or
infrastructure errors, and no new/stale diagnostic exceptions. The 38 remaining
contract diagnostics and four capability gaps retain their existing producer
reasons. Full-suite/all-screen and e2e validation remain CI-owned.

## Legacy app connection review

A historical completion without `observeStorage` correctly retains no credential
receipt during replay. Its Settings projection now uses confirmed metadata-only
slot presence to show saved storage; deletion still shows missing. Expired
receipts and unresolved claims keep priority. The regression failed with missing
before the fix; 57 related app/MCP/fixture checks and typecheck pass afterward.
No journal rewrite or token read/write is introduced by this projection.

## Concurrent app-read e2e correction

The integrated e2e run exposed a real HTTP 409 while app installation overlapped
an empty catalog read. Restart the projection at most twice when its app revision
changes within the original feed. Feed replacement still rejects immediately;
continued revision churn remains bounded and returns conflict. Metadata-only
reads never retry an app command or secret effect.

The delayed-source and bounded-churn regressions failed before the correction;
60 related app/MCP/lifecycle HTTP tests then passed. An additional exact overlapping
install regression passes (61 checks combined), and typecheck passes. The E2E
assertion remains HTTP 200; no browser or network policy was relaxed.

## Shutdown and member-response review

The real HTTP device regression reproduced a running adapter interrupted by drain
while the host reported drained. Device drain now rejects durable unknown outcomes
and rejected active work; the existing host aggregation reports unsettled. The
archived/restored client regressions reproduced a lost response locking the inverse
action after repeated successful reads. Settings now reconciles the exact original
command fingerprint through a read-only, feed-fenced receipt query. Current state
alone and unknown/mismatched receipts never unlock or resend that command.

Both client regressions and the HTTP drain regression failed before the fixes.
54 related member/device/app-presence/backup/structure checks pass, and typecheck
passes. Additional actual HTTP assertions reject duplicate query fields and
replacement-database receipts. The local browser script drops both committed
member response bodies and requires archive/restore recovery without replaying
an owner action; screenshots retain the existing nine state/theme names.

The final actual-host browser run passes all nine captured states after dropping
exactly two committed member reply bodies. Fresh reconnect contrast is 16.46:1
dark and 17.50:1 light; outside adapter calls and journaled secret values remain
zero. `interaction/report.json` contains the new measurements.
