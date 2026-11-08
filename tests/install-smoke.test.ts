import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {access,copyFile,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const passed='TAP version 13\nok 1 - fixture\n1..1\n# pass 1\n# fail 0\n# skipped 0\n';
async function fixture(t:TestContext,first=passed,second=passed){
 const root=await mkdtemp(join(await realpath(tmpdir()),'massion-smoke-guard-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'scripts'));await mkdir(join(root,'bin'));
 await copyFile(new URL('../scripts/install-smoke.sh',import.meta.url),join(root,'scripts/install-smoke.sh'));
 await writeFile(join(root,'first.tap'),first);await writeFile(join(root,'second.tap'),second);
 const programs={node:'exit 0',npm:'echo invoked > "$SMOKE_TEST_ROOT/npm-called"',python3:`
if [ "$1" = -c ]; then
 case "$2" in *tempfile*) echo "$SMOKE_TEST_ROOT";; *) echo 18317;; esac
elif [ -f "$SMOKE_TEST_ROOT/launched" ]; then cat "$SMOKE_TEST_ROOT/second.tap"
else touch "$SMOKE_TEST_ROOT/launched"; cat "$SMOKE_TEST_ROOT/first.tap"; fi`};
 for(const [name,body] of Object.entries(programs))await writeFile(join(root,'bin',name),'#!/bin/sh\n'+body+'\n',{mode:0o755});
 return {root,run:()=>spawnSync('/bin/bash',[join(root,'scripts/install-smoke.sh')],{env:{PATH:join(root,'bin')+':/usr/bin:/bin',SMOKE_TEST_ROOT:root,TMPDIR:root},encoding:'utf8',timeout:10000})};
}

test('install smoke refuses live and dangling node_modules symlinks before npm touches shared files',async t=>{
 for(const dangling of [false,true]){
  const f=await fixture(t),shared=join(f.root,'shared');
  if(!dangling){await mkdir(shared);await writeFile(join(shared,'retained'),'original dependency');}
  await symlink(shared,join(f.root,'node_modules'));
  const result=f.run();assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/node_modules is a symlink/);
  await assert.rejects(access(join(f.root,'npm-called')));
  if(!dangling)assert.equal(await readFile(join(shared,'retained'),'utf8'),'original dependency');
 }
});

test('install smoke refuses skipped, absent and filtered-away coverage in either invocation',async t=>{
 const emptyRun=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-name-pattern=missing-smoke-test',new URL('./schema-migrations.test.ts',import.meta.url).pathname],{env:{},encoding:'utf8',timeout:10000});
 assert.equal(emptyRun.status,0,emptyRun.stderr);assert.match(emptyRun.stdout,/1\.\.0/);
 const skipped='TAP version 13\n1..2\n# pass 1\n# fail 0\n# skipped 1\n';
 for(const [first,second] of [[skipped,passed],[passed,skipped],[passed,emptyRun.stdout],['',passed]]){
  const f=await fixture(t,first,second),result=f.run();assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stderr,/Smoke coverage/);
 }
 const f=await fixture(t),result=f.run();assert.equal(result.status,0,result.stderr);await access(join(f.root,'npm-called'));
});
