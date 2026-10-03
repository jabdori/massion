import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
test('headless clients share authoritative fixture results; web commands cannot forge pass',async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-http-'));const server=createWorkbench(new InMemoryStore<Mission>(),root);server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
 try{
  const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/controlled local fixture/);
  const blocked=await fetch(base+'/fixture-run',{method:'POST',headers:{Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);
  const forged=await fetch(base+'/fixture-run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"passed":true}'});assert.equal(forged.status,400);
  const result=await fetch(base+'/fixture-run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(result.status,201);const {missionId}=await result.json() as {missionId:string};
  const first=await (await fetch(base+'/missions/'+missionId)).json();const second=await (await fetch(base+'/missions/'+missionId)).json();assert.deepEqual(first,second);
 }finally{server.close();await once(server,'close');await rm(root,{recursive:true,force:true});}
});
