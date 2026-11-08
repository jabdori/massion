#!/usr/bin/env node
// Usage: node contract-check.mjs <snapshot> <contract.json>
// <snapshot>: agent-browser 'snapshot -c' text (or its --json output), or an agent-desktop snapshot JSON.
// Checks an app accessibility snapshot against a screen contract: required elements per region and order,
// forbidden strings, and the per-region text budget. Exits 1 on any failure. No dependencies.
import { readFileSync } from 'node:fs';

const [snapPath, contractPath] = process.argv.slice(2);
if (!snapPath || !contractPath) { console.error('usage: node contract-check.mjs <snapshot.json> <contract.json>'); process.exit(2); }
const raw = readFileSync(snapPath, 'utf8');
let snap;
try { snap = JSON.parse(raw); } catch { snap = null; }
if (!snap || typeof snap.data?.snapshot === 'string') snap = { tree: parseText(snap ? snap.data.snapshot : raw) };
/** agent-browser snapshot text: '  - role "name" [attrs]' per line, two spaces per level. */
function parseText(text) {
  const root = { role: 'webarea', children: [] }, stack = [[-1, root]];
  for (const line of text.split('\n')) {
    const m = /^(\s*)- ([A-Za-z]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(?::\s*(.*))?/.exec(line);
    if (!m) continue;
    const depth = m[1].length / 2, attrs = m[4] || '';
    const node = { role: m[2].toLowerCase(), name: (m[3] ?? m[5] ?? '').replace(/\\"/g, '"'), children: [] };
    const checked = /checked=(\w+)/.exec(attrs); if (checked) node.value = undefined;
    while (stack.length && stack[stack.length - 1][0] >= depth) stack.pop();
    stack[stack.length - 1][1].children.push(node); stack.push([depth, node]);
  }
  return root;
}
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));

const CONTROL = new Set(['disclosuretrianglegrouped', 'disclosuretriangle', 'button', 'link', 'checkbox', 'switch', 'combobox', 'menuitem', 'menuitemradio', 'tab', 'option', 'menuitemcheckbox', 'radiobutton', 'popupbutton', 'menubutton', 'disclosuretriangle', 'togglebutton']);
// contract role -> AX roles that may carry it (apps often use buttons for navigation rows)
const ROLES = { link: new Set(['link', 'button']), switch: new Set(['switch', 'checkbox', 'button', 'togglebutton']), tab: new Set(['tab', 'button', 'radiobutton']) };
const TEXTBOX = new Set(['searchbox', 'textfield', 'textarea', 'textbox', 'searchfield', 'combobox']);
const TEXTY = new Set(['statictext', 'heading', 'text']);
const CONTRACT_CONTROLS = new Set(['link', 'button', 'switch', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'checkbox', 'radio', 'option']);

// ---- flatten the tree with a region per node ----
const root = snap.data?.tree ?? snap.tree ?? snap;
const find = (n, role) => n.role === role ? n : (n.children || []).reduce((a, c) => a || find(c, role), null);
const web = find(root, 'webarea') || root;
const has = (n, pred) => pred(n) || (n.children || []).some((c) => has(c, pred));
const nodes = [];
let asides = 0, seenMain = false, seenMainNext = false;
(function walk(n, region, depth) {
  const r = n.role;
  if (region === 'header' && seenMain && depth > 0 && r !== 'complementary') region = 'pane'; // outside landmarks, after main: the work pane
  if (r === 'navigation' && region === 'header') region = 'rail';
  else if (r === 'complementary') region = asides++ === 0 && !/업무|작업 공간/.test(n.name || '') ? 'sidebar' : 'pane';
  else if (r === 'main' && (seenMainNext = true)) region = /^설정/.test(n.name || '') ? 'settings' : has(n, (x) => TEXTBOX.has(x.role)) ? 'main' : 'page';
  else if (r === 'alertdialog' || r === 'dialog') region = 'dialog';
  else if (r === 'log' && region === 'main') region = 'log';
  if (depth > 0) nodes.push({ role: r, name: (n.name || n.value || '').trim(), desc: (n.description || '').trim(), hasTextChildren: (n.children || []).some(c => has(c, x => TEXTY.has(x.role) && !!x.name)), region });
  for (const c of n.children || []) walk(c, region, depth + 1);
  if (seenMainNext && r === 'main') seenMain = true;
})(web, 'header', 0); // nodes outside landmarks = window header band
// split main by position: [header] [conversation/log] [composer from the text box on]
{
  const main = nodes.map((n, i) => i).filter((i) => nodes[i].region === 'main' || nodes[i].region === 'log');
  const box = main.find((i) => TEXTBOX.has(nodes[i].role));
  const hasLog = main.some((i) => nodes[i].region === 'log');
  // composer starts at the textbox, or at its labelling text just before it
  const start = box !== undefined && box > 0 && nodes[box - 1].role === 'statictext' && nodes[box - 1].name === nodes[box].name ? box - 1 : box;
  for (const i of main) {
    if (start !== undefined && i >= start && nodes[i].region !== 'log') nodes[i].region = 'composer';
    else if (nodes[i].region === 'log') nodes[i].region = 'conversation';
    else nodes[i].region = hasLog && i < main.find((j) => nodes[j].region === 'log' || nodes[j].region === 'conversation') ? 'header' : hasLog ? 'composer' : 'conversation';
  }
}

// contract regions -> app regions they may live in
const ALIAS = { conversation: ['conversation'], page: ['page', 'conversation', 'header', 'composer'], settings: ['settings', 'page', 'conversation', 'composer'], header: ['header'],
  rail: ['rail'], sidebar: ['sidebar'], pane: ['pane'], composer: ['composer'] };
const inRegion = (r) => nodes.map((n, i) => ({ ...n, i })).filter((n) => (ALIAS[r] || [r]).includes(n.region) || (r.startsWith('dialog') && n.region === 'dialog'));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// placeholder shapes (tolerant, but typed so '{date}' does not match any string)
const PH = { member: '[가-힣]{1,8}', work_title: '.+?', content: '.+?', time: '(?:오전|오후)? ?\\d{1,2}:\\d{2}',
  date: '\\d{1,2}월 \\d{1,2}일(?: \\([월화수목금토일]\\))?', duration: '(?:\\d+시간(?: ?\\d+분)?(?: ?\\d+초)?|\\d+분(?: ?\\d+초)?|\\d+초)',
  amount: '[\\d,]+원', progress: '\\d+/\\d+', count: '\\d+(?:건|개|곳|번|회|명)' };
const body = (text) => text.split(/(\{[a-z_]+\})/).map((p) => { const m = /^\{([a-z_]+)\}$/.exec(p); return m ? `(?:${PH[m[1]] || '.+?'})` : esc(p); }).join('');
const toRx = (text) => new RegExp('^' + body(text) + '$');
const toSub = (text) => new RegExp(body(text));

function matches(el, n) {
  const full = toRx(el.text), sub = toSub(el.text);
  const names = [n.name, n.desc].filter(Boolean);
  if (el.role === 'textbox') return TEXTBOX.has(n.role) && names.some((s) => full.test(s));
  if (CONTRACT_CONTROLS.has(el.role)) {
    // AX often folds a row's status/meta into the control name ('작업 중 퀼', '이탈 원인 조사 실행 중'): also try with those removed
    const strip = (s) => STATUS.reduce((a, t) => a.replace(t, ' '), s).replace(/\s+/g, ' ').trim();
    const tail = /^\{[a-z_]+\}$/.test(el.text) && el.text !== '{member}' ? /$^/ : new RegExp('(?:^|\\s)' + body(el.text) + '$');
    const ok = ROLES[el.role] ? ROLES[el.role].has(n.role) : n.role === el.role || el.role === 'radio' && n.role === 'radiobutton';
    return ok && names.some((s) => full.test(s) || full.test(strip(s)) || tail.test(s) || (el.visible_text && s === el.visible_text));
  }
  // Text, chips and status labels may be folded into a containing control name.
  return (['text', 'chip', 'status'].includes(el.role) || n.role === el.role) && names.some((s) => sub.test(s));
}

// Keep the consumed text position, including the real endpoint of a split label.
function locate(el, pool, last, offset) {
  const ctrl = CONTRACT_CONTROLS.has(el.role) || el.role === 'textbox';
  for (let k = 0; k < pool.length; k++) {
    const n = pool[k];
    if (n.i < last || ctrl && n.i === last) continue;
    if (ctrl) { if (matches(el, n)) return { node: n, last: n.i, offset: 0 }; continue; }
    if (matches(el, n)) for (const name of new Set([n.name, n.desc].filter(Boolean))) {
      const from = n.i === last ? offset : 0, hit = toSub(el.text).exec(name.slice(from));
      if (hit?.[0].length) return { node: n, last: n.i, offset: from + hit.index + hit[0].length };
    }
    if (!['text', 'chip', 'status'].includes(el.role) || !TEXTY.has(n.role)) continue;
    const parts = []; let joined = '';
    for (const next of pool.slice(k, k + 4)) {
      if (!TEXTY.has(next.role)) break;
      const base = next.i === last ? offset : 0, name = next.name.slice(base);
      if (!name) continue;
      if (joined) joined += ' ';
      parts.push({ node: next, start: joined.length, base }); joined += name;
    }
    if (parts.length < 2) continue;
    const hit = toSub(el.text).exec(joined);
    if (!hit?.[0].length) continue;
    const end = hit.index + hit[0].length;
    const part = parts.find((p, index) => end <= (parts[index + 1]?.start ?? joined.length)) || parts.at(-1);
    return { node: { ...n, name: joined }, last: part.node.i, offset: part.base + end - part.start };
  }
  return null;
}

const STATUS = [...new Set(contract.regions.flatMap((r) => r.elements.filter((e) => ['status', 'chip'].includes(e.role) && !e.text.includes('{')).map((e) => e.text)))];
const fails = [], warns = [], rows = [];
for (const reg of contract.regions) {
  const pool = inRegion(reg.region);
  let last = -1, offset = 0;
  for (const el of reg.elements) {
    if (!el.required) continue;
    const label = `${reg.region.padEnd(12)} ${el.role.padEnd(8)} ${JSON.stringify(el.text)}`;
    const after = locate(el, pool, last, offset);
    if (after) { last = after.last; offset = after.offset; rows.push(`  ok    ${label} -> ${after.node.role} ${JSON.stringify(after.node.name)}`); continue; }
    const before = pool.find((n) => matches(el, n));
    if (before) { fails.push(`order  ${label} (found earlier: ${before.role} ${JSON.stringify(before.name)})`); continue; }
    const anywhere = nodes.find((n) => matches(el, n));
    const loose = !anywhere && (el.text.includes('{') ? null : nodes.find((n) => [n.name, n.desc].some((s) => s && toSub(el.text).test(s))));
    if (anywhere) fails.push(`region ${label} (found in ${anywhere.region}: ${anywhere.role} ${JSON.stringify(anywhere.name)})`);
    else if (loose) fails.push(`role   ${label} (found as ${loose.role} ${JSON.stringify(loose.name)} in ${loose.region})`);
    else fails.push(`missing ${label}${pool.length ? '' : ' (region absent)'}`);
  }
}

// ---- forbidden strings ----
for (const pat of contract.forbidden || []) {
  const rx = new RegExp(pat);
  for (const n of nodes) {
    if (n.region === 'other' || n.region === 'dialog' && !n.name) continue;
    const hit = [n.name, n.desc].find((s) => s && rx.test(s));
    if (hit) fails.push(`forbidden /${pat}/ in ${n.region}: ${n.role} ${JSON.stringify(hit.length > 90 ? hit.slice(0, 90) + '…' : hit)}`);
  }
}

// ---- text budget ----
const isSentence = (s) => s.length >= 12 && s.includes(' ') && /[.?!]$|(요|다|죠|까)[.?!]?$/.test(s);
const full = nodes.some((n) => n.role === 'statictext');
const SHELL = new Set(['rail', 'sidebar', 'header', 'composer']);
for (const [region, b] of Object.entries(contract.text_budget || {})) {
  const pool = inRegion(region).filter((n) => n.name && (TEXTY.has(n.role) || CONTROL.has(n.role) && !n.hasTextChildren));
  const seen = new Set();
  const txt = pool.map((n) => n.name).filter((s) => !seen.has(s) && seen.add(s));
  const got = { chars: txt.reduce((a, s) => a + s.length, 0), strings: txt.length, sentences: txt.filter(isSentence).length, longest: Math.max(0, ...txt.map((s) => s.length)) };
  const hard = SHELL.has(region) || region === 'pane';
  const out = hard ? fails : warns;
  const tag = `budget ${region.padEnd(12)}`;
  if (got.sentences > b.sentences) out.push(`${tag} sentences ${got.sentences} > ${b.sentences}: ${JSON.stringify(txt.filter(isSentence)[0].slice(0, 90))}`);
  if (got.longest > Math.max(b.longest * 1.25, 24)) out.push(`${tag} longest string ${got.longest} > ${Math.round(Math.max(b.longest * 1.25, 24))} chars`);
  if (got.chars > b.chars * 1.3 + 20) out.push(`${tag} chars ${got.chars} > ${Math.round(b.chars * 1.3 + 20)}`);
  rows.push(`  budget ${region.padEnd(12)} app ${JSON.stringify(got)} proto ${JSON.stringify(b)}`);
}
if (!full) warns.push('snapshot has no static text (taken with -i); text budget counts control names only. Use a snapshot without -i for full text checks.');

console.log(`contract ${contract.artboard} (${contract.title}) vs ${snapPath}`);
rows.forEach((r) => console.log(r));
warns.forEach((w) => console.log('  warn  ' + w));
fails.forEach((f) => console.log('  FAIL  ' + f));
const req = contract.regions.reduce((a, r) => a + r.elements.filter((e) => e.required).length, 0);
console.log(`${fails.length ? 'FAIL' : 'PASS'}: ${fails.length} failures, ${warns.length} warnings, ${req} required elements`);
process.exit(fails.length ? 1 : 0);
