/** Self-contained loopback client. All user and host text is rendered through textContent. */
export const workbenchPage = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Massion · Mission workbench</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#21302d;background:#f4f5f0;font-synthesis:none;--ink:#21302d;--muted:#65726c;--line:#dce2d9;--green:#245b44;--soft:#edf4ee;--warn:#855019;--warn-bg:#fcf3df}*{box-sizing:border-box}body{margin:0}button,input,textarea,select{font:inherit}button,input,textarea,select,summary{outline-offset:4px}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #377dba}button{border:1px solid var(--green);border-radius:8px;background:var(--green);color:#fff;padding:10px 15px;font-weight:650;cursor:pointer;min-height:42px}button.secondary{background:#fff;color:var(--ink);border-color:#c9d2c7}button.quiet{background:transparent;color:var(--green);border-color:transparent}button.danger{color:#8a3932;border-color:#e1c7c1;background:#fff}button:disabled{opacity:.48;cursor:not-allowed}input,textarea,select{width:100%;padding:10px 11px;border:1px solid #bfcbbd;border-radius:7px;background:#fff;color:var(--ink);min-width:0}textarea{resize:vertical;line-height:1.5}label{display:block;font-size:.84rem;font-weight:650;margin-bottom:7px}input:disabled,textarea:disabled,select:disabled{background:#f0f2ed}fieldset{padding:0;border:0;margin:0;min-width:0}h1,h2,h3,h4,p{margin-top:0}h1{font-size:clamp(1.8rem,3vw,2.65rem);line-height:1.13;letter-spacing:-.06em;margin-bottom:12px;font-weight:650}h2{font-size:1.05rem;letter-spacing:-.02em;margin-bottom:16px}h3{font-size:1.08rem;line-height:1.45;margin:0}h4{font-size:.85rem;margin:18px 0 8px}p{line-height:1.55}small,.muted,.hint{color:var(--muted)}small,.hint{font-size:.77rem;line-height:1.5}.hint{margin:7px 0 0}.eyebrow{font-size:.67rem;letter-spacing:.12em;text-transform:uppercase;font-weight:750;color:var(--green);margin-bottom:8px}.shell{max-width:1300px;padding:0 36px;margin:auto}header{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:12px}.brand{display:flex;align-items:center;gap:10px;font-size:1.2rem;letter-spacing:-.04em;font-weight:750}.mark{display:grid;place-items:center;width:31px;height:31px;background:var(--green);color:#fff;border-radius:8px;font-size:1rem}.header-meta{display:flex;align-items:center;gap:10px;font-size:.73rem;color:var(--muted)}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#99a39b;margin-right:5px}.dot.online{background:#44845c}.intro{padding:32px 0 22px;display:flex;justify-content:space-between;align-items:end;gap:20px}.intro p{max-width:610px;margin:0;color:var(--muted);font-size:.9rem}.intro-side{max-width:255px;font-size:.75rem!important}.layout{display:grid;grid-template-columns:minmax(270px,340px) minmax(0,1fr);gap:24px;align-items:start;padding-bottom:32px}.stack{display:grid;gap:18px}.panel{border:1px solid var(--line);background:#fff;border-radius:13px;padding:22px;box-shadow:0 3px 10px #243d2d03}.field{margin-bottom:16px}.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.spread{justify-content:space-between}.grow{flex:1;min-width:150px}.full{width:100%}.section-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:17px}.section-top h2{margin:0}.tag{display:inline-block;font-size:.69rem;line-height:1.3;padding:5px 8px;border-radius:6px;background:#eff2ec;color:#4d6153;white-space:nowrap}.tag.good{background:#e7f2e9;color:#285b38}.tag.warn{background:var(--warn-bg);color:var(--warn)}.tag.bad{background:#fbece8;color:#8c4037}.notice{padding:13px 15px;border-radius:8px;border:1px solid #e7dbbd;background:var(--warn-bg);color:#77531d;font-size:.82rem;line-height:1.5;margin-bottom:18px}.notice p{margin:0}.status{margin:0 0 19px;font-size:.8rem;line-height:1.5;min-height:20px;color:var(--muted);overflow-wrap:anywhere}.status.error{color:#934438}.status.warning{color:var(--warn)}.status.success{color:var(--green)}.empty{padding:38px 30px;text-align:center;border:1px dashed #becdbb;border-radius:12px;background:#fafcf7}.empty-symbol{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;border:1px solid #d9e5d5;background:#eff5ec;color:#55714d;margin:0 auto 16px;font-size:1.2rem}.empty h2{margin-bottom:9px}.empty p{max-width:410px;margin:0 auto;color:var(--muted);font-size:.86rem}.mission-purpose{font-size:1.4rem;line-height:1.35;letter-spacing:-.03em;margin:0 0 16px;overflow-wrap:anywhere}.facts{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:0}.facts dt,.metric dt{font-size:.7rem;color:var(--muted);margin-bottom:5px}.facts dd,.metric dd{margin:0;font-size:.86rem;line-height:1.5;overflow-wrap:anywhere}.facts ul{margin:0;padding-left:17px}.id{font: .7rem ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);overflow-wrap:anywhere}.divider{height:1px;background:var(--line);margin:20px 0}.work-list{display:grid;gap:14px}.work-card{border:1px solid var(--line);border-radius:11px;padding:18px;background:#fff;overflow-wrap:anywhere}.work-title{margin:0 0 10px}.badge-row{display:flex;gap:6px;flex-wrap:wrap;margin:9px 0 15px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;background:#f7f9f4;border-radius:8px;padding:12px;margin:0 0 14px}.metric{margin:0}.metric dd{font-size:.8rem}.work-note{font-size:.8rem;line-height:1.5;margin-bottom:12px;color:var(--muted)}.work-note.warning{color:var(--warn)}details{font-size:.82rem;line-height:1.5}summary{cursor:pointer;font-weight:650;color:var(--green);padding:6px 0}.detail-content{margin-top:10px}.detail-content p,.detail-content ul{margin-bottom:9px}.detail-content ul{padding-left:18px}.detail-content pre,pre{font: .72rem/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f1;border:1px solid #e4e9df;border-radius:7px;padding:12px;max-height:360px;overflow:auto}.controls{border-top:1px solid var(--line);margin-top:14px;padding-top:14px}.steer-form{margin-top:9px}.steer-form .row{align-items:end}.steer-form label{font-size:.75rem}.steer-form textarea{font-size:.83rem}.work-compose{border-top:1px solid var(--line);padding-top:19px;margin-top:22px}.work-compose .budget{width:165px}.event-list{list-style:none;margin:0;padding:0}.event-list li{padding:10px 0;border-top:1px solid #edf0e8;font-size:.8rem;display:flex;justify-content:space-between;gap:10px}.event-list li:first-child{border-top:0}.event-list small{text-align:right}.fixture{background:#f9faf6}.fixture p{font-size:.79rem;margin:10px 0 14px}.footer{font-size:.72rem;color:var(--muted);padding:0 0 30px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}[hidden]{display:none!important}@media(max-width:850px){.shell{padding:0 20px}.layout{grid-template-columns:minmax(240px,300px) minmax(0,1fr);gap:16px}.panel{padding:18px}.intro-side{display:none}.facts{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}.metrics .metric:last-child{grid-column:1/-1}}@media(max-width:650px){header{height:68px}.shell{padding:0 15px}.layout{grid-template-columns:1fr}.intro{padding:26px 0 22px}.header-meta{max-width:180px;text-align:right}.panel{padding:19px}.facts{grid-template-columns:1fr 1fr}.metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.metrics .metric:last-child{grid-column:auto}.work-compose .budget{width:100%}.row>button{max-width:100%}}@media(prefers-reduced-motion:no-preference){button{transition:background .15s,opacity .15s}button:hover:not(:disabled){filter:brightness(.96)}}
.execution-form select,.execution-form input,#criteria-oracle{margin-bottom:14px}.execution-form button{margin:7px 8px 0 0}
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
<form id="work-form" class="work-compose"><fieldset id="work-fields"><h2>Admit bounded Work</h2><div class="row"><div class="field grow"><label for="work-title">Work title</label><input id="work-title" maxlength="16000" placeholder="A concrete responsibility or deliverable" required></div><div class="field budget"><label id="work-budget-label" for="work-budget">Budget limit (host units)</label><input id="work-budget" type="number" min="0" step="any" value="0" required></div></div><button id="admit-work" type="submit">Add Work</button><p id="work-budget-hint" class="hint">Admission records responsibility and pins criteria and effective memory. It does not start model execution.</p></fieldset></form>
<details style="margin-top:22px"><summary>Authoritative snapshot</summary><pre id="snapshot-json"></pre></details></section>
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
let snapshot = null, busy = false, loading = false, readSequence = 0, polling = false, reconnectRequired = true, connectionEpoch = 0;
let unknownOperation = null, providerSelection = null, providerKnown = false, runtimeConfiguration = null, activity = [], eventRefreshNeeded = false;
let recoveryProblem = '', fixtureUnknown = storage.get(fixtureKey) !== null;
const drafts = new Map(), confirmedOperations = new Set();
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
function element(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = String(text); if (className) item.className = className; return item; }
function report(message, tone = '') { $('status').textContent = message; $('status').className = 'status' + (tone ? ' ' + tone : ''); }
function controls() {
  const locked = reconnectRequired || busy || loading || !!unknownOperation || !!recoveryProblem;
  $('sync-notice').hidden = !reconnectRequired;
  $('sync-notice').textContent = reconnectRequired ? 'New actions are paused until current host state and permissions are refreshed. Mission reads and your drafts remain available. No command is retried.' : '';
  $('mission-fields').disabled = locked;
  connectionControls();
  $('work-fields').disabled = locked || !snapshot;
  $('load-mission').disabled = busy;
  $('mission-id').disabled = busy;
  $('run-fixture').disabled = locked || fixtureUnknown;
  for (const button of document.querySelectorAll('[data-write]')) button.disabled = locked;
  $('create-mission').textContent = busy ? 'Command in flight…' : 'Create Mission';
  $('mission-panel').setAttribute('aria-busy', String(busy || loading));
  const notice = $('operation-notice');
  notice.hidden = !unknownOperation && !recoveryProblem && !fixtureUnknown;
  notice.textContent = recoveryProblem || (unknownOperation ? (confirmedOperations.has(operationKey(unknownOperation)) ? 'Confirmed command awaiting browser recovery cleanup: ' : busy ? 'Command in flight: ' : 'Outcome unknown for command ') + unknownOperation.commandId + '. Its recovery reference is saved on this browser. Checking durable receipts; no write will be replayed, including after reload.' : fixtureUnknown ? 'A development fixture has no confirmed outcome in this browser. Fixture reruns are locked, including after reload. Inspect durable activity and the local host logs to identify its Mission and outcome; ordinary Mission reads remain available.' : '');
}
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
  snapshot = null; restoreMissionAddress();
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
  const changed = !snapshot || snapshot.revision !== value.revision || snapshot.value.id !== value.value.id;
  snapshot = {revision:value.revision, value:value.value};
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
  loading = true; controls();
  if (announce && !unknownOperation) report('Reading authoritative Mission state…');
  try {
    const {response, body} = await request('/missions/' + encodeURIComponent(id));
    if (sequence !== readSequence || id !== selectedId) return false;
    if (!response.ok) throw new Error(body.error || 'Mission read failed (' + response.status + ').');
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
function badge(text, state) { return element('span', text, 'tag' + (['accepted','passed','succeeded'].includes(state) ? ' good' : ['blocked','waiting','unknown','pending','stale'].includes(state) ? ' warn' : ['failed','cancelled'].includes(state) ? ' bad' : '')); }
function addFact(list, title, value) { const group = element('div'); group.append(element('dt', title)); const detail = element('dd'); if (Array.isArray(value)) { const items = element('ul'); for (const item of value) items.append(element('li', item)); detail.append(items); } else detail.textContent = String(value); group.append(detail); list.append(group); }
function metric(label, value) { const group = element('div', undefined, 'metric'); group.append(element('dt', label), element('dd', value)); return group; }
function providerNotice() {
  if (runtimeConfiguration) { $('work-budget-label').textContent = 'Budget limit (output tokens)'; $('work-budget-hint').textContent = 'Set a budget of at least twice the intended per-call output cap for executor and independent review. This is not a money or total-token limit. Admission does not start execution.'; $('provider-notice').textContent = 'Choose configured connections separately for execution and independent review on each Work. Selection does not authorize new accounts or spend. Costs remain unknown; budget units are output tokens.'; return; }
  $('work-budget-label').textContent = 'Budget limit (host units)';
  $('work-budget-hint').textContent = 'Admission records responsibility and pins criteria and effective memory. It does not start model execution. Confirm host runtime units before choosing a budget.';
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
  const area = element('details',undefined,'controls'); area.append(element('summary','Choose execution and review connections'));
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
  check.addEventListener('click',async () => {
    if (!current() || checking) return;
    const selection = choice(), key = JSON.stringify(selection), version = ++checkVersion;
    const stillCurrent = () => current() && version === checkVersion && key === JSON.stringify(choice());
    checking = true; check.disabled = true; check.textContent = 'Checking…'; result.textContent = 'Checking this Work and selection without executing providers…';
    try {
      const response = await request('/missions/' + encodeURIComponent(missionId) + '/preflight',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commandId:crypto.randomUUID(),expectedRevision:revision,workId:work.id,selection})});
      if (!stillCurrent()) return;
      const body = response.body;
      if (!response.response.ok || body.ready !== true) { result.textContent = (body.diagnostics || []).map(d => d.message).join(' ') || body.error || 'Selection was not confirmed. Refresh this Mission and check again.'; result.className = 'status warning'; return; }
      if (body.revision !== revision || body.workId !== work.id) { result.textContent = 'The host did not confirm this exact Work revision. Refresh the Mission and check again.'; result.className = 'status warning'; return; }
      result.textContent = 'Checked at revision ' + revision + '. This Work and selection can be submitted now. No provider request was made; Run rechecks current state before admission.'; result.className = 'status success';
    } catch(error) { if (stillCurrent()) { result.textContent = 'Selection could not be checked: ' + error.message; result.className = 'status warning'; } }
    finally { if (stillCurrent()) { checking = false; check.disabled = false; check.textContent = 'Check selection'; } }
  });
  const run = element('button','Run with selected connections'); run.type = 'submit'; run.setAttribute('data-write',''); run.setAttribute('aria-describedby',plan.id);
  form.addEventListener('submit',async event => { event.preventDefault(); if(!current())return; refresh(); await write('/missions/' + encodeURIComponent(missionId) + '/run',{commandId:crypto.randomUUID(),expectedRevision:revision,workId:work.id,selection:choice()},missionId,'Run finished. Inspect its execution and independent assurance below.'); });
  for(const connection of configuration.connections.filter(c=>c.diagnostics.length))form.append(element('p',connection.label + ': ' + connection.diagnostics.map(d=>d.message).join(' '),'hint'));
  form.append(detail,plan,check,run,result,element('p','No automatic fallback, retry or provider change. The same connection may serve both roles through separate stateless calls; independent review is not a quality guarantee.','hint'));area.append(form);return area;
}

function renderWork(work) {
  const card = element('article', undefined, 'work-card');
  const title = element('h3', work.title, 'work-title'); card.append(title, element('div', work.id, 'id'));
  const tags = element('div', undefined, 'badge-row'); tags.append(badge('Execution: ' + work.execution, work.execution), badge('Acceptance: ' + work.acceptance, work.acceptance));
  if (work.record) tags.append(badge(work.record.evidenceClass + ' evidence', work.record.evidenceClass)); card.append(tags);
  const metrics = element('dl', undefined, 'metrics'); metrics.append(metric('Attempts', (work.attempts || []).length), metric('Budget · reserved / limit', work.budget.reserved + ' / ' + work.budget.limit), metric('Measured usage', work.budget.measured === null ? 'Unknown' : work.budget.measured)); card.append(metrics);
  card.append(element('p', workBlocker(work), 'work-note' + (['queued','blocked','waiting'].includes(work.execution) ? ' warning' : '')));
  if ((work.instructions || []).length) card.append(element('p', 'Latest owner instruction: ' + work.instructions.at(-1).text, 'work-note'));
  const evidence = element('details'); evidence.append(element('summary', 'Criteria, memory pins & evidence'));
  const body = element('div', undefined, 'detail-content');
  body.append(element('h4', 'Pinned criteria'), element('p', 'v' + work.criteria.version + ' · ' + work.criteria.description), element('p', 'Oracle: ' + work.criteria.oracle, 'id'));
  body.append(element('h4', 'Pinned memory versions'), element('p', work.appliedMemoryVersions.length ? work.appliedMemoryVersions.join(', ') : 'None pinned for this Work.'));
  body.append(element('h4', 'Artifact'), element('p', work.artifact ? work.artifact.path + ' · v' + work.artifact.version + ' · ' + work.artifact.kind : 'No artifact has been published.'));
  if (work.artifact) body.append(element('p', 'SHA-256: ' + work.artifact.sha256, 'id'));
  body.append(element('h4', 'Independent assurance'), element('p', work.verdict ? work.verdict.status + ' · artifact v' + work.verdict.artifactVersion + ' · criteria v' + work.verdict.criteriaVersion : 'No independent verdict yet.'));
  if (work.verdict) { const items = element('ul'); for (const proof of work.verdict.evidence) items.append(element('li', proof.kind + ': ' + proof.detail + ' · source: ' + proof.source)); body.append(items); }
  if ((work.instructions || []).length) { body.append(element('h4', 'Recorded owner instructions')); const instructions = element('ul'); for (const instruction of work.instructions) instructions.append(element('li', instruction.actorId + ': ' + instruction.text)); body.append(instructions); }
  if (work.runtimeRecovery) { body.append(element('h4', 'Owner quarantine decision'), element('p', work.runtimeRecovery.actorId + ': ' + work.runtimeRecovery.reason), element('pre', JSON.stringify(work.runtimeRecovery, null, 2))); }
  body.append(element('h4', 'Effect receipts'));
  if (!work.effects.length) body.append(element('p', 'No effects admitted.'));
  for (const effect of work.effects) body.append(element('p', effect.id + ' · ' + effect.status + ' · ' + effect.target + (effect.receipt ? ' · receipt: ' + effect.receipt : ' · no receipt')));
  body.append(element('h4', 'Accepted Record'));
  if (work.record) { body.append(element('p', work.record.id + ' · ' + work.record.evidenceClass), element('p', 'Checksum: ' + work.record.checksum, 'id')); const record = element('details'); record.append(element('summary', 'Inspect Record bundle'), element('pre', JSON.stringify(work.record, null, 2))); body.append(record); }
  else body.append(element('p', 'No accepted Record. A completed attempt alone is not acceptance.'));
  const attempts = element('details'); attempts.append(element('summary', 'Attempts, tasks & assignments'), element('pre', JSON.stringify({attempts:work.attempts,tasks:work.tasks,assignments:work.assignments}, null, 2))); body.append(attempts); evidence.append(body); card.append(evidence);
  if (work.runtimeRun && work.runtimeRun.connectionBindings) body.append(element('h4','Selected connections'),element('pre',JSON.stringify(work.runtimeRun.connectionBindings,null,2)));
  if (runtimeConfiguration && !work.runtimeRun && work.execution !== 'cancelled' && work.acceptance !== 'accepted') card.append(renderExecutionSelection(work));
  if (work.runtimeRun && !work.runtimeRecovery && work.acceptance !== 'accepted' && work.effects.some(effect => effect.status === 'pending' || effect.status === 'unknown')) {
    const area = element('details', undefined, 'controls'); area.append(element('summary', 'Quarantine interrupted run'));
    area.append(element('p', 'Permanent local closure: pending effects become unknown, reservations remain held, and late provider responses cannot change this Work. An already admitted effect may still execute remotely. This does not resume completion or authorize replay.', 'work-note warning'));
    const form = element('form', undefined, 'quarantine-form');
    const label = element('label', 'Why are you quarantining this run?'); const reason = element('textarea'); reason.id = 'quarantine-reason-' + work.id; label.htmlFor = reason.id; reason.rows = 2; reason.maxLength = 16000; reason.required = true;
    const acknowledgement = element('input'); acknowledgement.type = 'checkbox'; acknowledgement.id = 'quarantine-ack-' + work.id; acknowledgement.required = true; acknowledgement.style.width = 'auto';
    const ackLabel = element('label', 'I understand that external effects and usage may remain unknown and this Work cannot be reopened.'); ackLabel.htmlFor = acknowledgement.id;
    const submit = element('button', 'Permanently quarantine run', 'danger'); submit.type = 'submit'; submit.setAttribute('data-write','');
    form.addEventListener('submit', event => { event.preventDefault(); const text = reason.value.trim(); if (!text || !acknowledgement.checked) { report('Enter a reason and explicitly acknowledge the uncertain external outcome.','warning'); return; } sendCommand({type:'quarantine-runtime',workId:work.id,runId:work.runtimeRun.id,reason:text,acknowledgeUncertainOutcome:true}); });
    form.append(label,reason,acknowledgement,ackLabel,submit); area.append(form); card.append(area);
  }
  if (work.execution !== 'cancelled' && work.acceptance !== 'accepted') {
    const area = element('div', undefined, 'controls');
    const form = element('form', undefined, 'steer-form');
    const label = element('label', 'Steering instruction'); const input = element('textarea'); input.id = 'steer-' + work.id; label.htmlFor = input.id; input.rows = 2; input.maxLength = 16000; input.required = true; input.placeholder = 'Record a change of direction'; input.value = drafts.get(work.id) || ''; input.addEventListener('input', () => drafts.set(work.id, input.value));
    const buttons = element('div', undefined, 'row'); buttons.style.marginTop = '9px';
    const steer = element('button', 'Record instruction', 'secondary'); steer.type = 'submit'; steer.setAttribute('data-write','');
    const cancel = element('button', 'Cancel Work', 'danger'); cancel.type = 'button'; cancel.setAttribute('data-write','');
    cancel.addEventListener('click', () => sendCommand({type:'cancel',workId:work.id}));
    form.addEventListener('submit', event => { event.preventDefault(); const instruction = input.value.trim(); if (instruction) sendCommand({type:'steer',workId:work.id,instruction}); });
    buttons.append(steer,cancel); form.append(label,input,buttons,element('p','Steering records an owner instruction; existing execution blockers remain. Cancellation does not undo effects.','hint')); area.append(form); card.append(area);
  }
  return card;
}
function renderMission() {
  if (!snapshot) return;
  const mission = snapshot.value;
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
}
function renderActivity() {
  const list = $('event-list'); list.replaceChildren();
  const shown = activity.filter(event => !selectedId || event.aggregateId === selectedId).slice(-8).reverse();
  if (!shown.length) list.append(element('li',selectedId ? 'No newly observed events for this Mission.' : 'Select a Mission to follow its events.'));
  for (const event of shown) { const row = element('li'); const label = (event.events || []).map(item => item.type).filter(Boolean).join(', ') || 'Committed change'; row.append(element('span',String(label).replaceAll('-',' ')),element('small','revision ' + event.revision + ' · cursor ' + event.cursor)); list.append(row); }
}
function receiptObserved() {
  return unknownOperation && (confirmedOperations.has(operationKey(unknownOperation)) || activity.some(event => event.commandId === unknownOperation.commandId && event.aggregateId === unknownOperation.missionId));
}
async function pollEvents() {
  if (polling) return;
  polling = true; const epoch = connectionEpoch;
  try {
    const after = unknownOperation ? Math.min(cursor, unknownOperation.reconcileCursor) : cursor;
    const {response, body} = await request('/events?after=' + after);
    if (response.status === 409) {
      cursor = 0; storage.set(cursorKey, '0'); activity = []; eventRefreshNeeded = true;
      if (unknownOperation) unknownOperation.reconcileCursor = 0;
      if (selectedId && !busy && !loading) await loadMission(selectedId, false);
      throw new Error('Saved cursor was ahead of the host. Catch-up will restart from the beginning.');
    }
    if (!response.ok || !Array.isArray(body.events) || !Number.isSafeInteger(body.cursor) || body.cursor < after || body.events.some(event => !Number.isSafeInteger(event.cursor) || event.cursor <= after || event.cursor > body.cursor)) throw new Error(body.error || 'Invalid event response.');
    for (const event of body.events) {
      if (!activity.some(old => old.cursor === event.cursor)) activity.push(event);
      if (event.aggregateId === selectedId && (!snapshot || event.revision > snapshot.revision)) eventRefreshNeeded = true;
    }
    if (unknownOperation) unknownOperation.reconcileCursor = body.cursor;
    activity.sort((a,b) => a.cursor - b.cursor);
    if (receiptObserved()) { const commandId = unknownOperation.commandId; confirmedOperations.add(operationKey(unknownOperation)); await clearPending(unknownOperation); controls(); report('Durable receipt found for ' + commandId + '. Refreshing current state; the command was not replayed.','success'); eventRefreshNeeded = true; }
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
      if (missionId && !await loadMission(missionId, false)) throw new Error('Current Mission could not be refreshed');
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
async function write(path, body, missionId, successMessage) {
  const longRun = path.endsWith('/run'); let ownsBusy = true;
  if (reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return false;
  const operation = {commandId:body.commandId, missionId, reconcileCursor:cursor};
  busy = true; controls();
  if (!await persistPending(operation)) { busy = false; controls(); return false; }
  rememberMission(missionId);
  controls(); report('Sending command ' + body.commandId + '…');
  try {
    const responsePromise = request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},longRun ? 120000 : 15000);
    // Keep the durable pending lock only until admission is observed. Events can then
    // refresh the admitted run and owner controls while the provider HTTP call waits.
    if(longRun){busy=false;ownsBusy=false;controls();}
    const {response, body:result} = await responsePromise;
    if(longRun && selectedId!==missionId){
      if(response.ok && ['settled','blocked','cancelled','already-started'].includes(result.status) && validSnapshot(result.snapshot,missionId)){confirmedOperations.add(operationKey(operation));await clearPending(operation);return result.status==='settled';}
      if(response.status>=400 && response.status<500 || response.status===503 && result.outcome==='rejected'){await clearPending(operation);return false;}
      throw new Error('Background run outcome requires durable readback.');
    }
    if (response.status === 409 || result.status === 'conflict') {
      await clearPending(operation);
      const loaded = await loadMission(missionId, false);
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
      confirmedOperations.add(operationKey(operation)); await clearPending(operation); if(selectedId===missionId && (!snapshot || snapshot.revision<=result.snapshot.revision)){++readSequence;installSnapshot(result.snapshot);}
      report(result.reason || successMessage,result.status === 'settled' ? 'success' : 'warning'); return result.status === 'settled';
    }
    if (!['committed','replayed'].includes(result.status) || !validSnapshot(result, missionId)) throw new Error('The command response did not confirm a valid committed snapshot.');
    confirmedOperations.add(operationKey(operation)); await clearPending(operation); rememberMission(missionId); ++readSequence; installSnapshot(result);
    report(successMessage + ' Revision ' + result.revision + (result.status === 'replayed' ? ' (existing receipt).' : '.'),'success');
    return true;
  } catch (error) {
    if(longRun && selectedId!==missionId){if(!confirmedOperations.has(operationKey(operation)) && (!unknownOperation || operationKey(unknownOperation)===operationKey(operation)))unknownOperation=operation;await pollEvents();return false;}
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
  } finally { if(ownsBusy)busy = false; controls(); if (eventRefreshNeeded && !unknownOperation) { eventRefreshNeeded = false; void loadMission(selectedId,false); } }
}
async function sendCommand(command) {
  if (!snapshot || reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const missionId = snapshot.value.id;
  const ok = await write('/missions/' + encodeURIComponent(missionId) + '/commands',{commandId:crypto.randomUUID(),expectedRevision:snapshot.revision,command},missionId,command.type === 'quarantine-runtime' ? 'Work permanently quarantined. External outcomes remain unresolved; no run was replayed.' : command.type === 'cancel' ? 'Cancellation recorded.' : 'Steering instruction recorded. Inspect the current execution state below.');
  if (ok && command.type === 'steer') { drafts.delete(command.workId); renderMission(); }
}
$('mission-form').addEventListener('submit', async event => {
  event.preventDefault(); if (reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const purpose = $('purpose').value.trim(), scope = $('scope').value.trim(), description = $('criteria').value.trim();
  if (!purpose || !scope || !description) { report('Purpose, scope and success criteria are required.','error'); return; }
  const id = 'mission:' + crypto.randomUUID();
  const body = {id,commandId:crypto.randomUUID(),purpose,scope,constraints:$('constraints').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean),criteria:{version:1,description,oracle:$('criteria-oracle').value || 'manual-review/v1'}};
  if (await write('/missions',body,id,'Mission created.')) $('mission-form').reset();
});
$('work-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!snapshot || reconnectRequired || busy || loading || unknownOperation || recoveryProblem) return;
  const title = $('work-title').value.trim(), budgetText = $('work-budget').value, budget = Number(budgetText);
  if (!title || !budgetText || !Number.isFinite(budget) || budget < 0) { report('Enter a Work title and a nonnegative finite budget.','error'); return; }
  const id = snapshot.value.id;
  const body = {commandId:crypto.randomUUID(),expectedRevision:snapshot.revision,workId:'work:' + crypto.randomUUID(),title,budget};
  if (await write('/missions/' + encodeURIComponent(id) + '/work',body,id,'Work admitted. No model execution was started.')) $('work-form').reset();
});
$('load-form').addEventListener('submit', event => { event.preventDefault(); if (!busy) void loadMission($('mission-id').value.trim()); });
$('run-fixture').addEventListener('click', async () => {
  if (reconnectRequired || busy || loading || unknownOperation || recoveryProblem || fixtureUnknown) return;
  busy = true; controls();
  if (!await claimFixture()) { busy = false; controls(); return; }
  controls(); report('Running the separate controlled development fixture. Real local file and process effects are in flight…');
  try {
    const {response, body} = await request('/fixture-run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},120000);
    if (response.status >= 500) throw new Error(body.error || 'The fixture outcome was not confirmed.');
    if (!response.ok) { await clearFixture(); report('Fixture rejected: ' + (body.error || 'HTTP ' + response.status),'error'); return; }
    if (typeof body.missionId !== 'string') throw new Error('No fixture Mission ID was returned.');
    await clearFixture();
    const loaded = await loadMission(body.missionId,false); if (loaded) report('Controlled fixture returned. Inspect its Mission and fixture-class Records.','success');
  } catch (error) {
    report('Fixture outcome unknown: ' + error.message + ' Do not restart it blindly. Inspect durable activity and the host logs to find its Mission.','warning');
    fixtureUnknown = true;
  } finally { busy = false; controls(); }
});
let connectionCatalog=null,connectionSequence=0,connectionBusy=false,connectionDiscovery=null,connectionReading=false;
const connectionButtons=new Set();
function connectionLocked(){return reconnectRequired||busy||loading||!!unknownOperation||!!recoveryProblem||!!snapshot?.value.works.some(work=>work.execution==='active'||work.effects.some(effect=>effect.status==='pending'||effect.status==='unknown'));}
function connectionControls(){const locked=connectionBusy||connectionLocked();for(const button of connectionButtons)button.disabled=locked;$('connection-fields').disabled=connectionLocked()||connectionBusy&&!connectionReading||!connectionCatalog||!!connectionCatalog.host?.managed;}
function installConnections(body){
 if(!body||!Array.isArray(body.providerTypes)||!Array.isArray(body.connections)||!body.runtime||!Array.isArray(body.runtime.connections)||!Array.isArray(body.runtime.authorizations))throw new Error('Invalid connection catalog');
 connectionCatalog=body;runtimeConfiguration=body.runtime;executionDrafts.clear();providerNotice();if(snapshot)renderMission();renderConnections();
}
function connectionField(form,title,node){const lab=element('label',title);if(node.id)lab.htmlFor=node.id;form.append(lab,node);return node;}
async function connectionWrite(path,body){const {response,body:result}=await request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)},20000);if(!response.ok)throw new Error(result.error||'Connection request failed');return result;}
function renderConnections(){
 const area=$('connection-list');area.replaceChildren();connectionButtons.clear();if(!connectionCatalog)return;
 for(const c of connectionCatalog.connections){
  const card=element('div',undefined,'work-card');card.append(element('h3',c.label),element('p',c.protocol+' · '+c.auth+' · '+c.connectionStatus+' · live execution not verified','hint'));
  const discover=element('button','Explore models');discover.type='button';connectionButtons.add(discover);discover.className='secondary';discover.disabled=connectionBusy;const notice=element('p',c.discovery==='discovery-failed'?'Discovery unavailable; enter an exact model manually.':'Model metadata is not proof of inference or model quality.','hint');
  discover.addEventListener('click',async()=>{if(connectionBusy||connectionLocked())return;const sequence=++connectionSequence;connectionReading=true;connectionBusy=true;connectionControls();connectionDiscovery?.abort();const controller=new AbortController();connectionDiscovery=controller;discover.disabled=true;notice.textContent='Reading provider model metadata…';try{const {response,body}=await request('/connections/'+encodeURIComponent(c.id)+'/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedConfigHash:c.configHash}),signal:controller.signal},20000);if(sequence!==connectionSequence)return;if(!response.ok)throw new Error(body.error||'Discovery failed');notice.textContent=body.message;if(body.status==='stale')return;const current=connectionCatalog.connections.find(x=>x.id===c.id&&x.configHash===c.configHash);if(current){current.models=body.models;current.discovery=body.status==='listed'?'models-discovered':'discovery-failed';populate();}}catch(error){if(sequence===connectionSequence)notice.textContent='Model discovery unavailable. Enter an exact model ID manually.';}finally{if(sequence===connectionSequence){connectionReading=false;connectionBusy=false;connectionControls();}}});card.append(discover,notice);
  const form=element('form');form.className='model-connect-form';const models=element('select');models.id='discovered-'+c.id;const model=element('input');model.id='manual-model-'+c.id;model.required=true;model.maxLength=256;const name=element('input');name.id='model-label-'+c.id;name.required=true;name.maxLength=512;
  function populate(){models.replaceChildren();const empty=element('option','Choose discovered model or enter manually');empty.value='';models.append(empty);for(const m of c.models){const option=element('option',m.label+' · '+m.id);option.value=m.id;models.append(option);}}
  populate();models.addEventListener('change',()=>{model.value=models.value;name.value=c.label+' / '+models.value;});connectionField(form,'Discovered models',models);connectionField(form,'Exact model ID (manual fallback)',model);connectionField(form,'Model connection name',name);const save=element('button','Use this model');save.type='submit';connectionButtons.add(save);form.append(save);form.addEventListener('submit',async event=>{event.preventDefault();if(connectionBusy||connectionLocked())return;connectionBusy=true;connectionControls();save.disabled=true;try{installConnections(await connectionWrite('/connections/'+encodeURIComponent(c.id)+'/profiles',{model:model.value,label:name.value,expectedConfigHash:c.configHash}));$('connection-status').textContent='Model configuration saved. Choose executor/reviewer roles and explicit permitted use before running.';}catch(error){notice.textContent=error.message;}finally{connectionBusy=false;connectionControls();}});card.append(form);area.append(card);
 }
 if(connectionCatalog.runtime.connections.length){
  const form=element('form');form.className='connection-authorization-form';form.append(element('h3','Permit selected models for a Mission scope'));const exec=element('select'),verify=element('select');exec.id='grant-executor';verify.id='grant-verifier';for(const field of [exec,verify]){const blank=element('option','Choose exact model connection');blank.value='';field.append(blank);for(const p of connectionCatalog.runtime.connections){const option=element('option',p.label+(p.diagnostics.length?' · credential or configuration required':''));option.value=p.id;option.disabled=p.diagnostics.length>0;field.append(option);}}connectionField(form,'Executor',exec);connectionField(form,'Independent verifier',verify);const scope=element('input');scope.id='grant-scope';scope.value=snapshot?.value.scope||$('scope').value;scope.required=true;connectionField(form,'Mission scope',scope);const cap=element('input');cap.id='grant-cap';cap.type='number';cap.value='1024';cap.min='1';cap.max='4096';cap.required=true;connectionField(form,'Maximum output tokens per call',cap);const button=element('button','Permit these models for this scope');button.type='submit';connectionButtons.add(button);form.append(button,element('p','Permission does not run a model. Cost and total token usage remain unknown. Live execution also requires a separately authorized host integration.','hint'));form.addEventListener('submit',async event=>{event.preventDefault();if(connectionBusy||connectionLocked())return;connectionBusy=true;connectionControls();button.disabled=true;try{installConnections(await connectionWrite('/connection-authorizations',{id:'authorization:'+crypto.randomUUID(),scope:scope.value,executorProfileId:exec.value,verifierProfileId:verify.value,maxOutputTokensPerCall:Number(cap.value),expectedConfigHash:connectionCatalog.configHash}));$('connection-status').textContent='Scoped permission saved. Open a Work, check the selection and request its run explicitly.';}catch(error){$('connection-status').textContent=error.message;}finally{connectionBusy=false;connectionControls();}});area.append(form);
 }
 connectionControls();
}
async function refreshConnections(){try{const {response,body}=await request('/connections');if(!response.ok)throw new Error('Setup not enabled');installConnections(body);$('connection-form').hidden=!!body.host?.managed;$('connection-heading').textContent=body.host?.managed?'Host model connections':'Connect a model provider';const kind=$('connection-kind');kind.replaceChildren();for(const p of body.providerTypes){const option=element('option',p.label);option.value=p.id;kind.append(option);}kind.value=body.providerTypes[0]?.id||'';$('connection-base').value=body.providerTypes[0]?.baseUrl||'';const mode=$('connection-mode');mode.replaceChildren();for(const value of body.fixtureModeEnabled?['https','local-http-mock']:['https']){const option=element('option',value==='https'?'HTTPS API':'Local test fixture (not live verification)');option.value=value;mode.append(option);}mode.value='https';connectionControls();$('connection-status').textContent=body.host?.managed?'Host manifest '+body.host.revision+' loaded. '+(body.liveExecutionEnabled?'Live capability enabled; scoped permission and explicit Run still required.':'Live model calls disabled.')+' Destinations and models are host-declared; edit the manifest and restart to change them.':'Connection setup ready. Credentials are host-owned; live model execution has not been verified.';}catch{$('connection-fields').disabled=true;$('connection-status').textContent='Connection setup is not enabled by this host.';}}
$('connection-kind').addEventListener('change',()=>{if(connectionLocked()||connectionBusy&&!connectionReading)return;++connectionSequence;connectionDiscovery?.abort();connectionReading=false;connectionBusy=false;connectionControls();const p=connectionCatalog?.providerTypes.find(p=>p.id===$('connection-kind').value);$('connection-base').value=p?.baseUrl||'';executionDrafts.clear();if(snapshot)renderMission();renderConnections();});
$('connection-form').addEventListener('submit',async event=>{event.preventDefault();if(connectionBusy||connectionLocked()||!connectionCatalog||connectionCatalog.host?.managed)return;++connectionSequence;connectionDiscovery?.abort();connectionBusy=true;connectionControls();$('connection-fields').disabled=true;try{const value={id:'connection:'+crypto.randomUUID(),label:$('connection-label').value,providerType:$('connection-kind').value,baseUrl:$('connection-base').value,mode:$('connection-mode').value};if($('connection-reference').value)value.secretRef=$('connection-reference').value;installConnections(await connectionWrite('/connections',value));$('connection-reference').value='';$('connection-status').textContent='Connection metadata saved. Explore models or enter a model manually. Live inference remains unverified.';}catch(error){$('connection-status').textContent=error.message;}finally{connectionBusy=false;connectionControls();}});

function requireReconnect() { reconnectRequired = true; ++connectionEpoch; controls(); }
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
