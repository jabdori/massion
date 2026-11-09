# Offline browser screenshot fixtures

These local pages preserve the page layout from the approved B15/B4 artboards. They are mock library/checkout sites, not an assertion that the example domains were contacted. No page is injected into the workbench.

Regenerate with `node scripts/ui-contracts/capture-browser-pages.mjs`. It serves these files only on loopback, opens an isolated script-disabled browser, runs the production `captureBrowserPage` redaction and screenshot routine, then records the PNG plus observed fields in `captured.json`. Fixture addresses map those local documents to their declared example-domain identities. `browser-fixtures.ts` verifies the HTML/CSS and image hashes before using the actual adapter read shapes.

`redaction.html` verifies Korean/English security labels, `name=csc`, and `autocomplete=cc-csc`. Two different private test values must produce identical masked PNG bytes; the ordinary quantity must remain visible and the page's harmless script sentinel must not execute. The report is written to `.runtime/browser-pages/redaction-report.json`.

Sensitive values are synthetic test inputs. The generated PNGs contain only their masks. Edit source HTML/CSS and regenerate; do not edit the PNG or manifest by hand.
