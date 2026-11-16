import test from 'node:test';
import assert from 'node:assert/strict';
import {judgeRun} from '../scripts/smoke-codex-tools-off.mjs';

// Recorded-stream shape of codex exec --json; only the pure judging function is tested here
// (the script's process-spawning part is run by hand and stays untested).
const base = {exitCode: 0, stderr: '', marker: 'MARK-test', dirBefore: ['marker.txt'], dirAfter: ['marker.txt']};
const stream = (items: Record<string, unknown>[]) => [{type: 'thread.started', thread_id: 't'},
  ...items.map((item, i) => ({type: 'item.completed', item: {id: 'i' + i, ...item}})),
  {type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}].map(e => JSON.stringify(e)).join('\n');

test('smoke judging passes a clean stream, fails a collab tool call, fails a leaked marker, and reports a usage limit as not run', () => {
  const clean = judgeRun({...base, stdout: stream([{type: 'agent_message', text: 'OK'}])});
  assert.equal(clean.status, 'pass');
  assert.deepEqual(clean.reasons, []);
  assert.equal(clean.verdict.status, 'completed');
  const collab = judgeRun({...base, stdout: stream([{type: 'collab_tool_call', tool: 'spawn_agent'}, {type: 'agent_message', text: 'OK'}])});
  assert.equal(collab.status, 'fail');
  assert.ok(collab.reasons.some(r => r.includes('collab_tool_call')));
  const leak = judgeRun({...base, stdout: stream([{type: 'agent_message', text: 'the marker is MARK-test'}])});
  assert.equal(leak.status, 'fail');
  assert.ok(leak.reasons.some(r => r.includes('marker')));
  assert.equal(leak.markerLeaked, true);
  const created = judgeRun({...base, dirAfter: ['marker.txt', 'created.txt'], stdout: stream([{type: 'agent_message', text: 'OK'}])});
  assert.equal(created.status, 'fail');
  assert.ok(created.reasons.some(r => r.includes('created.txt')));
  const limit = judgeRun({...base, stdout: '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit; try again at 1:45 AM"}}'});
  assert.equal(limit.status, 'not-run');
  assert.match(limit.usageLimitLine ?? '', /usage limit/i);
  const silent = judgeRun({...base, stdout: ''});
  assert.equal(silent.status, 'fail');
  assert.ok(silent.reasons.some(r => r.includes('no stream events')));
});
