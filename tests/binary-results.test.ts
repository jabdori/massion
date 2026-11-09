import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import type {Mission,Command} from '../src/domain.ts';
import {hash} from '../src/domain.ts';
import {assistantTurnId,assistantWorkId} from '../src/assistant-conversation.ts';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import {copy} from '../src/ui-copy.ts';
import {createWorkbench} from '../src/server.ts';
import {once} from 'node:events';
import * as records from '../src/record-artifact.ts';

async function binary(){const mod=await import('../src/binary-artifacts.ts');return mod;}
export async function acceptedBinary(t:test.TestContext,kind='image/png',withSource=false){
 const {BinaryArtifactStore,producePng,producePdf}=await binary(),root=await mkdtemp(join(tmpdir(),'massion-binary-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const messageId='m:'+'1'.repeat(32),turnId=assistantTurnId(messageId),workId=withSource?assistantWorkId(turnId):'work',message={id:messageId,ordinal:1,actorId:'owner',role:'owner' as const,turnId:null,text:'Create a static local result'},source={segmentId:'assistant-conversation:2',turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'deterministic'}};
 const artifacts=new BinaryArtifactStore(join(root,'artifacts')),bytes=kind==='image/png'?producePng(2,1,Uint8Array.from([255,0,0,0,128,255])):producePdf('Meeting notes\nBudget approved (local).'),artifact=await artifacts.write(workId,1,kind,bytes),store=new InMemoryStore<Mission>();
 const app=new Application(store,[{id:'owner',roles:['owner']},{id:'executor',roles:['executor']},{id:'verifier',roles:['verifier']},{id:'assistant',roles:['assistant']}]);
 await app.create({id:'mission',purpose:'Binary fixture evidence',scope:'local',constraints:[],criteria:{version:1,description:'Exact static result bytes',oracle:'fixture-binary/v1'}},'owner','create');let revision=1;
 const send=async(command:Command,actorId='owner')=>app.dispatch({missionId:'mission',commandId:'command-'+revision,expectedRevision:revision++,actorId,command});
 await send({type:'admit-work',workId,title:'Binary result',budget:2,...(withSource?{assistantSource:source}:{})},withSource?'assistant':'owner');
 for(const role of ['executor','verifier'] as const)await send({type:'assign',workId,assignment:{id:role,actorId:role,role,taskId:workId+':root',model:{provider:'fixture',model:'deterministic',configVersion:'v1',reason:'Data-only fixture',evidenceClass:'fixture'},extensionVersion:'binary-fixture/v1'}});
 await send({type:'admit-effect',workId,effect:{id:'effect',taskId:workId+':root',status:'pending',target:'local binary',authority:'fixture'},reserve:1},'executor');
 await send({type:'receipt',workId,effectId:'effect',outcome:'succeeded',receipt:'Exact bytes written',usage:1},'executor');
 await send({type:'publish-artifact',workId,artifact},'executor');
 await send({type:'verify',workId,verdict:{id:'verdict',verifierAssignmentId:'verifier',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:1,status:'passed',evidence:[{kind:'fixture',detail:'Independent deterministic fixture evidence',source:'test-verifier'}]}},'verifier');
 await send({type:'settle-task',workId,taskId:workId+':root',result:'Fixture settled'},'executor');
 await send({type:'accept',workId,recordId:'record',artifactSnapshot:await artifacts.snapshot(artifact)});
 const state=await store.readState('mission'),input={recordId:'record',artifactVersion:1,artifactSha256:artifact.sha256,feedId:state.feedId};
 return {root,artifacts,artifact,bytes,store,state,input,workId,source};
}

test('binary producers are available without altering the text reader contract',async()=>{
 assert.equal(typeof (records as any).readBinaryRecordArtifact,'function');
});
test('independent runtime review reads text and RGB evidence from the actual validated bytes',async()=>{
 const mod=await binary();assert.equal(typeof (mod as any).binaryArtifactText,'function');
 assert.equal(mod.binaryArtifactText('application/pdf',mod.producePdf('Notes (local)\nApproved')),'Notes (local)\nApproved');
 assert.equal(mod.binaryArtifactText('image/png',mod.producePng(2,1,Uint8Array.from([255,0,0,0,128,255]))),'RGB 2x1\n#ff0000 #0080ff');
 assert.throws(()=>mod.binaryArtifactText('image/png',mod.producePng(128,128,new Uint8Array(128*128*3))));
});
test('the longest supported PDF line fits the page and existing artifacts remain readable',async()=>{
 const {producePdf,binaryArtifactText}=await binary(),line='W'.repeat(96),bytes=producePdf(line),pdf=bytes.toString('ascii');
 const pageWidth=Number(/\/MediaBox \[0 0 (\d+)/.exec(pdf)![1]),fontSize=Number(/\/F1 (\d+) Tf/.exec(pdf)![1]),x=Number(/(\d+) 800 Td/.exec(pdf)![1]);
 assert.ok(x+96*fontSize*0.6<=pageWidth, 'Courier advances 600/1000 em per character');
 assert.equal(binaryArtifactText('application/pdf',bytes),line);
 const old=Buffer.from(producePdf('Legacy PDF').toString('ascii').replace('\n32 800 Td\n','\n40 800 Td\n'),'ascii');
 assert.equal(binaryArtifactText('application/pdf',old),'Legacy PDF');
});

test('PNG producer encodes the supplied pixels and PDF producer retains escaped text with correct xref',async()=>{
 const {producePng,producePdf,validateBinary}=await binary(),png=producePng(2,1,Uint8Array.from([255,0,0,0,128,255]));
 assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(png.readUInt32BE(16),2);assert.equal(png.readUInt32BE(20),1);
 const length=png.readUInt32BE(33);assert.deepEqual([...inflateSync(png.subarray(41,41+length))],[0,255,0,0,0,128,255]);
 const pdf=producePdf('Notes (local) \\ done\nSecond line'),text=pdf.toString('ascii');assert.match(text,/^%PDF-1\.4/);assert.match(text,/Notes \\\(local\\\) \\\\ done/);assert.match(text,/Second line/);
 const xref=Number(/startxref\n(\d+)/.exec(text)![1]);assert.equal(text.slice(xref,xref+4),'xref');
 validateBinary('application/pdf',pdf);validateBinary('image/png',png);
 for(const bad of [()=>producePng(513,1,new Uint8Array(1539)),()=>producePng(2,1,new Uint8Array(3)),()=>producePdf('한글'),()=>producePdf('x'.repeat(97))])assert.throws(bad);
 for(const kind of ['image/svg+xml','text/html','image/jpeg','application/pdf','image/png'])assert.throws(()=>validateBinary(kind,Buffer.from('<svg/>')));
 const corrupted=Buffer.from(png);corrupted[45]=corrupted[45]!^1;assert.throws(()=>validateBinary('image/png',corrupted));
 assert.throws(()=>validateBinary('application/pdf',Buffer.from(text.replace('/Type /Catalog','/Type /Catalog /OpenAction << /S /JavaScript >>'))));
 assert.throws(()=>validateBinary('image/png',Buffer.concat([png,Buffer.from('extra')])));
});
for(const kind of ['image/png','application/pdf'])test(`${kind} exact accepted reader preserves identity, immutable bytes and history`,async t=>{
 const f=await acceptedBinary(t,kind),{readBinaryRecordArtifact}=await import('../src/record-artifact.ts'),before=f.store.inspect();
 const result=await readBinaryRecordArtifact(f.store,f.artifacts,'mission','work',f.input);assert.ok(result);
 assert.equal(result.encoding,'base64');assert.deepEqual(Buffer.from(result.content,'base64'),f.bytes);assert.equal(result.byteLength,f.bytes.length);assert.equal(result.artifact.kind,kind);assert.equal(result.recordChecksum,f.state.snapshot!.value.works[0]!.record!.checksum);assert.equal(result.evidenceClass,'fixture');assert.equal('path' in result.artifact,false);
 await assert.rejects(records.readRecordArtifact(f.store,{read:async()=>''},'mission','work',f.input),/Only exact accepted UTF-8/);
 assert.deepEqual(await f.store.readState('mission'),f.state);assert.deepEqual(f.store.inspect(),before);
 const concurrent=await Promise.all([f.artifacts.write('work',1,kind,f.bytes),f.artifacts.write('work',1,kind,f.bytes)]);assert.deepEqual(concurrent,[f.artifact,f.artifact]);
 const reopened=new (await binary()).BinaryArtifactStore(join(f.root,'artifacts'));assert.deepEqual(await reopened.readBytes(f.artifact),f.bytes);
 await assert.rejects(reopened.readBytes({...f.artifact,path:join(f.root,'other')}));
 await chmod(f.artifact.path,0o600);await writeFile(f.artifact.path,Buffer.from('tampered'));await chmod(f.artifact.path,0o400);await assert.rejects(readBinaryRecordArtifact(f.store,f.artifacts,'mission','work',f.input),/integrity|unavailable/);
});
test('binary reads fail closed for forged acceptance, mismatched bytes, replaced feed and late Record changes',async t=>{
 const f=await acceptedBinary(t),{readBinaryRecordArtifact}=await import('../src/record-artifact.ts');let portCalls=0;
 for(const damage of ['pending','verifier','effect','snapshot','checksum']){
  const state=structuredClone(f.state),w=state.snapshot!.value.works[0]!,r=w.record!;
  if(damage==='pending')w.acceptance='pending';if(damage==='verifier'){r.assignments[1]!.actorId='executor';w.assignments=structuredClone(r.assignments);}if(damage==='effect'){r.receipts[0]!.status='unknown';w.effects=structuredClone(r.receipts);}if(damage==='snapshot')r.artifactSnapshot!.path+='other';
  const {checksum,...bundle}=r;r.checksum=damage==='checksum'?'0'.repeat(64):hash(bundle);
  await assert.rejects(readBinaryRecordArtifact({readState:async()=>state} as Store<Mission>,{readBytes:async()=>{portCalls++;return f.bytes;}},'mission','work',f.input));
 }assert.equal(portCalls,0);
 await assert.rejects(readBinaryRecordArtifact(f.store,undefined,'mission','work',f.input),/not enabled/);
 await assert.rejects(readBinaryRecordArtifact(f.store,{read:async()=>''},'mission','work',f.input),/not enabled/);
 for(const bytes of [Buffer.from('wrong'),Buffer.alloc(1048577)])await assert.rejects(readBinaryRecordArtifact(f.store,{readBytes:async()=>bytes},'mission','work',f.input));
 let release!:()=>void,started!:()=>void;const hold=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);let current=f.state;
 const proxy={readState:async()=>structuredClone(current)} as Store<Mission>,pending=readBinaryRecordArtifact(proxy,{readBytes:async()=>{started();await hold;return f.bytes;}},'mission','work',f.input);await ready;current={...current,feedId:'replacement'};release();await assert.rejects(pending,/cursor|feed/i);
 let count=0;const changed={readState:async()=>{const next=structuredClone(f.state);if(++count>1)next.snapshot!.value.works[0]!.record!.checksum='0'.repeat(64);return next;}} as Store<Mission>;await assert.rejects(readBinaryRecordArtifact(changed,f.artifacts,'mission','work',f.input));
 assert.equal(createHash('sha256').update(f.bytes).digest('hex'),f.artifact.sha256);
});
test('binary stores reject path traversal, symlink roots and false format labels before publication',async t=>{
 const {BinaryArtifactStore,producePng}=await binary(),root=await mkdtemp(join(tmpdir(),'massion-binary-path-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const artifacts=new BinaryArtifactStore(join(root,'owned')),bytes=producePng(1,1,Uint8Array.from([0,0,0]));
 await assert.rejects(artifacts.write('../escape',1,'image/png',bytes));await assert.rejects(artifacts.write('work',1,'application/pdf',bytes));await assert.rejects(artifacts.write('work',1,'image/svg+xml',bytes));
 await artifacts.initialize();await symlink(artifacts.root,join(root,'link'));await assert.rejects(new BinaryArtifactStore(join(root,'link')).write('work',1,'image/png',bytes));
});

async function previewFixture(t:test.TestContext,kind='image/png'){
 const f=await acceptedBinary(t,kind,true),read=()=>((records as any).readBinaryRecordArtifact(f.store,f.artifacts,'mission',f.workId,f.input));
 const row={missionId:'mission',workId:f.workId,recordId:'record',version:1,sha256:f.artifact.sha256,kind,title:kind==='image/png'?'Result.png':'Notes.pdf',memberId:null,segment:2,turnId:f.source.turnId,at:0};
 const state={rows:[row],body:await read(),hold:null as Promise<void>|null,feed:f.state.feedId,artifactStatus:200};
 const app=harness(async(path)=>{
  if(path==='/assistant/results')return reply({feedId:state.feed,results:state.rows});
  if(path.startsWith('/missions/mission/record-binary-artifact')){const body=structuredClone(state.body);if(state.hold)await state.hold;return reply(body,state.artifactStatus);}
  if(path.startsWith('/read-state'))return reply({feedId:state.feed,cursor:0,snapshot:null});
  if(path.startsWith('/events'))return reply({feedId:state.feed,cursor:1,events:[]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:state.feed,cursor:1,head:3,members:[],turns:[],segment:{number:path.includes('segment=2')?2:3,revision:1,closed:false,full:false,previous:null,messages:[]}});
  return reply({error:'Unavailable'},503);
 },{'massion.workbench.feed':state.feed});await settle();await app.node('rail-results').fire('click');await settle();
 return {...f,app,row,previewState:state,open:()=>runInContext('resultOpen(resultRows[0])',app.context) as Promise<void>};
}
for(const kind of ['image/png','application/pdf'])test(`${kind} preview verifies exact accepted bytes and opens the recorded source segment without writes`,async t=>{
 const f=await previewFixture(t,kind);await f.open();await settle();const viewer=f.app.node('result-preview').children[0]!;
 assert.equal(viewer.tagName,kind==='image/png'?'IMG':'PRE');
 if(kind==='image/png')assert.equal(viewer.attributes.get('src'),'data:'+kind+';base64,'+f.bytes.toString('base64'));else assert.match(viewer.textContent,/Meeting notes/);
 const original=f.app.node('result-preview').children.find(n=>n.tagName==='A');assert.ok(original);assert.equal(original.attributes.get('href'),'data:'+kind+';base64,'+f.bytes.toString('base64'));
 assert.equal(f.app.node('result-copy').hidden,true);assert.equal(f.app.node('result-tab-original').disabled,true);
 assert.ok(f.app.calls.some(c=>c.path==='/assistant/conversation?segment=2'));assert.equal(f.app.calls.some(c=>c.options?.method==='POST'),false);
 await f.app.all().find(n=>n.id==='result-filter-'+(kind==='image/png'?'images':'files'))!.fire('click');assert.equal(f.app.node('results-rows').children.length,1);
});
test('binary preview refuses substituted identity, source, kind, byte count, hash, base64 and unsupported formats',async t=>{
 const f=await previewFixture(t),valid=structuredClone(f.previewState.body);
 for(const corrupt of [(b:any)=>b.recordId='other',(b:any)=>b.feedId='other',(b:any)=>b.artifact.kind='image/svg+xml',(b:any)=>b.source.segment=1,(b:any)=>b.source.turnId='other',(b:any)=>b.byteLength++,(b:any)=>b.content=Buffer.from('wrong').toString('base64'),(b:any)=>b.content='!'.repeat(10),(b:any)=>b.content='A'.repeat(1_398_105)]){
  const body=structuredClone(valid);corrupt(body);f.previewState.body=body;await f.open();assert.equal(f.app.node('result-preview').textContent,copy('ui.panel.unavailable'));assert.equal(f.app.node('result-preview').children.length,0);
 }
 f.previewState.body=valid;await f.open();assert.equal(f.app.node('result-preview').children[0]!.tagName,'IMG');
});
test('feed replacement clears displayed bytes and ignores held binary preview responses',async t=>{
 const f=await previewFixture(t);await f.open();assert.equal(f.app.node('result-preview').children[0]!.tagName,'IMG');let release!:()=>void;
 f.previewState.hold=new Promise<void>(r=>release=r);const pending=f.open();await settle();runInContext('resultsReset()',f.app.context);assert.equal(f.app.node('result-preview').children.length,0);release();await pending;assert.equal(f.app.node('result-preview').children.length,0);
});
test('removed or replaced source rows and closed tabs cannot receive a late binary preview',async t=>{
 const f=await previewFixture(t);let release!:()=>void;f.previewState.hold=new Promise<void>(r=>release=r);const pending=f.open();await settle();
 f.previewState.rows=[];await runInContext('resultsLoad()',f.app.context);release();await pending;assert.equal(f.app.node('result-preview').children.length,0);
 f.previewState.rows=[f.row];f.previewState.hold=null;await runInContext('resultsLoad()',f.app.context);await f.open();assert.equal(f.app.node('result-preview').children[0]!.tagName,'IMG');
 f.previewState.hold=new Promise<void>(r=>release=r);const closed=f.open();await settle();runInContext('paneCloseTab(paneActive)',f.app.context);release();await closed;assert.equal(f.app.node('result-preview').children.length,0);
});
test('a results response from a replaced feed clears cached bytes before event recovery',async t=>{
 const f=await previewFixture(t);await f.open();assert.equal(f.app.node('result-preview').children[0]!.tagName,'IMG');
 f.previewState.feed='replaced-feed';await runInContext('resultsLoad()',f.app.context);
 assert.equal(f.app.node('result-preview').children.length,0);assert.equal(f.app.node('results-rows').children.length,0);
});
test('a changed source turn invalidates the displayed preview even when its artifact hash matches',async t=>{
 const f=await previewFixture(t);await f.open();f.previewState.rows=[{...f.row,turnId:'different-turn'}];await runInContext('resultsLoad()',f.app.context);
 assert.equal(f.app.node('result-preview').children.length,0);assert.equal(runInContext('paneTabs.some(t=>t.result)',f.app.context),false);
});
test('the reader rejects changed source pins before accessing accepted binary bytes',async t=>{
 const f=await acceptedBinary(t,'image/png',true),state=structuredClone(f.state);state.snapshot!.value.works[0]!.assistantSource!.segmentId='assistant-conversation:1';let calls=0;
 await assert.rejects(records.readBinaryRecordArtifact({readState:async()=>state} as Store<Mission>,{readBytes:async()=>{calls++;return f.bytes;}},'mission',f.workId,f.input));assert.equal(calls,0);
});
test('normal binary HTTP route serves exact accepted bytes and rejects path, identity and feed substitutions without writes',async t=>{
 const f=await acceptedBinary(t,'application/pdf',true),journal=f.store.inspect();let calls=0;
 const server=createWorkbench(f.store,f.root,{artifacts:{read:async()=>{throw Error('Text port unused');},readBytes:async a=>{calls++;return f.artifacts.readBytes(a);}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port,path='/missions/mission/record-binary-artifact?work='+encodeURIComponent(f.workId)+'&record=record&version=1&sha256='+f.artifact.sha256;
 const response=await fetch(base+path,{headers:{'X-Massion-Feed':f.state.feedId}});assert.equal(response.status,200);const body=await response.json();assert.deepEqual(Buffer.from(body.content,'base64'),f.bytes);assert.equal(body.source.turnId,f.source.turnId);assert.equal(body.evidenceClass,'fixture');assert.equal('path' in body.artifact,false);assert.equal(calls,1);
 for(const [query,status] of [[path+'&path=/private/tmp/other',400],[path+'&version=1',400],[path.replace('record=record','record=other'),409],[path.replace('version=1','version=2'),409]] as const)assert.equal((await fetch(base+query)).status,status);
 assert.equal((await fetch(base+path,{headers:{'X-Massion-Feed':'replaced'}})).status,409);assert.equal(calls,1);
 assert.deepEqual(await f.store.readState('mission'),f.state);assert.deepEqual(f.store.inspect(),journal);
});

test('the legacy portable text inventory rejects binaries instead of silently omitting their files',async t=>{
 const f=await acceptedBinary(t),{collectMissionArtifacts}=await import('../src/backup-lineage.ts');
 assert.throws(()=>collectMissionArtifacts(f.state.snapshot!.value),/only sealed text artifacts/);
});
