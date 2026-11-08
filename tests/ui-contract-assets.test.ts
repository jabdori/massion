import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
const root=new URL('../docs/product/screens/',import.meta.url);
test('each contract maps to a bounded PNG or an explicit missing-evidence reason',async()=>{
 const manifest=JSON.parse(await readFile(new URL('artboards.json',root),'utf8'));
 const files=(await readdir(new URL('contracts/',root))).filter(f=>f.endsWith('.json')).sort();
 assert.deepEqual(Object.keys(manifest).sort(),files.map(f=>f.slice(0,-5)).sort());
 for(const file of files){
  const screen=file.slice(0,-5),contract=JSON.parse(await readFile(new URL('contracts/'+file,root),'utf8'));
  assert.equal(contract.artboard,screen);assert.ok(contract.regions.length);assert.ok(contract.viewport.width>0&&contract.viewport.height>0);
  const reference=manifest[screen];
  if(reference.file===null){assert.ok(reference.reason.length>0);continue;}
  assert.equal(reference.file,'artboards/'+screen+'.png');
  const bytes=await readFile(new URL(reference.file,root));
  assert.ok(bytes.length<=200*1024,screen+' PNG exceeds 200 KiB');
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.ok(bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0);
 }
 assert.deepEqual((await readdir(new URL('artboards/',root))).sort(),Object.values(manifest).filter((x:any)=>x.file).map((x:any)=>x.file.split('/')[1]).sort());
});
