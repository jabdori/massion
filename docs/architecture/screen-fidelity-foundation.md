# E3a: Screen fidelity foundation

The approved screen contracts, copy keys and visual measurements in
`docs/product/screens/` are the source of truth for this slice. Generate one
CSS token layer from `visual.json`, select palettes through the browser system
preference, and reuse semantic roles throughout UI styles. Include geometry,
typography, spacing, radii, motion and keyboard focus values without restructuring
the Work pane, composer or cards.

A small shared Korean lookup reads `copy.ko.json`; the same lookup and table are
embedded in the self-contained browser client. Dynamic values use named
placeholders and remain text, never markup. Convert the shell and conversation
controls, dates and states first; remove forbidden explanatory shell notices.
Offline/failed sends retain the original private draft and command identity,
show a compact resend action. Transport disconnection is shown beside the name
independently of whether an earlier message failed. Unknown
external Work outcomes continue to forbid replay.

Make copy lint blocking for migrated UI files, with regression coverage for
interpolation, generated source drift, and retained-draft/unknown-outcome behavior.
Measure all 75 screens in both system themes before and after, inspect the B2
and B2-offline pairs, and retain remaining layout and unavailable-state gaps in
the PR rather than weakening contracts. No provider, database or external effect
is exercised by the fixture harness.

The browser theme mechanism follows [MDN prefers-color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme)
and [color-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/color-scheme).
Original approved copy entries and contracts remain unchanged. New keys localize
existing technical controls; their provenance is distinguished from prototype
copy. The generator records the existing-style provenance of tokens whose values
were absent from the supplied visual measurements.

## Visual-gate follow-up

Use the quiet line role for structural borders; reserve strong lines for inputs
and secondary controls. The supplied visual spec defines a 2px focus width but
no focus color, so use its muted foreground role for a visible, lower-contrast
ring. Hide the unsupported bare interrupted-answer label until the cards slice.
Place the retained-draft send error immediately after the composer with a 6px
gap. Failed-send identity and transport connection are separate: the failed
fixture disconnects before Send and reconnects before capture, without a product
write reaching the host. Member avatar rendering continues to honor the host's
role token; fix example member roles in fixtures against the approved artboard
rather than assigning colors by display name.

## CI and delivery-outcome correction

A lost response or an unclassified HTTP failure is unknown, including after a
reload. Persist the command identity, original target and delivery classification
before attempting the request; neither the resend action nor normal Submit may
reissue an unknown draft. Only an explicit pre-admission refusal, or the browser
being offline before request dispatch, permits the B2 retry with the same command
ID. A deliberate edit is a new private draft, not a reclassification of an
uncertain earlier submission. Connection status remains independent.

The token generation test must use a fresh caller directory under `os.tmpdir()`;
macOS-only `/private/tmp` is not a portable prerequisite. Relation review tests
must wait on the actual fresh write gate, not the permanently hidden shell notice.

Local draft preparation, uncertain dispatch intent, input persistence and receipt
cleanup share the existing browser recovery lock. Re-read the current delivery
classification inside that lock after asynchronous reads. Pending input edits
retain their original conversation key and newest edit object while waiting;
preparation consumes only the matching persisted edit, and a receipt never
clears a newer unsaved edit. No network request runs while holding the lock.
