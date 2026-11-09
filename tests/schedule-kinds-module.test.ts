import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('a standalone workbench import initializes schedule dependencies without a circular initialization error',()=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e',"await import('./src/workbench.ts')"],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:5000});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
});
