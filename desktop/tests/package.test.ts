import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,cp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

test('packaged daemon resources import without access to the source checkout',async t=>{
 const root=await mkdtemp(join(tmpdir(),'e4-package-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=resolve(import.meta.dirname,'..'),manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
 for(const resource of manifest.build.extraResources){const destination=join(root,resource.to);await mkdir(dirname(destination),{recursive:true});await cp(resolve(directory,resource.from),destination,{recursive:true});}
 const core=await import(pathToFileURL(join(root,'core/src/server.ts')).href);
 assert.equal(typeof core.createWorkbench,'function');
});
