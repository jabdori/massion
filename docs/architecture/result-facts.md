# Generic bounded result facts (R-M redesign)

Workers and final assembly may declare exactly
`{"format":"massion-facts/v1","items":[{"label":"Files","value":3,"unit":"items"},{"label":"Phase","value":"Ready"}]}`.
Items retain their declared order. There are 1–8 items, labels of 1–64 characters,
nonnegative integer values up to one billion or text values of 1–96 characters,
and optional units of 1–16 characters. Strings are well-formed, trimmed single
lines without control/format characters. The whole envelope is at most 4096
UTF-8 bytes. All object keys are exact. No scenario discriminator, business field,
canned sentence, title match, label interpretation or prose extraction exists.

A shared inert renderer joins `label valueunit` items with ` · `. Activity and
conversation cards add actual host state and the real active/settled step titles.
Only assigned producing-seat settled, non-skipped results supply facts. Final
assembly facts take precedence over worker declarations. Generic table counts
retain the existing validated worker-table projection; tables never invent fact
items. The original four-key table protocol is unchanged.

The runtime rejects invalid marked facts before writes/settlement. Final facts
retain their exact original bytes for independent checking and the existing
executor result. The task command validates the same envelope. Existing command
identity, ownerStore/drain, feed, request-generation and journal boundaries remain
unchanged. No new command, stored field, dependency or migration is needed; the
unshipped scenario-specific shapes are removed.

Fixture producers may declare scenario labels as data through real commands.
Regenerate their outputs from source. Recapture the affected screens and restore
honest allowances wherever the prototype requires a canned sentence rather than
generic facts. Compare flow disclosures/alignment with current main, fix touched
rendering, and record the comparison. Recompute allow-list totals relative to the
merged main; run related tests and typecheck locally, then CI/current-head Codex.
Leave PR #146 open for lead re-review; do not merge it.
