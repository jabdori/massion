# Monthly budget end-to-end journey

Extend the existing bounded daemon/browser suite with one isolated database and
fixture-only provider journey. Set the monthly output-token limit to zero through
B14 usage settings, submit one Work, and inspect B26 plus durable budget-waiting
state. Later and reopen must leave the Work unstarted. Raising the reviewed limit
must resume exactly that Work, independently check it and accept one Record.

The fixture daemon crashes immediately after the real store commits the raise,
before returning to the host's reconciliation scheduler. This test-only store
composition creates a deterministic persisted-decision/pre-resume crash boundary;
no production recovery hook or arbitrary timing sleep is added. Restart with the
same database and settings, then assert one producer call, one independent checker
call, one activation and one acceptance. Refresh and restart again to expose
replays. B14 must show the same period and recorded token totals as the usage API.
The existing 480-second suite and twelve-minute CI job bounds stay unchanged.

No live providers, credentials, prices, production behavior or new dependencies.
