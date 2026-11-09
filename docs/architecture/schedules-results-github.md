# Schedule kinds, binary results and GitHub review context

- Scope: R-E, above the existing Results, Schedules and Apps implementations.
- Contracts: B10, B17/B17-empty and B22/B22-room.

Extend the current producers and command boundaries rather than introducing a second scheduler, result store or app framework. Owner-created schedule templates retain bounded runs, durable command identity, drain admission and unknown-outcome handling. Each schedule is selected independently on the existing page; its kind determines its request and retained run result.

PDF and image results must originate from bounded artifact bytes, retain exact accepted Record identity and use an integrity-checked reader. Render supported bytes in the existing preview pane. Never label text as a PDF/image or invent accepted results for fixtures. Keep the existing text reader contract compatible.

GitHub item views retain the provider's external PR URL, exact head SHA and commit history. An active review link requires a product-owned exact app/repository/PR/head binding on a Work; matching a title is insufficient. The host resolves current Work state and assignee, and the client opens that exact Work. App-supplied data cannot manufacture review state or execution authority. URLs are validated before becoming links.

Implementation order:

1. Add failing tests, then extend schedule kinds and selection using the existing reducer/service/client.
2. Add failing tests, then connect bounded binary production, exact reading and previews.
3. Add failing tests, then extend validated app views, GitHub responses and product-owned review binding.
4. Update real-shaped screen fixtures and remove only allow-list entries resolved by these producers. Verify affected tests, typecheck and headless screen flows; CI owns full-suite/contract validation.

All owner writes retain the drain-aware store. Test overlapping command identity, drain, stale/feed-replaced state and late async reads where each path introduces that risk. No tests call external providers, payments or the real GitHub API. No merge, release or deployment is part of this slice.

## GitHub binding and existing installations

The explicit owner action in an existing fresh Work's PR tab reuses capture-document and attach-work-source. Its retained document has format github-review/v1, repository, PR number, head SHA and canonical external URL. It becomes an immutable input pin before Run. A lost capture receipt cannot trigger attachment or resend. Cancelling, stopping, an elapsed deadline, an unknown effect, changed source bytes or a different PR head removes the active-review projection.

The host assembles review state from stored Work and validated document pins. App view validation refuses app-authored review rows. The GitHub item must match the selected PR identity; a title alone only opens a browsing tab. Feed replacement invalidates page, item and room reads, and Work events/deadlines refresh existing views.

The bundled GitHub app is version 1.4.1. Existing installations expose the available catalog update in Settings, using the existing install/update command and permission decision path. No new app authority or automatic external action is introduced. Provider fields follow [GitHub's pull-request API](https://docs.github.com/en/rest/pulls/pulls) and [commit API](https://docs.github.com/en/rest/commits/commits). The existing single-repository and bounded first-page scope remains.

See [R-E acceptance evidence](../acceptance/R-E/README.md) for the final checks, contract exception removals and limits.

Admission uncertainty includes an answered Representative turn whose outcome was not durably recorded. Missing outcomes and missing/failed source reads never become known rejection or retry permission. GitHub commit subjects are bounded to the view's field limit before validation; the display uses a shorter line with the bounded subject available for hover/accessibility. Cursor/deadline refresh tracks item-selection generation and preserves an owner's newer selection.
