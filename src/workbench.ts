import {workRoomStyle,workRoomClient} from './work-room-panel.ts';
import {uiTokensStyle} from './ui-tokens.ts';
import {copy,uiCopyClient} from './ui-copy.ts';
import {protocolClientScript} from './client-protocol.ts';
import {memoryExpiryPanel,memoryExpiryClient} from './memory-expiry-panel.ts';
import {memoryConflictPanel,memoryConflictClient} from './memory-conflict-panel.ts';
import {missionConstraintsPanel,missionConstraintsClient} from './mission-constraints-panel.ts';
import {neighborhoodPanel,neighborhoodClient} from './knowledge-neighborhood-panel.ts';
import {recordSourcePanel,recordSourceClient} from './accepted-result-source-draft.ts';
import {workInboxPanel,workInboxClient} from './work-inbox-panel.ts';
import {missionCatalogPanel,missionCatalogClient} from './mission-catalog-panel.ts';
import {fileDocumentPanel,fileDocumentClient} from './owner-file-document-draft.ts';
import {memoryUsagePanel,memoryUsageClient} from './memory-usage-panel.ts';
import {memoryFindPanel,memoryFindClient} from './memory-find-panel.ts';
import {memorySearchPanel,memorySearchClient} from './memory-content-search-panel.ts';
import {clarificationPanel,clarificationClient} from './work-clarification-panel.ts';
import {conversationWorkPanel,conversationWorkClient} from './conversation-work-panel.ts';
import {expiredPanel,expiredClient} from './expired-run-panel.ts';
import {correctionPanel,correctionClient} from './work-correction-panel.ts';
import {rejectedTextClient} from './rejected-text-panel.ts';
import {reflectionTrailClient} from './reflection-trail-panel.ts';
import {prerequisitePanel,prerequisiteClient} from './work-prerequisite-panel.ts';
import {runSequencePanel,runSequenceClient} from './run-sequence-panel.ts';
import {MAX_REQUEST_BODY_BYTES} from './request-limits.ts';
import {chatPanel,chatClient,chatStyle} from './assistant-conversation-panel.ts';
import {memberDialog,memberClient,memberStyle} from './members-panel.ts';
import {resultsPage,resultsPane,resultsClient,resultsStyle} from './results-panel.ts';
import {schedulesPage,schedulesClient,schedulesStyle} from './schedules-panel.ts';
import {settingsSection,settingsClient,settingsStyle} from './settings-panel.ts';
import {appsStyle,appsPage,appsPane,appsClient} from './apps-panel.ts';
import {shellStyle,shellRail,shellSidebar,shellBand,shellPaneBar,shellClient} from './surface-shell.ts';
/** Self-contained loopback client. All user and host text is rendered through textContent. */
export const workbenchPage = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${copy("page.heading.01")}</title>
<style>
${uiTokensStyle}
:root{font-family:var(--font-sans);color:var(--fg);background:var(--bg-0);font-synthesis:none}*{box-sizing:border-box}body{margin:0}button,input,textarea,select{font:inherit}button,input,textarea,select,summary{outline-offset:var(--focus-offset)}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible,pre:focus-visible,.work-title:focus-visible{outline:var(--focus-width) solid var(--focus-ring)}button{border:1px solid var(--green);border-radius:8px;background:var(--green);color:var(--bg-0);padding:10px 15px;font-weight:650;cursor:pointer;min-height:42px}button.secondary{background:var(--bg-1);color:var(--ink);border-color:var(--line-strong)}button.quiet{background:transparent;color:var(--green);border-color:transparent}button.danger{color:var(--halt);border-color:var(--line);background:var(--bg-1)}button:disabled{opacity:.48;cursor:not-allowed}input,textarea,select{width:100%;padding:10px 11px;border:1px solid var(--line-strong);border-radius:7px;background:var(--bg-1);color:var(--ink);min-width:0}textarea{resize:vertical;line-height:1.5}label{display:block;font-size:.84rem;font-weight:650;margin-bottom:7px}input:disabled,textarea:disabled,select:disabled{background:var(--bg-2)}fieldset{padding:0;border:0;margin:0;min-width:0}h1,h2,h3,h4,p{margin-top:0}h1{font-size:clamp(1.8rem,3vw,2.65rem);line-height:1.13;letter-spacing:-.06em;margin-bottom:12px;font-weight:650}h2{font-size:1.05rem;letter-spacing:-.02em;margin-bottom:16px}h3{font-size:1.08rem;line-height:1.45;margin:0}h4{font-size:.85rem;margin:18px 0 8px}p{line-height:1.55}#stored-intervention-panel p{overflow-wrap:anywhere}small,.muted,.hint{color:var(--muted)}small,.hint{font-size:.77rem;line-height:1.5}.hint{margin:7px 0 0}.eyebrow{font-size:.67rem;letter-spacing:.12em;text-transform:uppercase;font-weight:750;color:var(--green);margin-bottom:8px}.shell{max-width:1300px;padding:0 36px;margin:auto}header{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:12px}.brand{display:flex;align-items:center;gap:10px;font-size:1.2rem;letter-spacing:-.04em;font-weight:750}.mark{display:grid;place-items:center;width:31px;height:31px;background:var(--green);color:var(--bg-0);border-radius:8px;font-size:1rem}.header-meta{display:flex;align-items:center;gap:10px;font-size:.73rem;color:var(--muted)}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--fg-4);margin-right:5px}.dot.online{background:var(--fg-3)}.intro{padding:32px 0 22px;display:flex;justify-content:space-between;align-items:end;gap:20px}.intro p{max-width:610px;margin:0;color:var(--muted);font-size:.9rem}.intro-side{max-width:255px;font-size:.75rem!important}.layout{display:grid;grid-template-columns:minmax(270px,340px) minmax(0,1fr);gap:24px;align-items:start;padding-bottom:32px}.stack{display:grid;gap:18px}.panel{border:1px solid var(--line);background:var(--bg-1);border-radius:13px;padding:22px;box-shadow:0 3px 10px transparent}.field{margin-bottom:16px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.spread{justify-content:space-between}.grow{flex:1;min-width:150px}.full{width:100%}.section-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:17px}.section-top h2{margin:0}.tag{display:inline-block;font-size:.69rem;line-height:1.3;padding:5px 8px;border-radius:6px;background:var(--bg-2);color:var(--fg-2);white-space:nowrap}.tag.good{background:var(--bg-2);color:var(--fg)}.tag.warn{background:var(--warn-bg);color:var(--warn)}.tag.bad{background:var(--bg-2);color:var(--halt)}.notice{padding:13px 15px;border-radius:8px;border:1px solid var(--line);background:var(--warn-bg);color:var(--fg-2);font-size:.82rem;line-height:1.5;margin-bottom:18px}.notice p{margin:0}.status{margin:0 0 19px;font-size:.8rem;line-height:1.5;min-height:20px;color:var(--muted);overflow-wrap:anywhere}.status.error{color:var(--halt)}.status.warning{color:var(--warn)}.status.success{color:var(--green)}.empty{padding:38px 30px;text-align:center;border:1px dashed var(--line);border-radius:12px;background:var(--bg-2)}.empty-symbol{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;border:1px solid var(--line);background:var(--bg-2);color:var(--fg-2);margin:0 auto 16px;font-size:1.2rem}.empty h2{margin-bottom:9px}.empty p{max-width:410px;margin:0 auto;color:var(--muted);font-size:.86rem}.mission-purpose{font-size:1.4rem;line-height:1.35;letter-spacing:-.03em;margin:0 0 16px;overflow-wrap:anywhere}.facts{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0}.facts dt,.metric dt{font-size:.7rem;color:var(--muted);margin-bottom:5px}.facts dd,.metric dd{margin:0;font-size:.86rem;line-height:1.5;overflow-wrap:anywhere}.facts ul{margin:0;padding-left:17px}.id{font: .7rem var(--font-mono);color:var(--muted);overflow-wrap:anywhere}.divider{height:1px;background:var(--line);margin:20px 0}.work-list{display:grid;gap:14px}.work-card{border:1px solid var(--line);border-radius:11px;padding:18px;background:var(--bg-1);overflow-wrap:anywhere}.work-title{margin:0 0 10px}.badge-row{display:flex;gap:6px;flex-wrap:wrap;margin:9px 0 15px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;background:var(--bg-2);border-radius:8px;padding:12px;margin:0 0 14px}.metric{margin:0}.metric dd{font-size:.8rem}.work-note{font-size:.8rem;line-height:1.5;margin-bottom:12px;color:var(--muted)}.work-note.warning{color:var(--warn)}details{font-size:.82rem;line-height:1.5}summary{cursor:pointer;font-weight:650;color:var(--green);padding:6px 0}.detail-content{margin-top:10px}.detail-content p,.detail-content ul{margin-bottom:9px}.detail-content ul{padding-left:18px}.detail-content pre,pre{font: .72rem/1.55 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg-2);border:1px solid var(--line);border-radius:7px;padding:12px;max-height:360px;overflow:auto}.controls{border-top:1px solid var(--line);margin-top:14px;padding-top:14px}.steer-form{margin-top:9px}.steer-form .row{align-items:end}.steer-form label{font-size:.75rem}.steer-form textarea{font-size:.83rem}.work-compose{border-top:1px solid var(--line);padding-top:19px;margin-top:22px}.work-compose .budget{width:165px}.event-list{list-style:none;margin:0;padding:0}.event-list li{padding:10px 0;border-top:1px solid var(--bg-2);font-size:.8rem;display:flex;justify-content:space-between;gap:10px}.event-list li:first-child{border-top:0}.event-list small{text-align:right}.fixture{background:var(--bg-2)}.fixture p{font-size:.79rem;margin:10px 0 14px}.footer{font-size:.72rem;color:var(--muted);padding:0 0 30px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}[hidden]{display:none!important}@media(max-width:850px){.shell{padding:0 20px}.layout{grid-template-columns:minmax(240px,300px) minmax(0,1fr);gap:16px}.panel{padding:18px}.intro-side{display:none}.facts{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}.metrics .metric:last-child{grid-column:1/-1}}@media(max-width:650px){header{height:68px}.shell{padding:0 15px}.layout{grid-template-columns:1fr}.intro{padding:26px 0 22px}.header-meta{max-width:180px;text-align:right}.panel{padding:19px}.facts{grid-template-columns:1fr 1fr}.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.metrics .metric:last-child{grid-column:auto}.work-compose .budget{width:100%}.row>button{max-width:100%}}#growth-evaluate-hint{overflow-wrap:anywhere}#growth-create-fields button,#growth-evaluate-fields button{max-width:100%}@media(prefers-reduced-motion:no-preference){button{transition:background var(--motion-fast) var(--motion-ease),opacity var(--motion-fast) var(--motion-ease)}button:hover:not(:disabled){filter:brightness(.96)}}
#sequence-panel{min-width:0;overflow-wrap:anywhere}#sequence-fields select,#sequence-fields input{margin-bottom:14px}
.execution-form select,.execution-form input,#criteria-oracle{margin-bottom:14px}.execution-form button{margin:7px 8px 0 0}
#conversation-panel{overflow-wrap:anywhere;min-width:0}#conversation-messages{max-width:100%;overflow:auto}
.impact-panel{border-top:1px solid var(--line);margin-top:20px;padding-top:14px;overflow-wrap:anywhere}.impact-results{max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:12px}.impact-results:focus-visible{outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-offset)}.impact-results ul{padding-left:20px}.impact-results li{margin-bottom:12px}
.expired-ack-row{display:flex;align-items:flex-start;gap:8px;margin-top:10px}.expired-ack-row input{width:auto;flex:none;margin-top:3px}
${chatStyle}
${memberStyle}
${resultsStyle}
${schedulesStyle}
${settingsStyle}
${appsStyle}
${shellStyle}
${workRoomStyle}</style>
</head>
<body>
<div id="app" class="app">
${shellRail}
${shellSidebar}
<main id="page" class="page" aria-labelledby="page-heading">
${shellBand}
<div id="sync-notice" class="notice" role="status" hidden></div>
<div id="operation-notice" class="notice" role="alert" hidden></div>
<div id="page-status" class="notice" role="alert" hidden></div>
<div id="page-chat" class="page-body">
${chatPanel}
</div>
${memberDialog}
${resultsPage}
${schedulesPage}
${appsPage}
<div id="page-settings" class="page-body" hidden><div class="settings-stack">
${settingsSection('general')}${settingsSection('memory')}${settingsSection('members')}${settingsSection('devices')}
${settingsSection('connections',`<div id="settings-groups"></div><details id="settings-setup" class="set-setup"><summary>${copy("legacy.connection-setup")}</summary>
<section class="panel" aria-labelledby="connection-heading"><h2 id="connection-heading">${copy("legacy.connect-a-model-provider")}</h2><p class="hint">${copy("legacy.choose-an-api-provider-discover-its-models")}</p>
<form id="connection-form"><fieldset id="connection-fields"><label for="connection-kind">${copy("legacy.provider-api")}</label><select id="connection-kind"></select><label for="connection-label">${copy("legacy.connection-name")}</label><input id="connection-label" maxlength="512" required><label for="connection-base">${copy("legacy.api-base-url")}</label><input id="connection-base" type="url" required><label for="connection-reference">${copy("legacy.host-credential-reference-optional")}</label><input id="connection-reference" maxlength="128" autocomplete="off" placeholder="${copy("legacy.opaque-reference-never-an-api-key")}"><label for="connection-mode">${copy("legacy.transport")}</label><select id="connection-mode"><option value="https">${copy("legacy.https-api")}</option></select><button type="submit">${copy("legacy.save-connection")}</button></fieldset></form><p id="connection-status" class="hint" role="status">${copy("legacy.checking-connection-setup")}</p><div id="connection-list"></div></section>
</details>`)}${settingsSection('apps')}${settingsSection('improvements')}${settingsSection('permissions')}
<section id="settings-advanced" class="set-section" aria-labelledby="settings-advanced-title" hidden><h2 id="settings-advanced-title">${copy("legacy.advanced")}</h2>
<span id="health" role="status"><span class="dot"></span>${copy("legacy.connecting")}</span>
<div id="provider-notice" class="notice" role="status">${copy("legacy.checking-provider-availability-no-execution-has-been")}</div>
<section class="panel" aria-labelledby="create-heading"><div class="section-top"><h2 id="create-heading">${copy("legacy.create-mission")}</h2><span class="tag">${copy("legacy.01-purpose")}</span></div>
<form id="mission-form"><fieldset id="mission-fields">
<div class="field"><label for="purpose">${copy("legacy.purpose")}</label><textarea id="purpose" rows="2" maxlength="16000" placeholder="${copy("legacy.what-outcome-should-this-mission-own")}" required></textarea></div>
<div class="field"><label for="scope">${copy("legacy.scope")}</label><input id="scope" maxlength="16000" placeholder="${copy("legacy.a-project-or-area-of-responsibility")}" required></div>
<div class="field"><label for="constraints">${copy("legacy.constraints")} <span class="muted">${copy("legacy.optional")}</span></label><textarea id="constraints" rows="2" maxlength="16000" placeholder="${copy("legacy.one-constraint-per-line")}"></textarea></div>
<div class="field"><label for="criteria">${copy("legacy.success-criteria")}</label><textarea id="criteria" rows="3" maxlength="16000" placeholder="${copy("legacy.what-evidence-would-make-the-outcome-acceptable")}" required></textarea><p id="criteria-oracle-hint" class="hint">${copy("legacy.saved-with-the-selected-acceptance-method-manual")}</p></div>
<label for="criteria-oracle">${copy("legacy.acceptance-method-2")}</label><select id="criteria-oracle" aria-describedby="criteria-oracle-hint"><option value="manual-review/v1">${copy("legacy.manual-review")}</option><option value="bounded-text-review/v1">${copy("legacy.bounded-text-with-independent-model-review")}</option></select><button id="create-mission" class="full" type="submit">${copy("legacy.create-mission")}</button>
</fieldset></form></section>
<section class="panel" aria-labelledby="load-heading"><h2 id="load-heading">${copy("legacy.continue-a-mission")}</h2><form id="load-form"><label for="mission-id">${copy("legacy.mission-id")}</label><input id="mission-id" maxlength="128" pattern="[a-zA-Z0-9:_\-]{1,128}" placeholder="${copy("legacy.mission-2")}" required><div class="row" style="margin-top:12px"><button id="load-mission" class="secondary" type="submit">${copy("legacy.load-refresh")}</button></div><p class="hint"></p></form>${missionCatalogPanel}${workInboxPanel}</section>
<section class="panel fixture"><details><summary>${copy("legacy.development-fixture")}</summary><p>${copy("legacy.this-controlled-local-fixture-creates-a-separate")}</p><button id="run-fixture" class="secondary" type="button">${copy("legacy.run-development-fixture")}</button><p class="hint"></p></details></section>
</section>
</div></div><!-- /page-settings -->
</main>
<section id="work-pane" class="pane" aria-label="${copy("legacy.work-2")}" hidden>
${shellPaneBar}
<div id="pane-body" class="pane-body" role="tabpanel">
<p id="status" class="status" role="status" aria-live="polite">${copy("ui.panel.ready")}</p>
<section id="empty-state" class="empty"><div class="empty-symbol" aria-hidden="true">↗</div><h2>${copy("legacy.no-current-mission-selected")}</h2><p id="empty-message"></p></section>
<section id="mission-panel" class="panel" aria-labelledby="mission-heading" hidden><div class="section-top"><h2 id="mission-heading">${copy("legacy.mission")}</h2><span id="revision" class="tag"></span></div><p id="loaded-id" class="id"></p><p><a id="mission-link" href="#" hidden>${copy("legacy.open-this-mission-in-another-browser")}</a></p><p class="hint"></p><h3 id="mission-purpose" class="mission-purpose"></h3><dl id="mission-facts" class="facts"></dl><div class="divider"></div><div class="section-top"><h2>${copy("legacy.work-2")}</h2><span id="work-count" class="tag"></span></div><div id="work-list" class="work-list"></div>
${prerequisitePanel}
${correctionPanel}
${expiredPanel}
${runSequencePanel}
<details id="revision-panel" class="impact-panel"><summary>${copy("legacy.revise-mission-purpose-and-acceptance")}</summary><p class="hint">${copy("legacy.only-future-work-uses-these-changes-existing")}</p><div id="revision-comparison" tabindex="0" role="region" aria-label="${copy("legacy.current-mission-and-revision-draft-comparison")}" class="impact-results"><p id="revision-current" class="hint"></p><p id="revision-base" class="hint"></p></div><form id="revision-form"><fieldset id="revision-fields"><label for="revision-purpose">${copy("legacy.revised-purpose")}</label><textarea id="revision-purpose" rows="2" maxlength="16000" required></textarea><label for="revision-version">${copy("legacy.new-criteria-version")}</label><input id="revision-version" type="number" min="1" max="9007199254740991" step="1" required><label for="revision-criteria">${copy("legacy.revised-success-criteria")}</label><textarea id="revision-criteria" rows="3" maxlength="16000" required></textarea><label for="revision-oracle">${copy("legacy.acceptance-method-2")}</label><select id="revision-oracle"><option value="manual-review/v1">${copy("legacy.manual-review")}</option><option value="bounded-text-review/v1">${copy("legacy.bounded-text-with-independent-model-review")}</option></select><button id="save-revision" type="submit" data-write>${copy("legacy.save-mission-revision")}</button><button id="rebase-revision" type="button" class="secondary">${copy("legacy.keep-draft-against-current-revision")}</button><button id="discard-revision" type="button" class="secondary">${copy("legacy.discard-revision-draft")}</button></fieldset></form><p id="revision-status" class="status" role="status" aria-live="polite">${copy("legacy.review-current-purpose-and-criteria-before-saving")}</p>${missionConstraintsPanel}</details>
<details id="organization-panel"><summary>${copy("legacy.inspect-and-revise-organization-responsibilities")}</summary><p id="organization-hint" class="hint">${copy("legacy.choose-an-exact-saved-revision-or-new")}</p><p id="organization-current" class="hint"></p><form id="organization-form"><fieldset id="organization-fields"><label for="organization-target">${copy("legacy.exact-source-organization-revision")}</label><select id="organization-target" aria-describedby="organization-hint organization-base"><option value="">${copy("legacy.choose-exact-revision-or-new-definitions")}</option></select><div id="organization-evidence" tabindex="0" role="region" aria-label="${copy("legacy.selected-stored-organization-responsibility-evidence")}" class="impact-results"></div><p id="organization-base" class="hint"></p><label for="organization-version">${copy("legacy.new-organization-version")}</label><input id="organization-version" type="number" readonly aria-describedby="organization-base"><label for="organization-executor">${copy("legacy.executor-responsibility-required-text-output")}</label><textarea id="organization-executor" rows="3" maxlength="2000" required></textarea><label for="organization-verifier">${copy("legacy.independent-verifier-responsibility-required-independent-text-review")}</label><textarea id="organization-verifier" rows="3" maxlength="2000" required></textarea><label for="organization-reason">${copy("legacy.reason-for-this-new-revision")}</label><textarea id="organization-reason" rows="2" maxlength="2000" required></textarea><div class="row"><button id="save-organization" type="submit" data-write>${copy("legacy.save-new-responsibility-revision")}</button><button id="review-organization" type="button" class="secondary">${copy("legacy.review-draft-against-current-revision")}</button><button id="cancel-organization" type="button" class="secondary">${copy("legacy.cancel-private-responsibility-draft")}</button></div></fieldset></form><p id="organization-status" class="status" role="status" aria-live="polite">${copy("legacy.choose-a-source-revision-and-review-its")}</p><button id="organization-recheck" type="button" class="secondary">${copy("legacy.check-pending-command-receipt")}</button><p class="hint">${copy("legacy.if-the-outcome-is-unknown-this-checks")}</p></details>
<details id="growth-create-panel"><summary>${copy("legacy.propose-a-scoped-memory-improvement")}</summary><p class="hint">${copy("legacy.choose-an-exact-effective-baseline-and-a")}</p><form id="growth-create-form"><fieldset id="growth-create-fields"><label for="growth-create-id">${copy("legacy.new-proposal-id")}</label><input id="growth-create-id" required maxlength="128"><label for="growth-create-baseline">${copy("legacy.exact-effective-baseline-memory-version")}</label><input id="growth-create-baseline" required><label for="growth-create-memory">${copy("legacy.candidate-memory-id")}</label><input id="growth-create-memory" required maxlength="128"><label for="growth-create-version">${copy("legacy.new-candidate-version")}</label><input id="growth-create-version" type="number" min="1" required><label for="growth-create-content">${copy("legacy.candidate-instruction")}</label><textarea id="growth-create-content" required maxlength="16000"></textarea><label for="growth-create-source">${copy("legacy.candidate-source")}</label><textarea id="growth-create-source" required maxlength="16000"></textarea><label for="growth-create-counter">${copy("legacy.counterevidence-or-limitations")}</label><textarea id="growth-create-counter" required maxlength="16000"></textarea><p id="growth-create-base" class="hint"></p><button id="growth-create-review" type="button">${copy("legacy.review-proposal-against-current-revision")}</button><button id="growth-create-submit" type="submit" data-write>${copy("legacy.create-inactive-memory-proposal")}</button></fieldset></form><p id="growth-create-status" role="status" aria-live="polite">${copy("legacy.enter-an-exact-baseline-candidate-source-and")}</p></details>
<details id="growth-panel"><summary>${copy("legacy.inspect-evaluated-memory-growth")}</summary><p id="growth-hint" class="hint">${copy("legacy.inspect-stored-proposal-and-evaluation-evidence-before")}</p><label for="growth-target">${copy("legacy.exact-stored-proposal")}</label><select id="growth-target" aria-describedby="growth-hint"><option value="">${copy("legacy.choose-exact-proposal")}</option></select><div id="growth-evidence" tabindex="0" role="region" aria-label="${copy("legacy.stored-growth-evaluation-evidence")}"></div><p id="growth-base" class="hint"></p><form id="growth-form"><fieldset id="growth-fields"><div class="row"><button id="adopt-growth" type="button">${copy("legacy.adopt-exact-evaluated-memory")}</button><button id="revert-growth" type="button">${copy("legacy.revert-exact-adoption")}</button><button id="review-growth" type="button" class="secondary">${copy("legacy.review-proposal-against-current-revision")}</button><button id="cancel-growth" type="button" class="secondary">${copy("legacy.clear-private-selection")}</button></div></fieldset></form><p id="growth-status" class="status" role="status" aria-live="polite">${copy("legacy.choose-a-stored-proposal-to-inspect-its")}</p><form id="growth-evaluate-form"><fieldset id="growth-evaluate-fields"><label for="growth-evaluate-cases">${copy("legacy.input-orders-as-json")}</label><textarea id="growth-evaluate-cases" rows="5" maxlength="24000" aria-describedby="growth-evaluate-hint"></textarea><p id="growth-evaluate-hint" class="hint">${copy("legacy.local-rounding-calculation-v1-only-exact-memory")}</p><button id="growth-evaluate-submit" type="submit" data-write>${copy("legacy.evaluate-exact-proposal-locally")}</button></fieldset></form><p id="growth-evaluate-status" role="status" aria-live="polite">${copy("legacy.choose-an-unevaluated-proposal-and-your-bounded")}</p></details>
<details id="source-panel" class="impact-panel"><summary>${copy("legacy.attach-exact-source-to-fresh-work")}</summary><p id="source-hint" class="hint">${copy("legacy.choose-a-fresh-unstarted-work-and-an")}</p><form id="source-form"><fieldset id="source-fields"><label for="source-work">${copy("legacy.fresh-work")}</label><select id="source-work" required></select><label for="source-document">${copy("legacy.exact-stored-document-id-version-hash")}</label><select id="source-document" required></select><div id="source-evidence" class="impact-results" tabindex="0" role="region" aria-label="${copy("legacy.original-source-selected-for-work")}"></div><label for="source-reason">${copy("legacy.reason-for-selecting-this-original")}</label><textarea id="source-reason" rows="2" maxlength="2000" required></textarea><p id="source-base" class="hint"></p><div class="row"><button id="save-source" type="submit" data-write>${copy("legacy.attach-exact-original-to-work")}</button><button id="review-source" type="button" class="secondary">${copy("legacy.review-exact-selection-at-current-revision")}</button><button id="cancel-source" type="button" class="secondary">${copy("legacy.cancel-private-source-selection")}</button></div></fieldset></form><p id="source-status" class="status" role="status" aria-live="polite">${copy("legacy.select-exact-work-and-document-saving-starts")}</p></details>
${fileDocumentPanel}${recordSourcePanel}${neighborhoodPanel}
<details id="document-panel" class="impact-panel"><summary>${copy("legacy.capture-and-find-local-source-text")}</summary><p class="hint">${copy("legacy.paste-text-from-an-approved-local-source")}</p><form id="document-form"><fieldset id="document-fields"><label for="document-id">${copy("legacy.document-reference-id")}</label><input id="document-id" required maxlength="73" placeholder="${copy("legacy.document-source")}"><label for="document-version">${copy("legacy.new-exact-version")}</label><input id="document-version" type="number" min="1" max="9007199254740991" required><label for="document-title">${copy("legacy.document-title")}</label><input id="document-title" required maxlength="200"><label for="document-source">${copy("legacy.original-source-or-provenance")}</label><textarea id="document-source" required rows="2" maxlength="2000"></textarea><label for="document-content">${copy("legacy.original-plain-text-at-most-16-kib")}</label><textarea id="document-content" required rows="6" maxlength="16384"></textarea><p id="document-base" class="hint"></p><div class="row"><button id="save-document" type="submit" data-write>${copy("legacy.store-exact-document-version")}</button><button id="review-document" type="button" class="secondary">${copy("legacy.review-draft-against-current-revision")}</button><button id="cancel-document" type="button" class="secondary">${copy("legacy.cancel-private-document-draft")}</button></div></fieldset></form><p id="document-status" class="status" role="status" aria-live="polite">${copy("legacy.enter-an-exact-document-id-version-and")}</p><form id="document-search-form"><label for="document-query">${copy("legacy.literal-title-or-content-query-case-sensitive")}</label><input id="document-query" required maxlength="200"><button id="document-search" type="submit">${copy("legacy.search-stored-source-text")}</button></form><div id="document-search-results" class="impact-results" tabindex="0" role="region" aria-label="${copy("legacy.latest-document-search-matches")}"></div><label for="document-choice">${copy("legacy.exact-stored-document-version")}</label><select id="document-choice"></select><div class="row"><button id="document-read" type="button">${copy("legacy.read-exact-original-text")}</button><button id="document-usage" type="button" aria-describedby="document-use-hint">${copy("legacy.find-work-and-record-uses")}</button><button id="document-read-cancel" type="button" class="secondary" disabled>${copy("legacy.cancel-text-read")}</button></div><p id="document-use-hint" class="hint">${copy("legacy.find-actual-pinned-uses-of-the-selected")}</p><div id="document-usage-results" class="impact-results" tabindex="0" role="region" aria-label="${copy("legacy.exact-source-work-record-uses")}"></div><p id="document-read-status" class="status" role="status" aria-live="polite">${copy("legacy.search-or-choose-an-exact-historical-version")}</p><div id="document-read-results" class="impact-results" tabindex="0" role="region" aria-label="${copy("legacy.exact-stored-document-source")}"></div></details>
<details id="relation-panel" class="impact-panel"><summary>${copy("legacy.record-an-exact-relationship")}</summary><p id="relation-hint" class="hint">${copy("legacy.connect-exact-user-reference-ids-and-versions")}</p><form id="relation-form"><fieldset id="relation-fields"><label for="relation-from">${copy("legacy.dependent-or-containing-reference-id")}</label><input id="relation-from" required maxlength="2000"><label for="relation-from-version">${copy("legacy.exact-source-version")}</label><input id="relation-from-version" type="number" min="1" max="9007199254740991" required><label for="relation-type">${copy("legacy.recorded-relationship")}</label><select id="relation-type"><option value="depends-on">${copy("legacy.depends-on")}</option><option value="evidenced-by">${copy("page.button.08")}</option><option value="contains">${copy("legacy.contains")}</option></select><label for="relation-to">${copy("legacy.referenced-target-id")}</label><input id="relation-to" required maxlength="2000"><label for="relation-to-version">${copy("legacy.exact-target-version")}</label><input id="relation-to-version" type="number" min="1" max="9007199254740991" required><label for="relation-provenance">${copy("ui.panel.source")}</label><textarea id="relation-provenance" required rows="3" maxlength="2000"></textarea><p id="relation-base" class="hint"></p><div class="row"><button id="save-relation" type="submit" data-write>${copy("legacy.record-an-exact-relationship")}</button><button id="review-relation" type="button" class="secondary">${copy("legacy.review-draft-against-current-revision")}</button><button id="cancel-relation" type="button" class="secondary">${copy("legacy.cancel-private-relation-draft")}</button></div></fieldset></form><p id="relation-status" class="status" role="status" aria-live="polite">${copy("legacy.enter-exact-reference-identities-versions-and-provenance")}</p><div id="relation-history" class="impact-results" tabindex="0" role="region" aria-label="${copy("legacy.stored-exact-relationships")}"></div></details>
<details id="impact-panel" class="impact-panel"><summary>${copy("legacy.inspect-relation-impact")}</summary><h3 id="impact-heading">${copy("legacy.exact-version-impact")}</h3><p id="impact-scope" class="hint"></p><p id="impact-hint" class="hint"></p><form id="impact-form"><div class="field"><label for="impact-entity">${copy("legacy.target-entity-id")}</label><input id="impact-entity" required maxlength="16000" aria-describedby="impact-hint" placeholder="${copy("legacy.exact-work-artifact-or-evidence-id")}"></div><div class="field"><label for="impact-version">${copy("settings.heading.04")}</label><input id="impact-version" type="number" min="1" max="9007199254740991" step="1" value="1" required aria-describedby="impact-hint"></div><button id="impact-read" type="submit">${copy("legacy.read-impact")}</button></form><p id="impact-status" class="status" role="status" aria-live="polite">${copy("legacy.choose-a-target-and-exact-version-then")}</p><div id="impact-results" class="impact-results" tabindex="0" role="region" aria-label="${copy("legacy.relation-impact-results")}" hidden></div></details>
<details id="memory-panel" class="impact-panel"><summary>${copy("legacy.manage-mission-memory")}</summary><h3>${copy("legacy.owner-authored-instructions-for-future-work")}</h3><p id="memory-hint" class="hint">${copy("legacy.save-an-explicit-instruction-for-this-mission")}</p><p id="memory-scope" class="hint"></p><form id="memory-form"><fieldset id="memory-fields"><label for="memory-id">${copy("legacy.memory-id")}</label><input id="memory-id" required maxlength="128" pattern="[a-zA-Z0-9:_\-]{1,128}" aria-describedby="memory-hint" placeholder="${copy("legacy.memory-instruction")}"><label for="memory-version">${copy("legacy.new-immutable-version")}</label><input id="memory-version" type="number" min="1" max="9007199254740991" step="1" value="1" required><label for="memory-content">${copy("legacy.explicit-instruction")}</label><textarea id="memory-content" rows="3" maxlength="16000" required></textarea><label for="memory-source">${copy("legacy.owner-supplied-source-or-reason")}</label><textarea id="memory-source" rows="2" maxlength="16000" required></textarea><button id="save-memory" type="submit" data-write>${copy("legacy.save-explicit-memory")}</button></fieldset></form><p id="memory-status" class="status" role="status" aria-live="polite">${copy("legacy.save-a-new-id-at-version-1")}</p><h3>${copy("legacy.stop-an-instruction-for-future-work")}</h3><p id="retirement-hint" class="hint">${copy("legacy.choose-one-exact-active-explicit-memory-version")}</p><form id="retirement-form"><fieldset id="retirement-fields"><label for="retirement-target">${copy("legacy.exact-active-explicit-memory")}</label><select id="retirement-target" required aria-describedby="retirement-hint retirement-base"></select><label for="retirement-reason">${copy("legacy.reason-for-stopping-future-application")}</label><textarea id="retirement-reason" rows="2" maxlength="16000" required aria-describedby="retirement-hint"></textarea><p id="retirement-base" class="hint"></p><button id="stop-memory" type="submit" data-write>${copy("legacy.stop-this-version-for-future-work")}</button><button id="review-retirement" type="button" class="secondary">${copy("legacy.keep-exact-target-against-current-revision")}</button><button id="cancel-retirement" type="button" class="secondary">${copy("legacy.cancel-stop-draft")}</button></fieldset></form><p id="retirement-status" class="status" role="status" aria-live="polite">${copy("legacy.choose-an-exact-version-and-review-what")}</p><div id="memory-history" class="impact-results" tabindex="0" role="region" aria-label="${copy("legacy.mission-memory-history")}"></div></details>${memoryConflictPanel}${memoryExpiryPanel}
${conversationWorkPanel}
${clarificationPanel}
${memorySearchPanel}
${memoryFindPanel}
${memoryUsagePanel}
<form id="work-form" class="work-compose"><fieldset id="work-fields"><h2>${copy("legacy.admit-bounded-work")}</h2><div class="row"><div class="field grow"><label for="work-title">${copy("legacy.work-title")}</label><input id="work-title" maxlength="16000" placeholder="${copy("legacy.a-concrete-responsibility-or-deliverable")}" required></div><div class="field budget"><label id="work-budget-label" for="work-budget">${copy("legacy.budget-limit-host-units")}</label><input id="work-budget" type="number" min="0" step="any" value="0" required></div></div><button id="admit-work" type="submit">${copy("legacy.add-work")}</button><p id="work-budget-hint" class="hint">${copy("legacy.admission-records-responsibility-and-pins-criteria-effective-2")}</p></fieldset></form>
<details id="conversation-panel" style="margin-top:22px"><summary id="conversation-summary">${copy("legacy.mission-and-work-discussion-messages-and-replies")}</summary><p id="conversation-hint" class="hint">${copy("legacy.owner-discussion-is-saved-for-this-exact")}</p><form id="conversation-form"><fieldset id="conversation-fields"><label for="conversation-scope">${copy("legacy.discussion-scope")}</label><select id="conversation-scope"><option value="work">${copy("legacy.work-2")}</option><option value="mission">${copy("legacy.mission")}</option></select><label for="conversation-target">${copy("legacy.exact-work-conversation")}</label><select id="conversation-target" aria-describedby="conversation-hint conversation-base"></select><div id="conversation-messages" tabindex="0" role="region" aria-label="${copy("legacy.stored-original-discussion")}"></div><p id="conversation-base" class="hint"></p><label for="conversation-reply">${copy("legacy.reply-to-an-exact-earlier-message")}</label><select id="conversation-reply"><option value="">${copy("legacy.new-message")}</option></select><label for="conversation-text">${copy("legacy.message-owner-discussion")}</label><textarea id="conversation-text" rows="3" maxlength="4096" required></textarea><div class="row"><button id="conversation-send" type="submit" data-write>${copy("legacy.save-owner-message")}</button><button id="conversation-review" type="button" class="secondary">${copy("legacy.review-draft-against-current-state")}</button><button id="conversation-cancel" type="button" class="secondary">${copy("legacy.clear-private-message-draft")}</button></div></fieldset></form><p id="conversation-status" class="status" role="status" aria-live="polite">${copy("legacy.choose-work-to-inspect-its-actual-budget")}</p></details>
<details id="budget-panel" style="margin-top:22px"><summary>${copy("legacy.change-fresh-work-budget")}</summary><p id="budget-hint" class="hint">${copy("legacy.only-fresh-unstarted-work-may-change-existing")}</p><form id="budget-form"><fieldset id="budget-fields"><label for="budget-target">${copy("legacy.fresh-work")}</label><select id="budget-target" required aria-describedby="budget-hint budget-current budget-base"></select><p id="budget-current" class="hint"></p><label for="budget-limit">${copy("legacy.new-budget-limit-in-the-shown-unit")}</label><input id="budget-limit" type="number" min="0" step="any" required><label for="budget-reason">${copy("legacy.reason-for-changing-the-limit")}</label><textarea id="budget-reason" rows="2" maxlength="16000" required></textarea><p id="budget-base" class="hint"></p><div class="row"><button id="save-budget" type="submit" data-write>${copy("legacy.change-budget-limit")}</button><button id="review-budget" type="button" class="secondary">${copy("legacy.review-exact-work-at-current-revision")}</button><button id="cancel-budget" type="button" class="secondary">${copy("legacy.cancel-budget-draft")}</button></div></fieldset></form><p id="budget-status" class="status" role="status"></p><details><summary>${copy("legacy.recent-observed-budget-reasons")}</summary><p class="hint">${copy("legacy.up-to-eight-changes-observed-by-this")}</p><div id="budget-history"></div></details><details id="stored-budget-panel"><summary>${copy("legacy.read-stored-budget-changes")}</summary><p id="stored-budget-hint" class="hint">${copy("legacy.read-recorded-owner-changes-for-exact-work")}</p><label for="stored-budget-target">${copy("legacy.exact-work-for-stored-history")}</label><select id="stored-budget-target" aria-describedby="stored-budget-hint"><option value="">${copy("legacy.choose-exact-work")}</option></select><div class="row"><button id="stored-budget-read" type="button">${copy("legacy.read-stored-history")}</button><button id="stored-budget-more" type="button" class="secondary">${copy("legacy.read-next-history-page")}</button><button id="stored-budget-cancel" type="button" class="secondary">${copy("legacy.cancel-history-read")}</button></div><p id="stored-budget-status" class="status" role="status" aria-live="polite">${copy("legacy.choose-work-then-read-its-stored-budget")}</p><div id="stored-budget-results" tabindex="0" role="region" aria-label="${copy("legacy.stored-work-budget-changes")}"></div></details></details><details id="stored-intervention-panel"><summary>${copy("legacy.inspect-recorded-owner-interventions")}</summary><p id="stored-intervention-hint" class="hint">${copy("legacy.read-committed-steer-cancel-permanent-quarantine-and")}</p><label for="stored-intervention-target">${copy("legacy.exact-work-for-stored-history")}</label><select id="stored-intervention-target" aria-describedby="stored-intervention-hint"><option value="">${copy("legacy.choose-exact-work")}</option></select><div class="row"><button id="stored-intervention-read" type="button">${copy("legacy.read-stored-history")}</button><button id="stored-intervention-more" type="button" class="secondary">${copy("legacy.read-next-history-page")}</button><button id="stored-intervention-cancel" type="button" class="secondary">${copy("legacy.cancel-history-read")}</button></div><p id="stored-intervention-status" class="status" role="status" aria-live="polite">${copy("legacy.choose-work-then-read-its-stored-owner")}</p><div id="stored-intervention-results" tabindex="0" role="region" aria-label="${copy("legacy.stored-work-owner-interventions")}"></div></details>
<details style="margin-top:22px"><summary>${copy("legacy.authoritative-snapshot")}</summary><pre id="snapshot-json" tabindex="0"></pre></details></section>
<section class="panel" aria-labelledby="activity-heading"><div class="section-top"><h2 id="activity-heading">${copy("legacy.durable-activity")}</h2><span id="event-state" class="tag" role="status">${copy("legacy.connecting")}</span></div><p id="event-help" class="hint" style="margin-bottom:10px">${copy("legacy.reading-committed-events-no-progress-is-inferred")}</p><ul id="event-list" class="event-list"><li>${copy("legacy.no-activity-loaded-yet")}</li></ul><small id="snapshot-time"></small></section>
</div>
${resultsPane}
${appsPane}
</section><!-- /work-pane -->
</div>
<script>
${uiCopyClient}
'use strict';
${protocolClientScript}
const protocol = createProtocolClient(createSseTransport(createHttpTransport()));
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
let snapshot = null, busy = false, loading = false, readSequence = 0, polling = false, feedRecoveryPending = false, reconnectRequired = true, connectionEpoch = 0;
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
const conversationDrafts=new Map(),conversationSelections=new Map(),conversationScopes=new Map(),conversationStatuses=new Map(),conversationSubmissions=new Map();
const drafts = new Map(), instructionConflicts = new Map(), instructionSubmissions = new Map(), confirmedOperations = new Set();
const instructionKey = (missionId, workId) => JSON.stringify([missionId, workId]);
function confirmOperation(operation) {
  sequenceAdmissionObserved(operation);
  const operationId = operationKey(operation); confirmedOperations.add(operationId);
  confirmMemoryExpirySubmission(operationId);confirmMemoryConflictSubmission(operationId);if(snapshot?.value.id===operation.missionId&&selectedId===operation.missionId){renderMemoryExpiries();renderMemoryConflicts();}
  confirmConstraintSubmission(operationId);if(snapshot?.value.id===operation.missionId&&selectedId===operation.missionId)renderConstraints();
  if(prerequisiteSubmissions.has(operationId)&&snapshot?.value.id===operation.missionId&&selectedId===operation.missionId)renderPrerequisites();
  if(expiredSubmissions.has(operationId)&&snapshot?.value.id===operation.missionId&&selectedId===operation.missionId)renderExpired();
  if(clarificationSubmissions.has(operationId)&&snapshot?.value.id===operation.missionId&&selectedId===operation.missionId)renderClarification();
  if(conversationWorkSubmissions.has(operationId)&&snapshot?.value.id===operation.missionId&&selectedId===operation.missionId)renderConversationWork();
  if(correctionSubmissions.has(operationId)&&snapshot?.value.id===operation.missionId&&selectedId===operation.missionId)renderCorrections();
  if(sourceSubmissions.has(operationId) && snapshot?.value.id===operation.missionId && selectedId===operation.missionId)renderSources();
  if(documentSubmissions.has(operationId) && snapshot?.value.id===operation.missionId && selectedId===operation.missionId)renderDocuments();
  if(relationSubmissions.has(operationId) && snapshot?.value.id===operation.missionId && selectedId===operation.missionId)renderRelations();
  if (organizationSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderOrganization();
  if (revisionSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderRevision();
  if (retirementSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderRetirement();
  if (budgetSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderBudget();
  if (growthSubmissions.has(operationId) && snapshot?.value.id === operation.missionId && selectedId === operation.missionId) renderGrowth();
  const conversationSubmission=conversationSubmissions.get(operationId);
  if(conversationSubmission){conversationSubmissions.delete(operationId);const key=instructionKey(conversationSubmission.missionId,conversationSubmission.workId),draft=conversationDrafts.get(key);if(draft===conversationSubmission.draft&&draft.text===conversationSubmission.text&&draft.replyTo===conversationSubmission.replyTo)conversationDrafts.delete(key);conversationStatuses.set(key,copy("legacy.exact-owner-message-confirmed-original-execution-and"));}
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
  if (!item || Object.keys(item).length !== 3 || typeof item.commandId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(item.commandId) || typeof item.missionId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(item.missionId) || !Number.isSafeInteger(item.reconcileCursor) || item.reconcileCursor < 0) throw new Error(copy("legacy.invalid-recovery-reference"));
  return {commandId:item.commandId,missionId:item.missionId,reconcileCursor:item.reconcileCursor};
}
const restoredPending = storage.get(pendingKey);
if (restoredPending !== null) {
  try { unknownOperation = parsePending(restoredPending); selectedId = unknownOperation.missionId; }
  catch { recoveryProblem = copy("legacy.pending-command-recovery-data-is-unreadable-writes"); }
}
if (!storage.readable) recoveryProblem = copy("legacy.browser-recovery-storage-is-unavailable-writes-are");
if (!globalThis.navigator || !navigator.locks || typeof navigator.locks.request !== 'function') recoveryProblem = copy("legacy.this-browser-cannot-coordinate-safe-writes-across");
function operationKey(operation) { return operation.missionId + '@' + operation.commandId; }
async function withRecoveryLock(action, nonblocking = true) {
  if (!globalThis.navigator || !navigator.locks || typeof navigator.locks.request !== 'function') { recoveryProblem = copy("legacy.this-browser-cannot-coordinate-safe-writes-across-2"); controls(); return {acquired:false}; }
  try { return await navigator.locks.request('massion.workbench.recovery', {mode:'exclusive',ifAvailable:nonblocking}, lock => lock ? {acquired:true,value:action()} : {acquired:false}); }
  catch { recoveryProblem = copy("legacy.browser-write-coordination-is-unavailable-writes-are"); controls(); return {acquired:false}; }
}
async function persistPending(operation) {
  const result = await withRecoveryLock(() => {
    const existing = storage.get(pendingKey);
    if (!storage.readable) { recoveryProblem = copy("legacy.browser-recovery-storage-is-unavailable-no-new"); return false; }
    if (existing !== null) {
      try { unknownOperation = parsePending(existing); }
      catch { recoveryProblem = copy("legacy.pending-command-recovery-data-is-unreadable-writes-2"); }
      report(copy("legacy.an-earlier-command-still-requires-reconciliation-no"),'warning'); return false;
    }
    if (!storage.set(pendingKey, JSON.stringify(operation))) {
      recoveryProblem = copy("legacy.could-not-save-the-pending-command-reference");
      report(recoveryProblem,'error'); return false;
    }
    unknownOperation = operation;
    return true;
  });
  if (!result.acquired && !recoveryProblem) report(copy("legacy.another-tab-is-updating-command-recovery-no"),'warning');
  controls(); return result.acquired && result.value;
}
async function clearPending(operation) {
  if (!confirmedOperations.has(operationKey(operation))) { memoryExpirySubmissions.delete(operationKey(operation));memoryConflictSubmissions.delete(operationKey(operation)); constraintSubmissions.delete(operationKey(operation)); instructionSubmissions.delete(operationKey(operation)); prerequisiteSubmissions.delete(operationKey(operation)); correctionSubmissions.delete(operationKey(operation)); expiredSubmissions.delete(operationKey(operation)); sourceSubmissions.delete(operationKey(operation)); documentSubmissions.delete(operationKey(operation)); relationSubmissions.delete(operationKey(operation)); organizationSubmissions.delete(operationKey(operation)); revisionSubmissions.delete(operationKey(operation)); retirementSubmissions.delete(operationKey(operation)); budgetSubmissions.delete(operationKey(operation)); growthSubmissions.delete(operationKey(operation)); conversationSubmissions.delete(operationKey(operation));conversationWorkSubmissions.delete(operationKey(operation));clarificationSubmissions.delete(operationKey(operation)); }
  const result = await withRecoveryLock(() => {
    const saved = storage.get(pendingKey);
    if (!storage.readable) { recoveryProblem = copy("legacy.the-command-outcome-was-confirmed-but-recovery"); return false; }
    if (saved !== null) {
      let stored;
      try { stored = parsePending(saved); } catch { recoveryProblem = copy("legacy.the-command-outcome-was-confirmed-but-its"); return false; }
      if (operationKey(stored) !== operationKey(operation)) { unknownOperation = stored; return false; }
      if (!storage.remove(pendingKey)) { recoveryProblem = copy("legacy.the-command-outcome-was-confirmed-but-its-2"); return false; }
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
      try { unknownOperation = parsePending(existing); } catch { recoveryProblem = copy("legacy.pending-command-recovery-data-is-unreadable-writes-3"); }
      report(copy("legacy.an-earlier-command-requires-reconciliation-no-fixture"),'warning'); return false;
    }
    if (storage.get(fixtureKey) !== null) { fixtureUnknown = true; return false; }
    if (!storage.readable || !storage.set(fixtureKey, 'pending')) { recoveryProblem = copy("legacy.could-not-save-the-fixture-recovery-marker"); report(recoveryProblem,'error'); return false; }
    fixtureUnknown = true; return true;
  });
  if (!result.acquired && !recoveryProblem) report(copy("legacy.another-tab-is-updating-recovery-state-no"),'warning');
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
function report(message, tone = '') {
  $('status').textContent = message; $('status').className = 'status' + (tone ? ' ' + tone : '');
  // The status lives in the work pane; while the pane is closed, problems also show on the page that sent the command.
  $('page-status').textContent = message; $('page-status').hidden = !$('work-pane').hidden || tone !== 'error' && tone !== 'warning';
}
function controls() {
  resumeFeedRecovery();
  const locked = reconnectRequired || busy || loading || !!unknownOperation || !!recoveryProblem;
  $('sync-notice').hidden = true;
  $('sync-notice').textContent = '';
  chatConnection(reconnectRequired);
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
  $('create-mission').textContent = busy ? copy("legacy.command-in-flight") : copy("legacy.create-mission");
  $('mission-panel').setAttribute('aria-busy', String(busy || loading));
  const notice = $('operation-notice');
  notice.hidden = !unknownOperation && !recoveryProblem && !fixtureUnknown;
  notice.textContent = recoveryProblem ? copy('ui.recovery-blocked') : unknownOperation ? copy('ui.command-pending',{command:unknownOperation.commandId}) : fixtureUnknown ? copy('ui.fixture-unknown') : '';
  memoryExpiryControls();memoryConflictControls();constraintControls();renderNeighborhood();inboxControls();catalogControls();clarificationControls();conversationControls();conversationWorkControls();memoryUsageControls();memoryFindControls();memorySearchControls();fileDocumentControls();renderRecordSource(); organizationControls(); impactControls(); storedBudgetControls(); storedInterventionControls(); growthControls(); growthCreationControls(); recordTextControls(); rejectedControls(); sequenceControls(); prerequisiteControls(); correctionControls(); expiredControls();
}
function impactControls() {
  const current = snapshot && snapshot.value.id === selectedId;
  $('impact-read').disabled = !current || !feedId || loading || impactReading;
  $('impact-scope').textContent = current ? copy("legacy.mission-scope-current-revision",{id:snapshot.value.id,scope:snapshot.value.scope,revision:snapshot.revision}) : copy("legacy.no-current-mission-selected");
  $('impact-results').setAttribute('aria-busy',String(impactReading));
  if (impactFocus && !$('impact-read').disabled) { const pending = impactFocus; impactFocus = null; if (currentImpact(pending.choice)) restoreControlFocus(pending.previous,'impact-read'); }
}
function invalidateImpact(message = copy("legacy.selection-changed-read-impact-again-for-this")) {
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
  area.append(element('p',copy("legacy.mission-read-revision",{missionId:body.missionId,revision:body.revision}),'hint'));
  area.append(element('h4',copy("legacy.changed-target")),element('p',copy("legacy.exact-version",{id:body.changed.id,version:body.changed.version})));
  area.append(element('h4',copy("legacy.impacted-versions")));
  if (!body.affected.length) area.append(element('p',copy("legacy.no-stored-relation-links-a-dependent-version")));
  else { const list = element('ul'); for (const id of body.affected) list.append(element('li',id)); area.append(list); }
  area.append(element('h4',copy("legacy.recorded-relations-and-provenance")));
  if (!body.relations.length) area.append(element('p',copy("legacy.no-supporting-relations-were-found")));
  else { const list = element('ul'); for (const edge of body.relations) { const row = element('li'); row.append(element('p',copy("legacy.v-v",{from:edge.from,fromVersion:edge.fromVersion,to:edge.to,toVersion:edge.toVersion,type:edge.type})),element('p',copy("legacy.provenance-inferred",{provenance:edge.provenance,value:(edge.inferred ? copy("legacy.yes") : copy("legacy.no"))}),'hint')); list.append(row); } area.append(list); }
}
for (const id of ['impact-entity','impact-version']) for (const event of ['input','change']) $(id).addEventListener(event,() => invalidateImpact());
$('impact-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!snapshot || snapshot.value.id !== selectedId || !feedId || loading || impactReading) return;
  const entity = $('impact-entity').value, versionText = $('impact-version').value, version = Number(versionText);
  invalidateImpact();
  if (!entity.trim() || !Number.isSafeInteger(version) || version < 1) { $('impact-status').textContent = copy("legacy.enter-an-exact-entity-id-and-a"); $('impact-status').className = 'status error'; return; }
  const choice = {sequence:impactSequence,missionId:snapshot.value.id,revision:snapshot.revision,feedId,epoch:connectionEpoch,entity,version,versionText}, submittedFocus = document.activeElement;
  impactReading = true; impactControls(); $('impact-status').textContent = copy("legacy.reading-exact-version-impact-in-this-mission");
  try {
    const {response,body} = await request('/missions/' + encodeURIComponent(choice.missionId) + '/impact?entity=' + encodeURIComponent(entity) + '&version=' + version,{scope:'impact-panel'});
    if (!currentImpact(choice)) return;
    if (!response.ok) throw new Error(body.error || copy("legacy.impact-read-failed",{status:response.status}));
    if (body.feedId !== choice.feedId) { requireReconnect(); $('impact-status').textContent = copy("legacy.the-database-changed-refresh-current-mission-state"); return; }
    if (!validImpact(body,choice)) throw new Error(copy("legacy.the-reply-does-not-match-the-selected"));
    renderImpact(body); $('impact-status').textContent = body.affected.length ? copy("legacy.impact-read-complete-stored-dependencies-are-shown") : copy("legacy.impact-read-complete-no-dependent-versions-were");
  } catch(error) { if (currentImpact(choice)) { $('impact-status').textContent = copy("legacy.impact-unavailable",{message:error.message}); $('impact-status').className = 'status error'; } }
  finally { if (currentImpact(choice)) { impactReading = false; if (submittedFocus === $('impact-read')) impactFocus = {choice,previous:submittedFocus}; impactControls(); } }
});
const request = protocol.request;

function validSnapshot(value, id) { return value && Number.isSafeInteger(value.revision) && value.revision > 0 && value.value && value.value.id === id && Array.isArray(value.value.works); }
function rememberMission(id) { selectedId = id; $('mission-id').value = id; storage.set(missionKey, id); }
function clearSnapshot(message) {
  switchSourceDraft('');sourceFocus=null;
  switchDocumentDraft('');documentFocus=null;invalidateDocumentRead(copy("legacy.no-current-mission-source-snapshot-is-available"));
  switchRelationDraft('');relationFocus=null;
  switchOrganizationDraft(''); organizationFocus=null;
  switchRevisionDraft(''); switchConstraints(''); revisionFocus = null;
  switchMemoryDraft(''); memoryFocus = null; $('memory-history').replaceChildren();
  snapshot = null; restoreMissionAddress();
  invalidateImpact(copy("legacy.no-current-mission-snapshot-is-available-load"));
  $('mission-panel').hidden = true;
  $('empty-state').hidden = false;
  $('empty-message').textContent = message;
  $('snapshot-json').textContent = '';
  $('mission-link').hidden = true; $('mission-link').setAttribute('href','#');
  $('work-list').replaceChildren(); executionForms.clear();
  $('snapshot-time').textContent = copy("legacy.no-current-snapshot-is-available");
  controls();
}
function installSnapshot(value) {
  const changed = !snapshot || JSON.stringify(snapshot) !== JSON.stringify({revision:value.revision,value:value.value});
  switchMemoryDraft(value.value.id);
  snapshot = {revision:value.revision, value:value.value};
  if (changed) invalidateDocumentRead(copy("legacy.mission-state-changed-read-exact-source-again"));
  if (changed) invalidateImpact(copy("legacy.mission-state-changed-choose-a-target-and"));
  window.history.replaceState(null, '', '#mission=' + encodeURIComponent(value.value.id));
  $('empty-state').hidden = true;
  $('mission-panel').hidden = false;
  paneFor(value.value);
  $('snapshot-time').textContent = copy("legacy.snapshot-read-at-revision",{value:new Date().toLocaleTimeString(),revision:value.revision});
  if (changed) renderMission();
  controls();
}
async function loadMission(id = selectedId, announce = true) {
  if (!id || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) { report(copy("legacy.enter-a-valid-mission-id"), 'error'); return false; }
  const changed = id !== selectedId;
  rememberMission(id);
  if (changed) { clearSnapshot(copy("legacy.loading-the-selected-mission")); activity = []; renderActivity(); }
  const sequence = ++readSequence;
  const readFeed = feedId, epoch = connectionEpoch;
  loading = true; controls();
  if (announce && !unknownOperation) report(copy("legacy.reading-authoritative-mission-state"));
  try {
    const {response, body:packet} = await request(readFeed ? '/read-state?mission=' + encodeURIComponent(id) : '/missions/' + encodeURIComponent(id),{scope:'mission-view'});
    if (sequence !== readSequence || id !== selectedId) return false;
    if (epoch !== connectionEpoch || readFeed && packet.feedId !== readFeed) { requireReconnect(); throw new Error(copy("legacy.database-or-connection-changed-during-mission-read")); }
    const body = readFeed ? packet.snapshot : packet;
    if (!response.ok) throw new Error(packet.error || copy("legacy.mission-read-failed",{status:response.status}));
    if (!validSnapshot(body, id)) throw new Error(copy("legacy.the-host-returned-an-invalid-mission-snapshot"));
    installSnapshot(body);
    if (announce && !unknownOperation) report(copy("legacy.loaded-revision-state-is-read-from-the",{revision:body.revision}), 'success');
    return true;
  } catch (error) {
    if (sequence !== readSequence || id !== selectedId) return false;
    clearSnapshot(copy("legacy.mission-state-could-not-be-refreshed-load"));
    report(copy("legacy.refresh-failed",{value:(unknownOperation ? copy("legacy.write-outcome-remains-unknown") : ''),message:error.message}), 'error');
    return false;
  } finally { if (sequence === readSequence) { loading = false; controls(); } }
}
async function verifyAcknowledgementFeed(origin, acknowledgementFeed, missionId, scope) {
  if (!origin) return null;
  if (acknowledgementFeed !== origin) { requireReconnect(); throw new Error(copy("legacy.command-acknowledgement-feed-is-missing-or-differs")); }
  const epoch = connectionEpoch;
  const {response,body} = await request('/read-state?mission=' + encodeURIComponent(missionId),{scope});
  if (!response.ok || epoch !== connectionEpoch || body.feedId !== origin || !validSnapshot(body.snapshot,missionId)) { requireReconnect(); throw new Error(copy("legacy.the-acknowledgement-belongs-to-a-previous-or")); }
  return body.snapshot;
}
function badge(text, state) { return element('span', text, 'tag' + (['accepted','passed','succeeded'].includes(state) ? ' good' : ['blocked','waiting','unknown','pending','stale'].includes(state) ? ' warn' : ['failed','cancelled'].includes(state) ? ' bad' : '')); }
function addFact(list, title, value) { const group = element('div'); group.append(element('dt', title)); const detail = element('dd'); if (Array.isArray(value)) { const items = element('ul'); for (const item of value) items.append(element('li', item)); detail.append(items); } else detail.textContent = String(value); group.append(detail); list.append(group); }
function metric(label, value) { const group = element('div', undefined, 'metric'); group.append(element('dt', label), element('dd', value)); return group; }
function providerNotice() {
  if (runtimeConfiguration) { $('work-budget-label').textContent = copy("legacy.budget-limit-output-tokens"); $('work-budget-hint').textContent = copy("legacy.set-a-budget-of-at-least-twice"); $('provider-notice').textContent = copy("legacy.choose-configured-connections-separately-for-execution-and"); return; }
  $('work-budget-label').textContent = copy("legacy.budget-limit-host-units");
  $('work-budget-hint').textContent = copy("legacy.admission-records-responsibility-and-pins-criteria-effective");
  $('provider-notice').textContent = !providerKnown ? copy("legacy.provider-availability-could-not-be-confirmed-user") : providerSelection.status === 'selected' ? copy("legacy.a-real-provider-is-configured-this-client") : copy("legacy.real-provider-execution-is-unavailable",{reason:providerSelection.reason});
}
function workBlocker(work) {
  if (work.runtimeRecovery) return copy("legacy.permanently-quarantined-by-owner-external-outcomes-remain");
  const unknown = (work.effects || []).filter(effect => effect.status === 'unknown' || effect.status === 'pending');
  if (unknown.length) return copy("legacy.unresolved-effects-reconcile-observed-outcomes-before-any",{value:unknown.map(effect => effect.id + ' (' + effect.status + ')').join(', ')});
  if (work.execution === 'cancelled') return copy("legacy.cancelled-in-durable-state-existing-effects-and");
  if (work.acceptance === 'accepted') return work.record && work.record.evidenceClass === 'fixture' ? copy("legacy.accepted-fixture-record-this-is-controlled-development") : copy("legacy.accepted-record-is-available-below");
  if (work.execution === 'waiting') return copy("legacy.waiting-after-a-steering-command-recording-an");
  if (work.blocker) return work.blocker.code.replaceAll('_', ' ') + ': ' + work.blocker.detail;
  if (work.execution === 'blocked') return copy("legacy.execution-is-blocked-in-the-authoritative-state");
  if (!(work.assignments || []).length) return providerKnown && providerSelection.status === 'unavailable' ? copy("legacy.provider-unavailable-for-this-work-no-executor") : copy("legacy.no-executor-is-assigned-admission-has-not");
  if (work.acceptance === 'failed' || work.acceptance === 'stale') return copy("legacy.independent-assurance-is-this-work-has-no",{acceptance:work.acceptance});
  return copy("legacy.execution-and-acceptance-are-tracked-separately-inspect");
}

const executionDrafts = new Map(), executionForms = new Map();
function renderExecutionSelection(work) {
  const missionId = snapshot.value.id, revision = snapshot.revision;
  const configuration = runtimeConfiguration;
  const area = element('details',undefined,'controls'); area.append(workElement(work,'summary',copy("legacy.choose-execution-and-review-connections"),'selection-summary'));
  const form = element('form',undefined,'execution-form');
  const draftKey = missionId + '\u0000' + work.id;
  executionForms.set(draftKey,form);
  const saved = executionDrafts.get(draftKey) || {};
  const fields = {};
  for (const role of ['executor','verifier']) {
    const label = element('label',role === 'executor' ? copy("legacy.executor-connection-model") : copy("legacy.independent-verifier-connection-model"));
    const select = element('select'); select.id = role + '-profile-' + work.id; label.htmlFor = select.id; select.required = true;
    const empty = element('option',copy("legacy.choose-a-connection")); empty.value = ''; select.append(empty);
    for (const connection of configuration.connections) {
      if (connection.backend !== 'model-provider') continue;
      const option = element('option',connection.label + (connection.diagnostics.length ? copy("legacy.unavailable") : ' · ' + connection.providerKind + ' / ' + connection.model)); option.value = connection.id; option.disabled = connection.diagnostics.length > 0; select.append(option);
    }
    select.value = saved[role + 'ProfileId'] || ''; fields[role + 'ProfileId'] = select; form.append(label,select);
  }
  const grantLabel = element('label',copy("legacy.authorized-use")); const grant = element('select'); grant.id = 'authorization-' + work.id; grantLabel.htmlFor = grant.id; grant.required = true;
  const empty = element('option',copy("legacy.choose-an-authorization")); empty.value = ''; grant.append(empty);
  const grants = configuration.authorizations.filter(a => a.scope === snapshot.value.scope);
  const modelOf = permissions => (permissions || []).map(p => configuration.connections.find(c => c.id === p.profileId)?.model ?? copy("legacy.unknown-profile")).join(', ') || copy("legacy.unknown");
  for (const item of grants) { const option = element('option',copy("legacy.executor-verifier-max-output-tokens-per-call",{value:modelOf(item.executor),value2:modelOf(item.verifier),mode:item.mode,maxOutputTokensPerCall:item.maxOutputTokensPerCall,id:item.id})); option.value = item.id; grant.append(option); }
  grant.value = saved.authorizationId || ''; fields.authorizationId = grant; form.append(grantLabel,grant);
  if (!grants.length) form.append(element('p',copy("legacy.no-host-authorization-matches-this-mission-scope"),'work-note warning'));
  const capLabel = element('label',copy("legacy.output-token-cap-per-call-two-calls")); const cap = element('input'); cap.type = 'number'; cap.min = '1'; cap.step = '1'; cap.required = true; cap.id = 'output-cap-' + work.id; capLabel.htmlFor = cap.id; cap.value = saved.outputTokenCap || ''; fields.outputTokenCap = cap; form.append(capLabel,cap);
  const detail = element('p',undefined,'hint');
  const plan = element('p',undefined,'work-note'); plan.id = 'execution-plan-' + work.id;
  const result = element('p',copy("legacy.not-checked-check-selection-does-not-start"),'status'); result.id = 'selection-check-' + work.id; result.setAttribute('role','status'); result.setAttribute('aria-live','polite');
  const check = element('button',copy("legacy.check-selection"),'secondary'); check.type = 'button';
  const choice = () => ({executorProfileId:fields.executorProfileId.value,verifierProfileId:fields.verifierProfileId.value,authorizationId:grant.value,outputTokenCap:Number(cap.value)});
  const current = () => snapshot && selectedId === missionId && snapshot.value.id === missionId && snapshot.revision === revision && runtimeConfiguration === configuration && executionForms.get(draftKey) === form;
  let checkVersion = 0, checking = false;
  const refresh = () => {
    ++checkVersion; checking = false; check.disabled = false; check.textContent = copy("legacy.check-selection");
    result.textContent = copy("legacy.not-checked-check-selection-does-not-start"); result.className = 'status';
    const selection = choice(); executionDrafts.set(draftKey,selection);
    detail.textContent = ['executor','verifier'].map(role => { const c = configuration.connections.find(p => p.id === selection[role + 'ProfileId']); return c && !c.diagnostics.length ? copy("legacy.auth-max-output-input-usage-cost-unknown",{value:role + ': ' + c.protocol + ' · ' + c.endpoint,method:c.auth.method,maxOutputTokens:c.limits.maxOutputTokens,inputTokens:c.usage.inputTokens}) : copy("legacy.no-connection-selected",{role:role}); }).join(' | ');
    const remaining = work.budget.limit - work.budget.reserved;
    const validCap = Number.isSafeInteger(selection.outputTokenCap) && selection.outputTokenCap > 0 && Number.isSafeInteger(selection.outputTokenCap * 2);
    plan.textContent = validCap ? copy("legacy.execution-plan-up-to-output-tokens-per",{outputTokenCap:selection.outputTokenCap,value:selection.outputTokenCap * 2,remaining:remaining,value2:(selection.outputTokenCap * 2 > remaining ? copy("legacy.insufficient-work-budget-use-a-lower-cap") : '')}) : copy("legacy.choose-both-connections-authorized-use-and-a",{remaining:remaining});
    plan.className = 'work-note' + (validCap && selection.outputTokenCap * 2 > remaining ? ' warning' : '');
  };
  for (const field of Object.values(fields)) { field.addEventListener('change',refresh); field.addEventListener('input',refresh); } refresh();
  check.id = 'selection-button-' + work.id;
  check.addEventListener('click',async () => {
    if (!current() || checking) return;
    const selection = choice(), key = JSON.stringify(selection), version = ++checkVersion;
    const stillCurrent = () => current() && version === checkVersion && key === JSON.stringify(choice());
    const submittedFocus = document.activeElement; checking = true; check.disabled = true; check.textContent = copy("legacy.checking"); result.textContent = copy("legacy.checking-this-work-and-selection-without-executing");
    try {
      const response = await request('/missions/' + encodeURIComponent(missionId) + '/preflight',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commandId:crypto.randomUUID(),expectedRevision:revision,workId:work.id,selection})});
      if (!stillCurrent()) return;
      const body = response.body;
      if (!response.response.ok || body.ready !== true) { result.textContent = (body.diagnostics || []).map(d => d.message).join(' ') || body.error || copy("legacy.selection-was-not-confirmed-refresh-this-mission"); result.className = 'status warning'; return; }
      if (body.revision !== revision || body.workId !== work.id) { result.textContent = copy("legacy.the-host-did-not-confirm-this-exact"); result.className = 'status warning'; return; }
      result.textContent = copy("legacy.checked-at-revision-this-work-and-selection",{revision:revision}); result.className = 'status success';
    } catch(error) { if (stillCurrent()) { result.textContent = copy("legacy.selection-could-not-be-checked",{message:error.message}); result.className = 'status warning'; } }
    finally { if (stillCurrent()) { checking = false; check.disabled = false; check.textContent = copy("legacy.check-selection"); if(submittedFocus === check)restoreControlFocus(submittedFocus,check.id); } }
  });
  const run = workElement(work,'button',copy("legacy.run-with-selected-connections"),'run'); run.type = 'submit'; run.setAttribute('data-write',''); run.setAttribute('aria-describedby',plan.id);
  form.addEventListener('submit',async event => { event.preventDefault(); if(!current())return; const submittedFocus=document.activeElement; refresh(); await write('/missions/' + encodeURIComponent(missionId) + '/run',{commandId:crypto.randomUUID(),expectedRevision:revision,workId:work.id,selection:choice()},missionId,copy("legacy.run-finished-inspect-its-execution-and-independent")); if(submittedFocus === run && snapshot?.value.id === missionId && selectedId === missionId)restoreControlFocus(submittedFocus,'work-heading-' + work.id); });
  for(const connection of configuration.connections.filter(c=>c.diagnostics.length))form.append(element('p',connection.label + ': ' + connection.diagnostics.map(d=>d.message).join(' '),'hint'));
  form.append(detail,plan,check,run,result,element('p',copy("legacy.no-automatic-fallback-retry-or-provider-change"),'hint'));area.append(form);return area;
}

function renderWork(work) {
  const card = element('article', undefined, 'work-card'); card.id = 'work-card-' + work.id;
  const title = element('h3', work.title, 'work-title'); title.id = 'work-heading-' + work.id; title.tabIndex = -1; card.append(title, element('div', work.id, 'id'));
  const tags = element('div', undefined, 'badge-row'); tags.append(badge(copy("legacy.execution",{execution:work.execution}), work.execution), badge(copy("legacy.acceptance",{acceptance:work.acceptance}), work.acceptance));
  if (work.record) tags.append(badge(copy("legacy.evidence",{evidenceClass:work.record.evidenceClass}), work.record.evidenceClass)); card.append(tags);
  const metrics = element('dl', undefined, 'metrics'); metrics.append(metric(copy("legacy.attempts"), (work.attempts || []).length), metric(copy("legacy.budget-reserved-limit"), work.budget.reserved + ' / ' + work.budget.limit), metric(copy("legacy.measured-usage"), work.budget.measured === null ? copy("legacy.unknown") : work.budget.measured)); card.append(metrics);
  card.append(element('p', workBlocker(work), 'work-note' + (['queued','blocked','waiting'].includes(work.execution) ? ' warning' : '')));
  if ((work.instructions || []).length) card.append(element('p', copy("legacy.latest-owner-instruction",{text:work.instructions.at(-1).text}), 'work-note'));
  const evidence = element('details'); evidence.append(workElement(work,'summary',copy("legacy.criteria-memory-pins-evidence"),'evidence-summary'));
  const body = element('div', undefined, 'detail-content');
  body.append(element('h4',copy("legacy.original-selected-source-documents")),workElement(work,'pre',work.sourceDocuments ? JSON.stringify(work.sourceDocuments,null,2) : copy("legacy.no-document-source-selected-for-this-work"),'source-input'));
  if(work.runtimeRun?.ownership)body.append(element('h4',copy("legacy.original-host-dispatch-ownership-deadline")),workElement(work,'pre',JSON.stringify({runId:work.runtimeRun.id,ownership:work.runtimeRun.ownership,interruption:work.runtimeInterruption || null,providerDispatchClaims:work.effects.filter(effect=>effect.providerDispatch).map(effect=>({effectId:effect.id,status:effect.status,claim:effect.providerDispatch}))},null,2),'runtime-ownership'),element('p',copy("legacy.a-declared-deadline-or-another-host-identity"),'hint'));
  if(work.questions)body.append(element('h4',work.questions.some(q=>q.answer===null)?copy("legacy.open-questions-first-run-blocked"):copy("legacy.answered-owner-clarification")),workElement(work,'pre',JSON.stringify(work.questions,null,2),'questions'));
  if(work.conversationSource)body.append(element('h4',copy("legacy.original-conversation-provenance")),workElement(work,'pre',JSON.stringify(work.conversationSource,null,2),'conversationSource'));
  if(work.correction)body.append(element('h4',copy("legacy.original-owner-correction-admission-decision")),workElement(work,'pre',JSON.stringify(work.correction,null,2),'correction'));
  if(work.prerequisites)body.append(element('h4',copy("legacy.explicit-execution-prerequisites")),workElement(work,'pre',JSON.stringify({pins:work.prerequisites,acceptedRecords:work.prerequisiteRecords || []},null,2),'prerequisites'));
  body.append(element('h4',copy("legacy.original-organization-responsibilities")),workElement(work,'pre',work.organizationSnapshot ? JSON.stringify(work.organizationSnapshot,null,2) : copy("legacy.no-organization-revision-pinned-at-work-admission"),'organization-input'));
  body.append(element('h4',copy("legacy.original-mission-input")),workElement(work,'pre',work.missionSnapshot ? JSON.stringify(work.missionSnapshot,null,2) : copy("legacy.original-mission-input-is-unavailable-current-input"),'mission-input'));
  body.append(element('h4', copy("legacy.pinned-criteria")), element('p', copy("legacy.pinned-criteria-description",{version:work.criteria.version,description:work.criteria.description})), element('p', copy("legacy.oracle",{oracle:work.criteria.oracle}), 'id'));
  body.append(element('h4', copy("legacy.pinned-memory-versions")), element('p', work.appliedMemoryVersions.length ? work.appliedMemoryVersions.join(', ') : copy("legacy.none-pinned-for-this-work")));
  for (const pin of work.appliedMemoryVersions) {
    const matches = (snapshot.value.memories || []).filter(memory => memory.id + '@' + memory.version === pin);
    const memory = matches.length === 1 && matches[0].scope === work.missionSnapshot?.scope ? matches[0] : null;
    if (!memory) { body.append(element('p',copy("legacy.pinned-memory-is-unavailable-or-has-mismatched",{pin:pin}),'warning')); continue; }
    body.append(element('p',copy("legacy.authority",{pin:pin,authority:memory.authority})),workElement(work,'pre',memory.content,'memory-' + pin),element('p',copy("legacy.stored-source",{source:memory.source}),'hint'));
  }
  body.append(element('h4', copy("rail.link.01")), element('p', work.artifact ? copy("legacy.v",{path:work.artifact.path,version:work.artifact.version,kind:work.artifact.kind}) : copy("legacy.no-artifact-has-been-published")));
  if (work.artifact) body.append(element('p', copy("legacy.sha-256",{sha256:work.artifact.sha256}), 'id'));
  body.append(element('h4', copy("legacy.independent-assurance")), element('p', work.verdict ? copy("legacy.artifact-v-criteria-v",{status:work.verdict.status,artifactVersion:work.verdict.artifactVersion,criteriaVersion:work.verdict.criteriaVersion}) : copy("legacy.no-independent-verdict-yet")));
  if (work.verdict) { const items = element('ul'); for (const proof of work.verdict.evidence) items.append(element('li', copy("legacy.source",{value:proof.kind + ': ' + proof.detail,source:proof.source}))); body.append(items); }
  if ((work.instructions || []).length) { body.append(element('h4', copy("legacy.recorded-owner-instructions"))); const instructions = element('ul'); for (const instruction of work.instructions) instructions.append(element('li', instruction.actorId + ': ' + instruction.text)); body.append(instructions); }
  if (work.runtimeRecovery) { body.append(element('h4', copy("legacy.owner-quarantine-decision")), element('p', work.runtimeRecovery.actorId + ': ' + work.runtimeRecovery.reason), workElement(work,'pre',JSON.stringify(work.runtimeRecovery,null,2),'recovery')); }
  body.append(element('h4', copy("legacy.effect-receipts")));
  if (!work.effects.length) body.append(element('p', copy("legacy.no-effects-admitted")));
  for (const effect of work.effects) body.append(element('p', effect.id + ' · ' + effect.status + ' · ' + effect.target + (effect.receipt ? copy("legacy.receipt",{receipt:effect.receipt}) : copy("legacy.no-receipt"))));
  body.append(element('h4', copy("legacy.accepted-record")));
  if (work.record) { body.append(element('p', work.record.id + ' · ' + work.record.evidenceClass), element('p', copy("legacy.checksum",{checksum:work.record.checksum}), 'id')); const record = element('details'); record.append(workElement(work,'summary',copy("legacy.inspect-record-bundle"),'record-summary'), workElement(work,'pre',JSON.stringify(work.record,null,2),'record')); body.append(record); }
  else body.append(element('p', copy("legacy.no-accepted-record-a-completed-attempt-alone")));
  if(work.record && work.acceptance==='accepted')body.append(recordTextPanel(work));
  if(work.execution==='settled'&&work.acceptance==='failed'&&work.verdict?.status==='failed'&&work.artifact)body.append(rejectedTextPanel(work));
  if(reflectionTrailEligible(work))body.append(reflectionTrailPanel(work));
  const attempts = element('details'); attempts.append(workElement(work,'summary',copy("legacy.attempts-tasks-assignments"),'attempts-summary'), workElement(work,'pre',JSON.stringify({attempts:work.attempts,tasks:work.tasks,assignments:work.assignments},null,2),'attempts')); body.append(attempts); evidence.append(body); card.append(evidence);
  if (work.runtimeRun && work.runtimeRun.connectionBindings) body.append(element('h4',copy("legacy.selected-connections")),workElement(work,'pre',JSON.stringify(work.runtimeRun.connectionBindings,null,2),'connections'));
  if (runtimeConfiguration && !work.runtimeRun && work.execution !== 'cancelled' && work.acceptance !== 'accepted') card.append(renderExecutionSelection(work));
  if (work.runtimeRun && !work.runtimeRecovery && work.acceptance !== 'accepted' && work.effects.some(effect => effect.status === 'pending' || effect.status === 'unknown')) {
    const area = element('details', undefined, 'controls'); area.append(workElement(work,'summary',copy("legacy.quarantine-interrupted-run"),'quarantine-summary'));
    area.append(element('p', copy("legacy.permanent-local-closure-pending-effects-become-unknown"), 'work-note warning'));
    const form = element('form', undefined, 'quarantine-form');
    const label = element('label', copy("legacy.why-are-you-quarantining-this-run")); const reason = element('textarea'); reason.id = 'quarantine-reason-' + work.id; label.htmlFor = reason.id; reason.rows = 2; reason.maxLength = 16000; reason.required = true;
    const acknowledgement = element('input'); acknowledgement.type = 'checkbox'; acknowledgement.id = 'quarantine-ack-' + work.id; acknowledgement.required = true; acknowledgement.style.width = 'auto';
    const ackLabel = element('label', copy("legacy.i-understand-that-external-effects-and-usage")); ackLabel.htmlFor = acknowledgement.id;
    const submit = element('button', copy("legacy.permanently-quarantine-run"), 'danger'); submit.id = 'work-quarantine-' + work.id; submit.type = 'submit'; submit.setAttribute('data-write','');
    form.addEventListener('submit', event => { event.preventDefault(); const text = reason.value.trim(); if (!text || !acknowledgement.checked) { report(copy("legacy.enter-a-reason-and-explicitly-acknowledge-the"),'warning'); return; } sendCommand({type:'quarantine-runtime',workId:work.id,runId:work.runtimeRun.id,reason:text,acknowledgeUncertainOutcome:true}); });
    form.append(label,reason,acknowledgement,ackLabel,submit); area.append(form); card.append(area);
  }
  const missionId = snapshot.value.id, revision = snapshot.revision, key = instructionKey(missionId, work.id);
  const conflict = instructionConflicts.get(key);
  if (conflict) {
    const comparison = element('section', undefined, 'instruction-conflict'); comparison.setAttribute('role','status');
    comparison.append(element('h4',copy("legacy.instruction-was-not-recorded")),element('p',copy("legacy.your-submission-at-revision-conflicted-no-instruction",{revision:conflict.revision})));
    comparison.append(element('h4',copy("legacy.your-unrecorded-submission")),workElement(work,'pre',conflict.text,'unrecorded'));
    const latest = (work.instructions || []).at(-1);
    comparison.append(element('h4',copy("legacy.latest-recorded-owner-instruction-current-revision",{revision:revision})),element('p',latest ? latest.actorId + ': ' + latest.text : copy("legacy.no-owner-instruction-is-recorded")));
    comparison.append(element('p',work.execution === 'cancelled' || work.acceptance === 'accepted' ? copy("legacy.this-work-is-closed-your-draft-remains") : copy("legacy.compare-the-current-direction-with-your-draft"),'hint'));
    if (work.execution === 'cancelled' || work.acceptance === 'accepted') comparison.append(element('h4',copy("legacy.retained-draft")),workElement(work,'pre',drafts.get(key) ?? conflict.text,'draft'));
    card.append(comparison);
  }
  if (work.execution !== 'cancelled' && work.acceptance !== 'accepted') {
    const area = element('div', undefined, 'controls');
    const form = element('form', undefined, 'steer-form');
    const label = element('label', copy("legacy.steering-instruction")); const input = element('textarea'); input.id = 'steer-' + work.id; label.htmlFor = input.id; input.rows = 2; input.maxLength = 16000; input.required = true; input.placeholder = copy("legacy.record-a-change-of-direction"); input.value = drafts.get(key) || ''; input.addEventListener('input', () => drafts.set(key, input.value));
    const buttons = element('div', undefined, 'row'); buttons.style.marginTop = '9px';
    const steer = element('button', conflict ? copy("legacy.submit-revised-instruction-at-revision",{revision:revision}) : copy("legacy.record-instruction"), 'secondary'); steer.id = 'work-steer-' + work.id; steer.type = 'submit'; steer.setAttribute('data-write','');
    const cancel = element('button', copy("legacy.cancel-work"), 'danger'); cancel.id = 'work-cancel-' + work.id; cancel.type = 'button'; cancel.setAttribute('data-write','');
    const current = () => snapshot && selectedId === missionId && snapshot.value.id === missionId && snapshot.revision === revision && snapshot.value.works.some(item => item.id === work.id && item.execution !== 'cancelled' && item.acceptance !== 'accepted');
    cancel.addEventListener('click', () => { if (current()) sendCommand({type:'cancel',workId:work.id}, document.activeElement === cancel); });
    form.addEventListener('submit', event => { event.preventDefault(); if (!current()) return; const instruction = input.value.trim(); drafts.set(key,input.value); if (instruction) sendCommand({type:'steer',workId:work.id,instruction}, document.activeElement === input || document.activeElement === steer); });
    buttons.append(steer,cancel); form.append(label,input,buttons,element('p',copy("legacy.steering-records-an-owner-instruction-existing-execution"),'hint')); area.append(form); card.append(area);
  }
  return paneTabs.some(t=>t.key===paneActive&&t.missionId===snapshot.value.id&&t.workId===work.id)?renderWorkRoom(work,card):card;
}
function renderMission() {
  if (!snapshot) return;
  const focused = document.activeElement;
  let card = focused; while (card && !card.id?.startsWith('work-card-')) card = card.parentElement;
  const workFocus = focused?.id && $('work-list').contains(focused) ? {id:focused.id,heading:card ? 'work-heading-' + card.id.slice(10) : null,start:focused.selectionStart,end:focused.selectionEnd,scroll:focused.scrollTop} : null;
  const mission = snapshot.value;
  renderSources(); renderPrerequisites(); renderCorrections(); renderExpired();
  renderDocuments();
  renderRelations();
  renderOrganization();
  renderRevision();renderConstraints();renderMemoryExpiries();renderMemoryConflicts();
  renderMemoryHistory();renderMemoryUsage();renderMemoryFind();renderMemorySearch();renderFileDocument();
  renderRetirement();
  renderBudget();
  renderClarification();renderConversation();renderConversationWork();
  renderSequence();
  renderGrowth();
  executionForms.clear();
  $('revision').textContent = copy("legacy.revision",{revision:snapshot.revision});
  $('loaded-id').textContent = mission.id;
  $('mission-link').setAttribute('href','#mission=' + encodeURIComponent(mission.id)); $('mission-link').hidden = false;
  $('mission-purpose').textContent = mission.purpose;
  const facts = $('mission-facts'); facts.replaceChildren();
  addFact(facts,copy("legacy.scope"),mission.scope); addFact(facts,copy("legacy.success-criteria-v",{version:mission.criteria.version}),mission.criteria.description); addFact(facts,copy("legacy.constraints"),mission.constraints.length ? mission.constraints : copy("legacy.no-constraints-recorded")); addFact(facts,copy("legacy.mission-version-effective-memory"),copy("legacy.versions",{value:mission.version + ' / ' + mission.memories.filter(memory => memory.effective).length}));
  $('work-count').textContent = mission.works.length + (mission.works.length === 1 ? copy("legacy.responsibility") : copy("legacy.responsibility"));
  $('work-list').replaceChildren(...(mission.works.length ? mission.works.map(renderWork) : [element('p',copy("legacy.no-work-admitted-yet-add-the-first"),'work-note')]));
  paneFilter();
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
  // Conversation events belong to the conversation section, which reads them itself.
  const shown = activity.filter(event => !String(event.aggregateId || '').startsWith('assistant-conversation:') && (!selectedId || event.aggregateId === selectedId)).slice(-8).reverse();
  if (!shown.length) list.append(element('li',selectedId ? copy("legacy.no-newly-observed-events-for-this-mission") : copy("legacy.select-a-mission-to-follow-its-events")));
  renderBudgetHistory();
  for (const event of shown) { const row = element('li'); const label = (event.events || []).map(item => item.type).filter(Boolean).join(', ') || copy("legacy.committed-change"); row.append(element('span',String(label).replaceAll('-',' ')),element('small',copy("legacy.revision-cursor",{revision:event.revision,cursor:event.cursor}))); list.append(row); }
}
function receiptObserved() {
  return unknownOperation && (confirmedOperations.has(operationKey(unknownOperation)) || activity.some(event => event.commandId === unknownOperation.commandId && event.aggregateId === unknownOperation.missionId));
}
async function refreshReadState(epoch, expectedFeed) {
  const missionId = selectedId, sequence = ++readSequence;
  loading = true; controls();
  try {
    const {response,body} = await request('/read-state' + (missionId ? '?mission=' + encodeURIComponent(missionId) : ''),{scope:'feed-recovery'});
    if (epoch !== connectionEpoch || sequence !== readSequence || missionId !== selectedId) throw new Error(copy("legacy.connection-or-selected-mission-changed-during-read"));
    if (!response.ok || typeof body.feedId !== 'string' || !body.feedId || !Number.isSafeInteger(body.cursor) || body.cursor < 0 || (missionId ? body.snapshot !== null && !validSnapshot(body.snapshot,missionId) : body.snapshot !== null)) throw new Error(copy("legacy.current-snapshot-and-feed-boundary-could-not"));
    if (expectedFeed && body.feedId !== expectedFeed) throw new Error(copy("legacy.database-changed-while-permissions-were-refreshing"));
    if (feedId && body.feedId !== feedId) {
      activity = []; confirmedOperations.clear();memoryExpirySubmissions.clear();memoryExpiryStatuses.clear();memoryConflictSubmissions.clear();memoryConflictStatuses.clear(); conversationSubmissions.clear(); conversationStatuses.clear();conversationWorkSubmissions.clear();conversationWorkStatuses.clear();clarificationSubmissions.clear();clarificationStatuses.clear(); prerequisiteSubmissions.clear(); prerequisiteStatuses.clear(); correctionSubmissions.clear(); correctionStatuses.clear(); sourceSubmissions.clear(); sourceStatuses.clear(); documentSubmissions.clear(); documentStatuses.clear(); relationSubmissions.clear(); relationStatuses.clear(); organizationSubmissions.clear(); organizationStatuses.clear(); retirementSubmissions.clear(); budgetSubmissions.clear(); budgetStatuses.clear(); chatReset(); resultsReset(); schedulesReset();
    }
    // Receipts predating this snapshot still matter; a fresh boundary is not command reconciliation.
    if (unknownOperation) unknownOperation.reconcileCursor = 0;
    // Bind the authoritative feed before rendering a newly initialized private draft.
    feedId = body.feedId;
    if (missionId && body.snapshot === null) {
      rememberMission(''); storage.remove('massion.fixture.mission');
      clearSnapshot(copy("legacy.this-mission-is-absent-from-the-current"));
    } else if (missionId) installSnapshot(body.snapshot);
    // Same-feed snapshot reads may be ahead of bounded event pages. Only reset
    // the event boundary when recovering a replaced/invalid feed, not reconnecting.
    if (!expectedFeed) cursor = body.cursor;
    storage.set(feedKey,feedId); storage.set(cursorKey,String(cursor)); renderActivity();
  } finally { loading = false; controls(); }
}
let eventReadDone=null;
function pollEvents() {
 if(eventReadDone)return eventReadDone;
 const read=(async()=>{while(await readEventPage()) {}})();eventReadDone=read;
 void read.finally(()=>{if(eventReadDone===read)eventReadDone=null;});return read;
}
async function readEventPage() {
  if (polling) return;
  polling = true; let epoch = connectionEpoch;
  try {
    const after = unknownOperation ? Math.min(cursor, unknownOperation.reconcileCursor) : cursor;
    const {response, body} = await request('/events?after=' + after,{scope:'feed-catchup',...(feedId ? {headers:{'X-Massion-Feed':feedId}} : {})});
    if (response.status === 409) {
      requireReconnect(); epoch = connectionEpoch;
      if (feedId) {
        await refreshReadState(epoch);
        throw new Error(copy("legacy.the-database-feed-changed-current-reads-were"));
      }
      cursor = 0; storage.set(cursorKey, '0'); activity = []; eventRefreshNeeded = true;
      if (unknownOperation) unknownOperation.reconcileCursor = 0;
      if (selectedId && !busy && !loading) await loadMission(selectedId, false);
      throw new Error(copy("legacy.saved-cursor-was-ahead-of-the-host"));
    }
    if (epoch !== connectionEpoch) throw new Error(copy("legacy.connection-changed-during-event-read"));
    if (feedId && body.feedId !== feedId) throw new Error(copy("legacy.event-feed-identity-changed-or-is-missing"));
    if (!response.ok || !Array.isArray(body.events) || !Number.isSafeInteger(body.cursor) || body.cursor < after || body.events.some(event => !Number.isSafeInteger(event.cursor) || event.cursor <= after || event.cursor > body.cursor)) throw new Error(body.error || copy("legacy.invalid-event-response"));
    for (const event of body.events) {
      if (!activity.some(old => old.cursor === event.cursor)) activity.push(event);
      if (event.aggregateId === selectedId && (!snapshot || event.revision > snapshot.revision)) eventRefreshNeeded = true;
    }
    chatEvents(body.events); schedulesEvents(body.events); resultsEvents(body.events);
    if (unknownOperation) unknownOperation.reconcileCursor = body.cursor;
    activity.sort((a,b) => a.cursor - b.cursor);
    if (receiptObserved()) { const commandId = unknownOperation.commandId; confirmOperation(unknownOperation); await clearPending(unknownOperation); controls(); report(copy("legacy.durable-receipt-found-for-refreshing-current-state",{commandId:commandId}),'success'); eventRefreshNeeded = true; }
    activity = activity.slice(-100);
    cursor = Math.max(cursor, body.cursor); storage.set(cursorKey, String(cursor));
    $('event-state').textContent = copy("legacy.connected",{cursor:cursor}); $('event-state').className = 'tag good';
    $('event-help').textContent = copy("legacy.committed-events-refresh-this-mission-automatically-cursor",{cursor:cursor});
    renderActivity();
    if(body.events.length===100)return true;
    if (reconnectRequired) {
      if (busy || loading) { feedRecoveryPending=true;return; }
      if (!await refreshProviders()) throw new Error(copy("legacy.current-host-permissions-could-not-be-refreshed"));
      await refreshConnections(); providerNotice();
      const missionId = selectedId;
      if (body.feedId) await refreshReadState(epoch,body.feedId);
      else if (missionId && !await loadMission(missionId, false)) throw new Error(copy("legacy.current-mission-could-not-be-refreshed"));
      if (epoch !== connectionEpoch || missionId !== selectedId) throw new Error(copy("legacy.connection-or-selected-mission-changed-during-refresh"));
      if (snapshot) renderMission();
      reconnectRequired = false; feedRecoveryPending=false; eventRefreshNeeded = false; controls();
    } else if (eventRefreshNeeded && !busy && !loading && selectedId) { eventRefreshNeeded = false; await loadMission(selectedId, false); }
  } catch (error) {
    if(busy||loading)feedRecoveryPending=true;requireReconnect();
    $('event-state').textContent = copy("ui.unavailable"); $('event-state').className = 'tag warn';
    $('event-help').textContent = copy("legacy.event-polling-interrupted-snapshot-refresh-remains-available",{message:error.message,cursor:cursor});
  } finally { polling = false; resumeFeedRecovery(); }
}
async function write(path, body, missionId, successMessage, revisionSubmission = null, retirementSubmission = null, budgetSubmission = null, growthSubmission = null, organizationSubmission = null, relationSubmission = null, documentSubmission = null, sourceSubmission = null, conversationSubmission = null, prerequisiteSubmission = null, correctionSubmission = null, expiredSubmission = null, conversationWorkSubmission = null, clarificationSubmission = null, constraintSubmission = null, memoryConflictSubmission = null, memoryExpirySubmission = null) {
  const longRun = path.endsWith('/run'); let ownsBusy = true;
  if (reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return false;
  const operation = {commandId:body.commandId, missionId, reconcileCursor:cursor};
  const writeFeed = feedId;
  const instructionSubmission = body.command?.type === 'steer' ? {missionId,workId:body.command.workId,draft:drafts.get(instructionKey(missionId,body.command.workId))} : null;
  busy = true; controls();
  if (!await persistPending(operation)) { busy = false; controls(); return false; }
  if (reconnectRequired || writeFeed !== feedId) { await clearPending(operation); busy = false; controls(); report(copy("legacy.host-state-changed-before-transmission-no-command"),'warning'); return false; }
  rememberMission(missionId);
  if (instructionSubmission) instructionSubmissions.set(operationKey(operation),instructionSubmission);
  if(constraintSubmission)constraintSubmissions.set(operationKey(operation),constraintSubmission);
  if(clarificationSubmission)clarificationSubmissions.set(operationKey(operation),clarificationSubmission);
  if(conversationWorkSubmission)conversationWorkSubmissions.set(operationKey(operation),conversationWorkSubmission);
  if(memoryExpirySubmission)memoryExpirySubmissions.set(operationKey(operation),memoryExpirySubmission);
  if(memoryConflictSubmission)memoryConflictSubmissions.set(operationKey(operation),memoryConflictSubmission);
  if(conversationSubmission)conversationSubmissions.set(operationKey(operation),conversationSubmission);
  if(prerequisiteSubmission)prerequisiteSubmissions.set(operationKey(operation),prerequisiteSubmission);
  if(correctionSubmission)correctionSubmissions.set(operationKey(operation),correctionSubmission);
  if(expiredSubmission)expiredSubmissions.set(operationKey(operation),expiredSubmission);
  if(sourceSubmission)sourceSubmissions.set(operationKey(operation),sourceSubmission);
  if(documentSubmission)documentSubmissions.set(operationKey(operation),documentSubmission);
  if(relationSubmission)relationSubmissions.set(operationKey(operation),relationSubmission);
  if (organizationSubmission) organizationSubmissions.set(operationKey(operation),organizationSubmission);
  if (revisionSubmission) revisionSubmissions.set(operationKey(operation),revisionSubmission);
  if (retirementSubmission) retirementSubmissions.set(operationKey(operation),retirementSubmission);
  if (budgetSubmission) budgetSubmissions.set(operationKey(operation),budgetSubmission);
  if (growthSubmission) growthSubmissions.set(operationKey(operation),growthSubmission);
  controls(); report(copy("legacy.sending-command",{commandId:body.commandId}));
  try {
    const responsePromise = request(path,{method:'POST',headers:{'Content-Type':'application/json',...(writeFeed ? {'X-Massion-Feed':writeFeed} : {})},body:JSON.stringify(body)},longRun ? 120000 : 15000);
    // Keep the durable pending lock only until admission is observed. Events can then
    // refresh the admitted run and owner controls while the provider HTTP call waits.
    if(longRun){busy=false;ownsBusy=false;controls();}
    const {response, body:result} = await responsePromise;
    if (result.outcome === 'rejected' && result.reason === 'feed') { await clearPending(operation); requireReconnect(); report(copy("legacy.database-changed-before-command-admission-no-command"),'warning'); return false; }
    if (writeFeed && writeFeed !== feedId) { requireReconnect(); throw new Error(copy("legacy.the-command-response-belongs-to-the-previous")); }
    const currentAcknowledgedSnapshot = response.ok ? await verifyAcknowledgementFeed(writeFeed,result.feedId,missionId,'ack:'+body.commandId) : null;
    if((longRun || prerequisiteSubmission || correctionSubmission || expiredSubmission || conversationWorkSubmission || clarificationSubmission || constraintSubmission || conversationSubmission || memoryConflictSubmission || memoryExpirySubmission) && selectedId!==missionId){
      if((prerequisiteSubmission||correctionSubmission||expiredSubmission||conversationWorkSubmission||clarificationSubmission||constraintSubmission||conversationSubmission||memoryConflictSubmission||memoryExpirySubmission)&&response.ok&&['committed','replayed'].includes(result.status)&&validSnapshot(result,missionId)){confirmOperation(operation);await clearPending(operation);return true;}
      if(response.ok && ['settled','blocked','cancelled','already-started'].includes(result.status) && validSnapshot(result.snapshot,missionId)){confirmOperation(operation);await clearPending(operation);return result.status==='settled';}
      if(response.status>=400 && response.status<500 || response.status===503 && result.outcome==='rejected'){await clearPending(operation);return false;}
      throw new Error(copy("legacy.background-run-outcome-requires-durable-readback"));
    }
    if (response.status === 409 || result.status === 'conflict') {
      await clearPending(operation);
      if (body.command?.type === 'steer') instructionConflicts.set(instructionKey(missionId,body.command.workId),{revision:body.expectedRevision,text:body.command.instruction});
      const loaded = await loadMission(missionId, false);
      if (loaded) renderMission();
      report(copy("legacy.the-command-was-not-retried",{value:(result.reason === 'idempotency' ? copy("legacy.command-identity-conflict-the-submitted-action-was") : copy("legacy.revision-conflict")),value2:(loaded ? copy("legacy.review-the-refreshed-state-before-submitting-a") : copy("legacy.current-state-could-not-be-refreshed-reload"))}),'warning');
      return false;
    }
    if (response.status === 503 && result.outcome === 'rejected') {
      await clearPending(operation);
      const loaded = await loadMission(missionId, false);
      report(copy("legacy.command-rejected-the-host-confirmed-a-transaction",{value:(loaded ? copy("legacy.current-state-was-refreshed-you-may-deliberately") : copy("legacy.refresh-the-mission-before-a-deliberate-retry"))}), 'warning');
      return false;
    }
    if (response.status >= 500 || result.status === 'unknown') throw new Error(result.error || copy("legacy.the-host-could-not-confirm-the-commit"));
    if (!response.ok) { await clearPending(operation); report(copy("legacy.command-rejected-no-automatic-retry",{value:(result.error || copy("legacy.http",{status:response.status}))}),'error'); return false; }
    if (path.endsWith('/run') && ['settled','blocked','cancelled','already-started'].includes(result.status) && validSnapshot(result.snapshot,missionId)) {
      confirmOperation(operation); await clearPending(operation); const current = currentAcknowledgedSnapshot || result.snapshot; if(selectedId===missionId && (!snapshot || snapshot.revision<=current.revision)){++readSequence;installSnapshot(current);}
      report(result.reason || successMessage,result.status === 'settled' ? 'success' : 'warning'); return result.status === 'settled';
    }
    if (!['committed','replayed'].includes(result.status) || !validSnapshot(result, missionId)) throw new Error(copy("legacy.the-command-response-did-not-confirm-a"));
    confirmOperation(operation); await clearPending(operation); if((prerequisiteSubmission||correctionSubmission||expiredSubmission||conversationWorkSubmission||clarificationSubmission||constraintSubmission||conversationSubmission||memoryConflictSubmission||memoryExpirySubmission)&&selectedId!==missionId)return true; rememberMission(missionId); ++readSequence; installSnapshot(currentAcknowledgedSnapshot || result);
    // Every Work admission (plain, correction, saved owner message) reveals the new card on the Mission tab.
    if (path.endsWith('/work')) paneExplicit(missionId,'','');
    report(copy("legacy.revision-2",{successMessage:successMessage,revision:result.revision,value:(result.status === 'replayed' ? copy("legacy.existing-receipt") : '.')}),'success');
    return true;
  } catch (error) {
    if((longRun || prerequisiteSubmission || correctionSubmission || expiredSubmission || conversationWorkSubmission || clarificationSubmission || constraintSubmission || conversationSubmission || memoryConflictSubmission || memoryExpirySubmission) && selectedId!==missionId){if(!confirmedOperations.has(operationKey(operation)) && (!unknownOperation || operationKey(unknownOperation)===operationKey(operation)))unknownOperation=operation;await pollEvents();return false;}
    if (confirmedOperations.has(operationKey(operation))) {
      const loaded = await loadMission(missionId, false);
      if (loaded) report(copy("legacy.the-host-confirmed-this-command-its-current"),'success');
      if (loaded && path.endsWith('/work')) paneExplicit(missionId,'','');
      return loaded;
    }
    unknownOperation = operation; rememberMission(missionId); controls();
    report(copy("legacy.write-outcome-unknown-reading-back-durable-state",{message:error.message}),'warning');
    await loadMission(missionId,false);
    await pollEvents();
    return false;
  } finally { if(ownsBusy)busy = false; controls(); if (eventRefreshNeeded && !unknownOperation) { eventRefreshNeeded = false; await loadMission(selectedId,false); } }
}
async function sendCommand(command, restoreFocus = false) {
  if (!snapshot || reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const missionId = snapshot.value.id, submittedFocus = document.activeElement;
  await write('/missions/' + encodeURIComponent(missionId) + '/commands',{commandId:crypto.randomUUID(),expectedRevision:snapshot.revision,command},missionId,command.type === 'quarantine-runtime' ? copy("legacy.work-permanently-quarantined-external-outcomes-remain-unresolved") : command.type === 'cancel' ? copy("legacy.cancellation-recorded") : copy("legacy.steering-instruction-recorded-inspect-the-current-execution"));
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
 for(const [key,submission] of sourceSubmissions){if(submission.missionId!==selectedId || !confirmedOperations.has(key) || snapshot.revision<=submission.expectedRevision)continue;const draft=sourceDrafts.get(selectedId),unchanged=draft===submission.draft&&JSON.stringify(sourceValues())===JSON.stringify(submission.values);if(unchanged){sourceDrafts.set(selectedId,emptySourceDraft());['source-work','source-document','source-reason'].forEach(name=>$(name).value='');}sourceStatuses.set(selectedId,copy("legacy.exact-source-selection-confirmed",{value:(unchanged?copy("legacy.work-retains-the-original-saving-starts-no"):copy("legacy.later-private-edits-retained"))}));sourceSubmissions.delete(key);}
 let draft=sourceDrafts.get(selectedId);if(!draft){draft=emptySourceDraft();sourceDrafts.set(selectedId,draft);}
 const workSelect=$('source-work'),docSelect=$('source-document');for(const select of [workSelect,docSelect]){select.replaceChildren();const blank=element('option',copy("legacy.choose-exact",{value:(select===workSelect?copy("legacy.fresh-work"):copy("legacy.stored-document"))}));blank.value='';select.append(blank);}
 for(const work of snapshot.value.works){const option=element('option',work.id+' · '+work.title+(budgetFresh(work)?'':copy("legacy.unavailable-execution-evidence-exists")));option.value=work.id;option.disabled=!budgetFresh(work);workSelect.append(option);}workSelect.value=draft.values[0];
 for(const d of snapshot.value.documents || []){const option=element('option',copy("legacy.v-sha-256",{id:d.id,version:d.version,title:d.title,contentSha256:d.contentSha256}));option.value=JSON.stringify([d.id,d.version,d.contentSha256]);docSelect.append(option);}docSelect.value=draft.values[1];$('source-reason').value=draft.values[2];
 const area=$('source-evidence');area.replaceChildren();const original=draft.original?JSON.parse(draft.original):null;
 if(original){area.append(element('p',copy("legacy.v-2",{id:original.id,version:original.version,title:original.title})),element('p',copy("legacy.source-original-author",{source:original.source,actorId:original.actorId})),element('p',copy("legacy.sha-256-2",{contentSha256:original.contentSha256}),'hint'),element('pre',original.content));if(!sourceSelection(draft))area.append(element('p',copy("legacy.exact-source-work-is-unavailable-already-selected"),'warning'));}
 $('source-base').textContent=copy("legacy.draft-based-on-aggregate-revision-current",{baseRevision:draft.baseRevision,revision:snapshot.revision,value:(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?copy("legacy.state-changed-compare-and-review-before-attaching"):'')});$('source-status').textContent=sourceStatuses.get(selectedId) || copy("legacy.select-exact-work-and-original-source-saving");
}
for(const id of ['source-work','source-document'])$(id).addEventListener('change',()=>{if(!organizationEditable())return;const draft=sourceDrafts.get(selectedId);draft.values=sourceValues();const original=sourceDocument(draft.values[1]);draft.original=original?JSON.stringify(original):null;renderSources();});
for(const event of ['input','change'])$('source-reason').addEventListener(event,()=>{const draft=sourceDrafts.get(sourceMission);if(draft)draft.values=sourceValues();});
$('cancel-source').addEventListener('click',()=>{if(!organizationEditable())return;sourceDrafts.set(selectedId,emptySourceDraft());sourceStatuses.set(selectedId,copy("legacy.private-source-selection-cancelled-no-command-was"));renderSources();});
$('review-source').addEventListener('click',()=>{const draft=sourceDrafts.get(selectedId);if(!organizationEditable() || !sourceSelection(draft))return;draft.values=sourceValues();draft.baseRevision=snapshot.revision;draft.feed=feedId;sourceStatuses.set(selectedId,copy("legacy.exact-original-and-fresh-work-reviewed-inspect"));renderSources();});
$('source-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!organizationEditable())return;const draft=sourceDrafts.get(selectedId),values=sourceValues();
 if(!sourceSelection(draft) || JSON.stringify(values.slice(0,2))!==JSON.stringify(draft.values.slice(0,2)) || draft.baseRevision!==snapshot.revision || draft.feed!==feedId){sourceStatuses.set(selectedId,copy("legacy.exact-selection-or-state-changed-compare-original"));renderSources();return;}
 if(!values[2].trim() || values[2].length>2000 || !values[2].isWellFormed()){sourceStatuses.set(selectedId,copy("legacy.enter-a-bounded-reason-for-this-exact"));return;}
 const d=sourceDocument(values[1]),missionId=selectedId,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,workId:values[0],documentId:d.id,version:d.version,contentSha256:d.contentSha256,reason:values[2]};if(!commandBodyFits(body))return;draft.values=[...values];const focus=document.activeElement;
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/work-source',body,missionId,copy("legacy.original-source-attached-to-fresh-work-no"),null,null,null,null,null,null,null,{missionId,draft,values:[...values],expectedRevision:body.expectedRevision});
 if(snapshot?.value.id===missionId && selectedId===missionId){if(!saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))sourceStatuses.set(missionId,copy("legacy.source-selection-not-confirmed-here-original-draft"));renderSources();if($('source-form').contains(focus)){sourceFocus={missionId,previous:focus,targetId:focus.id};controls();}}
});
function documentValues(){return documentIds.map(id=>$(id).value);}
function emptyDocumentDraft(){return {values:['','1','','',''],baseRevision:snapshot.revision,feed:feedId};}
function switchDocumentDraft(id){if(documentMission===id)return;const old=documentDrafts.get(documentMission);if(old)old.values=documentValues();documentMission=id;const values=documentDrafts.get(id)?.values || ['','1','','',''];documentIds.forEach((name,i)=>$(name).value=values[i]);$('document-query').value='';}
function renderDocuments(){
 switchDocumentDraft(snapshot.value.id);
 for(const [key,submission] of documentSubmissions){if(submission.missionId!==selectedId || !confirmedOperations.has(key) || snapshot.revision<=submission.expectedRevision)continue;
 const draft=documentDrafts.get(selectedId),unchanged=draft===submission.draft && JSON.stringify(documentValues())===JSON.stringify(submission.values);if(unchanged){documentDrafts.set(selectedId,emptyDocumentDraft());documentIds.forEach((name,i)=>$(name).value=documentDrafts.get(selectedId).values[i]);}documentStatuses.set(selectedId,copy("legacy.exact-document-version-confirmed",{value:(unchanged?copy("legacy.search-or-read-its-original-source-deliberately"):copy("legacy.later-private-edits-retained"))}));documentSubmissions.delete(key);}
 let draft=documentDrafts.get(selectedId);if(!draft){draft=emptyDocumentDraft();documentDrafts.set(selectedId,draft);documentIds.forEach((name,i)=>$(name).value=draft.values[i]);}
 $('document-base').textContent=copy("legacy.current-aggregate-revision-draft-based-on-revision",{revision:snapshot.revision,baseRevision:draft.baseRevision,value:(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?copy("legacy.state-changed-inspect-stored-versions-and-review"):'')});$('document-status').textContent=documentStatuses.get(selectedId) || copy("legacy.enter-an-exact-document-id-version-and");
 const history=snapshot.value.documents || [],choice=documentChoices.get(selectedId) || '';const select=$('document-choice');select.replaceChildren();const blank=element('option',copy("legacy.choose-an-exact-stored-version"));blank.value='';select.append(blank);
 for(const d of history){const option=element('option',copy("legacy.v-2",{id:d.id,version:d.version,title:d.title}));option.value=JSON.stringify([d.id,d.version,d.contentSha256]);select.append(option);}select.value=history.some(d=>JSON.stringify([d.id,d.version,d.contentSha256])===choice)?choice:'';documentReadControls();
}
for(const id of documentIds)for(const event of ['input','change'])$(id).addEventListener(event,()=>{const draft=documentDrafts.get(documentMission);if(draft)draft.values=documentValues();});
$('cancel-document').addEventListener('click',()=>{if(!organizationEditable())return;documentDrafts.set(selectedId,emptyDocumentDraft());documentIds.forEach((name,i)=>$(name).value=documentDrafts.get(selectedId).values[i]);documentStatuses.set(selectedId,copy("legacy.private-document-draft-cancelled-no-command-was"));renderDocuments();});
$('review-document').addEventListener('click',()=>{if(!organizationEditable())return;const draft=documentDrafts.get(selectedId);draft.values=documentValues();draft.baseRevision=snapshot.revision;draft.feed=feedId;documentStatuses.set(selectedId,copy("legacy.exact-document-draft-reviewed-confirm-id-and"));renderDocuments();});
$('document-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!organizationEditable())return;const draft=documentDrafts.get(selectedId),values=documentValues(),version=Number(values[1]);
 if(draft.baseRevision!==snapshot.revision || draft.feed!==feedId){documentStatuses.set(selectedId,copy("legacy.state-changed-review-original-source-and-exact"));renderDocuments();return;}
 const previous=(snapshot.value.documents || []).filter(d=>d.id===values[0]).at(-1)?.version || 0;
 if(!/^document:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(values[0]) || !Number.isSafeInteger(version) || version!==previous+1 || [values[2],values[3],values[4]].some((value,i)=>!value.trim() || !value.isWellFormed() || value.length>[200,2000,16384][i]) || new TextEncoder().encode(values[4]).byteLength>16384){documentStatuses.set(selectedId,copy("legacy.enter-bounded-original-text-title-source-and"));renderDocuments();return;}
 const missionId=selectedId,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,document:{id:values[0],version,title:values[2],source:values[3],content:values[4]}};if(!commandBodyFits(body)){documentStatuses.set(missionId,copy("legacy.serialized-document-command-exceeds-utf-8-request"));renderDocuments();return;}draft.values=[...values];const focus=document.activeElement;
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/documents',body,missionId,copy("legacy.exact-document-stored-earlier-sources-and-accepted"),null,null,null,null,null,null,{missionId,draft,values:[...values],expectedRevision:body.expectedRevision});
 if(snapshot?.value.id===missionId && selectedId===missionId){if(!saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))documentStatuses.set(missionId,copy("legacy.document-not-confirmed-here-exact-draft-and"));renderDocuments();if($('document-form').contains(focus)){documentFocus={missionId,previous:focus,targetId:focus.id};controls();}}
});
function selectedDocument(){const value=$('document-choice').value;return (snapshot?.value.documents || []).find(d=>JSON.stringify([d.id,d.version,d.contentSha256])===value);}
function documentReadControls(){const ready=!reconnectRequired && !loading && !recoveryProblem && snapshot?.value.id===selectedId;$('document-search').disabled=!ready || !!documentReadController;$('document-read').disabled=!ready || !selectedDocument() || !!documentReadController;$('document-usage').disabled=!ready || !selectedDocument() || !!documentReadController;$('document-choice').disabled=!ready;$('document-read-cancel').disabled=!documentReadController;}
function invalidateDocumentRead(message=copy("legacy.read-selection-changed-search-or-choose-exact")) {documentReadSequence++;documentReadController?.abort();documentReadController=null;$('document-read-results').replaceChildren();$('document-search-results').replaceChildren();$('document-usage-results').replaceChildren();$('document-read-status').textContent=message;documentReadControls();}
function currentDocumentRead(choice){return choice.sequence===documentReadSequence && selectedId===choice.missionId && snapshot?.value.id===choice.missionId && snapshot.revision===choice.revision && feedId===choice.feed && connectionEpoch===choice.epoch && (choice.mode==='search'?$('document-query').value===choice.query:$('document-choice').value===choice.selection);}
$('document-choice').addEventListener('change',()=>{documentChoices.set(selectedId,$('document-choice').value);invalidateDocumentRead();});$('document-query').addEventListener('input',()=>invalidateDocumentRead());
$('document-read-cancel').addEventListener('click',()=>{const focus=document.activeElement;invalidateDocumentRead(copy("legacy.source-read-cancelled-no-command-was-sent"));if(focus===$('document-read-cancel'))restoreControlFocus(focus,documentReadButton(documentReadMode));});
function documentReadButton(mode){return mode==='search'?'document-search':mode==='usage'?'document-usage':'document-read';}
function useData(work,pin){return {workId:work.id,title:work.title,execution:work.execution,acceptance:work.acceptance,criteriaVersion:work.criteria.version,decision:{actorId:pin.actorId,reason:pin.reason},...(work.record?{record:{id:work.record.id,checksum:work.record.checksum,evidenceClass:work.record.evidenceClass,criteriaVersion:work.record.criteria.version,artifact:{id:work.record.artifact.id,version:work.record.artifact.version,sha256:work.record.artifact.sha256,kind:work.record.artifact.kind}}}:{})};}
function comparableData(value){if(Array.isArray(value))return value.map(comparableData);if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,comparableData(value[key])]));return value;}
function renderDocumentUses(body,choice){
 const expected=snapshot.value.works.flatMap(work=>{const pin=(work.sourceDocuments || []).find(p=>p.document.id===choice.document.id && p.document.version===choice.document.version && p.document.contentSha256===choice.document.contentSha256);if(!pin)return [];if(JSON.stringify(comparableData(pin.document))!==JSON.stringify(comparableData(choice.document)))throw Error(copy("legacy.pinned-work-original-differs-from-selected-source"));return [useData(work,pin)];});
 if(body.limit!==20 || body.totalUses!==expected.length || !Array.isArray(body.uses) || JSON.stringify(comparableData(body.uses))!==JSON.stringify(comparableData(expected.slice(0,20))))throw Error(copy("legacy.use-results-do-not-match-exact-work"));
 const area=$('document-usage-results');area.append(element('p',copy("legacy.work-uses-v-showing-limit-20",{totalUses:body.totalUses,id:choice.document.id,version:choice.document.version,length:body.uses.length}),'hint'),element('p',copy("legacy.original-source-sha-256",{contentSha256:choice.document.contentSha256}),'hint'));
 for(const use of body.uses){area.append(element('h4',use.workId+' · '+use.title),element('p',copy("legacy.execution-acceptance-criteria-v",{execution:use.execution,acceptance:use.acceptance,criteriaVersion:use.criteriaVersion})),element('pre',copy("legacy.owner-selection-reason",{actorId:use.decision.actorId,reason:use.decision.reason})));
  const inspect=element('button',copy("legacy.inspect-work",{workId:use.workId}));inspect.id='document-usage-work-'+use.workId;inspect.type='button';inspect.addEventListener('click',()=>{if(!currentDocumentRead(choice))return;paneExplicit(snapshot.value.id,use.workId,use.title);openWorkEvidence(use.workId);document.getElementById('work-heading-'+use.workId)?.focus();});area.append(inspect);
  if(use.record){area.append(element('p',copy("legacy.record-evidence-criteria-v",{id:use.record.id,evidenceClass:use.record.evidenceClass,criteriaVersion:use.record.criteriaVersion})),element('p',copy("legacy.record-checksum",{checksum:use.record.checksum}),'hint'),element('p',copy("legacy.artifact-v-sha-256",{id:use.record.artifact.id,version:use.record.artifact.version,kind:use.record.artifact.kind,sha256:use.record.artifact.sha256}),'hint'));
   const record=element('button',copy("legacy.inspect-exact-record",{id:use.record.id}));record.id='document-usage-record-'+use.workId;record.type='button';record.addEventListener('click',()=>{if(!currentDocumentRead(choice))return;paneExplicit(snapshot.value.id,use.workId,use.title);openWorkEvidence(use.workId);const summary=document.getElementById('work-record-text-summary-'+use.workId);if(summary?.parentElement)summary.parentElement.open=true;const read=document.getElementById('work-record-text-read-'+use.workId);if(read && !read.disabled)read.focus();else document.getElementById('work-heading-'+use.workId)?.focus();});area.append(record);
  }else area.append(element('p',copy("legacy.no-accepted-record-for-this-work")));
 }
 $('document-read-status').textContent=copy("legacy.exact-original-and-stored-use-bindings-checked",{value:(body.totalUses>20?copy("legacy.more-uses-exist-this-view-shows-only"):'')});
}
async function readStoredDocument(mode){
 documentReadControls();const button=$(documentReadButton(mode));if(button.disabled)return;const d=selectedDocument(),query=$('document-query').value;if(mode==='search' && (!query.trim() || query.length>200 || !query.isWellFormed())){$('document-read-status').textContent=copy("legacy.enter-a-bounded-literal-query-no-read");return;}const focus=document.activeElement;invalidateDocumentRead();
 const choice={sequence:documentReadSequence,missionId:selectedId,revision:snapshot.revision,feed:feedId,epoch:connectionEpoch,mode,query,selection:$('document-choice').value,document:d?JSON.parse(JSON.stringify(d)):null},controller=new AbortController();documentReadController=controller;documentReadMode=mode;documentReadControls();$('document-read-status').textContent=copy("legacy.reading-stored",{value:(mode==='search'?copy("legacy.latest-source-matches"):mode==='usage'?copy("legacy.exact-source-work-record-uses"):copy("legacy.exact-original-source"))});const timer=setTimeout(()=>controller.abort(),15000);
 try{const path='/missions/'+encodeURIComponent(choice.missionId)+(mode==='search'?'/documents?query='+encodeURIComponent(query):(mode==='usage'?'/document-usage?id=':'/document?id=')+encodeURIComponent(d.id)+'&version='+d.version+'&sha256='+d.contentSha256),{response,body}=await request(path,{scope:'document-panel',headers:{'X-Massion-Feed':choice.feed},signal:controller.signal});if(!currentDocumentRead(choice))return;if(!response.ok)throw Error(body?.error || copy("legacy.document-read-unavailable"));if(body.missionId!==choice.missionId || body.feedId!==choice.feed || body.revision!==choice.revision || !Number.isSafeInteger(body.cursor) || body.cursor<0)throw Error(copy("legacy.reply-does-not-match-current-mission-feed"));
 if(mode==='search'){
  const latest=new Map();for(const entry of snapshot.value.documents || [])latest.set(entry.id,entry);if(body.query!==query || body.limit!==20 || !Number.isSafeInteger(body.totalMatches) || body.totalMatches<0 || body.totalMatches>100 || body.totalMatches!==[...latest.values()].filter(d=>d.title.includes(query)||d.content.includes(query)).length || !Array.isArray(body.matches) || body.matches.length!==Math.min(body.totalMatches,20) || new Set(body.matches.map(m=>m.id)).size!==body.matches.length || body.matches.some(m=>{const exact=latest.get(m.id);return !exact || exact.version!==m.version || exact.title!==m.title || exact.source!==m.source || exact.contentSha256!==m.contentSha256 || exact.actorId!==m.actorId || typeof m.excerpt!=='string' || m.excerpt.length>240 || !exact.content.includes(m.excerpt) || !(exact.title.includes(query)||exact.content.includes(query));}))throw Error(copy("legacy.latest-search-evidence-did-not-match-exact"));
  const area=$('document-search-results');area.append(element('p',copy("legacy.latest-versions-match-showing-limit-20-earlier",{totalMatches:body.totalMatches,length:body.matches.length})));
  for(const match of body.matches){area.append(element('p',copy("legacy.v-2",{id:match.id,version:match.version,title:match.title})),element('pre',match.excerpt));const read=element('button',copy("legacy.read-v",{id:match.id,version:match.version}));read.type='button';read.addEventListener('click',()=>{if(!currentDocumentRead(choice))return;const selection=JSON.stringify([match.id,match.version,match.contentSha256]);documentChoices.set(selectedId,selection);$('document-choice').value=selection;invalidateDocumentRead();restoreControlFocus(read,'document-read');void readStoredDocument('exact');});area.append(read);}
  $('document-read-status').textContent=copy("legacy.literal-latest-version-search-read-only",{value:(body.totalMatches>20?copy("legacy.more-matches-exist-narrow-your-query"):copy("legacy.no-command-was-sent"))});
 }else{
  if(!body.document || Object.keys(body.document).length!==7 || ['id','version','title','content','source','contentSha256','actorId'].some(key=>body.document[key]!==choice.document[key]) || typeof body.document.content!=='string' || !body.document.content.isWellFormed())throw Error(copy("legacy.exact-document-fields-do-not-match-the"));const bytes=new TextEncoder().encode(body.document.content);if(bytes.length>16384 || body.byteLength!==bytes.length || !crypto.subtle)throw Error(copy("legacy.document-utf-8-bound-is-unavailable-or"));const digest=await crypto.subtle.digest('SHA-256',bytes),sha=Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');if(!currentDocumentRead(choice))return;if(sha!==choice.document.contentSha256)throw Error(copy("legacy.original-document-sha-256-mismatch"));if(mode==='usage'){renderDocumentUses(body,choice);}else{const area=$('document-read-results');area.append(element('p',copy("legacy.v-2",{id:d.id,version:d.version,title:d.title})),element('p',copy("legacy.source-author",{source:d.source,actorId:d.actorId})),element('p',copy("legacy.sha-256-3",{sha:sha}),'hint'),element('pre',body.document.content));$('document-read-status').textContent=copy("legacy.exact-original-version-and-utf-8-content");}
 }
 }catch(error){if(currentDocumentRead(choice)){$('document-read-status').textContent=copy("legacy.source-read-not-verified-no-write-or",{value:(error?.message || copy("ui.panel.unavailable"))});}}
 finally{clearTimeout(timer);if(currentDocumentRead(choice)){documentReadController=null;documentReadControls();if(focus===button)restoreControlFocus(focus,button.id);}}
}
$('document-search-form').addEventListener('submit',event=>{event.preventDefault();return readStoredDocument('search');});$('document-read').addEventListener('click',()=>readStoredDocument('exact'));$('document-usage').addEventListener('click',()=>readStoredDocument('usage'));
function relationValues(){return relationIds.map(id=>$(id).value);}
function emptyRelationDraft(){return {values:['','1','depends-on','','1',''],baseRevision:snapshot.revision,feed:feedId};}
function switchRelationDraft(id){if(relationMission===id)return;const old=relationDrafts.get(relationMission);if(old)old.values=relationValues();relationMission=id;const values=relationDrafts.get(id)?.values || ['','1','depends-on','','1',''];relationIds.forEach((name,index)=>$(name).value=values[index]);}
function renderRelations(){
 switchRelationDraft(snapshot.value.id);
 for(const [key,submission] of relationSubmissions){if(submission.missionId!==selectedId || !confirmedOperations.has(key) || snapshot.revision<=submission.expectedRevision)continue;
 const draft=relationDrafts.get(selectedId),unchanged=draft===submission.draft && JSON.stringify(relationValues())===JSON.stringify(submission.values);if(unchanged){relationDrafts.set(selectedId,emptyRelationDraft());relationIds.forEach((name,index)=>$(name).value=relationDrafts.get(selectedId).values[index]);}relationStatuses.set(selectedId,copy("legacy.exact-relation-confirmed",{value:(unchanged?copy("legacy.read-target-impact-explicitly-to-inspect-its"):copy("legacy.later-private-edits-retained"))}));relationSubmissions.delete(key);}
 let draft=relationDrafts.get(selectedId);if(!draft){draft=emptyRelationDraft();relationDrafts.set(selectedId,draft);relationIds.forEach((name,index)=>$(name).value=draft.values[index]);}
 $('relation-base').textContent=copy("legacy.current-aggregate-revision-draft-based-on-revision",{revision:snapshot.revision,baseRevision:draft.baseRevision,value:(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?copy("legacy.state-changed-compare-current-relationships-and-review"):'')});
 $('relation-status').textContent=relationStatuses.get(selectedId) || copy("legacy.enter-exact-reference-identities-versions-and-provenance");
 const area=$('relation-history');area.replaceChildren();area.append(element('p',copy("legacy.stored-relations-user-references-are-declarations-inferred",{length:(snapshot.value.relations || []).length}),'hint'));
 for(const r of snapshot.value.relations || [])area.append(element('p',copy("legacy.inferred",{value:r.from+'@'+r.fromVersion+' '+r.type+' '+r.to+'@'+r.toVersion,inferred:r.inferred})),element('pre',copy("legacy.provenance",{provenance:r.provenance})));
}
for(const id of relationIds)for(const event of ['input','change'])$(id).addEventListener(event,()=>{const draft=relationDrafts.get(relationMission);if(draft)draft.values=relationValues();});
$('cancel-relation').addEventListener('click',()=>{if(!organizationEditable())return;relationDrafts.set(selectedId,emptyRelationDraft());relationIds.forEach((name,index)=>$(name).value=relationDrafts.get(selectedId).values[index]);relationStatuses.set(selectedId,copy("legacy.private-relation-draft-cancelled-no-command-was"));renderRelations();});
$('review-relation').addEventListener('click',()=>{if(!organizationEditable())return;const draft=relationDrafts.get(selectedId);draft.values=relationValues();draft.baseRevision=snapshot.revision;draft.feed=feedId;relationStatuses.set(selectedId,copy("legacy.exact-relation-draft-reviewed-against-current-state"));renderRelations();});
$('relation-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!organizationEditable())return;const draft=relationDrafts.get(selectedId),values=relationValues(),fromVersion=Number(values[1]),toVersion=Number(values[4]);
 if(draft.baseRevision!==snapshot.revision || draft.feed!==feedId){relationStatuses.set(selectedId,copy("legacy.state-changed-review-this-exact-relation-against"));renderRelations();return;}
 if([values[0],values[3],values[5]].some(value=>!value.trim() || value.length>2000 || !value.isWellFormed()) || !Number.isSafeInteger(fromVersion) || fromVersion<1 || !Number.isSafeInteger(toVersion) || toVersion<1 || !['depends-on','evidenced-by','contains'].includes(values[2])){relationStatuses.set(selectedId,copy("legacy.enter-exact-references-positive-whole-versions-supported"));renderRelations();return;}
 const missionId=selectedId,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,relation:{from:values[0],fromVersion,type:values[2],to:values[3],toVersion,provenance:values[5]}};if(!commandBodyFits(body)){relationStatuses.set(selectedId,copy("legacy.serialized-command-exceeds-utf-8-request-bound"));renderRelations();return;}
 draft.values=[...values];const submittedFocus=document.activeElement;const saved=await write('/missions/'+encodeURIComponent(missionId)+'/relations',body,missionId,copy("legacy.exact-owner-relation-recorded-existing-work-and"),null,null,null,null,null,{missionId,draft,values:[...values],expectedRevision:body.expectedRevision});
 if(snapshot?.value.id===missionId && selectedId===missionId){if(!saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))relationStatuses.set(missionId,copy("legacy.relation-not-confirmed-here-exact-draft-and"));renderRelations();if($('relation-form').contains(submittedFocus)){relationFocus={missionId,previous:submittedFocus,targetId:submittedFocus.id};controls();}}
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
  organizationStatuses.set(selectedId,copy("legacy.organization-revision-confirmed-existing-work-pins-remain",{version:submission.version,value:(unchanged?copy("legacy.choose-an-exact-revision-before-another-edit"):copy("legacy.later-private-edits-retained"))}));
  organizationSubmissions.delete(key);
 }
 const draft=organizationDrafts.get(selectedId),history=organizationHistory(),current=history.at(-1);
 $('organization-current').textContent=copy("legacy.current-aggregate-revision",{revision:snapshot.revision,value:(current?copy("legacy.current-organization-v",{version:current.version}):copy("legacy.no-organization-revision-stored-earlier-work-remains"))});
 const select=$('organization-target'),options=[element('option',copy("legacy.choose-exact-revision-or-new-definitions")),element('option',copy("legacy.new-responsibility-definitions"))];options[0].value='';options[1].value='new';
 for(const revision of history){const option=element('option',copy("legacy.organization-v-author",{version:revision.version,actorId:revision.actorId,value:(revision===current?copy("legacy.current"):'')}));option.value=String(revision.version);options.push(option);}select.replaceChildren(...options);select.value=draft?.target || '';
 const source=draft && organizationSource(draft.target),area=$('organization-evidence');area.replaceChildren();
 if(source){area.append(element('h3',copy("legacy.stored-organization-v",{version:source.version})),element('p',copy("legacy.author",{actorId:source.actorId})),element('p',copy("legacy.recorded-reason",{reason:source.reason})));for(const item of source.responsibilities)area.append(element('h4',copy("legacy.required",{role:item.role,capability:item.capability})),element('pre',item.responsibility));}
 else area.append(element('p',draft?.target==='new'?copy("legacy.new-owner-authored-definitions-no-stored-source"):copy("legacy.choose-an-exact-stored-revision-to-inspect"),'hint'));
 $('organization-version').value=draft?String(draft.baseVersion+1):'';
 $('organization-base').textContent=draft?copy("legacy.draft-source-based-on-aggregate-revision-and",{value:(draft.target==='new'?copy("legacy.new-definitions"):copy("legacy.organization-v",{target:draft.target})),baseRevision:draft.baseRevision,baseVersion:draft.baseVersion,value2:(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?copy("legacy.state-changed-compare-current-state-then-explicitly"):''),value3:(!organizationSourceMatches(draft)?copy("legacy.exact-source-changed-or-is-unavailable-choose"):'')}):copy("legacy.no-private-draft-selected");
 $('organization-status').textContent=organizationStatuses.get(selectedId) || copy("legacy.choose-a-source-revision-and-review-its");organizationControls();
}
$('organization-target').addEventListener('change',()=>{
 if(!organizationEditable())return;const target=$('organization-target').value,source=organizationSource(target);if(target!=='new' && !source){organizationDrafts.delete(selectedId);organizationIds.forEach(name=>$(name).value='');renderOrganization();return;}
 const values=[source?.responsibilities.find(item=>item.role==='executor').responsibility || '',source?.responsibilities.find(item=>item.role==='verifier').responsibility || '',''];organizationDrafts.set(selectedId,{target,source:source?JSON.stringify(source):null,values,baseRevision:snapshot.revision,baseVersion:organizationHistory().at(-1)?.version || 0,feed:feedId});organizationIds.forEach((name,index)=>$(name).value=values[index]);organizationStatuses.set(selectedId,copy("legacy.private-draft-from-exact-review-responsibilities-and",{value:(source?copy("legacy.organization-v-2",{version:source.version}):copy("legacy.new-definitions"))}));renderOrganization();
});
for(const id of organizationIds)for(const event of ['input','change'])$(id).addEventListener(event,()=>{const draft=organizationDrafts.get(organizationMission);if(draft)draft.values=organizationValues();});
$('cancel-organization').addEventListener('click',()=>{if(!organizationEditable())return;organizationDrafts.delete(selectedId);organizationIds.forEach(name=>$(name).value='');organizationStatuses.set(selectedId,copy("legacy.private-responsibility-draft-cancelled-no-command-was"));renderOrganization();});
$('review-organization').addEventListener('click',()=>{const draft=organizationDrafts.get(selectedId);if(!organizationEditable() || !organizationSourceMatches(draft))return;draft.values=organizationValues();draft.baseRevision=snapshot.revision;draft.baseVersion=organizationHistory().at(-1)?.version || 0;draft.feed=feedId;organizationStatuses.set(selectedId,copy("legacy.draft-reviewed-against-current-state-saving-will",{value:(draft.baseVersion+1)}));renderOrganization();});
$('organization-recheck').addEventListener('click',async()=>{if(busy || loading || !unknownOperation || unknownOperation.missionId!==selectedId)return;await pollEvents();});
$('organization-form').addEventListener('submit',async event=>{
 event.preventDefault();const draft=organizationDrafts.get(selectedId);if(!organizationEditable() || !organizationSourceMatches(draft))return;
 if(draft.baseRevision!==snapshot.revision || draft.feed!==feedId){organizationStatuses.set(selectedId,copy("legacy.state-changed-compare-current-state-and-explicitly"));renderOrganization();return;}
 const values=organizationValues(),version=draft.baseVersion+1;
 if(!Number.isSafeInteger(version) || values.some(value=>!value.trim() || value.length>2000 || !value.isWellFormed())){organizationStatuses.set(selectedId,copy("legacy.enter-both-responsibility-definitions-and-a-reason"));renderOrganization();return;}
 const missionId=selectedId,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,version,reason:values[2],responsibilities:[{role:'executor',responsibility:values[0],capability:'text-output'},{role:'verifier',responsibility:values[1],capability:'independent-text-review'}]};
 if(!commandBodyFits(body)){organizationStatuses.set(selectedId,copy("legacy.serialized-command-exceeds-utf-8-request-bound"));renderOrganization();return;}
 draft.values=[...values];const submittedFocus=document.activeElement;organizationStatuses.set(missionId,copy("legacy.saving-new-organization-revision-existing-work-pins"));renderOrganization();
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/organization',body,missionId,copy("legacy.organization-responsibility-revision-saved-existing-work-pins"),null,null,null,null,{missionId,draft,values:[...values],version,expectedRevision:body.expectedRevision});
 if(snapshot?.value.id===missionId && selectedId===missionId){if(!saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))organizationStatuses.set(missionId,copy("legacy.revision-not-confirmed-here-your-exact-source"));renderOrganization();if($('organization-form').contains(submittedFocus)){organizationFocus={missionId,previous:submittedFocus,targetId:!organizationDrafts.has(missionId) && submittedFocus.id==='save-organization'?'organization-target':submittedFocus.id};controls();}}
});
function revisionValues() { return revisionIds.map(id => $(id).value); }
function revisionCriteriaText(criteria) { const method = criteria.oracle === 'manual-review/v1' ? copy("legacy.manual-review") : criteria.oracle === 'bounded-text-review/v1' ? copy("legacy.bounded-text-with-independent-model-review") : criteria.oracle; return copy("legacy.acceptance-method",{value:'v' + criteria.version + ': ' + criteria.description,method:method}); }
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
  $('revision-status').textContent = copy("legacy.review-current-purpose-and-criteria-before-saving");
}
function renderRevision() {
  switchRevisionDraft(snapshot.value.id);
  for (const [key, submission] of revisionSubmissions) {
    if (submission.missionId !== revisionMission || !confirmedOperations.has(key) || snapshot.revision <= submission.expectedRevision) continue;
    const unchanged = JSON.stringify(revisionValues()) === JSON.stringify(submission.values);
    if (unchanged) revisionDrafts.set(revisionMission,newRevisionDraft());
    revisionSubmissions.delete(key);
    $('revision-status').textContent = copy("legacy.mission-revision-confirmed",{value:(unchanged ? copy("legacy.only-future-work-uses-the-new-purpose") : copy("legacy.later-private-edits-retained"))});
  }
  let draft = revisionDrafts.get(revisionMission);
  if (!draft || !draft.dirty) { draft = newRevisionDraft(); revisionDrafts.set(revisionMission,draft); for(let i=0;i<revisionIds.length;i++) $(revisionIds[i]).value = draft.values[i]; }
  $('revision-current').textContent = copy("legacy.current-revision-mission-v-criteria",{revision:snapshot.revision,version:snapshot.value.version,purpose:snapshot.value.purpose,value:revisionCriteriaText(snapshot.value.criteria)});
  $('revision-base').textContent = copy("legacy.draft-based-on-revision-criteria",{baseRevision:draft.baseRevision,basePurpose:draft.basePurpose,baseCriteria:draft.baseCriteria,value:(draft.baseRevision !== snapshot.revision ? copy("legacy.state-changed-compare-current-and-draft-before") : '')});
}
function revisionEditable() { return snapshot && snapshot.value.id === selectedId && !reconnectRequired && !busy && !loading && !unknownOperation && !recoveryProblem; }
for (const id of revisionIds) for (const event of ['input','change']) $(id).addEventListener(event,() => { const draft = revisionDrafts.get(revisionMission); if (draft) { draft.values = revisionValues(); draft.dirty = true; } });
$('discard-revision').addEventListener('click',() => { if (!revisionEditable()) return; revisionDrafts.set(selectedId,newRevisionDraft()); renderRevision(); $('revision-status').textContent = copy("legacy.revision-draft-discarded-no-command-was-sent"); });
$('rebase-revision').addEventListener('click',() => { if (!revisionEditable()) return; const values = revisionValues(); revisionDrafts.set(selectedId,{...newRevisionDraft(),values,dirty:true}); renderRevision(); $('revision-status').textContent = copy("legacy.draft-retained-against-current-revision-review-purpose"); });
$('revision-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!revisionEditable()) return;
  const values = revisionValues(), version = Number(values[1]), draft = revisionDrafts.get(selectedId);
  if (!draft || !values[0].trim() || values[0].length > 16000 || !values[2].trim() || values[2].length > 16000 || !Number.isSafeInteger(version) || version <= snapshot.value.criteria.version || !['manual-review/v1','bounded-text-review/v1'].includes(values[3])) { $('revision-status').textContent = copy("legacy.enter-purpose-success-criteria-and-a-positive"); return; }
  draft.values = values; draft.dirty = true;
  const missionId = selectedId, submittedFocus = document.activeElement;
  const body = {commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,purpose:values[0],criteria:{version,description:values[2],oracle:values[3]}};
  $('revision-status').textContent = copy("legacy.saving-mission-revision-no-work-is-restarted");
  const saved = await write('/missions/' + encodeURIComponent(missionId) + '/revision',body,missionId,copy("legacy.mission-revision-saved-earlier-work-retains-its"),{missionId,values:[...values],expectedRevision:body.expectedRevision});
  const confirmed = saved || confirmedOperations.has(operationKey({missionId,commandId:body.commandId}));
  if (snapshot?.value.id === missionId && selectedId === missionId) {
    if (confirmed && JSON.stringify(revisionValues()) === JSON.stringify(values)) { revisionDrafts.set(missionId,newRevisionDraft()); renderRevision(); }
    $('revision-status').textContent = confirmed ? copy("legacy.mission-revision-confirmed-only-future-work-uses") : copy("legacy.revision-was-not-confirmed-here-compare-current");
    if ($('revision-form').contains(submittedFocus)) { revisionFocus = {missionId,previous:submittedFocus,targetId:submittedFocus.id}; controls(); }
  }
});
function switchMemoryDraft(id) {
  if (memoryMission === id) return;
  if (memoryMission) memoryDrafts.set(memoryMission,memoryValues());
  memoryMission = id; const values = memoryDrafts.get(id) || ['', '1', '', ''];
  for (let i=0;i<memoryIds.length;i++) $(memoryIds[i]).value = values[i];
  $('memory-status').textContent = copy("legacy.save-a-new-id-at-version-1");
}
for (const id of memoryIds) $(id).addEventListener('input',() => { if (memoryMission) memoryDrafts.set(memoryMission,memoryValues()); });
function renderMemoryHistory() {
  const area = $('memory-history'), previous = document.activeElement, focused = area.contains(previous) ? previous?.id : null;
  area.replaceChildren(); $('memory-scope').textContent = copy("legacy.mission-scope-current-revision",{id:snapshot.value.id,scope:snapshot.value.scope,revision:snapshot.revision});
  const memories = snapshot.value.memories || [];
  if (!memories.length) area.append(element('p',copy("legacy.no-stored-mission-memory-future-work-has")));
  for (const memory of memories) {
    area.append(element('h4',copy("legacy.exact-version",{id:memory.id,version:memory.version})),element('p',copy("legacy.authority-2",{authority:memory.authority,value:(memory.effective ? copy("legacy.effective-for-new-work") : copy("legacy.historical-or-inactive-version"))}),'hint'));
    const content = element('pre',memory.content); content.id = 'memory-content-' + memory.id + '-' + memory.version; area.append(content,element('p',copy("legacy.stored-source",{source:memory.source}),'hint'));
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
  if (!shown.length) area.append(element('p',copy("legacy.no-recent-budget-changes-observed-here-this")));
  for (const {event,item} of shown) area.append(element('p',copy("legacy.work-limit-revision",{workId:item.command.workId,limit:item.command.limit,revision:event.revision})),element('p',copy("legacy.recorded-reason",{reason:item.command.reason})));
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
    budgetStatuses.set(draftKey,copy("legacy.confirmed-budget-change-for-work-no-execution",{workId:submission.workId})); budgetSubmissions.delete(key);
  }
  select.replaceChildren(); const prompt = element('option',copy("legacy.choose-exact-fresh-work")); prompt.value = ''; select.append(prompt);
  for (const work of snapshot.value.works.filter(budgetFresh)) { const option = element('option',work.title + ' · ' + work.id); option.value = work.id; select.append(option); }
  if (workId && !budgetFresh(budgetWork(workId))) { const stale = element('option',copy("legacy.is-no-longer-fresh-no-other-work",{workId:workId})); stale.value = workId; select.append(stale); }
  select.value = workId;
  const work = budgetWork(workId), key = budgetDraftKey(), draft = budgetDrafts.get(key);
  $('budget-limit').value = draft?.values[0] || ''; $('budget-reason').value = draft?.values[1] || '';
  $('budget-current').textContent = work ? copy("legacy.work-current-limit-unit-reserved-measured",{id:work.id,limit:work.budget.limit,value:(work.budget.unit || copy("legacy.host-units-unit-not-pinned-yet")),reserved:work.budget.reserved,value2:(work.budget.measured === null ? copy("legacy.unknown") : work.budget.measured)}) : copy("legacy.choose-work-to-inspect-its-actual-budget");
  $('budget-base').textContent = copy("legacy.current-revision",{revision:snapshot.revision,value:(draft ? copy("legacy.draft-based-on-revision",{baseRevision:draft.baseRevision,value:(draft.baseRevision !== snapshot.revision || draft.feed !== feedId ? copy("legacy.state-changed-review-this-exact-work-against") : '')}) : copy("legacy.no-work-selected"))});
  if (workId && !budgetFresh(work)) $('budget-base').textContent += copy("legacy.this-work-is-no-longer-eligible-no");
  $('budget-status').textContent = budgetStatuses.get(key) || copy("legacy.review-the-exact-work-changed-limit-and");
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
  const choice=recordTextChoice(work),state=recordTextReads.get(recordTextKey(choice)),details=element('details');details.append(workElement(work,'summary',copy("legacy.read-exact-accepted-text"),'record-text-summary'));
  details.append(element('p',copy("legacy.read-only-the-text-pinned-by-this"),'hint'));
  const row=element('div',undefined,'row'),read=workElement(work,'button',copy("legacy.read-exact-record-text"),'record-text-read'),cancel=workElement(work,'button',copy("legacy.cancel-text-read"),'record-text-cancel');read.type=cancel.type='button';read.disabled=work.record.artifact.kind!=='text'||!feedId||!currentRecordText(choice)||loading||!!state?.busy;cancel.disabled=!state?.busy;
  read.addEventListener('click',()=>readRecordText(choice));cancel.addEventListener('click',()=>cancelRecordText(choice));const prepare=workElement(work,'button',copy("legacy.prepare-exact-accepted-result-source-draft"),'record-source-prepare');prepare.type='button';prepare.disabled=true;prepare.addEventListener('click',()=>prepareRecordSource(choice));row.append(read,cancel,prepare);
  const status=workElement(work,'p',state?.message || (work.record.artifact.kind==='text'?copy("legacy.read-the-exact-stored-text-deliberately"):copy("legacy.this-accepted-artifact-is-not-utf-8")),'record-text-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const content=workElement(work,'pre',state?.content || '','record-text-content');content.setAttribute('role','region');content.setAttribute('aria-label',copy("legacy.exact-accepted-text-for",{id:work.id}));content.setAttribute('aria-busy',String(!!state?.busy));details.append(row,status,content);return details;
}
function recordTextControls() {
  for(const [key,state] of recordTextReads)if(!currentRecordText(state.choice)){state.sequence++;state.controller?.abort();recordTextReads.delete(key);const content=recordTextNode(state.choice.workId,'content');if(content){content.replaceChildren();content.setAttribute('aria-busy','false');}const status=recordTextNode(state.choice.workId,'status');if(status)status.textContent=copy("legacy.text-read-invalidated-by-context-change-choose");}
  if(!snapshot || snapshot.value.id!==selectedId)return;
  for(const work of snapshot.value.works){if(!work.record || work.acceptance!=='accepted')continue;const choice=recordTextChoice(work),state=recordTextReads.get(recordTextKey(choice)),read=recordTextNode(work.id,'read'),cancel=recordTextNode(work.id,'cancel');if(read)read.disabled=work.record.artifact.kind!=='text'||!feedId||!currentRecordText(choice)||loading||!!state?.busy;if(cancel)cancel.disabled=!state?.busy;}
}
function renderRecordText(choice) {
  const state=recordTextReads.get(recordTextKey(choice));if(!state || !currentRecordText(choice))return;
  const status=recordTextNode(choice.workId,'status'),content=recordTextNode(choice.workId,'content');if(status)status.textContent=state.message;if(content){content.textContent=state.content || '';content.setAttribute('aria-busy',String(state.busy));}recordTextControls();recordSourceControls();
}
function cancelRecordText(choice) {
  const state=recordTextReads.get(recordTextKey(choice));if(!state?.busy)return;const previous=document.activeElement;state.sequence++;state.controller?.abort();state.controller=null;state.busy=false;state.content='';state.message=copy("legacy.text-read-canceled-no-write-or-execution");renderRecordText(choice);if(previous===recordTextNode(choice.workId,'cancel'))restoreControlFocus(previous,'work-record-text-read-'+choice.workId);
}
async function validRecordText(body,choice) {
  if(!body || body.missionId!==choice.missionId || body.workId!==choice.workId || body.recordId!==choice.recordId || body.recordChecksum!==choice.recordChecksum || body.feedId!==choice.feedId || body.criteriaVersion!==choice.criteriaVersion || body.evidenceClass!==choice.evidenceClass || !Number.isSafeInteger(body.revision)||body.revision<1 || body.artifact?.id!==choice.artifactId || body.artifact.kind!=='text' || body.artifact.version!==choice.artifactVersion || body.artifact.sha256!==choice.artifactSha256 || typeof body.content!=='string' || !body.content.isWellFormed() || !body.content.length || !Number.isSafeInteger(body.byteLength))return false;
  const bytes=new TextEncoder().encode(body.content);if(bytes.length>32768 || bytes.length!==body.byteLength || !crypto.subtle)return false;const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('')===choice.artifactSha256;
}
async function readRecordText(choice) {
  recordTextControls();const button=recordTextNode(choice.workId,'read');if(!button || button.disabled || !currentRecordText(choice))return;
  const key=recordTextKey(choice),old=recordTextReads.get(key);old?.controller?.abort();const state={choice,sequence:(old?.sequence || 0)+1,controller:new AbortController(),busy:true,content:'',message:copy("legacy.reading-and-checking-exact-accepted-text")},sequence=state.sequence,submittedFocus=document.activeElement;recordTextReads.set(key,state);renderRecordText(choice);const timer=setTimeout(()=>state.controller?.abort(),15000);
  try{
    const path='/missions/'+encodeURIComponent(choice.missionId)+'/record-artifact?work='+encodeURIComponent(choice.workId)+'&record='+encodeURIComponent(choice.recordId)+'&version='+choice.artifactVersion+'&sha256='+choice.artifactSha256;
    const {response,body}=await request(path,{scope:'record-text:'+key,headers:{'X-Massion-Feed':choice.feedId},signal:state.controller.signal});
    if(recordTextReads.get(key)!==state || sequence!==state.sequence || !currentRecordText(choice))return;
    if(!response.ok)throw new Error(body?.error || copy("legacy.exact-text-read-unavailable"));if(!await validRecordText(body,choice))throw new Error(copy("legacy.text-reply-failed-exact-record-feed-utf"));
    if(recordTextReads.get(key)!==state || sequence!==state.sequence || !currentRecordText(choice))return;
    state.content=body.content;state.message=copy("legacy.exact-stored-text-verified-against-record-artifact",{recordId:choice.recordId,artifactVersion:choice.artifactVersion,artifactSha256:choice.artifactSha256,byteLength:body.byteLength,revision:body.revision,evidenceClass:body.evidenceClass});
  }catch(error){if(recordTextReads.get(key)===state && sequence===state.sequence && currentRecordText(choice)){state.content='';state.message=copy("legacy.read-not-verified-retry-deliberately-no-other",{value:(error?.message || copy("ui.panel.unavailable"))});}}
  finally{clearTimeout(timer);if(recordTextReads.get(key)===state && sequence===state.sequence && currentRecordText(choice)){state.controller=null;state.busy=false;renderRecordText(choice);if(submittedFocus===button)restoreControlFocus(submittedFocus,'work-record-text-read-'+choice.workId);}}
}
const growthCreateDrafts=new Map(),growthCaseDrafts=new Map();let growthCreateMission='',growthCreateFocus=null;
const growthCreateIds=['growth-create-id','growth-create-baseline','growth-create-memory','growth-create-version','growth-create-content','growth-create-source','growth-create-counter'];
function creationValues(){return growthCreateIds.map(id=>$(id).value);}
function renderGrowthCreation(){
 if(growthCreateMission!==selectedId){growthCreateMission=selectedId;const draft=growthCreateDrafts.get(selectedId);growthCreateIds.forEach((id,i)=>$(id).value=draft?.values[i] || '');$('growth-evaluate-cases').value=growthCaseDrafts.get(selectedId)||'';$('growth-create-status').textContent=copy("legacy.private-proposal-draft-restored-review-exact-versions");$('growth-evaluate-status').textContent=copy("legacy.choose-an-unevaluated-proposal-and-your-bounded");}
 const draft=growthCreateDrafts.get(selectedId);$('growth-create-base').textContent=copy("legacy.current-revision",{revision:snapshot.revision,value:(draft?copy("legacy.draft-revision",{revision:draft.revision,value:(draft.revision!==snapshot.revision || draft.feed!==feedId?copy("legacy.state-changed-review-deliberately"):'')}):copy("legacy.no-draft-revision"))});
}
function growthCreationControls(){
 const ready=revisionEditable(),previous=document.activeElement;
 for(const id of ['growth-create-fields','growth-evaluate-fields']){if(!$(id).disabled && $(id).contains(previous))growthCreateFocus={missionId:selectedId,previous,targetId:previous.id};$(id).disabled=!ready;}
 $('growth-evaluate-submit').disabled=!ready || selectedGrowth()?.status!=='proposed' || !growthMatches(selectedGrowth(),growthDrafts.get(selectedId));
 if(growthCreateFocus && ready){const focus=growthCreateFocus;growthCreateFocus=null;if(focus.missionId===selectedId)restoreControlFocus(focus.previous,focus.targetId);}
}
for(const id of growthCreateIds)for(const event of ['input','change'])$(id).addEventListener(event,()=>{if(!revisionEditable())return;const old=growthCreateDrafts.get(selectedId);growthCreateDrafts.set(selectedId,{values:creationValues(),revision:old?.revision || snapshot.revision,feed:old?.feed || feedId});renderGrowthCreation();});
$('growth-create-review').addEventListener('click',()=>{if(!revisionEditable())return;growthCreateDrafts.set(selectedId,{values:creationValues(),revision:snapshot.revision,feed:feedId});renderGrowthCreation();$('growth-create-status').textContent=copy("legacy.exact-draft-retained-against-current-revision-no");});
$('growth-evaluate-cases').addEventListener('input',()=>{growthCaseDrafts.set(selectedId,$('growth-evaluate-cases').value);});
$('growth-create-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!revisionEditable())return;const missionId=selectedId,values=creationValues(),draft=growthCreateDrafts.get(selectedId),focus=document.activeElement;
 if(!draft || draft.feed!==feedId){$('growth-create-status').textContent=copy("legacy.review-this-exact-draft-at-current-revision");return;}
 const body={commandId:crypto.randomUUID(),expectedRevision:draft.revision,growthId:values[0],baseline:values[1],candidate:{id:values[2],version:Number(values[3]),content:values[4],source:values[5]},counterevidence:values[6]};if(!commandBodyFits(body)){$('growth-create-status').textContent=copy("legacy.request-exceeds-bounded-utf-8-size-shorten");return;}
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/growth-proposals',body,missionId,copy("legacy.inactive-candidate-and-proposal-saved-evaluation-and"));if(selectedId===missionId){$('growth-create-status').textContent=saved?copy("legacy.proposal-confirmed-original-draft-retained-choose-the"):copy("legacy.proposal-not-confirmed-here-draft-and-original");restoreControlFocus(focus,focus.id);}
});
$('growth-evaluate-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!revisionEditable())return;const g=selectedGrowth(),draft=growthDrafts.get(selectedId),missionId=selectedId,focus=document.activeElement;if(g?.status!=='proposed'||!growthMatches(g,draft))return;let cases;try{cases=JSON.parse($('growth-evaluate-cases').value);}catch{$('growth-evaluate-status').textContent=copy("legacy.enter-bounded-input-orders-as-valid-json");return;}
 const body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,growthId:g.id,baseline:draft.baseline,candidate:draft.candidate,oracle:'rounding-calculation/v1',cases};if(!commandBodyFits(body)){$('growth-evaluate-status').textContent=copy("legacy.evaluation-request-exceeds-utf-8-bound");return;}
 const saved=await write('/missions/'+encodeURIComponent(missionId)+'/growth-evaluation',body,missionId,copy("legacy.local-calculation-evidence-recorded-no-model-quality"),null,null,null,{missionId,expectedRevision:body.expectedRevision,draft,action:'evaluate'});if(selectedId===missionId){$('growth-evaluate-status').textContent=saved?copy("legacy.independent-bounded-calculation-confirmed-inspect-evidence-and"):copy("legacy.evaluation-not-confirmed-here-inputs-and-exact");restoreControlFocus(focus,focus.id);}
});

function selectedGrowth() { return snapshot?.value.id === selectedId ? (snapshot.value.growth || []).find(g => g.id === $('growth-target').value) : null; }
function growthDraft(g) { return {target:g.id,baseline:g.baseline,candidate:g.candidate,action:g.status==='adopted'?'revert':'adopt',baseRevision:snapshot.revision,feed:feedId,message:copy("legacy.exact-proposal-selected-inspect-evidence-and-memory")}; }
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
    if(growthDrafts.get(selectedId)===submission.draft)submission.draft.message=copy("legacy.confirmed-for-existing-work-pins-remain-review",{action:submission.action,target:submission.draft.target});
    growthSubmissions.delete(key);
  }
  const draft=growthDrafts.get(selectedId),select=$('growth-target'),previous=document.activeElement,area=$('growth-evidence'),focused=area.contains(previous)?previous?.id:null;
  select.replaceChildren();const prompt=element('option',copy("legacy.choose-exact-proposal"));prompt.value='';select.append(prompt);
  for(const g of snapshot.value.growth || []){const option=element('option',g.id+' · '+g.status+' · '+g.candidate);option.value=g.id;select.append(option);}
  if(draft && !(snapshot.value.growth || []).some(g=>g.id===draft.target)){const missing=element('option',copy("legacy.unavailable-no-replacement-selected",{target:draft.target}));missing.value=draft.target;select.append(missing);}
  select.value=draft?.target || '';const g=selectedGrowth();area.replaceChildren();
  if(g){
    area.append(element('p',copy("legacy.proposal-target-status-proposer",{id:g.id,target:g.target,status:g.status,proposer:g.proposer})));
    for(const [label,ref] of [[copy("legacy.baseline"),g.baseline],[copy("legacy.candidate"),g.candidate]]){
      area.append(element('h4',copy("legacy.exact-memory",{label:label,ref:ref})));const matches=(snapshot.value.memories || []).filter(m=>m.id+'@'+m.version===ref && m.scope===snapshot.value.scope);
      if(matches.length!==1){area.append(element('p',copy("legacy.exact-scoped-memory-unavailable-current-versions-are"),'warning'));continue;}
      const m=matches[0];area.append(element('p',copy("legacy.scope-authority-effective",{scope:m.scope,authority:m.authority,effective:m.effective})),element('pre',m.content),element('p',copy("legacy.stored-source",{source:m.source}),'hint'));
    }
    area.append(element('h4',copy("legacy.counterevidence")),element('pre',g.counterevidence),element('p',copy("legacy.recorded-independent-evaluator",{value:(g.evaluator || copy("settings.text.03"))})));
    if(g.scores)area.append(element('p',copy("legacy.recorded-baseline-score-candidate-score",{baseline:g.scores.baseline,candidate:g.scores.candidate})),element('h4',copy("legacy.stored-held-out-evaluation-evidence")),element('pre',g.scores.heldOut));
    else area.append(element('p',copy("legacy.no-stored-evaluation-adoption-is-unavailable")));
    if(g.previousEffective)area.append(element('p',copy("legacy.effective-pins-recorded-before-adoption",{value:g.previousEffective.join(', ')})));
    if(g.observation)area.append(element('p',copy("legacy.stored-later-observation-work-metric",{workId:g.observation.workId,metric:g.observation.metric})));
  }else area.append(element('p',copy("legacy.choose-an-exact-stored-proposal-no-evaluation")));
  $('growth-base').textContent=copy("legacy.current-mission-revision",{revision:snapshot.revision,value:(draft?copy("legacy.reviewed-revision-proposal-baseline-candidate-action",{baseRevision:draft.baseRevision,target:draft.target,baseline:draft.baseline,candidate:draft.candidate,action:draft.action,value:(draft.baseRevision!==snapshot.revision || draft.feed!==feedId?copy("legacy.state-changed-review-current-evidence-deliberately-original"):'')}):copy("legacy.no-proposal-selected"))});
  $('growth-status').textContent=draft?.message || copy("legacy.choose-a-stored-proposal-to-inspect-its");growthControls();growthCreationControls();if(focused)restoreControlFocus(previous,focused);
}
$('growth-target').addEventListener('change',()=>{const g=selectedGrowth();if(g)growthDrafts.set(selectedId,growthDraft(g));else growthDrafts.delete(selectedId);renderGrowth();});
$('review-growth').addEventListener('click',()=>{if(!revisionEditable())return;const g=selectedGrowth();if(!g)return;growthDrafts.set(selectedId,growthDraft(g));renderGrowth();$('growth-status').textContent=copy("legacy.exact-proposal-and-memory-versions-retained-at");});
$('cancel-growth').addEventListener('click',()=>{if(!revisionEditable())return;growthDrafts.delete(selectedId);renderGrowth();$('growth-status').textContent=copy("legacy.private-selection-cleared-no-adoption-or-revert");});
async function submitGrowth(action) {
  if(!revisionEditable())return;const g=selectedGrowth(),draft=growthDrafts.get(selectedId);if(!growthMatches(g,draft) || draft.action!==action || !growthEligible(g,action))return;
  const missionId=selectedId,submittedFocus=document.activeElement,body={commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,growthId:draft.target,baseline:draft.baseline,candidate:draft.candidate,action};
  draft.message=copy("legacy.awaiting-durable-receipt-for-exact-proposal-no",{action:action,target:draft.target});renderGrowth();
  const saved=await write('/missions/'+encodeURIComponent(missionId)+'/growth',body,missionId,copy("legacy.exact-growth-confirmed-existing-work-pins-retained",{action:action}),null,null,null,{missionId,action,expectedRevision:body.expectedRevision,draft});
  if(snapshot?.value.id===missionId && selectedId===missionId){
    if(growthDrafts.get(missionId)===draft && !saved && !confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))draft.message=copy("legacy.action-not-confirmed-here-exact-proposal-memory");
    renderGrowth();if($('growth-form').contains(submittedFocus)){growthFocus={missionId,previous:submittedFocus,targetId:submittedFocus.id};controls();}
  }
}
$('adopt-growth').addEventListener('click',()=>submitGrowth('adopt'));
$('revert-growth').addEventListener('click',()=>submitGrowth('revert'));
function conversationChoice(){return snapshot?.value.id===selectedId?($('conversation-scope').value==='mission'?{id:null,title:copy("legacy.mission-discussion")}:snapshot.value.works.find(work=>work.id===$('conversation-target').value)):null;}
function conversationDraft(work){const key=instructionKey(selectedId,work.id);let draft=conversationDrafts.get(key);if(!draft){draft={text:'',replyTo:null,baseRevision:snapshot.revision,feed:feedId};conversationDrafts.set(key,draft);}return draft;}
function conversationCurrent(work,draft){return !!work&&draft&&snapshot?.value.id===selectedId&&draft.baseRevision===snapshot.revision&&draft.feed===feedId&&(draft.replyTo===null||(snapshot.value.conversations||[]).find(c=>c.workId===work.id)?.messages.some(message=>message.id===draft.replyTo));}
function conversationControls(){const work=conversationChoice(),draft=work?conversationDrafts.get(instructionKey(selectedId,work.id)):null,editable=revisionEditable(),ready=editable&&!!work;$('conversation-fields').disabled=!editable;$('conversation-target').disabled=!editable||$('conversation-scope').value==='mission';for(const id of ['conversation-text','conversation-reply'])$(id).disabled=!ready;$('conversation-send').disabled=!ready||!conversationCurrent(work,draft)||!draft.text.trim()||new TextEncoder().encode(draft.text).length>4096;$('conversation-review').disabled=!ready;$('conversation-cancel').disabled=!ready;}
function renderConversation(){
 const focus=document.activeElement?.id,mission=snapshot?.value;if(!mission||mission.id!==selectedId){$('conversation-target').replaceChildren();$('conversation-messages').replaceChildren();conversationControls();return;}
 $('conversation-scope').value=conversationScopes.get(selectedId)||'work';const target=$('conversation-target'),selected=conversationSelections.get(selectedId)||'';target.replaceChildren();const placeholder=element('option',copy("legacy.choose-exact-work-conversation"));placeholder.value='';target.append(placeholder);for(const work of mission.works){const option=element('option',work.id+' · '+work.title+' · '+work.execution);option.value=work.id;target.append(option);}target.value=mission.works.some(w=>w.id===selected)?selected:'';
 const work=conversationChoice(),area=$('conversation-messages'),reply=$('conversation-reply');area.replaceChildren();reply.replaceChildren();const newMessage=element('option',copy("legacy.new-message"));newMessage.value='';reply.append(newMessage);
 if(work){const thread=(mission.conversations||[]).find(c=>c.workId===work.id),draft=conversationDraft(work);area.append(element('p',thread?copy("legacy.conversation-100-stored-messages",{id:thread.id,length:thread.messages.length}):copy("legacy.no-saved-conversation-for-this-selection-yet"),'hint'));for(const message of thread?.messages||[]){area.append(element('p','#'+message.ordinal+' · '+message.id+' · '+message.role+' '+message.actorId+(message.replyTo?copy("legacy.reply-to",{replyTo:message.replyTo}):''),'hint'),element('pre',message.text));const option=element('option','#'+message.ordinal+' · '+message.id);option.value=message.id;reply.append(option);}if(draft.replyTo&&!(thread?.messages||[]).some(message=>message.id===draft.replyTo)){const missing=element('option',copy("legacy.original-reply-target-unavailable",{replyTo:draft.replyTo}));missing.value=draft.replyTo;reply.append(missing);}reply.value=draft.replyTo||'';$('conversation-text').value=draft.text;$('conversation-base').textContent=copy("legacy.current-revision-draft-reviewed-at",{value:(work.id===null?copy("legacy.mission-discussion"):copy("legacy.work",{id:work.id})),revision:snapshot.revision,baseRevision:draft.baseRevision,value2:(conversationCurrent(work,draft)?'':copy("legacy.state-or-database-changed-review-the-retained"))});$('conversation-status').textContent=conversationStatuses.get(instructionKey(selectedId,work.id))||copy("legacy.saved-discussion-is-separate-from-work-instructions");
 }else{$('conversation-text').value='';$('conversation-base').textContent=copy("legacy.choose-an-exact-work-message-drafts-are");$('conversation-status').textContent=copy("legacy.choose-work-to-inspect-its-actual-budget");}
 conversationControls();if(focus&&$('conversation-form').contains($(focus)))restoreControlFocus(document.activeElement,focus);
}
$('conversation-scope').addEventListener('change',()=>{if(!revisionEditable())return;conversationScopes.set(selectedId,$('conversation-scope').value);renderConversation();});
$('conversation-target').addEventListener('change',()=>{conversationSelections.set(selectedId,$('conversation-target').value);renderConversation();});
for(const [id,events] of [['conversation-text',['input']],['conversation-reply',['input','change']]])for(const name of events)$(id).addEventListener(name,()=>{const work=conversationChoice(),workId=work?work.id:conversationSelections.get(selectedId),key=instructionKey(selectedId,workId),previous=work?conversationDraft(work):conversationDrafts.get(key);if(!previous)return;conversationDrafts.set(key,{...previous,text:$('conversation-text').value,replyTo:$('conversation-reply').value||null});conversationControls();});
$('conversation-review').addEventListener('click',()=>{if(!revisionEditable())return;const work=conversationChoice();if(!work)return;const draft=conversationDraft(work);conversationDrafts.set(instructionKey(selectedId,work.id),{...draft,baseRevision:snapshot.revision,feed:feedId});conversationStatuses.set(instructionKey(selectedId,work.id),copy("legacy.draft-retained-at-the-current-discussion-and"));renderConversation();});
$('conversation-cancel').addEventListener('click',()=>{if(!revisionEditable())return;const work=conversationChoice();if(!work)return;conversationDrafts.delete(instructionKey(selectedId,work.id));conversationStatuses.set(instructionKey(selectedId,work.id),copy("legacy.private-draft-cleared-stored-messages-remain-original"));renderConversation();});
$('conversation-form').addEventListener('submit',async event=>{
 event.preventDefault();if(!revisionEditable())return;const work=conversationChoice(),draft=work?conversationDraft(work):null;if(!conversationCurrent(work,draft)||!draft.text.trim()||new TextEncoder().encode(draft.text).length>4096)return;
 const missionId=selectedId,workId=work.id,key=instructionKey(missionId,workId),messageId=crypto.randomUUID(),submission={missionId,workId,draft,text:draft.text,replyTo:draft.replyTo},body={commandId:messageId,messageId,expectedRevision:draft.baseRevision,...(workId===null?{}:{workId}),text:draft.text,replyTo:draft.replyTo},focus=document.activeElement;
 conversationStatuses.set(key,copy("legacy.saving-this-exact-owner-message-once-awaiting"));const saved=await write('/missions/'+encodeURIComponent(missionId)+(workId===null?'/mission-message':'/work-message'),body,missionId,copy("legacy.owner-conversation-message-saved-no-execution-requested"),null,null,null,null,null,null,null,null,submission);
 if(!saved&&!confirmedOperations.has(operationKey({missionId,commandId:body.commandId})))conversationStatuses.set(key,copy("legacy.message-not-confirmed-here-exact-discussion-text"));
 if(snapshot?.value.id===missionId&&selectedId===missionId){renderConversation();if(focus?.id)restoreControlFocus(focus,focus.id==='conversation-send'&&$('conversation-send').disabled?'conversation-text':focus.id);}
});

function currentStoredBudget(choice) {
  return !reconnectRequired && snapshot?.value.id === choice.missionId && selectedId === choice.missionId && feedId === choice.feedId && connectionEpoch === choice.epoch && $('stored-budget-target').value === choice.workId;
}
function cancelStoredBudget(clear = false) {
  storedBudgetSequence++; storedBudgetController?.abort(); storedBudgetController = null;
  if (clear) { storedBudgetState = null; $('stored-budget-results').replaceChildren(); $('stored-budget-status').textContent = copy("legacy.choose-work-then-read-its-stored-budget"); }
  else if (storedBudgetState) { storedBudgetState.busy = false; storedBudgetState.message = copy("legacy.history-read-canceled-earlier-pages-and-your"); }
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
  select.replaceChildren(); const prompt = element('option',copy("legacy.choose-exact-work")); prompt.value = ''; select.append(prompt);
  for (const work of snapshot.value.works) { const option = element('option',work.title + ' · ' + work.id); option.value = work.id; select.append(option); }
  if (intended && !snapshot.value.works.some(work => work.id === intended)) { const stale = element('option',copy("legacy.is-unavailable-no-other-work-is-substituted",{intended:intended})); stale.value = intended; select.append(stale); }
  select.value = intended; storedBudgetControls();
  if (!storedBudgetState) return;
  const state = storedBudgetState, area = $('stored-budget-results'), previous = document.activeElement, focused = area.contains(previous) ? previous?.id : null;
  area.replaceChildren();
  if (state.loaded) {
    area.append(element('p',copy("legacy.mission-work-feed-read-through-of-frozen",{missionId:state.missionId,workId:state.workId,feedId:state.feedId,cursor:state.cursor,through:state.through}),'hint'));
    if (!state.changes.length) area.append(element('p',copy("legacy.no-matching-budget-changes-in-the-scanned",{value:(state.complete ? copy("legacy.frozen-boundary-reached") : copy("legacy.more-pages-remain-this-is-not-complete"))})));
    for (const change of state.changes) { area.append(element('p',copy("legacy.cursor-revision-command-actor-recorded-limit",{cursor:change.cursor,revision:change.revision,commandId:change.commandId,actor:change.actor,limit:change.limit}))); const reason = element('pre',copy("legacy.recorded-reason",{reason:change.reason})); reason.id = 'stored-budget-reason-' + change.cursor; area.append(reason); }
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
  state.busy = true; state.message = copy("legacy.reading-stored-history-for-exact-work-your"); renderStoredBudget();
  const path = '/missions/' + encodeURIComponent(choice.missionId) + '/work-budget-history?work=' + encodeURIComponent(choice.workId) + '&limit=20&after=' + choice.cursor + (choice.through === null ? '' : '&through=' + choice.through);
  const timer = setTimeout(() => controller.abort(),15000);
  try {
    const {response,body} = await request(path,{scope:'budget-history',headers:{'X-Massion-Feed':choice.feedId},signal:controller.signal});
    if (sequence !== storedBudgetSequence || !currentStoredBudget(choice)) return;
    if (!response.ok) throw new Error(copy("legacy.history-read-failed"));
    if (!validStoredBudgetPage(body,choice)) throw new Error(copy("legacy.history-reply-did-not-match-the-exact"));
    if (state.changes.length + body.changes.length > 200) { state.capped = true; throw new Error(copy("legacy.this-view-is-limited-to-200-changes")); }
    state.changes.push(...body.changes); state.cursor = body.cursor; state.through = body.through; state.loaded = true; state.complete = body.complete;
    state.message = body.complete ? copy("legacy.frozen-history-boundary-reached-new-changes-need") : copy("legacy.page-read-more-pages-remain-even-when");
  } catch (error) {
    if (sequence === storedBudgetSequence && currentStoredBudget(choice)) state.message = copy("legacy.earlier-pages-and-your-budget-draft-remain",{value:(error?.message || copy("legacy.history-read-unavailable"))});
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
  if (clear) { storedInterventionState = null; $('stored-intervention-results').replaceChildren(); $('stored-intervention-status').textContent = copy("legacy.choose-work-then-read-its-stored-owner"); }
  else if (storedInterventionState) { storedInterventionState.busy = false; storedInterventionState.message = copy("legacy.history-read-canceled-earlier-pages-and-your"); }
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
  select.replaceChildren(); const prompt = element('option',copy("legacy.choose-exact-work")); prompt.value = ''; select.append(prompt);
  for (const work of snapshot.value.works) { const option = element('option',work.title + ' · ' + work.id); option.value = work.id; select.append(option); }
  if (intended && !snapshot.value.works.some(work => work.id === intended)) { const stale = element('option',copy("legacy.is-unavailable-no-other-work-is-substituted",{intended:intended})); stale.value = intended; select.append(stale); }
  select.value = intended; storedInterventionControls();
  if (!storedInterventionState) return;
  const state = storedInterventionState, area = $('stored-intervention-results'), previous = document.activeElement, focused = area.contains(previous) ? previous?.id : null;
  area.replaceChildren();
  if (state.loaded) {
    area.append(element('p',copy("legacy.mission-work-feed-read-through-of-frozen",{missionId:state.missionId,workId:state.workId,feedId:state.feedId,cursor:state.cursor,through:state.through}),'hint'));
    if (!state.changes.length) area.append(element('p',copy("legacy.no-matching-owner-interventions-in-the-scanned",{value:(state.complete ? copy("legacy.frozen-boundary-reached") : copy("legacy.more-pages-remain-this-is-not-complete"))})));
    for (const change of state.changes) { area.append(element('p',copy("legacy.cursor-resulting-mission-revision-command-actor-action",{cursor:change.cursor,revision:change.revision,commandId:change.commandId,actor:change.actor,action:change.action}))); if(change.runId)area.append(element('p',copy("legacy.exact-original-run",{runId:change.runId}))); const input = element('pre',change.action==='steer' ? copy("legacy.recorded-instruction",{instruction:change.instruction}) : change.action==='close-expired-runtime' ? copy("legacy.recorded-expired-run-closure-reason",{reason:change.reason}) : change.action==='quarantine-runtime' ? copy("legacy.recorded-quarantine-reason",{reason:change.reason}) : copy("legacy.cancellation-intent-recorded-external-stop-is-not")); input.id = 'stored-intervention-input-' + change.cursor; area.append(input); }
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
  state.busy = true; state.message = copy("legacy.reading-stored-history-for-exact-work-your"); renderStoredIntervention();
  const path = '/missions/' + encodeURIComponent(choice.missionId) + '/work-intervention-history?work=' + encodeURIComponent(choice.workId) + '&limit=20&after=' + choice.cursor + (choice.through === null ? '' : '&through=' + choice.through);
  const timer = setTimeout(() => controller.abort(),15000);
  try {
    const {response,body} = await request(path,{scope:'intervention-history',headers:{'X-Massion-Feed':choice.feedId},signal:controller.signal});
    if (sequence !== storedInterventionSequence || !currentStoredIntervention(choice)) return;
    if (!response.ok) throw new Error(copy("legacy.history-read-failed"));
    if (!validStoredInterventionPage(body,choice)) throw new Error(copy("legacy.history-reply-did-not-match-the-exact"));
    if (state.changes.length + body.changes.length > 200) { state.capped = true; throw new Error(copy("legacy.this-view-is-limited-to-200-changes")); }
    state.changes.push(...body.changes); state.cursor = body.cursor; state.through = body.through; state.loaded = true; state.complete = body.complete;
    state.message = body.complete ? copy("legacy.frozen-history-boundary-reached-new-changes-need") : copy("legacy.page-read-more-pages-remain-even-when");
  } catch (error) {
    if (sequence === storedInterventionSequence && currentStoredIntervention(choice)) state.message = copy("legacy.earlier-pages-and-your-budget-draft-remain",{value:(error?.message || copy("legacy.history-read-unavailable"))});
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
  const key = budgetDraftKey(); budgetDrafts.set(key,{values:budgetValues(),baseRevision:snapshot.revision,feed:feedId}); budgetStatuses.set(key,copy("legacy.exact-work-reviewed-against-current-state-no")); renderBudget(); controls();
});
$('cancel-budget').addEventListener('click',() => {
  if (!revisionEditable()) return; const key = budgetDraftKey(); budgetDrafts.set(key,freshBudgetDraft(budgetWork())); budgetStatuses.set(key,copy("legacy.budget-draft-canceled-no-command-was-sent")); renderBudget(); controls();
});
$('budget-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!revisionEditable()) return;
  const missionId = selectedId, work = budgetWork(), values = budgetValues(), key = budgetDraftKey(), draft = budgetDrafts.get(key), limit = Number(values[0]);
  if (!budgetFresh(work) || !values[0].trim() || !Number.isFinite(limit) || limit < work.budget.reserved || limit < 0 || limit === work.budget.limit || !values[1].trim() || values[1].length > 16000 || !draft?.baseRevision || draft.feed !== feedId) { budgetStatuses.set(key,copy("legacy.choose-exact-fresh-work-a-changed-finite")); $('budget-status').textContent = budgetStatuses.get(key); return; }
  const body = {commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,workId:work.id,limit,reason:values[1]};
  if (!commandBodyFits(body)) { budgetStatuses.set(key,copy("legacy.request-exceeds-32-kib-utf-8-shorten")); $('budget-status').textContent = budgetStatuses.get(key); return; }
  const submittedFocus = document.activeElement; budgetStatuses.set(key,copy("legacy.awaiting-a-durable-budget-receipt-no-execution")); $('budget-status').textContent = budgetStatuses.get(key);
  const saved = await write('/missions/' + encodeURIComponent(missionId) + '/work-budget',body,missionId,copy("legacy.owner-budget-change-confirmed-no-execution-requested"),null,null,{missionId,workId:work.id,values:[...values],expectedRevision:body.expectedRevision});
  if (snapshot?.value.id === missionId && selectedId === missionId) {
    if (saved || confirmedOperations.has(operationKey({missionId,commandId:body.commandId}))) renderBudget();
    else { budgetStatuses.set(key,copy("legacy.budget-change-not-confirmed-here-exact-work")); $('budget-status').textContent = budgetStatuses.get(key); }
    if ($('budget-form').contains(submittedFocus)) { budgetFocus = {missionId,previous:submittedFocus,targetId:submittedFocus.id}; controls(); }
  }
});

function retirementValues() { return [$('retirement-target').value,$('retirement-reason').value]; }
function retirementLabel(value) { try { const target = JSON.parse(value); if (Array.isArray(target) && target.length === 2) return copy("legacy.version",{value:String(target[0]),value2:String(target[1])}); } catch {} return copy("legacy.invalid-exact-selection"); }
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
    $('retirement-status').textContent = copy("legacy.choose-an-exact-version-and-review-what");
  }
  for (const [key, submission] of retirementSubmissions) {
    if (submission.missionId !== missionId || !confirmedOperations.has(key) || snapshot.revision <= submission.expectedRevision) continue;
    if (JSON.stringify(retirementValues()) === JSON.stringify(submission.values)) { retirementDrafts.set(missionId,freshRetirementDraft()); $('retirement-target').value = ''; $('retirement-reason').value = ''; }
    retirementSubmissions.delete(key);
    $('retirement-status').textContent = copy("legacy.confirmed-stopped-for-future-work-earlier-work",{label:submission.label});
  }
  const draft = retirementDrafts.get(missionId), select = $('retirement-target');
  select.replaceChildren(); const prompt = element('option',copy("legacy.choose-an-exact-active-explicit-version")); prompt.value = ''; select.append(prompt);
  for (const memory of snapshot.value.memories || []) {
    if (memory.authority !== 'explicit' || memory.effective !== true || memory.scope !== snapshot.value.scope) continue;
    const option = element('option',copy("legacy.exact-version",{id:memory.id,version:memory.version})); option.value = JSON.stringify([memory.id,memory.version]); select.append(option);
  }
  if (draft.values[0] && !activeRetirementTarget(draft.values[0])) { const stale = element('option',copy("legacy.previously-selected-is-no-longer-active-choose",{value:retirementLabel(draft.values[0])})); stale.value = draft.values[0]; select.append(stale); }
  select.value = draft.values[0];
  $('retirement-base').textContent = copy("legacy.current-revision",{revision:snapshot.revision,value:(draft.baseRevision === null ? copy("legacy.no-target-selected") : copy("legacy.draft-based-on-revision",{baseRevision:draft.baseRevision,value:(draft.baseRevision !== snapshot.revision || draft.feed !== feedId ? copy("legacy.state-changed-review-the-exact-current-target") : '')}))});
  if (draft.values[0] && !activeRetirementTarget(draft.values[0])) $('retirement-base').textContent += copy("legacy.the-selected-version-is-inactive-or-unavailable");
  $('review-retirement').disabled = !activeRetirementTarget(draft.values[0]);
}
$('retirement-target').addEventListener('change',() => {
  if (!revisionEditable()) return;
  const active = activeRetirementTarget($('retirement-target').value);
  retirementDrafts.set(selectedId,{values:retirementValues(),baseRevision:active ? snapshot.revision : null,feed:feedId}); renderRetirement();
  if (!active) { $('retirement-status').textContent = copy("legacy.no-active-version-selected-no-command-was"); return; }
  $('retirement-status').textContent = copy("legacy.exact-target-selected-review-the-reason-original");
});
$('retirement-reason').addEventListener('input',() => { const draft = retirementDrafts.get(retirementMission); if (draft) draft.values = retirementValues(); });
$('review-retirement').addEventListener('click',() => {
  if (!revisionEditable() || !activeRetirementTarget($('retirement-target').value)) return;
  retirementDrafts.set(selectedId,{values:retirementValues(),baseRevision:snapshot.revision,feed:feedId}); renderRetirement();
  $('retirement-status').textContent = copy("legacy.exact-target-retained-against-current-revision-review");
});
$('cancel-retirement').addEventListener('click',() => { if (!revisionEditable()) return; retirementDrafts.set(selectedId,freshRetirementDraft()); $('retirement-target').value = ''; $('retirement-reason').value = ''; renderRetirement(); $('retirement-status').textContent = copy("legacy.stop-draft-canceled-no-command-was-sent"); });
$('retirement-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!revisionEditable()) return;
  const missionId = selectedId, values = retirementValues(), draft = retirementDrafts.get(missionId), target = activeRetirementTarget(values[0]);
  if (!target || !values[1].trim() || values[1].length > 16000 || !draft?.baseRevision || draft.feed !== feedId) { $('retirement-status').textContent = copy("legacy.choose-an-exact-active-explicit-version-and"); return; }
  const body = {commandId:crypto.randomUUID(),expectedRevision:draft.baseRevision,memoryId:target.id,version:target.version,reason:values[1]}, label = copy("legacy.exact-version",{id:target.id,version:target.version});
  if (!commandBodyFits(body)) { $('retirement-status').textContent = copy("legacy.request-exceeds-32-kib-utf-8-shorten"); return; }
  const submittedFocus = document.activeElement; $('retirement-status').textContent = copy("legacy.stopping-for-future-work-awaiting-a-durable",{label:label});
  const saved = await write('/missions/' + encodeURIComponent(missionId) + '/memory-retirement',body,missionId,copy("legacy.exact-memory-version-stopped-for-future-work"),null,{missionId,values:[...values],expectedRevision:body.expectedRevision,label});
  if (snapshot?.value.id === missionId && selectedId === missionId) {
    if (saved || confirmedOperations.has(operationKey({missionId,commandId:body.commandId}))) renderRetirement();
    else $('retirement-status').textContent = copy("legacy.stop-request-not-confirmed-here-your-exact");
    if ($('retirement-form').contains(submittedFocus)) { retirementFocus = {missionId,previous:submittedFocus,targetId:submittedFocus.id}; controls(); }
  }
});
$('memory-form').addEventListener('submit',async event => {
  event.preventDefault(); if (!snapshot || snapshot.value.id !== selectedId || reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const values = memoryValues(), id = values[0].trim(), version = Number(values[1]);
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(id) || !Number.isSafeInteger(version) || version < 1 || !values[2].trim() || !values[3].trim()) { $('memory-status').textContent = copy("legacy.enter-a-valid-id-positive-integer-version"); return; }
  const missionId = snapshot.value.id, submittedFocus = document.activeElement;
  const body = {commandId:crypto.randomUUID(),expectedRevision:snapshot.revision,memory:{id,version,content:values[2],source:values[3]}};
  if (!commandBodyFits(body)) { $('memory-status').textContent = copy("legacy.memory-request-exceeds-the-32-kib-utf"); $('memory-status').className = 'status error'; return; }
  $('memory-status').className = 'status';
  $('memory-status').textContent = copy("legacy.saving-explicit-memory-no-work-or-model");
  const saved = await write('/missions/' + encodeURIComponent(missionId) + '/memory',body,missionId,copy("legacy.explicit-memory-saved-earlier-work-retains-its"));
  const confirmed = saved || confirmedOperations.has(operationKey({missionId,commandId:body.commandId}));
  if (snapshot?.value.id === missionId && selectedId === missionId) {
    if (confirmed && JSON.stringify(memoryValues()) === JSON.stringify(values)) { for (let i=0;i<memoryIds.length;i++) $(memoryIds[i]).value = ['', '1', '', ''][i]; memoryDrafts.set(missionId,memoryValues()); }
    $('memory-status').textContent = confirmed ? copy("legacy.explicit-version-confirmed-new-work-will-pin") : copy("legacy.memory-save-was-not-confirmed-here-inspect");
    if ($('memory-form').contains(submittedFocus)) { memoryFocus = {missionId,previous:submittedFocus,targetId:submittedFocus.id}; controls(); }
  }
});
$('mission-form').addEventListener('submit', async event => {
  event.preventDefault(); if (reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const purpose = $('purpose').value.trim(), scope = $('scope').value.trim(), description = $('criteria').value.trim();
  if (!purpose || !scope || !description) { report(copy("legacy.purpose-scope-and-success-criteria-are-required"),'error'); return; }
  const submittedFocus = document.activeElement;
  const id = 'mission:' + crypto.randomUUID();
  const body = {id,commandId:crypto.randomUUID(),purpose,scope,constraints:$('constraints').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean),criteria:{version:1,description,oracle:$('criteria-oracle').value || 'manual-review/v1'}};
  if (await write('/missions',body,id,copy("legacy.mission-created"))) $('mission-form').reset();
  if (selectedId === id && snapshot?.value.id === id && $('mission-form').contains(submittedFocus)) restoreControlFocus(submittedFocus,submittedFocus.id);
});
$('work-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!snapshot || reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const title = $('work-title').value.trim(), budgetText = $('work-budget').value, budget = Number(budgetText);
  if (!title || !budgetText || !Number.isFinite(budget) || budget < 0) { report(copy("legacy.enter-a-work-title-and-a-nonnegative"),'error'); return; }
  const id = snapshot.value.id, submittedFocus = document.activeElement;
  const body = {commandId:crypto.randomUUID(),expectedRevision:snapshot.revision,workId:'work:' + crypto.randomUUID(),title,budget};
  if (await write('/missions/' + encodeURIComponent(id) + '/work',body,id,copy("legacy.work-admitted-no-model-execution-was-started"))) $('work-form').reset();
  if (selectedId === id && snapshot?.value.id === id && $('work-form').contains(submittedFocus)) restoreControlFocus(submittedFocus,submittedFocus.id);
});
$('load-form').addEventListener('submit', event => { event.preventDefault(); if (!busy) { paneExplicit('','',''); void loadMission($('mission-id').value.trim()); } });
$('run-fixture').addEventListener('click', async () => {
  if (reconnectRequired || busy || loading || unknownOperation || recoveryProblem || fixtureUnknown) return;
  const fixtureFeed = feedId;
  busy = true; controls();
  if (!await claimFixture()) { busy = false; controls(); return; }
  controls(); report(copy("legacy.running-the-separate-controlled-development-fixture-real"));
  try {
    const {response, body} = await request('/fixture-run',{method:'POST',headers:{'Content-Type':'application/json',...(fixtureFeed ? {'X-Massion-Feed':fixtureFeed} : {})},body:'{}'},120000);
    if (body.outcome === 'rejected' && body.reason === 'feed') { await clearFixture(); requireReconnect(); report(copy("legacy.database-changed-before-fixture-admission-no-fixture"),'warning'); return; }
    if (fixtureFeed && fixtureFeed !== feedId) { requireReconnect(); throw new Error(copy("legacy.fixture-response-belongs-to-the-previous-database")); }
    if (response.status >= 500) throw new Error(body.error || copy("legacy.the-fixture-outcome-was-not-confirmed"));
    if (!response.ok) { await clearFixture(); report(copy("legacy.fixture-rejected",{value:(body.error || copy("legacy.http",{status:response.status}))}),'error'); return; }
    if (typeof body.missionId !== 'string') throw new Error(copy("legacy.no-fixture-mission-id-was-returned"));
    await verifyAcknowledgementFeed(fixtureFeed,body.feedId,body.missionId,'fixture-ack');
    const loaded = await loadMission(body.missionId,false); if (!loaded) throw new Error(copy("legacy.current-fixture-mission-could-not-be-read"));
    await clearFixture(); report(copy("legacy.controlled-fixture-returned-inspect-its-mission-and"),'success');
  } catch (error) {
    report(copy("legacy.fixture-outcome-unknown-do-not-restart-it",{message:error.message}),'warning');
    fixtureUnknown = true;
  } finally { busy = false; controls(); }
});
let connectionCatalog=null,connectionSequence=0,connectionBusy=false,connectionDiscovery=null,connectionReading=false;
const connectionButtons=new Set();
function connectionLocked(){return !connectionCatalog||reconnectRequired||busy||loading||!!unknownOperation||!!recoveryProblem||!!snapshot?.value.works.some(work=>work.execution==='active'||work.effects.some(effect=>effect.status==='pending'||effect.status==='unknown'));}
function connectionControls(){const locked=connectionBusy||connectionLocked();for(const button of connectionButtons)button.disabled=locked;$('connection-fields').disabled=connectionLocked()||connectionBusy&&!connectionReading||!connectionCatalog||!!connectionCatalog.host?.managed;}
function installConnections(body){
 if(!body||!Array.isArray(body.providerTypes)||!Array.isArray(body.connections)||!body.runtime||!Array.isArray(body.runtime.connections)||!Array.isArray(body.runtime.authorizations))throw new Error(copy("legacy.invalid-connection-catalog"));
 connectionCatalog=body;runtimeConfiguration=body.runtime;executionDrafts.clear();providerNotice();if(snapshot)renderMission();renderConnections();
}
function connectionField(form,title,node){const lab=element('label',title);if(node.id)lab.htmlFor=node.id;form.append(lab,node);return node;}
async function connectionWrite(path,body){
 const epoch=connectionEpoch;let response,result;
 try{const reply=await request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},20000);response=reply.response;result=reply.body;}
 catch(error){requireReconnect();void pollEvents();throw error;}
 if(epoch!==connectionEpoch||reconnectRequired){requireReconnect();void pollEvents();throw new Error(copy("legacy.host-connection-changed-during-the-request-refresh"));}
 if(!response.ok)throw new Error(result.error||copy("legacy.connection-request-failed"));return result;
}

function renderConnections(){
 const area=$('connection-list'),focused=document.activeElement;const focusId=focused?.id && area.contains(focused) ? focused.id : null;area.replaceChildren();connectionButtons.clear();if(!connectionCatalog)return;
 for(const c of connectionCatalog.connections){
  const card=element('div',undefined,'work-card');card.append(element('h3',c.label),element('p',copy("legacy.live-execution-not-verified",{value:c.protocol+' · '+c.auth+' · '+c.connectionStatus}),'hint'));
  const discover=element('button',copy("legacy.explore-models"));discover.type='button';connectionButtons.add(discover);discover.className='secondary';discover.disabled=connectionBusy;const notice=element('p',c.discovery==='discovery-failed'?copy("legacy.discovery-unavailable-enter-an-exact-model-manually"):copy("legacy.model-metadata-is-not-proof-of-inference"),'hint');
  discover.addEventListener('click',async()=>{if(connectionBusy||connectionLocked())return;const sequence=++connectionSequence;connectionReading=true;connectionBusy=true;connectionControls();connectionDiscovery?.abort();const controller=new AbortController();connectionDiscovery=controller;discover.disabled=true;notice.textContent=copy("legacy.reading-provider-model-metadata");try{const {response,body}=await request('/connections/'+encodeURIComponent(c.id)+'/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedConfigHash:c.configHash}),signal:controller.signal},20000);if(sequence!==connectionSequence)return;if(!response.ok)throw new Error(body.error||copy("legacy.discovery-failed"));notice.textContent=body.message;if(body.status==='stale')return;const current=connectionCatalog.connections.find(x=>x.id===c.id&&x.configHash===c.configHash);if(current){current.models=body.models;current.discovery=body.status==='listed'?'models-discovered':'discovery-failed';populate();}}catch(error){if(sequence===connectionSequence)notice.textContent=copy("legacy.discovery-unavailable-enter-an-exact-model-manually");}finally{if(sequence===connectionSequence){connectionReading=false;connectionBusy=false;connectionControls();}}});card.append(discover,notice);
  const form=element('form');form.className='model-connect-form';const models=element('select');models.id='discovered-'+c.id;const model=element('input');model.id='manual-model-'+c.id;model.required=true;model.maxLength=256;const name=element('input');name.id='model-label-'+c.id;name.required=true;name.maxLength=512;
  function populate(){models.replaceChildren();const empty=element('option',copy("legacy.choose-discovered-model-or-enter-manually"));empty.value='';models.append(empty);for(const m of c.models){const option=element('option',m.label+' · '+m.id);option.value=m.id;models.append(option);}}
  populate();models.addEventListener('change',()=>{model.value=models.value;name.value=c.label+' / '+models.value;});connectionField(form,copy("legacy.discovered-models"),models);connectionField(form,copy("legacy.exact-model-id-manual-fallback"),model);connectionField(form,copy("legacy.model-connection-name"),name);const save=element('button',copy("legacy.use-this-model"));save.type='submit';connectionButtons.add(save);form.append(save);form.addEventListener('submit',async event=>{event.preventDefault();if(connectionBusy||connectionLocked())return;const submittedFocus=document.activeElement;connectionBusy=true;connectionControls();save.disabled=true;try{installConnections(await connectionWrite('/connections/'+encodeURIComponent(c.id)+'/profiles',{model:model.value,label:name.value,expectedConfigHash:c.configHash}));$('connection-status').textContent=copy("legacy.model-configuration-saved-choose-executor-reviewer-roles");}catch(error){notice.textContent=error.message;}finally{connectionBusy=false;connectionControls();if(form.contains(submittedFocus))restoreControlFocus(submittedFocus,submittedFocus.id || 'manual-model-'+c.id);}});card.append(form);area.append(card);
 }
 if(connectionCatalog.runtime.connections.length){
  const form=element('form');form.className='connection-authorization-form';form.append(element('h3',copy("legacy.permit-selected-models-for-a-mission-scope")));const exec=element('select'),verify=element('select');exec.id='grant-executor';verify.id='grant-verifier';for(const field of [exec,verify]){const blank=element('option',copy("legacy.choose-exact-model-connection"));blank.value='';field.append(blank);for(const p of connectionCatalog.runtime.connections){const option=element('option',p.label+(p.diagnostics.length?copy("legacy.credential-or-configuration-required"):''));option.value=p.id;option.disabled=p.diagnostics.length>0;field.append(option);}}connectionField(form,copy("legacy.executor"),exec);connectionField(form,copy("legacy.independent-assurance"),verify);const scope=element('input');scope.id='grant-scope';scope.value=snapshot?.value.scope||$('scope').value;scope.required=true;connectionField(form,copy("legacy.mission-scope"),scope);const cap=element('input');cap.id='grant-cap';cap.type='number';cap.value='1024';cap.min='1';cap.max='4096';cap.required=true;connectionField(form,copy("legacy.maximum-output-tokens-per-call"),cap);const button=element('button',copy("legacy.permit-these-models-for-this-scope"));button.type='submit';connectionButtons.add(button);form.append(button,element('p',copy("legacy.permission-does-not-run-a-model-cost"),'hint'));form.addEventListener('submit',async event=>{event.preventDefault();if(connectionBusy||connectionLocked())return;const submittedFocus=document.activeElement;connectionBusy=true;connectionControls();button.disabled=true;try{installConnections(await connectionWrite('/connection-authorizations',{id:'authorization:'+crypto.randomUUID(),scope:scope.value,executorProfileId:exec.value,verifierProfileId:verify.value,maxOutputTokensPerCall:Number(cap.value),expectedConfigHash:connectionCatalog.configHash}));$('connection-status').textContent=copy("legacy.scoped-permission-saved-open-a-work-check");}catch(error){$('connection-status').textContent=error.message;}finally{connectionBusy=false;connectionControls();if(form.contains(submittedFocus))restoreControlFocus(submittedFocus,submittedFocus.id || 'grant-executor');}});area.append(form);
 }
 connectionControls();if(focusId)restoreControlFocus(focused,focusId);
}
async function refreshConnections(){try{const {response,body}=await request('/connections',{scope:'host-connections'});if(!response.ok)throw new Error(copy("legacy.setup-not-enabled"));installConnections(body);$('connection-form').hidden=!!body.host?.managed;$('connection-heading').textContent=body.host?.managed?copy("legacy.host-model-connections"):copy("legacy.connect-a-model-provider");const kind=$('connection-kind');kind.replaceChildren();for(const p of body.providerTypes){const option=element('option',p.label);option.value=p.id;kind.append(option);}kind.value=body.providerTypes[0]?.id||'';$('connection-base').value=body.providerTypes[0]?.baseUrl||'';const mode=$('connection-mode');mode.replaceChildren();for(const value of body.fixtureModeEnabled?['https','local-http-mock']:['https']){const option=element('option',value==='https'?copy("legacy.https-api"):copy("legacy.local-test-fixture-not-live-verification"));option.value=value;mode.append(option);}mode.value='https';connectionControls();$('connection-status').textContent=body.host?.managed?copy("legacy.host-manifest-loaded-destinations-and-models-are",{revision:body.host.revision,value:(body.liveExecutionEnabled?copy("legacy.live-capability-enabled-scoped-permission-and-explicit"):copy("legacy.live-model-calls-disabled"))}):copy("legacy.connection-setup-ready-credentials-are-host-owned");}catch{connectionCatalog=null;++connectionSequence;connectionDiscovery?.abort();renderConnections();$('connection-fields').disabled=true;$('connection-status').textContent=copy("legacy.connection-setup-is-unavailable-refresh-before-changing");}}
$('connection-kind').addEventListener('change',()=>{if(connectionLocked()||connectionBusy&&!connectionReading)return;++connectionSequence;connectionDiscovery?.abort();connectionReading=false;connectionBusy=false;connectionControls();const p=connectionCatalog?.providerTypes.find(p=>p.id===$('connection-kind').value);$('connection-base').value=p?.baseUrl||'';executionDrafts.clear();if(snapshot)renderMission();renderConnections();});
$('connection-form').addEventListener('submit',async event=>{event.preventDefault();if(connectionBusy||connectionLocked()||!connectionCatalog||connectionCatalog.host?.managed)return;++connectionSequence;connectionDiscovery?.abort();connectionBusy=true;connectionControls();$('connection-fields').disabled=true;try{const value={id:'connection:'+crypto.randomUUID(),label:$('connection-label').value,providerType:$('connection-kind').value,baseUrl:$('connection-base').value,mode:$('connection-mode').value};if($('connection-reference').value)value.secretRef=$('connection-reference').value;installConnections(await connectionWrite('/connections',value));$('connection-reference').value='';$('connection-status').textContent=copy("legacy.connection-metadata-saved-explore-models-or-enter");}catch(error){$('connection-status').textContent=error.message;}finally{connectionBusy=false;connectionControls();}});

function requireReconnect() { reconnectRequired = true; ++connectionEpoch; invalidateNeighborhood(); invalidateInbox(); invalidateCatalog(); ++connectionSequence; invalidateDocumentRead(copy("legacy.host-connection-changed-read-exact-source-again")); invalidateImpact(copy("legacy.host-connection-changed-read-impact-again-against")); connectionDiscovery?.abort(); if(connectionReading){connectionReading=false;connectionBusy=false;} controls(); }
async function refreshProviders() {
  try { const {response,body} = await request('/providers',{scope:'host-providers'}); if (!response.ok) throw new Error(copy("legacy.provider-read-failed")); if (!Array.isArray(body.providers) || !body.selection || !['selected','unavailable'].includes(body.selection.status)) throw new Error(copy("legacy.invalid-provider-response")); providerSelection = body.selection; runtimeConfiguration = body.runtime && Array.isArray(body.runtime.connections) && Array.isArray(body.runtime.authorizations) ? body.runtime : null; providerKnown = true; return true; }
  catch { providerKnown = false; runtimeConfiguration = null; providerNotice(); if (snapshot) renderMission(); return false; }
}
function resumeFeedRecovery(){
 if(!feedSuspended&&!feedRecoveryScheduled&&(feedRecoveryPending||!reconnectRequired&&eventRefreshNeeded&&selectedId)&&!busy&&!loading&&!polling){
  feedRecoveryScheduled=true;
  void Promise.resolve().then(()=>{
   feedRecoveryScheduled=false;if(feedSuspended||busy||loading||polling)return;
   if(feedRecoveryPending){feedRecoveryPending=false;return syncFeed();}
   if(!reconnectRequired&&eventRefreshNeeded&&selectedId){eventRefreshNeeded=false;return loadMission(selectedId,false);}
  });
 }
}
let feedStop=null,feedStarting=0,feedSyncing=false,feedAgain=false,feedTarget=0,feedReset=false,feedRetry=null;
let feedState='stopped',feedSuspended=false,feedRecoveryScheduled=false;
function stopFeed(){clearTimeout(feedRetry);feedRetry=null;++feedStarting;feedStop?.();feedStop=null;feedState='stopped';}
function retryFeed(){if(!feedSuspended&&feedRetry===null)feedRetry=setTimeout(()=>{stopFeed();void startFeed();},1000);}
async function syncFeed(){
 if(feedSuspended)return;feedAgain=true;if(feedSyncing)return;feedSyncing=true;
 try{do{feedAgain=false;if(feedReset){feedReset=false;protocol.invalidate();requireReconnect();await refreshReadState(connectionEpoch);feedTarget=cursor;}
   const before=cursor;await pollEvents();
   if(!reconnectRequired&&cursor<feedTarget){if(cursor===before)feedReset=true;feedAgain=true;}
 }while(feedAgain&&!feedSuspended);}catch{requireReconnect();}finally{feedSyncing=false;if(reconnectRequired){if(busy||loading)feedRecoveryPending=true;else retryFeed();}}
}
async function startFeed(){
 if(feedSuspended||feedState!=='stopped')return;
 clearTimeout(feedRetry);feedRetry=null;const generation=++feedStarting;feedState='connecting';
 const failed=()=>{
  if(generation!==feedStarting)return;
  stopFeed();requireReconnect();protocol.reconnect();const stopped=feedStarting;
  void protocol.connection().then(state=>{if(stopped===feedStarting&&state.state==='ready'&&state.features.feedPush)retryFeed();},()=>{if(stopped===feedStarting)retryFeed();});
 };
 try{const stop=await protocol.subscribe({after:cursor,...(feedId?{feedId}:{})},hint=>{
   if(generation!==feedStarting)return;feedState='live';
   if(hint.reason==='connected'){requireReconnect();feedTarget=hint.cursor;}
   else if(hint.reason==='reset'||feedId&&hint.feedId!==feedId){feedReset=true;feedTarget=hint.cursor;}
   else feedTarget=Math.max(feedTarget,hint.cursor);
   void syncFeed();
 },failed);
 if(generation!==feedStarting)stop();else feedStop=stop;
 }catch{
  if(generation!==feedStarting)return;stopFeed();requireReconnect();const stopped=feedStarting;
  if(!await protocol.connection().then(state=>state.state!=='ready'||!state.features.feedPush,()=>false)&&stopped===feedStarting)retryFeed();
 }
}
function resumeFeed(){feedSuspended=false;void startFeed();void syncFeed();}
function suspendFeed(){feedSuspended=true;stopFeed();protocol.reconnect();requireReconnect();}
async function connect() {
  if(connectionEpoch || !reconnectRequired)requireReconnect();
  try { const {response,body} = await request('/health',{scope:'host-health'}); if (!response.ok) throw new Error(copy("legacy.host-unavailable")); $('health').replaceChildren(element('span',undefined,'dot online'),element('span',body.status === 'ready' ? copy("legacy.host-ready") : String(body.status || copy("legacy.host-reachable")))); }
  catch { $('health').textContent = copy("legacy.host-unavailable"); }
  await pollEvents();
  await startFeed();
  if (!selectedId && initialReference.present) report(copy("legacy.invalid-mission-link-enter-a-valid-mission"), 'error');
}
${chatClient}
${memberClient}
${resultsClient}
${schedulesClient}
${settingsClient}
${appsClient}
${shellClient}
${workRoomClient}
${missionCatalogClient}
${workInboxClient}
${runSequenceClient}
${prerequisiteClient}
${correctionClient}
${conversationWorkClient}
${clarificationClient}
${memoryUsageClient}
${memoryFindClient}
${memorySearchClient}
${fileDocumentClient}
${recordSourceClient}
${memoryConflictClient}${memoryExpiryClient}
${missionConstraintsClient}
${neighborhoodClient}
${expiredClient}
${rejectedTextClient}
${reflectionTrailClient}
controls(); void connect();

document.addEventListener('visibilitychange', () => { if (!document.hidden) { resumeFeed(); if (selectedId && !busy && !loading) void loadMission(selectedId,false); } });
window.addEventListener('online', () => { feedSuspended=false;void connect(); });
window.addEventListener('pageshow', resumeFeed);
window.addEventListener('offline', suspendFeed);
window.addEventListener('pagehide', suspendFeed);
function restoreMissionAddress() { window.history.replaceState(null, '', snapshot ? '#mission=' + encodeURIComponent(snapshot.value.id) : window.location.pathname + window.location.search); }
window.addEventListener('hashchange', () => {
  const reference = missionReference();
  if (!reference.id) { restoreMissionAddress(); report(copy("legacy.invalid-mission-link-enter-a-valid-mission"), 'error'); return; }
  if (busy) { restoreMissionAddress(); report(copy("legacy.wait-for-the-current-command-to-settle"), 'warning'); return; }
  paneExplicit('','',''); void loadMission(reference.id);
});
</script>
</body>
</html>`;
