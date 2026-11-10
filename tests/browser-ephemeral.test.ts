import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Application} from '../src/application.ts';
import {canonical,hash,workInputHash} from '../src/domain.ts';
import type {Command,Mission} from '../src/domain.ts';
import {BrowserSessions} from '../src/browser-runtime.ts';
import type {RawBrowserPage} from '../src/browser-runtime.ts';
import {InMemoryStore,journalChecksum,validateJournal} from '../src/storage.ts';
import type {PortableJournal} from '../src/storage.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {exportPortableBackup,parsePortableBackup} from '../src/portable-backup.ts';

const now=Date.UTC(2026,10,10),deadline=now+60000,address='https://shop.example.com/checkout';
const sentinel='ephemeral-private-sentinel-7e32';
// PNG의 tEXt 청크에도 표식을 넣어 이미지 자체의 영속화를 검출합니다.
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAJ3RFWHRDb21tZW50AGVwaGVtZXJhbC1wcml2YXRlLXNlbnRpbmVsLTdlMzL0V3VCAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const screenshot={mimeType:'image/png' as const,data:png,width:1,height:1};
const imageBytes=Buffer.from(png,'base64'),unkeyedImageHash=createHash('sha256').update(imageBytes).digest('hex');
const raw:RawBrowserPage={address,title:'Checkout '+sentinel,blocks:['Private value: '+sentinel,'Quantity: 2'],fields:[{label:'Password',type:'password',value:sentinel,autocomplete:'current-password'},{label:'Quantity',type:'number',value:'2',autocomplete:''}],screenshot};
const request={missionId:'mission',workId:'work',readId:'page:1',address};
const model={provider:'fixture',model:'deterministic',configVersion:'v1',reason:'In-memory browser fixture',evidenceClass:'fixture' as const};

async function fixture(t:TestContext,initial=now){
 const root=await mkdtemp(join(tmpdir(),'massion-browser-ephemeral-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let clock=initial,calls=0,sequence=0;
 const store=new InMemoryStore<Mission>(()=>new Date(clock)),artifacts=new TextArtifactStore(join(root,'artifacts'));
 const app=new Application(store,[{id:'owner',roles:['owner']},{id:'executor',roles:['executor']},{id:'verifier',roles:['verifier']}],()=>clock);
 await app.create({id:'mission',purpose:'Ephemeral browser evidence',scope:'local',constraints:[],criteria:{version:1,description:'Retain structure without private pixels',oracle:'fixture-browser/v1'}},'owner','create');
 const send=async(command:Command,actorId='owner')=>{
  const revision=(await store.load('mission'))!.revision;
  const result=await app.dispatch({missionId:'mission',commandId:'command-'+(++sequence),expectedRevision:revision,actorId,command});
  assert.equal(result.status,'committed');return result;
 };
 await send({type:'admit-work',workId:'work',title:'Read checkout',budget:8});
 const work=(await store.load('mission'))!.value.works[0]!;
 await send({type:'activate-runtime',workId:'work',run:{id:'run',authorizationId:'fixture',criteriaHash:hash(work.criteria),inputHash:workInputHash(work),mode:'mock-http',outputTokenCap:1,ownership:{hostSessionId:'host',dispatchId:'dispatch',startedAt:initial,deadlineAt:initial+60000}}});
 for(const role of ['executor','verifier'] as const)await send({type:'assign',workId:'work',assignment:{id:role,actorId:role,role,taskId:'work:root',model,extensionVersion:'v1'}});
 await send({type:'admit-effect',workId:'work',effect:{id:'effect',taskId:'work:root',status:'pending',target:'fixture observation',authority:'local fixture'},reserve:1},'executor');
 assert.equal((await store.load('mission'))!.value.works[0]!.execution,'active');
 const service=new BrowserSessions(store,store,{adapter:{async read(){calls++;return structuredClone(raw);}},clock:()=>clock});t.after(()=>service.drain());
 const journal=():PortableJournal<Mission>=>{const operations=[...store.inspect()];return {schemaVersion:2,head:operations.length,operations};};
 return {store,artifacts,service,send,journal,clock:()=>clock,setClock:(value:number)=>{clock=value;},calls:()=>calls};
}
function noPrivateBytes(value:string|Buffer,label:string){
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);
 assert.equal(bytes.includes(imageBytes),false,label+' contains raw PNG');
 assert.equal(bytes.includes(png),false,label+' contains base64 PNG');
 assert.equal(bytes.includes('iVBORw0KGgo'),false,label+' contains PNG signature');
 assert.equal(bytes.includes(sentinel),false,label+' contains private sentinel');
 assert.equal(bytes.includes('"screenshot"'),false,label+' contains screenshot payload');
}
async function imageVisible(service:BrowserSessions,expected:boolean){
 const session=(await service.read('mission','work')).session;
 assert.ok(session);assert.ok(session.page.tainted);assert.equal('imageHash' in session.page,false);
 assert.equal(session.page.screenshot?.data===png,expected,'Latest page live image visibility');
 assert.equal(session.pages.some(page=>Object.hasOwn(page,'screenshot')),expected,'Page history live image visibility');
 if(!expected)assert.equal(Object.hasOwn(session.page,'screenshot'),false);
}

test('active images stay out of settled artifacts, accepted Records, journals and portable backups',async t=>{
 const s=await fixture(t);assert.equal(imageBytes.includes(sentinel),true);
 assert.equal((await s.service.capture(request)).status,'committed');await imageVisible(s.service,true);
 assert.equal((await s.service.capture({...request,readId:'page:2'})).status,'committed');
 const live=(await s.service.read('mission','work')).session!;assert.equal(live.pagesRead,2);
 assert.equal(live.pages.every(page=>page.screenshot?.data===png),true,'Every active page exposes its transient image');
 const page=(await s.store.load('mission'))!.value.works[0]!.browserSession!.pages[0]!;
 assert.ok(page.tainted);assert.equal(page.summary.privateFields,1);assert.deepEqual(page.summary.fields.map(f=>f.kind),['password','number']);assert.equal('title' in page,false);noPrivateBytes(JSON.stringify(page),'Durable page');
 await s.send({type:'receipt',workId:'work',effectId:'effect',outcome:'succeeded',receipt:'Fixture observation completed',usage:1},'executor');
 await imageVisible(s.service,true);
 await s.send({type:'settle-task',workId:'work',taskId:'work:root',result:'Observed checkout structure'},'executor');
 await imageVisible(s.service,false);
 const artifact=await s.artifacts.write('work',1,canonical((await s.store.load('mission'))!.value.works[0]!.browserSession));
 await s.send({type:'publish-artifact',workId:'work',artifact},'executor');
 await s.send({type:'verify',workId:'work',verdict:{id:'verdict',verifierAssignmentId:'verifier',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:1,status:'passed',evidence:[{kind:'fixture',detail:'Sanitized structural observation',source:'test'}]}},'verifier');
 await s.send({type:'accept',workId:'work',recordId:'record',artifactSnapshot:await s.artifacts.snapshot(artifact)});
 const accepted=(await s.store.load('mission'))!.value.works[0]!;assert.equal(accepted.acceptance,'accepted');assert.ok(accepted.record);
 const {checksum,...record}=accepted.record;assert.equal(hash(record),checksum);
 validateMissionJournalLineage(s.journal().operations);
 const serialized=await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts),backup=parsePortableBackup(serialized);
 const artifactBytes=await readFile(artifact.path),snapshotBytes=await readFile(accepted.record.artifactSnapshot!.path);
 for(const [label,value] of [['Artifact',artifactBytes],['Accepted snapshot',snapshotBytes],['Record',JSON.stringify(accepted.record)],['Journal',JSON.stringify(s.journal())],['Backup',serialized]] as const)noPrivateBytes(value,label);
 for(const blob of backup.blobs)noPrivateBytes(Buffer.from(blob.base64,'base64'),'Backup blob');
 assert.equal(artifactBytes.includes(unkeyedImageHash),false);assert.equal(snapshotBytes.includes(unkeyedImageHash),false);
 assert.equal(backup.journal.operations.at(-1)!.value.works[0]!.browserSession!.pages[0]!.tainted,true);
 await imageVisible(s.service,false);
});

test('a restarted service and command replay cannot recover images still visible in the original active service',async t=>{
 const s=await fixture(t);await s.service.capture(request);const head=s.journal().head;
 const restarted=new BrowserSessions(s.store,s.store,{adapter:{async read(){throw Error('Replay must not invoke the browser adapter');}},clock:s.clock});t.after(()=>restarted.drain());
 await imageVisible(restarted,false);await imageVisible(s.service,true);
 await assert.rejects(restarted.capture(request),/identity.*unavailable/i);await imageVisible(restarted,false);await imageVisible(s.service,true);
 assert.equal((await s.service.capture(request)).status,'replayed');assert.equal(s.calls(),1);assert.equal(s.journal().head,head);
 noPrivateBytes(JSON.stringify(s.journal()),'Replayed journal');
});

test('writes invalidate images before leaving active and input changes cannot revive old pixels',async t=>{
 const s=await fixture(t);await s.service.capture(request);await imageVisible(s.service,true);
 const activeRevision=(await s.store.load('mission'))!.revision;
 let duringWrite:ReturnType<BrowserSessions['read']>|undefined;
 const unsubscribe=s.store.onWrite((id,value)=>{if(id==='mission'&&value?.works[0]?.execution==='blocked')duringWrite=s.service.read('mission','work');});t.after(unsubscribe);
 await s.send({type:'receipt',workId:'work',effectId:'effect',outcome:'unknown',receipt:'Outcome requires reconciliation',usage:null},'executor');
 assert.ok(duringWrite);const beforeCommit=await duringWrite;
 assert.equal(beforeCommit.revision,activeRevision,'Write notification runs before the new state is stored');
 assert.equal(beforeCommit.session?.page.screenshot===undefined,true,'Image invalidated before the blocked write becomes visible');
 // 중간 브라우저 조회 없이 재활성화해 저장소 알림만으로 폐기되는지 확인합니다.
 await s.send({type:'reconcile-effect',workId:'work',effectId:'effect',outcome:'succeeded',receipt:'Fixture confirms completion'});
 assert.equal((await s.store.load('mission'))!.value.works[0]!.execution,'active');await imageVisible(s.service,false);
 assert.equal((await s.service.capture(request)).status,'replayed');await imageVisible(s.service,false);assert.equal(s.calls(),1);
 validateMissionJournalLineage(s.journal().operations);
 const changed=await fixture(t);await changed.service.capture(request);await imageVisible(changed.service,true);
 const original=(await changed.store.load('mission'))!.value;
 // 외부 저장소 교체를 재현하며 원래 입력 복원 사이에 브라우저 조회를 하지 않습니다.
 for(const [index,title] of ['Changed input',original.works[0]!.title].entries()){
  const value=structuredClone(original);value.works[0]!.title=title;
  assert.equal((await changed.store.commit({id:'mission',expectedRevision:(await changed.store.load('mission'))!.revision,commandId:'replace-input-'+index,fingerprint:'fixture-input-'+index,value,events:[],outbox:[]})).status,'committed');
 }
 await imageVisible(changed.service,false);assert.equal(changed.calls(),1);
});

test('drain, deadline expiry without an event and feed replacement discard live images permanently',async t=>{
 for(const reason of ['drain','deadline','feed'] as const){
  const s=await fixture(t);await s.service.capture(request);await imageVisible(s.service,true);const head=s.journal().head;
  if(reason==='drain')await s.service.drain();
  if(reason==='deadline')s.setClock(deadline);
  const readState=s.store.readState.bind(s.store);
  if(reason==='feed')s.store.readState=async(...args)=>({...await readState(...args),feedId:'replacement-feed'});
  await imageVisible(s.service,false);
  s.setClock(now);s.store.readState=readState;await imageVisible(s.service,false);
  assert.equal(s.journal().head,head);assert.equal(s.calls(),1);noPrivateBytes(JSON.stringify(s.journal()),reason+' journal');
 }
});

test('lineage and portable parsing reject image-bearing durable pages even with recomputed checksums',async t=>{
 const s=await fixture(t);await s.service.capture(request);
 const serialized=await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts),backup=parsePortableBackup(serialized);
 validateMissionJournalLineage(backup.journal.operations);
 const operation=backup.journal.operations.at(-1)!;
 Object.assign(operation.value.works[0]!.browserSession!.pages[0]!,{screenshot:structuredClone(screenshot)});
 const event=operation.events[0] as {actor:string;command:Extract<Command,{type:'record-browser-page'}>};
 Object.assign(event.command.page,{screenshot:structuredClone(screenshot)});
 operation.fingerprint=hash({actorId:event.actor,command:event.command,expectedRevision:operation.expectedRevision});
 operation.contentDigest=hash({id:operation.aggregateId,commandId:operation.commandId,fingerprint:operation.fingerprint,expectedRevision:operation.expectedRevision,value:operation.value,events:operation.events,outbox:operation.outbox});
 validateJournal(backup.journal);
 assert.throws(()=>validateMissionJournalLineage(backup.journal.operations),/browser/i);
 backup.journalChecksum=journalChecksum(backup.journal);const {checksum,...body}=backup;
 assert.throws(()=>parsePortableBackup(canonical({...body,checksum:hash(body)})),/browser/i);
});

test('HTTP live queries are no-store and closing or replacing the daemon drops images',async t=>{
 const {createWorkbench}=await import('../src/server.ts'),s=await fixture(t,Date.now()),server=createWorkbench(s.store,'.',{scheduleIntervalMs:0,browserAdapter:{async read(){return raw;}}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());await server.browserSessions.capture(request);
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,response=await fetch(origin+'/missions/mission/works/work/browser'),body=await response.json();assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(body.session.page.screenshot.data===png,true);
 noPrivateBytes(await (await fetch(origin+'/missions/mission')).text(),'HTTP Mission');
 await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await imageVisible(server.browserSessions,false);
 const restarted=createWorkbench(s.store,'.',{scheduleIntervalMs:0});await imageVisible(restarted.browserSessions,false);await restarted.browserSessions.drain();
});

test('a held observation commit cannot resurrect pixels after Work stops and reactivates',async t=>{
 const s=await fixture(t),commit=s.store.commit.bind(s.store);let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);t.after(release);
 s.store.commit=async input=>{const result=await commit(input);if(input.commandId.startsWith('assistant-browser:')){entered();await held;}return result;};
 const capturing=s.service.capture(request);await reached;
 await s.send({type:'receipt',workId:'work',effectId:'effect',outcome:'unknown',receipt:'Held observation crossed a stop',usage:null},'executor');
 await s.send({type:'reconcile-effect',workId:'work',effectId:'effect',outcome:'succeeded',receipt:'Work reactivated'});
 release();assert.equal((await capturing).status,'committed');await imageVisible(s.service,false);assert.equal(s.calls(),1);
});

test('restart refuses legacy image-bearing state rather than reviving durable pixels',async t=>{const s=await fixture(t);await s.service.capture(request);const snapshot=(await s.store.load('mission'))!;Object.assign(snapshot.value.works[0]!.browserSession!.pages[0]!,{screenshot});await s.store.commit({id:'mission',expectedRevision:snapshot.revision,commandId:'legacy-fixture',fingerprint:'legacy-fixture',value:snapshot.value,events:[],outbox:[]});const restarted=new BrowserSessions(s.store,s.store);t.after(()=>restarted.drain());await assert.rejects(restarted.read('mission','work'),/browser/i);});


test('private-tainted sessions persist no page-controlled payload across history, Records and backup',async t=>{
 const s=await fixture(t),payloads:string[]=[],make=(seed:number)=>Array.from({length:24},(_,i)=>String.fromCharCode(0x5000+seed*32+i)).join('');let index=0;
 const page=(seed:number):RawBrowserPage=>{const values=Array.from({length:10},(_,i)=>make(seed*10+i));payloads.push(...values);return {address,title:values[0]!,blocks:values.slice(1,5),fields:[{label:values[5]!,name:values[6]!,autocomplete:values[7]!,type:'password',value:values[8]!},{label:values[9]!,type:'text',autocomplete:'',value:values[4]!}]};};
 const service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return page(index++);}},clock:s.clock});t.after(()=>service.drain());
 for(let i=0;i<8;i++)await service.capture({...request,readId:'private:'+i});
 const following=make(90);payloads.push(following);const resumed=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {address,title:following,blocks:[following],fields:[]};}},clock:s.clock});t.after(()=>resumed.drain());await resumed.capture({...request,readId:'same-origin'});
 const stored=(await s.store.load('mission'))!.value.works[0]!.browserSession!;assert.equal(stored.pages.length,9);assert.ok(stored.pages.every(p=>'tainted' in p&&p.tainted===true));
 const publicAddress='https://public.example/view',publicService=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {address:publicAddress,title:'Public guide',blocks:['Public hours'],fields:[]};}},clock:s.clock});t.after(()=>publicService.drain());await publicService.capture({...request,readId:'other-origin',address:publicAddress});const publicPage=(await publicService.read('mission','work')).session!.page;assert.ok(!publicPage.tainted);assert.equal(publicPage.title,'Public guide');
 await s.send({type:'receipt',workId:'work',effectId:'effect',outcome:'succeeded',receipt:'Read complete',usage:1},'executor');await s.send({type:'settle-task',workId:'work',taskId:'work:root',result:'Private page metadata only'},'executor');
 const artifact=await s.artifacts.write('work',1,canonical(stored));await s.send({type:'publish-artifact',workId:'work',artifact},'executor');await s.send({type:'verify',workId:'work',verdict:{id:'verdict',verifierAssignmentId:'verifier',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:1,status:'passed',evidence:[{kind:'fixture',detail:'Host metadata only',source:'test'}]}},'verifier');await s.send({type:'accept',workId:'work',recordId:'record',artifactSnapshot:await s.artifacts.snapshot(artifact)});
 const backup=await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts),serialized=[JSON.stringify(await resumed.read('mission','work')),JSON.stringify(s.journal()),backup,(await readFile(artifact.path)).toString()].join('\n');
 for(const value of payloads)for(let i=0;i<=value.length-4;i++)assert.ok(!serialized.includes(value.slice(i,i+4)),'Page-controlled text must not reach a persisted surface');validateMissionJournalLineage(s.journal().operations);parsePortableBackup(backup);
});
