/** Strict, inert validation of the bounded portable Mission schema.
 * This verifies retained structure and evidence bindings, not historical
 * authorization, provider truth, or the current bytes behind an artifact.
 */
import { isAbsolute, normalize } from 'node:path';
import { apply, createMission, hash } from './domain.ts';
import type { Actor, Artifact, Assignment, Command, Criteria, Effect, Mission, Verdict, Work } from './domain.ts';
import type { Operation } from './storage.ts';

const SHA256 = /^[a-f0-9]{64}$/;
const TEXT_ID = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63}):text$/;
const MAX_ITEMS = 10_000;
function fail(message: string): never { throw new Error(`Portable Mission lineage: ${message}`); }
function ensure(condition: unknown, message: string): asserts condition { if (!condition) fail(message); }
function object(value: unknown, label: string, required: string[], optional: string[] = []): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  ensure([Object.prototype, null].includes(Object.getPrototypeOf(value)), `${label} must be plain JSON`);
  const result = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  ensure(Object.getOwnPropertySymbols(result).length === 0 && Object.keys(result).every(key => allowed.has(key)), `${label} has unsupported fields`);
  ensure(required.every(key => Object.hasOwn(result, key)), `${label} is missing required fields`);
  return result;
}
function text(value: unknown, label: string, max = 16_000): asserts value is string {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= max && value.isWellFormed(), `invalid ${label}`);
}
function integer(value: unknown, label: string, min = 1): asserts value is number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= min, `invalid ${label}`);
}
function number(value: unknown, label: string): asserts value is number {
  ensure(typeof value === 'number' && Number.isFinite(value) && value >= 0, `invalid ${label}`);
}
function oneOf(value: unknown, values: readonly string[], label: string): void {
  ensure(typeof value === 'string' && values.includes(value), `invalid ${label}`);
}
function array(value: unknown, label: string): unknown[] {
  ensure(Array.isArray(value) && value.length <= MAX_ITEMS && Object.keys(value).length === value.length, `invalid or oversized ${label}`);
  return value;
}
function texts(value: unknown, label: string): string[] {
  const entries = array(value, label); entries.forEach(entry => text(entry, label)); return entries as string[];
}
function unique(values: readonly string[], label: string): void { ensure(new Set(values).size === values.length, `duplicate ${label}`); }
function sha(value: unknown, label: string): asserts value is string { ensure(typeof value === 'string' && SHA256.test(value), `invalid ${label}`); }
function equal(left: unknown, right: unknown, label: string): void { ensure(hash(left) === hash(right), `${label} mismatch`); }
function criteria(value: unknown): asserts value is Criteria {
  const item = object(value, 'criteria', ['version', 'description', 'oracle']);
  integer(item.version, 'criteria version'); text(item.description, 'criteria description'); text(item.oracle, 'criteria oracle');
}
function artifact(value: unknown): asserts value is Artifact {
  const item = object(value, 'artifact', ['id', 'version', 'sha256', 'path', 'kind']);
  ensure(item.kind === 'text', 'only sealed text artifacts are supported');
  ensure(typeof item.id === 'string' && TEXT_ID.test(item.id), 'invalid text artifact identity');
  integer(item.version, 'artifact version'); sha(item.sha256, 'artifact hash'); text(item.path, 'artifact path');
  ensure(isAbsolute(item.path) && normalize(item.path) === item.path && !item.path.includes('\\') && !item.path.includes('\0') &&
    !item.path.split('/').some(part => part === '.' || part === '..'), 'unsafe artifact path');
  const directory = TEXT_ID.exec(item.id)![1]!;
  ensure(item.path.endsWith(`/${directory}/${item.sha256}.txt`), 'artifact path does not match identity and hash');
}
function assignment(value: unknown): asserts value is Assignment {
  const item = object(value, 'assignment', ['id', 'actorId', 'role', 'taskId', 'model', 'extensionVersion']);
  for (const key of ['id', 'actorId', 'taskId', 'extensionVersion']) text(item[key], `assignment ${key}`);
  oneOf(item.role, ['executor', 'verifier'], 'assignment role');
  const model = object(item.model, 'model selection', ['provider', 'model', 'configVersion', 'reason', 'evidenceClass'], ['enabled', 'capabilities']);
  // Configured runtime historically copied these descriptor fields into assignments.
  // Retain and validate them as evidence, never as restored execution authority.
  if (Object.hasOwn(model, 'enabled')) ensure(typeof model.enabled === 'boolean', 'invalid recorded model enablement');
  if (Object.hasOwn(model, 'capabilities')) texts(model.capabilities, 'recorded model capabilities');
  for (const key of ['provider', 'model', 'configVersion', 'reason']) text(model[key], `model ${key}`);
  oneOf(model.evidenceClass, ['fixture', 'real-provider'], 'evidence class');
}
function effect(value: unknown, recoveryPendingIds: readonly string[] = []): asserts value is Effect {
  const item = object(value, 'effect', ['id', 'taskId', 'status', 'target', 'authority'], ['receipt']);
  for (const key of ['id', 'taskId', 'target', 'authority']) text(item[key], `effect ${key}`);
  oneOf(item.status, ['pending', 'succeeded', 'failed', 'unknown'], 'effect status');
  if (item.status === 'pending') ensure(!Object.hasOwn(item, 'receipt'), 'pending effect has a receipt');
  else if (item.status === 'unknown' && !Object.hasOwn(item, 'receipt')) ensure(recoveryPendingIds.includes(String(item.id)), 'receipt-free unknown lacks owner recovery');
  else text(item.receipt, 'effect receipt', 262_144);
}
function verdict(value: unknown): asserts value is Verdict {
  const item = object(value, 'verdict', ['id', 'verifierAssignmentId', 'artifactSha256', 'artifactVersion', 'criteriaVersion', 'status', 'evidence']);
  text(item.id, 'verdict ID'); text(item.verifierAssignmentId, 'verifier assignment'); sha(item.artifactSha256, 'verdict artifact hash');
  integer(item.artifactVersion, 'verdict artifact version'); integer(item.criteriaVersion, 'verdict criteria version');
  oneOf(item.status, ['passed', 'failed', 'stale'], 'verdict status');
  const evidence = array(item.evidence, 'verdict evidence'); ensure(evidence.length > 0, 'empty independent evidence');
  for (const value of evidence) {
    const entry = object(value, 'evidence', ['kind', 'detail', 'source']);
    text(entry.kind, 'evidence kind'); text(entry.detail, 'evidence detail', 262_144); text(entry.source, 'evidence source');
  }
}
function checkVerdictBinding(work: Work, current: boolean): void {
  const value = work.verdict!;
  ensure(work.artifact, 'verdict has no artifact');
  const verifier = work.assignments.find(entry => entry.id === value.verifierAssignmentId && entry.role === 'verifier');
  ensure(verifier, 'verdict verifier assignment is missing');
  ensure(!work.assignments.some(entry => entry.actorId === verifier.actorId && entry.role === 'executor'), 'executor self-verification');
  ensure(value.criteriaVersion === work.criteria.version, 'verdict criteria binding mismatch');
  ensure(value.artifactVersion <= work.artifact.version, 'verdict references a future artifact');
  if (current || value.artifactVersion === work.artifact.version) {
    ensure(value.artifactSha256 === work.artifact.sha256 && value.artifactVersion === work.artifact.version, 'verdict artifact binding mismatch');
  }
}
function checkRecord(work: Work): void {
  const record = object(work.record, 'accepted Record', ['id', 'workId', 'criteria', 'artifact', 'verdict', 'receipts', 'assignments', 'memoryVersions', 'evidenceClass', 'checksum'], ['artifactSnapshot']);
  text(record.id, 'Record ID'); ensure(record.workId === work.id, 'Record work binding mismatch'); sha(record.checksum, 'Record checksum');
  const { checksum, ...payload } = record; ensure(hash(payload) === checksum, 'Record checksum mismatch');
  criteria(record.criteria); artifact(record.artifact); verdict(record.verdict);
  array(record.assignments, 'Record assignments').forEach(assignment); array(record.receipts, 'Record receipts').forEach(entry => effect(entry));
  texts(record.memoryVersions, 'Record memory versions'); oneOf(record.evidenceClass, ['fixture', 'real-provider'], 'Record evidence class');
  equal(record.criteria, work.criteria, 'Record criteria'); equal(record.artifact, work.artifact, 'Record artifact');
  equal(record.verdict, work.verdict, 'Record verdict'); equal(record.assignments, work.assignments, 'Record assignments');
  equal(record.receipts, work.effects, 'Record receipts'); equal(record.memoryVersions, work.appliedMemoryVersions, 'Record memory pins');
  ensure(record.evidenceClass === (work.assignments.some(entry => entry.model.evidenceClass === 'fixture') ? 'fixture' : 'real-provider'), 'Record evidence classification mismatch');
  if (Object.hasOwn(record, 'artifactSnapshot')) {
    const snapshot = object(record.artifactSnapshot, 'Record artifact snapshot', ['sha256', 'path']);
    ensure(snapshot.sha256 === work.artifact!.sha256 && snapshot.path === work.artifact!.path, 'Record snapshot binding mismatch');
  }
  ensure(work.execution === 'settled' && work.verdict?.status === 'passed', 'accepted Work lacks settled independent pass');
  ensure(work.tasks.every(task => task.status === 'settled') && work.attempts.at(-1)?.status === 'settled', 'accepted Work has unsettled tasks or attempt');
  ensure(work.effects.length > 0 && work.effects.every(entry => ['succeeded', 'failed'].includes(entry.status)) &&
    work.effects.some(entry => entry.status === 'succeeded'), 'accepted Work has unresolved or no successful effects');
  ensure(work.assignments.some(entry => entry.role === 'executor'), 'accepted Work lacks executor assignment');
  checkVerdictBinding(work, true);
}
function validateWork(value: unknown, mission: Mission, memoryKeys: Set<string>): asserts value is Work {
  const item = object(value, 'Work', ['id', 'title', 'missionVersion', 'criteria', 'execution', 'acceptance', 'tasks', 'attempts', 'assignments', 'effects', 'appliedMemoryVersions', 'budget'],
    ['runtimeRun', 'runtimeRecovery', 'blocker', 'instructions', 'missionSnapshot', 'artifact', 'verdict', 'record']);
  text(item.id, 'Work ID'); text(item.title, 'Work title'); integer(item.missionVersion, 'Work Mission version'); criteria(item.criteria);
  ensure(item.missionVersion <= mission.version && item.criteria.version <= mission.criteria.version, 'Work references future Mission or criteria');
  oneOf(item.execution, ['queued', 'active', 'waiting', 'blocked', 'cancelled', 'settled'], 'Work execution');
  oneOf(item.acceptance, ['pending', 'failed', 'stale', 'accepted'], 'Work acceptance');
  if (Object.hasOwn(item, 'missionSnapshot')) {
    const snapshot = object(item.missionSnapshot, 'Mission input snapshot', ['version', 'purpose', 'scope', 'constraints']);
    integer(snapshot.version, 'snapshot version'); text(snapshot.purpose, 'snapshot purpose'); text(snapshot.scope, 'snapshot scope');
    array(snapshot.constraints, 'snapshot constraints').forEach(entry => ensure(typeof entry === 'string' && entry.isWellFormed(), 'invalid snapshot constraint'));
    ensure(snapshot.version === item.missionVersion && snapshot.scope === mission.scope, 'Mission input snapshot binding mismatch');
    if (snapshot.version === mission.version) equal(snapshot, { version: mission.version, purpose: mission.purpose, scope: mission.scope, constraints: mission.constraints }, 'current Mission input snapshot');
  }
  if (item.missionVersion === mission.version) equal(item.criteria, mission.criteria, 'current Mission criteria pin');
  if (Object.hasOwn(item, 'blocker')) {
    const blocker = object(item.blocker, 'execution blocker', ['code', 'detail']);
    oneOf(blocker.code, ['provider_unavailable', 'runtime_unavailable', 'provider_failed', 'budget_exceeded', 'verification_failed'], 'blocker code'); text(blocker.detail, 'blocker detail');
  }
  if (Object.hasOwn(item, 'instructions')) for (const entry of array(item.instructions, 'instructions')) {
    const instruction = object(entry, 'instruction', ['actorId', 'text']); text(instruction.actorId, 'instruction actor'); text(instruction.text, 'instruction text');
  }
  const budget = object(item.budget, 'budget', ['limit', 'reserved', 'measured'], ['unit']);
  number(budget.limit, 'budget limit'); number(budget.reserved, 'budget reserved'); ensure(budget.reserved <= budget.limit, 'reservation exceeds budget');
  if (budget.measured !== null) number(budget.measured, 'budget measurement');
  if (Object.hasOwn(budget, 'unit')) ensure(budget.unit === 'output-tokens', 'unsupported budget unit');
  if (Object.hasOwn(item, 'runtimeRun')) {
    const run = object(item.runtimeRun, 'runtime run', ['id', 'authorizationId', 'criteriaHash', 'inputHash', 'mode', 'outputTokenCap'], ['connectionBindings']);
    text(run.id, 'run ID'); text(run.authorizationId, 'run authorization identity'); sha(run.criteriaHash, 'run criteria hash'); sha(run.inputHash, 'run input hash');
    oneOf(run.mode, ['mock-http', 'live'], 'run mode'); integer(run.outputTokenCap, 'output cap');
    if (run.connectionBindings !== undefined) {
      const bindings = object(run.connectionBindings, 'connection bindings', ['executor', 'verifier']);
      for (const role of ['executor', 'verifier']) { const binding = object(bindings[role], 'connection binding', ['profileId', 'configHash']); text(binding.profileId, 'profile ID', 128); sha(binding.configHash, 'profile config hash');
        for (const assignment of item.assignments as Assignment[]) if (assignment.role === role) ensure(assignment.model.configVersion === binding.configHash, 'assignment/profile config binding mismatch');
      }
    }
    ensure(run.criteriaHash === hash(item.criteria) && item.missionSnapshot && budget.unit === 'output-tokens', 'runtime criteria/input/budget binding mismatch');
    // Owner steering can append instructions after admission. The original
    // inputHash is retained, not recomputed from later mutable instructions.
  }
  let recoveryPendingIds: string[] = [];
  if (Object.hasOwn(item, 'runtimeRecovery')) {
    const recovery = object(item.runtimeRecovery, 'owner recovery', ['runId', 'actorId', 'reason', 'pendingEffectIds', 'unknownEffectIds']);
    text(recovery.runId, 'recovery run'); text(recovery.actorId, 'recovery actor'); text(recovery.reason, 'recovery reason');
    ensure(item.runtimeRun && recovery.runId === (item.runtimeRun as {id:unknown}).id, 'recovery run binding mismatch');
    ensure(item.execution === 'cancelled' && item.acceptance !== 'accepted', 'quarantined Work must remain unaccepted and cancelled');
    recoveryPendingIds = texts(recovery.pendingEffectIds, 'recovery pending effects');
    const unknownIds = texts(recovery.unknownEffectIds, 'recovery unknown effects');
    const ids = [...recoveryPendingIds, ...unknownIds]; unique(ids, 'recovery effect'); ensure(ids.length > 0, 'empty recovery effects');
    if (recoveryPendingIds.length) ensure(budget.measured === null, 'missing receipts cannot imply known usage');
    const effects = array(item.effects, 'effects') as Effect[];
    ensure(ids.every(id => effects.some(effect => effect.id === id && effect.status === 'unknown')), 'recovery effects must remain unknown');
    ensure(effects.filter(effect => effect.status === 'unknown').every(effect => ids.includes(effect.id)), 'unbound recovery unknown effect');
    ensure(!effects.some(effect => effect.status === 'pending'), 'quarantined Work still has pending effects');
    ensure(recoveryPendingIds.every(id => !Object.hasOwn(effects.find(effect => effect.id === id)!, 'receipt')), 'owner recovery fabricated a provider receipt');
    ensure(unknownIds.every(id => Object.hasOwn(effects.find(effect => effect.id === id)!, 'receipt')), 'existing unknown receipt was lost');
  }
  const tasks = array(item.tasks, 'tasks'); ensure(tasks.length > 0, 'Work has no root task');
  for (const value of tasks) {
    const task = object(value, 'task', ['id', 'parentId', 'status'], ['result']); text(task.id, 'task ID');
    if (task.parentId !== null) text(task.parentId, 'parent task ID'); oneOf(task.status, ['queued', 'active', 'settled'], 'task status');
    if (Object.hasOwn(task, 'result')) text(task.result, 'task result');
    if (task.status === 'settled') text(task.result, 'settled task result');
  }
  array(item.assignments, 'assignments').forEach(assignment); array(item.effects, 'effects').forEach(entry => effect(entry, recoveryPendingIds));
  const attempts = array(item.attempts, 'attempts'); ensure(attempts.length > 0, 'Work has no attempt');
  for (const [index, value] of attempts.entries()) {
    const attempt = object(value, 'attempt', ['id', 'number', 'criteria', 'status', 'modelVersions'], ['results']);
    ensure(attempt.id === `${item.id}:attempt:${index + 1}` && attempt.number === index + 1, 'attempt sequence or identity mismatch');
    criteria(attempt.criteria); equal(attempt.criteria, item.criteria, 'attempt criteria'); oneOf(attempt.status, ['queued', 'active', 'settled'], 'attempt status');
    texts(attempt.modelVersions, 'attempt model versions');
    if (Object.hasOwn(attempt, 'results')) for (const value of array(attempt.results, 'attempt results')) {
      const result = object(value, 'attempt result', ['taskId', 'result']); text(result.taskId, 'attempt task ID'); text(result.result, 'attempt result');
    }
  }
  const memoryPins = texts(item.appliedMemoryVersions, 'applied memory versions'); unique(memoryPins, 'applied memory pin');
  ensure(memoryPins.every(pin => memoryKeys.has(pin)), 'Work references absent memory version');
  if (Object.hasOwn(item, 'artifact')) artifact(item.artifact);
  if (Object.hasOwn(item, 'verdict')) verdict(item.verdict);
  const work = value as Work;
  unique(work.tasks.map(entry => entry.id), 'task ID'); unique(work.assignments.map(entry => entry.id), 'assignment ID'); unique(work.effects.map(entry => entry.id), 'effect ID');
  const taskIds = new Set(work.tasks.map(entry => entry.id));
  ensure(work.tasks.filter(task => task.parentId === null).length === 1 && work.tasks.some(task => task.id === `${work.id}:root` && task.parentId === null), 'invalid root task');
  const taskParents = new Map(work.tasks.map(task => [task.id, task.parentId]));
  for (const task of work.tasks) {
    const seen = new Set<string>(); let id: string | null = task.id;
    while (id !== null) { ensure(taskIds.has(id) && !seen.has(id), 'missing or cyclic task parent'); seen.add(id); id = taskParents.get(id)!; }
  }
  const actorRoles = new Map<string, string>();
  for (const entry of work.assignments) {
    ensure(taskIds.has(entry.taskId), 'assignment references absent task');
    ensure(!actorRoles.has(entry.actorId) || actorRoles.get(entry.actorId) === entry.role, 'executor and verifier identities overlap');
    actorRoles.set(entry.actorId, entry.role);
  }
  for (const entry of work.effects) ensure(taskIds.has(entry.taskId) && work.assignments.some(assignment => assignment.taskId === entry.taskId), 'effect lacks task/assignment lineage');
  for (const attempt of work.attempts) {
    ensure(attempt.modelVersions.every(version => work.assignments.some(entry => entry.model.configVersion === version)), 'attempt references absent model version');
    if (attempt.results) {
      unique(attempt.results.map(result => result.taskId), 'attempt result task');
      ensure(attempt.results.every(result => taskIds.has(result.taskId)), 'attempt result references absent task');
    }
  }
  equal(work.attempts.at(-1)!.modelVersions, work.assignments.map(entry => entry.model.configVersion), 'current attempt model lineage');
  if (work.verdict) checkVerdictBinding(work, work.acceptance !== 'stale');
  if (work.acceptance === 'failed') ensure(work.verdict?.status === 'failed', 'failed acceptance has no failed verdict');
  if (work.acceptance === 'stale') ensure(work.verdict, 'stale acceptance has no verdict');
  if (work.acceptance === 'accepted') checkRecord(work);
  else ensure(!Object.hasOwn(item, 'record'), 'unaccepted Work contains a Record');
}

export function validateMissionLineage(value: unknown): asserts value is Mission {
  const item = object(value, 'Mission', ['id', 'version', 'purpose', 'scope', 'constraints', 'criteria', 'works', 'memories', 'growth', 'relations']);
  text(item.id, 'Mission ID'); text(item.purpose, 'Mission purpose'); text(item.scope, 'Mission scope'); integer(item.version, 'Mission version'); criteria(item.criteria);
  array(item.constraints, 'Mission constraints').forEach(entry => ensure(typeof entry === 'string' && entry.isWellFormed(), 'invalid constraint'));
  const memories = array(item.memories, 'memories');
  for (const value of memories) {
    const memory = object(value, 'memory', ['id', 'version', 'scope', 'authority', 'content', 'source', 'effective']);
    text(memory.id, 'memory ID'); integer(memory.version, 'memory version'); ensure(memory.scope === item.scope, 'memory scope mismatch');
    oneOf(memory.authority, ['explicit', 'learned'], 'memory authority'); text(memory.content, 'memory content'); text(memory.source, 'memory source'); ensure(typeof memory.effective === 'boolean', 'invalid effective memory flag');
  }
  const mission = value as Mission;
  const memoryKeys = new Set(mission.memories.map(memory => `${memory.id}@${memory.version}`)); ensure(memoryKeys.size === memories.length, 'duplicate memory version');
  unique(mission.memories.filter(memory => memory.effective).map(memory => memory.id), 'effective memory ID');
  const works = array(item.works, 'Works'); works.forEach(work => validateWork(work, mission, memoryKeys)); unique(mission.works.map(work => work.id), 'Work ID');
  unique(mission.works.flatMap(work => work.record ? [work.record.id] : []), 'Record ID');
  const growth = array(item.growth, 'Growth');
  for (const value of growth) {
    const entry = object(value, 'Growth', ['id', 'proposer', 'target', 'baseline', 'candidate', 'counterevidence', 'status'], ['evaluator', 'scores', 'observation', 'previousEffective']);
    for (const key of ['id', 'proposer', 'baseline', 'candidate', 'counterevidence']) text(entry[key], `Growth ${key}`);
    ensure(entry.target === 'memory' && memoryKeys.has(entry.baseline as string) && memoryKeys.has(entry.candidate as string), 'Growth has unsupported target or absent memory lineage');
    oneOf(entry.status, ['proposed', 'evaluated', 'adopted', 'reverted'], 'Growth status');
    if (entry.status === 'proposed') ensure(!Object.hasOwn(entry, 'evaluator') && !Object.hasOwn(entry, 'scores') && !Object.hasOwn(entry, 'observation') && !Object.hasOwn(entry, 'previousEffective'), 'proposed Growth has later-stage evidence');
    else {
      text(entry.evaluator, 'Growth evaluator'); ensure(entry.evaluator !== entry.proposer, 'Growth self-evaluation');
      const scores = object(entry.scores, 'Growth scores', ['baseline', 'candidate', 'heldOut']); number(scores.baseline, 'baseline score'); number(scores.candidate, 'candidate score'); text(scores.heldOut, 'held-out evidence');
      if (entry.status === 'adopted' || entry.status === 'reverted') {
        ensure(scores.candidate > scores.baseline, 'Growth adoption lacks measured improvement');
        const pins = texts(entry.previousEffective, 'previous effective memory'); unique(pins, 'previous effective memory'); ensure(pins.every(pin => memoryKeys.has(pin)), 'Growth references absent previous memory');
      } else ensure(!Object.hasOwn(entry, 'previousEffective') && !Object.hasOwn(entry, 'observation'), 'evaluated Growth has adoption evidence');
    }
    if (Object.hasOwn(entry, 'observation')) {
      const observation = object(entry.observation, 'Growth observation', ['workId', 'metric']); text(observation.workId, 'observed Work ID'); number(observation.metric, 'observed metric');
      const work = mission.works.find(work => work.id === observation.workId);
      ensure(work?.acceptance === 'accepted' && work.appliedMemoryVersions.includes(entry.candidate as string), 'Growth observation lacks accepted candidate Work');
    }
  }
  unique(mission.growth.map(entry => entry.id), 'Growth ID');
  for (const value of array(item.relations, 'relations')) {
    const entry = object(value, 'relation', ['from', 'to', 'type', 'fromVersion', 'toVersion', 'provenance', 'inferred']);
    text(entry.from, 'relation source'); text(entry.to, 'relation target'); text(entry.provenance, 'relation provenance');
    oneOf(entry.type, ['depends-on', 'evidenced-by', 'contains'], 'relation type'); integer(entry.fromVersion, 'relation source version'); integer(entry.toVersion, 'relation target version'); ensure(typeof entry.inferred === 'boolean', 'invalid relation inference flag');
    // Relations may name external evidence; they are not a closed-world graph.
  }
}

/** Descriptors are copied; original path and Record evidence are never edited. */
export function collectMissionArtifacts(mission: Mission): Artifact[] {
  validateMissionLineage(mission);
  const artifacts = new Map<string, Artifact>();
  for (const work of mission.works) for (const artifact of [work.artifact, work.record?.artifact]) if (artifact) {
    const key = hash(artifact); if (!artifacts.has(key)) artifacts.set(key, structuredClone(artifact));
  }
  return [...artifacts.values()];
}

const COMMAND_KEYS: Record<Command['type'], { required: string[]; optional?: string[] }> = {
  'revise-mission': { required: ['purpose', 'criteria'] },
  'admit-work': { required: ['workId', 'title', 'budget'], optional: ['executionGate'] },
  assign: { required: ['workId', 'assignment'] },
  'revise-work': { required: ['workId'] },
  'activate-runtime': { required: ['workId', 'run'] },
  'quarantine-runtime': { required: ['workId', 'runId', 'reason', 'acknowledgeUncertainOutcome'] },
  'block-work': { required: ['workId', 'blocker'] },
  delegate: { required: ['workId', 'taskId', 'parentId'] },
  'settle-task': { required: ['workId', 'taskId', 'result'] },
  'admit-effect': { required: ['workId', 'effect', 'reserve'] },
  receipt: { required: ['workId', 'effectId', 'outcome', 'receipt', 'usage'] },
  'reconcile-effect': { required: ['workId', 'effectId', 'outcome', 'receipt'] },
  'publish-artifact': { required: ['workId', 'artifact'] },
  verify: { required: ['workId', 'verdict'] },
  accept: { required: ['workId', 'recordId'], optional: ['artifactSnapshot'] },
  cancel: { required: ['workId'] },
  steer: { required: ['workId', 'instruction'] },
  'save-memory': { required: ['memory'] },
  'propose-growth': { required: ['proposal'] },
  'evaluate-growth': { required: ['growthId', 'baseline', 'candidate', 'heldOut'] },
  'adopt-growth': { required: ['growthId'] },
  'observe-growth': { required: ['growthId', 'workId', 'metric'] },
  'revert-growth': { required: ['growthId'] },
  relate: { required: ['relation'] },
};

/**
 * Proves that retained application events deterministically produce every
 * retained Mission snapshot. Role grants were not journaled by schema v2:
 * synthetic validation roles are never persisted, executed, or authority.
 * Storage separately checks journal digests, global cursors and audit fields.
 */
export function validateMissionJournalLineage(operations: readonly Operation<Mission>[]): void {
  const previous = new Map<string, Operation<Mission>>();
  const commands = new Set<string>();
  for (const operation of operations) {
    validateMissionLineage(operation.value);
    ensure(operation.aggregateId === operation.value.id, 'operation aggregate/Mission mismatch');
    text(operation.commandId, 'command ID'); ensure(!commands.has(operation.commandId), 'duplicate journal command ID'); commands.add(operation.commandId);
    const prior = previous.get(operation.aggregateId);
    ensure(operation.expectedRevision === (prior?.revision ?? 0) && operation.revision === operation.expectedRevision + 1, 'operation revision lineage mismatch');
    ensure(Array.isArray(operation.events) && operation.events.length === 1, 'portable Mission operation requires one typed application event');
    const event = object(operation.events[0], 'application event', prior ? ['type', 'actor', 'command'] : ['type', 'actor']);
    text(event.actor, 'event actor ID');
    const actor: Actor = { id: event.actor, roles: ['owner', 'representative', 'executor', 'verifier', 'evaluator'] };
    if (!prior) {
      ensure(event.type === 'mission-created', 'journal must start with mission-created');
      const { id, purpose, scope, constraints, criteria } = operation.value;
      const input = { id, purpose, scope, constraints, criteria };
      equal(createMission(input, actor), operation.value, 'Mission creation baseline');
      ensure(operation.fingerprint === hash({ actorId: actor.id, input, kind: 'create' }), 'creation fingerprint mismatch');
      equal(operation.outbox, [], 'creation outbox');
    } else {
      ensure(event.command && typeof event.command === 'object' && !Array.isArray(event.command), 'invalid journal command');
      const type = (event.command as Record<string, unknown>).type;
      ensure(typeof type === 'string' && Object.hasOwn(COMMAND_KEYS, type), 'unsupported journal command');
      const keys = COMMAND_KEYS[type as Command['type']];
      const command = object(event.command, 'journal command', ['type', ...keys.required], keys.optional) as unknown as Command;
      ensure(event.type === type, 'event and command type mismatch');
      ensure(operation.fingerprint === hash({ actorId: actor.id, command, expectedRevision: operation.expectedRevision }), 'command fingerprint mismatch');
      const derived = apply(prior.value, command, actor);
      equal(derived.value, operation.value, 'command/state transition'); equal(derived.events, operation.events, 'command/event transition');
      equal(operation.outbox, command.type === 'admit-effect' ? [{ type: 'effect-admitted', workId: command.workId, effectId: command.effect.id }] : [], 'command/outbox transition');
    }
    previous.set(operation.aggregateId, operation);
  }
}
