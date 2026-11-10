# Check predicate observation times (R-H)

Record each independently validated predicate's host observation time alongside
its existing quote, reason and pass/fail value. These are observations of the
single verification report, not claims about when a model evaluated each item.
The executor cannot supply checking evidence or times.

New application commands use telemetry version 2. Version 1 and unversioned
journal replay retain their original exact snapshots, including absent predicate
times. Backups validate each optional predicate time against its verdict's host
time; journal replay additionally establishes provenance. No command, runtime
permission, retry, or acceptance rule is added.

Extend the existing application telemetry tests first for concurrent replay,
forged times, independent verification and journal tampering. Render the retained
time next to each predicate using the current Work inspection rows. Table results
are the other R-H producer in this PR; file-read marks and active procedure edits
remain follow-ups because the bounded text runtime has no file-reading tool or
in-flight procedure mutation authority.
