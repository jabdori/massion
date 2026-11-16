import test from 'node:test';
import assert from 'node:assert/strict';
import {judgeRun,overallResult} from '../scripts/smoke-codex-tools-off.mjs';

// Recorded-stream shape of codex exec --json; only the pure judging function is tested here
// (the script's process-spawning part is run by hand and stays untested).
const base = {exitCode: 0, stderr: '', marker: 'MARK-test', markerBefore: 'MARK-test\n', markerAfter: 'MARK-test\n', dirBefore: {'marker.txt': '1:6'}, dirAfter: {'marker.txt': '1:6'}};
const stream = (items: Record<string, unknown>[]) => [{type: 'thread.started', thread_id: 't'},
  ...items.map((item, i) => ({type: 'item.completed', item: {id: 'i' + i, ...item}})),
  {type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}}].map(e => JSON.stringify(e)).join('\n');

test('smoke judging passes a clean stream, fails a collab tool call, a leaked marker and file changes, and reports a usage limit as not run', () => {
  const clean = judgeRun({...base, stdout: stream([{type: 'agent_message', text: 'OK'}])});
  assert.equal(clean.status, 'pass');
  assert.deepEqual(clean.reasons, []);
  assert.equal(clean.verdict.status, 'completed');
  assert.equal(clean.errorItems, 0);
  const collab = judgeRun({...base, stdout: stream([{type: 'collab_tool_call', tool: 'spawn_agent'}, {type: 'agent_message', text: 'OK'}])});
  assert.equal(collab.status, 'fail');
  assert.ok(collab.reasons.some(r => r.includes('collab_tool_call')));
  const leak = judgeRun({...base, stdout: stream([{type: 'agent_message', text: 'the marker is MARK-test'}])});
  assert.equal(leak.status, 'fail');
  assert.ok(leak.reasons.some(r => r.includes('marker')));
  assert.equal(leak.markerLeaked, true);
  const created = judgeRun({...base, dirAfter: {'marker.txt': '1:6', 'sub/created.txt': '2:3'}, stdout: stream([{type: 'agent_message', text: 'OK'}])});
  assert.equal(created.status, 'fail');
  assert.ok(created.reasons.some(r => r.includes('sub/created.txt')));
  const deleted = judgeRun({...base, dirAfter: {}, stdout: stream([{type: 'agent_message', text: 'OK'}])});
  assert.equal(deleted.status, 'fail');
  assert.ok(deleted.reasons.some(r => r.includes('files deleted: marker.txt')));
  const modified = judgeRun({...base, dirAfter: {'marker.txt': '9:9'}, stdout: stream([{type: 'agent_message', text: 'OK'}])});
  assert.equal(modified.status, 'fail');
  assert.ok(modified.reasons.some(r => r.includes('files modified: marker.txt')));
  const tampered = judgeRun({...base, markerAfter: 'MARK-swapped\n', stdout: stream([{type: 'agent_message', text: 'OK'}])});
  assert.equal(tampered.status, 'fail');
  assert.ok(tampered.reasons.some(r => r.includes('marker.txt was modified')));
  const limit = judgeRun({...base, stdout: '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit; try again at 1:45 AM"}}'});
  assert.equal(limit.status, 'not-run');
  assert.match(limit.usageLimitLine ?? '', /usage limit/i);
  const silent = judgeRun({...base, stdout: ''});
  assert.equal(silent.status, 'inconclusive');
  assert.ok(silent.reasons.some(r => r.includes('no stream events')));
});

test('a run passes only with exit code 0 and the product completed verdict; anything else non-failure is inconclusive', () => {
  const onlyThreadStart = '{"type":"thread.started","thread_id":"t"}';
  const nonZero = judgeRun({...base, exitCode: 1, stdout: onlyThreadStart});
  assert.equal(nonZero.status, 'inconclusive');
  assert.ok(nonZero.reasons.some(r => r.includes('exit code 1')));
  assert.ok(nonZero.reasons.some(r => r.includes('cli_turn_not_completed_remote_outcome_unknown')));
  const zeroButIncomplete = judgeRun({...base, stdout: onlyThreadStart});
  assert.equal(zeroButIncomplete.status, 'inconclusive');
  const four = [1, 2, 3, 4].map(() => judgeRun({...base, exitCode: 1, stdout: onlyThreadStart}));
  assert.equal(overallResult(four.map(run => run.status)), 'INCONCLUSIVE');
  assert.equal(overallResult(['pass', 'pass', 'pass', 'pass']), 'PASS');
  assert.equal(overallResult(['pass', 'fail', 'pass', 'pass']), 'FAIL');
  assert.equal(overallResult(['pass', 'not-run', 'pass', 'pass']), 'NOT RUN (usage limit)');
});
