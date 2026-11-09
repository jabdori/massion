import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {hash} from '../src/domain.ts';
import {spawnSync} from 'node:child_process';
import {validateBinary,binaryArtifactText} from '../src/binary-artifacts.ts';
import type {ScreenFixture} from '../scripts/ui-contracts/fixture-host.ts';

async function template(screen:string):Promise<ScreenFixture>{
 const raw=JSON.parse(await readFile(new URL('../scripts/ui-contracts/fixtures/'+screen+'.json',import.meta.url),'utf8'));
 if(!raw.extends)return raw;const base=await template(raw.extends);return {...base,...raw,routes:{...base.routes,...raw.routes}};
}
test('a fresh process imports each binary entry without a cyclic initialization failure',()=>{
 for(const file of ['../src/record-artifact.ts','../scripts/ui-contracts/binary-fixture.ts']){const entry=new URL(file,import.meta.url).href,result=spawnSync(process.execPath,['--input-type=module','-e','await import('+JSON.stringify(entry)+')'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
});
for(const screen of ['B10','B10-preview'])test(`${screen} fixture retains text rows and adds genuine accepted static binaries with exact source routes`,async()=>{
 const {binaryScreenFixture}=await import('../scripts/ui-contracts/binary-fixture.ts'),original=await template(screen),before=structuredClone(original),fixture=await binaryScreenFixture(original);
 assert.deepEqual(original,before);const initial=(original.routes['/assistant/results']!.body as any).results,body=fixture.routes['/assistant/results']!.body as any;
 assert.deepEqual(body.results.slice(0,initial.length),initial);const rows=body.results.slice(initial.length);assert.equal(rows.length,2);
 assert.deepEqual(rows.map((r:any)=>[r.title,r.kind,r.memberId]),[['회의 메모 정리.pdf','application/pdf',null],['로고 시안 3종.png','image/png',null]]);
 const mission=(fixture.routes['/read-state?mission=intake']!.body as any).snapshot.value,conversation=fixture.routes['/assistant/conversation?segment=1']!.body as any;
 for(const row of rows){
  const path='/missions/intake/record-binary-artifact?work='+encodeURIComponent(row.workId)+'&record='+encodeURIComponent(row.recordId)+'&version='+row.version+'&sha256='+row.sha256,reply=fixture.routes[path]!;assert.equal(reply.status,200);const read=reply.body as any,bytes=Buffer.from(read.content,'base64');
  validateBinary(row.kind,bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);assert.equal(read.byteLength,bytes.length);assert.equal(read.feedId,body.feedId);assert.equal(read.source.segment,1);assert.equal(read.source.turnId,row.turnId);assert.equal(read.source.memberId,row.memberId);
  const w=mission.works.find((w:any)=>w.id===row.workId),{checksum,...bundle}=w.record;assert.equal(w.acceptance,'accepted');assert.equal(hash(bundle),checksum);assert.equal(read.recordChecksum,checksum);assert.deepEqual(w.assistantSource,w.record.assistantSource);
  const turn=conversation.turns.find((t:any)=>t.id===row.turnId);assert.equal(turn.work.workId,w.id);assert.equal(turn.work.acceptance,'accepted');assert.ok(conversation.segment.messages.some((m:any)=>m.id===w.assistantSource.messageId));
  await assert.rejects(readFile(w.artifact.path),{code:'ENOENT'});
  if(row.kind==='image/png'){assert.equal(bytes.readUInt32BE(16),96);assert.equal(bytes.readUInt32BE(20),32);assert.match(binaryArtifactText(row.kind,bytes),/^RGB 96x32\n/);}else assert.match(binaryArtifactText(row.kind,bytes),/Meeting notes/);
 }
 assert.deepEqual(fixture.steps,original.steps);
});
