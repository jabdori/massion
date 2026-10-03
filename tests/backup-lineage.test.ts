import test from 'node:test';
import assert from 'node:assert/strict';
import { Application } from '../src/application.ts';
import { hash } from '../src/domain.ts';
import type { Actor, Artifact, Command, Mission } from '../src/domain.ts';
import { InMemoryStore } from '../src/storage.ts';
import { collectMissionArtifacts, validateMissionJournalLineage, validateMissionLineage } from '../src/backup-lineage.ts';

const actors: Actor[] = [
  { id: 'owner', roles: ['owner'] }, { id: 'executor', roles: ['executor'] }, { id: 'verifier', roles: ['verifier'] },
  { id: 'representative', roles: ['representative'] }, { id: 'evaluator', roles: ['evaluator'] },
];
const candidate: Artifact = { id: 'text-work:text', version: 1, sha256: 'a'.repeat(64), path: `/original/root/text-work/${'a'.repeat(64)}.txt`, kind: 'text' };
const model = { provider: 'fixture', model: 'fixture-model', configVersion: 'config@1', reason: 'Deterministic test', evidenceClass: 'fixture' as const };
async function fixture(accept = true) {
  const store = new InMemoryStore<Mission>(() => new Date('2026-10-03T00:00:00Z'));
  const app = new Application(store, actors);
  await app.create({ id: 'mission', purpose: 'Bounded text', scope: 'local', constraints: ['No effects on restore'], criteria: { version: 1, description: 'Exact grounded review', oracle: 'manual-review/v1' } }, 'owner', 'create');
  let commandNumber = 0;
  const send = async (command: Command, actorId = 'owner') => {
    const snapshot = (await store.load('mission'))!;
    return app.dispatch({ missionId: 'mission', expectedRevision: snapshot.revision, commandId: `command-${++commandNumber}`, actorId, command });
  };
  await send({ type: 'save-memory', memory: { id: 'guidance', version: 1, scope: 'local', authority: 'explicit', content: 'Keep exact evidence', source: 'owner', effective: true } });
  await send({ type: 'admit-work', workId: 'work', title: 'Produce text', budget: 10 });
  for (const role of ['executor', 'verifier'] as const) await send({ type: 'assign', workId: 'work', assignment: { id: `${role}-assignment`, actorId: role, role, taskId: 'work:root', model, extensionVersion: 'fixture@1' } });
  await send({ type: 'admit-effect', workId: 'work', effect: { id: 'effect', taskId: 'work:root', status: 'pending', target: 'bounded text', authority: 'fixture-grant' }, reserve: 1 }, 'executor');
  await send({ type: 'receipt', workId: 'work', effectId: 'effect', outcome: 'succeeded', receipt: 'Fixture artifact was written', usage: 1 }, 'executor');
  await send({ type: 'publish-artifact', workId: 'work', artifact: candidate }, 'executor');
  await send({ type: 'settle-task', workId: 'work', taskId: 'work:root', result: 'Candidate ready' }, 'executor');
  await send({ type: 'verify', workId: 'work', verdict: { id: 'verdict', verifierAssignmentId: 'verifier-assignment', artifactSha256: candidate.sha256, artifactVersion: 1, criteriaVersion: 1, status: 'passed', evidence: [{ kind: 'fixture-review', detail: 'Verified known text', source: 'independent-fixture' }] } }, 'verifier');
  if (accept) await send({ type: 'accept', workId: 'work', recordId: 'record', artifactSnapshot: { sha256: candidate.sha256, path: candidate.path } });
  return { store, app, send, mission: (await store.load('mission'))!.value };
}

test('validates every historical snapshot and exact accepted Record without changing evidence', async () => {
  const { store, mission } = await fixture(); const original = structuredClone(mission);
  for (const operation of store.inspect()) validateMissionLineage(operation.value);
  validateMissionJournalLineage(store.inspect());
  assert.deepEqual(mission, original);
  const artifacts = collectMissionArtifacts(mission); assert.deepEqual(artifacts, [candidate]);
  artifacts[0]!.path = '/changed'; assert.deepEqual(mission, original, 'collection returns independent descriptors');
});

test('rejects recomputed Record checksums over inconsistent bindings and missing closure', async () => {
  const { mission } = await fixture();
  const mutations: ((mission: Mission) => void)[] = [
    mission => { mission.works[0]!.record!.criteria.description = 'Changed criterion'; },
    mission => { mission.works[0]!.record!.artifact.version = 2; },
    mission => { mission.works[0]!.record!.artifactSnapshot!.path = '/different/root'; },
    mission => { mission.works[0]!.record!.assignments.pop(); },
    mission => { mission.works[0]!.record!.receipts = []; },
    mission => { mission.works[0]!.record!.memoryVersions = []; },
    mission => { mission.works[0]!.record!.evidenceClass = 'real-provider'; },
    mission => { mission.memories = []; },
    mission => { mission.works[0]!.effects[0]!.status = 'unknown'; mission.works[0]!.record!.receipts[0]!.status = 'unknown'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(mission); mutate(changed);
    const { checksum: _checksum, ...payload } = changed.works[0]!.record!; changed.works[0]!.record!.checksum = hash(payload);
    assert.throws(() => validateMissionLineage(changed), /Portable Mission lineage/);
  }
});

test('rejects graph identity collisions, missing references, task cycles and self-verification', async () => {
  const { mission } = await fixture();
  const mutations: ((mission: Mission) => void)[] = [
    mission => { mission.works.push(structuredClone(mission.works[0]!)); },
    mission => { mission.works[0]!.tasks.push(structuredClone(mission.works[0]!.tasks[0]!)); },
    mission => { mission.works[0]!.assignments[1]!.taskId = 'absent'; },
    mission => { mission.works[0]!.assignments[1]!.actorId = 'executor'; },
    mission => { mission.works[0]!.effects[0]!.taskId = 'absent'; },
    mission => { mission.works[0]!.tasks[0]!.parentId = 'work:root'; },
    mission => { mission.works[0]!.attempts[0]!.number = 2; },
    mission => { mission.works[0]!.verdict!.verifierAssignmentId = 'absent'; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(mission); mutate(changed); assert.throws(() => validateMissionLineage(changed), /Portable Mission lineage/); }
});

test('refuses extra configuration fields, unsafe paths, non-text artifacts and invalid schemas', async () => {
  const { mission } = await fixture();
  const mutations: ((mission: Mission) => void)[] = [
    mission => { Object.assign(mission, { credentials: { apiKey: 'not-a-real-key' } }); },
    mission => { Object.assign(mission.works[0]!, { providerConfig: {} }); },
    mission => { mission.works[0]!.artifact!.kind = 'code'; },
    mission => { mission.works[0]!.artifact!.path = `/original/../root/text-work/${candidate.sha256}.txt`; },
    mission => { mission.works[0]!.artifact!.path = `relative/text-work/${candidate.sha256}.txt`; },
    mission => { mission.works[0]!.artifact!.id = 'other-work:text'; },
    mission => { mission.criteria.version = 0; },
    mission => { mission.works[0]!.budget.reserved = Number.NaN; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(mission); mutate(changed); assert.throws(() => validateMissionLineage(changed), /Portable Mission lineage/); }
});

test('supports historical stale verdicts and prospective Mission changes without rewriting pins', async () => {
  const fixtureState = await fixture(false);
  await fixtureState.send({ type: 'publish-artifact', workId: 'work', artifact: { ...candidate, version: 2, sha256: 'b'.repeat(64), path: `/original/root/text-work/${'b'.repeat(64)}.txt` } }, 'executor');
  await fixtureState.send({ type: 'revise-mission', purpose: 'Future purpose', criteria: { version: 3, description: 'Future criterion', oracle: 'next/v1' } });
  validateMissionJournalLineage(fixtureState.store.inspect());
  const state = (await fixtureState.store.load('mission'))!.value;
  assert.equal(state.works[0]!.criteria.version, 1); assert.equal(state.works[0]!.verdict!.artifactVersion, 1);
  assert.equal(collectMissionArtifacts(state)[0]!.version, 2);
});

test('journal validation detects event/state and outbox corruption even with matching command fingerprints', async () => {
  const { store } = await fixture();
  for (const kind of ['event', 'outbox', 'fingerprint', 'baseline', 'gap', 'duplicate']) {
    const operations = structuredClone([...store.inspect()]);
    if (kind === 'event') {
      const operation = operations.find(operation => (operation.events[0] as { type: string }).type === 'publish-artifact')!;
      const event = operation.events[0] as { actor: string; command: Extract<Command, { type: 'publish-artifact' }> };
      event.command.artifact = { ...candidate, version: 2 };
      operation.fingerprint = hash({ actorId: event.actor, command: event.command, expectedRevision: operation.expectedRevision });
    }
    if (kind === 'outbox') operations.find(operation => operation.outbox.length)!.outbox = [];
    if (kind === 'fingerprint') operations.at(-1)!.fingerprint = 'b'.repeat(64);
    if (kind === 'baseline') operations[0]!.value.version = 2;
    if (kind === 'gap') operations.splice(2, 1);
    if (kind === 'duplicate') operations.at(-1)!.commandId = operations[0]!.commandId;
    assert.throws(() => validateMissionJournalLineage(operations), /Portable Mission lineage/);
  }
});

test('journal requires known typed events and rejects hidden command fields', async () => {
  const { store } = await fixture();
  for (const mutate of [
    (event: Record<string, unknown>) => { event.type = 'unknown-command'; },
    (event: Record<string, unknown>) => { Object.assign(event.command as object, { authorizationConfig: { enabled: true } }); },
    (event: Record<string, unknown>) => { event.actor = ''; },
  ]) {
    const operations = structuredClone(store.inspect()); mutate(operations.at(-1)!.events[0] as Record<string, unknown>);
    assert.throws(() => validateMissionJournalLineage(operations), /Portable Mission lineage/);
  }
});

test('pending and unknown effect snapshots stay unresolved and are valid retained evidence', async () => {
  const { store } = await fixture();
  const pending = store.inspect().find(operation => operation.value.works[0]?.effects[0]?.status === 'pending')!;
  validateMissionLineage(pending.value);
  const unknown = structuredClone(pending.value); unknown.works[0]!.effects[0]!.status = 'unknown'; unknown.works[0]!.effects[0]!.receipt = 'Outcome unknown'; unknown.works[0]!.execution = 'blocked'; unknown.works[0]!.budget.measured = null;
  validateMissionLineage(unknown); assert.equal(unknown.works[0]!.effects[0]!.status, 'unknown');
});

test('runtime binding remains original when owner steering appends later instructions', async () => {
  const { store, send } = await fixture();
  await send({ type: 'admit-work', workId: 'runtime', title: 'Future runtime Work', budget: 100 });
  const work = (await store.load('mission'))!.value.works[1]!;
  const inputHash = hash({ mission: work.missionSnapshot, title: work.title, instructions: [], memoryVersions: work.appliedMemoryVersions });
  await send({ type: 'activate-runtime', workId: 'runtime', run: { id: 'run', authorizationId: 'historical-grant', criteriaHash: hash(work.criteria), inputHash, mode: 'mock-http', outputTokenCap: 10 } });
  await send({ type: 'steer', workId: 'runtime', instruction: 'Pause before any invocation' });
  validateMissionJournalLineage(store.inspect());
  assert.equal((await store.load('mission'))!.value.works[1]!.runtimeRun!.inputHash, inputHash);
});

test('measured Growth adoption, later accepted Work, observation and revert preserve memory lineage', async () => {
  const { store, send } = await fixture();
  await send({ type: 'save-memory', memory: { id: 'guidance', version: 2, scope: 'local', authority: 'learned', content: 'Improved evidence guidance', source: 'evaluation fixture', effective: false } });
  await send({ type: 'propose-growth', proposal: { id: 'growth', proposer: 'representative', target: 'memory', baseline: 'guidance@1', candidate: 'guidance@2', counterevidence: 'One case may regress', status: 'proposed' } }, 'representative');
  await send({ type: 'evaluate-growth', growthId: 'growth', baseline: 1, candidate: 2, heldOut: 'Independent fixture comparison' }, 'evaluator');
  await send({ type: 'adopt-growth', growthId: 'growth' });
  await send({ type: 'admit-work', workId: 'later', title: 'Later accepted Work', budget: 10 });
  for (const role of ['executor', 'verifier'] as const) await send({ type: 'assign', workId: 'later', assignment: { id: `later-${role}`, actorId: role, role, taskId: 'later:root', model, extensionVersion: 'fixture@1' } });
  await send({ type: 'admit-effect', workId: 'later', effect: { id: 'later-effect', taskId: 'later:root', status: 'pending', target: 'bounded text', authority: 'fixture-grant' }, reserve: 1 }, 'executor');
  await send({ type: 'receipt', workId: 'later', effectId: 'later-effect', outcome: 'succeeded', receipt: 'Retained text evidence', usage: 1 }, 'executor');
  await send({ type: 'publish-artifact', workId: 'later', artifact: candidate }, 'executor');
  await send({ type: 'settle-task', workId: 'later', taskId: 'later:root', result: 'Settled later Work' }, 'executor');
  await send({ type: 'verify', workId: 'later', verdict: { id: 'later-verdict', verifierAssignmentId: 'later-verifier', artifactSha256: candidate.sha256, artifactVersion: 1, criteriaVersion: 1, status: 'passed', evidence: [{ kind: 'fixture', detail: 'Independent review', source: 'verifier' }] } }, 'verifier');
  await send({ type: 'accept', workId: 'later', recordId: 'later-record' });
  await send({ type: 'observe-growth', growthId: 'growth', workId: 'later', metric: 2 }, 'evaluator');
  await send({ type: 'revert-growth', growthId: 'growth' });
  validateMissionJournalLineage(store.inspect());
  const restored = (await store.load('mission'))!.value;
  assert.equal(restored.growth[0]!.status, 'reverted'); assert.deepEqual(restored.works[1]!.record!.memoryVersions, ['guidance@2']);
  const invalid = structuredClone(restored); invalid.growth[0]!.observation!.workId = 'work';
  assert.throws(() => validateMissionLineage(invalid), /Growth observation/);
});
