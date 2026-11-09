# B12 memory rows and transition history

B12 reuses the Settings search, existing tokens and owner retire/revert commands. Each memory has a title and one inline detail row: instruction, version, actual state and the exact source Work link when present. Learned candidates say pending before adoption, in use only while effective, and not in use after retirement/supersession. Source links retain feed, generation and input/criteria hash guards.

Optional `Growth.adoptedAt` and `Growth.revertedAt` store successful host transition times. New adopt/revert commands carry `recordChangeTime: true`; Application supplies `observedAt`. Rule decisions pass the same marker/time into adoption. Exact operation replay happens before reading the clock. Old commands replay without timestamps, including receipt readback for old ProductService and rule-answer requests.

Times are safe nonnegative, Date-representable integers. A recorded reversion cannot precede its adoption. Proposed Growth cannot supply these fields. B12 sorts actual transitions separately, newest first. Undated legacy history remains undated; evaluation time is never used as a substitute. A completed reversion has no directly applicable revert command, so its history control is disabled; reconsideration remains in the existing pending owner decision.

The B12 fixture uses production Application transitions and validates their complete journal: a prior evaluation, adoption one day and two hours before capture, reversion one day before capture, then a new pending evaluation. The baseline is effective and the learned candidate inactive. Recorded fixture clock values produce both history dates on the approved November 4 example day.

Related tests cover one search field, inline source/detail, pending/active/inactive states, native-hash completion, actual versus evaluation dates, invalid clocks, legacy journals/receipts and idempotent replay. Browser evidence lives in `docs/acceptance/r-d/`.
