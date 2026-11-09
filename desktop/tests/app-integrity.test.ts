import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {appIntegrity} from './app-integrity.ts';

test('app inventory detects changed bytes, executable mode, symlink targets and added files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-integrity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'Contents'));const binary=join(root,'Contents/app');await writeFile(binary,'original',{mode:0o755});await symlink('Contents/app',join(root,'current'));
 const original=await appIntegrity(root);assert.equal(await appIntegrity(root),original);
 await writeFile(binary,'substituted');assert.notEqual(await appIntegrity(root),original);await writeFile(binary,'original');
 await chmod(binary,0o644);assert.notEqual(await appIntegrity(root),original);await chmod(binary,0o755);
 await rm(join(root,'current'));await symlink('Contents/other',join(root,'current'));assert.notEqual(await appIntegrity(root),original);
 await rm(join(root,'current'));await symlink('Contents/app',join(root,'current'));
 await writeFile(join(root,'extra'),'added');assert.notEqual(await appIntegrity(root),original);await rm(join(root,'extra'));
 assert.equal(await appIntegrity(root),original);
});
