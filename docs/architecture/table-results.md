# Bounded typed tables

Tables use an explicit JSON envelope inside existing immutable UTF-8 text artifacts and settled task results: `{ "format": "massion-table/v1", "caption": "...", "columns": ["..."], "rows": [["..."]] }`. Cells are literal strings; there is no prose, Markdown or HTML extraction. No artifact kind, API, domain field or backup format changes.

The pure parser accepts only exact envelope keys, 1–12 nonempty column names, 1–100 rectangular rows, at most 600 cells, 128-character captions/headers, 1024-character cells and 32768 UTF-8 bytes. Invalid or unmarked text never receives table semantics. Runtime prompts describe this envelope; marked invalid final and worker outputs are blocked before artifact writes or task settlement. Worker results remain untrusted observations, not acceptance evidence.

The pane and accepted preview construct semantic caption/thead/tbody/th/td nodes using textContent only. Original and Copy retain the exact JSON string, including whitespace. The existing independent checker receives those same immutable JSON bytes; hashing, readback, journal replay, feed and request-generation fences remain authoritative.

The pricing fixture settles an explicit controlled six-row envelope through the existing task command. Its invented companies and prices are fixture data, not fetched market facts. A separate accepted-preview generator may create genuine text artifacts, independent fixture verification and acceptance through Application and the exact Record reader. Parent integration owns fixture-host wiring, regenerated screen JSON and allow-list changes. Memory proposals, conversation ordering and business scenario composition remain outside this slice.

## Work attribution after visual review

The expanded attribution strip must not use assignment model IDs as display
names. The pricing fixture's `bounded-fixture` came from that shared fallback;
real-provider Works could expose equally internal route/model strings. Keep the
existing product-backed member name and pinned connection label, and omit
producer/checker identity rows without an actual named member source. The host
checking seat is not a named member. Exact model bindings stay in the existing
technical inspection, not this summary strip. Keep fixture identities unchanged.
