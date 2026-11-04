import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, link, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import {
  BUILTIN_FIXTURE_EXTENSION, CALCULATION_CRITERIA_VERSION, DOCUMENT_CRITERIA_VERSION,
  FIXTURE_LIMITS, FIXTURE_PROVIDER, createFixtureWorkspace, independentlyVerifyCalculation,
  independentlyVerifyDocumentSummary, writeCalculationCandidate, writeDocumentSummaryCandidate,
  chooseFixtureVariant, evaluateCalculationImprovement,
  sealArtifact, verifyArtifactSnapshot,
  assertFixtureCapability, BUILTIN_FIXTURE_EXTENSION_PIN,
} from '../src/execution.ts';
import type { FixtureWorkspace } from '../src/execution.ts';

async function fixture(t: TestContext, name = 'work-a'): Promise<FixtureWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'massion-execution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createFixtureWorkspace(root, name);
}

const verify = (workspace: FixtureWorkspace, artifact: Awaited<ReturnType<typeof writeCalculationCandidate>>) =>
  independentlyVerifyCalculation(workspace, artifact, CALCULATION_CRITERIA_VERSION);

test('actual file writes and a separate oracle process fail wrong code and pass corrected code', async t => {
  const workspace = await fixture(t);
  const wrong = await writeCalculationCandidate(workspace, 'wrong');
  const wrongBytes = await readFile(wrong.path);
  assert.equal(wrong.version, 1);
  assert.equal(wrong.sha256, createHash('sha256').update(wrongBytes).digest('hex'));
  assert.match(wrongBytes.toString(), /per-line rounding/);
  const failed = await verify(workspace, wrong);
  assert.equal(failed.verdict, 'failed');
  assert.ok(failed.evidence.some(evidence => evidence.startsWith('FAIL round after aggregate')));
  assert.equal(failed.process?.exitCode, 1);
  assert.ok(failed.process?.pid && failed.process.pid !== process.pid);
  const correct = await writeCalculationCandidate(workspace, 'correct');
  assert.equal(correct.id, wrong.id);
  assert.equal(correct.version, 2);
  assert.notEqual(correct.sha256, wrong.sha256);
  const passed = await verify(workspace, correct);
  assert.equal(passed.verdict, 'passed');
  assert.equal(passed.artifactSha256, correct.sha256);
  assert.equal(passed.criteriaVersion, CALCULATION_CRITERIA_VERSION);
  assert.equal(passed.process?.exitCode, 0);
  assert.equal(passed.process?.stderr, '');
  assert.equal(passed.process?.timedOut, false);
  assert.equal(passed.process?.outputExceeded, false);
  assert.ok(passed.process?.oracleSha256.match(/^[a-f0-9]{64}$/));
  assert.equal(passed.evidence.length, 8);
  assert.ok(passed.evidence.every(evidence => evidence.startsWith('PASS')));
});

test('passing evidence is stale after bytes change or disappear', async t => {
  const workspace = await fixture(t);
  const artifact = await writeCalculationCandidate(workspace, 'correct');
  assert.equal((await verify(workspace, artifact)).verdict, 'passed');
  await writeFile(artifact.path, '// tampered bytes\n');
  const stale = await verify(workspace, artifact);
  assert.equal(stale.verdict, 'stale');
  assert.equal(stale.process, undefined);
  await rm(artifact.path);
  assert.equal((await verify(workspace, artifact)).verdict, 'stale');
});

test('old version is stale even when the same candidate bytes are written again', async t => {
  const workspace = await fixture(t);
  const first = await writeCalculationCandidate(workspace, 'correct');
  const second = await writeCalculationCandidate(workspace, 'correct');
  assert.equal(second.sha256, first.sha256);
  assert.equal((await verify(workspace, first)).verdict, 'stale');
  assert.equal((await verify(workspace, second)).verdict, 'passed');
});

test('reopening the fixture preserves manifest versions and concurrent writes serialize', async t => {
  const workspace = await fixture(t);
  const first = await writeCalculationCandidate(workspace, 'wrong');
  const reopened = await createFixtureWorkspace(workspace.root, workspace.workId);
  assert.deepEqual(reopened, workspace);
  const [second, third] = await Promise.all([
    writeCalculationCandidate(reopened, 'correct'), writeCalculationCandidate(reopened, 'wrong'),
  ]);
  assert.deepEqual([first.version, second.version, third.version], [1, 2, 3]);
  assert.equal((await verify(reopened, second)).verdict, 'stale');
  assert.equal((await verify(reopened, third)).verdict, 'failed');
});

test('unknown criteria are not certified and unknown variants are not executed', async t => {
  const workspace = await fixture(t);
  const artifact = await writeCalculationCandidate(workspace, 'correct');
  const result = await independentlyVerifyCalculation(workspace, artifact, 'unreviewed-v2');
  assert.equal(result.verdict, 'failed');
  assert.equal(result.process, undefined);
  await assert.rejects(writeCalculationCandidate(workspace, 'arbitrary' as 'wrong'), /unknown controlled candidate/);
});

test('pinned but arbitrary source is rejected before execution', async t => {
  const workspace = await fixture(t);
  const artifact = await writeCalculationCandidate(workspace, 'correct');
  const bytes = "import { writeFileSync } from 'node:fs'; writeFileSync('must-not-exist', 'executed');\n";
  const forged = { ...artifact, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(artifact.path, bytes);
  const manifestPath = join(workspace.path, '.fixture-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.artifacts.calculation = forged;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const result = await verify(workspace, forged);
  assert.equal(result.verdict, 'failed');
  assert.equal(result.process, undefined);
  assert.ok(result.evidence[0]);
  assert.match(result.evidence[0], /allowlist/);
  await assert.rejects(readFile(join(workspace.path, 'must-not-exist')), { code: 'ENOENT' });
});

test('work IDs, lexical traversal, and escaping artifact paths are rejected', async t => {
  const workspace = await fixture(t);
  const artifact = await writeCalculationCandidate(workspace, 'correct');
  await assert.rejects(createFixtureWorkspace(workspace.root, '../escape'), /invalid work ID/);
  await assert.rejects(createFixtureWorkspace(`${workspace.root}/../escape`, 'work'), /path traversal/);
  await assert.rejects(createFixtureWorkspace('relative', 'work'), /absolute path/);
  await assert.rejects(verify(workspace, { ...artifact, path: `${workspace.path}/../outside.mjs` }), /path traversal/);
  await assert.rejects(verify(workspace, { ...artifact, path: join(workspace.root, 'outside.mjs') }), /escapes workspace/);
  await assert.rejects(writeCalculationCandidate({ ...workspace, path: workspace.root }, 'correct'), /workspace identity/);
});

test('symlink roots and workspace directories are rejected without changing their target', async t => {
  const workspace = await fixture(t);
  const outside = join(workspace.root, 'outside');
  await mkdir(outside);
  const linkedRoot = join(workspace.root, 'linked-root');
  await symlink(outside, linkedRoot);
  await assert.rejects(createFixtureWorkspace(linkedRoot, 'work'), /symlink/);
  const linkedWork = join(workspace.root, 'linked-work');
  await symlink(outside, linkedWork);
  await assert.rejects(createFixtureWorkspace(workspace.root, 'linked-work'), /symlink/);
  await assert.rejects(readFile(join(outside, '.fixture-manifest.json')), { code: 'ENOENT' });
});

test('symlink candidate and manifest paths are rejected without following external targets', async t => {
  const workspace = await fixture(t);
  const artifact = await writeCalculationCandidate(workspace, 'correct');
  const outside = join(workspace.root, 'outside.txt');
  await writeFile(outside, 'unchanged');
  await rm(artifact.path);
  await symlink(outside, artifact.path);
  await assert.rejects(verify(workspace, artifact), /symlink/);
  await assert.rejects(writeCalculationCandidate(workspace, 'correct'), /symlink/);
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  const manifestPath = join(workspace.path, '.fixture-manifest.json');
  await rm(manifestPath);
  await symlink(outside, manifestPath);
  await assert.rejects(createFixtureWorkspace(workspace.root, workspace.workId), /symlink/);
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
});

test('hard-linked files and oversized candidates are rejected', async t => {
  const workspace = await fixture(t);
  const artifact = await writeCalculationCandidate(workspace, 'correct');
  await link(artifact.path, join(workspace.root, 'hard-linked.mjs'));
  await assert.rejects(verify(workspace, artifact), /regular/);
  await assert.rejects(writeCalculationCandidate(workspace, 'correct'), /regular/);
  await rm(join(workspace.root, 'hard-linked.mjs'));
  await writeFile(artifact.path, 'x'.repeat(FIXTURE_LIMITS.maxFileBytes + 1));
  await assert.rejects(verify(workspace, artifact), /size limit/);
});

test('document summary fixture fails unsupported facts and passes exact source-backed evidence', async t => {
  const workspace = await fixture(t, 'document-work');
  const wrong = await writeDocumentSummaryCandidate(workspace, 'wrong');
  assert.equal(wrong.kind, 'document');
  const failed = await independentlyVerifyDocumentSummary(workspace, wrong, DOCUMENT_CRITERIA_VERSION);
  assert.equal(failed.verdict, 'failed');
  assert.ok(failed.evidence.includes('FAIL facts supported by source'));
  const correct = await writeDocumentSummaryCandidate(workspace, 'correct');
  const passed = await independentlyVerifyDocumentSummary(workspace, correct, DOCUMENT_CRITERIA_VERSION);
  assert.equal(passed.verdict, 'passed');
  assert.equal(passed.evidence.length, 3);
  assert.equal(passed.process, undefined);
  await writeFile(join(workspace.path, 'source.md'), 'Source changed.');
  assert.equal((await independentlyVerifyDocumentSummary(workspace, correct, DOCUMENT_CRITERIA_VERSION)).verdict, 'stale');
});

test('built-in extension and fixture identity/config are pinned and explicit about limitations', () => {
  assert.equal(BUILTIN_FIXTURE_EXTENSION.version, '1.0.0');
  assert.match(BUILTIN_FIXTURE_EXTENSION.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(BUILTIN_FIXTURE_EXTENSION.externalPackagesAllowed, false);
  assert.ok(Object.isFrozen(BUILTIN_FIXTURE_EXTENSION));
  assert.ok(Object.isFrozen(BUILTIN_FIXTURE_EXTENSION.contributions));
  assert.equal(FIXTURE_PROVIDER.realModel, false);
  assert.equal(FIXTURE_PROVIDER.kind, 'deterministic-fixture');
  assert.deepEqual(FIXTURE_PROVIDER.configuration, { network: false, inheritedEnvironment: false, arbitraryCode: false });
  assert.ok(FIXTURE_LIMITS.timeoutMs > 0);
  assert.ok(FIXTURE_LIMITS.maxOutputBytes > 0);
});

test('initialization never adopts or overwrites an unmarked populated workspace', async t => {
  const workspace = await fixture(t);
  const unmarked = join(workspace.root, 'unmarked');
  await mkdir(unmarked);
  const existing = join(unmarked, 'source.md');
  await writeFile(existing, 'User-owned content.');
  await assert.rejects(createFixtureWorkspace(workspace.root, 'unmarked'), /nonempty unmarked/);
  assert.equal(await readFile(existing, 'utf8'), 'User-owned content.');
});

test('workspace directory replacement by a symlink is rejected on the next operation', async t => {
  const workspace = await fixture(t);
  const artifact = await writeCalculationCandidate(workspace, 'correct');
  const outside = join(workspace.root, 'untouched');
  await mkdir(outside);
  await writeFile(join(outside, 'calculation.mjs'), 'unchanged');
  await rm(workspace.path, { recursive: true });
  await symlink(outside, workspace.path);
  await assert.rejects(writeCalculationCandidate(workspace, 'correct'), /symlink/);
  await assert.rejects(verify(workspace, artifact), /symlink/);
  assert.equal(await readFile(join(outside, 'calculation.mjs'), 'utf8'), 'unchanged');
});

test('held-out Growth evaluation measures real independent-process results, not constant scores', async () => {
  const result = await evaluateCalculationImprovement();
  assert.equal(result.baseline, 2);
  assert.equal(result.candidate, 6);
  assert.match(result.heldOut, /calculation-held-out\/v1/);
  assert.match(result.heldOut, /oracle SHA-256 [a-f0-9]{64}/);
  assert.equal(result.evidence.length, 14);
  assert.equal(result.evidence.filter(item => item.startsWith('wrong: FAIL')).length, 4);
  assert.equal(result.evidence.filter(item => item.startsWith('correct: PASS')).length, 6);
  assert.equal(result.evidence.filter(item => item.includes('separate process')).length, 2);
  assert.ok(result.evidence.every(item => !item.includes(`separate process ${process.pid},`)));
});

test('fixture improvement routing requires the exact effective memory marker', () => {
  assert.equal(chooseFixtureVariant([]), 'wrong');
  assert.equal(chooseFixtureVariant(['Unrelated instruction']), 'wrong');
  assert.equal(chooseFixtureVariant(['Do not Round aggregate once']), 'wrong');
  assert.equal(chooseFixtureVariant(['Round aggregate once']), 'correct');
  assert.equal(chooseFixtureVariant(['Unrelated instruction', 'Round aggregate once']), 'correct');
  assert.equal(chooseFixtureVariant([]), 'wrong'); // Revert removes effective memory.
});

test('sealing creates reusable read-only content-addressed bytes independent of later candidate changes', async t => {
  const workspace = await fixture(t);
  const artifact = await writeCalculationCandidate(workspace, 'correct');
  const original = await readFile(artifact.path);
  assert.equal((await verify(workspace, artifact)).verdict, 'passed');
  const snapshot = await sealArtifact(workspace, artifact);
  assert.equal(snapshot.sha256, artifact.sha256);
  assert.notEqual(snapshot.path, artifact.path);
  assert.ok(snapshot.path.includes(artifact.sha256));
  assert.equal((await stat(snapshot.path)).mode & 0o222, 0);
  assert.deepEqual(await sealArtifact(workspace, artifact), snapshot);
  assert.equal(await verifyArtifactSnapshot(workspace, snapshot), true);
  await writeCalculationCandidate(workspace, 'wrong');
  assert.deepEqual(await readFile(snapshot.path), original);
  assert.equal(await verifyArtifactSnapshot(workspace, snapshot), true);
  await assert.rejects(sealArtifact(workspace, artifact), /stale/);
});

test('sealing rejects tampered snapshots, writable snapshots, and symlinks instead of overwriting', async t => {
  const workspace = await fixture(t);
  const artifact = await writeCalculationCandidate(workspace, 'correct');
  const snapshot = await sealArtifact(workspace, artifact);
  await chmod(snapshot.path, 0o600);
  assert.equal(await verifyArtifactSnapshot(workspace, snapshot), false);
  await assert.rejects(sealArtifact(workspace, artifact), /refusing overwrite/);
  await writeFile(snapshot.path, 'tampered snapshot');
  await chmod(snapshot.path, 0o400);
  assert.equal(await verifyArtifactSnapshot(workspace, snapshot), false);
  await assert.rejects(sealArtifact(workspace, artifact), /refusing overwrite/);
  assert.equal(await readFile(snapshot.path, 'utf8'), 'tampered snapshot');
  await rm(snapshot.path);
  await symlink(artifact.path, snapshot.path);
  await assert.rejects(sealArtifact(workspace, artifact), /symlink/);
});

test('execution admission requires exact enabled extension/provider pins and a supported capability', () => {
  const input = {
    extensionVersion: BUILTIN_FIXTURE_EXTENSION_PIN,
    provider: FIXTURE_PROVIDER.providerId,
    model: FIXTURE_PROVIDER.modelId,
    configVersion: FIXTURE_PROVIDER.configurationVersion,
    capability: 'controlled-code-candidate',
  };
  for (const capability of FIXTURE_PROVIDER.capabilities) assert.doesNotThrow(() => assertFixtureCapability({ ...input, capability }));
  assert.throws(() => assertFixtureCapability({ ...input, extensionVersion: `${BUILTIN_FIXTURE_EXTENSION.id}@2.0.0` }), /extension pin/);
  assert.throws(() => assertFixtureCapability({ ...input, extensionVersion: 'external.package@1.0.0' }), /extension pin/);
  assert.throws(() => assertFixtureCapability({ ...input, provider: 'unconfigured-real-provider' }), /provider/);
  assert.throws(() => assertFixtureCapability({ ...input, model: 'different-model' }), /model/);
  assert.throws(() => assertFixtureCapability({ ...input, configVersion: 'v2' }), /configuration/);
  assert.throws(() => assertFixtureCapability({ ...input, capability: 'arbitrary-shell-command' }), /contribution/);
  assert.throws(() => assertFixtureCapability({ ...input, capability: '__proto__' }), /contribution/);
});
