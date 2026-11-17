import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertHandWrittenBundleShape} from './tauri-package-check.mjs';

// The counter-example the review asked for (note 4): a tree with a MISSING
// required entry must FAIL the hand-written shape check, so the assertion can
// fail on a normal bundle and removing it cannot pass silently.
async function tree(extra?: (root: string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'bundle-shape-'));
 const app=join(root,'Massion.app','Contents');
 await mkdir(join(app,'MacOS'),{recursive:true});
 await mkdir(join(app,'Resources','desktop'),{recursive:true});
 await mkdir(join(app,'Resources','src'),{recursive:true});
 await mkdir(join(app,'Resources','docs'),{recursive:true});
 await writeFile(join(app,'Info.plist'),'x');
 for(const name of ['Massion','manifest.json','node','surreal'])await writeFile(join(app,'MacOS',name),'x');
 await writeFile(join(app,'Resources','package.json'),'x');
 if(extra)await extra(root);
 return join(root,'Massion.app');
}

test('the hand-written bundle shape passes a complete bundle',async t=>{
 const app=await tree();
 t.after(()=>rm(app,{recursive:true,force:true}));
 assert.doesNotThrow(()=>assertHandWrittenBundleShape(app));
});

test('the hand-written bundle shape fails a bundle missing a required entry',async t=>{
 const app=await tree(async root=>{
 const {unlink}=await import('node:fs/promises');
 await unlink(join(root,'Massion.app','Contents','MacOS','node'));
 });
 t.after(()=>rm(app,{recursive:true,force:true}));
 assert.throws(()=>assertHandWrittenBundleShape(app),/MacOS holds exactly|MacOS must contain node/);
});

test('the hand-written bundle shape fails a bundle with a forbidden root',async t=>{
 const app=await tree(async root=>{
 await mkdir(join(root,'Massion.app','Contents','Resources','tests'),{recursive:true});
 });
 t.after(()=>rm(app,{recursive:true,force:true}));
 assert.throws(()=>assertHandWrittenBundleShape(app),/Unexpected resources root entry: tests/);
});
