/**
 * Real local file/process effects for controlled fixtures only. This is neither
 * a model implementation nor an OS sandbox. No caller-supplied code is run.
 */
import { createHash, randomUUID } from 'node:crypto';
import {calculationPlan} from './growth-evaluation.ts';
import type {OrderCase} from './growth-evaluation.ts';
import type {Memory} from './domain.ts';
export async function verifyGrowthCalculation(baseline:Memory,candidate:Memory,cases:OrderCase[]):Promise<void>{
 const plan=calculationPlan(baseline,candidate,cases);
 const result=await runOracle(undefined,plan.input,plan.source);
 if(result.timedOut||result.outputExceeded||result.signal||result.stderr||result.exitCode!==0||JSON.stringify(JSON.parse(result.stdout))!==JSON.stringify(plan.expected))throw new Error('Independent bounded calculation did not confirm the exact policies and input orders');
}
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

export interface Artifact {
  id: string;
  version: number;
  sha256: string;
  path: string;
  kind: 'code' | 'document';
}

export interface FixtureWorkspace {
  root: string;
  path: string;
  workId: string;
}

export interface ArtifactSnapshot {
  sha256: string;
  path: string;
}

export interface FixtureProcessEvidence {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputExceeded: boolean;
  stdout: string;
  stderr: string;
  oracleSha256: string;
}

export interface FixtureVerification {
  verdict: 'passed' | 'failed' | 'stale';
  evidence: string[];
  artifactSha256: string;
  criteriaVersion: string;
  process?: FixtureProcessEvidence;
}

type CandidateVariant = 'wrong' | 'correct';
type FixtureName = 'calculation' | 'summary';
interface Manifest {
  schema: 'massion-controlled-fixture/v1';
  workId: string;
  artifacts: Partial<Record<FixtureName, Artifact>>;
}

export const CALCULATION_CRITERIA_VERSION = 'calculation-total/v1';
export const DOCUMENT_CRITERIA_VERSION = 'summary-facts/v1';
export const FIXTURE_LIMITS = Object.freeze({
  timeoutMs: 2_000,
  maxOutputBytes: 16_384,
  maxFileBytes: 65_536,
  maxHeapMegabytes: 32,
});
const MANIFEST_FILE = '.fixture-manifest.json';
const FILE_NAMES: Record<FixtureName, string> = {
  calculation: 'calculation.mjs',
  summary: 'summary.json',
};
const CANDIDATES: Record<CandidateVariant, string> = {
  wrong: `// Controlled fixture: intentionally incorrect per-line rounding.\nexport function totalCents(items, discountBasisPoints = 0) {\n  return items.reduce((sum, item) => sum + Math.round(item.unitPriceCents * item.quantity * (10000 - discountBasisPoints) / 10000), 0);\n}\n`,
  correct: `// Controlled fixture: apply the order-level discount after subtotaling.\nexport function totalCents(items, discountBasisPoints = 0) {\n  const subtotal = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);\n  return Math.round(subtotal * (10000 - discountBasisPoints) / 10000);\n}\n`,
};
const DOCUMENT_SOURCE = [
  '# Harbor delivery review',
  'The owner is Mira.',
  'The review date is 2026-10-12.',
  'There are 3 open issues.',
  'The next step is to run the acceptance review.',
  '',
].join('\n');
const DOCUMENT_FACTS = Object.freeze([
  'Mira owns the delivery review.',
  'The review is scheduled for 2026-10-12.',
  'There are 3 open issues.',
  'The next step is to run the acceptance review.',
]);

// The verifier owns these expected values; they are not computed by the
// candidate, its generator, or a second copy of its calculation algorithm.
const CALCULATION_ORACLE = `
let source = '';
for await (const chunk of process.stdin) {
  source += chunk;
  if (Buffer.byteLength(source) > 65536) throw new Error('input limit');
}
const { totalCents } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const cases = [
  { name: 'empty order', items: [], discount: 0, expected: 0 },
  { name: 'single line', items: [{ unitPriceCents: 125, quantity: 2 }], discount: 0, expected: 250 },
  { name: 'mixed quantities', items: [{ unitPriceCents: 199, quantity: 3 }, { unitPriceCents: 450, quantity: 2 }], discount: 0, expected: 1497 },
  { name: 'whole order discount', items: [{ unitPriceCents: 1000, quantity: 2 }], discount: 2500, expected: 1500 },
  { name: 'round after aggregate', items: [{ unitPriceCents: 1, quantity: 1 }, { unitPriceCents: 1, quantity: 1 }], discount: 5000, expected: 1 },
  { name: 'three fractional lines', items: [{ unitPriceCents: 1, quantity: 1 }, { unitPriceCents: 1, quantity: 1 }, { unitPriceCents: 1, quantity: 1 }], discount: 5000, expected: 2 },
  { name: 'full discount', items: [{ unitPriceCents: 9999, quantity: 3 }], discount: 10000, expected: 0 },
  { name: 'nonround discount', items: [{ unitPriceCents: 1234, quantity: 2 }, { unitPriceCents: 57, quantity: 3 }], discount: 1750, expected: 2177 },
];
const results = cases.map(({ name, items, discount, expected }) => {
  const actual = totalCents(items, discount);
  return { name, expected, actual, passed: actual === expected };
});
process.stdout.write(JSON.stringify({ schema: 'massion-oracle/v1', criteriaVersion: 'calculation-total/v1', results }));
process.exitCode = results.every(result => result.passed) ? 0 : 1;
`;

// These cases are held out from the acceptance oracle above. The expected
// values are independently fixed, rather than generated by either candidate.
const GROWTH_ORACLE = `
let source = '';
for await (const chunk of process.stdin) {
  source += chunk;
  if (Buffer.byteLength(source) > 65536) throw new Error('input limit');
}
const { totalCents } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const cases = [
  { name: 'held-out paired three-cent lines', items: [{ unitPriceCents: 3, quantity: 1 }, { unitPriceCents: 3, quantity: 1 }], discount: 5000, expected: 3 },
  { name: 'held-out quarter-price aggregate', items: [{ unitPriceCents: 2, quantity: 1 }, { unitPriceCents: 2, quantity: 1 }, { unitPriceCents: 2, quantity: 1 }], discount: 7500, expected: 2 },
  { name: 'held-out ninety-percent discount', items: [{ unitPriceCents: 5, quantity: 1 }, { unitPriceCents: 5, quantity: 1 }], discount: 9000, expected: 1 },
  { name: 'held-out mixed large lines', items: [{ unitPriceCents: 299, quantity: 2 }, { unitPriceCents: 101, quantity: 3 }], discount: 1250, expected: 788 },
  { name: 'held-out fractional basis points', items: [{ unitPriceCents: 4, quantity: 2 }, { unitPriceCents: 7, quantity: 1 }], discount: 3333, expected: 10 },
  { name: 'held-out paired seven-cent lines', items: [{ unitPriceCents: 7, quantity: 1 }, { unitPriceCents: 7, quantity: 1 }], discount: 5000, expected: 7 },
];
const results = cases.map(({ name, items, discount, expected }) => {
  const actual = totalCents(items, discount);
  return { name, expected, actual, passed: actual === expected };
});
process.stdout.write(JSON.stringify({ schema: 'massion-growth-oracle/v1', criteriaVersion: 'calculation-held-out/v1', results }));
process.exitCode = results.every(result => result.passed) ? 0 : 1;
`;

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export const BUILTIN_FIXTURE_EXTENSION = Object.freeze({
  id: 'massion.builtin.controlled-fixture',
  version: '1.0.0',
  hostCompatibility: 'massion.execution/v1',
  distribution: 'built-in',
  artifactSha256: hash(JSON.stringify({ CANDIDATES, CALCULATION_ORACLE, GROWTH_ORACLE, DOCUMENT_SOURCE, DOCUMENT_FACTS })),
  contributions: Object.freeze(['fixture.calculation.write', 'fixture.calculation.verify', 'fixture.document.write', 'fixture.document.verify']),
  capabilities: Object.freeze(['workspace.read', 'workspace.write', 'controlled-node-process']),
  // These describe the bounded built-in route, not external-package approval.
  installed: true,
  enabled: true,
  externalPackagesAllowed: false,
  executionAuthorization: 'explicit-workspace-fixture-call',
});

export const BUILTIN_FIXTURE_EXTENSION_PIN = `${BUILTIN_FIXTURE_EXTENSION.id}@${BUILTIN_FIXTURE_EXTENSION.version}`;

export const FIXTURE_PROVIDER = Object.freeze({
  providerId: 'massion.fixture',
  modelId: 'deterministic-fixture-v1',
  configurationVersion: 'v1',
  enabled: true,
  kind: 'deterministic-fixture',
  realModel: false,
  capabilities: Object.freeze(['controlled-code-candidate', 'controlled-document-summary', 'controlled-code-verification', 'controlled-document-verification']),
  selectionReason: 'Known local fixtures for reproducible development evidence; no claim of model quality.',
  configuration: Object.freeze({ network: false, inheritedEnvironment: false, arbitraryCode: false }),
  limits: FIXTURE_LIMITS,
});

/** Admission gate for the enabled built-in contribution and provider pins. */
export function assertFixtureCapability(input: {
  extensionVersion: string;
  provider: string;
  model: string;
  configVersion: string;
  capability: string;
}): void {
  const contributions: Record<string, string> = {
    'controlled-code-candidate': 'fixture.calculation.write',
    'controlled-code-verification': 'fixture.calculation.verify',
    'controlled-document-summary': 'fixture.document.write',
    'controlled-document-verification': 'fixture.document.verify',
  };
  if (!BUILTIN_FIXTURE_EXTENSION.installed || !BUILTIN_FIXTURE_EXTENSION.enabled ||
      input.extensionVersion !== BUILTIN_FIXTURE_EXTENSION_PIN) throw new Error('Fixture capability denied: extension pin is not installed and enabled.');
  if (!FIXTURE_PROVIDER.enabled || input.provider !== FIXTURE_PROVIDER.providerId ||
      input.model !== FIXTURE_PROVIDER.modelId || input.configVersion !== FIXTURE_PROVIDER.configurationVersion) {
    throw new Error('Fixture capability denied: provider, model, or configuration pin does not match.');
  }
  const contribution = Object.hasOwn(contributions, input.capability) ? contributions[input.capability] : undefined;
  if (!contribution || !FIXTURE_PROVIDER.capabilities.includes(input.capability) ||
      !BUILTIN_FIXTURE_EXTENSION.contributions.includes(contribution)) throw new Error('Fixture capability denied: required contribution is unavailable.');
}

function fail(message: string): never {
  throw new Error(`Fixture boundary: ${message}`);
}

function validateWorkId(workId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workId)) fail('invalid work ID');
}

function absoluteLexical(path: string): string {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) fail('absolute path required');
  if (path.split(/[\\/]/).includes('..')) fail('path traversal is forbidden');
  return resolve(path);
}

function within(root: string, path: string): void {
  const part = relative(root, path);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) fail('path escapes workspace');
}

/** Reject symlinks in every existing component, including root ancestors. */
async function checkDirectory(path: string, create = false): Promise<void> {
  const target = absoluteLexical(path);
  let current = resolve(sep);
  for (const part of target.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('directory must be real and not a symlink');
  }
  if (await realpath(target) !== target) fail('directory realpath mismatch');
}

async function validateWorkspace(workspace: FixtureWorkspace): Promise<void> {
  validateWorkId(workspace.workId);
  const root = absoluteLexical(workspace.root);
  const path = absoluteLexical(workspace.path);
  if (workspace.root !== root || workspace.path !== path || path !== join(root, workspace.workId)) fail('workspace identity mismatch');
  within(root, path);
  await checkDirectory(root);
  await checkDirectory(path);
}

async function validateFile(workspace: FixtureWorkspace, path: string, mayBeAbsent = false): Promise<void> {
  await validateWorkspace(workspace);
  const normalized = absoluteLexical(path);
  within(workspace.path, normalized);
  if (dirname(normalized) !== workspace.path) fail('fixture files must be direct workspace children');
  try {
    const stat = await lstat(normalized);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('file must be regular, singly linked, and not a symlink');
    if (await realpath(normalized) !== normalized) fail('file realpath mismatch');
  } catch (error) {
    if (!mayBeAbsent || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readBounded(workspace: FixtureWorkspace, path: string): Promise<Buffer> {
  await validateFile(workspace, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > FIXTURE_LIMITS.maxFileBytes) fail('file type or size limit');
    // A bounded read also covers concurrent growth after stat().
    const bytes = Buffer.alloc(FIXTURE_LIMITS.maxFileBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > FIXTURE_LIMITS.maxFileBytes) fail('file size limit');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function atomicWrite(workspace: FixtureWorkspace, path: string, bytes: string): Promise<void> {
  if (Buffer.byteLength(bytes) > FIXTURE_LIMITS.maxFileBytes) fail('file size limit');
  await validateFile(workspace, path, true);
  const temporary = join(workspace.path, `.write-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await validateFile(workspace, path, true);
    await validateFile(workspace, temporary);
    await rename(temporary, path);
  } finally {
    await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readManifest(workspace: FixtureWorkspace): Promise<Manifest> {
  const manifest = JSON.parse((await readBounded(workspace, join(workspace.path, MANIFEST_FILE))).toString('utf8')) as Manifest;
  if (manifest.schema !== 'massion-controlled-fixture/v1' || manifest.workId !== workspace.workId ||
      !manifest.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts)) fail('invalid workspace manifest');
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    if (!Object.hasOwn(FILE_NAMES, name) || artifact === null || typeof artifact !== 'object' ||
        artifact.id !== `${workspace.workId}:${name}` || !Number.isSafeInteger(artifact.version) || artifact.version < 1 ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.path !== join(workspace.path, FILE_NAMES[name as FixtureName]) ||
        artifact.kind !== (name === 'calculation' ? 'code' : 'document')) fail('invalid manifest artifact');
  }
  return manifest;
}

// Serialize fixture mutations within this host. This is not a durable lock or
// protection against an adversary changing the host filesystem concurrently.
const queues = new Map<string, Promise<unknown>>();
async function serialize<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(path, next);
  try { return await next; }
  finally { if (queues.get(path) === next) queues.delete(path); }
}

export async function createFixtureWorkspace(root: string, workId: string): Promise<FixtureWorkspace> {
  validateWorkId(workId);
  const normalizedRoot = absoluteLexical(root);
  await checkDirectory(normalizedRoot, true);
  const workspace = Object.freeze({ root: normalizedRoot, path: join(normalizedRoot, workId), workId });
  await checkDirectory(workspace.path, true);
  return serialize(workspace.path, async () => {
    const manifestPath = join(workspace.path, MANIFEST_FILE);
    try {
      await readManifest(workspace);
      const source = await readBounded(workspace, join(workspace.path, 'source.md'));
      if (hash(source) !== hash(DOCUMENT_SOURCE)) fail('document source changed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // An incomplete preexisting workspace is not silently adopted or reset.
      let existingManifest = false;
      try { await lstat(manifestPath); existingManifest = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existingManifest) fail('incomplete workspace');
      if ((await readdir(workspace.path)).length !== 0) fail('refusing to initialize a nonempty unmarked workspace');
      await atomicWrite(workspace, join(workspace.path, 'source.md'), DOCUMENT_SOURCE);
      const manifest: Manifest = { schema: 'massion-controlled-fixture/v1', workId, artifacts: {} };
      await atomicWrite(workspace, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return workspace;
  });
}

async function writeCandidate(workspace: FixtureWorkspace, name: FixtureName, bytes: string): Promise<Artifact> {
  return serialize(workspace.path, async () => {
    await validateWorkspace(workspace);
    const manifest = await readManifest(workspace);
    const artifact: Artifact = {
      id: `${workspace.workId}:${name}`,
      version: (manifest.artifacts[name]?.version ?? 0) + 1,
      sha256: hash(bytes),
      path: join(workspace.path, FILE_NAMES[name]),
      kind: name === 'calculation' ? 'code' : 'document',
    };
    if (!Number.isSafeInteger(artifact.version)) fail('artifact version overflow');
    await atomicWrite(workspace, artifact.path, bytes);
    manifest.artifacts[name] = artifact;
    await atomicWrite(workspace, join(workspace.path, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    return Object.freeze(artifact);
  });
}

export async function writeCalculationCandidate(workspace: FixtureWorkspace, variant: CandidateVariant): Promise<Artifact> {
  if (variant !== 'wrong' && variant !== 'correct') fail('unknown controlled candidate');
  return writeCandidate(workspace, 'calculation', CANDIDATES[variant]);
}

export async function writeDocumentSummaryCandidate(workspace: FixtureWorkspace, variant: CandidateVariant): Promise<Artifact> {
  if (variant !== 'wrong' && variant !== 'correct') fail('unknown controlled candidate');
  const facts = [...DOCUMENT_FACTS];
  if (variant === 'wrong') facts[2] = 'There are 4 open issues.';
  const summary = { title: 'Harbor delivery review summary', sourceSha256: hash(DOCUMENT_SOURCE), facts };
  return writeCandidate(workspace, 'summary', `${JSON.stringify(summary, null, 2)}\n`);
}

async function pinnedBytes(workspace: FixtureWorkspace, artifact: Artifact, name: FixtureName): Promise<Buffer | null> {
  // Boundary violations are errors, never merely a failed assurance verdict.
  await validateFile(workspace, artifact.path, true);
  const manifest = await readManifest(workspace);
  const pinned = manifest.artifacts[name];
  if (!pinned || artifact.id !== pinned.id || artifact.version !== pinned.version || artifact.kind !== pinned.kind ||
      artifact.path !== pinned.path || artifact.sha256 !== pinned.sha256) return null;
  try {
    const bytes = await readBounded(workspace, artifact.path);
    return hash(bytes) === artifact.sha256 ? bytes : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Preserve pinned bytes for delivery without rewriting historical versions.
 * Read-only permissions prevent accidental mutation; the filesystem owner can
 * still change them, so consumers must check the digest. This does not certify
 * assurance or grant acceptance by itself.
 */
export async function sealArtifact(workspace: FixtureWorkspace, artifact: Artifact): Promise<ArtifactSnapshot> {
  const name: FixtureName = artifact.kind === 'code' ? 'calculation' : 'summary';
  const bytes = await pinnedBytes(workspace, artifact, name);
  if (!bytes) throw new Error('Cannot seal a stale artifact.');
  const suffix = artifact.kind === 'code' ? 'mjs' : 'json';
  const path = join(workspace.path, `.artifact-${artifact.sha256}.${suffix}`);
  await validateFile(workspace, path, true);
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (handle) {
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o400);
      await handle.sync();
    } finally { await handle.close(); }
  }
  const snapshot = Object.freeze({ path, sha256: artifact.sha256 });
  if (!await verifyArtifactSnapshot(workspace, snapshot)) throw new Error('Existing artifact snapshot is incomplete or has changed; refusing overwrite.');
  if (!await pinnedBytes(workspace, artifact, name)) throw new Error('Artifact became stale while sealing its bytes.');
  return snapshot;
}

export async function verifyArtifactSnapshot(workspace: FixtureWorkspace, snapshot: ArtifactSnapshot): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(snapshot.sha256)) fail('invalid snapshot hash');
  const allowedPaths = ['mjs', 'json'].map(suffix => join(workspace.path, `.artifact-${snapshot.sha256}.${suffix}`));
  await validateFile(workspace, snapshot.path, true);
  if (!allowedPaths.includes(snapshot.path)) fail('snapshot path must be content addressed');
  try {
    const bytes = await readBounded(workspace, snapshot.path);
    const stat = await lstat(snapshot.path);
    return hash(bytes) === snapshot.sha256 && (stat.mode & 0o222) === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function verdict(artifact: Artifact, criteriaVersion: string, result: FixtureVerification['verdict'], evidence: string[], processEvidence?: FixtureProcessEvidence): FixtureVerification {
  return { verdict: result, evidence, artifactSha256: artifact.sha256, criteriaVersion, ...(processEvidence ? { process: processEvidence } : {}) };
}

async function runOracle(workspace: FixtureWorkspace | undefined, bytes: Buffer, oracleSource = CALCULATION_ORACLE): Promise<FixtureProcessEvidence> {
  if (workspace) await validateWorkspace(workspace);
  return new Promise(resolveResult => {
    // No shell, packages, inherited NODE_OPTIONS, secrets, or arbitrary command.
    // Node permissions are defense in depth for known fixture bytes, not an OS sandbox.
    const child = spawn(process.execPath, [
      '--permission', '--disable-proto=throw', '--max-old-space-size=32',
      '--input-type=module', '--eval', oracleSource,
    ], { ...(workspace ? { cwd: workspace.path } : {}), env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const evidence: FixtureProcessEvidence = {
      pid: child.pid ?? null, exitCode: null, signal: null, timedOut: false,
      outputExceeded: false, stdout: '', stderr: '', oracleSha256: hash(oracleSource),
    };
    let outputBytes = 0;
    const collect = (target: 'stdout' | 'stderr', data: Buffer): void => {
      const remaining = Math.max(0, FIXTURE_LIMITS.maxOutputBytes - outputBytes);
      evidence[target] += data.subarray(0, remaining).toString('utf8');
      outputBytes += data.length;
      if (outputBytes > FIXTURE_LIMITS.maxOutputBytes) { evidence.outputExceeded = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', data => collect('stdout', data));
    child.stderr.on('data', data => collect('stderr', data));
    const timer = setTimeout(() => { evidence.timedOut = true; child.kill('SIGKILL'); }, FIXTURE_LIMITS.timeoutMs);
    child.on('error', error => collect('stderr', Buffer.from(`Oracle process error: ${error.message}`)));
    child.stdin.on('error', error => collect('stderr', Buffer.from(`Oracle input error: ${error.message}`)));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      evidence.exitCode = code;
      evidence.signal = signal;
      resolveResult(evidence);
    });
    child.stdin.end(bytes);
  });
}

export async function independentlyVerifyCalculation(workspace: FixtureWorkspace, artifact: Artifact, criteriaVersion: string): Promise<FixtureVerification> {
  if (criteriaVersion !== CALCULATION_CRITERIA_VERSION) return verdict(artifact, criteriaVersion, 'failed', ['Unsupported pinned calculation criteria version.']);
  const bytes = await pinnedBytes(workspace, artifact, 'calculation');
  if (!bytes) return verdict(artifact, criteriaVersion, 'stale', ['Current artifact version or bytes differ from the pinned artifact.']);
  if (!Object.values(CANDIDATES).some(candidate => bytes.equals(Buffer.from(candidate)))) {
    return verdict(artifact, criteriaVersion, 'failed', ['Source is outside the controlled fixture allowlist; no code was executed.']);
  }
  const processEvidence = await runOracle(workspace, bytes);
  if (!await pinnedBytes(workspace, artifact, 'calculation')) {
    return verdict(artifact, criteriaVersion, 'stale', ['Artifact changed while the independent oracle was running.'], processEvidence);
  }
  if (processEvidence.timedOut || processEvidence.outputExceeded || processEvidence.signal || processEvidence.stderr) {
    return verdict(artifact, criteriaVersion, 'failed', ['Independent oracle did not complete within the execution contract.'], processEvidence);
  }
  let report;
  try { report = JSON.parse(processEvidence.stdout); }
  catch { return verdict(artifact, criteriaVersion, 'failed', ['Independent oracle returned invalid evidence.'], processEvidence); }
  if (report.schema !== 'massion-oracle/v1' || report.criteriaVersion !== criteriaVersion || !Array.isArray(report.results) || report.results.length !== 8) {
    return verdict(artifact, criteriaVersion, 'failed', ['Independent oracle evidence schema does not match the pinned criteria.'], processEvidence);
  }
  const passed = processEvidence.exitCode === 0 && report.results.every((result: { passed: boolean }) => result.passed === true);
  return verdict(artifact, criteriaVersion, passed ? 'passed' : 'failed', report.results.map((result: { name: string; expected: number; actual: number; passed: boolean }) =>
    `${result.passed ? 'PASS' : 'FAIL'} ${result.name}: expected ${result.expected}, observed ${result.actual}`), processEvidence);
}

export async function independentlyVerifyDocumentSummary(workspace: FixtureWorkspace, artifact: Artifact, criteriaVersion: string): Promise<FixtureVerification> {
  if (criteriaVersion !== DOCUMENT_CRITERIA_VERSION) return verdict(artifact, criteriaVersion, 'failed', ['Unsupported pinned document criteria version.']);
  const bytes = await pinnedBytes(workspace, artifact, 'summary');
  if (!bytes) return verdict(artifact, criteriaVersion, 'stale', ['Current document version or bytes differ from the pinned artifact.']);
  const source = await readBounded(workspace, join(workspace.path, 'source.md'));
  if (hash(source) !== hash(DOCUMENT_SOURCE)) return verdict(artifact, criteriaVersion, 'stale', ['Source document differs from the fixed evidence source.']);
  let summary;
  try { summary = JSON.parse(bytes.toString('utf8')); }
  catch { return verdict(artifact, criteriaVersion, 'failed', ['Summary is not valid structured document evidence.']); }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return verdict(artifact, criteriaVersion, 'failed', ['Summary must be a structured document object.']);
  }
  const checks = [
    ['source attribution', summary.sourceSha256 === hash(source)],
    ['summary title', summary.title === 'Harbor delivery review summary'],
    ['facts supported by source', JSON.stringify(summary.facts) === JSON.stringify(DOCUMENT_FACTS)],
  ] as const;
  if (!await pinnedBytes(workspace, artifact, 'summary') || hash(await readBounded(workspace, join(workspace.path, 'source.md'))) !== hash(DOCUMENT_SOURCE)) {
    return verdict(artifact, criteriaVersion, 'stale', ['Summary or source changed during verification.']);
  }
  return verdict(artifact, criteriaVersion, checks.every(([, passed]) => passed) ? 'passed' : 'failed',
    checks.map(([name, passed]) => `${passed ? 'PASS' : 'FAIL'} ${name}`));
}

/** Transparent test routing, not a claim that a model learned from memory. */
export function chooseFixtureVariant(memoryContents: readonly string[]): CandidateVariant {
  return memoryContents.includes('Round aggregate once') ? 'correct' : 'wrong';
}

export async function evaluateCalculationImprovement(): Promise<{
  baseline: number;
  candidate: number;
  heldOut: string;
  evidence: string[];
}> {
  const evidence: string[] = [];
  const scores: number[] = [];
  for (const variant of ['wrong', 'correct'] as const) {
    const result = await runOracle(undefined, Buffer.from(CANDIDATES[variant]), GROWTH_ORACLE);
    if (result.timedOut || result.outputExceeded || result.signal || result.stderr ||
        (result.exitCode !== 0 && result.exitCode !== 1)) throw new Error('Held-out oracle execution did not complete.');
    const report = JSON.parse(result.stdout) as {
      schema: string;
      criteriaVersion: string;
      results: { name: string; expected: number; actual: number; passed: boolean }[];
    };
    if (report.schema !== 'massion-growth-oracle/v1' || report.criteriaVersion !== 'calculation-held-out/v1' ||
        !Array.isArray(report.results) || report.results.length !== 6 ||
        !report.results.every(item => typeof item.name === 'string' && Number.isFinite(item.expected) && Number.isFinite(item.actual) && item.passed === (item.expected === item.actual))) {
      throw new Error('Held-out oracle returned invalid evidence.');
    }
    const score = report.results.filter(item => item.passed).length;
    if ((score === report.results.length ? 0 : 1) !== result.exitCode) throw new Error('Held-out oracle exit disagrees with its evidence.');
    scores.push(score);
    evidence.push(`${variant === 'wrong' ? 'baseline' : 'candidate'}: ${score}/${report.results.length} held-out cases passed; artifact SHA-256 ${hash(CANDIDATES[variant])}; oracle SHA-256 ${result.oracleSha256}; separate process ${result.pid}, exit ${result.exitCode}.`);
    evidence.push(...report.results.map(item => `${variant}: ${item.passed ? 'PASS' : 'FAIL'} ${item.name}: expected ${item.expected}, observed ${item.actual}`));
  }
  return {
    baseline: scores[0]!,
    candidate: scores[1]!,
    heldOut: `calculation-held-out/v1; oracle SHA-256 ${hash(GROWTH_ORACLE)}; six cases distinct from acceptance criteria`,
    evidence,
  };
}
