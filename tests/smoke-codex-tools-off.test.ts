import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {judgeRun,overallResult,snapshotDir} from '../scripts/smoke-codex-tools-off.mjs';
import {tempRoot} from './support/temp-root.ts';

// Recorded-stream shape of codex exec --json; the pure judging function and the real directory
// snapshot comparison are tested here (the process spawning is run by hand and stays untested).
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

test('a top-level tool call beats a usage limit in the run and overall verdicts', () => {
  const call = '{"type":"tool_call","name":"example"}';
  const limit = '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again at 1:45 AM."}}';
  for (const stdout of [call, call+'\n'+limit]) {
    const judged = judgeRun({...base, stdout, exitCode: 1});
    assert.equal(judged.status, 'fail');
    assert.equal(judged.verdict.reason, 'unsupported_tool_output');
    assert.equal(overallResult(['not-run', judged.status, 'inconclusive']), 'FAIL');
  }
});

test('the printed answer is capped at 400 characters and never contains the marker token; the version comes from the --version output', () => {
  const long = 'x'.repeat(600);
  const leaky = judgeRun({...base, versionOutput: 'codex-cli 0.167.1', stdout: stream([{type: 'agent_message', text: `the marker is MARK-test ${long}`}])});
  assert.equal(leaky.status, 'fail');
  assert.equal(leaky.version, 'codex-cli 0.167.1');
  assert.ok(leaky.answer!.length <= 400, String(leaky.answer!.length));
  assert.ok(!leaky.answer!.includes('MARK-test'), leaky.answer!);
  assert.ok(leaky.answer!.includes('[redacted-marker]'));
  const clean = judgeRun({...base, versionOutput: 'codex-cli 0.167.1', stdout: stream([{type: 'agent_message', text: 'OK'}])});
  assert.equal(clean.answer, 'OK');
  assert.equal(judgeRun({...base, stdout: stream([{type: 'agent_message', text: 'OK'}])}).version, null);
  assert.equal(judgeRun({...base, versionOutput: 'not a codex version string', stdout: stream([{type: 'agent_message', text: 'OK'}])}).version, null);
});

test('the directory comparison uses real snapshots taken before and after the run: a created, deleted or modified file and a deleted marker each fail', async t => {
  const ok = stream([{type: 'agent_message', text: 'OK'}]);
  // Mirrors the script: snapshot before the "run", mutate, then snapshot after and read the marker
  // only afterwards (a deleted marker reads as null instead of throwing).
  const scenario = async (mutate: (dir: string) => Promise<void> | void) => {
    const dir = await mkdtemp(join(tempRoot(), 'massion-smoke-codex-'));
    try {
      await writeFile(join(dir, 'marker.txt'), 'MARK-real');
      await writeFile(join(dir, 'kept.txt'), 'keep');
      const dirBefore = snapshotDir(dir);
      await mutate(dir);
      let markerAfter: string | null = null;
      try { markerAfter = await readFile(join(dir, 'marker.txt'), 'utf8'); } catch {}
      return judgeRun({...base, marker: 'MARK-real', markerBefore: 'MARK-real', markerAfter, dirBefore, dirAfter: snapshotDir(dir), stdout: ok});
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  };
  const created = await scenario(dir => writeFile(join(dir, 'created.txt'), 'x'));
  assert.equal(created.status, 'fail');
  assert.ok(created.reasons.some(r => r.includes('created.txt')));
  const deleted = await scenario(async dir => rm(join(dir, 'kept.txt')));
  assert.equal(deleted.status, 'fail');
  assert.ok(deleted.reasons.some(r => r.includes('files deleted: kept.txt')));
  const modified = await scenario(dir => writeFile(join(dir, 'kept.txt'), 'changed and longer'));
  assert.equal(modified.status, 'fail');
  assert.ok(modified.reasons.some(r => r.includes('files modified: kept.txt')));
  const markerDeleted = await scenario(async dir => rm(join(dir, 'marker.txt')));
  assert.equal(markerDeleted.status, 'fail');
  assert.ok(markerDeleted.deletedFiles.includes('marker.txt'));
  assert.ok(markerDeleted.reasons.some(r => r.includes('marker.txt')));
});
