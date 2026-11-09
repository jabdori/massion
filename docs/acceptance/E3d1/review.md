# Independent review and corrections

A separate reviewer read the final Settings write/read paths, server admission,
connection persistence and app source navigation without changing files.

1. An older catalog read could overwrite a successful group save. A regression
   first reproduced `hash-b` becoming `hash-a`. Saving now advances the shared
   catalog generation before dispatch and again before adopting a successful
   reply; every Settings `/connections` read checks that generation as well as
   its section generation, feed and connection epoch.
2. An ambiguous host persistence error can be returned as HTTP 400, so neither
   4xx nor 5xx proves rejection. A regression matrix first failed for an
   unclassified HTTP 500. Only explicit `outcome: rejected` is now a definite
   refusal; missing/unknown outcome, transport loss and malformed successful
   replies latch unknown and disable every group edit without replay.

Both regressions were observed failing before their fixes and passing after.
The existing endpoint remains exact-field CAS: it accepts `expectedConfigHash`,
not a new command ID. Overlapping client edits send once. No policy route,
credential resolver, owner-store admission or server behavior changed.

Aggregate verification also caught fixed-icon `innerHTML` assignments against
the repository's stronger no-dynamic-HTML-sinks rule. The icons now use static
CSS masks. Chromium then demonstrated that standalone SVG masks require the XML namespace: decoding failed without it and succeeded with it. The shared icon source now includes that namespace; the actual generated mask decodes. The original no-HTML-sinks test passes without an exception. App source navigation
tests preload their immutable fixture instead of racing asynchronous filesystem
reads against a fixed number of event-loop turns.

The admitted member shape and recorded busy identity are regression-tested;
unknown counts, archive metadata and builtin-skill claims are not fabricated.
Browser interaction evidence separately verifies local search, the readonly
General controls, keyboard model reorder dispatch and no replay after the
read-only fixture host rejects a write. That fixture evidence is not a real
provider call, durable group save, app installation or credential result.

## Main integration

After the first push, main advanced to `d435690` (PR 108). Only the copy table conflicted: preserve all current-main entries and add the seven Settings keys. Regenerate tokens from the combined visual source. No Work-pane implementation was rewritten; its current-main changes are inherited. The integrated candidate passes typecheck, 211 affected tests and the source/copy checks. The full 1,930-test run has 1,589 passes, 340 optional skips and only the documented macOS case-path failure. Rerun all 150 screen/theme cases before the integration push.

The final residual audit found two unconfigured API rows were fixture gaps, not missing host capabilities. `ConnectionWorkbench.connect` permits an omitted secret reference and `list` returns `credential-required`; the existing Settings test already covers OpenAI without a credential. Add both approved Anthropic/OpenAI metadata rows to B14 and its inherited variants. No credential, provider call, endpoint or UI implementation was added. Rerun the integrated 150 captures after this fixture repair.
