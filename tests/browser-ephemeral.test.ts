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
import {BrowserSessions,browserPrivateRanges} from '../src/browser-runtime.ts';
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
 assert.ok(session);assert.match(session.page.imageHash!,/^hmac-sha256:[a-f0-9]{64}$/);assert.ok(!session.page.imageHash!.includes(unkeyedImageHash));
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
 const imageHash=page.imageHash!;assert.match(imageHash,/^hmac-sha256:[a-f0-9]{64}$/);assert.equal(live.pages.every(p=>p.imageHash===imageHash),true);assert.equal(page.fields[0]!.masked,true);assert.equal(page.fields[0]!.value==='••••',true);
 assert.equal(page.fields[1]!.value==='2',true);noPrivateBytes(JSON.stringify(page),'Durable page');
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
 assert.equal(artifactBytes.includes(imageHash),true);assert.equal(snapshotBytes.includes(imageHash),true);
 assert.equal(backup.journal.operations.at(-1)!.value.works[0]!.browserSession!.pages[0]!.imageHash,imageHash);
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

test('capability paths never enter observations, commands or portable backups',async t=>{
 const s=await fixture(t),token='042731',address='https://shop.example.com/verify/'+token;
 const service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,address,title:'Reset '+token,blocks:['Capability '+token],fields:[]};}},clock:s.clock});t.after(()=>service.drain());
 const input={...request,readId:'capability',address};await service.capture(input);const read=await service.read('mission','work');assert.equal(read.session!.page.address,'https://shop.example.com');assert.ok(!JSON.stringify(read).includes(token));
 assert.equal((await service.capture(input)).status,'replayed');await assert.rejects(service.capture({...input,address:'https://shop.example.com/verify/042732'}),/identity/i);const restarted=new BrowserSessions(s.store,s.store,{clock:s.clock});t.after(()=>restarted.drain());await assert.rejects(restarted.capture(input),/identity.*unavailable/i);assert.equal((await restarted.read('mission','work')).session!.page.address,'https://shop.example.com');await assert.rejects(restarted.capture({...input,address:'https://shop.example.com/reset/another-token'}),/identity|conflict/i);
 await s.send({type:'receipt',workId:'work',effectId:'effect',outcome:'succeeded',receipt:'Read complete',usage:1},'executor');await s.send({type:'settle-task',workId:'work',taskId:'work:root',result:'Origin only'},'executor');
 const backup=await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts);for(const serialized of [JSON.stringify(s.journal()),backup]){assert.ok(!serialized.includes(token));assert.ok(!serialized.includes('/verify/'));assert.ok(!serialized.includes(hash(address)),'No offline URL verifier');assert.ok(!serialized.includes(unkeyedImageHash),'No offline image verifier');}validateMissionJournalLineage(s.journal().operations);
});

for(const part of ['?M4G1CL1NK7e32Bearer','?%4D4G1CL1NK7e32Bearer=value','#route?key=M4G1CL1NK7e32Bearer'])test('URL names and fragment parts never persist '+part[0],async t=>{
 const s=await fixture(t),token='M4G1CL1NK7e32Bearer',service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,address:address+part,title:token,blocks:[token,'%4D4G1CL1NK7e32Bearer'],fields:[]};}},clock:s.clock});t.after(()=>service.drain());if(part.includes('%4D'))await service.capture(request);else await assert.rejects(service.capture(request),/encoded browser text/i);
 const snapshot=await service.read('mission','work'),backup=await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts);for(const value of [JSON.stringify(snapshot),JSON.stringify(s.journal()),backup]){assert.ok(!value.includes(token),'URL token must not be retained');assert.ok(!value.includes('%4D4G1CL1NK7e32Bearer'));}validateMissionJournalLineage(s.journal().operations);
});

for(const depth of [2,4,8])test('nested encoded paths cannot reflect private components into durable observations: '+depth,async t=>{
 const s=await fixture(t),token='M4GABearer7e32';let path='reset/'+token;for(let i=0;i<depth;i++)path=path.replaceAll('%','%25').replaceAll('/','%2F').replaceAll('A','%41');
 const address='https://shop.example.com/'+path,service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,address,title:token,blocks:['Reset '+token],fields:[]};}},clock:s.clock});t.after(()=>service.drain());await service.capture({...request,address});
 for(const value of [JSON.stringify(await service.read('mission','work')),JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(token),'Decoded URL secret must not persist');validateMissionJournalLineage(s.journal().operations);
});

for(const [name,secret,encode] of [['base64','ABCD1234',(s:string)=>Buffer.from(s).toString('base64')],['unpadded','456',(s:string)=>Buffer.from(s).toString('base64url')],['url-safe','a?>b??c',(s:string)=>Buffer.from(s).toString('base64url')],['nested','ABCD1234',(s:string)=>Buffer.from(Buffer.from(s).toString('base64')).toString('base64')]] as const)test('encoded private values are masked in reads, journal and backup: '+name,async t=>{
 const s=await fixture(t),encoded=encode(secret),service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:'Code '+encoded,blocks:['Prefix'+encoded+'Suffix'],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:secret}]};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);
 for(const value of [JSON.stringify(await service.read('mission','work')),JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)]){assert.ok(!value.includes(encoded),'Encoded private value must not persist');assert.ok(!value.includes(JSON.stringify(secret)),'Private field value must not persist');}validateMissionJournalLineage(s.journal().operations);
});

for(const [name,secret,plain] of [['fullwidth','１２３４５６','123456'],['digits','١٢٣٤٥٦','123456'],['grouped','abcd-1234','ABCD1234'],['case','straße9','STRASSE9'],['composed','e\u0301xample9','éxample9'],['decomposed','éxample9','e\u0301xample9']])test('normalization before Base64 cannot retain a private value: '+name,async t=>{
 const s=await fixture(t),encoded=Buffer.from(plain!).toString('base64'),service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:'Code '+encoded,blocks:[encoded],fields:[{label:'Verification code',type:'text',autocomplete:'one-time-code',value:secret!}]};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);
 for(const value of [JSON.stringify(await service.read('mission','work')),JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(encoded),'Normalized private encoding must not persist');validateMissionJournalLineage(s.journal().operations);
});

for(const [secret,display] of [['ABCD1234','ABCD-1234'],['123456','１２３４５６'],['123456','١٢٣٤٥٦'],['ABCD1234','AB CD 1234']])test('decoded display equivalence masks normalized preimages: '+display,async t=>{
 const s=await fixture(t),encoded=Buffer.from(display!).toString('base64url'),service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:'앞😀'+encoded+'뒤',blocks:[encoded],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:secret!}]};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);const observed=await service.read('mission','work');assert.equal(observed.session!.page.title,'앞😀••••뒤');
 for(const value of [JSON.stringify(observed),JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(encoded),'Encoded display preimage must not persist');validateMissionJournalLineage(s.journal().operations);
});

test('known nested values are masked while unrecognized decoding stays bounded',async t=>{
 const s=await fixture(t);let encoded='ABCD1234';for(let i=0;i<10;i++)encoded=Buffer.from(encoded).toString('base64');const before=s.journal().head,service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:encoded,blocks:[],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:'ABCD1234'}]};}},clock:s.clock});t.after(()=>service.drain());assert.throws(()=>browserPrivateRanges(encoded),/encoding bound/i);await service.capture(request);assert.equal((await service.read('mission','work')).session!.page.title,'••••');assert.equal(s.journal().head,before+1);assert.ok(!JSON.stringify(s.journal()).includes(encoded));
});

for(const variant of ['spaces','wrapped','invisible','compatibility'])test('formatted encoded display candidates remain private: '+variant,async t=>{
 const s=await fixture(t),encoded=Buffer.from('ABCD-1234').toString('base64'),display=variant==='compatibility'?[...encoded].map(c=>String.fromCharCode(c.charCodeAt(0)+0xfee0)).join(''):encoded.match(/.{1,4}/g)!.join(variant==='invisible'?'\u200b':' '),title=variant==='wrapped'?'Prefix '+display+' Suffix':'앞😀'+display+'뒤';
 const service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title,blocks:[display],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:'ABCD1234'}]};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);const observed=await service.read('mission','work');assert.equal(observed.session!.page.title,variant==='wrapped'?'••••':'앞😀••••뒤');assert.deepEqual(observed.session!.page.blocks,['••••']);
 for(const value of [JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(display),'Formatted private encoding must not persist');validateMissionJournalLineage(s.journal().operations);
});

for(const separator of ['.','-',' · ','....'])test('punctuation-separated encoded candidates cannot persist: '+separator,async t=>{
 const s=await fixture(t),display=Buffer.from('WXYZ-9876').toString('base64').match(/.{1,4}/g)!.join(separator),service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:'앞😀'+display+'뒤',blocks:[display],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:'WXYZ9876'}]};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);const observed=await service.read('mission','work');assert.equal(observed.session!.page.title,'앞😀••••뒤');assert.deepEqual(observed.session!.page.blocks,['••••']);
 for(const value of [JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(display),'Punctuation-separated private encoding must not persist');validateMissionJournalLineage(s.journal().operations);
});

for(const [plain,format,separator] of [['ABCD??1234','base64url','-'],['AB?CD1234','base64url','-'],['AB?CD1234','base64','_'],['AB>CD1234','base64url','_'],['AB?CD1234','base64url','_'],['AB>CD1234','base64url','--'],['AB>CD1234','base64url','----']] as const)test('mixed alphabet and grouping symbols remain private: '+plain+separator,async t=>{
 const s=await fixture(t),display=Buffer.from(plain).toString(format).match(/.{1,4}/g)!.join(separator),service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:'앞😀'+display+'뒤',blocks:[display],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:'ABCD1234'}]};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);const observed=await service.read('mission','work');assert.equal(observed.session!.page.title,'앞😀••••뒤');assert.deepEqual(observed.session!.page.blocks,['••••']);
 for(const value of [JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(display));validateMissionJournalLineage(s.journal().operations);
});

for(const separator of [':','%253A','%EF%BC%9A'])test('reserved capability path boundaries cannot retain token suffixes: '+separator,async t=>{
 const s=await fixture(t),token='M4G1CL1NK7e32',address='https://shop.example.com/reset'+separator+token,service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,address,title:token,blocks:[token],fields:[]};}},clock:s.clock});t.after(()=>service.drain());await service.capture({...request,address});
 for(const value of [JSON.stringify(await service.read('mission','work')),JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(token),'Capability suffix must not persist');validateMissionJournalLineage(s.journal().operations);
});

for(const [plain,separator] of [['WXYZ9876',''],['WXYZ-9876',''],['ＷＸＹＺ９８７６',':'],['WXYZ-9876',' ']] as const)test('hex display candidates cannot retain private values: '+separator+plain,async t=>{
 const s=await fixture(t),display=Buffer.from(plain).toString('hex').match(/.{1,4}/g)!.join(separator),service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:'앞😀'+display+'뒤',blocks:[display],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:'WXYZ9876'}]};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);const observed=await service.read('mission','work');assert.equal(observed.session!.page.title,'앞😀••••뒤');assert.deepEqual(observed.session!.page.blocks,['••••']);
 for(const value of [JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(display),'Hex private value must not persist');validateMissionJournalLineage(s.journal().operations);
});

for(const format of ['base64','base64url','hex'] as const)test('decoded capability seeds remain private: '+format,async t=>{
 const s=await fixture(t),secret='ABCD1234',token=Buffer.from(secret).toString(format),address='https://shop.example.com/recover/'+token,service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,address,title:secret,blocks:[secret],fields:[]};}},clock:s.clock});t.after(()=>service.drain());await service.capture({...request,address});
 for(const value of [JSON.stringify(await service.read('mission','work')),JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(secret),'Decoded capability must not persist');validateMissionJournalLineage(s.journal().operations);
});

test('a decoded private field seed is masked just like its original encoding',async t=>{
 const s=await fixture(t),service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:'ABCD1234',blocks:['ABCD1234'],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:Buffer.from('ABCD1234').toString('base64')}]};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);assert.ok(!JSON.stringify(s.journal()).includes('ABCD1234'));assert.equal((await service.read('mission','work')).session!.page.title,'••••');
});

test('a percent separator inside a hex candidate cannot bypass masking or refusal',async t=>{
 const s=await fixture(t),display='5758595a3938373%6',service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:display,blocks:[],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:'WXYZ9876'}]};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);assert.equal((await service.read('mission','work')).session!.page.title,'••••');for(const value of [JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(display));
});

test('excessively encoded private seeds fail before an observation is committed',async t=>{
 const s=await fixture(t);let secret='ABCD1234';for(let i=0;i<12;i++)secret=Buffer.from(secret).toString('base64');const before=s.journal().head,service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:'ABCD1234',blocks:[],fields:[{label:'Recovery code',type:'text',autocomplete:'',value:secret}]};}},clock:s.clock});t.after(()=>service.drain());await assert.rejects(service.capture(request),/private normalization bound/i);assert.equal(s.journal().head,before);
});

for(const first of ['WXYZ','ABCD'])test('both hex byte alignments are redacted: '+first,async t=>{
 const s=await fixture(t),display=Buffer.from(first).toString('hex')+'0'+Buffer.from('WXYZ').toString('hex')+'0',service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,title:display,blocks:[display],fields:[...new Set([first,'WXYZ'])].map(value=>({label:'Security code',type:'text',autocomplete:'',value}))};}},clock:s.clock});t.after(()=>service.drain());await service.capture(request);const observed=await service.read('mission','work');assert.match(observed.session!.page.title,/^(?:••••0)+$/);assert.ok(observed.session!.page.blocks.every(value=>/^(?:••••0)+$/.test(value)));
 for(const value of [JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes(Buffer.from('WXYZ').toString('hex')),'No shifted private hex suffix may persist');validateMissionJournalLineage(s.journal().operations);
});

for(const structure of ['reset:ABCD1234','reset：ABCD1234','reset:'+Buffer.from('ABCD1234').toString('base64')])test('decoded structured capability suffixes remain private: '+structure.slice(0,6),async t=>{
 const s=await fixture(t),address='https://shop.example.com/recover/'+Buffer.from(structure).toString('base64url'),service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return {...raw,address,title:'ABCD1234',blocks:['ABCD1234'],fields:[]};}},clock:s.clock});t.after(()=>service.drain());await service.capture({...request,address});
 for(const value of [JSON.stringify(await service.read('mission','work')),JSON.stringify(s.journal()),await exportPortableBackup({exportJournal:async()=>s.journal()},s.artifacts)])assert.ok(!value.includes('ABCD1234'),'Decoded structured suffix must not persist');validateMissionJournalLineage(s.journal().operations);
});
