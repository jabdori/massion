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
if (!snap || typeof snap.data?.snapshot === 'string') snap = { ...snap, tree: parseText(snap ? snap.data.snapshot : raw) };
/** agent-browser snapshot text: '  - role "name" [attrs]' per line, two spaces per level. */
function parseText(text) {
  const root = { role: 'webarea', children: [] }, stack = [[-1, root]];
  for (const line of text.split('\n')) {
    const m = /^(\s*)- ([A-Za-z]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(?::\s*(.*))?/.exec(line);
    if (!m) continue;
    const depth = m[1].length / 2, attrs = m[4] || '';
    const node = { role: m[2].toLowerCase(), name: m[3] !== undefined ? JSON.parse('"' + m[3] + '"') : m[5] || '', children: [] };
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
const tree = (function walk(n, region, depth, path) {
  const r = n.role;
  if (region === 'header' && seenMain && depth > 0 && r !== 'complementary') region = 'pane'; // outside landmarks, after main: the work pane
  if (r === 'navigation' && region === 'header') region = 'rail';
  else if (r === 'complementary') region = asides++ === 0 && !/업무|작업 공간/.test(n.name || '') ? 'sidebar' : 'pane';
  else if (r === 'main' && (seenMainNext = true)) region = /^설정/.test(n.name || '') ? 'page' : has(n, (x) => TEXTBOX.has(x.role)) ? 'main' : 'page';
  else if (r === 'alertdialog' || r === 'dialog') region = 'dialog';
  else if (r === 'log' && region === 'main') region = 'log';
  const node = { role: r, name: (n.name || n.value || '').trim(), desc: (n.description || '').trim(), region, path, children: [] };
  if (depth > 0) nodes.push(node);
  node.children = (n.children || []).map((child, index) => walk(child, region, depth + 1, path + '.' + index));
  if (seenMainNext && r === 'main') seenMain = true;
  return node;
})(web, 'header', 0, '0');
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
const inRegion = (region, actual) => (ALIAS[region] || [region]).includes(actual) || region.startsWith('dialog') && actual === 'dialog';
const visibleTextBudget = snap.visibleTextBudget;
if (visibleTextBudget !== undefined) {
  const known = new Set([...Object.keys(ALIAS), 'dialog', ...contract.regions.map(region => region.region)]);
  const valid = visibleTextBudget && typeof visibleTextBudget === 'object' && !Array.isArray(visibleTextBudget)
    && Object.entries(visibleTextBudget).every(([region, texts]) => known.has(region) && Array.isArray(texts) && texts.every(text => typeof text === 'string' && text.trim().length > 0))
    && Object.keys(contract.text_budget || {}).every(region => Object.hasOwn(visibleTextBudget, region));
  if (!valid) { console.error('invalid visibleTextBudget: expected arrays of nonempty strings for known regions, including every contract budget region'); process.exit(2); }
}

// Canonical occurrences belong to tree positions; container labels are only views.
const views = [];
const STRUCTURAL = new Set(['webarea', 'document', 'window', 'application', 'navigation', 'main', 'complementary', 'region', 'log', 'form', 'list', 'group', 'generic', 'sectionheader', 'tablist', 'toolbar', 'menu', 'menubar', 'tree']);
function buildOccurrences(node) {
  const children = node.children.flatMap(buildOccurrences);
  function view(text, field, aliases, allowOwn) {
    const spans = []; let from = 0;
    const own = end => {
      const raw = text.slice(from, end), label = raw.trim(), start = from + raw.indexOf(label);
      if (!allowOwn || !label || aliases.length && /^[·•|;\s]+$/.test(label)) return;
      const occurrence = { id: node.path + '/' + field + ':' + start, text: label, node };
      spans.push({ start, end: start + label.length, occurrence });
    };
    const mapped = [];
    // Longest labels first avoid treating a sibling's prefix as its full alias.
    for (const occurrence of [...aliases].sort((a, b) => b.text.length - a.text.length)) {
      let start = text.indexOf(occurrence.text);
      while (start >= 0 && mapped.some(span => start < span.end && start + occurrence.text.length > span.start)) start = text.indexOf(occurrence.text, start + 1);
      if (start >= 0) mapped.push({ start, end: start + occurrence.text.length, occurrence });
    }
    for (const span of mapped.sort((a, b) => a.start - b.start)) { own(span.start); spans.push(span); from = span.end; }
    own(text.length);
    const result = { text, node, spans, field }; if (text && spans.length) views.push(result);
    return result;
  }
  const name = view(node.name, 'name', children, !STRUCTURAL.has(node.role));
  const slots = Array.from({ length: children.length + 1 }, () => []);
  for (let i = 0; i < name.spans.length; i++) {
    const span = name.spans[i]; if (children.includes(span.occurrence)) continue;
    const following = name.spans.slice(i + 1).find(span => children.includes(span.occurrence));
    const preceding = name.spans.slice(0, i).findLast(span => children.includes(span.occurrence));
    const slot = following ? children.indexOf(following.occurrence) : preceding ? children.indexOf(preceding.occurrence) + 1 : 0;
    slots[slot].push(span.occurrence);
  }
  const ordered = children.flatMap((child, index) => [...slots[index], child]).concat(slots.at(-1));
  if (node.desc) view(node.desc, 'description', ordered, false);
  if (node.role === 'status' && has(node, child => CONTROL.has(child.role))) view(children.map(child => child.text).join(' '), 'content', children, false);
  return ordered;
}
function segments(text) {
  const result = []; let from = 0;
  const append = end => { const raw = text.slice(from, end), label = raw.trim(); if (label) result.push({ text: label, start: from + raw.indexOf(label), end: from + raw.indexOf(label) + label.length }); };
  for (const delimiter of text.matchAll(/[·•|;\n]+/g)) { append(delimiter.index); from = delimiter.index + delimiter[0].length; }
  append(text.length);
  return result.length ? result : text.trim() ? [{ text: text.trim(), start: text.indexOf(text.trim()), end: text.trimEnd().length }] : [];
}
const occurrences = buildOccurrences(tree), units = [];
for (const occurrence of occurrences) occurrence.units = segments(occurrence.text).map(segment => {
  const unit = { ...segment, occurrence, id: occurrence.id + ':' + segment.start, order: units.length }; units.push(unit); return unit;
});
function references(view, start = 0, end = view.text.length) {
  const found = new Set();
  for (const span of view.spans) for (const unit of span.occurrence.units)
    if (span.start + unit.start < end && span.start + unit.end > start) found.add(unit);
  return [...found].sort((a, b) => a.order - b.order);
}

function represented(view, start, end) {
  let from = start;
  for (const span of view.spans) {
    if (span.end <= start || span.start >= end) continue;
    if (/[^·•|;\s]/.test(view.text.slice(from, Math.min(span.start, end)))) return false;
    from = Math.max(from, span.end);
  }
  return !/[^·•|;\s]/.test(view.text.slice(from, end));
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PH = { member: '[가-힣]{1,8}', work_title: '.+', content: '.+', time: '(?:오전|오후)? ?\\d{1,2}:\\d{2}',
  date: '\\d{1,2}월 \\d{1,2}일(?: \\([월화수목금토일]\\))?', duration: '(?:\\d+시간(?: ?\\d+분)?(?: ?\\d+초)?|\\d+분(?: ?\\d+초)?|\\d+초)',
  amount: '[\\d,]+원', progress: '\\d+/\\d+', count: '\\d+(?:건|개|곳|번|회|명)' };
const body = text => text.split(/(\{[a-z_]+\})/).map(part => { const match = /^\{([a-z_]+)\}$/.exec(part); return match ? `(?:${PH[match[1]] || '.+'})` : esc(part); }).join('');
const TEXT_ROLES = new Set(['text', 'chip', 'status']);
const STATUS = [...new Set(contract.regions.flatMap(region => region.elements.filter(el => ['status', 'chip'].includes(el.role) && !el.text.includes('{')).map(el => el.text)))];
function roleMatches(role, node) {
  if (TEXT_ROLES.has(role)) return true;
  if (role === 'textbox') return TEXTBOX.has(node.role);
  return ROLES[role] ? ROLES[role].has(node.role) : node.role === role || role === 'radio' && node.role === 'radiobutton';
}
function candidates(el) {
  const standalone = /^\{[a-z_]+\}$/.test(el.text), structural = !TEXT_ROLES.has(el.role);
  const full = new RegExp('^' + body(el.text) + '$'), sub = new RegExp(body(el.text)), result = [], seen = new Set();
  const hit = text => {
    if (standalone || el.role === 'textbox') return full.test(text) ? { index: 0, length: text.length } : null;
    if (CONTRACT_CONTROLS.has(el.role)) {
      const stripped = STATUS.reduce((value, status) => value.replace(status, ' '), text).replace(/\s+/g, ' ').trim();
      const tail = new RegExp('(?:^|\\s)' + body(el.text) + '$');
      return full.test(text) || full.test(stripped) || tail.test(text) || el.visible_text === text ? { index: 0, length: text.length } : null;
    }
    const match = sub.exec(text); return match?.[0].length ? { index: match.index, length: match[0].length } : null;
  };
  const add = (refs, node, text, consumed = refs) => {
    if (!refs.length) return;
    const key = (structural ? node.path + ':' : '') + refs.map(unit => unit.id).join(',');
    if (seen.has(key)) return; seen.add(key);
    const anchor = el.role === 'listbox';
    const first = anchor ? units.find(unit => unit.occurrence.node.path === node.path || unit.occurrence.node.path.startsWith(node.path + '.')) : consumed[0];
    const start = first.order - (anchor ? 0.5 : 0);
    result.push({ units: refs, node, text, start, end: anchor ? start : consumed.at(-1).order });
  };
  for (const view of views) {
    if (!roleMatches(el.role, view.node)) continue;
    const compoundStatus = el.role === 'status' && view.node.role === 'status' && has(view.node, child => CONTROL.has(child.role));
    if (compoundStatus && view.field !== 'content') continue;
    for (const unit of references(view)) if (hit(unit.text)) add([unit], view.node, unit.text);
    if (standalone) continue;
    for (const segment of [...segments(view.text), { text: view.text, start: 0 }]) {
      const match = hit(segment.text);
      if (match && represented(view, segment.start + match.index, segment.start + match.index + match.length)) {
        const refs = references(view, segment.start + match.index, segment.start + match.index + match.length);
        const action = compoundStatus ? refs.findIndex(unit => has(view.node, child => CONTROL.has(child.role) && (unit.occurrence.node.path === child.path || unit.occurrence.node.path.startsWith(child.path + '.')))) : -1;
        add(refs, view.node, segment.text, action > 0 ? refs.slice(0, action) : refs);
      }
    }
  }
  if (!standalone && TEXT_ROLES.has(el.role)) for (let i = 0; i < units.length; i++) {
    const parts = []; let text = '';
    for (const unit of units.slice(i)) {
      if (!TEXTY.has(unit.occurrence.node.role) || parts.some(part => part.unit.occurrence === unit.occurrence)) break;
      if (text) text += ' '; parts.push({ unit, start: text.length }); text += unit.text;
      if (parts.length < 2) continue;
      const match = hit(text); if (!match) continue;
      const refs = parts.filter(part => part.start < match.index + match.length && part.start + part.unit.text.length > match.index).map(part => part.unit);
      add(refs, refs[0].occurrence.node, text); break;
    }
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}

const fails = [], warns = [], rows = [];
for (const reg of contract.regions) {
  const usedNodes = new Set(); let last = -1;
  for (const el of reg.elements) {
    if (!el.required) continue;
    const label = `${reg.region.padEnd(12)} ${el.role.padEnd(8)} ${JSON.stringify(el.text)}`;
    const all = candidates(el), pool = all.filter(candidate => candidate.units.every(unit => inRegion(reg.region, unit.occurrence.node.region)));
    const after = pool.find(candidate => candidate.start > last && (TEXT_ROLES.has(el.role) || !usedNodes.has(candidate.node.path)));
    if (after) {
      if (!TEXT_ROLES.has(el.role)) usedNodes.add(after.node.path);
      last = after.end; rows.push(`  ok    ${label} -> ${after.node.role} ${JSON.stringify(after.text)}`); continue;
    }
    if (pool.length) fails.push(`order  ${label} (occurrence already consumed or found earlier)`);
    else if (all.length) fails.push(`region ${label} (found in ${all[0].units[0].occurrence.node.region})`);
    else if (candidates({ ...el, role: 'text' }).length) fails.push(`role   ${label} (text exists without the required role)`);
    else fails.push(`missing ${label}`);
  }
}

// Forbidden hits and budgets use the same canonical occurrence identities.
for (const pattern of contract.forbidden || []) {
  const seen = new Set();
  const record = (occurrence, text) => {
    if (seen.has(occurrence.id)) return; seen.add(occurrence.id);
    fails.push(`forbidden /${pattern}/ in ${occurrence.node.region}: ${occurrence.node.role} ${JSON.stringify(text.slice(0, 90))}`);
  };
  for (const occurrence of occurrences) for (const text of [occurrence.text, ...occurrence.units.map(unit => unit.text)])
    if (new RegExp(pattern).test(text)) record(occurrence, text);
  for (const view of views) {
    const rx = new RegExp(pattern, 'g');
    for (let match; (match = rx.exec(view.text));) {
      if (!match[0].length) { rx.lastIndex++; continue; }
      const end = rx.lastIndex;
      if (represented(view, match.index, end)) for (const unit of references(view, match.index, end)) record(unit.occurrence, view.text);
      rx.lastIndex = match.index + 1;
    }
  }
}
const isSentence = text => text.length >= 12 && text.includes(' ') && /[.?!]$|(?<!필)요$|(?:다|죠|까)$/.test(text);
const SHELL = new Set(['rail', 'sidebar', 'header', 'composer']);
for (const [region, budget] of Object.entries(contract.text_budget || {})) {
  const texts = visibleTextBudget === undefined ? occurrences.filter(occurrence => inRegion(region, occurrence.node.region)).map(occurrence => occurrence.text) : visibleTextBudget[region];
  const got = { chars: texts.reduce((sum, text) => sum + text.length, 0), strings: texts.length, sentences: texts.filter(isSentence).length, longest: Math.max(0, ...texts.map(text => text.length)) };
  const out = SHELL.has(region) || region === 'pane' ? fails : warns, tag = `budget ${region.padEnd(12)}`;
  if (got.sentences > budget.sentences) out.push(`${tag} sentences ${got.sentences} > ${budget.sentences}: ${JSON.stringify(texts.find(isSentence).slice(0, 90))}`);
  if (got.longest > Math.max(budget.longest * 1.25, 24)) out.push(`${tag} longest string ${got.longest} > ${Math.round(Math.max(budget.longest * 1.25, 24))} chars`);
  if (got.chars > budget.chars * 1.3 + 20) out.push(`${tag} chars ${got.chars} > ${Math.round(budget.chars * 1.3 + 20)}`);
  rows.push(`  budget ${region.padEnd(12)} app ${JSON.stringify(got)} proto ${JSON.stringify(budget)}${visibleTextBudget === undefined ? '' : ' source visibleTextBudget'}`);
}
if (visibleTextBudget === undefined && !nodes.some(node => ['statictext', 'text'].includes(node.role))) warns.push('snapshot has no explicit text nodes; budgets use accessible-label fallbacks.');
console.log(`contract ${contract.artboard} (${contract.title}) vs ${snapPath}`);
rows.forEach(row => console.log(row)); warns.forEach(warning => console.log('  warn  ' + warning)); fails.forEach(failure => console.log('  FAIL  ' + failure));
const required = contract.regions.reduce((sum, region) => sum + region.elements.filter(el => el.required).length, 0);
console.log(`${fails.length ? 'FAIL' : 'PASS'}: ${fails.length} failures, ${warns.length} warnings, ${required} required elements`);
process.exit(fails.length ? 1 : 0);
