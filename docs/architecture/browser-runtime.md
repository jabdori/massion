# Browser session and page snapshots (R-B)

A Work retains bounded, sanitized browser observations: a session identity, first-read time, page count, current address, sanitized PNG, and text/form metadata for accessibility. These are observations, not accepted evidence or effect receipts. The host adapter can only read; submission, payment and sending remain on the existing decision and single-send paths.

The browser service reads through an injected adapter, then records a host-only command through the drain-aware store and the existing Application CAS/idempotency boundary. Reads are pinned to the original feed, Work input and revision. Overlapping identical requests share one read; a newer request supersedes a late response. Unknown commits are reconciled by operation identity and are never retried as effects. A stopped Work, expired run or host drain refuses late writes. Restore validates the additive observation and journal replay.

Only bounded metadata and sanitized PNGs are retained, never HTML, cookies, storage, unmasked screenshots or executable markup. Every input value is masked by default; explicit benign field meanings alone may remain visible. Password, hidden, payment, security/code and authentication identifiers in labels, names or autocomplete always require masking. Classification includes all associated labels, aria-label and aria-labelledby references, title and placeholder. Their values are also removed from reflected page text before capture. Addresses omit credentials, queries and fragments. The real headless adapter is opt-in local configuration and uses a fresh isolated browser session. Tests use injected read shapes and no external network or payments.

The browser pane renders the retained PNG, including the B15 form and B4 checkout, below one page tab strip and a domain-only pill. Sanitized text is screen-reader-only image alternative content. Existing copy.ko.json supplies interface labels. B7 activity and the conversation fold count committed reads. Client generation/feed/selection guards discard late results and remove stale pages. A page never supplies a second submit/payment button.

## Implementation and verification

1. Add failing sanitizer, admission/idempotency, drain and response-order tests; implement the adapter/service and journal validation.
2. Connect the host query and existing pane, with UI tests for feed replacement, deadlines and thread changes.
3. Produce B4/B15/B7 fixtures through the actual service; verify the affected contracts headlessly in both themes and remove only resolved allow-list entries.
4. Run related tests and typecheck; push feat/browser-runtime and open the requested PR. Follow CI and head-specific Codex review for at most four correction rounds. Do not merge.

General automation, form submission, order-history connectors, real payment adapters and acceptance of browser content are out of scope.

## Local adapter and retained bounds

The normal host leaves the adapter off. Local opt-in requires `MASSION_BROWSER_READS=1` and `MASSION_BROWSER_ORIGINS` containing comma-separated exact HTTPS origins. An installed `agent-browser` CLI is required only for that opt-in. It launches a fresh headless session with an explicit empty config, scrubbed environment and domain restriction; it never loads the owner's profile. Before navigation, a retained CDP session disables script execution on the fresh blank page. The raw Blink launch setting was observed to stall screenshots; the protocol-level setting preserves disabled page scripts and allows captures. Each invocation closes its session. The logical Work session retains at most 32 observations. Metadata is bounded to 24,000 serialized characters, 64 text blocks and 64 fields. Each PNG is at most 192 KiB with dimensions up to 2048 pixels; the session has a 1 MiB encoded-image budget. The UI displays captured pixels, never a remote interactive embed. Legacy text-only pages remain readable as metadata but display unavailable instead of a fabricated page image.

The host-owned `server.browserSessions.capture({missionId,workId,readId,address})` is the adapter seam, analogous to the existing effect producer. It is not a public browser command route. The UI reads `/missions/:mission/works/:work/browser`; conversation and Work-list queries carry only the retained count and first observation time. Automatic model-to-browser planning is a follow-up. Existing owner decisions remain the sole effect-admission path.

Verification and remaining screen contracts: [R-B evidence](../acceptance/browser-runtime/README.md).

## Blocking visual correction

The owner rejected the structured-text presentation for B15/B4. Retain a bounded PNG screenshot supplied by the trusted browser adapter after it masks sensitive form fields and reflected values in the DOM. Never take or persist an unmasked screenshot. Existing text-only history remains readable as metadata, but cannot be substituted for the missing page image. The image renders without page scripts, links or form actions. Its sanitized text remains screen-reader-only alternative content.

The browser surface uses one observed-page tab strip and a domain-only address pill. Remove the duplicate Work/browser header row and timestamps/counts inside the page viewport. B15 has its three observed page titles; B4 has the contract's single browser tab. The contract's actor marker remains a small overlay with its existing identity, not an unrelated footer. B7 keeps its R-A-owned step content; only separate browser telemetry spacing and the recorded chat activity line change. Payment merchant copy displays the hostname.

Use locally served reference page fixtures to capture actual sanitized PNGs with the same adapter screenshot routine; commit their source HTML and a reproducible capture script. Recheck image bounds, legacy journal replay, secret masking before capture, feed/selection/generation fencing, then capture B15/B4/B7 in both themes and mobile layouts. Final delivery follows the existing PR/CI/Codex loop.

CSS-generated content is suppressed before capture, with computed-style verification. Arbitrary attribute values use the same private-value scrubber. Author Shadow DOM is explicitly unsupported: the CDP document guard rejects both open and closed roots before the screenshot rather than relying on inaccessible DOM inspection. It also binds pre/post-redaction inspection to one document. These refusals do not fall back to a text reconstruction or an unmasked image.

Uninspectable pixel sources are neutralized before capture rather than guessed clean: image/picture/SVG paint, CSS images/masks/filters/clipping and page-defined fonts, including text pseudo-elements such as first-letter and first-line. Boxes, layout, colors and sanitized ordinary text remain. Computed styles verify the neutralization, and privacy fixtures include base64 SVG content in image, SVG and CSS backgrounds. Unsupported author Shadow DOM remains a refusal. This may omit a site's graphics; it never substitutes an invented screenshot or exposes their unchecked pixels.

Known open security boundary: ordinary CSS primitive drawings can encode private values in retained colors/geometry. Current text/image neutralization does not prove arbitrary-page pixel confidentiality. See `docs/acceptance/browser-runtime/css-primitive-proof.json`; the finding remains a merge blocker, and the local adapter remains off by default.
