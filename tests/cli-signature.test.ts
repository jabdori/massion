import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, realpathSync, symlinkSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tempRoot} from './support/temp-root.ts';
import {verifySignedCli, cliStamp} from '../src/cli-launcher.ts';

const darwin = process.platform === 'darwin';
const mac = {skip: !darwin && 'verifySignedCli only runs on macOS'};

interface SignedExecutable {
  path: string;
  teamId: string;
  identifier: string;
}

function codesignDisplay(candidate: string): {executable: SignedExecutable | null; checkedPath: string} {
  if (!existsSync(candidate)) return {executable: null, checkedPath: candidate};
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return {executable: null, checkedPath: candidate};
  }
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', realCandidate], {encoding: 'utf8', timeout: 5000});
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  // Only Developer ID signed tools satisfy `certificate leaf[subject.OU]`;
  // Apple's own software-signing certificates carry a team id but not as the
  // leaf certificate's subject OU.
  if (result.status !== 0 || !teamId || teamId === 'not set' || !identifier || !output.includes('Developer ID')) {
    return {executable: null, checkedPath: realCandidate};
  }
  const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${teamId}" and identifier "${identifier}"`;
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement}`, realCandidate], {encoding: 'utf8', timeout: 5000});
  if (verified.status !== 0) return {executable: null, checkedPath: realCandidate};
  return {executable: {path: realCandidate, teamId, identifier}, checkedPath: realCandidate};
}

function findSignedExecutable(): {executable: SignedExecutable | null; tried: string[]} {
  if (!darwin) return {executable: null, tried: []};
  const candidates: string[] = [];
  const add = (path: string) => {
    if (path && !candidates.includes(path)) candidates.push(path);
  };

  try {
    add(realpathSync(process.execPath));
  } catch {
    add(process.execPath);
  }

  const selected = spawnSync('xcode-select', ['-p'], {encoding: 'utf8', timeout: 5000});
  const developerDir = (selected.stdout ?? '').trim();
  if (developerDir) add(`${developerDir}/usr/bin/git`);

  add('/Applications/Xcode.app/Contents/Developer/usr/bin/git');
  add('/Applications/Xcode.app/Contents/MacOS/Xcode');

  try {
    for (const name of readdirSync('/Applications')) {
      if (!/^Xcode.*\.app$/.test(name)) continue;
      const base = join('/Applications', name);
      add(join(base, 'Contents/Developer/usr/bin/git'));
      add(join(base, 'Contents/MacOS/Xcode'));
    }
  } catch {
    // /Applications may be unreadable on some hosts; ignore and inspect queued candidates.
  }

  const tried: string[] = [];
  for (const candidate of candidates) {
    const {executable, checkedPath} = codesignDisplay(candidate);
    if (!tried.includes(checkedPath)) tried.push(checkedPath);
    if (executable) return {executable, tried};
  }

  // No filesystem-wide scan: probing every Mach-O with codesign has been
  // observed to exceed the CI job timeout. If neither Node nor the well-known
  // toolchains are Developer ID signed, skip test (a) and name what was tried.
  return {executable: null, tried};
}

const discovery = findSignedExecutable();
const signedExecutable = discovery.executable;
const skipA = !darwin
  ? 'verifySignedCli only runs on macOS'
  : (!signedExecutable && `no Developer ID signed executable was found (tried: ${discovery.tried.join(', ') || 'none'})`);

const fallbackTarget = '/bin/ls';

async function assertAccepted(executable: SignedExecutable) {
  const result = await verifySignedCli(executable.path, {teamId: executable.teamId, identifier: executable.identifier});
  assert.equal(result.path, executable.path);
  assert.equal(result.stamp, cliStamp(executable.path));
  return result;
}

test('verifySignedCli accepts a Developer ID signed executable and returns its path and stamp', {skip: skipA}, async () => {
  assert.ok(signedExecutable);
  await assertAccepted(signedExecutable);
});

test('verifySignedCli refuses a wrong team id', mac, async () => {
  if (signedExecutable) {
    await assertAccepted(signedExecutable);
    await assert.rejects(() => verifySignedCli(signedExecutable.path, {teamId: 'ZZZZZZZZZZ', identifier: signedExecutable.identifier}));
    return;
  }
  await assert.rejects(() => verifySignedCli(fallbackTarget, {teamId: 'AAAAAAAAAA', identifier: 'com.apple.ls'}));
});

test('verifySignedCli refuses a wrong identifier', mac, async () => {
  if (signedExecutable) {
    await assertAccepted(signedExecutable);
    await assert.rejects(() => verifySignedCli(signedExecutable.path, {teamId: signedExecutable.teamId, identifier: `${signedExecutable.identifier}.wrong`}));
    return;
  }
  await assert.rejects(() => verifySignedCli(fallbackTarget, {teamId: 'AAAAAAAAAA', identifier: 'com.apple.wrong'}));
});

test('verifySignedCli refuses an Apple-signed binary without a team id', mac, async () => {
  const display = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', '/bin/ls'], {encoding: 'utf8', timeout: 5000});
  assert.equal(display.status, 0);
  assert.match(`${display.stdout ?? ''}\n${display.stderr ?? ''}`, /^TeamIdentifier=not set$/m);
  const appleSigned = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '-R=anchor apple and identifier "com.apple.ls"', '/bin/ls'], {encoding: 'utf8', timeout: 5000});
  assert.equal(appleSigned.status, 0);
  if (signedExecutable) {
    await assertAccepted(signedExecutable);
    await assert.rejects(() => verifySignedCli('/bin/ls', {teamId: signedExecutable.teamId, identifier: 'com.apple.ls'}));
  }
  await assert.rejects(() => verifySignedCli('/bin/ls', {teamId: 'AAAAAAAAAA', identifier: 'com.apple.ls'}));
});

test('verifySignedCli refuses a team id containing a double quote', mac, async () => {
  if (signedExecutable) await assertAccepted(signedExecutable);
  const target = signedExecutable?.path ?? fallbackTarget;
  await assert.rejects(() => verifySignedCli(target, {teamId: 'abc"def', identifier: signedExecutable?.identifier ?? 'com.apple.ls'}));
});

test('verifySignedCli refuses a double quote or backslash in team id or identifier before calling codesign', mac, async () => {
  if (signedExecutable) await assertAccepted(signedExecutable);
  await assert.rejects(() => verifySignedCli('/bin/ls', {teamId: 'abc"def', identifier: 'com.apple.ls'}));
  await assert.rejects(() => verifySignedCli('/bin/ls', {teamId: 'abc\\def', identifier: 'com.apple.ls'}));
  await assert.rejects(() => verifySignedCli('/bin/ls', {teamId: 'AAAAAAAAAA', identifier: 'com.apple"ls'}));
  await assert.rejects(() => verifySignedCli('/bin/ls', {teamId: 'AAAAAAAAAA', identifier: 'com.apple\\ls'}));
  // Quote injection that codesign itself accepts if allowed into the requirement text.
  await assert.rejects(() => verifySignedCli('/bin/ls', {teamId: 'ZZZZZZZZZZ', identifier: 'wrong" or identifier "com.apple.ls'}));
  if (signedExecutable) {
    await assert.rejects(() => verifySignedCli(signedExecutable.path, {
      teamId: 'ZZZZZZZZZZ',
      identifier: `wrong" or identifier "${signedExecutable.identifier}`,
    }));
  }
});

test('verifySignedCli refuses a symbolic link', mac, async () => {
  const target = signedExecutable?.path ?? fallbackTarget;
  if (signedExecutable) await assertAccepted(signedExecutable);
  const link = join(tempRoot(), `massion-cli-signature-link-${process.pid}`);
  try {
    try { unlinkSync(link); } catch {}
    symlinkSync(target, link);
    await assert.rejects(() => verifySignedCli(link, {
      teamId: signedExecutable?.teamId ?? 'AAAAAAAAAA',
      identifier: signedExecutable?.identifier ?? 'com.apple.ls',
    }));
  } finally {
    try { unlinkSync(link); } catch {}
  }
});
