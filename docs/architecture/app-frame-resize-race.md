# First app-frame resize delivery

The workbench already installs its message listener before any app view opens.
The race is the later association of an iframe's source window: a detached
iframe has no content window, its registration microtask can run before insertion,
and its document can post a resize before the load handler registers it.

Resolve the exact source window against currently connected isolated app frames
when a message arrives. This removes asynchronous registration altogether and
needs no new app protocol or resend. Preserve opaque-origin validation, exact
message keys, safe integer heights from 80 through 1200, URL admission and sandbox
attributes. Detached, replaced and unrelated frames must never resize a live view.
The same client serves loopback documents and desktop `massion-app` documents.

The initial browser-command retry below was later removed after it hid browser
closure. See [E2E app-frame network controls](e2e-app-frame-network.md) for the
remaining harness race and native loopback restriction.

Reproduce first-message delivery before load, including insertion after the old
registration microtask, in the existing frame tests. Reuse the bounded one-retry
browser command helper for all browser operations in the journey drivers; only
the exact CDP context-installation failure permits retry, never an app command or
an arbitrary browser failure. Run related tests, typechecks, syntax checks, the
Linux headless desktop smoke and ten complete headless E2E runs. Keep snapshots,
screenshots and per-run counts as fixture evidence, with no real provider calls.

Platform reference: [HTML iframe processing and contentWindow](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#dom-iframe-contentwindow).
