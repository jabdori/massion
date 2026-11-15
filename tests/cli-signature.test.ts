import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, statSync, symlinkSync, unlinkSync} from 'node:fs';
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

function codesignDisplay(candidate: string): SignedExecutable | null {
  if (!existsSync(candidate)) return null;
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', candidate], {encoding: 'utf8'});
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  // Only Developer ID signed tools satisfy `certificate leaf[subject.OU]`;
  // Apple's own software-signing certificates carry a team id but not as the
  // leaf certificate's subject OU.
  if (result.status !== 0 || !teamId || teamId === 'not set' || !identifier || !output.includes('Developer ID')) return null;
  const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${teamId}" and identifier "${identifier}"`;
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--strict', `-R=${requirement}`, candidate], {encoding: 'utf8'});
  if (verified.status !== 0) return null;
  return {path: candidate, teamId, identifier};
}

function findSignedExecutable(): SignedExecutable | null {
  const candidates: string[] = [];
  const add = (path: string) => {
    if (path && !candidates.includes(path)) candidates.push(path);
  };

  const selected = spawnSync('xcode-select', ['-p'], {encoding: 'utf8'});
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
    // /Applications may be unreadable on some hosts; fall through to the scan below.
  }

  for (const candidate of candidates) {
    const found = codesignDisplay(candidate);
    if (found) return found;
  }

  // No filesystem-wide scan: probing every Mach-O with codesign has been
  // observed to exceed the CI job timeout. If the well-known Apple toolchains
  // above are not Developer ID signed, skip test (a) rather than hang.
  return null;
}

const signedExecutable = findSignedExecutable();
const skipA = !signedExecutable && 'no Developer ID signed executable was found on this host';

const fallbackTarget = '/bin/ls';

test('verifySignedCli accepts a Developer ID signed executable and returns its path and stamp', {skip: skipA}, async () => {
  assert.ok(signedExecutable);
  const {path, teamId, identifier} = signedExecutable!;
  const result = await verifySignedCli(path, {teamId, identifier});
  assert.equal(result.path, path);
  assert.equal(result.stamp, cliStamp(path));
});

test('verifySignedCli refuses a wrong team id', mac, async () => {
  const target = signedExecutable?.path ?? fallbackTarget;
  const teamId = signedExecutable ? 'ZZZZZZZZZZ' : 'AAAAAAAAAA';
  const identifier = signedExecutable?.identifier ?? 'com.apple.ls';
  await assert.rejects(() => verifySignedCli(target, {teamId, identifier}));
});

test('verifySignedCli refuses a wrong identifier', mac, async () => {
  const target = signedExecutable?.path ?? fallbackTarget;
  const teamId = signedExecutable?.teamId ?? 'AAAAAAAAAA';
  const identifier = signedExecutable ? `${signedExecutable.identifier}.wrong` : 'com.apple.wrong';
  await assert.rejects(() => verifySignedCli(target, {teamId, identifier}));
});

test('verifySignedCli refuses an Apple-signed binary without a team id', mac, async () => {
  await assert.rejects(() => verifySignedCli('/bin/ls', {teamId: 'AAAAAAAAAA', identifier: 'com.apple.ls'}));
});

test('verifySignedCli refuses a team id containing a double quote', mac, async () => {
  const target = signedExecutable?.path ?? fallbackTarget;
  await assert.rejects(() => verifySignedCli(target, {teamId: 'abc"def', identifier: signedExecutable?.identifier ?? 'com.apple.ls'}));
});

test('verifySignedCli refuses a symbolic link', mac, async () => {
  const link = join(tempRoot(), `massion-cli-signature-link-${process.pid}`);
  try {
    try { unlinkSync(link); } catch {}
    symlinkSync('/bin/ls', link);
    await assert.rejects(() => verifySignedCli(link, {teamId: 'AAAAAAAAAA', identifier: 'com.apple.ls'}));
  } finally {
    try { unlinkSync(link); } catch {}
  }
});
