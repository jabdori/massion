import {rejectedTextClient} from './rejected-text-panel.ts';
import {prerequisitePanel,prerequisiteClient} from './work-prerequisite-panel.ts';
import {runSequencePanel,runSequenceClient} from './run-sequence-panel.ts';
import {MAX_REQUEST_BODY_BYTES} from './request-limits.ts';
/** Self-contained loopback client. All user and host text is rendered through textContent. */
export const workbenchPage = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Massion · Mission workbench</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#21302d;background:#f4f5f0;font-synthesis:none;--ink:#21302d;--muted:#65726c;--line:#dce2d9;--green:#245b44;--soft:#edf4ee;--warn:#855019;--warn-bg:#fcf3df}*{box-sizing:border-box}body{margin:0}button,input,textarea,select{font:inherit}button,input,textarea,select,summary{outline-offset:4px}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible,pre:focus-visible,.work-title:focus-visible{outline:3px solid #377dba}button{border:1px solid var(--green);border-radius:8px;background:var(--green);color:#fff;padding:10px 15px;font-weight:650;cursor:pointer;min-height:42px}button.secondary{background:#fff;color:var(--ink);border-color:#c9d2c7}button.quiet{background:transparent;color:var(--green);border-color:transparent}button.danger{color:#8a3932;border-color:#e1c7c1;background:#fff}button:disabled{opacity:.48;cursor:not-allowed}input,textarea,select{width:100%;padding:10px 11px;border:1px solid #bfcbbd;border-radius:7px;background:#fff;color:var(--ink);min-width:0}textarea{resize:vertical;line-height:1.5}label{display:block;font-size:.84rem;font-weight:650;margin-bottom:7px}input:disabled,textarea:disabled,select:disabled{background:#f0f2ed}fieldset{padding:0;border:0;margin:0;min-width:0}h1,h2,h3,h4,p{margin-top:0}h1{font-size:clamp(1.8rem,3vw,2.65rem);line-height:1.13;letter-spacing:-.06em;margin-bottom:12px;font-weight:650}h2{font-size:1.05rem;letter-spacing:-.02em;margin-bottom:16px}h3{font-size:1.08rem;line-height:1.45;margin:0}h4{font-size:.85rem;margin:18px 0 8px}p{line-height:1.55}#stored-intervention-panel p{overflow-wrap:anywhere}small,.muted,.hint{color:var(--muted)}small,.hint{font-size:.77rem;line-height:1.5}.hint{margin:7px 0 0}.eyebrow{font-size:.67rem;letter-spacing:.12em;text-transform:uppercase;font-weight:750;color:var(--green);margin-bottom:8px}.shell{max-width:1300px;padding:0 36px;margin:auto}header{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:12px}.brand{display:flex;align-items:center;gap:10px;font-size:1.2rem;letter-spacing:-.04em;font-weight:750}.mark{display:grid;place-items:center;width:31px;height:31px;background:var(--green);color:#fff;border-radius:8px;font-size:1rem}.header-meta{display:flex;align-items:center;gap:10px;font-size:.73rem;color:var(--muted)}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#99a39b;margin-right:5px}.dot.online{background:#44845c}.intro{padding:32px 0 22px;display:flex;justify-content:space-between;align-items:end;gap:20px}.intro p{max-width:610px;margin:0;color:var(--muted);font-size:.9rem}.intro-side{max-width:255px;font-size:.75rem!important}.layout{display:grid;grid-template-columns:minmax(270px,340px) minmax(0,1fr);gap:24px;align-items:start;padding-bottom:32px}.stack{display:grid;gap:18px}.panel{border:1px solid var(--line);background:#fff;border-radius:13px;padding:22px;box-shadow:0 3px 10px #243d2d03}.field{margin-bottom:16px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.spread{justify-content:space-between}.grow{flex:1;min-width:150px}.full{width:100%}.section-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:17px}.section-top h2{margin:0}.tag{display:inline-block;font-size:.69rem;line-height:1.3;padding:5px 8px;border-radius:6px;background:#eff2ec;color:#4d6153;white-space:nowrap}.tag.good{background:#e7f2e9;color:#285b38}.tag.warn{background:var(--warn-bg);color:var(--warn)}.tag.bad{background:#fbece8;color:#8c4037}.notice{padding:13px 15px;border-radius:8px;border:1px solid #e7dbbd;background:var(--warn-bg);color:#77531d;font-size:.82rem;line-height:1.5;margin-bottom:18px}.notice p{margin:0}.status{margin:0 0 19px;font-size:.8rem;line-height:1.5;min-height:20px;color:var(--muted);overflow-wrap:anywhere}.status.error{color:#934438}.status.warning{color:var(--warn)}.status.success{color:var(--green)}.empty{padding:38px 30px;text-align:center;border:1px dashed #becdbb;border-radius:12px;background:#fafcf7}.empty-symbol{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;border:1px solid #d9e5d5;background:#eff5ec;color:#55714d;margin:0 auto 16px;font-size:1.2rem}.empty h2{margin-bottom:9px}.empty p{max-width:410px;margin:0 auto;color:var(--muted);font-size:.86rem}.mission-purpose{font-size:1.4rem;line-height:1.35;letter-spacing:-.03em;margin:0 0 16px;overflow-wrap:anywhere}.facts{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0}.facts dt,.metric dt{font-size:.7rem;color:var(--muted);margin-bottom:5px}.facts dd,.metric dd{margin:0;font-size:.86rem;line-height:1.5;overflow-wrap:anywhere}.facts ul{margin:0;padding-left:17px}.id{font: .7rem ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);overflow-wrap:anywhere}.divider{height:1px;background:var(--line);margin:20px 0}.work-list{display:grid;gap:14px}.work-card{border:1px solid var(--line);border-radius:11px;padding:18px;background:#fff;overflow-wrap:anywhere}.work-title{margin:0 0 10px}.badge-row{display:flex;gap:6px;flex-wrap:wrap;margin:9px 0 15px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;background:#f7f9f4;border-radius:8px;padding:12px;margin:0 0 14px}.metric{margin:0}.metric dd{font-size:.8rem}.work-note{font-size:.8rem;line-height:1.5;margin-bottom:12px;color:var(--muted)}.work-note.warning{color:var(--warn)}details{font-size:.82rem;line-height:1.5}summary{cursor:pointer;font-weight:650;color:var(--green);padding:6px 0}.detail-content{margin-top:10px}.detail-content p,.detail-content ul{margin-bottom:9px}.detail-content ul{padding-left:18px}.detail-content pre,pre{font: .72rem/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f1;border:1px solid #e4e9df;border-radius:7px;padding:12px;max-height:360px;overflow:auto}.controls{border-top:1px solid var(--line);margin-top:14px;padding-top:14px}.steer-form{margin-top:9px}.steer-form .row{align-items:end}.steer-form label{font-size:.75rem}.steer-form textarea{font-size:.83rem}.work-compose{border-top:1px solid var(--line);padding-top:19px;margin-top:22px}.work-compose .budget{width:165px}.event-list{list-style:none;margin:0;padding:0}.event-list li{padding:10px 0;border-top:1px solid #edf0e8;font-size:.8rem;display:flex;justify-content:space-between;gap:10px}.event-list li:first-child{border-top:0}.event-list small{text-align:right}.fixture{background:#f9faf6}.fixture p{font-size:.79rem;margin:10px 0 14px}.footer{font-size:.72rem;color:var(--muted);padding:0 0 30px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}[hidden]{display:none!important}@media(max-width:850px){.shell{padding:0 20px}.layout{grid-template-columns:minmax(240px,300px) minmax(0,1fr);gap:16px}.panel{padding:18px}.intro-side{display:none}.facts{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}.metrics .metric:last-child{grid-column:1/-1}}@media(max-width:650px){header{height:68px}.shell{padding:0 15px}.layout{grid-template-columns:1fr}.intro{padding:26px 0 22px}.header-meta{max-width:180px;text-align:right}.panel{padding:19px}.facts{grid-template-columns:1fr 1fr}.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.metrics .metric:last-child{grid-column:auto}.work-compose .budget{width:100%}.row>button{max-width:100%}}#growth-evaluate-hint{overflow-wrap:anywhere}#growth-create-fields button,#growth-evaluate-fields button{max-width:100%}@media(prefers-reduced-motion:no-preference){button{transition:background .15s,opacity .15s}button:hover:not(:disabled){filter:brightness(.96)}}
#sequence-panel{min-width:0;overflow-wrap:anywhere}#sequence-fields select,#sequence-fields input{margin-bottom:14px}
.execution-form select,.execution-form input,#criteria-oracle{margin-bottom:14px}.execution-form button{margin:7px 8px 0 0}
#conversation-panel{overflow-wrap:anywhere;min-width:0}#conversation-messages{max-width:100%;overflow:auto}
.impact-panel{border-top:1px solid var(--line);margin-top:20px;padding-top:14px;overflow-wrap:anywhere}.impact-results{max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:12px}.impact-results:focus-visible{outline:3px solid #377dba;outline-offset:4px}.impact-results ul{padding-left:20px}.impact-results li{margin-bottom:12px}
</style>
</head>
<body>
<div class="shell">
<header><div class="brand"><span class="mark" aria-hidden="true">m</span>Massion</div><div class="header-meta"><span>Local development</span><span id="health" role="status"><span class="dot"></span>Connecting</span></div></header>
<section class="intro" aria-labelledby="page-title"><div><div class="eyebrow">Purpose → Work → Evidence</div><h1 id="page-title">Work with a reason.<br>Progress you can inspect.</h1><p>Set the Mission, admit bounded Work, and follow its durable state.</p></div><p class="intro-side">Execution and acceptance are separate. A result becomes a Record only after independent evidence.</p></section>
<div id="provider-notice" class="notice" role="status">Checking provider availability. No execution has been requested.</div>
<div id="sync-notice" class="notice" role="status" hidden></div>
<div id="operation-notice" class="notice" role="alert" hidden></div>
<p id="status" class="status" role="status" aria-live="polite">Ready. Create a Mission or load an existing one.</p>
<main class="layout">
<aside class="stack" aria-label="Mission controls">
<section class="panel" aria-labelledby="connection-heading"><h2 id="connection-heading">Connect a model provider</h2><p class="hint">Choose an API provider, discover its models or enter an exact model ID. Connections remain in this host session. API credentials stay with the host; do not paste API keys here. OAuth, subscription CLI and ACP agent sessions are not implemented.</p>
<form id="connection-form"><fieldset id="connection-fields"><label for="connection-kind">Provider API</label><select id="connection-kind"></select><label for="connection-label">Connection name</label><input id="connection-label" maxlength="512" required><label for="connection-base">API base URL</label><input id="connection-base" type="url" required><label for="connection-reference">Host credential reference (optional)</label><input id="connection-reference" maxlength="128" autocomplete="off" placeholder="Opaque reference, never an API key"><label for="connection-mode">Transport</label><select id="connection-mode"><option value="https">HTTPS API</option></select><button type="submit">Save connection</button></fieldset></form><p id="connection-status" class="hint" role="status">Checking connection setup…</p><div id="connection-list"></div></section>
<section class="panel" aria-labelledby="create-heading"><div class="section-top"><h2 id="create-heading">Create a Mission</h2><span class="tag">01 / Purpose</span></div>
<form id="mission-form"><fieldset id="mission-fields">
<div class="field"><label for="purpose">Purpose</label><textarea id="purpose" rows="2" maxlength="16000" placeholder="What outcome should this Mission own?" required></textarea></div>
<div class="field"><label for="scope">Scope</label><input id="scope" maxlength="16000" placeholder="A project or area of responsibility" required></div>
<div class="field"><label for="constraints">Constraints <span class="muted">(optional)</span></label><textarea id="constraints" rows="2" maxlength="16000" placeholder="One constraint per line"></textarea></div>
<div class="field"><label for="criteria">Success criteria</label><textarea id="criteria" rows="3" maxlength="16000" placeholder="What evidence would make the outcome acceptable?" required></textarea><p id="criteria-oracle-hint" class="hint">Saved with the selected acceptance method. Manual review uses manual-review/v1, which this client cannot execute. Bounded text uses bounded-text-review/v1 with independent model review during an explicitly requested Work run. Selecting a method or creating a Mission does not start execution or mark Work accepted.</p></div>
<label for="criteria-oracle">Acceptance method</label><select id="criteria-oracle" aria-describedby="criteria-oracle-hint"><option value="manual-review/v1">Manual review (no model execution)</option><option value="bounded-text-review/v1">Bounded text with independent model review</option></select><button id="create-mission" class="full" type="submit">Create Mission</button>
</fieldset></form></section>
<section class="panel" aria-labelledby="load-heading"><h2 id="load-heading">Continue a Mission</h2><form id="load-form"><label for="mission-id">Mission ID</label><input id="mission-id" maxlength="128" pattern="[a-zA-Z0-9:_-]{1,128}" placeholder="mission:…" required><div class="row" style="margin-top:12px"><button id="load-mission" class="secondary" type="submit">Load / refresh</button></div><p class="hint">Reloads the authoritative snapshot. The last entered ID is remembered on this browser.</p></form></section>
<section class="panel fixture"><details><summary>Development fixture</summary><p>This controlled local fixture creates a separate Mission and runs real local file and process effects. Its predefined outputs demonstrate the lifecycle, not real model competence.</p><button id="run-fixture" class="secondary" type="button">Run development fixture</button><p class="hint">User Work never falls back to this fixture.</p></details></section>
</aside>
<div class="stack">
<section id="empty-state" class="empty"><div class="empty-symbol" aria-hidden="true">↗</div><h2>No Mission selected</h2><p id="empty-message">Start with a purpose and clear success criteria. Your Mission and Work will appear here after the host confirms them.</p></section>
<section id="mission-panel" class="panel" aria-labelledby="mission-heading" hidden><div class="section-top"><h2 id="mission-heading">Mission</h2><span id="revision" class="tag"></span></div><p id="loaded-id" class="id"></p><p><a id="mission-link" href="#" hidden>Open this Mission in another browser</a></p><p class="hint">Copy this link to continue on the same host. Opening it reads current state; it does not start Work or grant access.</p><h3 id="mission-purpose" class="mission-purpose"></h3><dl id="mission-facts" class="facts"></dl><div class="divider"></div><div class="section-top"><h2>Work</h2><span id="work-count" class="tag"></span></div><div id="work-list" class="work-list"></div>
${prerequisitePanel}
${runSequencePanel}
<details id="revision-panel" class="impact-panel"><summary>Revise Mission purpose and acceptance</summary><p class="hint">Only future Work uses these changes. Existing Work keeps its original Mission input and criteria. Scope and constraints stay fixed; editing does not run a model or re-evaluate Work.</p><div id="revision-comparison" tabindex="0" role="region" aria-label="Current Mission and revision draft comparison" class="impact-results"><p id="revision-current" class="hint"></p><p id="revision-base" class="hint"></p></div><form id="revision-form"><fieldset id="revision-fields"><label for="revision-purpose">Revised purpose</label><textarea id="revision-purpose" rows="2" maxlength="16000" required></textarea><label for="revision-version">New criteria version</label><input id="revision-version" type="number" min="1" max="9007199254740991" step="1" required><label for="revision-criteria">Revised success criteria</label><textarea id="revision-criteria" rows="3" maxlength="16000" required></textarea><label for="revision-oracle">Acceptance method</label><select id="revision-oracle"><option value="manual-review/v1">Manual review (no model execution)</option><option value="bounded-text-review/v1">Bounded text with independent model review</option></select><button id="save-revision" type="submit" data-write>Save Mission revision</button><button id="rebase-revision" type="button" class="secondary">Keep draft against current revision</button><button id="discard-revision" type="button" class="secondary">Discard revision draft</button></fieldset></form><p id="revision-status" class="status" role="status" aria-live="polite">Review current purpose and criteria before saving.</p></details>
<details id="organization-panel"><summary>Inspect and revise organization responsibilities</summary><p id="organization-hint" class="hint">Choose an exact saved revision or new definitions. Owner-declared executor and independent verifier responsibilities affect only newly admitted Work. Existing Work and Records retain their original version. Required capabilities are declarations, not measured competence, staffing choices or permission grants. Saving does not execute a model.</p><p id="organization-current" class="hint"></p><form id="organization-form"><fieldset id="organization-fields"><label for="organization-target">Exact source organization revision</label><select id="organization-target" aria-describedby="organization-hint organization-base"><option value="">Choose exact revision or new definitions</option></select><div id="organization-evidence" tabindex="0" role="region" aria-label="Selected stored organization responsibility evidence" class="impact-results"></div><p id="organization-base" class="hint"></p><label for="organization-version">New organization version</label><input id="organization-version" type="number" readonly aria-describedby="organization-base"><label for="organization-executor">Executor responsibility · required text-output</label><textarea id="organization-executor" rows="3" maxlength="2000" required></textarea><label for="organization-verifier">Independent verifier responsibility · required independent-text-review</label><textarea id="organization-verifier" rows="3" maxlength="2000" required></textarea><label for="organization-reason">Reason for this new revision</label><textarea id="organization-reason" rows="2" maxlength="2000" required></textarea><div class="row"><button id="save-organization" type="submit" data-write>Save new responsibility revision</button><button id="review-organization" type="button" class="secondary">Review draft against current revision</button><button id="cancel-organization" type="button" class="secondary">Cancel private responsibility draft</button></div></fieldset></form><p id="organization-status" class="status" role="status" aria-live="polite">Choose a source revision and review its recorded requirements.</p><button id="organization-recheck" type="button" class="secondary">Check pending command receipt</button><p class="hint">If the outcome is unknown, this checks durable receipts. It does not repeat the save or unlock writes from snapshot inference.</p></details>
<details id="growth-create-panel"><summary>Propose a scoped memory improvement</summary><p class="hint">Choose an exact effective baseline and a new inactive learned memory version. Preserve source and counterevidence. Creating a proposal does not evaluate or adopt it.</p><form id="growth-create-form"><fieldset id="growth-create-fields"><label for="growth-create-id">New proposal ID</label><input id="growth-create-id" required maxlength="128"><label for="growth-create-baseline">Exact effective baseline (memory@version)</label><input id="growth-create-baseline" required><label for="growth-create-memory">Candidate memory ID</label><input id="growth-create-memory" required maxlength="128"><label for="growth-create-version">New candidate version</label><input id="growth-create-version" type="number" min="1" required><label for="growth-create-content">Candidate instruction</label><textarea id="growth-create-content" required maxlength="16000"></textarea><label for="growth-create-source">Candidate source</label><textarea id="growth-create-source" required maxlength="16000"></textarea><label for="growth-create-counter">Counterevidence or limitations</label><textarea id="growth-create-counter" required maxlength="16000"></textarea><p id="growth-create-base" class="hint"></p><button id="growth-create-review" type="button">Review proposal against current revision</button><button id="growth-create-submit" type="submit" data-write>Create inactive memory proposal</button></fieldset></form><p id="growth-create-status" role="status" aria-live="polite">Enter an exact baseline, candidate, source and limitations.</p></details>
<details id="growth-panel"><summary>Inspect evaluated memory Growth</summary><p id="growth-hint" class="hint">Inspect stored proposal and evaluation evidence before a deliberate owner adoption or revert. Scores and held-out evidence are recorded evaluation claims, not new model verification. Exact memory versions affect only future Work; existing Work pins remain. No automatic adoption or execution. This development host uses a local owner; remote authentication remains unimplemented.</p><label for="growth-target">Exact stored proposal</label><select id="growth-target" aria-describedby="growth-hint"><option value="">Choose exact proposal</option></select><div id="growth-evidence" tabindex="0" role="region" aria-label="Stored Growth evaluation evidence"></div><p id="growth-base" class="hint"></p><form id="growth-form"><fieldset id="growth-fields"><div class="row"><button id="adopt-growth" type="button">Adopt exact evaluated memory</button><button id="revert-growth" type="button">Revert exact adoption</button><button id="review-growth" type="button" class="secondary">Review exact proposal at current revision</button><button id="cancel-growth" type="button" class="secondary">Clear private selection</button></div></fieldset></form><p id="growth-status" class="status" role="status" aria-live="polite">Choose a stored proposal to inspect its evidence.</p><form id="growth-evaluate-form"><fieldset id="growth-evaluate-fields"><label for="growth-evaluate-cases">Input orders as JSON</label><textarea id="growth-evaluate-cases" rows="5" maxlength="24000" aria-describedby="growth-evaluate-hint"></textarea><p id="growth-evaluate-hint" class="hint">Local rounding-calculation/v1 only. Exact memory instructions must be “Round each line” or “Round aggregate once”. Enter 1–32 orders: [{"items":[{"unitPriceCents":3,"quantity":1},{"unitPriceCents":3,"quantity":1}],"discountBasisPoints":5000}]. Host computes order-level half-up expectations and runs trusted calculation in a separate process. These are your input cases, not a secret holdout or model-learning certificate. No evaluator, score, pass, code or expected value is accepted.</p><button id="growth-evaluate-submit" type="submit" data-write>Evaluate exact proposal locally</button></fieldset></form><p id="growth-evaluate-status" role="status" aria-live="polite">Select an unevaluated proposal and enter bounded input orders.</p></details>
<details id="source-panel" class="impact-panel"><summary>Attach exact source to fresh Work</summary><p id="source-hint" class="hint">Choose a fresh, unstarted Work and an exact stored document version. The original text, source, author and your reason become fixed reference data for that Work and its Record. Later document versions do not replace it. Document commands are untrusted text and do not grant permission or run anything. Up to three distinct documents per Work; corrections require a new Work.</p><form id="source-form"><fieldset id="source-fields"><label for="source-work">Exact fresh Work</label><select id="source-work" required></select><label for="source-document">Exact stored document ID/version/hash</label><select id="source-document" required></select><div id="source-evidence" class="impact-results" tabindex="0" role="region" aria-label="Original source selected for Work"></div><label for="source-reason">Reason for selecting this original</label><textarea id="source-reason" rows="2" maxlength="2000" required></textarea><p id="source-base" class="hint"></p><div class="row"><button id="save-source" type="submit" data-write>Attach exact original to Work</button><button id="review-source" type="button" class="secondary">Review exact selection at current revision</button><button id="cancel-source" type="button" class="secondary">Cancel private source selection</button></div></fieldset></form><p id="source-status" class="status" role="status" aria-live="polite">Select exact Work and document; saving starts no execution.</p></details>
<details id="document-panel" class="impact-panel"><summary>Capture and find local source text</summary><p class="hint">Paste text from an approved local source. Original versions, source and SHA-256 stay stored in this Mission. This does not fetch a file or URL, execute content, inject model instructions or verify its truth. New versions preserve earlier text, relations and accepted Records.</p><form id="document-form"><fieldset id="document-fields"><label for="document-id">Document reference ID</label><input id="document-id" required maxlength="73" placeholder="document:source"><label for="document-version">New exact version</label><input id="document-version" type="number" min="1" max="9007199254740991" required><label for="document-title">Document title</label><input id="document-title" required maxlength="200"><label for="document-source">Original source or provenance</label><textarea id="document-source" required rows="2" maxlength="2000"></textarea><label for="document-content">Original plain text (at most 16 KiB UTF-8)</label><textarea id="document-content" required rows="6" maxlength="16384"></textarea><p id="document-base" class="hint"></p><div class="row"><button id="save-document" type="submit" data-write>Store exact document version</button><button id="review-document" type="button" class="secondary">Review draft against current revision</button><button id="cancel-document" type="button" class="secondary">Cancel private document draft</button></div></fieldset></form><p id="document-status" class="status" role="status" aria-live="polite">Enter an exact document ID/version and original text/source.</p><form id="document-search-form"><label for="document-query">Literal title or content query (case-sensitive, latest versions only)</label><input id="document-query" required maxlength="200"><button id="document-search" type="submit">Search stored source text</button></form><div id="document-search-results" class="impact-results" tabindex="0" role="region" aria-label="Latest document search matches"></div><label for="document-choice">Exact stored document version</label><select id="document-choice"></select><div class="row"><button id="document-read" type="button">Read exact original text</button><button id="document-usage" type="button" aria-describedby="document-use-hint">Find Work and Record uses</button><button id="document-read-cancel" type="button" class="secondary" disabled>Cancel source read</button></div><p id="document-use-hint" class="hint">Find actual pinned uses of the selected exact source in this Mission, with original owner decisions and Record evidence. Up to 20 uses shown; this reads stored evidence, creates no relationship and does not replace inputs or re-evaluate results.</p><div id="document-usage-results" class="impact-results" tabindex="0" role="region" aria-label="Exact source Work and Record uses"></div><p id="document-read-status" class="status" role="status" aria-live="polite">Search or choose an exact historical version. Reads send no command.</p><div id="document-read-results" class="impact-results" tabindex="0" role="region" aria-label="Exact stored document source"></div></details>
<details id="relation-panel" class="impact-panel"><summary>Record an exact relationship</summary><p id="relation-hint" class="hint">Connect exact user reference IDs and versions with source evidence. References may name Work, documents, files or other knowledge; recording them does not prove they exist or ingest their content. This is owner-authored provenance, not model inference or an independent truth verdict. Relations do not schedule Work, invalidate Records or call a provider.</p><form id="relation-form"><fieldset id="relation-fields"><label for="relation-from">Dependent or containing reference ID</label><input id="relation-from" required maxlength="2000"><label for="relation-from-version">Exact source version</label><input id="relation-from-version" type="number" min="1" max="9007199254740991" required><label for="relation-type">Recorded relationship</label><select id="relation-type"><option value="depends-on">Depends on</option><option value="evidenced-by">Evidenced by</option><option value="contains">Contains</option></select><label for="relation-to">Referenced target ID</label><input id="relation-to" required maxlength="2000"><label for="relation-to-version">Exact target version</label><input id="relation-to-version" type="number" min="1" max="9007199254740991" required><label for="relation-provenance">Source or provenance</label><textarea id="relation-provenance" required rows="3" maxlength="2000"></textarea><p id="relation-base" class="hint"></p><div class="row"><button id="save-relation" type="submit" data-write>Record exact relation</button><button id="review-relation" type="button" class="secondary">Review draft against current revision</button><button id="cancel-relation" type="button" class="secondary">Cancel private relation draft</button></div></fieldset></form><p id="relation-status" class="status" role="status" aria-live="polite">Enter exact reference identities, versions and provenance.</p><div id="relation-history" class="impact-results" tabindex="0" role="region" aria-label="Stored exact relationships"></div></details>
<details id="impact-panel" class="impact-panel"><summary>Inspect relation impact</summary><h3 id="impact-heading">Exact-version impact</h3><p id="impact-scope" class="hint"></p><p id="impact-hint" class="hint">Read stored dependencies for an exact entity ID and version in this Mission. Provenance and inferred flags describe recorded relations, not an independent truth verdict. This read does not invalidate results, start Work or call a model.</p><form id="impact-form"><div class="field"><label for="impact-entity">Target entity ID</label><input id="impact-entity" required maxlength="16000" aria-describedby="impact-hint" placeholder="Exact Work, artifact or evidence ID"></div><div class="field"><label for="impact-version">Exact version</label><input id="impact-version" type="number" min="1" max="9007199254740991" step="1" value="1" required aria-describedby="impact-hint"></div><button id="impact-read" type="submit">Read impact</button></form><p id="impact-status" class="status" role="status" aria-live="polite">Choose a target and exact version, then read its impact.</p><div id="impact-results" class="impact-results" tabindex="0" role="region" aria-label="Relation impact results" hidden></div></details>
<details id="memory-panel" class="impact-panel"><summary>Manage Mission memory</summary><h3>Owner-authored instructions for future Work</h3><p id="memory-hint" class="hint">Save an explicit instruction for this Mission. New Work pins its effective version; earlier Work keeps its original memory. This does not run a model or adopt learned memory. Sources are owner-supplied context, not independent verification. Instruction and source each allow up to 16,000 characters; the complete JSON command must fit 32 KiB of UTF-8, including escaping and metadata.</p><p id="memory-scope" class="hint"></p><form id="memory-form"><fieldset id="memory-fields"><label for="memory-id">Memory ID</label><input id="memory-id" required maxlength="128" pattern="[a-zA-Z0-9:_-]{1,128}" aria-describedby="memory-hint" placeholder="memory:instruction"><label for="memory-version">New immutable version</label><input id="memory-version" type="number" min="1" max="9007199254740991" step="1" value="1" required><label for="memory-content">Explicit instruction</label><textarea id="memory-content" rows="3" maxlength="16000" required></textarea><label for="memory-source">Owner-supplied source or reason</label><textarea id="memory-source" rows="2" maxlength="16000" required></textarea><button id="save-memory" type="submit" data-write>Save explicit memory</button></fieldset></form><p id="memory-status" class="status" role="status" aria-live="polite">Save a new ID at version 1, or advance an existing ID to a higher version.</p><h3>Stop an instruction for future Work</h3><p id="retirement-hint" class="hint">Choose one exact active explicit memory version. This stops its application to newly admitted Work. Its original content, history and earlier Work pins stay available; nothing is deleted.</p><form id="retirement-form"><fieldset id="retirement-fields"><label for="retirement-target">Exact active explicit memory</label><select id="retirement-target" required aria-describedby="retirement-hint retirement-base"></select><label for="retirement-reason">Reason for stopping future application</label><textarea id="retirement-reason" rows="2" maxlength="16000" required aria-describedby="retirement-hint"></textarea><p id="retirement-base" class="hint"></p><button id="stop-memory" type="submit" data-write>Stop this version for future Work</button><button id="review-retirement" type="button" class="secondary">Keep exact target against current revision</button><button id="cancel-retirement" type="button" class="secondary">Cancel stop draft</button></fieldset></form><p id="retirement-status" class="status" role="status" aria-live="polite">Choose an exact version and review what will remain.</p><div id="memory-history" class="impact-results" tabindex="0" role="region" aria-label="Mission memory history"></div></details>
<form id="work-form" class="work-compose"><fieldset id="work-fields"><h2>Admit bounded Work</h2><div class="row"><div class="field grow"><label for="work-title">Work title</label><input id="work-title" maxlength="16000" placeholder="A concrete responsibility or deliverable" required></div><div class="field budget"><label id="work-budget-label" for="work-budget">Budget limit (host units)</label><input id="work-budget" type="number" min="0" step="any" value="0" required></div></div><button id="admit-work" type="submit">Add Work</button><p id="work-budget-hint" class="hint">Admission records responsibility and pins criteria, effective memory and the current organization revision. It does not start model execution.</p></fieldset></form>
<details id="conversation-panel" style="margin-top:22px"><summary id="conversation-summary">Work conversation · messages and replies</summary><p id="conversation-hint" class="hint">Owner discussion is saved for this exact Work and shared through the host. It does not steer execution, change accepted evidence or authorize retries. Up to 100 messages per thread; each message is at most 4 KiB of UTF-8. Private drafts stay in this open client during state refresh.</p><form id="conversation-form"><fieldset id="conversation-fields"><label for="conversation-target">Exact Work conversation</label><select id="conversation-target" required aria-describedby="conversation-hint conversation-base"></select><div id="conversation-messages" tabindex="0" role="region" aria-label="Stored original Work conversation"></div><p id="conversation-base" class="hint"></p><label for="conversation-reply">Reply to an exact earlier message</label><select id="conversation-reply"><option value="">New message</option></select><label for="conversation-text">Message · owner discussion</label><textarea id="conversation-text" rows="3" maxlength="4096" required></textarea><div class="row"><button id="conversation-send" type="submit" data-write>Save owner message</button><button id="conversation-review" type="button" class="secondary">Review draft against current state</button><button id="conversation-cancel" type="button" class="secondary">Clear private message draft</button></div></fieldset></form><p id="conversation-status" class="status" role="status" aria-live="polite">Choose exact Work to read its discussion or write a message.</p></details>
<details id="budget-panel" style="margin-top:22px"><summary>Change fresh Work budget</summary><p id="budget-hint" class="hint">Only fresh, unstarted Work may change. Existing inputs, history, reservations and measured usage remain. This does not grant permission, start execution or change an active run cap. Output tokens are not a money or total-token ceiling. When unit is absent it is not pinned yet. Reason and prior limits remain in the host journal.</p><form id="budget-form"><fieldset id="budget-fields"><label for="budget-target">Exact fresh Work</label><select id="budget-target" required aria-describedby="budget-hint budget-current budget-base"></select><p id="budget-current" class="hint"></p><label for="budget-limit">New budget limit in the shown unit</label><input id="budget-limit" type="number" min="0" step="any" required><label for="budget-reason">Reason for changing the limit</label><textarea id="budget-reason" rows="2" maxlength="16000" required></textarea><p id="budget-base" class="hint"></p><div class="row"><button id="save-budget" type="submit" data-write>Change budget limit</button><button id="review-budget" type="button" class="secondary">Review exact Work at current revision</button><button id="cancel-budget" type="button" class="secondary">Cancel budget draft</button></div></fieldset></form><p id="budget-status" class="status" role="status"></p><details><summary>Recent observed budget reasons</summary><p class="hint">Up to eight changes observed by this browser, not complete history. Refreshing or using another browser may show fewer events.</p><div id="budget-history"></div></details><details id="stored-budget-panel"><summary>Read stored budget changes</summary><p id="stored-budget-hint" class="hint">Read recorded owner changes for exact Work, including historical Work. This does not edit your budget draft, grant permission or run anything. Each page scans up to 20 journal batches and may contain no matching changes. Read more until the frozen boundary is reached. Up to 200 changes are kept in this view; use the history API for larger histories. New writes require a new initial read.</p><label for="stored-budget-target">Exact Work for stored history</label><select id="stored-budget-target" aria-describedby="stored-budget-hint"><option value="">Choose exact Work</option></select><div class="row"><button id="stored-budget-read" type="button">Read stored history</button><button id="stored-budget-more" type="button" class="secondary">Read next history page</button><button id="stored-budget-cancel" type="button" class="secondary">Cancel history read</button></div><p id="stored-budget-status" class="status" role="status" aria-live="polite">Choose Work, then read its stored budget changes.</p><div id="stored-budget-results" tabindex="0" role="region" aria-label="Stored Work budget changes"></div></details></details><details id="stored-intervention-panel"><summary>Inspect recorded owner interventions</summary><p id="stored-intervention-hint" class="hint">Read committed steer, cancel, permanent quarantine and expired-run closure commands for exact Work, including historical Work. Command identity and revision describe recorded intent, not proof of external stop or execution. This does not edit your budget draft, grant permission or run anything. Each page scans up to 20 journal batches and may contain no matching changes. Read more until the frozen boundary is reached. Up to 200 changes are kept in this view; use the history API for larger histories. New writes require a new initial read.</p><label for="stored-intervention-target">Exact Work for stored history</label><select id="stored-intervention-target" aria-describedby="stored-intervention-hint"><option value="">Choose exact Work</option></select><div class="row"><button id="stored-intervention-read" type="button">Read stored history</button><button id="stored-intervention-more" type="button" class="secondary">Read next history page</button><button id="stored-intervention-cancel" type="button" class="secondary">Cancel history read</button></div><p id="stored-intervention-status" class="status" role="status" aria-live="polite">Choose Work, then read its stored owner interventions.</p><div id="stored-intervention-results" tabindex="0" role="region" aria-label="Stored Work owner interventions"></div></details>
<details style="margin-top:22px"><summary>Authoritative snapshot</summary><pre id="snapshot-json" tabindex="0"></pre></details></section>
<section class="panel" aria-labelledby="activity-heading"><div class="section-top"><h2 id="activity-heading">Durable activity</h2><span id="event-state" class="tag" role="status">Connecting</span></div><p id="event-help" class="hint" style="margin-bottom:10px">Reading committed events. No progress is inferred from a model response.</p><ul id="event-list" class="event-list"><li>No activity loaded yet.</li></ul><small id="snapshot-time"></small></section>
</div>
</main>
<footer class="footer">Loopback workbench · SurrealDB is authoritative · Closing this page does not cancel Work</footer>
</div>
<script>
'use strict';
const $ = id => document.getElementById(id);
const storage = {
  readable:true,
  get(key){try{return localStorage.getItem(key);}catch{this.readable=false;return null;}},
  set(key,value){try{localStorage.setItem(key,value);return localStorage.getItem(key)===value;}catch{return false;}},
  remove(key){try{localStorage.removeItem(key);return localStorage.getItem(key)===null;}catch{return false;}}
};
const missionKey = 'massion.workbench.mission';
const cursorKey = 'massion.workbench.cursor';
const feedKey = 'massion.workbench.feed';
const pendingKey = 'massion.workbench.pending';
const fixtureKey = 'massion.workbench.fixture-pending';
function missionReference() {
  const fragment = window.location.hash;
  if (!fragment) return {present:false,id:''};
  if (fragment.length > 393 || !fragment.startsWith('#mission=')) return {present:true,id:''};
  try { const id = decodeURIComponent(fragment.slice(9)); return {present:true,id:/^[a-zA-Z0-9:_-]{1,128}$/.test(id) ? id : ''}; }
  catch { return {present:true,id:''}; }
}
const initialReference = missionReference();
let selectedId = initialReference.present ? initialReference.id : storage.get(missionKey) || storage.get('massion.fixture.mission') || '';
let cursor = Number(storage.get(cursorKey) || 0);
if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
let feedId = storage.get(feedKey) || '';
let snapshot = null, busy = false, loading = false, readSequence = 0, polling = false, reconnectRequired = true, connectionEpoch = 0;
let unknownOperation = null, providerSelection = null, providerKnown = false, runtimeConfiguration = null, activity = [], eventRefreshNeeded = false;
let recoveryProblem = '', fixtureUnknown = storage.get(fixtureKey) !== null;
let impactSequence = 0, impactReading = false, impactFocus = null;
let sourceMission='',sourceFocus=null;const sourceDrafts=new Map(),sourceSubmissions=new Map(),sourceStatuses=new Map();
let documentMission='',documentFocus=null,documentReadSequence=0,documentReadController=null,documentReadMode='search';
const documentIds=['document-id','document-version','document-title','document-source','document-content'],documentDrafts=new Map(),documentSubmissions=new Map(),documentStatuses=new Map(),documentChoices=new Map();
let relationMission="",relationFocus=null;
const relationDrafts=new Map(),relationSubmissions=new Map(),relationStatuses=new Map(),relationIds=["relation-from","relation-from-version","relation-type","relation-to","relation-to-version","relation-provenance"];
let organizationMission = "", organizationFocus = null;
const organizationDrafts = new Map(), organizationSubmissions = new Map(), organizationStatuses = new Map(), organizationIds = ["organization-executor","organization-verifier","organization-reason"];
let revisionMission = "", revisionFocus = null;
const revisionSubmissions = new Map(), revisionDrafts = new Map(), revisionIds = ["revision-purpose","revision-version","revision-criteria","revision-oracle"];
let budgetMission = "", budgetFocus = null;
const budgetDrafts = new Map(), budgetSelections = new Map(), budgetStatuses = new Map(), budgetSubmissions = new Map();
let storedBudgetState = null, storedBudgetSequence = 0, storedBudgetController = null;
const storedBudgetSelections = new Map();
let storedInterventionState = null, storedInterventionSequence = 0, storedInterventionController = null;
const storedInterventionSelections = new Map();
const recordTextReads = new Map();
let retirementMission = "", retirementFocus = null;
const retirementDrafts = new Map(), retirementSubmissions = new Map();
const growthDrafts = new Map(), growthSubmissions = new Map();
let growthFocus = null;
let memoryMission = "", memoryFocus = null;
const memoryDrafts = new Map(), memoryIds = ["memory-id","memory-version","memory-content","memory-source"];
const conversationDrafts=new Map(),conversationSelections=new Map(),conversationStatuses=new Map(),conversationSubmissions=new Map();
const drafts = new Map(), instructionConflicts = new Map(), instructionSubmissions = new Map(), confirmedOperations = new Set();
const instructionKey = (missionId, workId) => JSON.stringify([missionId, workId]);
function confirmOperation(operation) {
  sequenceAdmissionObserved(operation);
  const operationId = operationKey(operation); confirmedOperations.add(operationId);
  if(prerequisiteSubmissions.has(operationId)&&snapshot?.value.id===operation.missionId&&selectedId===operation.missionId)renderPrerequisites();
  if(sourceSubmissions.has(operationId) && snapshot?.value.id===operation.missionId && selectedId===operation.missionId)renderSources();
  if(documentSubmissions.has(operationId) && snapshot?.value.id===operation.missionId && selectedId===operation.missionId)renderDocuments();
  if(relationSubmissions.has(operationId) && snapshot?.value.id===operation.missionId && selectedId===operation.missionId)renderRelations();
  if (organizationSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderOrganization();
  if (revisionSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderRevision();
  if (retirementSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderRetirement();
  if (budgetSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderBudget();
  if (growthSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderGrowth();
  const conversationSubmission=conversationSubmissions.get(operationId);
  if(conversationSubmission){conversationSubmissions.delete(operationId);const key=instructionKey(conversationSubmission.missionId,conversationSubmission.workId),draft=conversationDrafts.get(key);if(draft===conversationSubmission.draft&&draft.text===conversationSubmission.text&&draft.replyTo===conversationSubmission.replyTo)conversationDrafts.delete(key);conversationStatuses.set(key,'Exact owner message confirmed. Original Work execution and evidence retained.');}
  const submission = instructionSubmissions.get(operationId);
  if (!submission) return;
  instructionSubmissions.delete(operationId);
  const key = instructionKey(submission.missionId, submission.workId);
  if (drafts.get(key) === submission.draft) drafts.delete(key);
  instructionConflicts.delete(key);
  if (snapshot?.value.id === submission.missionId) renderMission();
}
function parsePending(raw) {
  const item = JSON.parse(raw);
  if (!item || Object.keys(item).length !== 3 || typeof item.commandId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(item.commandId) || typeof item.missionId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(item.missionId) || !Number.isSafeInteger(item.reconcileCursor) || item.reconcileCursor < 0) throw new Error('Invalid recovery reference');
  return {commandId:item.commandId,missionId:item.missionId,reconcileCursor:item.reconcileCursor};
}
const restoredPending = storage.get(pendingKey);
if (restoredPending !== null) {
  try { unknownOperation = parsePending(restoredPending); selectedId = unknownOperation.missionId; }
  catch { recoveryProblem = 'Pending command recovery data is unreadable. Writes are locked. Inspect the host state before repairing this browser’s recovery data; an earlier command may have committed.'; }
}
if (!storage.readable) recoveryProblem = 'Browser recovery storage is unavailable. Writes are locked; reading Mission state is still available.';
if (!globalThis.navigator || !navigator.locks || typeof navigator.locks.request !== 'function') recoveryProblem = 'This browser cannot coordinate safe writes across tabs (Web Locks unavailable). Read-only access remains available.';
function operationKey(operation) { return operation.missionId + '@' + operation.commandId; }
async function withRecoveryLock(action, nonblocking = true) {
  if (!globalThis.navigator || !navigator.locks || typeof navigator.locks.request !== 'function') { recoveryProblem = 'This browser cannot coordinate safe writes across tabs (Web Locks unavailable). No command was sent; read-only access remains available.'; controls(); return {acquired:false}; }
  try { return await navigator.locks.request('massion.workbench.recovery', {mode:'exclusive',ifAvailable:nonblocking}, lock => lock ? {acquired:true,value:action()} : {acquired:false}); }
  catch { recoveryProblem = 'Browser write coordination is unavailable. Writes are locked; read-only access remains available.'; controls(); return {acquired:false}; }
}
async function persistPending(operation) {
  const result = await withRecoveryLock(() => {
    const existing = storage.get(pendingKey);
    if (!storage.readable) { recoveryProblem = 'Browser recovery storage is unavailable. No new command was sent. Read-only access remains available.'; return false; }
    if (existing !== null) {
      try { unknownOperation = parsePending(existing); }
      catch { recoveryProblem = 'Pending command recovery data is unreadable. Writes are locked until the host outcome and browser recovery data are inspected.'; }
      report('An earlier command still requires reconciliation. No new command was sent.','warning'); return false;
    }
    if (!storage.set(pendingKey, JSON.stringify(operation))) {
      recoveryProblem = 'Could not save the pending command reference in this browser. No command was sent. Read-only access remains available.';
      report(recoveryProblem,'error'); return false;
    }
    unknownOperation = operation;
    return true;
  });
  if (!result.acquired && !recoveryProblem) report('Another tab is updating command recovery. No command was sent. Inspect its pending state before trying again.','warning');
  controls(); return result.acquired && result.value;
}
async function clearPending(operation) {
  if (!confirmedOperations.has(operationKey(operation))) { instructionSubmissions.delete(operationKey(operation)); prerequisiteSubmissions.delete(operationKey(operation)); sourceSubmissions.delete(operationKey(operation)); documentSubmissions.delete(operationKey(operation)); relationSubmissions.delete(operationKey(operation)); organizationSubmissions.delete(operationKey(operation)); revisionSubmissions.delete(operationKey(operation)); retirementSubmissions.delete(operationKey(operation)); budgetSubmissions.delete(operationKey(operation)); growthSubmissions.delete(operationKey(operation)); conversationSubmissions.delete(operationKey(operation)); }
  const result = await withRecoveryLock(() => {
    const saved = storage.get(pendingKey);
    if (!storage.readable) { recoveryProblem = 'The command outcome was confirmed, but recovery storage cannot be read. Writes remain locked.'; return false; }
    if (saved !== null) {
      let stored;
      try { stored = parsePending(saved); } catch { recoveryProblem = 'The command outcome was confirmed, but its browser recovery data is unreadable. Writes remain locked.'; return false; }
      if (operationKey(stored) !== operationKey(operation)) { unknownOperation = stored; return false; }
      if (!storage.remove(pendingKey)) { recoveryProblem = 'The command outcome was confirmed, but its browser recovery reference could not be cleared. Writes remain locked.'; return false; }
    }
    if (unknownOperation && operationKey(unknownOperation) === operationKey(operation)) unknownOperation = null;
    return true;
  }, false);
  return result.acquired && result.value;
}
async function claimFixture() {
  const result = await withRecoveryLock(() => {
    const existing = storage.get(pendingKey);
    if (existing !== null) {
      try { unknownOperation = parsePending(existing); } catch { recoveryProblem = 'Pending command recovery data is unreadable. Writes are locked.'; }
      report('An earlier command requires reconciliation. No fixture request was sent.','warning'); return false;
    }
    if (storage.get(fixtureKey) !== null) { fixtureUnknown = true; return false; }
    if (!storage.readable || !storage.set(fixtureKey, 'pending')) { recoveryProblem = 'Could not save the fixture recovery marker. No fixture request was sent. Read-only access remains available.'; report(recoveryProblem,'error'); return false; }
    fixtureUnknown = true; return true;
  });
  if (!result.acquired && !recoveryProblem) report('Another tab is updating recovery state. No fixture request was sent.','warning');
  controls(); return result.acquired && result.value;
}
async function clearFixture() {
  const result = await withRecoveryLock(() => {
    const marker = storage.get(fixtureKey);
    if (!storage.readable || (marker !== null && marker !== 'pending')) return false;
    return marker === null || storage.remove(fixtureKey);
  }, false);
  fixtureUnknown = !(result.acquired && result.value);
}
$('mission-id').value = selectedId;
function element(tag, text, className) { const item = document.createElement(tag); if (tag === 'pre') item.tabIndex = 0; if (text !== undefined) item.textContent = String(text); if (className) item.className = className; return item; }
function workElement(work, tag, text, key) { const item = element(tag,text); item.id = 'work-' + key + '-' + work.id; return item; }
function restoreControlFocus(previous, targetId) {
  const active = document.activeElement;
  if (!active || active.tagName === 'BODY' || active === previous || (active.id && active.id === previous?.id)) document.getElementById(targetId)?.focus();
}
function report(message, tone = '') { $('status').textContent = message; $('status').className = 'status' + (tone ? ' ' + tone : ''); }
function controls() {
  const locked = reconnectRequired || busy || loading || !!unknownOperation || !!recoveryProblem;
  $('sync-notice').hidden = !reconnectRequired;
  $('sync-notice').textContent = reconnectRequired ? 'New actions are paused until current host state and permissions are refreshed. Mission reads and your drafts remain available. No command is retried.' : '';
  $('mission-fields').disabled = locked;
  connectionControls();
  $('work-fields').disabled = locked || !snapshot;
  const sourceActive=document.activeElement;
  if(!sourceFocus && snapshot?.value.id===selectedId && !$('source-fields').disabled && $('source-fields').contains(sourceActive))sourceFocus={missionId:selectedId,previous:sourceActive,targetId:sourceActive.id};
  $('source-fields').disabled=locked || snapshot?.value.id!==selectedId;
  if(sourceFocus && !$('source-fields').disabled){const focus=sourceFocus;sourceFocus=null;if(selectedId===focus.missionId)restoreControlFocus(focus.previous,focus.targetId);}
  const documentActive=document.activeElement;
  if(!documentFocus && snapshot?.value.id===selectedId && !$('document-fields').disabled && $('document-fields').contains(documentActive))documentFocus={missionId:selectedId,previous:documentActive,targetId:documentActive.id};
  $('document-fields').disabled=locked || snapshot?.value.id!==selectedId;
  if(documentFocus && !$('document-fields').disabled){const focus=documentFocus;documentFocus=null;if(selectedId===focus.missionId)restoreControlFocus(focus.previous,focus.targetId);}
  documentReadControls();
  const relationActive=document.activeElement;
  if(!relationFocus && snapshot && snapshot.value.id===selectedId && !$('relation-fields').disabled && $('relation-fields').contains(relationActive))relationFocus={missionId:selectedId,previous:relationActive,targetId:relationActive.id};
  $('relation-fields').disabled=locked || !snapshot || snapshot.value.id!==selectedId;
  if(relationFocus && !$('relation-fields').disabled){const focus=relationFocus;relationFocus=null;if(selectedId===focus.missionId)restoreControlFocus(focus.previous,focus.targetId);}
  const organizationActive = document.activeElement;
  if(!organizationFocus && snapshot && snapshot.value.id===selectedId && !$('organization-fields').disabled && $('organization-fields').contains(organizationActive))organizationFocus={missionId:selectedId,previous:organizationActive,targetId:organizationActive.id};
  $('organization-fields').disabled=locked || !snapshot || snapshot.value.id!==selectedId;
  if(organizationFocus && !$('organization-fields').disabled){const focus=organizationFocus;organizationFocus=null;if(selectedId===focus.missionId)restoreControlFocus(focus.previous,focus.targetId);}
  const revisionActive = document.activeElement;
  if (snapshot && snapshot.value.id === selectedId && !$('revision-fields').disabled && $('revision-fields').contains(revisionActive)) revisionFocus = {missionId:selectedId,previous:revisionActive,targetId:revisionActive.id};
  $('revision-fields').disabled = locked || !snapshot || snapshot.value.id !== selectedId;
  if (revisionFocus && !$('revision-fields').disabled) { const focus = revisionFocus; revisionFocus = null; if (snapshot.value.id === focus.missionId && selectedId === focus.missionId) restoreControlFocus(focus.previous,focus.targetId); }

  const memoryActive = document.activeElement;
  if (snapshot && snapshot.value.id === selectedId && !$('memory-fields').disabled && $('memory-fields').contains(memoryActive)) memoryFocus = {missionId:selectedId,previous:memoryActive,targetId:memoryActive.id};
  $('memory-fields').disabled = locked || !snapshot || snapshot.value.id !== selectedId;
  if (memoryFocus && !$('memory-fields').disabled) { const focus = memoryFocus; memoryFocus = null; if (snapshot.value.id === focus.missionId && selectedId === focus.missionId) restoreControlFocus(focus.previous,focus.targetId); }
  const retirementActive = document.activeElement;
  if (snapshot && snapshot.value.id === selectedId && !$('retirement-fields').disabled && $('retirement-fields').contains(retirementActive)) retirementFocus = {missionId:selectedId,previous:retirementActive,targetId:retirementActive.id};
  $('retirement-fields').disabled = locked || !snapshot || snapshot.value.id !== selectedId;
  if (retirementFocus && !$('retirement-fields').disabled) { const focus = retirementFocus; retirementFocus = null; if (snapshot.value.id === focus.missionId && selectedId === focus.missionId) restoreControlFocus(focus.previous,focus.targetId); }
  const budgetActive = document.activeElement;
  if (snapshot && snapshot.value.id === selectedId && !$('budget-fields').disabled && $('budget-fields').contains(budgetActive)) budgetFocus = {missionId:selectedId,previous:budgetActive,targetId:budgetActive.id};
  $('budget-fields').disabled = locked || !snapshot || snapshot.value.id !== selectedId;
  if (budgetFocus && !$('budget-fields').disabled) { const focus = budgetFocus; budgetFocus = null; if (selectedId === focus.missionId) restoreControlFocus(focus.previous,focus.targetId); }
  $('load-mission').disabled = busy;
  $('mission-id').disabled = busy;
  $('run-fixture').disabled = locked || fixtureUnknown;
  for (const button of document.querySelectorAll('[data-write]')) button.disabled = locked;
  $('save-budget').disabled = locked || !snapshot || !budgetFresh(budgetWork());
  $('review-budget').disabled = locked || !snapshot || !budgetFresh(budgetWork());
  $('create-mission').textContent = busy ? 'Command in flight…' : 'Create Mission';
  $('mission-panel').setAttribute('aria-busy', String(busy || loading));
  const notice = $('operation-notice');
  notice.hidden = !unknownOperation && !recoveryProblem && !fixtureUnknown;
  notice.textContent = recoveryProblem || (unknownOperation ? (confirmedOperations.has(operationKey(unknownOperation)) ? 'Confirmed command awaiting browser recovery cleanup: ' : busy ? 'Command in flight: ' : 'Outcome unknown for command ') + unknownOperation.commandId + '. Its recovery reference is saved on this browser. Checking durable receipts; no write will be replayed, including after reload.' : fixtureUnknown ? 'A development fixture has no confirmed outcome in this browser. Fixture reruns are locked, including after reload. Inspect durable activity and the local host logs to identify its Mission and outcome; ordinary Mission reads remain available.' : '');
  conversationControls(); organizationControls(); impactControls(); storedBudgetControls(); storedInterventionControls(); growthControls(); growthCreationControls(); recordTextControls(); rejectedControls(); sequenceControls(); prerequisiteControls();
}
function impactControls() {
  const current = snapshot && snapshot.value.id === selectedId;
  $('impact-read').disabled = !current || !feedId || loading || impactReading;
  $('impact-scope').textContent = current ? 'Mission: ' + snapshot.value.id + ' · Scope: ' + snapshot.value.scope + ' · Current revision: ' + snapshot.revision : 'No current Mission selected.';
  $('impact-results').setAttribute('aria-busy',String(impactReading));
  if (impactFocus && !$('impact-read').disabled) { const pending = impactFocus; impactFocus = null; if (currentImpact(pending.choice)) restoreControlFocus(pending.previous,'impact-read'); }
}
function invalidateImpact(message = 'Selection changed. Read impact again for this exact target and version.') {
  ++impactSequence; impactReading = false; impactFocus = null;
  $('impact-results').replaceChildren(); $('impact-results').hidden = true;
  $('impact-status').textContent = message; $('impact-status').className = 'status'; impactControls();
}
function currentImpact(choice) {
  return choice.sequence === impactSequence && snapshot && snapshot.value.id === choice.missionId && selectedId === choice.missionId &&
    snapshot.revision === choice.revision && feedId === choice.feedId && connectionEpoch === choice.epoch &&
    $('impact-entity').value === choice.entity && $('impact-version').value === choice.versionText;
}
function validImpact(body, choice) {
  const positive = value => Number.isSafeInteger(value) && value > 0;
  return body && body.missionId === choice.missionId && body.revision === choice.revision && body.feedId === choice.feedId && Number.isSafeInteger(body.cursor) && body.cursor >= 0 &&
    body.changed?.id === choice.entity && body.changed?.version === choice.version && Array.isArray(body.affected) && body.affected.every(id => typeof id === 'string') &&
    new Set(body.affected).size === body.affected.length && Array.isArray(body.relations) && body.relations.length <= 1000 && body.relations.every(edge => edge &&
      typeof edge.from === 'string' && !!edge.from.trim() && typeof edge.to === 'string' && !!edge.to.trim() && positive(edge.fromVersion) && positive(edge.toVersion) &&
      ['depends-on','evidenced-by','contains'].includes(edge.type) && typeof edge.provenance === 'string' && !!edge.provenance.trim() && typeof edge.inferred === 'boolean') &&
    new Set(body.relations.map(edge => edge.from + '@' + edge.fromVersion)).size === body.affected.length && body.affected.every(id => body.relations.some(edge => edge.from + '@' + edge.fromVersion === id));
}
function renderImpact(body) {
  const area = $('impact-results'); area.replaceChildren(); area.hidden = false;
  area.append(element('p','Mission: ' + body.missionId + ' · Read revision: ' + body.revision,'hint'));
  area.append(element('h4','Changed target'),element('p',body.changed.id + ' · exact version ' + body.changed.version));
  area.append(element('h4','Impacted versions'));
  if (!body.affected.length) area.append(element('p','No stored relation links a dependent version to this target and version in this Mission.'));
  else { const list = element('ul'); for (const id of body.affected) list.append(element('li',id)); area.append(list); }
  area.append(element('h4','Recorded relations and provenance'));
  if (!body.relations.length) area.append(element('p','No supporting relations were found.'));
  else { const list = element('ul'); for (const edge of body.relations) { const row = element('li'); row.append(element('p',edge.from + ' · v' + edge.fromVersion + ' → ' + edge.to + ' · v' + edge.toVersion + ' · ' + edge.type),element('p','Provenance: ' + edge.provenance + ' · Inferred: ' + (edge.inferred ? 'yes' : 'no'),'hint')); list.append(row); } area.append(list); }
}
for (const id of ['impact-entity','impact-version']) for (const event of ['input','change']) $(id).addEventListener(event,() => invalidateImpact());
$('impact-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!snapshot || snapshot.value.id !== selectedId || !feedId || loading || impactReading) return;
  const entity = $('impact-entity').value, versionText = $('impact-version').value, version = Number(versionText);
  invalidateImpact();
  if (!entity.trim() || !Number.isSafeInteger(version) || version < 1) { $('impact-status').textContent = 'Enter an exact entity ID and a positive safe integer version. No query was sent.'; $('impact-status').className = 'status error'; return; }
  const choice = {sequence:impactSequence,missionId:snapshot.value.id,revision:snapshot.revision,feedId,epoch:connectionEpoch,entity,version,versionText}, submittedFocus = document.activeElement;
  impactReading = true; impactControls(); $('impact-status').textContent = 'Reading exact-version impact in this Mission…';
  try {
    const {response,body} = await request('/missions/' + encodeURIComponent(choice.missionId) + '/impact?entity=' + encodeURIComponent(entity) + '&version=' + version);
    if (!currentImpact(choice)) return;
    if (!response.ok) throw new Error(body.error || 'Impact read failed (' + response.status + ').');
    if (body.feedId !== choice.feedId) { requireReconnect(); $('impact-status').textContent = 'The database changed. Refresh current Mission state before reading impact again; no old result is shown.'; return; }
    if (!validImpact(body,choice)) throw new Error('The reply does not match the selected Mission revision, target, version or relation evidence. Refresh current Mission state before another read.');
    renderImpact(body); $('impact-status').textContent = body.affected.length ? 'Impact read complete. Stored dependencies are shown; no Work or result was changed.' : 'Impact read complete. No dependent versions were found; this does not establish that the target exists.';
  } catch(error) { if (currentImpact(choice)) { $('impact-status').textContent = 'Impact unavailable: ' + error.message; $('impact-status').className = 'status error'; } }
  finally { if (currentImpact(choice)) { impactReading = false; if (submittedFocus === $('impact-read')) impactFocus = {choice,previous:submittedFocus}; impactControls(); } }
});
async function request(path, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {...options, signal: controller.signal, cache:'no-store'});
    let body;
    try { body = await response.json(); } catch { throw new Error('The host returned an unreadable response.'); }
    return {response, body};
  } finally { clearTimeout(timer); }
}
function validSnapshot(value, id) { return value && Number.isSafeInteger(value.revision) && value.revision > 0 && value.value && value.value.id === id && Array.isArray(value.value.works); }
function rememberMission(id) { selectedId = id; $('mission-id').value = id; storage.set(missionKey, id); }
function clearSnapshot(message) {
  switchSourceDraft('');sourceFocus=null;
  switchDocumentDraft('');documentFocus=null;invalidateDocumentRead('No current Mission source snapshot is available.');
  switchRelationDraft('');relationFocus=null;
  switchOrganizationDraft(''); organizationFocus=null;
  switchRevisionDraft(''); revisionFocus = null;
  switchMemoryDraft(''); memoryFocus = null; $('memory-history').replaceChildren();
  snapshot = null; restoreMissionAddress();
  invalidateImpact('No current Mission snapshot is available. Load current state before reading impact.');
  $('mission-panel').hidden = true;
  $('empty-state').hidden = false;
  $('empty-message').textContent = message;
  $('snapshot-json').textContent = '';
  $('mission-link').hidden = true; $('mission-link').setAttribute('href','#');
  $('work-list').replaceChildren(); executionForms.clear();
  $('snapshot-time').textContent = 'No current snapshot is available.';
  controls();
}
function installSnapshot(value) {
  const changed = !snapshot || JSON.stringify(snapshot) !== JSON.stringify({revision:value.revision,value:value.value});
  switchMemoryDraft(value.value.id);
  snapshot = {revision:value.revision, value:value.value};
  if (changed) invalidateDocumentRead('Mission state changed. Read exact source again.');
  if (changed) invalidateImpact('Mission state changed. Choose a target and read its exact-version impact.');
  window.history.replaceState(null, '', '#mission=' + encodeURIComponent(value.value.id));
  $('empty-state').hidden = true;
  $('mission-panel').hidden = false;
  $('snapshot-time').textContent = 'Snapshot read at ' + new Date().toLocaleTimeString() + ' · revision ' + value.revision;
  if (changed) renderMission();
  controls();
}
async function loadMission(id = selectedId, announce = true) {
  if (!id || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) { report('Enter a valid Mission ID.', 'error'); return false; }
  const changed = id !== selectedId;
  rememberMission(id);
  if (changed) { clearSnapshot('Loading the selected Mission…'); activity = []; renderActivity(); }
  const sequence = ++readSequence;
  const readFeed = feedId, epoch = connectionEpoch;
  loading = true; controls();
  if (announce && !unknownOperation) report('Reading authoritative Mission state…');
  try {
    const {response, body:packet} = await request(readFeed ? '/read-state?mission=' + encodeURIComponent(id) : '/missions/' + encodeURIComponent(id));
    if (sequence !== readSequence || id !== selectedId) return false;
    if (epoch !== connectionEpoch || readFeed && packet.feedId !== readFeed) { requireReconnect(); throw new Error('Database or connection changed during Mission read; fresh permissions and state are required'); }
    const body = readFeed ? packet.snapshot : packet;
    if (!response.ok) throw new Error(packet.error || 'Mission read failed (' + response.status + ').');
    if (!validSnapshot(body, id)) throw new Error('The host returned an invalid Mission snapshot.');
    installSnapshot(body);
    if (announce && !unknownOperation) report('Loaded revision ' + body.revision + '. State is read from the host.', 'success');
    return true;
  } catch (error) {
    if (sequence !== readSequence || id !== selectedId) return false;
    clearSnapshot('Mission state could not be refreshed. Load it again to inspect current Work.');
    report((unknownOperation ? 'Write outcome remains unknown. ' : '') + 'Refresh failed: ' + error.message, 'error');
    return false;
  } finally { if (sequence === readSequence) { loading = false; controls(); } }
}
async function verifyAcknowledgementFeed(origin, acknowledgementFeed, missionId) {
  if (!origin) return null;
  if (acknowledgementFeed !== origin) { requireReconnect(); throw new Error('Command acknowledgement feed is missing or differs from its originating database'); }
  const epoch = connectionEpoch;
  const {response,body} = await request('/read-state?mission=' + encodeURIComponent(missionId));
  if (!response.ok || epoch !== connectionEpoch || body.feedId !== origin || !validSnapshot(body.snapshot,missionId)) { requireReconnect(); throw new Error('The acknowledgement belongs to a previous or unavailable database; current-feed receipt readback is required'); }
  return body.snapshot;
}
function badge(text, state) { return element('span', text, 'tag' + (['accepted','passed','succeeded'].includes(state) ? ' good' : ['blocked','waiting','unknown','pending','stale'].includes(state) ? ' warn' : ['failed','cancelled'].includes(state) ? ' bad' : '')); }
function addFact(list, title, value) { const group = element('div'); group.append(element('dt', title)); const detail = element('dd'); if (Array.isArray(value)) { const items = element('ul'); for (const item of value) items.append(element('li', item)); detail.append(items); } else detail.textContent = String(value); group.append(detail); list.append(group); }
function metric(label, value) { const group = element('div', undefined, 'metric'); group.append(element('dt', label), element('dd', value)); return group; }
function providerNotice() {
  if (runtimeConfiguration) { $('work-budget-label').textContent = 'Budget limit (output tokens)'; $('work-budget-hint').textContent = 'Set a budget of at least twice the intended per-call output cap for executor and independent review. This is not a money or total-token limit. Admission does not start execution.'; $('provider-notice').textContent = 'Choose configured connections separately for execution and independent review on each Work. Selection does not authorize new accounts or spend. Costs remain unknown; budget units are output tokens.'; return; }
  $('work-budget-label').textContent = 'Budget limit (host units)';
  $('work-budget-hint').textContent = 'Admission records responsibility and pins criteria, effective memory and the current organization revision. It does not start model execution. Confirm host runtime units before choosing a budget.';
  $('provider-notice').textContent = !providerKnown ? 'Provider availability could not be confirmed. User Work is only admitted here; no model execution is started.' : providerSelection.status === 'selected' ? 'A real provider is configured. This client admits Work and records controls; automatic model execution is not implemented.' : 'Real-provider execution is unavailable. ' + providerSelection.reason;
}
function workBlocker(work) {
  if (work.runtimeRecovery) return 'Permanently quarantined by owner. External outcomes remain unresolved; this is not proof the provider stopped. No replay or resumed completion is authorized.';
  const unknown = (work.effects || []).filter(effect => effect.status === 'unknown' || effect.status === 'pending');
  if (unknown.length) return 'Unresolved effects: ' + unknown.map(effect => effect.id + ' (' + effect.status + ')').join(', ') + '. Reconcile observed outcomes before any replay.';
  if (work.execution === 'cancelled') return 'Cancelled in durable state. Existing effects and evidence remain visible.';
  if (work.acceptance === 'accepted') return work.record && work.record.evidenceClass === 'fixture' ? 'Accepted fixture Record. This is controlled development evidence, not real-provider execution.' : 'Accepted Record is available below.';
  if (work.execution === 'waiting') return 'Waiting after a steering command. Recording an instruction does not start or resume execution.';
  if (work.blocker) return work.blocker.code.replaceAll('_', ' ') + ': ' + work.blocker.detail;
  if (work.execution === 'blocked') return 'Execution is blocked in the authoritative state. Inspect effect receipts and evidence below.';
  if (!(work.assignments || []).length) return providerKnown && providerSelection.status === 'unavailable' ? 'Provider unavailable for this Work. No executor is assigned; admission has not started execution.' : 'No executor is assigned. Admission has not started execution.';
  if (work.acceptance === 'failed' || work.acceptance === 'stale') return 'Independent assurance is ' + work.acceptance + '. This Work has no accepted current Record.';
  return 'Execution and acceptance are tracked separately. Inspect the pinned evidence below.';
}

const executionDrafts = new Map(), executionForms = new Map();
function renderExecutionSelection(work) {
  const missionId = snapshot.value.id, revision = snapshot.revision;
  const configuration = runtimeConfiguration;
  const area = element('details',undefined,'controls'); area.append(workElement(work,'summary','Choose execution and review connections','selection-summary'));
  const form = element('form',undefined,'execution-form');
  const draftKey = missionId + '\u0000' + work.id;
  executionForms.set(draftKey,form);
  const saved = executionDrafts.get(draftKey) || {};
  const fields = {};
  for (const role of ['executor','verifier']) {
    const label = element('label',role === 'executor' ? 'Executor connection / model' : 'Independent verifier connection / model');
    const select = element('select'); select.id = role + '-profile-' + work.id; label.htmlFor = select.id; select.required = true;
    const empty = element('option','Choose a connection'); empty.value = ''; select.append(empty);
    for (const connection of configuration.connections) {
      if (connection.backend !== 'model-provider') continue;
      const option = element('option',connection.label + (connection.diagnostics.length ? ' · unavailable' : ' · ' + connection.providerKind + ' / ' + connection.model)); option.value = connection.id; option.disabled = connection.diagnostics.length > 0; select.append(option);
    }
    select.value = saved[role + 'ProfileId'] || ''; fields[role + 'ProfileId'] = select; form.append(label,select);
  }
  const grantLabel = element('label','Authorized use'); const grant = element('select'); grant.id = 'authorization-' + work.id; grantLabel.htmlFor = grant.id; grant.required = true;
  const empty = element('option','Choose an authorization'); empty.value = ''; grant.append(empty);
  const grants = configuration.authorizations.filter(a => a.scope === snapshot.value.scope);
  for (const item of grants) { const option = element('option',item.id + ' · ' + item.mode + ' · max ' + item.maxOutputTokensPerCall + ' output tokens per call'); option.value = item.id; grant.append(option); }
  grant.value = saved.authorizationId || ''; fields.authorizationId = grant; form.append(grantLabel,grant);
  if (!grants.length) form.append(element('p','No host authorization matches this Mission scope. Choosing a connection cannot grant account access or spending permission.','work-note warning'));
  const capLabel = element('label','Output-token cap per call (two calls reserved)'); const cap = element('input'); cap.type = 'number'; cap.min = '1'; cap.step = '1'; cap.required = true; cap.id = 'output-cap-' + work.id; capLabel.htmlFor = cap.id; cap.value = saved.outputTokenCap || ''; fields.outputTokenCap = cap; form.append(capLabel,cap);
  const detail = element('p',undefined,'hint');
  const plan = element('p',undefined,'work-note'); plan.id = 'execution-plan-' + work.id;
  const result = element('p','Not checked. Check selection does not start execution.','status'); result.id = 'selection-check-' + work.id; result.setAttribute('role','status'); result.setAttribute('aria-live','polite');
  const check = element('button','Check selection','secondary'); check.type = 'button';
  const choice = () => ({executorProfileId:fields.executorProfileId.value,verifierProfileId:fields.verifierProfileId.value,authorizationId:grant.value,outputTokenCap:Number(cap.value)});
  const current = () => snapshot && selectedId === missionId && snapshot.value.id === missionId && snapshot.revision === revision && runtimeConfiguration === configuration && executionForms.get(draftKey) === form;
  let checkVersion = 0, checking = false;
  const refresh = () => {
    ++checkVersion; checking = false; check.disabled = false; check.textContent = 'Check selection';
    result.textContent = 'Not checked. Check selection does not start execution.'; result.className = 'status';
    const selection = choice(); executionDrafts.set(draftKey,selection);
    detail.textContent = ['executor','verifier'].map(role => { const c = configuration.connections.find(p => p.id === selection[role + 'ProfileId']); return c && !c.diagnostics.length ? role + ': ' + c.protocol + ' · ' + c.endpoint + ' · auth ' + c.auth.method + ' · max output ' + c.limits.maxOutputTokens + ' · input usage ' + c.usage.inputTokens + ' · cost unknown' : role + ': no connection selected'; }).join(' | ');
    const remaining = work.budget.limit - work.budget.reserved;
    const validCap = Number.isSafeInteger(selection.outputTokenCap) && selection.outputTokenCap > 0 && Number.isSafeInteger(selection.outputTokenCap * 2);
    plan.textContent = validCap ? 'Execution plan: up to ' + selection.outputTokenCap + ' output tokens per call; ' + selection.outputTokenCap * 2 + ' needed for two calls. Work has ' + remaining + ' output tokens available. ' + (selection.outputTokenCap * 2 > remaining ? 'Insufficient Work budget. Use a lower cap or admit new Work with a sufficient budget. ' : '') + 'This does not bound money or total input-plus-output usage.' : 'Choose both connections, authorized use, and a positive whole-number output cap. Both calls must fit the available Work budget of ' + remaining + ' output tokens.';
    plan.className = 'work-note' + (validCap && selection.outputTokenCap * 2 > remaining ? ' warning' : '');
  };
  for (const field of Object.values(fields)) { field.addEventListener('change',refresh); field.addEventListener('input',refresh); } refresh();
  check.id = 'selection-button-' + work.id;
  check.addEventListener('click',async () => {
    if (!current() || checking) return;
    const selection = choice(), key = JSON.stringify(selection), version = ++checkVersion;
    const stillCurrent = () => current() && version === checkVersion && key === JSON.stringify(choice());
    const submittedFocus = document.activeElement; checking = true; check.disabled = true; check.textContent = 'Checking…'; result.textContent = 'Checking this Work and selection without executing providers…';
    try {
      const response = await request('/missions/' + encodeURIComponent(missionId) + '/preflight',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commandId:crypto.randomUUID(),expectedRevision:revision,workId:work.id,selection})});
      if (!stillCurrent()) return;
      const body = response.body;
      if (!response.response.ok || body.ready !== true) { result.textContent = (body.diagnostics || []).map(d => d.message).join(' ') || body.error || 'Selection was not confirmed. Refresh this Mission and check again.'; result.className = 'status warning'; return; }
      if (body.revision !== revision || body.workId !== work.id) { result.textContent = 'The host did not confirm this exact Work revision. Refresh the Mission and check again.'; result.className = 'status warning'; return; }
      result.textContent = 'Checked at revision ' + revision + '. This Work and selection can be submitted now. No provider request was made; Run rechecks current state before admission.'; result.className = 'status success';
    } catch(error) { if (stillCurrent()) { result.textContent = 'Selection could not be checked: ' + error.message; result.className = 'status warning'; } }
    finally { if (stillCurrent()) { checking = false; check.disabled = false; check.textContent = 'Check selection'; if(submittedFocus === check)restoreControlFocus(submittedFocus,check.id); } }
  });
  const run = workElement(work,'button','Run with selected connections','run'); run.type = 'submit'; run.setAttribute('data-write',''); run.setAttribute('aria-describedby',plan.id);
  form.addEventListener('submit',async event => { event.preventDefault(); if(!current())return; const submittedFocus=document.activeElement; refresh(); await write('/missions/' + encodeURIComponent(missionId) + '/run',{commandId:crypto.randomUUID(),expectedRevision:revision,workId:work.id,selection:choice()},missionId,'Run finished. Inspect its execution and independent assurance below.'); if(submittedFocus === run && snapshot?.value.id === missionId && selectedId === missionId)restoreControlFocus(submittedFocus,'work-heading-' + work.id); });
  for(const connection of configuration.connections.filter(c=>c.diagnostics.length))form.append(element('p',connection.label + ': ' + connection.diagnostics.map(d=>d.message).join(' '),'hint'));
  form.append(detail,plan,check,run,result,element('p','No automatic fallback, retry or provider change. The same connection may serve both roles through separate stateless calls; independent review is not a quality guarantee.','hint'));area.append(form);return area;
}

function renderWork(work) {
  const card = element('article', undefined, 'work-card'); card.id = 'work-card-' + work.id;
  const title = element('h3', work.title, 'work-title'); title.id = 'work-heading-' + work.id; title.tabIndex = -1; card.append(title, element('div', work.id, 'id'));
  const tags = element('div', undefined, 'badge-row'); tags.append(badge('Execution: ' + work.execution, work.execution), badge('Acceptance: ' + work.acceptance, work.acceptance));
  if (work.record) tags.append(badge(work.record.evidenceClass + ' evidence', work.record.evidenceClass)); card.append(tags);
  const metrics = element('dl', undefined, 'metrics'); metrics.append(metric('Attempts', (work.attempts || []).length), metric('Budget · reserved / limit', work.budget.reserved + ' / ' + work.budget.limit), metric('Measured usage', work.budget.measured === null ? 'Unknown' : work.budget.measured)); card.append(metrics);
  card.append(element('p', workBlocker(work), 'work-note' + (['queued','blocked','waiting'].includes(work.execution) ? ' warning' : '')));
  if ((work.instructions || []).length) card.append(element('p', 'Latest owner instruction: ' + work.instructions.at(-1).text, 'work-note'));
  const evidence = element('details'); evidence.append(workElement(work,'summary','Criteria, memory pins & evidence','evidence-summary'));
  const body = element('div', undefined, 'detail-content');
  body.append(element('h4','Original selected source documents'),workElement(work,'pre',work.sourceDocuments ? JSON.stringify(work.sourceDocuments,null,2) : 'No document source selected for this Work; current documents are not substituted.','source-input'));
  if(work.runtimeRun?.ownership)body.append(element('h4','Original host dispatch ownership & deadline'),workElement(work,'pre',JSON.stringify({runId:work.runtimeRun.id,ownership:work.runtimeRun.ownership,interruption:work.runtimeInterruption || null,providerDispatchClaims:work.effects.filter(effect=>effect.providerDispatch).map(effect=>({effectId:effect.id,status:effect.status,claim:effect.providerDispatch}))},null,2),'runtime-ownership'),element('p','A declared deadline or another host identity is not remote stop proof. A provider dispatch claim records admission, not proof of a call or outcome. Admitted runs and claims are never reclaimed or replayed.','hint'));
  if(work.prerequisites)body.append(element('h4','Explicit execution prerequisites'),workElement(work,'pre',JSON.stringify({pins:work.prerequisites,acceptedRecords:work.prerequisiteRecords || []},null,2),'prerequisites'));
  body.append(element('h4','Original organization responsibilities'),workElement(work,'pre',work.organizationSnapshot ? JSON.stringify(work.organizationSnapshot,null,2) : 'No organization revision pinned at Work admission; current organization is not substituted.','organization-input'));
  body.append(element('h4','Original Mission input'),workElement(work,'pre',work.missionSnapshot ? JSON.stringify(work.missionSnapshot,null,2) : 'Original Mission input is unavailable; current input is not substituted.','mission-input'));
  body.append(element('h4', 'Pinned criteria'), element('p', 'v' + work.criteria.version + ' · ' + work.criteria.description), element('p', 'Oracle: ' + work.criteria.oracle, 'id'));
  body.append(element('h4', 'Pinned memory versions'), element('p', work.appliedMemoryVersions.length ? work.appliedMemoryVersions.join(', ') : 'None pinned for this Work.'));
  for (const pin of work.appliedMemoryVersions) {
    const matches = (snapshot.value.memories || []).filter(memory => memory.id + '@' + memory.version === pin);
    const memory = matches.length === 1 && matches[0].scope === work.missionSnapshot?.scope ? matches[0] : null;
    if (!memory) { body.append(element('p','Pinned memory ' + pin + ' is unavailable or has mismatched scope; no current version is substituted.','warning')); continue; }
    body.append(element('p',pin + ' · Authority: ' + memory.authority),workElement(work,'pre',memory.content,'memory-' + pin),element('p','Stored source: ' + memory.source,'hint'));
  }
  body.append(element('h4', 'Artifact'), element('p', work.artifact ? work.artifact.path + ' · v' + work.artifact.version + ' · ' + work.artifact.kind : 'No artifact has been published.'));
  if (work.artifact) body.append(element('p', 'SHA-256: ' + work.artifact.sha256, 'id'));
  body.append(element('h4', 'Independent assurance'), element('p', work.verdict ? work.verdict.status + ' · artifact v' + work.verdict.artifactVersion + ' · criteria v' + work.verdict.criteriaVersion : 'No independent verdict yet.'));
  if (work.verdict) { const items = element('ul'); for (const proof of work.verdict.evidence) items.append(element('li', proof.kind + ': ' + proof.detail + ' · source: ' + proof.source)); body.append(items); }
  if ((work.instructions || []).length) { body.append(element('h4', 'Recorded owner instructions')); const instructions = element('ul'); for (const instruction of work.instructions) instructions.append(element('li', instruction.actorId + ': ' + instruction.text)); body.append(instructions); }
  if (work.runtimeRecovery) { body.append(element('h4', 'Owner quarantine decision'), element('p', work.runtimeRecovery.actorId + ': ' + work.runtimeRecovery.reason), workElement(work,'pre',JSON.stringify(work.runtimeRecovery,null,2),'recovery')); }
  body.append(element('h4', 'Effect receipts'));
  if (!work.effects.length) body.append(element('p', 'No effects admitted.'));
  for (const effect of work.effects) body.append(element('p', effect.id + ' · ' + effect.status + ' · ' + effect.target + (effect.receipt ? ' · receipt: ' + effect.receipt : ' · no receipt')));
  body.append(element('h4', 'Accepted Record'));
  if (work.record) { body.append(element('p', work.record.id + ' · ' + work.record.evidenceClass), element('p', 'Checksum: ' + work.record.checksum, 'id')); const record = element('details'); record.append(workElement(work,'summary','Inspect Record bundle','record-summary'), workElement(work,'pre',JSON.stringify(work.record,null,2),'record')); body.append(record); }
  else body.append(element('p', 'No accepted Record. A completed attempt alone is not acceptance.'));
  if(work.record && work.acceptance==='accepted')body.append(recordTextPanel(work));
  if(work.execution==='settled'&&work.acceptance==='failed'&&work.verdict?.status==='failed'&&work.artifact)body.append(rejectedTextPanel(work));
  const attempts = element('details'); attempts.append(workElement(work,'summary','Attempts, tasks & assignments','attempts-summary'), workElement(work,'pre',JSON.stringify({attempts:work.attempts,tasks:work.tasks,assignments:work.assignments},null,2),'attempts')); body.append(attempts); evidence.append(body); card.append(evidence);
  if (work.runtimeRun && work.runtimeRun.connectionBindings) body.append(element('h4','Selected connections'),workElement(work,'pre',JSON.stringify(work.runtimeRun.connectionBindings,null,2),'connections'));
  if (runtimeConfiguration && !work.runtimeRun && work.execution !== 'cancelled' && work.acceptance !== 'accepted') card.append(renderExecutionSelection(work));
  if (work.runtimeRun && !work.runtimeRecovery && work.acceptance !== 'accepted' && work.effects.some(effect => effect.status === 'pending' || effect.status === 'unknown')) {
    const area = element('details', undefined, 'controls'); area.append(workElement(work,'summary','Quarantine interrupted run','quarantine-summary'));
    area.append(element('p', 'Permanent local closure: pending effects become unknown, reservations remain held, and late provider responses cannot change this Work. An already admitted effect may still execute remotely. This does not resume completion or authorize replay.', 'work-note warning'));
    const form = element('form', undefined, 'quarantine-form');
    const label = element('label', 'Why are you quarantining this run?'); const reason = element('textarea'); reason.id = 'quarantine-reason-' + work.id; label.htmlFor = reason.id; reason.rows = 2; reason.maxLength = 16000; reason.required = true;
    const acknowledgement = element('input'); acknowledgement.type = 'checkbox'; acknowledgement.id = 'quarantine-ack-' + work.id; acknowledgement.required = true; acknowledgement.style.width = 'auto';
    const ackLabel = element('label', 'I understand that external effects and usage may remain unknown and this Work cannot be reopened.'); ackLabel.htmlFor = acknowledgement.id;
    const submit = element('button', 'Permanently quarantine run', 'danger'); submit.id = 'work-quarantine-' + work.id; submit.type = 'submit'; submit.setAttribute('data-write','');
    form.addEventListener('submit', event => { event.preventDefault(); const text = reason.value.trim(); if (!text || !acknowledgement.checked) { report('Enter a reason and explicitly acknowledge the uncertain external outcome.','warning'); return; } sendCommand({type:'quarantine-runtime',workId:work.id,runId:work.runtimeRun.id,reason:text,acknowledgeUncertainOutcome:true}); });
    form.append(label,reason,acknowledgement,ackLabel,submit); area.append(form); card.append(area);
  }
  const missionId = snapshot.value.id, revision = snapshot.revision, key = instructionKey(missionId, work.id);
  const conflict = instructionConflicts.get(key);
  if (conflict) {
    const comparison = element('section', undefined, 'instruction-conflict'); comparison.setAttribute('role','status');
    comparison.append(element('h4','Instruction was not recorded'),element('p','Your submission at revision ' + conflict.revision + ' conflicted. No instruction was retried.'));
    comparison.append(element('h4','Your unrecorded submission'),workElement(work,'pre',conflict.text,'unrecorded'));
    const latest = (work.instructions || []).at(-1);
    comparison.append(element('h4','Latest recorded owner instruction · current revision ' + revision),element('p',latest ? latest.actorId + ': ' + latest.text : 'No owner instruction is recorded.'));
    comparison.append(element('p',work.execution === 'cancelled' || work.acceptance === 'accepted' ? 'This Work is closed. Your draft remains available here; it cannot be resubmitted.' : 'Compare the current direction with your draft below. Edit it or deliberately submit it against the displayed revision.','hint'));
    if (work.execution === 'cancelled' || work.acceptance === 'accepted') comparison.append(element('h4','Retained draft'),workElement(work,'pre',drafts.get(key) ?? conflict.text,'draft'));
    card.append(comparison);
  }
  if (work.execution !== 'cancelled' && work.acceptance !== 'accepted') {
    const area = element('div', undefined, 'controls');
    const form = element('form', undefined, 'steer-form');
    const label = element('label', 'Steering instruction'); const input = element('textarea'); input.id = 'steer-' + work.id; label.htmlFor = input.id; input.rows = 2; input.maxLength = 16000; input.required = true; input.placeholder = 'Record a change of direction'; input.value = drafts.get(key) || ''; input.addEventListener('input', () => drafts.set(key, input.value));
    const buttons = element('div', undefined, 'row'); buttons.style.marginTop = '9px';
    const steer = element('button', conflict ? 'Submit revised instruction at revision ' + revision : 'Record instruction', 'secondary'); steer.id = 'work-steer-' + work.id; steer.type = 'submit'; steer.setAttribute('data-write','');
    const cancel = element('button', 'Cancel Work', 'danger'); cancel.id = 'work-cancel-' + work.id; cancel.type = 'button'; cancel.setAttribute('data-write','');
    const current = () => snapshot && selectedId === missionId && snapshot.value.id === missionId && snapshot.revision === revision && snapshot.value.works.some(item => item.id === work.id && item.execution !== 'cancelled' && item.acceptance !== 'accepted');
    cancel.addEventListener('click', () => { if (current()) sendCommand({type:'cancel',workId:work.id}, document.activeElement === cancel); });
    form.addEventListener('submit', event => { event.preventDefault(); if (!current()) return; const instruction = input.value.trim(); drafts.set(key,input.value); if (instruction) sendCommand({type:'steer',workId:work.id,instruction}, document.activeElement === input || document.activeElement === steer); });
    buttons.append(steer,cancel); form.append(label,input,buttons,element('p','Steering records an owner instruction; existing execution blockers remain. Cancellation does not undo effects.','hint')); area.append(form); card.append(area);
  }
  return card;
}
function renderMission() {
  if (!snapshot) return;
  const focused = document.activeElement;
  let card = focused; while (card && !card.id?.startsWith('work-card-')) card = card.parentElement;
  const workFocus = focused?.id && $('work-list').contains(focused) ? {id:focused.id,heading:card ? 'work-heading-' + card.id.slice(10) : null,start:focused.selectionStart,end:focused.selectionEnd,scroll:focused.scrollTop} : null;
  const mission = snapshot.value;
  renderSources(); renderPrerequisites();
  renderDocuments();
  renderRelations();
  renderOrganization();
  renderRevision();
  renderMemoryHistory();
  renderRetirement();
  renderBudget();
  renderConversation();
  renderSequence();
  renderGrowth();
  executionForms.clear();
  $('revision').textContent = 'Revision ' + snapshot.revision;
  $('loaded-id').textContent = mission.id;
  $('mission-link').setAttribute('href','#mission=' + encodeURIComponent(mission.id)); $('mission-link').hidden = false;
  $('mission-purpose').textContent = mission.purpose;
  const facts = $('mission-facts'); facts.replaceChildren();
  addFact(facts,'Scope',mission.scope); addFact(facts,'Success criteria · v' + mission.criteria.version,mission.criteria.description); addFact(facts,'Constraints',mission.constraints.length ? mission.constraints : 'No constraints recorded.'); addFact(facts,'Mission version / effective memory',mission.version + ' / ' + mission.memories.filter(memory => memory.effective).length + ' versions');
  $('work-count').textContent = mission.works.length + (mission.works.length === 1 ? ' responsibility' : ' responsibilities');
  $('work-list').replaceChildren(...(mission.works.length ? mission.works.map(renderWork) : [element('p','No Work admitted yet. Add the first bounded responsibility below.','work-note')]));
  $('snapshot-json').textContent = JSON.stringify(snapshot, null, 2);
  controls();
  if (workFocus) {
    const target = document.getElementById(workFocus.id) || (workFocus.heading && document.getElementById(workFocus.heading));
    for (let parent = target?.parentElement; parent && parent !== $('work-list'); parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS' && !(target.tagName === 'SUMMARY' && parent === target.parentElement)) parent.open = true;
    }
    target?.focus();
    if (target?.tagName === 'TEXTAREA' && Number.isInteger(workFocus.start) && Number.isInteger(workFocus.end)) target.setSelectionRange(workFocus.start,workFocus.end);
    if (target?.tagName === 'PRE' && typeof workFocus.scroll === 'number') target.scrollTop = workFocus.scroll;
  }
}
function renderActivity() {
  const list = $('event-list'); list.replaceChildren();
  const shown = activity.filter(event => !selectedId || event.aggregateId === selectedId).slice(-8).reverse();
  if (!shown.length) list.append(element('li',selectedId ? 'No newly observed events for this Mission.' : 'Select a Mission to follow its events.'));
  renderBudgetHistory();
  for (const event of shown) { const row = element('li'); const label = (event.events || []).map(item => item.type).filter(Boolean).join(', ') || 'Committed change'; row.append(element('span',String(label).replaceAll('-',' ')),element('small','revision ' + event.revision + ' · cursor ' + event.cursor)); list.append(row); }
}
function receiptObserved() {
  return unknownOperation && (confirmedOperations.has(operationKey(unknownOperation)) || activity.some(event => event.commandId === unknownOperation.commandId && event.aggregateId === unknownOperation.missionId));
}
async function refreshReadState(epoch, expectedFeed) {
  const missionId = selectedId, sequence = ++readSequence;
  loading = true; controls();
  try {
    const {response,body} = await request('/read-state' + (missionId ? '?mission=' + encodeURIComponent(missionId) : ''));
    if (epoch !== connectionEpoch || sequence !== readSequence || missionId !== selectedId) throw new Error('Connection or selected Mission changed during read recovery');
    if (!response.ok || typeof body.feedId !== 'string' || !body.feedId || !Number.isSafeInteger(body.cursor) || body.cursor < 0 || (missionId ? body.snapshot !== null && !validSnapshot(body.snapshot,missionId) : body.snapshot !== null)) throw new Error('Current snapshot and feed boundary could not be refreshed');
    if (expectedFeed && body.feedId !== expectedFeed) throw new Error('Database changed while permissions were refreshing');
    if (feedId && body.feedId !== feedId) {
      activity = []; confirmedOperations.clear(); conversationSubmissions.clear(); conversationStatuses.clear(); prerequisiteSubmissions.clear(); prerequisiteStatuses.clear(); sourceSubmissions.clear(); sourceStatuses.clear(); documentSubmissions.clear(); documentStatuses.clear(); relationSubmissions.clear(); relationStatuses.clear(); organizationSubmissions.clear(); organizationStatuses.clear(); retirementSubmissions.clear(); budgetSubmissions.clear(); budgetStatuses.clear();
    }
    // Receipts predating this snapshot still matter; a fresh boundary is not command reconciliation.
    if (unknownOperation) unknownOperation.reconcileCursor = 0;
    // Bind the authoritative feed before rendering a newly initialized private draft.
    feedId = body.feedId;
    if (missionId && body.snapshot === null) {
      rememberMission(''); storage.remove('massion.fixture.mission');
      clearSnapshot('This Mission is absent from the current database. Create or load current state after reconnecting.');
    } else if (missionId) installSnapshot(body.snapshot);
    // Same-feed snapshot reads may be ahead of bounded event pages. Only reset
    // the event boundary when recovering a replaced/invalid feed, not reconnecting.
    if (!expectedFeed) cursor = body.cursor;
    storage.set(feedKey,feedId); storage.set(cursorKey,String(cursor)); renderActivity();
  } finally { loading = false; controls(); }
}
async function pollEvents() {
  if (polling) return;
  polling = true; let epoch = connectionEpoch;
  try {
    const after = unknownOperation ? Math.min(cursor, unknownOperation.reconcileCursor) : cursor;
    const {response, body} = await request('/events?after=' + after,feedId ? {headers:{'X-Massion-Feed':feedId}} : {});
    if (response.status === 409) {
      requireReconnect(); epoch = connectionEpoch;
      if (feedId) {
        await refreshReadState(epoch);
        throw new Error('The database feed changed. Current reads were recovered; permissions must still refresh. No command was replayed.');
      }
      cursor = 0; storage.set(cursorKey, '0'); activity = []; eventRefreshNeeded = true;
      if (unknownOperation) unknownOperation.reconcileCursor = 0;
      if (selectedId && !busy && !loading) await loadMission(selectedId, false);
      throw new Error('Saved cursor was ahead of the host. Catch-up will restart from the beginning.');
    }
    if (epoch !== connectionEpoch) throw new Error('Connection changed during event read');
    if (feedId && body.feedId !== feedId) throw new Error('Event feed identity changed or is missing');
    if (!response.ok || !Array.isArray(body.events) || !Number.isSafeInteger(body.cursor) || body.cursor < after || body.events.some(event => !Number.isSafeInteger(event.cursor) || event.cursor <= after || event.cursor > body.cursor)) throw new Error(body.error || 'Invalid event response.');
    for (const event of body.events) {
      if (!activity.some(old => old.cursor === event.cursor)) activity.push(event);
      if (event.aggregateId === selectedId && (!snapshot || event.revision > snapshot.revision)) eventRefreshNeeded = true;
    }
    if (unknownOperation) unknownOperation.reconcileCursor = body.cursor;
    activity.sort((a,b) => a.cursor - b.cursor);
    if (receiptObserved()) { const commandId = unknownOperation.commandId; confirmOperation(unknownOperation); await clearPending(unknownOperation); controls(); report('Durable receipt found for ' + commandId + '. Refreshing current state; the command was not replayed.','success'); eventRefreshNeeded = true; }
    activity = activity.slice(-100);
    cursor = Math.max(cursor, body.cursor); storage.set(cursorKey, String(cursor));
    $('event-state').textContent = 'Connected · ' + cursor; $('event-state').className = 'tag good';
    $('event-help').textContent = 'Committed events refresh this Mission automatically. Cursor ' + cursor + ' is saved for reconnect.';
    renderActivity();
    if (reconnectRequired) {
      if (busy || loading) return;
      if (!await refreshProviders()) throw new Error('Current host permissions could not be refreshed');
      await refreshConnections(); providerNotice();
      const missionId = selectedId;
      if (body.feedId) await refreshReadState(epoch,body.feedId);
      else if (missionId && !await loadMission(missionId, false)) throw new Error('Current Mission could not be refreshed');
      if (epoch !== connectionEpoch || missionId !== selectedId) throw new Error('Connection or selected Mission changed during refresh');
      if (snapshot) renderMission();
      reconnectRequired = false; eventRefreshNeeded = false; controls();
    } else if (eventRefreshNeeded && !busy && !loading && selectedId) { eventRefreshNeeded = false; await loadMission(selectedId, false); }
  } catch (error) {
    requireReconnect();
    $('event-state').textContent = 'Disconnected'; $('event-state').className = 'tag warn';
    $('event-help').textContent = 'Event polling interrupted: ' + error.message + ' Snapshot refresh remains available; reconnect will resume from cursor ' + cursor + '.';
  } finally { polling = false; }
}
async function write(path, body, missionId, successMessage, revisionSubmission = null, retirementSubmission = null, budgetSubmission = null, growthSubmission = null, organizationSubmission = null, relationSubmission = null, documentSubmission = null, sourceSubmission = null, conversationSubmission = null, prerequisiteSubmission = null) {
  const longRun = path.endsWith('/run'); let ownsBusy = true;
  if (reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return false;
  const operation = {commandId:body.commandId, missionId, reconcileCursor:cursor};
  const writeFeed = feedId;
  const instructionSubmission = body.command?.type === 'steer' ? {missionId,workId:body.command.workId,draft:drafts.get(instructionKey(missionId,body.command.workId))} : null;
  busy = true; controls();
  if (!await persistPending(operation)) { busy = false; controls(); return false; }
  if (reconnectRequired || writeFeed !== feedId) { await clearPending(operation); busy = false; controls(); report('Host state changed before transmission. No command was sent; refresh before a deliberate new action.','warning'); return false; }
  rememberMission(missionId);
  if (instructionSubmission) instructionSubmissions.set(operationKey(operation),instructionSubmission);
  if(conversationSubmission)conversationSubmissions.set(operationKey(operation),conversationSubmission);
  if(prerequisiteSubmission)prerequisiteSubmissions.set(operationKey(operation),prerequisiteSubmission);
  if(sourceSubmission)sourceSubmissions.set(operationKey(operation),sourceSubmission);
  if(documentSubmission)documentSubmissions.set(operationKey(operation),documentSubmission);
  if(relationSubmission)relationSubmissions.set(operationKey(operation),relationSubmission);
  if (organizationSubmission) organizationSubmissions.set(operationKey(operation),organizationSubmission);
  if (revisionSubmission) revisionSubmissions.set(operationKey(operation),revisionSubmission);
  if (retirementSubmission) retirementSubmissions.set(operationKey(operation),retirementSubmission);
  if (budgetSubmission) budgetSubmissions.set(operationKey(operation),budgetSubmission);
  if (growthSubmission) growthSubmissions.set(operationKey(operation),growthSubmission);
  controls(); report('Sending command ' + body.commandId + '…');
  try {
    const responsePromise = request(path,{method:'POST',headers:{'Content-Type':'application/json',...(writeFeed ? {'X-Massion-Feed':writeFeed} : {})},body:JSON.stringify(body)},longRun ? 120000 : 15000);
    // Keep the durable pending lock only until admission is observed. Events can then
    // refresh the admitted run and owner controls while the provider HTTP call waits.
    if(longRun){busy=false;ownsBusy=false;controls();}
    const {response, body:result} = await responsePromise;
    if (result.outcome === 'rejected' && result.reason === 'feed') { await clearPending(operation); requireReconnect(); report('Database changed before command admission. No command was executed or retried; refresh before a new action.','warning'); return false; }
    if (writeFeed && writeFeed !== feedId) { requireReconnect(); throw new Error('The command response belongs to the previous database. Its outcome requires current-feed receipt readback; no replay occurred.'); }
    const currentAcknowledgedSnapshot = response.ok ? await verifyAcknowledgementFeed(writeFeed,result.feedId,missionId) : null;
    if((longRun || prerequisiteSubmission) && selectedId!==missionId){
      if(prerequisiteSubmission&&response.ok&&['committed','replayed'].includes(result.status)&&validSnapshot(result,missionId)){confirmOperation(operation);await clearPending(operation);return true;}
      if(response.ok && ['settled','blocked','cancelled','already-started'].includes(result.status) && validSnapshot(result.snapshot,missionId)){confirmOperation(operation);await clearPending(operation);return result.status==='settled';}
      if(response.status>=400 && response.status<500 || response.status===503 && result.outcome==='rejected'){await clearPending(operation);return false;}
      throw new Error('Background run outcome requires durable readback.');
    }
    if (response.status === 409 || result.status === 'conflict') {
      await clearPending(operation);
      if (body.command?.type === 'steer') instructionConflicts.set(instructionKey(missionId,body.command.workId),{revision:body.expectedRevision,text:body.command.instruction});
      const loaded = await loadMission(missionId, false);
      if (loaded) renderMission();
      report((result.reason === 'idempotency' ? 'Command identity conflict. The submitted action was rejected; the existing identity belongs to different command content. ' : 'Revision conflict. ') + 'The command was not retried. ' + (loaded ? 'Review the refreshed state before submitting a new action.' : 'Current state could not be refreshed. Reload before another write.'),'warning');
      return false;
    }
    if (response.status === 503 && result.outcome === 'rejected') {
      await clearPending(operation);
      const loaded = await loadMission(missionId, false);
      report('Command rejected: the host confirmed a transaction rollback. ' + (loaded ? 'Current state was refreshed. You may deliberately submit a new action.' : 'Refresh the Mission before a deliberate retry.') + ' No automatic retry occurred.', 'warning');
      return false;
    }
    if (response.status >= 500 || result.status === 'unknown') throw new Error(result.error || 'The host could not confirm the commit outcome.');
    if (!response.ok) { await clearPending(operation); report('Command rejected: ' + (result.error || 'HTTP ' + response.status) + '. No automatic retry.','error'); return false; }
    if (path.endsWith('/run') && ['settled','blocked','cancelled','already-started'].includes(result.status) && validSnapshot(result.snapshot,missionId)) {
      confirmOperation(operation); await clearPending(operation); const current = currentAcknowledgedSnapshot || result.snapshot; if(selectedId===missionId && (!snapshot || snapshot.revision<=current.revision)){++readSequence;installSnapshot(current);}
      report(result.reason || successMessage,result.status === 'settled' ? 'success' : 'warning'); return result.status === 'settled';
    }
    if (!['committed','replayed'].includes(result.status) || !validSnapshot(result, missionId)) throw new Error('The command response did not confirm a valid committed snapshot.');
    confirmOperation(operation); await clearPending(operation); if(prerequisiteSubmission&&selectedId!==missionId)return true; rememberMission(missionId); ++readSequence; installSnapshot(currentAcknowledgedSnapshot || result);
    report(successMessage + ' Revision ' + result.revision + (result.status === 'replayed' ? ' (existing receipt).' : '.'),'success');
    return true;
  } catch (error) {
    if((longRun || prerequisiteSubmission) && selectedId!==missionId){if(!confirmedOperations.has(operationKey(operation)) && (!unknownOperation || operationKey(unknownOperation)===operationKey(operation)))unknownOperation=operation;await pollEvents();return false;}
    if (confirmedOperations.has(operationKey(operation))) {
      const loaded = await loadMission(missionId, false);
      if (loaded) report('The host confirmed this command. Its current state was refreshed without replaying it.','success');
      return loaded;
    }
    unknownOperation = operation; rememberMission(missionId); controls();
    report('Write outcome unknown: ' + error.message + ' Reading back durable state without replaying the command.','warning');
    await loadMission(missionId,false);
    await pollEvents();
    return false;
  } finally { if(ownsBusy)busy = false; controls(); if (eventRefreshNeeded && !unknownOperation) { eventRefreshNeeded = false; await loadMission(selectedId,false); } }
}
async function sendCommand(command, restoreFocus = false) {
  if (!snapshot || reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const missionId = snapshot.value.id, submittedFocus = document.activeElement;
  await write('/missions/' + encodeURIComponent(missionId) + '/commands',{commandId:crypto.randomUUID(),expectedRevision:snapshot.revision,command},missionId,command.type === 'quarantine-runtime' ? 'Work permanently quarantined. External outcomes remain unresolved; no run was replayed.' : command.type === 'cancel' ? 'Cancellation recorded.' : 'Steering instruction recorded. Inspect the current execution state below.');
  if (restoreFocus && snapshot?.value.id === missionId && selectedId === missionId) {
    const target = document.getElementById('steer-' + command.workId) || document.getElementById('work-heading-' + command.workId);
    if(target)restoreControlFocus(submittedFocus,target.id);
  }
}
function commandBodyFits(body) { return new TextEncoder().encode(JSON.stringify(body)).byteLength <= ${MAX_REQUEST_BODY_BYTES}; }
function memoryValues() { return memoryIds.map(id => $(id).value); }
function sourceValues(){return [$('source-work').value,$('source-document').value,$('source-reason').value];}
function emptySourceDraft(){return {values:['','',''],original:null,baseRevision:snapshot.revision,feed:feedId};}
function sourceDocument(choice){return (snapshot?.value.documents || []).find(d=>JSON.stringify([d.id,d.version,d.contentSha256])===choice);}
function sourceSelection(draft){const work=snapshot?.value.works.find(w=>w.id===draft?.values[0]),d=sourceDocument(draft?.values[1]);return budgetFresh(work)&&d&&JSON.stringify(d)===draft.original&&(work.sourceDocuments || []).length<3&&!(work.sourceDocuments || []).some(p=>p.document.id===d.id);}
function switchSourceDraft(id){if(sourceMission===id)return;const old=sourceDrafts.get(sourceMission);if(old)old.values=sourceValues();sourceMission=id;const values=sourceDrafts.get(id)?.values || ['','',''];['source-work','source-document','source-reason'].forEach((name,i)=>$(name).value=values[i]);}
function renderSources(){
 switchSourceDraft(snapshot.value.id);
 for(const [key,submission] of sourceSubmissions){if(submission.missionId!==selectedId || !confirmedOperations.has(key) || snapshot.revision<=submission.expectedRevision)continue;const draft=sourceDrafts.get(selectedId),unchanged=draft===submission.draft&&JSON.stringify(sourceValues())===JSON.stringify(submission.values);if(unchanged){sourceDrafts.set(selectedId,emptySourceDraft());['source-work','source-document','source-reason'].forEach(name=>$(name).value='');}sourceStatuses.set(selectedId,'Exact source selection confirmed. '+(unchanged?'Work retains the original; saving starts no execution.':'Later private edits retained.'));sourceSubmissions.delete(key);}
 let draft=sourceDrafts.get(selectedId);if(!draft){draft=emptySourceDraft();sourceDrafts.set(selectedId,draft);}
 const workSelect=$('source-work'),docSelect=$('source-document');for(const select of [workSelect,docSelect]){select.replaceChildren();const blank=element('option','Choose exact '+(select===workSelect?'fresh Work':'stored document'));blank.value='';select.append(blank);}
 for(const work of snapshot.value.works){const option=element('option',work.id+' · '+work.title+(budgetFresh(work)?'':' · unavailable: execution evidence exists'));option.value=work.id;option.disabled=!budgetFresh(work);workSelect.append(option);}workSelect.value=draft.values[0];
 for(const d of snapshot.value.documents || []){const option=element('option',d.id+' · v'+d.version+' · '+d.title+' · SHA-256 '+d.contentSha256);option.value=JSON.stringify([d.id,d.version,d.contentSha256]);docSelect.append(option);}docSelect.value=draft.values[1];$('source-reason').value=draft.values[2];
 const area=$('source-evidence');area.replaceChildren();const original=draft.original?JSON.parse(draft.original):null;
 if(original){area.append(element('p',original.id+' · v'+original.version+' · '+original.title),element('p','Source: '+original.source+' · Original author: '+original.actorId),element('p','SHA-256: '+original.contentSha256,'hint'),element('pre',original.content));if(!sourceSelection(draft))area.append(element('p','Exact source/Work is unavailable, already selected or no longer fresh. Choose deliberately again.','warning'));}
 $('source-base').textContent='Draft based on aggregate revision '+draft.baseRevision+' · Current '+snapshot.revision+(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?' · State changed. Compare and review before attaching.':'');$('source-status').textContent=sourceStatuses.get(selectedId) || 'Select exact Work and original source; saving starts no execution.';
}
for(const id of ['source-work','source-document'])$(id).addEventListener('change',()=>{if(!organizationEditable())return;const draft=sourceDrafts.get(selectedId);draft.values=sourceValues();const original=sourceDocument(draft.values[1]);draft.original=original?JSON.stringify(original):null;renderSources();});
for(const event of ['input','change'])$('source-reason').addEventListener(event,()=>{const draft=sourceDrafts.get(sourceMission);if(draft)draft.values=sourceValues();});
$('cancel-source').addEventListener('click',()=>{if(!organizationEditable())return;sourceDrafts.set(selectedId,emptySourceDraft());sourceStatuses.set(selectedId,'Private source selection cancelled. No command was sent.');renderSources();});
$('review-source').addEventListener('click',()=>{const draft=sourceDrafts.get(selectedId);if(!organizationEditable() || !sourceSelection(draft))return;draft.values=sourceValues();draft.baseRevision=snapshot.revision;draft.feed=feedId;sourceStatuses.set(selectedId,'Exact original and fresh Work reviewed. Inspect original text/hash and reason before attaching.');renderSources();});
$('source-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!organizationEditable())return;const draft=sourceDrafts.get(selectedId),values=sourceValues();
 if(!sourceSelection(draft) || JSON.stringify(values.slice(0,2))!==JSON.stringify(draft.values.slice(0,2)) || draft.baseRevision!==snapshot.revision || draft.feed!==feedId){sourceStatuses.set(selectedId,'Exact selection or state changed. Compare original and review fresh Work. No command was sent.');renderSources();return;}
 if(!values[2].trim() || values[2].length>2000 || !values[2].isWellFormed()){sourceStatuses.set(selectedId,'Enter a bounded reason for this exact source selection. No command was sent.');return;}
 const d=sourceDocument(values[1]),missionId=selectedId,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,workId:values[0],documentId:d.id,version:d.version,contentSha256:d.contentSha256,reason:values[2]};if(!commandBodyFits(body))return;draft.values=[...values];const focus=document.activeElement;
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/work-source',body,missionId,'Original source attached to fresh Work. No execution requested.',null,null,null,null,null,null,null,{missionId,draft,values:[...values],expectedRevision:body.expectedRevision});
 if(snapshot?.value.id===missionId && selectedId===missionId){if(!saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))sourceStatuses.set(missionId,'Source selection not confirmed here. Original draft and revision retained; inspect durable receipts without replay.');renderSources();if($('source-form').contains(focus)){sourceFocus={missionId,previous:focus,targetId:focus.id};controls();}}
});
function documentValues(){return documentIds.map(id=>$(id).value);}
function emptyDocumentDraft(){return {values:['','1','','',''],baseRevision:snapshot.revision,feed:feedId};}
function switchDocumentDraft(id){if(documentMission===id)return;const old=documentDrafts.get(documentMission);if(old)old.values=documentValues();documentMission=id;const values=documentDrafts.get(id)?.values || ['','1','','',''];documentIds.forEach((name,i)=>$(name).value=values[i]);$('document-query').value='';}
function renderDocuments(){
 switchDocumentDraft(snapshot.value.id);
 for(const [key,submission] of documentSubmissions){if(submission.missionId!==selectedId || !confirmedOperations.has(key) || snapshot.revision<=submission.expectedRevision)continue;
 const draft=documentDrafts.get(selectedId),unchanged=draft===submission.draft && JSON.stringify(documentValues())===JSON.stringify(submission.values);if(unchanged){documentDrafts.set(selectedId,emptyDocumentDraft());documentIds.forEach((name,i)=>$(name).value=documentDrafts.get(selectedId).values[i]);}documentStatuses.set(selectedId,'Exact document version confirmed. '+(unchanged?'Search or read its original source deliberately.':'Later private edits are retained.'));documentSubmissions.delete(key);}
 let draft=documentDrafts.get(selectedId);if(!draft){draft=emptyDocumentDraft();documentDrafts.set(selectedId,draft);documentIds.forEach((name,i)=>$(name).value=draft.values[i]);}
 $('document-base').textContent='Current aggregate revision '+snapshot.revision+' · Draft based on revision '+draft.baseRevision+(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?' · State changed. Inspect stored versions and review before saving.':'');$('document-status').textContent=documentStatuses.get(selectedId) || 'Enter an exact document ID/version and original text/source.';
 const history=snapshot.value.documents || [],choice=documentChoices.get(selectedId) || '';const select=$('document-choice');select.replaceChildren();const blank=element('option','Choose an exact stored version');blank.value='';select.append(blank);
 for(const d of history){const option=element('option',d.id+' · v'+d.version+' · '+d.title);option.value=JSON.stringify([d.id,d.version,d.contentSha256]);select.append(option);}select.value=history.some(d=>JSON.stringify([d.id,d.version,d.contentSha256])===choice)?choice:'';documentReadControls();
}
for(const id of documentIds)for(const event of ['input','change'])$(id).addEventListener(event,()=>{const draft=documentDrafts.get(documentMission);if(draft)draft.values=documentValues();});
$('cancel-document').addEventListener('click',()=>{if(!organizationEditable())return;documentDrafts.set(selectedId,emptyDocumentDraft());documentIds.forEach((name,i)=>$(name).value=documentDrafts.get(selectedId).values[i]);documentStatuses.set(selectedId,'Private document draft cancelled. No command was sent.');renderDocuments();});
$('review-document').addEventListener('click',()=>{if(!organizationEditable())return;const draft=documentDrafts.get(selectedId);draft.values=documentValues();draft.baseRevision=snapshot.revision;draft.feed=feedId;documentStatuses.set(selectedId,'Exact document draft reviewed. Confirm ID and advancing version before saving.');renderDocuments();});
$('document-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!organizationEditable())return;const draft=documentDrafts.get(selectedId),values=documentValues(),version=Number(values[1]);
 if(draft.baseRevision!==snapshot.revision || draft.feed!==feedId){documentStatuses.set(selectedId,'State changed. Review original source and exact version before saving. No command was sent.');renderDocuments();return;}
 const previous=(snapshot.value.documents || []).filter(d=>d.id===values[0]).at(-1)?.version || 0;
 if(!/^document:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(values[0]) || !Number.isSafeInteger(version) || version!==previous+1 || [values[2],values[3],values[4]].some((value,i)=>!value.trim() || !value.isWellFormed() || value.length>[200,2000,16384][i]) || new TextEncoder().encode(values[4]).byteLength>16384){documentStatuses.set(selectedId,'Enter bounded original text/title/source and the next exact document version. No command was sent.');renderDocuments();return;}
 const missionId=selectedId,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,document:{id:values[0],version,title:values[2],source:values[3],content:values[4]}};if(!commandBodyFits(body)){documentStatuses.set(missionId,'Serialized document command exceeds UTF-8 request bound. No command was sent.');renderDocuments();return;}draft.values=[...values];const focus=document.activeElement;
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/documents',body,missionId,'Exact document stored. Earlier sources and accepted Records preserved.',null,null,null,null,null,null,{missionId,draft,values:[...values],expectedRevision:body.expectedRevision});
 if(snapshot?.value.id===missionId && selectedId===missionId){if(!saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))documentStatuses.set(missionId,'Document not confirmed here. Exact draft and original revision retained; check durable receipts without replay.');renderDocuments();if($('document-form').contains(focus)){documentFocus={missionId,previous:focus,targetId:focus.id};controls();}}
});
function selectedDocument(){const value=$('document-choice').value;return (snapshot?.value.documents || []).find(d=>JSON.stringify([d.id,d.version,d.contentSha256])===value);}
function documentReadControls(){const ready=!reconnectRequired && !loading && !recoveryProblem && snapshot?.value.id===selectedId;$('document-search').disabled=!ready || !!documentReadController;$('document-read').disabled=!ready || !selectedDocument() || !!documentReadController;$('document-usage').disabled=!ready || !selectedDocument() || !!documentReadController;$('document-choice').disabled=!ready;$('document-read-cancel').disabled=!documentReadController;}
function invalidateDocumentRead(message='Read selection changed. Search or choose exact source again.') {documentReadSequence++;documentReadController?.abort();documentReadController=null;$('document-read-results').replaceChildren();$('document-search-results').replaceChildren();$('document-usage-results').replaceChildren();$('document-read-status').textContent=message;documentReadControls();}
function currentDocumentRead(choice){return choice.sequence===documentReadSequence && selectedId===choice.missionId && snapshot?.value.id===choice.missionId && snapshot.revision===choice.revision && feedId===choice.feed && connectionEpoch===choice.epoch && (choice.mode==='search'?$('document-query').value===choice.query:$('document-choice').value===choice.selection);}
$('document-choice').addEventListener('change',()=>{documentChoices.set(selectedId,$('document-choice').value);invalidateDocumentRead();});$('document-query').addEventListener('input',()=>invalidateDocumentRead());
$('document-read-cancel').addEventListener('click',()=>{const focus=document.activeElement;invalidateDocumentRead('Source read cancelled. No command was sent.');if(focus===$('document-read-cancel'))restoreControlFocus(focus,documentReadButton(documentReadMode));});
function documentReadButton(mode){return mode==='search'?'document-search':mode==='usage'?'document-usage':'document-read';}
function useData(work,pin){return {workId:work.id,title:work.title,execution:work.execution,acceptance:work.acceptance,criteriaVersion:work.criteria.version,decision:{actorId:pin.actorId,reason:pin.reason},...(work.record?{record:{id:work.record.id,checksum:work.record.checksum,evidenceClass:work.record.evidenceClass,criteriaVersion:work.record.criteria.version,artifact:{id:work.record.artifact.id,version:work.record.artifact.version,sha256:work.record.artifact.sha256,kind:work.record.artifact.kind}}}:{})};}
function comparableData(value){if(Array.isArray(value))return value.map(comparableData);if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,comparableData(value[key])]));return value;}
function renderDocumentUses(body,choice){
 const expected=snapshot.value.works.flatMap(work=>{const pin=(work.sourceDocuments || []).find(p=>p.document.id===choice.document.id && p.document.version===choice.document.version && p.document.contentSha256===choice.document.contentSha256);if(!pin)return [];if(JSON.stringify(comparableData(pin.document))!==JSON.stringify(comparableData(choice.document)))throw Error('Pinned Work original differs from selected source.');return [useData(work,pin)];});
 if(body.limit!==20 || body.totalUses!==expected.length || !Array.isArray(body.uses) || JSON.stringify(comparableData(body.uses))!==JSON.stringify(comparableData(expected.slice(0,20))))throw Error('Use results do not match exact Work/Record pins and original decisions.');
 const area=$('document-usage-results');area.append(element('p',body.totalUses+' Work uses '+choice.document.id+' v'+choice.document.version+'; showing '+body.uses.length+' (limit 20).','hint'),element('p','Original source SHA-256: '+choice.document.contentSha256,'hint'));
 for(const use of body.uses){area.append(element('h4',use.workId+' · '+use.title),element('p','Execution: '+use.execution+' · Acceptance: '+use.acceptance+' · Criteria v'+use.criteriaVersion),element('pre','Owner selection: '+use.decision.actorId+' · Reason: '+use.decision.reason));
  const inspect=element('button','Inspect Work '+use.workId);inspect.id='document-usage-work-'+use.workId;inspect.type='button';inspect.addEventListener('click',()=>{if(!currentDocumentRead(choice))return;const summary=document.getElementById('work-evidence-summary-'+use.workId);if(summary?.parentElement)summary.parentElement.open=true;document.getElementById('work-heading-'+use.workId)?.focus();});area.append(inspect);
  if(use.record){area.append(element('p','Record: '+use.record.id+' · '+use.record.evidenceClass+' evidence · Criteria v'+use.record.criteriaVersion),element('p','Record checksum: '+use.record.checksum,'hint'),element('p','Artifact '+use.record.artifact.id+' v'+use.record.artifact.version+' · '+use.record.artifact.kind+' · SHA-256: '+use.record.artifact.sha256,'hint'));
   const record=element('button','Inspect exact Record '+use.record.id);record.id='document-usage-record-'+use.workId;record.type='button';record.addEventListener('click',()=>{if(!currentDocumentRead(choice))return;const evidence=document.getElementById('work-evidence-summary-'+use.workId);if(evidence?.parentElement)evidence.parentElement.open=true;const summary=document.getElementById('work-record-text-summary-'+use.workId);if(summary?.parentElement)summary.parentElement.open=true;const read=document.getElementById('work-record-text-read-'+use.workId);if(read && !read.disabled)read.focus();else document.getElementById('work-heading-'+use.workId)?.focus();});area.append(record);
  }else area.append(element('p','No accepted Record for this Work.'));
 }
 $('document-read-status').textContent='Exact original and stored use bindings checked. No write, execution, input replacement or new quality verdict.'+(body.totalUses>20?' More uses exist; this view shows only the first 20.':'');
}
async function readStoredDocument(mode){
 documentReadControls();const button=$(documentReadButton(mode));if(button.disabled)return;const d=selectedDocument(),query=$('document-query').value;if(mode==='search' && (!query.trim() || query.length>200 || !query.isWellFormed())){$('document-read-status').textContent='Enter a bounded literal query. No read was sent.';return;}const focus=document.activeElement;invalidateDocumentRead();
 const choice={sequence:documentReadSequence,missionId:selectedId,revision:snapshot.revision,feed:feedId,epoch:connectionEpoch,mode,query,selection:$('document-choice').value,document:d?JSON.parse(JSON.stringify(d)):null},controller=new AbortController();documentReadController=controller;documentReadMode=mode;documentReadControls();$('document-read-status').textContent='Reading stored '+(mode==='search'?'latest source matches':mode==='usage'?'exact source Work/Record uses':'exact original source')+'…';const timer=setTimeout(()=>controller.abort(),15000);
 try{const path='/missions/'+encodeURIComponent(choice.missionId)+(mode==='search'?'/documents?query='+encodeURIComponent(query):(mode==='usage'?'/document-usage?id=':'/document?id=')+encodeURIComponent(d.id)+'&version='+d.version+'&sha256='+d.contentSha256),response=await fetch(path,{headers:{'X-Massion-Feed':choice.feed},signal:controller.signal,cache:'no-store'}),body=await response.json();if(!currentDocumentRead(choice))return;if(!response.ok)throw Error(body?.error || 'Document read unavailable.');if(body.missionId!==choice.missionId || body.feedId!==choice.feed || body.revision!==choice.revision || !Number.isSafeInteger(body.cursor) || body.cursor<0)throw Error('Reply does not match current Mission/feed/revision. Refresh and choose exact source.');
 if(mode==='search'){
  const latest=new Map();for(const entry of snapshot.value.documents || [])latest.set(entry.id,entry);if(body.query!==query || body.limit!==20 || !Number.isSafeInteger(body.totalMatches) || body.totalMatches<0 || body.totalMatches>100 || body.totalMatches!==[...latest.values()].filter(d=>d.title.includes(query)||d.content.includes(query)).length || !Array.isArray(body.matches) || body.matches.length!==Math.min(body.totalMatches,20) || new Set(body.matches.map(m=>m.id)).size!==body.matches.length || body.matches.some(m=>{const exact=latest.get(m.id);return !exact || exact.version!==m.version || exact.title!==m.title || exact.source!==m.source || exact.contentSha256!==m.contentSha256 || exact.actorId!==m.actorId || typeof m.excerpt!=='string' || m.excerpt.length>240 || !exact.content.includes(m.excerpt) || !(exact.title.includes(query)||exact.content.includes(query));}))throw Error('Latest search evidence did not match exact stored sources.');
  const area=$('document-search-results');area.append(element('p',body.totalMatches+' latest versions match; showing '+body.matches.length+' (limit 20). Earlier versions remain readable by exact selection.'));
  for(const match of body.matches){area.append(element('p',match.id+' · v'+match.version+' · '+match.title),element('pre',match.excerpt));const read=element('button','Read '+match.id+' v'+match.version);read.type='button';read.addEventListener('click',()=>{if(!currentDocumentRead(choice))return;const selection=JSON.stringify([match.id,match.version,match.contentSha256]);documentChoices.set(selectedId,selection);$('document-choice').value=selection;invalidateDocumentRead();restoreControlFocus(read,'document-read');void readStoredDocument('exact');});area.append(read);}
  $('document-read-status').textContent='Literal latest-version search read only. '+(body.totalMatches>20?'More matches exist; narrow your query.':'No command was sent.');
 }else{
  if(!body.document || Object.keys(body.document).length!==7 || ['id','version','title','content','source','contentSha256','actorId'].some(key=>body.document[key]!==choice.document[key]) || typeof body.document.content!=='string' || !body.document.content.isWellFormed())throw Error('Exact document fields do not match the selected original.');const bytes=new TextEncoder().encode(body.document.content);if(bytes.length>16384 || body.byteLength!==bytes.length || !crypto.subtle)throw Error('Document UTF-8 bound is unavailable or mismatched.');const digest=await crypto.subtle.digest('SHA-256',bytes),sha=Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');if(!currentDocumentRead(choice))return;if(sha!==choice.document.contentSha256)throw Error('Original document SHA-256 mismatch.');if(mode==='usage'){renderDocumentUses(body,choice);}else{const area=$('document-read-results');area.append(element('p',d.id+' · v'+d.version+' · '+d.title),element('p','Source: '+d.source+' · Author: '+d.actorId),element('p','SHA-256: '+sha,'hint'),element('pre',body.document.content));$('document-read-status').textContent='Exact original version and UTF-8 content hash checked. This is stored owner source, not an independent truth verdict.';}
 }
 }catch(error){if(currentDocumentRead(choice)){$('document-read-status').textContent='Source read not verified: '+(error?.message || 'Unavailable.')+' No write or fallback was sent.';}}
 finally{clearTimeout(timer);if(currentDocumentRead(choice)){documentReadController=null;documentReadControls();if(focus===button)restoreControlFocus(focus,button.id);}}
}
$('document-search-form').addEventListener('submit',event=>{event.preventDefault();return readStoredDocument('search');});$('document-read').addEventListener('click',()=>readStoredDocument('exact'));$('document-usage').addEventListener('click',()=>readStoredDocument('usage'));
function relationValues(){return relationIds.map(id=>$(id).value);}
function emptyRelationDraft(){return {values:['','1','depends-on','','1',''],baseRevision:snapshot.revision,feed:feedId};}
function switchRelationDraft(id){if(relationMission===id)return;const old=relationDrafts.get(relationMission);if(old)old.values=relationValues();relationMission=id;const values=relationDrafts.get(id)?.values || ['','1','depends-on','','1',''];relationIds.forEach((name,index)=>$(name).value=values[index]);}
function renderRelations(){
 switchRelationDraft(snapshot.value.id);
 for(const [key,submission] of relationSubmissions){if(submission.missionId!==selectedId || !confirmedOperations.has(key) || snapshot.revision<=submission.expectedRevision)continue;
 const draft=relationDrafts.get(selectedId),unchanged=draft===submission.draft && JSON.stringify(relationValues())===JSON.stringify(submission.values);if(unchanged){relationDrafts.set(selectedId,emptyRelationDraft());relationIds.forEach((name,index)=>$(name).value=relationDrafts.get(selectedId).values[index]);}relationStatuses.set(selectedId,'Exact relation confirmed. '+(unchanged?'Read target impact explicitly to inspect its recorded dependencies.':'Later private edits are retained.'));relationSubmissions.delete(key);}
 let draft=relationDrafts.get(selectedId);if(!draft){draft=emptyRelationDraft();relationDrafts.set(selectedId,draft);relationIds.forEach((name,index)=>$(name).value=draft.values[index]);}
 $('relation-base').textContent='Current aggregate revision '+snapshot.revision+' · Draft based on revision '+draft.baseRevision+(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?' · State changed. Compare current relationships and review before saving.':'');
 $('relation-status').textContent=relationStatuses.get(selectedId) || 'Enter exact reference identities, versions and provenance.';
 const area=$('relation-history');area.replaceChildren();area.append(element('p',(snapshot.value.relations || []).length+' stored relations. User references are declarations; inferred flags do not certify truth.','hint'));
 for(const r of snapshot.value.relations || [])area.append(element('p',r.from+'@'+r.fromVersion+' '+r.type+' '+r.to+'@'+r.toVersion+' · Inferred: '+r.inferred),element('pre','Provenance: '+r.provenance));
}
for(const id of relationIds)for(const event of ['input','change'])$(id).addEventListener(event,()=>{const draft=relationDrafts.get(relationMission);if(draft)draft.values=relationValues();});
$('cancel-relation').addEventListener('click',()=>{if(!organizationEditable())return;relationDrafts.set(selectedId,emptyRelationDraft());relationIds.forEach((name,index)=>$(name).value=relationDrafts.get(selectedId).values[index]);relationStatuses.set(selectedId,'Private relation draft cancelled. No command was sent.');renderRelations();});
$('review-relation').addEventListener('click',()=>{if(!organizationEditable())return;const draft=relationDrafts.get(selectedId);draft.values=relationValues();draft.baseRevision=snapshot.revision;draft.feed=feedId;relationStatuses.set(selectedId,'Exact relation draft reviewed against current state; inspect versions and provenance before saving.');renderRelations();});
$('relation-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!organizationEditable())return;const draft=relationDrafts.get(selectedId),values=relationValues(),fromVersion=Number(values[1]),toVersion=Number(values[4]);
 if(draft.baseRevision!==snapshot.revision || draft.feed!==feedId){relationStatuses.set(selectedId,'State changed. Review this exact relation against current revision. No command was sent.');renderRelations();return;}
 if([values[0],values[3],values[5]].some(value=>!value.trim() || value.length>2000 || !value.isWellFormed()) || !Number.isSafeInteger(fromVersion) || fromVersion<1 || !Number.isSafeInteger(toVersion) || toVersion<1 || !['depends-on','evidenced-by','contains'].includes(values[2])){relationStatuses.set(selectedId,'Enter exact references, positive whole versions, supported relationship and provenance. No command was sent.');renderRelations();return;}
 const missionId=selectedId,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,relation:{from:values[0],fromVersion,type:values[2],to:values[3],toVersion,provenance:values[5]}};if(!commandBodyFits(body)){relationStatuses.set(selectedId,'Serialized command exceeds UTF-8 request bound. No command was sent.');renderRelations();return;}
 draft.values=[...values];const submittedFocus=document.activeElement;const saved=await write('/missions/'+encodeURIComponent(missionId)+'/relations',body,missionId,'Exact owner relation recorded. Existing Work and Records unchanged.',null,null,null,null,null,{missionId,draft,values:[...values],expectedRevision:body.expectedRevision});
 if(snapshot?.value.id===missionId && selectedId===missionId){if(!saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))relationStatuses.set(missionId,'Relation not confirmed here. Exact draft and original revision retained; check durable receipts without replay.');renderRelations();if($('relation-form').contains(submittedFocus)){relationFocus={missionId,previous:submittedFocus,targetId:submittedFocus.id};controls();}}
});
function organizationValues(){return organizationIds.map(id=>$(id).value);}
function organizationHistory(){return snapshot?.value.organizationRevisions || [];}
function organizationSource(target){return target==='new'?null:organizationHistory().find(item=>String(item.version)===target);}
function organizationSourceMatches(draft){return draft && (draft.target==='new' || JSON.stringify(organizationSource(draft.target))===draft.source);}
function organizationEditable(){return snapshot && snapshot.value.id===selectedId && !reconnectRequired && !busy && !loading && !unknownOperation && !recoveryProblem;}
function switchOrganizationDraft(id){
 if(organizationMission===id)return;
 const old=organizationDrafts.get(organizationMission);if(old)old.values=organizationValues();organizationMission=id;
 const draft=organizationDrafts.get(id);$('organization-target').value=draft?.target || '';organizationIds.forEach((name,index)=>$(name).value=draft?.values[index] || '');
}
function organizationControls(){
 const editable=organizationEditable(),draft=organizationDrafts.get(selectedId);
 $('save-organization').disabled=!editable || !organizationSourceMatches(draft);
 $('review-organization').disabled=!editable || !organizationSourceMatches(draft);
 $('cancel-organization').disabled=!editable || !draft;
 $('organization-recheck').disabled=busy || loading || !unknownOperation || unknownOperation.missionId!==selectedId;
}
function renderOrganization(){
 switchOrganizationDraft(snapshot.value.id);
 for(const [key,submission] of organizationSubmissions){
  if(submission.missionId!==selectedId || !confirmedOperations.has(key) || snapshot.revision<=submission.expectedRevision)continue;
  const draft=organizationDrafts.get(selectedId),unchanged=draft===submission.draft && JSON.stringify(organizationValues())===JSON.stringify(submission.values);
  if(unchanged){organizationDrafts.delete(selectedId);organizationIds.forEach(name=>$(name).value='');}
  organizationStatuses.set(selectedId,'Organization revision '+submission.version+' confirmed. Existing Work pins remain. '+(unchanged?'Choose an exact revision before another edit.':'Your later private edits are retained for review.'));
  organizationSubmissions.delete(key);
 }
 const draft=organizationDrafts.get(selectedId),history=organizationHistory(),current=history.at(-1);
 $('organization-current').textContent='Current aggregate revision '+snapshot.revision+' · '+(current?'Current organization v'+current.version:'No organization revision stored. Earlier Work remains unbound.');
 const select=$('organization-target'),options=[element('option','Choose exact revision or new definitions'),element('option','New responsibility definitions')];options[0].value='';options[1].value='new';
 for(const revision of history){const option=element('option','Organization v'+revision.version+' · Author '+revision.actorId+(revision===current?' · current':''));option.value=String(revision.version);options.push(option);}select.replaceChildren(...options);select.value=draft?.target || '';
 const source=draft && organizationSource(draft.target),area=$('organization-evidence');area.replaceChildren();
 if(source){area.append(element('h3','Stored organization v'+source.version),element('p','Author: '+source.actorId),element('p','Recorded reason: '+source.reason));for(const item of source.responsibilities)area.append(element('h4',item.role+' · Required '+item.capability),element('pre',item.responsibility));}
 else area.append(element('p',draft?.target==='new'?'New owner-authored definitions; no stored source is substituted.':'Choose an exact stored revision to inspect original author, reason and requirements.','hint'));
 $('organization-version').value=draft?String(draft.baseVersion+1):'';
 $('organization-base').textContent=draft?'Draft source '+(draft.target==='new'?'new definitions':'organization v'+draft.target)+' · Based on aggregate revision '+draft.baseRevision+' and current organization v'+draft.baseVersion+(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?' · State changed. Compare current state, then explicitly review before saving.':'')+(!organizationSourceMatches(draft)?' · Exact source changed or is unavailable. Choose a source again.':''):'No private draft selected.';
 $('organization-status').textContent=organizationStatuses.get(selectedId) || 'Choose a source revision and review its recorded requirements.';organizationControls();
}
$('organization-target').addEventListener('change',()=>{
 if(!organizationEditable())return;const target=$('organization-target').value,source=organizationSource(target);if(target!=='new' && !source){organizationDrafts.delete(selectedId);organizationIds.forEach(name=>$(name).value='');renderOrganization();return;}
 const values=[source?.responsibilities.find(item=>item.role==='executor').responsibility || '',source?.responsibilities.find(item=>item.role==='verifier').responsibility || '',''];organizationDrafts.set(selectedId,{target,source:source?JSON.stringify(source):null,values,baseRevision:snapshot.revision,baseVersion:organizationHistory().at(-1)?.version || 0,feed:feedId});organizationIds.forEach((name,index)=>$(name).value=values[index]);organizationStatuses.set(selectedId,'Private draft from exact '+(source?'organization v'+source.version:'new definitions')+'. Review responsibilities and supply a new reason.');renderOrganization();
});
for(const id of organizationIds)for(const event of ['input','change'])$(id).addEventListener(event,()=>{const draft=organizationDrafts.get(organizationMission);if(draft)draft.values=organizationValues();});
$('cancel-organization').addEventListener('click',()=>{if(!organizationEditable())return;organizationDrafts.delete(selectedId);organizationIds.forEach(name=>$(name).value='');organizationStatuses.set(selectedId,'Private responsibility draft cancelled. No command was sent.');renderOrganization();});
$('review-organization').addEventListener('click',()=>{const draft=organizationDrafts.get(selectedId);if(!organizationEditable() || !organizationSourceMatches(draft))return;draft.values=organizationValues();draft.baseRevision=snapshot.revision;draft.baseVersion=organizationHistory().at(-1)?.version || 0;draft.feed=feedId;organizationStatuses.set(selectedId,'Draft reviewed against current state. Saving will create organization v'+(draft.baseVersion+1)+'; inspect the new reason and original source before submitting.');renderOrganization();});
$('organization-recheck').addEventListener('click',async()=>{if(busy || loading || !unknownOperation || unknownOperation.missionId!==selectedId)return;await pollEvents();});
$('organization-form').addEventListener('submit',async event=>{
 event.preventDefault();const draft=organizationDrafts.get(selectedId);if(!organizationEditable() || !organizationSourceMatches(draft))return;
 if(draft.baseRevision!==snapshot.revision || draft.feed!==feedId){organizationStatuses.set(selectedId,'State changed. Compare current state and explicitly review this exact draft. No command was sent.');renderOrganization();return;}
 const values=organizationValues(),version=draft.baseVersion+1;
 if(!Number.isSafeInteger(version) || values.some(value=>!value.trim() || value.length>2000 || !value.isWellFormed())){organizationStatuses.set(selectedId,'Enter both responsibility definitions and a reason, each up to 2000 well-formed characters. No command was sent.');renderOrganization();return;}
 const missionId=selectedId,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,version,reason:values[2],responsibilities:[{role:'executor',responsibility:values[0],capability:'text-output'},{role:'verifier',responsibility:values[1],capability:'independent-text-review'}]};
 if(!commandBodyFits(body)){organizationStatuses.set(selectedId,'The serialized command exceeds the UTF-8 request bound. No command was sent.');renderOrganization();return;}
 draft.values=[...values];const submittedFocus=document.activeElement;organizationStatuses.set(missionId,'Saving new organization revision; existing Work pins remain…');renderOrganization();
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/organization',body,missionId,'Organization responsibility revision saved. Existing Work pins remain.',null,null,null,null,{missionId,draft,values:[...values],version,expectedRevision:body.expectedRevision});
 if(snapshot?.value.id===missionId && selectedId===missionId){if(!saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))organizationStatuses.set(missionId,'Revision not confirmed here. Your exact source and original draft revision are retained. Check pending receipts; no save is retried.');renderOrganization();if($('organization-form').contains(submittedFocus)){organizationFocus={missionId,previous:submittedFocus,targetId:!organizationDrafts.has(missionId) && submittedFocus.id==='save-organization'?'organization-target':submittedFocus.id};controls();}}
});
function revisionValues() { return revisionIds.map(id => $(id).value); }
function revisionCriteriaText(criteria) { const method = criteria.oracle === 'manual-review/v1' ? 'Manual review' : criteria.oracle === 'bounded-text-review/v1' ? 'Bounded text with independent model review' : criteria.oracle; return 'v' + criteria.version + ': ' + criteria.description + ' · Acceptance method: ' + method; }
function newRevisionDraft() {
  const mission = snapshot.value;
  return {values:[mission.purpose,String(mission.criteria.version + 1),mission.criteria.description,mission.criteria.oracle],baseRevision:snapshot.revision,basePurpose:mission.purpose,baseCriteria:revisionCriteriaText(mission.criteria),dirty:false};
}
function switchRevisionDraft(id) {
  if (revisionMission === id) return;
  const old = revisionDrafts.get(revisionMission); if (old) old.values = revisionValues();
  revisionMission = id;
  const values = revisionDrafts.get(id)?.values || ['', '', '', 'manual-review/v1'];
  for (let i=0;i<revisionIds.length;i++) $(revisionIds[i]).value = values[i];
  $('revision-status').textContent = 'Review current purpose and criteria before saving.';
}
function renderRevision() {
  switchRevisionDraft(snapshot.value.id);
  for (const [key, submission] of revisionSubmissions) {
    if (submission.missionId !== revisionMission || !confirmedOperations.has(key) || snapshot.revision <= submission.expectedRevision) continue;
    const unchanged = JSON.stringify(revisionValues()) === JSON.stringify(submission.values);
    if (unchanged) revisionDrafts.set(revisionMission,newRevisionDraft());
    revisionSubmissions.delete(key);
    $('revision-status').textContent = 'Mission revision confirmed. ' + (unchanged ? 'Only future Work uses the new purpose and criteria.' : 'Your later edits are retained for review.');
  }
  let draft = revisionDrafts.get(revisionMission);
  if (!draft || !draft.dirty) { draft = newRevisionDraft(); revisionDrafts.set(revisionMission,draft); for(let i=0;i<revisionIds.length;i++) $(revisionIds[i]).value = draft.values[i]; }
  $('revision-current').textContent = 'Current revision ' + snapshot.revision + ' · Mission v' + snapshot.value.version + ': ' + snapshot.value.purpose + ' · Criteria: ' + revisionCriteriaText(snapshot.value.criteria);
  $('revision-base').textContent = 'Draft based on revision ' + draft.baseRevision + ': ' + draft.basePurpose + ' · Criteria: ' + draft.baseCriteria + (draft.baseRevision !== snapshot.revision ? ' · State changed. Compare current and draft before explicitly keeping this draft against the current revision.' : '');
}
function revisionEditable() { return snapshot && snapshot.value.id === selectedId && !reconnectRequired && !busy && !loading && !unknownOperation && !recoveryProblem; }
for (const id of revisionIds) for (const event of ['input','change']) $(id).addEventListener(event,() => { const draft = revisionDrafts.get(revisionMission); if (draft) { draft.values = revisionValues(); draft.dirty = true; } });
$('discard-revision').addEventListener('click',() => { if (!revisionEditable()) return; revisionDrafts.set(selectedId,newRevisionDraft()); renderRevision(); $('revision-status').textContent = 'Revision draft discarded. No command was sent.'; });
$('rebase-revision').addEventListener('click',() => { if (!revisionEditable()) return; const values = revisionValues(); revisionDrafts.set(selectedId,{...newRevisionDraft(),values,dirty:true}); renderRevision(); $('revision-status').textContent = 'Draft retained against current revision. Review purpose, criteria and advancing version before saving.'; });
$('revision-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!revisionEditable()) return;
  const values = revisionValues(), version = Number(values[1]), draft = revisionDrafts.get(selectedId);
  if (!draft || !values[0].trim() || values[0].length > 16000 || !values[2].trim() || values[2].length > 16000 || !Number.isSafeInteger(version) || version <= snapshot.value.criteria.version || !['manual-review/v1','bounded-text-review/v1'].includes(values[3])) { $('revision-status').textContent = 'Enter purpose, success criteria and a positive whole-number version above the current criteria version. No command was sent.'; return; }
  draft.values = values; draft.dirty = true;
  const missionId = selectedId, submittedFocus = document.activeElement;
  const body = {commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,purpose:values[0],criteria:{version,description:values[2],oracle:values[3]}};
  $('revision-status').textContent = 'Saving Mission revision. No Work is restarted or model invoked…';
  const saved = await write('/missions/' + encodeURIComponent(missionId) + '/revision',body,missionId,'Mission revision saved. Earlier Work retains its original purpose and criteria.',{missionId,values:[...values],expectedRevision:body.expectedRevision});
  const confirmed = saved || confirmedOperations.has(operationKey({missionId,commandId:body.commandId}));
  if (snapshot?.value.id === missionId && selectedId === missionId) {
    if (confirmed && JSON.stringify(revisionValues()) === JSON.stringify(values)) { revisionDrafts.set(missionId,newRevisionDraft()); renderRevision(); }
    $('revision-status').textContent = confirmed ? 'Mission revision confirmed. Only future Work uses the new purpose and criteria.' : 'Revision was not confirmed here. Compare current state and your retained draft; no command is retried.';
    if ($('revision-form').contains(submittedFocus)) { revisionFocus = {missionId,previous:submittedFocus,targetId:submittedFocus.id}; controls(); }
  }
});
function switchMemoryDraft(id) {
  if (memoryMission === id) return;
  if (memoryMission) memoryDrafts.set(memoryMission,memoryValues());
  memoryMission = id; const values = memoryDrafts.get(id) || ['', '1', '', ''];
  for (let i=0;i<memoryIds.length;i++) $(memoryIds[i]).value = values[i];
  $('memory-status').textContent = 'Save a new ID at version 1, or advance an existing ID to a higher version.';
}
for (const id of memoryIds) $(id).addEventListener('input',() => { if (memoryMission) memoryDrafts.set(memoryMission,memoryValues()); });
function renderMemoryHistory() {
  const area = $('memory-history'), previous = document.activeElement, focused = area.contains(previous) ? previous?.id : null;
  area.replaceChildren(); $('memory-scope').textContent = 'Mission: ' + snapshot.value.id + ' · Scope: ' + snapshot.value.scope + ' · Current revision: ' + snapshot.revision;
  const memories = snapshot.value.memories || [];
  if (!memories.length) area.append(element('p','No stored Mission memory. Future Work has no memory from this Mission until one becomes effective.'));
  for (const memory of memories) {
    area.append(element('h4',memory.id + ' · version ' + memory.version),element('p','Authority: ' + memory.authority + ' · ' + (memory.effective ? 'Effective for new Work' : 'Historical or inactive version'),'hint'));
    const content = element('pre',memory.content); content.id = 'memory-content-' + memory.id + '-' + memory.version; area.append(content,element('p','Stored source: ' + memory.source,'hint'));
  }
  if (focused) restoreControlFocus(previous,focused);
}
function budgetValues() { return [$('budget-limit').value,$('budget-reason').value]; }
function budgetWork(id = $('budget-target').value) { return snapshot?.value.works.find(work => work.id === id); }
function budgetFresh(work) { return !!work && work.acceptance === 'pending' && ['queued','blocked','waiting'].includes(work.execution) && !work.runtimeRun && !work.runtimeRecovery && !work.effects.length && !work.assignments.length && !work.artifact && !work.verdict && !work.record && work.attempts.length === 1 && work.attempts[0].status === 'queued' && work.tasks.length === 1 && work.tasks[0].status === 'queued' && !work.tasks[0].result; }
function budgetDraftKey(workId = $('budget-target').value) { return instructionKey(budgetMission,workId); }
function freshBudgetDraft(work) { return {values:[work ? String(work.budget.limit) : '', ''],baseRevision:snapshot?.revision || null,feed:feedId}; }
function renderBudgetHistory() {
  const area = $('budget-history'); area.replaceChildren();
  const shown = activity.filter(event => event.aggregateId === budgetMission).flatMap(event => (event.events || []).filter(item => item.type === 'revise-budget' && item.command?.workId === $('budget-target').value).map(item => ({event,item}))).slice(-8).reverse();
  if (!shown.length) area.append(element('p','No recent budget changes observed here. This is not complete history.'));
  for (const {event,item} of shown) area.append(element('p','Work ' + item.command.workId + ' · limit ' + item.command.limit + ' · revision ' + event.revision),element('p','Recorded reason: ' + item.command.reason));
}
function renderBudget() {
  if (!snapshot) return;
  const missionId = snapshot.value.id, select = $('budget-target');
  // Preserve the intended ID independently of the previous Mission's native options.
  const workId = budgetMission !== missionId ? budgetSelections.get(missionId) || '' : select.value;
  budgetMission = missionId;
  for (const [key,submission] of budgetSubmissions) {
    if (submission.missionId !== missionId || !confirmedOperations.has(key) || snapshot.revision <= submission.expectedRevision) continue;
    const draftKey = instructionKey(missionId,submission.workId), draft = budgetDrafts.get(draftKey), work = budgetWork(submission.workId);
    if (draft && JSON.stringify(draft.values) === JSON.stringify(submission.values)) budgetDrafts.set(draftKey,freshBudgetDraft(work));
    budgetStatuses.set(draftKey,'Confirmed budget change for Work ' + submission.workId + '. No execution or permission was granted. Later draft edits are retained.'); budgetSubmissions.delete(key);
  }
  select.replaceChildren(); const prompt = element('option','Choose exact fresh Work'); prompt.value = ''; select.append(prompt);
  for (const work of snapshot.value.works.filter(budgetFresh)) { const option = element('option',work.title + ' · ' + work.id); option.value = work.id; select.append(option); }
  if (workId && !budgetFresh(budgetWork(workId))) { const stale = element('option',workId + ' is no longer fresh; no other Work is substituted'); stale.value = workId; select.append(stale); }
  select.value = workId;
  const work = budgetWork(workId), key = budgetDraftKey(), draft = budgetDrafts.get(key);
  $('budget-limit').value = draft?.values[0] || ''; $('budget-reason').value = draft?.values[1] || '';
  $('budget-current').textContent = work ? 'Work ' + work.id + ' · Current limit ' + work.budget.limit + ' · Unit: ' + (work.budget.unit || 'host units (unit not pinned yet)') + ' · Reserved ' + work.budget.reserved + ' · Measured ' + (work.budget.measured === null ? 'Unknown' : work.budget.measured) : 'Choose Work to inspect its actual budget.';
  $('budget-base').textContent = 'Current revision ' + snapshot.revision + (draft ? ' · Draft based on revision ' + draft.baseRevision + (draft.baseRevision !== snapshot.revision || draft.feed !== feedId ? ' · State changed. Review this exact Work against current state before a deliberate submission.' : '') : ' · No Work selected.');
  if (workId && !budgetFresh(work)) $('budget-base').textContent += ' This Work is no longer eligible; no replacement is selected.';
  $('budget-status').textContent = budgetStatuses.get(key) || 'Review the exact Work, changed limit and reason. No execution will start.';
  renderBudgetHistory(); renderStoredBudget(); renderStoredIntervention();
}


function recordTextChoice(work) { return {missionId:snapshot.value.id,workId:work.id,recordId:work.record.id,recordChecksum:work.record.checksum,artifactId:work.record.artifact.id,artifactVersion:work.record.artifact.version,artifactSha256:work.record.artifact.sha256,criteriaVersion:work.record.criteria.version,evidenceClass:work.record.evidenceClass,feedId,epoch:connectionEpoch}; }
function recordTextKey(choice) { return JSON.stringify([choice.missionId,choice.workId,choice.recordId,choice.recordChecksum,choice.artifactVersion,choice.artifactSha256,choice.feedId]); }
function currentRecordText(choice) {
  if(reconnectRequired || selectedId!==choice.missionId || snapshot?.value.id!==choice.missionId || feedId!==choice.feedId || connectionEpoch!==choice.epoch)return false;
  const w=snapshot.value.works.find(work=>work.id===choice.workId);return w?.acceptance==='accepted' && w.record?.id===choice.recordId && w.record.checksum===choice.recordChecksum && w.record.artifact.version===choice.artifactVersion && w.record.artifact.sha256===choice.artifactSha256;
}
function recordTextNode(workId,part) { return document.getElementById('work-record-text-'+part+'-'+workId); }
function recordTextPanel(work) {
  const choice=recordTextChoice(work),state=recordTextReads.get(recordTextKey(choice)),details=element('details');details.append(workElement(work,'summary','Read exact accepted text','record-text-summary'));
  details.append(element('p','Read only the text pinned by this accepted Record. Host checks the Record and exact UTF-8 bytes/SHA-256. This is not a new independent quality verdict; no execution or file path input. Other artifact kinds remain unsupported.','hint'));
  const row=element('div',undefined,'row'),read=workElement(work,'button','Read exact Record text','record-text-read'),cancel=workElement(work,'button','Cancel text read','record-text-cancel');read.type=cancel.type='button';read.disabled=work.record.artifact.kind!=='text'||!feedId||!currentRecordText(choice)||loading||!!state?.busy;cancel.disabled=!state?.busy;
  read.addEventListener('click',()=>readRecordText(choice));cancel.addEventListener('click',()=>cancelRecordText(choice));row.append(read,cancel);
  const status=workElement(work,'p',state?.message || (work.record.artifact.kind==='text'?'Read the exact stored text deliberately.':'This accepted artifact is not UTF-8 text; no filesystem fallback is available.'),'record-text-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const content=workElement(work,'pre',state?.content || '','record-text-content');content.setAttribute('role','region');content.setAttribute('aria-label','Exact accepted text for '+work.id);content.setAttribute('aria-busy',String(!!state?.busy));details.append(row,status,content);return details;
}
function recordTextControls() {
  for(const [key,state] of recordTextReads)if(!currentRecordText(state.choice)){state.sequence++;state.controller?.abort();recordTextReads.delete(key);const content=recordTextNode(state.choice.workId,'content');if(content){content.replaceChildren();content.setAttribute('aria-busy','false');}const status=recordTextNode(state.choice.workId,'status');if(status)status.textContent='Text read invalidated by context change. Choose the exact accepted result and read again deliberately.';}
  if(!snapshot || snapshot.value.id!==selectedId)return;
  for(const work of snapshot.value.works){if(!work.record || work.acceptance!=='accepted')continue;const choice=recordTextChoice(work),state=recordTextReads.get(recordTextKey(choice)),read=recordTextNode(work.id,'read'),cancel=recordTextNode(work.id,'cancel');if(read)read.disabled=work.record.artifact.kind!=='text'||!feedId||!currentRecordText(choice)||loading||!!state?.busy;if(cancel)cancel.disabled=!state?.busy;}
}
function renderRecordText(choice) {
  const state=recordTextReads.get(recordTextKey(choice));if(!state || !currentRecordText(choice))return;
  const status=recordTextNode(choice.workId,'status'),content=recordTextNode(choice.workId,'content');if(status)status.textContent=state.message;if(content){content.textContent=state.content || '';content.setAttribute('aria-busy',String(state.busy));}recordTextControls();
}
function cancelRecordText(choice) {
  const state=recordTextReads.get(recordTextKey(choice));if(!state?.busy)return;const previous=document.activeElement;state.sequence++;state.controller?.abort();state.controller=null;state.busy=false;state.content='';state.message='Text read canceled. No write or execution was sent.';renderRecordText(choice);if(previous===recordTextNode(choice.workId,'cancel'))restoreControlFocus(previous,'work-record-text-read-'+choice.workId);
}
async function validRecordText(body,choice) {
  if(!body || body.missionId!==choice.missionId || body.workId!==choice.workId || body.recordId!==choice.recordId || body.recordChecksum!==choice.recordChecksum || body.feedId!==choice.feedId || body.criteriaVersion!==choice.criteriaVersion || body.evidenceClass!==choice.evidenceClass || !Number.isSafeInteger(body.revision)||body.revision<1 || body.artifact?.id!==choice.artifactId || body.artifact.kind!=='text' || body.artifact.version!==choice.artifactVersion || body.artifact.sha256!==choice.artifactSha256 || typeof body.content!=='string' || !body.content.isWellFormed() || !body.content.length || !Number.isSafeInteger(body.byteLength))return false;
  const bytes=new TextEncoder().encode(body.content);if(bytes.length>32768 || bytes.length!==body.byteLength || !crypto.subtle)return false;const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('')===choice.artifactSha256;
}
async function readRecordText(choice) {
  recordTextControls();const button=recordTextNode(choice.workId,'read');if(!button || button.disabled || !currentRecordText(choice))return;
  const key=recordTextKey(choice),old=recordTextReads.get(key);old?.controller?.abort();const state={choice,sequence:(old?.sequence || 0)+1,controller:new AbortController(),busy:true,content:'',message:'Reading and checking exact accepted text…'},sequence=state.sequence,submittedFocus=document.activeElement;recordTextReads.set(key,state);renderRecordText(choice);const timer=setTimeout(()=>state.controller?.abort(),15000);
  try{
    const path='/missions/'+encodeURIComponent(choice.missionId)+'/record-artifact?work='+encodeURIComponent(choice.workId)+'&record='+encodeURIComponent(choice.recordId)+'&version='+choice.artifactVersion+'&sha256='+choice.artifactSha256;
    const response=await fetch(path,{headers:{'X-Massion-Feed':choice.feedId},signal:state.controller.signal,cache:'no-store'}),body=await response.json();
    if(recordTextReads.get(key)!==state || sequence!==state.sequence || !currentRecordText(choice))return;
    if(!response.ok)throw new Error(body?.error || 'Exact text read unavailable.');if(!await validRecordText(body,choice))throw new Error('Text reply failed exact Record, feed, UTF-8 byte or SHA-256 checks.');
    if(recordTextReads.get(key)!==state || sequence!==state.sequence || !currentRecordText(choice))return;
    state.content=body.content;state.message='Exact stored text verified against Record '+choice.recordId+' · artifact v'+choice.artifactVersion+' · SHA-256 '+choice.artifactSha256+' · '+body.byteLength+' UTF-8 bytes · read at Mission revision '+body.revision+' · recorded evidence '+body.evidenceClass+'. Viewing text creates no new acceptance.';
  }catch(error){if(recordTextReads.get(key)===state && sequence===state.sequence && currentRecordText(choice)){state.content='';state.message='Read not verified: '+(error?.message || 'Unavailable.')+' Retry deliberately; no other artifact, write or execution is substituted.';}}
  finally{clearTimeout(timer);if(recordTextReads.get(key)===state && sequence===state.sequence && currentRecordText(choice)){state.controller=null;state.busy=false;renderRecordText(choice);if(submittedFocus===button)restoreControlFocus(submittedFocus,'work-record-text-read-'+choice.workId);}}
}
const growthCreateDrafts=new Map(),growthCaseDrafts=new Map();let growthCreateMission='',growthCreateFocus=null;
const growthCreateIds=['growth-create-id','growth-create-baseline','growth-create-memory','growth-create-version','growth-create-content','growth-create-source','growth-create-counter'];
function creationValues(){return growthCreateIds.map(id=>$(id).value);}
function renderGrowthCreation(){
 if(growthCreateMission!==selectedId){growthCreateMission=selectedId;const draft=growthCreateDrafts.get(selectedId);growthCreateIds.forEach((id,i)=>$(id).value=draft?.values[i] || '');$('growth-evaluate-cases').value=growthCaseDrafts.get(selectedId)||'';$('growth-create-status').textContent='Private proposal draft restored. Review exact versions and source before submission.';$('growth-evaluate-status').textContent='Choose an unevaluated proposal and your bounded input orders.';}
 const draft=growthCreateDrafts.get(selectedId);$('growth-create-base').textContent='Current revision '+snapshot.revision+(draft?' · Draft revision '+draft.revision+(draft.revision!==snapshot.revision || draft.feed!==feedId?' · State changed; review deliberately.':''):' · No draft revision.');
}
function growthCreationControls(){
 const ready=revisionEditable(),previous=document.activeElement;
 for(const id of ['growth-create-fields','growth-evaluate-fields']){if(!$(id).disabled && $(id).contains(previous))growthCreateFocus={missionId:selectedId,previous,targetId:previous.id};$(id).disabled=!ready;}
 $('growth-evaluate-submit').disabled=!ready || selectedGrowth()?.status!=='proposed' || !growthMatches(selectedGrowth(),growthDrafts.get(selectedId));
 if(growthCreateFocus && ready){const focus=growthCreateFocus;growthCreateFocus=null;if(focus.missionId===selectedId)restoreControlFocus(focus.previous,focus.targetId);}
}
for(const id of growthCreateIds)for(const event of ['input','change'])$(id).addEventListener(event,()=>{if(!revisionEditable())return;const old=growthCreateDrafts.get(selectedId);growthCreateDrafts.set(selectedId,{values:creationValues(),revision:old?.revision || snapshot.revision,feed:old?.feed || feedId});renderGrowthCreation();});
$('growth-create-review').addEventListener('click',()=>{if(!revisionEditable())return;growthCreateDrafts.set(selectedId,{values:creationValues(),revision:snapshot.revision,feed:feedId});renderGrowthCreation();$('growth-create-status').textContent='Exact draft retained against current revision. No command was sent.';});
$('growth-evaluate-cases').addEventListener('input',()=>{growthCaseDrafts.set(selectedId,$('growth-evaluate-cases').value);});
$('growth-create-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!revisionEditable())return;const missionId=selectedId,values=creationValues(),draft=growthCreateDrafts.get(selectedId),focus=document.activeElement;
 if(!draft || draft.feed!==feedId){$('growth-create-status').textContent='Review this exact draft at current revision before submission.';return;}
 const body={commandId:crypto.randomUUID(),expectedRevision:draft.revision,growthId:values[0],baseline:values[1],candidate:{id:values[2],version:Number(values[3]),content:values[4],source:values[5]},counterevidence:values[6]};if(!commandBodyFits(body)){$('growth-create-status').textContent='Request exceeds bounded UTF-8 size. Shorten inputs.';return;}
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/growth-proposals',body,missionId,'Inactive candidate and proposal saved. Evaluation and adoption remain deliberate.');if(selectedId===missionId){$('growth-create-status').textContent=saved?'Proposal confirmed; original draft retained. Choose the new exact proposal to evaluate.':'Proposal not confirmed here; draft and original revision retained. Inspect durable receipt; no replay.';restoreControlFocus(focus,focus.id);}
});
$('growth-evaluate-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!revisionEditable())return;const g=selectedGrowth(),draft=growthDrafts.get(selectedId),missionId=selectedId,focus=document.activeElement;if(g?.status!=='proposed'||!growthMatches(g,draft))return;let cases;try{cases=JSON.parse($('growth-evaluate-cases').value);}catch{$('growth-evaluate-status').textContent='Enter bounded input orders as valid JSON. No evaluation sent.';return;}
 const body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,growthId:g.id,baseline:draft.baseline,candidate:draft.candidate,oracle:'rounding-calculation/v1',cases};if(!commandBodyFits(body)){$('growth-evaluate-status').textContent='Evaluation request exceeds UTF-8 bound.';return;}
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/growth-evaluation',body,missionId,'Local calculation evidence recorded; no model quality verdict.',null,null,null,{missionId,expectedRevision:body.expectedRevision,draft,action:'evaluate'});if(selectedId===missionId){$('growth-evaluate-status').textContent=saved?'Independent bounded calculation confirmed. Inspect evidence and review before adoption.':'Evaluation not confirmed here; inputs and exact selection retained. Inspect receipt/state; no automatic replay.';restoreControlFocus(focus,focus.id);}
});

function selectedGrowth() { return snapshot?.value.id === selectedId ? (snapshot.value.growth || []).find(g => g.id === $('growth-target').value) : null; }
function growthDraft(g) { return {target:g.id,baseline:g.baseline,candidate:g.candidate,action:g.status==='adopted'?'revert':'adopt',baseRevision:snapshot.revision,feed:feedId,message:'Exact proposal selected. Inspect evidence and memory versions before a deliberate action.'}; }
function growthMatches(g,draft) { return g && draft && g.id===draft.target && g.target==='memory' && g.baseline===draft.baseline && g.candidate===draft.candidate && draft.feed===feedId; }
function growthEligible(g,action) {
  if(!g || g.target!=='memory')return false;
  const memory = ref => (snapshot.value.memories || []).find(m => m.id+'@'+m.version===ref && m.scope===snapshot.value.scope);
  const candidate=memory(g.candidate),baseline=memory(g.baseline);
  if(!candidate || !baseline)return false;
  return action==='adopt' ? g.status==='evaluated' && !!g.evaluator && g.evaluator!==g.proposer && g.scores && Number.isFinite(g.scores.baseline) && Number.isFinite(g.scores.candidate) && g.scores.candidate>g.scores.baseline && typeof g.scores.heldOut==='string' && !!g.scores.heldOut.trim() && baseline.effective : g.status==='adopted' && Array.isArray(g.previousEffective) && candidate.effective;
}
function growthControls() {
  const g=selectedGrowth(),draft=growthDrafts.get(selectedId),ready=revisionEditable();
  $('growth-target').disabled=!snapshot || snapshot.value.id!==selectedId || loading;
  const previous=document.activeElement;
  if(snapshot?.value.id===selectedId && !$('growth-fields').disabled && $('growth-fields').contains(previous))growthFocus={missionId:selectedId,previous,targetId:previous.id};
  $('growth-fields').disabled=!ready;
  for(const action of ['adopt','revert'])$(''+action+'-growth').disabled=!ready || !growthMatches(g,draft) || draft.action!==action || !growthEligible(g,action);
  $('review-growth').disabled=!ready || !g || g.target!=='memory';
  $('cancel-growth').disabled=!ready || !draft;
  if(growthFocus && ready){const pending=growthFocus;growthFocus=null;if(pending.missionId===selectedId)restoreControlFocus(pending.previous,$(pending.targetId).disabled?'review-growth':pending.targetId);}
}
function renderGrowth() {
  if(!snapshot || snapshot.value.id!==selectedId)return;
  renderGrowthCreation();
  for(const [key,submission] of growthSubmissions){
    if(submission.missionId!==selectedId || !confirmedOperations.has(key) || snapshot.revision<=submission.expectedRevision)continue;
    if(growthDrafts.get(selectedId)===submission.draft)submission.draft.message='Confirmed '+submission.action+' for '+submission.draft.target+'. Existing Work pins remain. Review the exact proposal at current revision before another action.';
    growthSubmissions.delete(key);
  }
  const draft=growthDrafts.get(selectedId),select=$('growth-target'),previous=document.activeElement,area=$('growth-evidence'),focused=area.contains(previous)?previous?.id:null;
  select.replaceChildren();const prompt=element('option','Choose exact proposal');prompt.value='';select.append(prompt);
  for(const g of snapshot.value.growth || []){const option=element('option',g.id+' · '+g.status+' · '+g.candidate);option.value=g.id;select.append(option);}
  if(draft && !(snapshot.value.growth || []).some(g=>g.id===draft.target)){const missing=element('option',draft.target+' unavailable; no replacement selected');missing.value=draft.target;select.append(missing);}
  select.value=draft?.target || '';const g=selectedGrowth();area.replaceChildren();
  if(g){
    area.append(element('p','Proposal '+g.id+' · target '+g.target+' · status '+g.status+' · proposer '+g.proposer));
    for(const [label,ref] of [['Baseline',g.baseline],['Candidate',g.candidate]]){
      area.append(element('h4',label+' exact memory '+ref));const matches=(snapshot.value.memories || []).filter(m=>m.id+'@'+m.version===ref && m.scope===snapshot.value.scope);
      if(matches.length!==1){area.append(element('p','Exact scoped memory unavailable; current versions are not substituted.','warning'));continue;}
      const m=matches[0];area.append(element('p','Scope '+m.scope+' · authority '+m.authority+' · effective '+m.effective),element('pre',m.content),element('p','Stored source: '+m.source,'hint'));
    }
    area.append(element('h4','Counterevidence'),element('pre',g.counterevidence),element('p','Recorded independent evaluator: '+(g.evaluator || 'None')));
    if(g.scores)area.append(element('p','Recorded baseline score '+g.scores.baseline+' · candidate score '+g.scores.candidate),element('h4','Stored held-out evaluation evidence'),element('pre',g.scores.heldOut));
    else area.append(element('p','No stored evaluation; adoption is unavailable.'));
    if(g.previousEffective)area.append(element('p','Effective pins recorded before adoption: '+g.previousEffective.join(', ')));
    if(g.observation)area.append(element('p','Stored later observation: Work '+g.observation.workId+' · metric '+g.observation.metric));
  }else area.append(element('p','Choose an exact stored proposal. No evaluation is created here.'));
  $('growth-base').textContent='Current Mission revision '+snapshot.revision+(draft?' · Reviewed revision '+draft.baseRevision+' · proposal '+draft.target+' · baseline '+draft.baseline+' · candidate '+draft.candidate+' · action '+draft.action+(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?' · State changed; review current evidence deliberately. Original confirmation is retained.':''):' · No proposal selected.');
  $('growth-status').textContent=draft?.message || 'Choose a stored proposal to inspect its evidence.';growthControls();growthCreationControls();if(focused)restoreControlFocus(previous,focused);
}
$('growth-target').addEventListener('change',()=>{const g=selectedGrowth();if(g)growthDrafts.set(selectedId,growthDraft(g));else growthDrafts.delete(selectedId);renderGrowth();});
$('review-growth').addEventListener('click',()=>{if(!revisionEditable())return;const g=selectedGrowth();if(!g)return;growthDrafts.set(selectedId,growthDraft(g));renderGrowth();$('growth-status').textContent='Exact proposal and memory versions retained at current revision. Inspect recorded evidence before a deliberate action. No command was sent.';});
$('cancel-growth').addEventListener('click',()=>{if(!revisionEditable())return;growthDrafts.delete(selectedId);renderGrowth();$('growth-status').textContent='Private selection cleared. No adoption or revert was sent.';});
async function submitGrowth(action) {
  if(!revisionEditable())return;const g=selectedGrowth(),draft=growthDrafts.get(selectedId);if(!growthMatches(g,draft) || draft.action!==action || !growthEligible(g,action))return;
  const missionId=selectedId,submittedFocus=document.activeElement,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,growthId:draft.target,baseline:draft.baseline,candidate:draft.candidate,action};
  draft.message='Awaiting durable '+action+' receipt for exact proposal '+draft.target+'. No execution is requested.';renderGrowth();
  const saved=await write('/missions/'+encodeURIComponent(missionId)+'/growth',body,missionId,'Exact Growth '+action+' confirmed; existing Work pins retained.',null,null,null,{missionId,action,expectedRevision:body.expectedRevision,draft});
  if(snapshot?.value.id===missionId && selectedId===missionId){
    if(growthDrafts.get(missionId)===draft && !saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))draft.message='Action not confirmed here. Exact proposal, memory versions and reviewed revision are retained. Inspect command status; no automatic retry.';
    renderGrowth();if($('growth-form').contains(submittedFocus)){growthFocus={missionId,previous:submittedFocus,targetId:submittedFocus.id};controls();}
  }
}
$('adopt-growth').addEventListener('click',()=>submitGrowth('adopt'));
$('revert-growth').addEventListener('click',()=>submitGrowth('revert'));
function conversationChoice(){return snapshot?.value.id===selectedId?snapshot.value.works.find(work=>work.id===$('conversation-target').value):null;}
function conversationDraft(work){const key=instructionKey(selectedId,work.id);let draft=conversationDrafts.get(key);if(!draft){draft={text:'',replyTo:null,baseRevision:snapshot.revision,feed:feedId};conversationDrafts.set(key,draft);}return draft;}
function conversationCurrent(work,draft){return !!work&&draft&&snapshot?.value.id===selectedId&&draft.baseRevision===snapshot.revision&&draft.feed===feedId&&(draft.replyTo===null||(snapshot.value.conversations||[]).find(c=>c.workId===work.id)?.messages.some(message=>message.id===draft.replyTo));}
function conversationControls(){const work=conversationChoice(),draft=work?conversationDrafts.get(instructionKey(selectedId,work.id)):null,ready=revisionEditable()&&!!work;$('conversation-fields').disabled=!ready;$('conversation-send').disabled=!ready||!conversationCurrent(work,draft)||!draft.text.trim()||new TextEncoder().encode(draft.text).length>4096;$('conversation-review').disabled=!ready;$('conversation-cancel').disabled=!ready;}
function renderConversation(){
 const focus=document.activeElement?.id,mission=snapshot?.value;if(!mission||mission.id!==selectedId){$('conversation-target').replaceChildren();$('conversation-messages').replaceChildren();conversationControls();return;}
 const target=$('conversation-target'),selected=conversationSelections.get(selectedId)||'';target.replaceChildren();const placeholder=element('option','Choose exact Work conversation');placeholder.value='';target.append(placeholder);for(const work of mission.works){const option=element('option',work.id+' · '+work.title+' · '+work.execution);option.value=work.id;target.append(option);}target.value=mission.works.some(w=>w.id===selected)?selected:'';
 const work=conversationChoice(),area=$('conversation-messages'),reply=$('conversation-reply');area.replaceChildren();reply.replaceChildren();const newMessage=element('option','New message');newMessage.value='';reply.append(newMessage);
 if(work){const thread=(mission.conversations||[]).find(c=>c.workId===work.id),draft=conversationDraft(work);area.append(element('p',thread?'Conversation '+thread.id+' · '+thread.messages.length+' / 100 stored messages':'No saved conversation for this Work yet.','hint'));for(const message of thread?.messages||[]){area.append(element('p','#'+message.ordinal+' · '+message.id+' · '+message.role+' '+message.actorId+(message.replyTo?' · reply to '+message.replyTo:''),'hint'),element('pre',message.text));const option=element('option','#'+message.ordinal+' · '+message.id);option.value=message.id;reply.append(option);}if(draft.replyTo&&!(thread?.messages||[]).some(message=>message.id===draft.replyTo)){const missing=element('option','Original reply target unavailable · '+draft.replyTo);missing.value=draft.replyTo;reply.append(missing);}reply.value=draft.replyTo||'';$('conversation-text').value=draft.text;$('conversation-base').textContent='Work '+work.id+' · current revision '+snapshot.revision+' · draft reviewed at '+draft.baseRevision+(conversationCurrent(work,draft)?'':' · State or database changed. Review the retained draft deliberately.');$('conversation-status').textContent=conversationStatuses.get(instructionKey(selectedId,work.id))||'Saved discussion is separate from Work instructions and runtime decisions.';
 }else{$('conversation-text').value='';$('conversation-base').textContent='Choose an exact Work. Message drafts are scoped to Mission and Work.';$('conversation-status').textContent='Choose exact Work to read its discussion or write a message.';}
 conversationControls();if(focus&&$('conversation-form').contains($(focus)))restoreControlFocus(document.activeElement,focus);
}
$('conversation-target').addEventListener('change',()=>{conversationSelections.set(selectedId,$('conversation-target').value);renderConversation();});
for(const [id,events] of [['conversation-text',['input']],['conversation-reply',['input','change']]])for(const name of events)$(id).addEventListener(name,()=>{const work=conversationChoice(),workId=work?.id||conversationSelections.get(selectedId),key=instructionKey(selectedId,workId),previous=work?conversationDraft(work):conversationDrafts.get(key);if(!previous)return;conversationDrafts.set(key,{...previous,text:$('conversation-text').value,replyTo:$('conversation-reply').value||null});conversationControls();});
$('conversation-review').addEventListener('click',()=>{if(!revisionEditable())return;const work=conversationChoice();if(!work)return;const draft=conversationDraft(work);conversationDrafts.set(instructionKey(selectedId,work.id),{...draft,baseRevision:snapshot.revision,feed:feedId});conversationStatuses.set(instructionKey(selectedId,work.id),'Draft retained at the current Work and host revision. No message sent.');renderConversation();});
$('conversation-cancel').addEventListener('click',()=>{if(!revisionEditable())return;const work=conversationChoice();if(!work)return;conversationDrafts.delete(instructionKey(selectedId,work.id));conversationStatuses.set(instructionKey(selectedId,work.id),'Private draft cleared. Stored messages remain original.');renderConversation();});
$('conversation-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!revisionEditable())return;const work=conversationChoice(),draft=work?conversationDraft(work):null;if(!conversationCurrent(work,draft)||!draft.text.trim()||new TextEncoder().encode(draft.text).length>4096)return;
 const missionId=selectedId,workId=work.id,key=instructionKey(missionId,workId),messageId=crypto.randomUUID(),submission={missionId,workId,draft,text:draft.text,replyTo:draft.replyTo},body={commandId:messageId,messageId,expectedRevision:draft.baseRevision,workId,text:draft.text,replyTo:draft.replyTo},focus=document.activeElement;
 conversationStatuses.set(key,'Saving this exact owner message once. Awaiting durable receipt.');const saved=await write('/missions/'+encodeURIComponent(missionId)+'/work-message',body,missionId,'Owner conversation message saved. No execution requested.',null,null,null,null,null,null,null,null,submission);
 if(!saved&&!confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))conversationStatuses.set(key,'Message not confirmed here. Exact Work, text and reply target retained. Inspect receipt; no automatic retry.');
 if(snapshot?.value.id===missionId&&selectedId===missionId){renderConversation();if(focus?.id)restoreControlFocus(focus,focus.id==='conversation-send'&&$('conversation-send').disabled?'conversation-text':focus.id);}
});

function currentStoredBudget(choice) {
  return !reconnectRequired && snapshot?.value.id === choice.missionId && selectedId === choice.missionId && feedId === choice.feedId && connectionEpoch === choice.epoch && $('stored-budget-target').value === choice.workId;
}
function cancelStoredBudget(clear = false) {
  storedBudgetSequence++; storedBudgetController?.abort(); storedBudgetController = null;
  if (clear) { storedBudgetState = null; $('stored-budget-results').replaceChildren(); $('stored-budget-status').textContent = 'Choose Work, then read its stored budget changes.'; }
  else if (storedBudgetState) { storedBudgetState.busy = false; storedBudgetState.message = 'History read canceled. Earlier pages and your budget draft are retained. No write was sent.'; }
}
function storedBudgetControls() {
  if (storedBudgetState && !currentStoredBudget(storedBudgetState)) cancelStoredBudget(true);
  const ready = !reconnectRequired && !loading && snapshot?.value.id === selectedId && !!feedId && snapshot.value.works.some(work => work.id === $('stored-budget-target').value);
  const pending = !!storedBudgetState?.busy;
  $('stored-budget-target').disabled = !snapshot || snapshot.value.id !== selectedId || loading;
  $('stored-budget-read').disabled = !ready || pending;
  $('stored-budget-more').disabled = !ready || pending || !storedBudgetState?.loaded || storedBudgetState.complete || storedBudgetState.capped;
  $('stored-budget-cancel').disabled = !pending;
  $('stored-budget-results').setAttribute('aria-busy',String(pending));
}
function renderStoredBudget() {
  if (!snapshot || snapshot.value.id !== selectedId) { cancelStoredBudget(true); storedBudgetControls(); return; }
  const select = $('stored-budget-target'), intended = storedBudgetSelections.get(selectedId) || '';
  select.replaceChildren(); const prompt = element('option','Choose exact Work'); prompt.value = ''; select.append(prompt);
  for (const work of snapshot.value.works) { const option = element('option',work.title + ' · ' + work.id); option.value = work.id; select.append(option); }
  if (intended && !snapshot.value.works.some(work => work.id === intended)) { const stale = element('option',intended + ' is unavailable; no other Work is substituted'); stale.value = intended; select.append(stale); }
  select.value = intended; storedBudgetControls();
  if (!storedBudgetState) return;
  const state = storedBudgetState, area = $('stored-budget-results'), previous = document.activeElement, focused = area.contains(previous) ? previous?.id : null;
  area.replaceChildren();
  if (state.loaded) {
    area.append(element('p','Mission ' + state.missionId + ' · Work ' + state.workId + ' · Feed ' + state.feedId + ' · Read through ' + state.cursor + ' of frozen boundary ' + state.through,'hint'));
    if (!state.changes.length) area.append(element('p','No matching budget changes in the scanned pages. ' + (state.complete ? 'Frozen boundary reached.' : 'More pages remain; this is not complete history.')));
    for (const change of state.changes) { area.append(element('p','Cursor ' + change.cursor + ' · revision ' + change.revision + ' · command ' + change.commandId + ' · actor ' + change.actor + ' · recorded limit ' + change.limit)); const reason = element('pre','Recorded reason: ' + change.reason); reason.id = 'stored-budget-reason-' + change.cursor; area.append(reason); }
  }
  $('stored-budget-status').textContent = state.message;
  if (focused) restoreControlFocus(previous,focused);
}
function validStoredBudgetPage(body,choice) {
  if (!body || body.missionId !== choice.missionId || body.workId !== choice.workId || body.feedId !== choice.feedId || !Number.isSafeInteger(body.through) || body.through < 0 || !Number.isSafeInteger(body.cursor) || body.cursor < choice.cursor || body.cursor > body.through || typeof body.complete !== 'boolean' || body.complete !== (body.cursor === body.through) || !Number.isSafeInteger(body.scannedBatches) || body.scannedBatches < 0 || body.scannedBatches > 20 || body.scannedBatches === 0 && body.cursor !== choice.cursor || body.cursor - choice.cursor < body.scannedBatches || !Array.isArray(body.changes) || body.changes.length > body.scannedBatches || choice.through !== null && body.through !== choice.through || !body.complete && body.cursor <= choice.cursor) return false;
  let last = choice.cursor;
  for (const change of body.changes) {
    if (!change || !Number.isSafeInteger(change.cursor) || change.cursor <= last || change.cursor > body.cursor || !Number.isSafeInteger(change.revision) || change.revision < 1 || typeof change.commandId !== 'string' || !change.commandId || change.commandId.length > 128 || typeof change.actor !== 'string' || !change.actor || change.actor.length > 128 || typeof change.limit !== 'number' || !Number.isFinite(change.limit) || change.limit < 0 || typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 16000) return false;
    last = change.cursor;
  }
  return true;
}
async function readStoredBudget(more) {
  storedBudgetControls(); const button = $(more ? 'stored-budget-more' : 'stored-budget-read');
  if (button.disabled) return;
  if (!more) { cancelStoredBudget(true); storedBudgetState = {missionId:selectedId,workId:$('stored-budget-target').value,feedId,epoch:connectionEpoch,cursor:0,through:null,changes:[],loaded:false,complete:false,capped:false,busy:false,message:''}; }
  const state = storedBudgetState, choice = {...state}, sequence = ++storedBudgetSequence, submittedFocus = document.activeElement, controller = new AbortController(); storedBudgetController = controller;
  state.busy = true; state.message = 'Reading stored history for exact Work. Your budget draft is unchanged…'; renderStoredBudget();
  const path = '/missions/' + encodeURIComponent(choice.missionId) + '/work-budget-history?work=' + encodeURIComponent(choice.workId) + '&limit=20&after=' + choice.cursor + (choice.through === null ? '' : '&through=' + choice.through);
  const timer = setTimeout(() => controller.abort(),15000);
  try {
    const response = await fetch(path,{headers:{'X-Massion-Feed':choice.feedId},signal:controller.signal,cache:'no-store'}), body = await response.json();
    if (sequence !== storedBudgetSequence || !currentStoredBudget(choice)) return;
    if (!response.ok) throw new Error('History read failed.');
    if (!validStoredBudgetPage(body,choice)) throw new Error('History reply did not match the exact Work, feed or page boundary.');
    if (state.changes.length + body.changes.length > 200) { state.capped = true; throw new Error('This view is limited to 200 changes; the next page was not added. Use the history API for larger histories.'); }
    state.changes.push(...body.changes); state.cursor = body.cursor; state.through = body.through; state.loaded = true; state.complete = body.complete;
    state.message = body.complete ? 'Frozen history boundary reached. New changes need a new initial read; no write was sent.' : 'Page read. More pages remain, even when no changes matched. Read the next page deliberately.';
  } catch (error) {
    if (sequence === storedBudgetSequence && currentStoredBudget(choice)) state.message = (error?.message || 'History read unavailable.') + ' Earlier pages and your budget draft remain. Retry deliberately; no write was sent.';
  } finally {
    clearTimeout(timer);
    if (sequence === storedBudgetSequence && currentStoredBudget(choice)) { storedBudgetController = null; state.busy = false; renderStoredBudget(); if (submittedFocus === button) restoreControlFocus(submittedFocus,button.disabled ? 'stored-budget-read' : button.id); }
  }
}
$('stored-budget-target').addEventListener('change',() => { storedBudgetSelections.set(selectedId,$('stored-budget-target').value); cancelStoredBudget(true); renderStoredBudget(); });
$('stored-budget-read').addEventListener('click',() => readStoredBudget(false));
$('stored-budget-more').addEventListener('click',() => readStoredBudget(true));
$('stored-budget-cancel').addEventListener('click',() => { const previous = document.activeElement; cancelStoredBudget(); renderStoredBudget(); if (previous === $('stored-budget-cancel')) restoreControlFocus(previous,'stored-budget-read'); });
function currentStoredIntervention(choice) {
  return !reconnectRequired && snapshot?.value.id === choice.missionId && selectedId === choice.missionId && feedId === choice.feedId && connectionEpoch === choice.epoch && $('stored-intervention-target').value === choice.workId;
}
function cancelStoredIntervention(clear = false) {
  storedInterventionSequence++; storedInterventionController?.abort(); storedInterventionController = null;
  if (clear) { storedInterventionState = null; $('stored-intervention-results').replaceChildren(); $('stored-intervention-status').textContent = 'Choose Work, then read its stored owner interventions.'; }
  else if (storedInterventionState) { storedInterventionState.busy = false; storedInterventionState.message = 'History read canceled. Earlier pages and your budget draft are retained. No write was sent.'; }
}
function storedInterventionControls() {
  if (storedInterventionState && !currentStoredIntervention(storedInterventionState)) cancelStoredIntervention(true);
  const ready = !reconnectRequired && !loading && snapshot?.value.id === selectedId && !!feedId && snapshot.value.works.some(work => work.id === $('stored-intervention-target').value);
  const pending = !!storedInterventionState?.busy;
  $('stored-intervention-target').disabled = !snapshot || snapshot.value.id !== selectedId || loading;
  $('stored-intervention-read').disabled = !ready || pending;
  $('stored-intervention-more').disabled = !ready || pending || !storedInterventionState?.loaded || storedInterventionState.complete || storedInterventionState.capped;
  $('stored-intervention-cancel').disabled = !pending;
  $('stored-intervention-results').setAttribute('aria-busy',String(pending));
}
function renderStoredIntervention() {
  if (!snapshot || snapshot.value.id !== selectedId) { cancelStoredIntervention(true); storedInterventionControls(); return; }
  const select = $('stored-intervention-target'), intended = storedInterventionSelections.get(selectedId) || '';
  select.replaceChildren(); const prompt = element('option','Choose exact Work'); prompt.value = ''; select.append(prompt);
  for (const work of snapshot.value.works) { const option = element('option',work.title + ' · ' + work.id); option.value = work.id; select.append(option); }
  if (intended && !snapshot.value.works.some(work => work.id === intended)) { const stale = element('option',intended + ' is unavailable; no other Work is substituted'); stale.value = intended; select.append(stale); }
  select.value = intended; storedInterventionControls();
  if (!storedInterventionState) return;
  const state = storedInterventionState, area = $('stored-intervention-results'), previous = document.activeElement, focused = area.contains(previous) ? previous?.id : null;
  area.replaceChildren();
  if (state.loaded) {
    area.append(element('p','Mission ' + state.missionId + ' · Work ' + state.workId + ' · Feed ' + state.feedId + ' · Read through ' + state.cursor + ' of frozen boundary ' + state.through,'hint'));
    if (!state.changes.length) area.append(element('p','No matching owner interventions in the scanned pages. ' + (state.complete ? 'Frozen boundary reached.' : 'More pages remain; this is not complete history.')));
    for (const change of state.changes) { area.append(element('p','Cursor ' + change.cursor + ' · resulting Mission revision ' + change.revision + ' · command ' + change.commandId + ' · actor ' + change.actor + ' · action ' + change.action)); if(change.runId)area.append(element('p','Exact original run: ' + change.runId)); const input = element('pre',change.action==='steer' ? 'Recorded instruction: ' + change.instruction : change.action==='close-expired-runtime' ? 'Recorded expired-run closure reason: ' + change.reason : change.action==='quarantine-runtime' ? 'Recorded quarantine reason: ' + change.reason : 'Cancellation intent recorded. External stop is not certified.'); input.id = 'stored-intervention-input-' + change.cursor; area.append(input); }
  }
  $('stored-intervention-status').textContent = state.message;
  if (focused) restoreControlFocus(previous,focused);
}
function validStoredInterventionPage(body,choice) {
  if (!body || body.missionId !== choice.missionId || body.workId !== choice.workId || body.feedId !== choice.feedId || !Number.isSafeInteger(body.through) || body.through < 0 || !Number.isSafeInteger(body.cursor) || body.cursor < choice.cursor || body.cursor > body.through || typeof body.complete !== 'boolean' || body.complete !== (body.cursor === body.through) || !Number.isSafeInteger(body.scannedBatches) || body.scannedBatches < 0 || body.scannedBatches > 20 || body.scannedBatches === 0 && body.cursor !== choice.cursor || body.cursor - choice.cursor < body.scannedBatches || !Array.isArray(body.changes) || body.changes.length > body.scannedBatches || choice.through !== null && body.through !== choice.through || !body.complete && body.cursor <= choice.cursor) return false;
  let last = choice.cursor;
  for (const change of body.changes) {
    if (!change || !Number.isSafeInteger(change.cursor) || change.cursor <= last || change.cursor > body.cursor || !Number.isSafeInteger(change.revision) || change.revision < 1 || typeof change.commandId !== 'string' || !change.commandId || change.commandId.length > 128 || typeof change.actor !== 'string' || !change.actor || change.actor.length > 128 || !['steer','cancel','quarantine-runtime','close-expired-runtime'].includes(change.action) || change.action==='steer' && (typeof change.instruction !== 'string' || !change.instruction.trim() || change.instruction.length>16000) || ['quarantine-runtime','close-expired-runtime'].includes(change.action) && (typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length>16000 || typeof change.runId !== 'string' || !change.runId || change.runId.length>128)) return false;
    last = change.cursor;
  }
  return true;
}
async function readStoredIntervention(more) {
  storedInterventionControls(); const button = $(more ? 'stored-intervention-more' : 'stored-intervention-read');
  if (button.disabled) return;
  if (!more) { cancelStoredIntervention(true); storedInterventionState = {missionId:selectedId,workId:$('stored-intervention-target').value,feedId,epoch:connectionEpoch,cursor:0,through:null,changes:[],loaded:false,complete:false,capped:false,busy:false,message:''}; }
  const state = storedInterventionState, choice = {...state}, sequence = ++storedInterventionSequence, submittedFocus = document.activeElement, controller = new AbortController(); storedInterventionController = controller;
  state.busy = true; state.message = 'Reading stored history for exact Work. Your budget draft is unchanged…'; renderStoredIntervention();
  const path = '/missions/' + encodeURIComponent(choice.missionId) + '/work-intervention-history?work=' + encodeURIComponent(choice.workId) + '&limit=20&after=' + choice.cursor + (choice.through === null ? '' : '&through=' + choice.through);
  const timer = setTimeout(() => controller.abort(),15000);
  try {
    const response = await fetch(path,{headers:{'X-Massion-Feed':choice.feedId},signal:controller.signal,cache:'no-store'}), body = await response.json();
    if (sequence !== storedInterventionSequence || !currentStoredIntervention(choice)) return;
    if (!response.ok) throw new Error('History read failed.');
    if (!validStoredInterventionPage(body,choice)) throw new Error('History reply did not match the exact Work, feed or page boundary.');
    if (state.changes.length + body.changes.length > 200) { state.capped = true; throw new Error('This view is limited to 200 changes; the next page was not added. Use the history API for larger histories.'); }
    state.changes.push(...body.changes); state.cursor = body.cursor; state.through = body.through; state.loaded = true; state.complete = body.complete;
    state.message = body.complete ? 'Frozen history boundary reached. New changes need a new initial read; no write was sent.' : 'Page read. More pages remain, even when no changes matched. Read the next page deliberately.';
  } catch (error) {
    if (sequence === storedInterventionSequence && currentStoredIntervention(choice)) state.message = (error?.message || 'History read unavailable.') + ' Earlier pages and your budget draft remain. Retry deliberately; no write was sent.';
  } finally {
    clearTimeout(timer);
    if (sequence === storedInterventionSequence && currentStoredIntervention(choice)) { storedInterventionController = null; state.busy = false; renderStoredIntervention(); if (submittedFocus === button) restoreControlFocus(submittedFocus,button.disabled ? 'stored-intervention-read' : button.id); }
  }
}
$('stored-intervention-target').addEventListener('change',() => { storedInterventionSelections.set(selectedId,$('stored-intervention-target').value); cancelStoredIntervention(true); renderStoredIntervention(); });
$('stored-intervention-read').addEventListener('click',() => readStoredIntervention(false));
$('stored-intervention-more').addEventListener('click',() => readStoredIntervention(true));
$('stored-intervention-cancel').addEventListener('click',() => { const previous = document.activeElement; cancelStoredIntervention(); renderStoredIntervention(); if (previous === $('stored-intervention-cancel')) restoreControlFocus(previous,'stored-intervention-read'); });
$('budget-target').addEventListener('change',() => {
  if (!revisionEditable()) return;
  const workId = $('budget-target').value; budgetSelections.set(budgetMission,workId); const key = budgetDraftKey();
  if (workId && !budgetDrafts.has(key)) budgetDrafts.set(key,freshBudgetDraft(budgetWork(workId)));
  renderBudget(); controls();
});
for (const id of ['budget-limit','budget-reason']) $(id).addEventListener('input',() => { const draft = budgetDrafts.get(budgetDraftKey()); if (draft) draft.values = budgetValues(); });
$('review-budget').addEventListener('click',() => {
  if (!revisionEditable() || !budgetFresh(budgetWork())) return;
  const key = budgetDraftKey(); budgetDrafts.set(key,{values:budgetValues(),baseRevision:snapshot.revision,feed:feedId}); budgetStatuses.set(key,'Exact Work reviewed against current state. No command was sent.'); renderBudget(); controls();
});
$('cancel-budget').addEventListener('click',() => {
  if (!revisionEditable()) return; const key = budgetDraftKey(); budgetDrafts.set(key,freshBudgetDraft(budgetWork())); budgetStatuses.set(key,'Budget draft canceled. No command was sent.'); renderBudget(); controls();
});
$('budget-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!revisionEditable()) return;
  const missionId = selectedId, work = budgetWork(), values = budgetValues(), key = budgetDraftKey(), draft = budgetDrafts.get(key), limit = Number(values[0]);
  if (!budgetFresh(work) || !values[0].trim() || !Number.isFinite(limit) || limit < work.budget.reserved || limit < 0 || limit === work.budget.limit || !values[1].trim() || values[1].length > 16000 || !draft?.baseRevision || draft.feed !== feedId) { budgetStatuses.set(key,'Choose exact fresh Work, a changed finite nonnegative limit and reason against this host. No command was sent.'); $('budget-status').textContent = budgetStatuses.get(key); return; }
  const body = {commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,workId:work.id,limit,reason:values[1]};
  if (!commandBodyFits(body)) { budgetStatuses.set(key,'Request exceeds 32 KiB UTF-8. Shorten the reason. No command was sent.'); $('budget-status').textContent = budgetStatuses.get(key); return; }
  const submittedFocus = document.activeElement; budgetStatuses.set(key,'Awaiting a durable budget receipt. No execution is requested.'); $('budget-status').textContent = budgetStatuses.get(key);
  const saved = await write('/missions/' + encodeURIComponent(missionId) + '/work-budget',body,missionId,'Owner budget change confirmed; no execution requested.',null,null,{missionId,workId:work.id,values:[...values],expectedRevision:body.expectedRevision});
  if (snapshot?.value.id === missionId && selectedId === missionId) {
    if (saved || confirmedOperations.has(operationKey({missionId,commandId:body.commandId}))) renderBudget();
    else { budgetStatuses.set(key,'Budget change not confirmed here. Exact Work, limit and reason are retained. Inspect command status; no command is retried.'); $('budget-status').textContent = budgetStatuses.get(key); }
    if ($('budget-form').contains(submittedFocus)) { budgetFocus = {missionId,previous:submittedFocus,targetId:submittedFocus.id}; controls(); }
  }
});

function retirementValues() { return [$('retirement-target').value,$('retirement-reason').value]; }
function retirementLabel(value) { try { const target = JSON.parse(value); if (Array.isArray(target) && target.length === 2) return String(target[0]) + ' · version ' + String(target[1]); } catch {} return 'invalid exact selection'; }
function freshRetirementDraft() { return {values:['',''],baseRevision:null,feed:''}; }
function activeRetirementTarget(value) {
  return (snapshot?.value.memories || []).find(m => m.authority === 'explicit' && m.effective === true && m.scope === snapshot.value.scope && JSON.stringify([m.id,m.version]) === value);
}
function renderRetirement() {
  const missionId = snapshot.value.id;
  if (retirementMission !== missionId) {
    retirementMission = missionId;
    const draft = retirementDrafts.get(missionId) || freshRetirementDraft(); retirementDrafts.set(missionId,draft);
    $('retirement-target').value = draft.values[0]; $('retirement-reason').value = draft.values[1];
    $('retirement-status').textContent = 'Choose an exact version and review what will remain.';
  }
  for (const [key, submission] of retirementSubmissions) {
    if (submission.missionId !== missionId || !confirmedOperations.has(key) || snapshot.revision <= submission.expectedRevision) continue;
    if (JSON.stringify(retirementValues()) === JSON.stringify(submission.values)) { retirementDrafts.set(missionId,freshRetirementDraft()); $('retirement-target').value = ''; $('retirement-reason').value = ''; }
    retirementSubmissions.delete(key);
    $('retirement-status').textContent = 'Confirmed: ' + submission.label + ' stopped for future Work. Earlier Work, original content and history are retained. Any later draft edits are kept.';
  }
  const draft = retirementDrafts.get(missionId), select = $('retirement-target');
  select.replaceChildren(); const prompt = element('option','Choose an exact active explicit version'); prompt.value = ''; select.append(prompt);
  for (const memory of snapshot.value.memories || []) {
    if (memory.authority !== 'explicit' || memory.effective !== true || memory.scope !== snapshot.value.scope) continue;
    const option = element('option',memory.id + ' · version ' + memory.version); option.value = JSON.stringify([memory.id,memory.version]); select.append(option);
  }
  if (draft.values[0] && !activeRetirementTarget(draft.values[0])) { const stale = element('option','Previously selected ' + retirementLabel(draft.values[0]) + ' is no longer active; choose again'); stale.value = draft.values[0]; select.append(stale); }
  select.value = draft.values[0];
  $('retirement-base').textContent = 'Current revision ' + snapshot.revision + (draft.baseRevision === null ? ' · No target selected.' : ' · Draft based on revision ' + draft.baseRevision + (draft.baseRevision !== snapshot.revision || draft.feed !== feedId ? ' · State changed. Review the exact current target before a deliberate new submission.' : ''));
  if (draft.values[0] && !activeRetirementTarget(draft.values[0])) $('retirement-base').textContent += ' The selected version is inactive or unavailable; no newer version is substituted.';
  $('review-retirement').disabled = !activeRetirementTarget(draft.values[0]);
}
$('retirement-target').addEventListener('change',() => {
  if (!revisionEditable()) return;
  const active = activeRetirementTarget($('retirement-target').value);
  retirementDrafts.set(selectedId,{values:retirementValues(),baseRevision:active ? snapshot.revision : null,feed:feedId}); renderRetirement();
  if (!active) { $('retirement-status').textContent = 'No active version selected. No command was sent; your reason is retained.'; return; }
  $('retirement-status').textContent = 'Exact target selected. Review the reason; original content and earlier Work will remain.';
});
$('retirement-reason').addEventListener('input',() => { const draft = retirementDrafts.get(retirementMission); if (draft) draft.values = retirementValues(); });
$('review-retirement').addEventListener('click',() => {
  if (!revisionEditable() || !activeRetirementTarget($('retirement-target').value)) return;
  retirementDrafts.set(selectedId,{values:retirementValues(),baseRevision:snapshot.revision,feed:feedId}); renderRetirement();
  $('retirement-status').textContent = 'Exact target retained against current revision. Review before stopping future application. No command was sent.';
});
$('cancel-retirement').addEventListener('click',() => { if (!revisionEditable()) return; retirementDrafts.set(selectedId,freshRetirementDraft()); $('retirement-target').value = ''; $('retirement-reason').value = ''; renderRetirement(); $('retirement-status').textContent = 'Stop draft canceled. No command was sent; current memory application, original content and history are unchanged.'; });
$('retirement-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!revisionEditable()) return;
  const missionId = selectedId, values = retirementValues(), draft = retirementDrafts.get(missionId), target = activeRetirementTarget(values[0]);
  if (!target || !values[1].trim() || values[1].length > 16000 || !draft?.baseRevision || draft.feed !== feedId) { $('retirement-status').textContent = 'Choose an exact active explicit version and a reason against this host. No command was sent; no newer version is substituted.'; return; }
  const body = {commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,memoryId:target.id,version:target.version,reason:values[1]}, label = target.id + ' · version ' + target.version;
  if (!commandBodyFits(body)) { $('retirement-status').textContent = 'Request exceeds the 32 KiB UTF-8 limit. Shorten the reason. No command was sent.'; return; }
  const submittedFocus = document.activeElement; $('retirement-status').textContent = 'Stopping ' + label + ' for future Work; awaiting a durable receipt. Nothing is deleted…';
  const saved = await write('/missions/' + encodeURIComponent(missionId) + '/memory-retirement',body,missionId,'Exact memory version stopped for future Work; original content and earlier Work retained.',null,{missionId,values:[...values],expectedRevision:body.expectedRevision,label});
  if (snapshot?.value.id === missionId && selectedId === missionId) {
    if (saved || confirmedOperations.has(operationKey({missionId,commandId:body.commandId}))) renderRetirement();
    else $('retirement-status').textContent = 'Stop request not confirmed here. Your exact target and reason are retained. Inspect command status and current history; no command is retried.';
    if ($('retirement-form').contains(submittedFocus)) { retirementFocus = {missionId,previous:submittedFocus,targetId:submittedFocus.id}; controls(); }
  }
});
$('memory-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!snapshot || snapshot.value.id !== selectedId || reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const values = memoryValues(), id = values[0].trim(), version = Number(values[1]);
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(id) || !Number.isSafeInteger(version) || version < 1 || !values[2].trim() || !values[3].trim()) { $('memory-status').textContent = 'Enter a valid ID, positive integer version, instruction and owner source. No command was sent.'; return; }
  const missionId = snapshot.value.id, submittedFocus = document.activeElement;
  const body = {commandId:crypto.randomUUID(),expectedRevision:snapshot.revision,memory:{id,version,content:values[2],source:values[3]}};
  if (!commandBodyFits(body)) { $('memory-status').textContent = 'Memory request exceeds the 32 KiB UTF-8 limit. Shorten instruction or source. No command was sent.'; $('memory-status').className = 'status error'; return; }
  $('memory-status').className = 'status';
  $('memory-status').textContent = 'Saving explicit memory. No Work or model execution is requested…';
  const saved = await write('/missions/' + encodeURIComponent(missionId) + '/memory',body,missionId,'Explicit memory saved. Earlier Work retains its pinned versions.');
  const confirmed = saved || confirmedOperations.has(operationKey({missionId,commandId:body.commandId}));
  if (snapshot?.value.id === missionId && selectedId === missionId) {
    if (confirmed && JSON.stringify(memoryValues()) === JSON.stringify(values)) { for (let i=0;i<memoryIds.length;i++) $(memoryIds[i]).value = ['', '1', '', ''][i]; memoryDrafts.set(missionId,memoryValues()); }
    $('memory-status').textContent = confirmed ? 'Explicit version confirmed. New Work will pin current effective memory; earlier Work stays unchanged.' : 'Memory save was not confirmed here. Inspect the command status and current history; your draft is retained and no command is retried.';
    if ($('memory-form').contains(submittedFocus)) { memoryFocus = {missionId,previous:submittedFocus,targetId:submittedFocus.id}; controls(); }
  }
});
$('mission-form').addEventListener('submit', async event => {
  event.preventDefault(); if (reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const purpose = $('purpose').value.trim(), scope = $('scope').value.trim(), description = $('criteria').value.trim();
  if (!purpose || !scope || !description) { report('Purpose, scope and success criteria are required.','error'); return; }
  const submittedFocus = document.activeElement;
  const id = 'mission:' + crypto.randomUUID();
  const body = {id,commandId:crypto.randomUUID(),purpose,scope,constraints:$('constraints').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean),criteria:{version:1,description,oracle:$('criteria-oracle').value || 'manual-review/v1'}};
  if (await write('/missions',body,id,'Mission created.')) $('mission-form').reset();
  if (selectedId === id && snapshot?.value.id === id && $('mission-form').contains(submittedFocus)) restoreControlFocus(submittedFocus,submittedFocus.id);
});
$('work-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!snapshot || reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const title = $('work-title').value.trim(), budgetText = $('work-budget').value, budget = Number(budgetText);
  if (!title || !budgetText || !Number.isFinite(budget) || budget < 0) { report('Enter a Work title and a nonnegative finite budget.','error'); return; }
  const id = snapshot.value.id, submittedFocus = document.activeElement;
  const body = {commandId:crypto.randomUUID(),expectedRevision:snapshot.revision,workId:'work:' + crypto.randomUUID(),title,budget};
  if (await write('/missions/' + encodeURIComponent(id) + '/work',body,id,'Work admitted. No model execution was started.')) $('work-form').reset();
  if (selectedId === id && snapshot?.value.id === id && $('work-form').contains(submittedFocus)) restoreControlFocus(submittedFocus,submittedFocus.id);
});
$('load-form').addEventListener('submit', event => { event.preventDefault(); if (!busy) void loadMission($('mission-id').value.trim()); });
$('run-fixture').addEventListener('click', async () => {
  if (reconnectRequired || busy || loading || unknownOperation || recoveryProblem || fixtureUnknown) return;
  const fixtureFeed = feedId;
  busy = true; controls();
  if (!await claimFixture()) { busy = false; controls(); return; }
  controls(); report('Running the separate controlled development fixture. Real local file and process effects are in flight…');
  try {
    const {response, body} = await request('/fixture-run',{method:'POST',headers:{'Content-Type':'application/json',...(fixtureFeed ? {'X-Massion-Feed':fixtureFeed} : {})},body:'{}'},120000);
    if (body.outcome === 'rejected' && body.reason === 'feed') { await clearFixture(); requireReconnect(); report('Database changed before fixture admission. No fixture was executed or retried.','warning'); return; }
    if (fixtureFeed && fixtureFeed !== feedId) { requireReconnect(); throw new Error('Fixture response belongs to the previous database'); }
    if (response.status >= 500) throw new Error(body.error || 'The fixture outcome was not confirmed.');
    if (!response.ok) { await clearFixture(); report('Fixture rejected: ' + (body.error || 'HTTP ' + response.status),'error'); return; }
    if (typeof body.missionId !== 'string') throw new Error('No fixture Mission ID was returned.');
    await verifyAcknowledgementFeed(fixtureFeed,body.feedId,body.missionId);
    const loaded = await loadMission(body.missionId,false); if (!loaded) throw new Error('Current fixture Mission could not be read from its originating feed');
    await clearFixture(); report('Controlled fixture returned. Inspect its Mission and fixture-class Records.','success');
  } catch (error) {
    report('Fixture outcome unknown: ' + error.message + ' Do not restart it blindly. Inspect durable activity and the host logs to find its Mission.','warning');
    fixtureUnknown = true;
  } finally { busy = false; controls(); }
});
let connectionCatalog=null,connectionSequence=0,connectionBusy=false,connectionDiscovery=null,connectionReading=false;
const connectionButtons=new Set();
function connectionLocked(){return !connectionCatalog||reconnectRequired||busy||loading||!!unknownOperation||!!recoveryProblem||!!snapshot?.value.works.some(work=>work.execution==='active'||work.effects.some(effect=>effect.status==='pending'||effect.status==='unknown'));}
function connectionControls(){const locked=connectionBusy||connectionLocked();for(const button of connectionButtons)button.disabled=locked;$('connection-fields').disabled=connectionLocked()||connectionBusy&&!connectionReading||!connectionCatalog||!!connectionCatalog.host?.managed;}
function installConnections(body){
 if(!body||!Array.isArray(body.providerTypes)||!Array.isArray(body.connections)||!body.runtime||!Array.isArray(body.runtime.connections)||!Array.isArray(body.runtime.authorizations))throw new Error('Invalid connection catalog');
 connectionCatalog=body;runtimeConfiguration=body.runtime;executionDrafts.clear();providerNotice();if(snapshot)renderMission();renderConnections();
}
function connectionField(form,title,node){const lab=element('label',title);if(node.id)lab.htmlFor=node.id;form.append(lab,node);return node;}
async function connectionWrite(path,body){
 const epoch=connectionEpoch;let response,result;
 try{const reply=await request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},20000);response=reply.response;result=reply.body;}
 catch(error){requireReconnect();void pollEvents();throw error;}
 if(epoch!==connectionEpoch||reconnectRequired){requireReconnect();void pollEvents();throw new Error('Host connection changed during the request. Refresh before further changes; no retry occurred.');}
 if(!response.ok)throw new Error(result.error||'Connection request failed');return result;
}

function renderConnections(){
 const area=$('connection-list'),focused=document.activeElement;const focusId=focused?.id && area.contains(focused) ? focused.id : null;area.replaceChildren();connectionButtons.clear();if(!connectionCatalog)return;
 for(const c of connectionCatalog.connections){
  const card=element('div',undefined,'work-card');card.append(element('h3',c.label),element('p',c.protocol+' · '+c.auth+' · '+c.connectionStatus+' · live execution not verified','hint'));
  const discover=element('button','Explore models');discover.type='button';connectionButtons.add(discover);discover.className='secondary';discover.disabled=connectionBusy;const notice=element('p',c.discovery==='discovery-failed'?'Discovery unavailable; enter an exact model manually.':'Model metadata is not proof of inference or model quality.','hint');
  discover.addEventListener('click',async()=>{if(connectionBusy||connectionLocked())return;const sequence=++connectionSequence;connectionReading=true;connectionBusy=true;connectionControls();connectionDiscovery?.abort();const controller=new AbortController();connectionDiscovery=controller;discover.disabled=true;notice.textContent='Reading provider model metadata…';try{const {response,body}=await request('/connections/'+encodeURIComponent(c.id)+'/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedConfigHash:c.configHash}),signal:controller.signal},20000);if(sequence!==connectionSequence)return;if(!response.ok)throw new Error(body.error||'Discovery failed');notice.textContent=body.message;if(body.status==='stale')return;const current=connectionCatalog.connections.find(x=>x.id===c.id&&x.configHash===c.configHash);if(current){current.models=body.models;current.discovery=body.status==='listed'?'models-discovered':'discovery-failed';populate();}}catch(error){if(sequence===connectionSequence)notice.textContent='Model discovery unavailable. Enter an exact model ID manually.';}finally{if(sequence===connectionSequence){connectionReading=false;connectionBusy=false;connectionControls();}}});card.append(discover,notice);
  const form=element('form');form.className='model-connect-form';const models=element('select');models.id='discovered-'+c.id;const model=element('input');model.id='manual-model-'+c.id;model.required=true;model.maxLength=256;const name=element('input');name.id='model-label-'+c.id;name.required=true;name.maxLength=512;
  function populate(){models.replaceChildren();const empty=element('option','Choose discovered model or enter manually');empty.value='';models.append(empty);for(const m of c.models){const option=element('option',m.label+' · '+m.id);option.value=m.id;models.append(option);}}
  populate();models.addEventListener('change',()=>{model.value=models.value;name.value=c.label+' / '+models.value;});connectionField(form,'Discovered models',models);connectionField(form,'Exact model ID (manual fallback)',model);connectionField(form,'Model connection name',name);const save=element('button','Use this model');save.type='submit';connectionButtons.add(save);form.append(save);form.addEventListener('submit',async event=>{event.preventDefault();if(connectionBusy||connectionLocked())return;const submittedFocus=document.activeElement;connectionBusy=true;connectionControls();save.disabled=true;try{installConnections(await connectionWrite('/connections/'+encodeURIComponent(c.id)+'/profiles',{model:model.value,label:name.value,expectedConfigHash:c.configHash}));$('connection-status').textContent='Model configuration saved. Choose executor/reviewer roles and explicit permitted use before running.';}catch(error){notice.textContent=error.message;}finally{connectionBusy=false;connectionControls();if(form.contains(submittedFocus))restoreControlFocus(submittedFocus,submittedFocus.id || 'manual-model-'+c.id);}});card.append(form);area.append(card);
 }
 if(connectionCatalog.runtime.connections.length){
  const form=element('form');form.className='connection-authorization-form';form.append(element('h3','Permit selected models for a Mission scope'));const exec=element('select'),verify=element('select');exec.id='grant-executor';verify.id='grant-verifier';for(const field of [exec,verify]){const blank=element('option','Choose exact model connection');blank.value='';field.append(blank);for(const p of connectionCatalog.runtime.connections){const option=element('option',p.label+(p.diagnostics.length?' · credential or configuration required':''));option.value=p.id;option.disabled=p.diagnostics.length>0;field.append(option);}}connectionField(form,'Executor',exec);connectionField(form,'Independent verifier',verify);const scope=element('input');scope.id='grant-scope';scope.value=snapshot?.value.scope||$('scope').value;scope.required=true;connectionField(form,'Mission scope',scope);const cap=element('input');cap.id='grant-cap';cap.type='number';cap.value='1024';cap.min='1';cap.max='4096';cap.required=true;connectionField(form,'Maximum output tokens per call',cap);const button=element('button','Permit these models for this scope');button.type='submit';connectionButtons.add(button);form.append(button,element('p','Permission does not run a model. Cost and total token usage remain unknown. Live execution also requires a separately authorized host integration.','hint'));form.addEventListener('submit',async event=>{event.preventDefault();if(connectionBusy||connectionLocked())return;const submittedFocus=document.activeElement;connectionBusy=true;connectionControls();button.disabled=true;try{installConnections(await connectionWrite('/connection-authorizations',{id:'authorization:'+crypto.randomUUID(),scope:scope.value,executorProfileId:exec.value,verifierProfileId:verify.value,maxOutputTokensPerCall:Number(cap.value),expectedConfigHash:connectionCatalog.configHash}));$('connection-status').textContent='Scoped permission saved. Open a Work, check the selection and request its run explicitly.';}catch(error){$('connection-status').textContent=error.message;}finally{connectionBusy=false;connectionControls();if(form.contains(submittedFocus))restoreControlFocus(submittedFocus,submittedFocus.id || 'grant-executor');}});area.append(form);
 }
 connectionControls();if(focusId)restoreControlFocus(focused,focusId);
}
async function refreshConnections(){try{const {response,body}=await request('/connections');if(!response.ok)throw new Error('Setup not enabled');installConnections(body);$('connection-form').hidden=!!body.host?.managed;$('connection-heading').textContent=body.host?.managed?'Host model connections':'Connect a model provider';const kind=$('connection-kind');kind.replaceChildren();for(const p of body.providerTypes){const option=element('option',p.label);option.value=p.id;kind.append(option);}kind.value=body.providerTypes[0]?.id||'';$('connection-base').value=body.providerTypes[0]?.baseUrl||'';const mode=$('connection-mode');mode.replaceChildren();for(const value of body.fixtureModeEnabled?['https','local-http-mock']:['https']){const option=element('option',value==='https'?'HTTPS API':'Local test fixture (not live verification)');option.value=value;mode.append(option);}mode.value='https';connectionControls();$('connection-status').textContent=body.host?.managed?'Host manifest '+body.host.revision+' loaded. '+(body.liveExecutionEnabled?'Live capability enabled; scoped permission and explicit Run still required.':'Live model calls disabled.')+' Destinations and models are host-declared; edit the manifest and restart to change them.':'Connection setup ready. Credentials are host-owned; live model execution has not been verified.';}catch{connectionCatalog=null;++connectionSequence;connectionDiscovery?.abort();renderConnections();$('connection-fields').disabled=true;$('connection-status').textContent='Connection setup is unavailable. Refresh before changing model connections.';}}
$('connection-kind').addEventListener('change',()=>{if(connectionLocked()||connectionBusy&&!connectionReading)return;++connectionSequence;connectionDiscovery?.abort();connectionReading=false;connectionBusy=false;connectionControls();const p=connectionCatalog?.providerTypes.find(p=>p.id===$('connection-kind').value);$('connection-base').value=p?.baseUrl||'';executionDrafts.clear();if(snapshot)renderMission();renderConnections();});
$('connection-form').addEventListener('submit',async event=>{event.preventDefault();if(connectionBusy||connectionLocked()||!connectionCatalog||connectionCatalog.host?.managed)return;++connectionSequence;connectionDiscovery?.abort();connectionBusy=true;connectionControls();$('connection-fields').disabled=true;try{const value={id:'connection:'+crypto.randomUUID(),label:$('connection-label').value,providerType:$('connection-kind').value,baseUrl:$('connection-base').value,mode:$('connection-mode').value};if($('connection-reference').value)value.secretRef=$('connection-reference').value;installConnections(await connectionWrite('/connections',value));$('connection-reference').value='';$('connection-status').textContent='Connection metadata saved. Explore models or enter a model manually. Live inference remains unverified.';}catch(error){$('connection-status').textContent=error.message;}finally{connectionBusy=false;connectionControls();}});

function requireReconnect() { reconnectRequired = true; ++connectionEpoch; ++connectionSequence; invalidateDocumentRead('Host connection changed. Read exact source again against refreshed Mission state.'); invalidateImpact('Host connection changed. Read impact again against refreshed Mission state.'); connectionDiscovery?.abort(); if(connectionReading){connectionReading=false;connectionBusy=false;} controls(); }
async function refreshProviders() {
  try { const {response,body} = await request('/providers'); if (!response.ok) throw new Error('Provider read failed'); if (!Array.isArray(body.providers) || !body.selection || !['selected','unavailable'].includes(body.selection.status)) throw new Error('Invalid provider response'); providerSelection = body.selection; runtimeConfiguration = body.runtime && Array.isArray(body.runtime.connections) && Array.isArray(body.runtime.authorizations) ? body.runtime : null; providerKnown = true; return true; }
  catch { providerKnown = false; runtimeConfiguration = null; providerNotice(); if (snapshot) renderMission(); return false; }
}
async function connect() {
  requireReconnect();
  try { const {response,body} = await request('/health'); if (!response.ok) throw new Error('Host unavailable'); $('health').replaceChildren(element('span',undefined,'dot online'),element('span',body.status === 'ready' ? 'Host ready' : String(body.status || 'Host reachable'))); }
  catch { $('health').textContent = 'Host unavailable'; }
  await pollEvents();
  if (!selectedId && initialReference.present) report('Invalid Mission link. Enter a valid Mission ID to continue.', 'error');
}
${runSequenceClient}
${prerequisiteClient}
${rejectedTextClient}
controls(); void connect();
setInterval(() => { if (!document.hidden) void pollEvents(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { void pollEvents(); if (selectedId && !busy && !loading) void loadMission(selectedId,false); } });
window.addEventListener('online', () => { void connect(); });
window.addEventListener('offline', requireReconnect);
function restoreMissionAddress() { window.history.replaceState(null, '', snapshot ? '#mission=' + encodeURIComponent(snapshot.value.id) : window.location.pathname + window.location.search); }
window.addEventListener('hashchange', () => {
  const reference = missionReference();
  if (!reference.id) { restoreMissionAddress(); report('Invalid Mission link. Enter a valid Mission ID to continue.', 'error'); return; }
  if (busy) { restoreMissionAddress(); report('Wait for the current command to settle before opening another Mission.', 'warning'); return; }
  void loadMission(reference.id);
});
</script>
</body>
</html>`;
