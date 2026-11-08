import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
const root=new URL('../docs/product/screens/',import.meta.url);
test('all 75 v2 contracts map to bounded exact PNGs in both themes',async()=>{
 const manifest=JSON.parse(await readFile(new URL('artboards.json',root),'utf8'));
 const files=(await readdir(new URL('contracts/',root))).filter(f=>f.endsWith('.json')).sort();
 assert.deepEqual(Object.keys(manifest).sort(),files.map(f=>f.slice(0,-5)).sort());
 assert.equal(files.length,75);
 for(const theme of ['dark','light'])for(const file of files){
  const screen=file.slice(0,-5),contract=JSON.parse(await readFile(new URL('contracts/'+file,root),'utf8'));
  assert.equal(contract.artboard,screen);assert.ok(contract.regions.length);assert.ok(contract.viewport.width>0&&contract.viewport.height>0);
  assert.deepEqual(Object.keys(contract.themes).sort(),['dark','light']);
  const reference=manifest[screen][theme];
  assert.equal(reference.file,'artboards/'+theme+'/'+screen+'.png');
  const bytes=await readFile(new URL(reference.file,root));
  assert.ok(bytes.length<=200000,screen+' PNG exceeds 200 KB');
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.ok(bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0);
 }
 assert.deepEqual((await readdir(new URL('artboards/',root))).sort(),['dark','light']);
 for(const theme of ['dark','light'])assert.deepEqual((await readdir(new URL('artboards/'+theme+'/',root))).sort(),files.map(f=>f.replace('.json','.png')));
 const copy=JSON.parse(await readFile(new URL('copy.ko.json',root),'utf8'));
 assert.equal(Object.keys(copy).filter(key=>!key.startsWith('ui.')&&!key.startsWith('legacy.')).length,241);
});
