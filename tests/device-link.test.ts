import test from 'node:test';
import assert from 'node:assert/strict';
import {connect,createServer} from 'node:tls';
import type {TLSSocket} from 'node:tls';
import {connect as netConnect,createServer as netCreateServer} from 'node:net';
import {createHash,createHmac,createPrivateKey,createPublicKey,generateKeyPairSync,hkdfSync,randomBytes,X509Certificate} from 'node:crypto';
import {hostname} from 'node:os';
import {InMemoryStore,SurrealStore,COMMIT_QUERY,LOAD_QUERY,READ_STATE_QUERY,OPERATION_QUERY,CommitOutcomeUnknownError,StorageQueryError} from '../src/storage.ts';
import type {QueryTransport,CommitInput} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {DeviceLinkService,DEVICE_LINK_ID,selfSignedDeviceCertificate,deviceIdFor,SRP_GROUP,srpK,srpX,srpVerifier,srpClientPublic,srpServerPublic,srpU,srpServerSecret,srpClientSecret,pairingConfirmations,nextPairingWindow,replayDeviceLink} from '../src/device-link.ts';
import type {PairingEffect,PairingEvent,PairingPhase,PairingWindowState} from '../src/device-link.ts';
import {hash} from '../src/domain.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const wait=async<T>(action:()=>Promise<T>|T,probe:(value:T)=>boolean,timeout=3000)=>{const end=Date.now()+timeout;for(;;){const value=await action();if(probe(value))return value;if(Date.now()>end)throw new Error('Condition not reached');await new Promise(resolve=>setTimeout(resolve,20));}};
const signal=async(task:Promise<void>)=>{let timer:NodeJS.Timeout|undefined;try{await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Signal not reached')),8000);timer.unref?.();})]);}finally{if(timer)clearTimeout(timer);}};
interface Core {store:ReturnType<typeof makeStore>;secrets:InMemorySecretSlots;service:DeviceLinkService}
const makeStore=()=>new InMemoryStore<any>();
let sequence=0;
async function core(clock:()=>number=Date.now,extra:Partial<{pairingTtlMs:number;port:number;bind:string;connectTimeoutMs:number;preAuthTimeoutMs:number;idleTimeoutMs:number;maxUnauthenticated:number;maxUnauthenticatedPerAddress:number;inboundCoalesceMs:number}>={}){const store=makeStore(),secrets=new InMemorySecretSlots();const service=new DeviceLinkService(store,store,secrets,{clock,bind:'127.0.0.1',port:0,connectTimeoutMs:1000,...extra});return {store,secrets,service};}
const openWindow=async(a:Core,commandId=`window-${++sequence}`)=>{
 const window=await a.service.openPairing({commandId});
 await assertWindowConsistency(a.service,a.store);
 return window;
};
test('review 1: opening and closing persist the pairing window generation',async()=>{
 const a=await core();
 try{
  const opened=await openWindow(a);
  const before=(await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow;
  assert.equal(before.status,'open');assert.equal(before.expiresAt,opened.expiresAt);assert.ok(before.generation);
  await a.service.closePairing({commandId:'review-1-close'});
  const after=(await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow;
  assert.equal(after.status,'closed');assert.notEqual(after.generation,before.generation);
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a);}
});
test('review 7 HIGH 1 (1): a failed close is settled before the command returns',async()=>{
 const base=makeStore();let fail=false;
 const store=new Proxy(base,{get(target,key){if(key==='commit')return async(input:CommitInput<any>)=>{if(fail&&(input.events[0] as any)?.command?.action==='window-closed'){fail=false;throw new Error('close failed');}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof base;
 const a=wedgedCore(store);
 try{
  await openWindow(a);fail=true;
  await assert.rejects(a.service.closePairing({commandId:'review7-failed-close'}),/close failed/);
  assert.equal((await store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'closed');
  await assertWindowConsistency(a.service,store);
  assert.match((await openWindow(a)).code,/^[0-9]{6}$/);
 }finally{await drain(a).catch(()=>{});}
});
test('concurrent opens return only the code for the committed window',async()=>{
 const a=await core(),b=await core();
 try{
  const outcomes=await Promise.allSettled([openWindow(a),openWindow(a)]);
  const successes=outcomes.filter(result=>result.status==='fulfilled');
  assert.equal(successes.length,1);
  const opened=successes[0]!.value;
  assert.equal((await pairFrom(b,opened.address,opened.code)).status,'paired');
  const pairing=a.store.inspect().find(entry=>(entry.events[0] as any).command?.windowGeneration);
  assert.ok(pairing);assert.ok(Date.parse(pairing.recordedAt)<opened.expiresAt);
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});
test('review 6: a second open cannot replace a code before the first open returns',async()=>{
 const base=makeStore();let arm=false,entered=false,release=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const store=new Proxy(base,{get(target,key){
  if(key==='commit')return async(input:CommitInput<any>)=>{const result=await target.commit(input);if((input.events[0] as any)?.command?.action==='window-opened')arm=true;return result;};
  if(key==='load')return async(...args:Parameters<typeof target.load>)=>{if(arm&&!entered){entered=true;await gate;}return target.load(...args);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }}) as typeof base;
 const a=wedgedCore(store),b=await core();
 try{
  await a.service.read();
  const first=openWindow(a);first.catch(()=>{});
  await wait(()=>entered,Boolean,8000);
  const second=openWindow(a);second.catch(()=>{});
  release();
  const results=await Promise.allSettled([first,second]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const winner=results.find(result=>result.status==='fulfilled');assert.ok(winner&&winner.status==='fulfilled');
  assert.equal((await pairFrom(b,winner.value.address,winner.value.code)).status,'paired');
  await assertWindowConsistency(a.service,a.store);
 }finally{release();await drain(a,b).catch(()=>{});}
});
test('review 6: a queued close starts after the first open returns',async()=>{
 const base=makeStore();let arm=false,entered=false,release=()=>{},firstReturned=false,closeAfterReturn=false;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const store=new Proxy(base,{get(target,key){
  if(key==='commit')return async(input:CommitInput<any>)=>{const action=(input.events[0] as any)?.command?.action;if(action==='window-closed')closeAfterReturn=firstReturned;const result=await target.commit(input);if(action==='window-opened')arm=true;return result;};
  if(key==='load')return async(...args:Parameters<typeof target.load>)=>{if(arm&&!entered){entered=true;await gate;}return target.load(...args);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }}) as typeof base;
 const a=wedgedCore(store);
 try{
  await a.service.read();
  const first=a.service.openPairing({commandId:'queued-open'});first.then(()=>{firstReturned=true;});
  await wait(()=>entered,Boolean,8000);
  const closing=a.service.closePairing({commandId:'queued-close'});release();
  await first;await closing;
  assert.equal(closeAfterReturn,true);
  await assertWindowConsistency(a.service,a.store);
 }finally{release();await drain(a).catch(()=>{});}
});
test('review 6: an open never returns a code after another writer closes it',async()=>{
 const db=queuedDatabase(),store=db.store(),other=db.store(),secrets=new InMemorySecretSlots();let arm=false,entered=()=>{},release=()=>{};
 const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const commit=store.commit.bind(store),load=store.load.bind(store);
 store.commit=async(input:CommitInput<any>)=>{const result=await commit(input);if((input.events[0] as any)?.command?.action==='window-opened')arm=true;return result;};
 store.load=async(id:string)=>{if(arm){arm=false;entered();await gate;}return load(id);};
 const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
 try{
  await service.read();
  const opening=service.openPairing({commandId:'external-close-open'});opening.catch(()=>{});
  await started;
  const snapshot=(await other.load(DEVICE_LINK_ID))!,value=structuredClone(snapshot.value),previous=value.pairingWindow.generation;
  const command={type:'link-observe',action:'window-closed',generation:'external-close-before-return',previous};
  value.pairingWindow={...value.pairingWindow,generation:command.generation,status:'closed'};
  assert.equal((await other.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:snapshot.revision,value,events:[{type:command.type,actor:'device-link',command}],outbox:[]})).status,'committed');
  release();
  await assert.rejects(opening,(error:any)=>error.code==='conflict');
  await assertWindowConsistency(service,other);
 }finally{release();await service.drain().catch(()=>{});}
});
test('restart closes the persisted pairing window before serving requests',async()=>{
 const a=await core();let restarted:DeviceLinkService|undefined;
 try{
  await openWindow(a);
  const before=(await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow;
  await a.service.drain();
  restarted=new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  assert.equal((await restarted.read()).pairing,null);
  const after=(await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow;
  assert.equal(after.status,'closed');assert.notEqual(after.generation,before.generation);
  await assertWindowConsistency(restarted,a.store);
 }finally{if(restarted)await restarted.drain();await a.service.drain().catch(()=>{});}
});
const pairFrom=(b:Core,address:string,code:string)=>b.service.pair({commandId:`pair-${++sequence}`,address,code,name:'Laptop',agentName:'Claude Code'});
const link=async(a:Core,b:Core)=>{const window=await openWindow(a);const outcome=await pairFrom(b,window.address,window.code!);assert.equal(outcome.status,'paired');return window;};
const drain=async(...cores:Core[])=>{for(const core of cores)await core.service.drain();};
const assertWindowConsistency=async(service:DeviceLinkService,store:{load:(id:string)=>Promise<any>},clock:()=>number=Date.now)=>{
 const view=await service.read(),window=(await store.load(DEVICE_LINK_ID))?.value.pairingWindow;
 if(view.unknownPairingCommit){assert.equal(view.pairing,null);assert.ok(window?.generation);return;}
 assert.equal(view.pairing!==null,Boolean(window?.status==='open'&&window.expiresAt>clock()));
 if(view.pairing){assert.ok(window?.generation);assert.equal(view.pairing.expiresAt,window.expiresAt);}
};

test('review 6: every window status requires the exact previous generation',async()=>{
 const rows=[
  ['missing',null,true],['missing','old',false],
  ['open','old',true],['open',null,false],['open','stale',false],
  ['closed','old',true],['closed',null,false],['closed','stale',false],
  ['consumed','old',true],['consumed',null,false],['consumed','stale',false],
 ] as const;
 assert.equal(rows.length,11);
 for(const action of ['window-opened','window-closed'] as const)for(const [status,previous,allowed] of rows){
  const store=makeStore(),current={kind:'device-link',id:DEVICE_LINK_ID,peers:[],offers:[],...(status==='missing'?{}:{pairingWindow:{generation:'old',status,expiresAt:1000}})};
  await store.commit({id:DEVICE_LINK_ID,commandId:'seed',fingerprint:'seed',expectedRevision:0,value:current,events:[],outbox:[]});
  const command=action==='window-opened'?{type:'link-observe',action,generation:'new',previous,expiresAt:2000}:{type:'link-observe',action,generation:'new',previous};
  const next={...current,pairingWindow:{generation:'new',status:action==='window-opened'?'open':'closed',expiresAt:action==='window-opened'?2000:status==='missing'?0:1000}};
  await store.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:1,value:next,events:[{type:command.type,actor:'device-link',command}],outbox:[]});
  const [prior,operation]=store.inspect();
  if(allowed)assert.doesNotThrow(()=>replayDeviceLink(operation!,prior));
  else assert.throws(()=>replayDeviceLink(operation!,prior),/conflict/i);
 }
});

// Stores share query results and revisions but retain independent commit queues.
function queuedDatabase(){
 let recordedAt=Date.now(),release=()=>{},entered=()=>{},releaseReply=()=>{},replyEntered=()=>{},holdWindow=false,holdPeerReply=false,deadlineRejections=0;
 const key=(value:string)=>createHash('sha256').update(value).digest('hex');
 const base=new InMemoryStore<any>(()=>new Date(recordedAt));
 const started=new Promise<void>(resolve=>{entered=resolve;});
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const replyStarted=new Promise<void>(resolve=>{replyEntered=resolve;}),replyGate=new Promise<void>(resolve=>{releaseReply=resolve;});
 const transport:QueryTransport={async query(sql,vars){
  if(sql===COMMIT_QUERY){
   if(vars.commandId==='queue-blocker'||holdWindow&&(vars.events as any[])?.[0]?.command?.action==='window-opened'){holdWindow=false;entered();await gate;}
   const feed=await base.readState();
   if(vars.expectedFeed&&vars.expectedFeed!==feed.feedId)return [{status:'feed-mismatch',feedId:feed.feedId}];
   const current=await base.load(String(vars.aggregateId));
   const existing=base.inspect().some(item=>item.commandId===vars.commandId);
   if(!existing&&vars.deadlinePassed&&Number(vars.expectedRevision)===(current?.revision??0)){deadlineRejections++;return [{status:'conflict',reason:'deadline',revision:current?.revision??0}];}
   recordedAt=Date.parse(String(vars.recordedAt));
   const result=await base.commit({id:String(vars.aggregateId),commandId:String(vars.commandId),fingerprint:String(vars.fingerprint),expectedRevision:Number(vars.expectedRevision),value:vars.value,events:vars.events as unknown[],outbox:vars.outbox as unknown[]});
   if(holdPeerReply&&(vars.events as any[])?.[0]?.command?.action==='peer-added'){holdPeerReply=false;replyEntered();await replyGate;}
   return [result];
  }
  if(sql===LOAD_QUERY){const op=base.inspect().filter(item=>key(item.aggregateId)===vars.aggregateKey).at(-1);return [op?{aggregateId:op.aggregateId,revision:op.revision,value:op.value}:null];}
  if(sql===OPERATION_QUERY)return [base.inspect().find(item=>key(item.commandId)===vars.operationKey)??null];
  if(sql===READ_STATE_QUERY){const state=await base.readState();const op=base.inspect().filter(item=>key(item.aggregateId)===vars.aggregateKey).at(-1);return [{feedId:state.feedId,cursor:state.cursor,state:op?{aggregateId:op.aggregateId,revision:op.revision,value:op.value}:null}];}
  throw new Error('Unexpected storage query');
 }};
 let now=Date.now();
 return {base,started,release,replyStarted,releaseReply,holdPeerReply:()=>{holdPeerReply=true;},now:()=>now,deadlineRejections:()=>deadlineRejections,holdWindow:()=>{holdWindow=true;},advance:(time:number)=>{now=time;},store:()=>new SurrealStore<any>(transport,()=>new Date(now))};
}

// The peer query loses its response while its server-side write waits independently.
function uncertainQueuedDatabase(){
 const base=makeStore(),key=(value:string)=>createHash('sha256').update(value).digest('hex');
 let releasePair=()=>{},releaseClose=()=>{},pairEntered=()=>{},closeEntered=()=>{},holdClose=false,silent=false,intercepted=false;
 const pairGate=new Promise<void>(resolve=>{releasePair=resolve;}),closeGate=new Promise<void>(resolve=>{releaseClose=resolve;});
 const pairStarted=new Promise<void>(resolve=>{pairEntered=resolve;}),closeStarted=new Promise<void>(resolve=>{closeEntered=resolve;});
 let pairResult:Promise<any>|undefined;
 const apply=async(vars:Record<string,unknown>)=>{
  const snapshot=await base.load(String(vars.aggregateId));
  if(vars.deadlinePassed&&Number(vars.expectedRevision)===(snapshot?.revision??0))return {status:'conflict',reason:'deadline',revision:snapshot?.revision??0};
  return await base.commit({id:String(vars.aggregateId),commandId:String(vars.commandId),fingerprint:String(vars.fingerprint),expectedRevision:Number(vars.expectedRevision),value:vars.value,events:vars.events as unknown[],outbox:vars.outbox as unknown[]});
 };
 const transport:QueryTransport={async query(sql,vars){
  if(sql===COMMIT_QUERY){
   const action=(vars.events as any[])?.[0]?.command?.action;
   if(action==='peer-added'&&!intercepted){intercepted=true;pairResult=pairGate.then(()=>apply(vars));pairEntered();throw new Error('response lost');}
   if(action==='window-closed'&&silent)throw new Error('store silent');
   if(action==='window-closed'&&holdClose){holdClose=false;closeEntered();await closeGate;}
   return [await apply(vars)];
  }
  if(sql===LOAD_QUERY){const op=base.inspect().filter(item=>key(item.aggregateId)===vars.aggregateKey).at(-1);return [op?{aggregateId:op.aggregateId,revision:op.revision,value:op.value}:null];}
  if(sql===OPERATION_QUERY)return [base.inspect().find(item=>key(item.commandId)===vars.operationKey)??null];
  if(sql===READ_STATE_QUERY){const state=await base.readState(),op=base.inspect().filter(item=>key(item.aggregateId)===vars.aggregateKey).at(-1);return [{feedId:state.feedId,cursor:state.cursor,state:op?{aggregateId:op.aggregateId,revision:op.revision,value:op.value}:null}];}
  throw new Error('Unexpected storage query');
 }};
 const store=new SurrealStore<any>(transport);
 return {base,store,other:new SurrealStore<any>(transport),pairStarted,closeStarted,releasePair,releaseClose,holdClose:()=>{holdClose=true;},setSilent:(value:boolean)=>{silent=value;},pairResult:()=>pairResult!};
}

// A real SurrealStore queue where another writer commits to the same aggregate between the settle's read and its close commit.
function contendedDatabase(interleavings:number){
 const base=makeStore(),key=(value:string)=>createHash('sha256').update(value).digest('hex');
 let windowCloses=0,active=interleavings;
 const apply=async(vars:Record<string,unknown>)=>{
  const snapshot=await base.load(String(vars.aggregateId));
  if(vars.deadlinePassed&&Number(vars.expectedRevision)===(snapshot?.revision??0))return {status:'conflict',reason:'deadline',revision:snapshot?.revision??0};
  return await base.commit({id:String(vars.aggregateId),commandId:String(vars.commandId),fingerprint:String(vars.fingerprint),expectedRevision:Number(vars.expectedRevision),value:vars.value,events:vars.events as unknown[],outbox:vars.outbox as unknown[]});
 };
 const transport:QueryTransport={async query(sql,vars){
  if(sql===COMMIT_QUERY){
   if((vars.events as any[])?.[0]?.command?.action==='window-closed'&&windowCloses<active){
    windowCloses++;
    const snapshot=await base.load(DEVICE_LINK_ID),value=structuredClone(snapshot?.value??{kind:'device-link',id:DEVICE_LINK_ID,peers:[],offers:[]});
    const command={type:'link-observe',action:'listener-bound',port:47000+windowCloses};
    await base.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:snapshot?.revision??0,value:{...value,listen:{port:command.port}},events:[{type:command.type,actor:'device-link',command}],outbox:[]});
   }
   return [await apply(vars)];
  }
  if(sql===LOAD_QUERY){const op=base.inspect().filter(item=>key(item.aggregateId)===vars.aggregateKey).at(-1);return [op?{aggregateId:op.aggregateId,revision:op.revision,value:op.value}:null];}
  if(sql===OPERATION_QUERY)return [base.inspect().find(item=>key(item.commandId)===vars.operationKey)??null];
  if(sql===READ_STATE_QUERY){const state=await base.readState(),op=base.inspect().filter(item=>key(item.aggregateId)===vars.aggregateKey).at(-1);return [{feedId:state.feedId,cursor:state.cursor,state:op?{aggregateId:op.aggregateId,revision:op.revision,value:op.value}:null}];}
  throw new Error('Unexpected storage query');
 }};
 return {base,windowCloses:()=>windowCloses,stop:()=>{active=0;},store:()=>new SurrealStore<any>(transport)};
}
const seedOpenWindow=async(other:{load:(id:string)=>Promise<any>;commit:(input:CommitInput<any>)=>Promise<any>},generation:string)=>{
 const snapshot=await other.load(DEVICE_LINK_ID),command={type:'link-observe',action:'window-opened',generation,previous:null,expiresAt:Date.now()+60000};
 const value={kind:'device-link',id:DEVICE_LINK_ID,peers:[],offers:[],pairingWindow:{generation,status:'open' as const,expiresAt:command.expiresAt}};
 return await other.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:snapshot?.revision??0,value,events:[{type:command.type,actor:'device-link',command}],outbox:[]});
};

test('review 7 HIGH 2: a stored pairing is reported while its reply is pending',async()=>{
 const db=queuedDatabase(),store=db.store(),secrets=new InMemorySecretSlots(),b=await core();
 const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:1000});
 try{
  const window=await service.openPairing({commandId:'review7-pair-reply'});
  db.holdPeerReply();void pairFrom(b,window.address,window.code).catch(()=>{});
  await signal(db.replyStarted);
  const result=await service.closePairing({commandId:'review7-pair-reply-close'});
  assert.equal(result.status,'paired');
  const state=(await store.load(DEVICE_LINK_ID))!;assert.equal(state.value.pairingWindow.status,'consumed');assert.equal(state.value.peers.length,1);
  if(result.status==='paired')assert.equal(result.peer.deviceId,state.value.peers[0].deviceId);
  await assertWindowConsistency(service,store);
 }finally{db.releaseReply();await service.drain().catch(()=>{});await drain(b).catch(()=>{});}
});

for(const pairWins of [false,true]){
 test(`review 7 HIGH 2: ${pairWins?'pairing wins before the settling close':'settling close fences the pending pairing'}`,async()=>{
  const db=uncertainQueuedDatabase(),secrets=new InMemorySecretSlots(),b=await core();
  const service=new DeviceLinkService(db.store,db.store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:1000});
  try{
   const window=await service.openPairing({commandId:`review7-unknown-${pairWins}`});
   void pairFrom(b,window.address,window.code).catch(()=>{});
   await signal(db.pairStarted);
   await wait(()=>service.read(),view=>view.unknownPairingCommit!==null,8000);
   if(pairWins)db.holdClose();
   const closing=service.closePairing({commandId:`review7-close-${pairWins}`});closing.catch(()=>{});
   if(pairWins){await Promise.race([db.closeStarted,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('settling close did not start')),2000).unref())]);db.releasePair();assert.equal((await db.pairResult()).status,'committed');db.releaseClose();}
   const result=await closing;assert.equal(result.status,pairWins?'paired':'closed');
   if(!pairWins){db.releasePair();assert.equal((await db.pairResult()).status,'conflict');}
   const state=(await db.store.load(DEVICE_LINK_ID))!;
   assert.equal(state.value.peers.length,pairWins?1:0);
   if(pairWins){assert.equal(result.status,'paired');if(result.status==='paired')assert.equal(result.peer.deviceId,state.value.peers[0].deviceId);}
   assert.equal(state.value.pairingWindow.status,pairWins?'consumed':'closed');
   assert.equal((await service.read()).unknownPairingCommit,null);
   if(!pairWins){assert.match((await service.openPairing({commandId:'review7-reopen-after-fenced-unknown'})).code,/^[0-9]{6}$/);}
   await assertWindowConsistency(service,db.store);
  }finally{db.releasePair();db.releaseClose();await service.drain().catch(()=>{});await drain(b).catch(()=>{});}
 });
}

test('review 7 HIGH 2: opening directly during a true unknown settles and opens a code',async()=>{
 const db=uncertainQueuedDatabase(),secrets=new InMemorySecretSlots(),b=await core();
 const service=new DeviceLinkService(db.store,db.store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:1000});
 try{
  const window=await service.openPairing({commandId:'review7-unknown-direct-open-1'});
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await signal(db.pairStarted);
  await wait(()=>service.read(),view=>view.unknownPairingCommit!==null,8000);
  const reopened=await service.openPairing({commandId:'review7-unknown-direct-open-2'});
  assert.match(reopened.code,/^[0-9]{6}$/);
  db.releasePair();assert.equal((await db.pairResult()).status,'conflict');
  assert.equal((await service.read()).peers.length,0);
  assert.equal((await service.read()).unknownPairingCommit,null);
  await assertWindowConsistency(service,db.store);
 }finally{db.releasePair();db.releaseClose();await service.drain().catch(()=>{});await drain(b).catch(()=>{});}
});

test('review 7 HIGH 2: another device consuming the window resolves the pending pairing as not paired',async()=>{
 const db=uncertainQueuedDatabase(),secrets=new InMemorySecretSlots(),b=await core();
 const service=new DeviceLinkService(db.store,db.store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
 try{
  const window=await service.openPairing({commandId:'review7-other-device'});
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await signal(db.pairStarted);await wait(()=>service.read(),view=>view.unknownPairingCommit!==null,8000);
  const snapshot=(await db.other.load(DEVICE_LINK_ID))!,value=structuredClone(snapshot.value),identity=rawIdentity();
  const peer={deviceId:identity.deviceId,publicKey:identity.publicKeyB64,name:'Other',agentName:'Other',grants:{view:true,instruct:true,answerApprovals:true},addresses:[],pairedAt:Date.now()};
  const command={type:'link-observe',action:'peer-added',peer,windowGeneration:value.pairingWindow.generation};
  value.pairingWindow.status='consumed';value.peers.push(peer);
  assert.equal((await db.other.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:snapshot.revision,value,events:[{type:command.type,actor:'device-link',command}],outbox:[]})).status,'committed');
  assert.equal((await service.closePairing({commandId:'review7-other-close'})).status,'closed');
  db.releasePair();assert.equal((await db.pairResult()).status,'conflict');
  const view=await service.read();assert.equal(view.unknownPairingCommit,null);assert.equal(view.peers.length,1);assert.equal(view.peers[0]!.deviceId,peer.deviceId);
  await assertWindowConsistency(service,db.store);
 }finally{db.releasePair();db.releaseClose();await service.drain().catch(()=>{});await drain(b).catch(()=>{});}
});

for(const nextAction of ['open','close'] as const){
 test(`review 7 recovery: the next ${nextAction} resolves unknown after the store responds`,async()=>{
  const db=uncertainQueuedDatabase(),secrets=new InMemorySecretSlots(),b=await core();
  const service=new DeviceLinkService(db.store,db.store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:100});
  try{
   const window=await service.openPairing({commandId:`review7-recovery-initial-${nextAction}`});
   void pairFrom(b,window.address,window.code).catch(()=>{});
   await signal(db.pairStarted);
   await wait(()=>service.read(),view=>view.unknownPairingCommit!==null,8000);
   db.setSilent(true);
   await assert.rejects(service.closePairing({commandId:`review7-silent-${nextAction}`}),error=>error instanceof CommitOutcomeUnknownError);
   assert.notEqual((await service.read()).unknownPairingCommit,null);
   assert.equal((await db.store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'open');
   db.setSilent(false);
   await flush();
   assert.notEqual((await service.read()).unknownPairingCommit,null);
   assert.equal((await db.store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'open');
   const recovered=nextAction==='open'?await service.openPairing({commandId:'review7-recovered-open'}):await service.closePairing({commandId:'review7-recovered-close'});
   if(nextAction==='open')assert.match((recovered as {code:string}).code,/^[0-9]{6}$/);
   else assert.equal((recovered as {status:string}).status,'closed');
   db.releasePair();assert.equal((await db.pairResult()).status,'conflict');
   assert.equal((await service.read()).peers.length,0);
   assert.equal((await service.read()).unknownPairingCommit,null);
   await assertWindowConsistency(service,db.store);
  }finally{db.setSilent(false);db.releasePair();db.releaseClose();await service.drain().catch(()=>{});await drain(b).catch(()=>{});}
 });
}

test('review 9 q1: the settling close retries past four interleaved writers and the command still agrees',async()=>{
 const db=contendedDatabase(4),store=db.store(),other=db.store(),secrets=new InMemorySecretSlots();
 const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:5000});
 try{
  await service.read(); // the start-up settle has finished on an empty aggregate
  assert.equal((await seedOpenWindow(other,'contended-open')).status,'committed');
  // Stored window open, nothing live in memory: one owner command; each of the settle's first four close commits meets a writer that landed in between.
  const result=await service.closePairing({commandId:'contended-close'});
  assert.equal(result.status,'closed');
  assert.equal(db.windowCloses(),4);
  assert.equal((await store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'closed');
  await assertWindowConsistency(service,store);
 }finally{await service.drain().catch(()=>{});}
});

test('review 9 q1: a never-stopping writer ends the settle at the command deadline',async()=>{
 const db=contendedDatabase(Number.POSITIVE_INFINITY),store=db.store(),other=db.store(),secrets=new InMemorySecretSlots();
 const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:120});
 try{
  await service.read();
  assert.equal((await seedOpenWindow(other,'endless-open')).status,'committed');
  const started=Date.now();
  await assert.rejects(service.closePairing({commandId:'endless-close'}),error=>error instanceof CommitOutcomeUnknownError,'the deadline error, not the old three-conflict throw');
  const elapsed=Date.now()-started;
  assert.ok(elapsed>=120,`the command ended only at its deadline, not earlier (took ${elapsed}ms)`);
  assert.ok(elapsed<120+2000,`the command did not outlast its deadline (took ${elapsed}ms)`);
  assert.ok(db.windowCloses()>4,'the settle kept retrying past the old three-attempt bound');
  db.stop();
  assert.equal((await service.closePairing({commandId:'endless-close-recovered'})).status,'closed','the next command settles once the writer stops');
  await assertWindowConsistency(service,store);
 }finally{await service.drain().catch(()=>{});}
});

test('review 9 q1: a window expiring between the settle clock readings is closed, not thrown as a mismatch',async()=>{
 const t0=Date.now(),ttl=60000;let alternate=false,high=true;
 const clock=()=>{if(!alternate)return t0;high=!high;return high?t0+ttl+1:t0;};
 const a=await core(clock,{pairingTtlMs:ttl});
 try{
  await openWindow(a); // opened while the clock is pinned: expiresAt=t0+ttl
  alternate=true; // the settle's first clock reading is t0 (still live), the second is past the expiry
  assert.equal((await a.service.closePairing({commandId:'expiry-between-readings'})).status,'closed','the expired window is closed by the same command');
  assert.equal((await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'closed');
  await assertWindowConsistency(a.service,a.store,clock);
 }finally{alternate=false;await drain(a).catch(()=>{});}
});

for(const scenario of ['expiry','restart'] as const){
 test(`real SurrealStore queue refuses pairing after ${scenario} wins`,async()=>{
  const db=queuedDatabase(),store=db.store(),other=db.store(),secrets=new InMemorySecretSlots(),b=await core();
  const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:1000});
  let queued=()=>{};const pairingQueued=new Promise<void>(resolve=>{queued=resolve;});
  const commit=store.commit.bind(store);
  store.commit=(input:CommitInput<any>)=>{if((input.events[0] as any)?.command?.action==='peer-added')queued();return commit(input);};
  let restarted:DeviceLinkService|undefined;
  try{
   const window=await service.openPairing({commandId:`queue-${scenario}`});
   const blocker=store.commit({id:'queue-blocker',commandId:'queue-blocker',fingerprint:'queue-blocker',expectedRevision:0,value:{},events:[],outbox:[]});
   await db.started;
   const pairing=pairFrom(b,window.address,window.code);pairing.catch(()=>{});
   await Promise.race([pairingQueued,pairing.then(result=>{throw new Error(`Pairing settled before queue: ${result.status}`);}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Pairing did not reach the queue')),8000).unref())]);
   if(scenario==='expiry')db.advance(window.expiresAt+1);
   else if(scenario==='restart'){
    restarted=new DeviceLinkService(other,other,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
    await restarted.read();
   }
   db.release();await blocker;
   await wait(()=>db.base.load(DEVICE_LINK_ID),snapshot=>snapshot?.value.peers.length===0);
   const outcome=await pairing;
   assert.notEqual(outcome.status,'paired');
   const state=(await other.load(DEVICE_LINK_ID))!;
   assert.equal(state.value.peers.length,0);
   assert.equal((await service.read()).unknownPairingCommit,null);
   assert.equal(db.base.inspect().filter(item=>(item.events[0] as any)?.command?.action==='peer-added').length,0);
   if(scenario==='expiry')assert.equal(db.deadlineRejections(),1);
   validateMissionJournalLineage(db.base.inspect().filter(item=>item.aggregateId===DEVICE_LINK_ID));
   await assertWindowConsistency(scenario==='restart'?restarted!:service,scenario==='restart'?other:store,db.now);
  }finally{db.release();if(restarted)await restarted.drain().catch(()=>{});await service.drain().catch(()=>{});await drain(b).catch(()=>{});}
 });
}

test('real SurrealStore queue retains a pairing that wins before restart',async()=>{
 const db=queuedDatabase(),store=db.store(),other=db.store(),secrets=new InMemorySecretSlots(),b=await core();
 const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
 let queued=()=>{};const pairingQueued=new Promise<void>(resolve=>{queued=resolve;});
 const commit=store.commit.bind(store);
 store.commit=(input:CommitInput<any>)=>{if((input.events[0] as any)?.command?.action==='peer-added')queued();return commit(input);};
 let restarted:DeviceLinkService|undefined;
 try{
  const window=await service.openPairing({commandId:'queue-pair-first'});
  const blocker=store.commit({id:'queue-blocker',commandId:'queue-blocker',fingerprint:'queue-blocker',expectedRevision:0,value:{},events:[],outbox:[]});
  await db.started;
  const pairing=pairFrom(b,window.address,window.code);
  await Promise.race([pairingQueued,pairing.then(result=>{throw new Error(`Pairing settled before queue: ${result.status}`);})]);
  db.release();await blocker;
  assert.equal((await pairing).status,'paired');
  const operation=db.base.inspect().find(item=>(item.events[0] as any)?.command?.action==='peer-added');
  assert.ok(operation);assert.ok(Date.parse(operation.recordedAt)<window.expiresAt);
  await service.drain();
  restarted=new DeviceLinkService(other,other,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  assert.equal((await restarted.read()).peers.length,1);
  await assertWindowConsistency(restarted,other);
 }finally{db.release();if(restarted)await restarted.drain().catch(()=>{});await service.drain().catch(()=>{});await drain(b).catch(()=>{});}
});

for(const releaseWithinDeadline of [true,false]){
 test(`review 6: queued pairing ${releaseWithinDeadline?'wins before close':'settles after close deadline'}`,async()=>{
  const db=queuedDatabase(),store=db.store(),secrets=new InMemorySecretSlots(),b=await core();
  const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:releaseWithinDeadline?5000:100});
  let queued=()=>{};const pairingQueued=new Promise<void>(resolve=>{queued=resolve;});const commit=store.commit.bind(store);
  store.commit=(input:CommitInput<any>)=>{if((input.events[0] as any)?.command?.action==='peer-added')queued();return commit(input);};
  try{
   const window=await service.openPairing({commandId:`fifo-${releaseWithinDeadline}`});
   const blocker=store.commit({id:'queue-blocker',commandId:'queue-blocker',fingerprint:'queue-blocker',expectedRevision:0,value:{},events:[],outbox:[]});
   await db.started;
   const pairing=pairFrom(b,window.address,window.code);pairing.catch(()=>{});
   await pairingQueued;
   const closing=service.closePairing({commandId:`fifo-close-${releaseWithinDeadline}`});closing.catch(()=>{});
   if(releaseWithinDeadline){db.release();await blocker;assert.equal((await pairing).status,'paired');assert.equal((await closing).status,'closed');}
   else{await assert.rejects(closing,error=>error instanceof CommitOutcomeUnknownError);db.release();await blocker;await wait(()=>service.read(),view=>view.unknownPairingCommit===null&&view.peers.length===1,8000);}
   assert.equal((await service.read()).peers.length,1);
   assert.equal((await store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,releaseWithinDeadline?'closed':'consumed');
   if(releaseWithinDeadline){
    const history=db.base.inspect().filter(entry=>entry.aggregateId===DEVICE_LINK_ID),actions=history.map(entry=>(entry.events[0] as any)?.command?.action),closed=actions.lastIndexOf('window-closed');
    const paired=actions.indexOf('peer-added');assert.ok(paired>=0&&paired<closed);assert.equal(history[closed-1]!.value.pairingWindow.status,'consumed');
   }
   await assertWindowConsistency(service,store);
  }finally{db.release();await service.drain().catch(()=>{});await drain(b).catch(()=>{});}
 });
}

test('a timed-out window write blocks reopening until the delayed write settles',async()=>{
 const db=queuedDatabase(),store=db.store(),secrets=new InMemorySecretSlots();
 const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:100});
 try{
  await service.read();db.holdWindow();
  const first=service.openPairing({commandId:'delayed-window-first'});first.catch(()=>{});
  await db.started;
  await assert.rejects(first,error=>error instanceof CommitOutcomeUnknownError);
  await assert.rejects(service.openPairing({commandId:'delayed-window-blocked'}),error=>error instanceof CommitOutcomeUnknownError);
  assert.equal(db.base.inspect().filter(item=>(item.events[0] as any)?.command?.action==='window-opened').length,0);
  db.release();
  await wait(()=>db.base.inspect(),entries=>entries.some(item=>(item.events[0] as any)?.command?.action==='window-opened'&&item.value.pairingWindow?.status==='open'));
  await wait(()=>store.load(DEVICE_LINK_ID),snapshot=>snapshot?.value.pairingWindow?.status==='closed');
  await assertWindowConsistency(service,store);
  const reopened=await service.openPairing({commandId:'delayed-window-reopened'});
  assert.match(reopened.code,/^[0-9]{6}$/);
  assert.equal(db.base.inspect().filter(item=>(item.events[0] as any)?.command?.action==='window-opened').length,2);
  await assertWindowConsistency(service,store);
 }finally{db.release();await service.drain().catch(()=>{});}
});
test('review 7 HIGH 1 (2): a late opened window is settled without an in-memory verifier',async()=>{
 const db=queuedDatabase(),store=db.store(),secrets=new InMemorySecretSlots();
 const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:100});
 try{
  await service.read();db.holdWindow();
  const first=service.openPairing({commandId:'review7-late-open'});first.catch(()=>{});
  await db.started;await assert.rejects(first,error=>error instanceof CommitOutcomeUnknownError);
  db.release();
  await wait(()=>store.load(DEVICE_LINK_ID),snapshot=>snapshot?.value.pairingWindow?.status==='closed');
  await assertWindowConsistency(service,store);
  assert.match((await service.openPairing({commandId:'review7-after-late-open'})).code,/^[0-9]{6}$/);
  await assertWindowConsistency(service,store);
 }finally{db.release();await service.drain().catch(()=>{});}
});
test('review 7 HIGH 1 (3): listener failure closes the committed window',async()=>{
 const base=makeStore();let fail=false;
 const store=new Proxy(base,{get(target,key){
  if(key==='commit')return async(input:CommitInput<any>)=>{const result=await target.commit(input);if((input.events[0] as any)?.command?.action==='window-opened')fail=true;return result;};
  if(key==='load')return async(...args:Parameters<typeof target.load>)=>{if(fail){fail=false;throw new Error('listener load failed');}return target.load(...args);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }}) as typeof base;
 const a=wedgedCore(store);
 try{
  await a.service.read();
  await assert.rejects(openWindow(a),/listener load failed/);
  assert.equal((await store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'closed');
  await assertWindowConsistency(a.service,store);
 }finally{await drain(a).catch(()=>{});}
});
test('review 6: a stale replacement cannot reopen a window closed by another writer',async()=>{
 const db=queuedDatabase(),store=db.store(),other=db.store(),secrets=new InMemorySecretSlots();
 const service=new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
 try{
  await service.openPairing({commandId:'stale-initial'});
  db.holdWindow();
  const replacing=service.openPairing({commandId:'stale-replacement'});replacing.catch(()=>{});
  await db.started;
  const snapshot=(await other.load(DEVICE_LINK_ID))!,value=structuredClone(snapshot.value),previous=value.pairingWindow.generation;
  const command={type:'link-observe',action:'window-closed',generation:'external-close',previous};
  value.pairingWindow={...value.pairingWindow,generation:command.generation,status:'closed'};
  const result=await other.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:snapshot.revision,value,events:[{type:command.type,actor:'device-link',command}],outbox:[]});
  assert.equal(result.status,'committed');
  db.release();
  await assert.rejects(replacing,(error:any)=>error.code==='conflict');
  assert.equal((await other.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'closed');
  assert.equal((await service.read()).pairing,null);
  await assertWindowConsistency(service,store);
 }finally{db.release();await service.drain().catch(()=>{});}
});
const rawServer=async(options:{key:string;cert:string;requestCert:boolean;rejectUnauthorized?:boolean},handler:(socket:TLSSocket)=>void)=>{const sockets=new Set<TLSSocket>();const server=await new Promise<ReturnType<typeof createServer>>(resolve=>{const s=createServer({...options},socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));handler(socket);});s.listen(0,'127.0.0.1',()=>resolve(s));});return {server,sockets,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(()=>resolve(null)));}};};
const rawIdentity=()=>{const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});const spki=publicKey.export({type:'spki',format:'der'}) as Buffer,publicKeyB64=spki.toString('base64');return {privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}).toString(),certPem:selfSignedDeviceCertificate(privateKey,deviceIdFor(publicKeyB64)),publicKeyB64,fingerprint:createHash('sha256').update(spki).digest('hex'),deviceId:deviceIdFor(publicKeyB64)};};
const dial=(port:number,identity?:{privateKeyPem?:string;keyPem?:string;certPem:string})=>new Promise<TLSSocket>((resolve,reject)=>{const c=connect({port,host:'127.0.0.1',...(identity?{key:identity.privateKeyPem??identity.keyPem,cert:identity.certPem}:{}),minVersion:'TLSv1.3',rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);});
const readFrames=(socket:TLSSocket)=>{const parts:string[]=[];socket.on('data',(chunk:Buffer)=>parts.push(String(chunk)));return {text:()=>parts.join(''),frames:()=>parts.join('').split('\n').filter(Boolean).map(line=>JSON.parse(line)as Record<string,any>)};};
const randomExponent=()=>BigInt('0x'+randomBytes(32).toString('hex'));
// A raw SRP client that can hold its confirmation: it starts a session and computes a valid confirmation for a given code on demand.
const rawSession=async(port:number,name:string)=>{
 const identity=rawIdentity(),socket=await dial(port,identity),frames=readFrames(socket);
 const claim={deviceId:identity.deviceId,publicKey:identity.publicKeyB64,name,agentName:name},exponent=randomExponent(),aPub=srpClientPublic(SRP_GROUP,exponent);
 socket.write(JSON.stringify({kind:'pair-client',peer:claim,supported:{min:1,max:1},A:bigB64(aPub)})+'\n');
 const reply=(await wait(frames.frames,list=>list.some(message=>message.kind==='pair-server'))).find(message=>message.kind==='pair-server')!;
 const derive=(code:string)=>{const salt=Buffer.from(reply.salt,'base64'),b=BigInt('0x'+Buffer.from(reply.B,'base64').toString('hex'));const x=srpX(SRP_GROUP,salt,`massion-pair:${code}`),u=srpU(SRP_GROUP,aPub,b);return {premaster:srpClientSecret(SRP_GROUP,b,x,exponent,u),host:reply.peer};};
 return {socket,frames,confirm:(code:string)=>{
  const salt=Buffer.from(reply.salt,'base64'),b=BigInt('0x'+Buffer.from(reply.B,'base64').toString('hex'));
  const x=srpX(SRP_GROUP,salt,`massion-pair:${code}`),u=srpU(SRP_GROUP,aPub,b);
  return pairingConfirmations(srpClientSecret(SRP_GROUP,b,x,exponent,u),claim,reply.peer,{min:1,max:1},reply.supported).client;
 },confirmWithoutKeys:(code:string)=>{
  const {premaster,host}=derive(code);
  // What the confirmation would be if the transcript bound everything except the two peer public keys.
  const transcript=JSON.stringify(['massion-pair v1',claim.deviceId,claim.name,claim.agentName,host.deviceId,host.name,host.agentName,1,1,reply.supported.min,reply.supported.max]);
  const key=Buffer.from(hkdfSync('sha256',Buffer.from(premaster.toString(16).padStart(SRP_GROUP.prime.length*2,'0'),'hex'),Buffer.from('massion-pair v1'),Buffer.from(transcript),32));
  return createHmac('sha256',key).update('client').digest().toString('base64');
 }};
};
const bigHex=(value:bigint,length:number)=>value.toString(16).toUpperCase().padStart(length*2,'0');
const bigB64=(value:bigint)=>{let hex=value.toString(16);if(hex.length%2)hex='0'+hex;return Buffer.from(hex,'hex').toString('base64');};
const bigPaddedB64=(value:bigint)=>Buffer.from(value.toString(16).padStart(SRP_GROUP.prime.length*2,'0'),'hex').toString('base64');
// A rogue host for the initiator's aborts: it sends the given server value and answers a confirmation as a host answers a wrong code, so an initiator that goes past the abort returns at once instead of waiting out the exchange.
// rejectUnauthorized stays false: the server default is true, which rejects the self-signed client certificate and closes the socket before any frame is exchanged.
const rogueHost=async(serverValue:bigint,confirmations:string[])=>{
 const identity=rawIdentity();
 return await rawServer({key:identity.privateKeyPem,cert:identity.certPem,requestCert:true,rejectUnauthorized:false},socket=>{
  let buffer='';
  socket.on('data',(chunk:Buffer)=>{
   buffer+=chunk.toString();
   for(let index;(index=buffer.indexOf('\n'))>=0;){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
    let message:Record<string,any>;try{message=JSON.parse(line);}catch{continue;}
    if(message.kind==='pair-client')socket.write(JSON.stringify({kind:'pair-server',salt:randomBytes(16).toString('base64'),B:bigB64(serverValue),peer:{deviceId:identity.deviceId,publicKey:identity.publicKeyB64,name:'Rogue',agentName:'Rogue'},supported:{min:1,max:1}})+'\n');
    if(message.kind==='pair-confirm'){confirmations.push(String(message.confirm));socket.write(JSON.stringify({kind:'pair-failed',reason:'code',attemptsLeft:1})+'\n');}
   }
  });
 });
};
const identityFromSecrets=async(secrets:InMemorySecretSlots)=>{const stored=await secrets.read({owner:'device-link',slot:'device-identity'});const key=createPrivateKey({key:Buffer.from(stored!,'base64'),format:'der',type:'pkcs8'});const spki=createPublicKey(key).export({type:'spki',format:'der'}) as Buffer,publicKeyB64=spki.toString('base64');return {keyPem:key.export({type:'pkcs8',format:'pem'}).toString(),certPem:selfSignedDeviceCertificate(key,deviceIdFor(publicKeyB64)),deviceId:deviceIdFor(publicKeyB64)};};
const observations=(core:Core,deviceId:string)=>core.store.inspect().filter(operation=>(operation.events[0] as {command:{action?:string;deviceId?:string}}).command?.action==='connection-observed'&&(operation.events[0] as {command:{deviceId?:string}}).command?.deviceId===deviceId).length;
const seedPeer=async(store:ReturnType<typeof makeStore>,deviceId:string,address:string,publicKey='A'.repeat(64))=>{const command={type:'link-observe' as const,action:'peer-added' as const,peer:{deviceId,publicKey,name:'Seeded',agentName:'Seeded',grants:{view:true,instruct:true,answerApprovals:true},addresses:[address],pairedAt:Date.now()}};await store.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:0,value:{kind:'device-link',id:DEVICE_LINK_ID,peers:[command.peer],offers:[]},events:[{type:command.type,actor:'device-link',command}],outbox:[]});};

// RFC 5054 appendix B: 1024-bit group (generator 2), SHA-1, user "alice" with "password123".
const RFC_N='EEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE48E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B297BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9AFD5138FE8376435B9FC61D2FC0EB06E3';
const RFC_V='7E273DE8696FFC4F4E337D05B4B375BEB0DDE1569E8FA00A9886D8129BADA1F1822223CA1A605B530E379BA4729FDC59F105B4787E5186F5C671085A1447B52A48CF1970B4FB6F8400BBF4CEBFBB168152E08AB5EA53D15C1AFF87B2B9DA6E04E058AD51CC72BFC9033B564E26480D78E955A5E29E7AB245DB2BE315E2099AFB';
const RFC_A='61D5E490F6F1B79547B0704C436F523DD0E560F0C64115BB72557EC44352E8903211C04692272D8B2D1A5358A2CF1B6E0BFCF99F921530EC8E39356179EAE45E42BA92AEACED825171E1E8B9AF6D9C03E1327F44BE087EF06530E69F66615261EEF54073CA11CF5858F0EDFDFE15EFEAB349EF5D76988A3672FAC47B0769447B';
const RFC_B='BD0C61512C692C0CB6D041FA01BB152D4916A1E77AF46AE105393011BAF38964DC46A0670DD125B95A981652236F99D9B681CBF87837EC996C6DA04453728610D0C6DDB58B318885D7D82C7F8DEB75CE7BD4FBAA37089E6F9C6059F388838E7A00030B331EB76840910440B1B27AAEAEEB4012B7D7665238A8E3FB004B117B58';
const RFC_S='B0DC82BABCF30674AE450C0287745E7990A3381F63B387AAF271A10D233861E359B48220F7C4693C9AE12B0A6F67809F0876E2D013800D6C41BB59B6D5979B5C00A172B4A2A5903A0BDCAF8A709585EB2AFAFA8F3499B200210DCC1F10EB33943CD67FC88A2F39A4BE5BEC4EC0A3212DC346D7E474B29EDE8A469FFECA686E5A';

test('the RFC 5054 appendix B vectors reproduce through the SRP code path',()=>{
 const group={prime:Buffer.from(RFC_N,'hex'),generator:Buffer.from([2]),hash:'sha1'},salt=Buffer.from('BEB25379D1A8581EB5A727673A2441EE','hex');
 const a=BigInt('0x60975527035CF2AD1989806F0407210BC81EDC04E2762A56AFD529DDDA2D4393'),b=BigInt('0xE487CB59D31AC550471E81F00F6928E01DDA08E974A004F49E61F5D105284D20');
 const k=srpK(group),x=srpX(group,salt,'alice:password123'),v=srpVerifier(group,salt,'alice:password123');
 const aPub=srpClientPublic(group,a),bPub=srpServerPublic(group,v,b),u=srpU(group,aPub,bPub);
 const client=srpClientSecret(group,bPub,x,a,u),server=srpServerSecret(group,aPub,x,u,b);
 assert.equal(bigHex(k,20),'7556AA045AEF2CDD07ABAF0F665C3E818913186F');
 assert.equal(bigHex(x,20),'94B7555AABE9127CC58CCF4993DB6CF84D16C124');
 assert.equal(bigHex(v,128),RFC_V);
 assert.equal(bigHex(aPub,128),RFC_A);
 assert.equal(bigHex(bPub,128),RFC_B);
 assert.equal(bigHex(u,20),'CE38B9593487DA98554ED47D70A7AE5F462EF019');
 assert.equal(bigHex(client,128),RFC_S);
 assert.equal(client===server,true,'both sides derive the same premaster secret');
});

test('the pairing window transition table covers every state and event',()=>{
 const states:Record<PairingPhase,PairingWindowState>={
  none:{phase:'none',expiresAt:0,wrong:0},
  open:{phase:'open',expiresAt:1000,wrong:0},
  accepting:{phase:'accepting',expiresAt:1000,wrong:0},
  committing:{phase:'committing',expiresAt:1000,wrong:0},
  unknown:{phase:'unknown',expiresAt:1000,wrong:0},
  paired:{phase:'paired',expiresAt:1000,wrong:0},
  closed:{phase:'closed',expiresAt:1000,wrong:0},
  expired:{phase:'expired',expiresAt:1000,wrong:0},
  exhausted:{phase:'exhausted',expiresAt:1000,wrong:5},
  replaced:{phase:'replaced',expiresAt:1000,wrong:0},
 };
 const events:PairingEvent[]=[
  {type:'open-requested',expiresAt:2000},
  {type:'replace-requested'},
  {type:'confirmation-accepted'},
  {type:'wrong-confirmation'},
  {type:'store-read-finished',now:500},
  {type:'expiry-reached'},
  {type:'close-requested'},
  {type:'write-issued'},
  {type:'write-fulfilled'},
  {type:'write-rejected'},
  {type:'write-refused'},
  {type:'commit-deadline-passed'},
  {type:'committed-state-read',devicePresent:true},
  {type:'host-restarted'},
 ];
 const E=(phase:PairingPhase,...kinds:PairingEffect['kind'][])=>({phase,kinds});
 const dead=(phase:PairingPhase)=>({
  'open-requested':E('open','open-window'),'replace-requested':E(phase),'confirmation-accepted':E(phase,'answer-code-ended'),
  'wrong-confirmation':E(phase),'store-read-finished':E(phase),'expiry-reached':E(phase),'close-requested':E(phase),
  'write-issued':E(phase),'write-fulfilled':E(phase),'write-rejected':E(phase),'write-refused':E(phase),'commit-deadline-passed':E(phase),
  'committed-state-read':E(phase),'host-restarted':E('none'),
 });
 const expected:Record<PairingPhase,Partial<Record<PairingEvent['type'],{phase:PairingPhase;kinds:PairingEffect['kind'][]}>>>={
  none:{
   'open-requested':E('open','open-window'),'replace-requested':E('none'),'confirmation-accepted':E('none','answer-code-ended'),
   'wrong-confirmation':E('none'),'store-read-finished':E('none'),'expiry-reached':E('none'),'close-requested':E('none'),
   'write-issued':E('none'),'write-fulfilled':E('none'),'write-rejected':E('none'),'write-refused':E('none'),'commit-deadline-passed':E('none'),
   'committed-state-read':E('none'),'host-restarted':E('none'),
  },
  open:{
   'open-requested':E('open'),'replace-requested':E('replaced','end-window'),'confirmation-accepted':E('accepting','accept-session'),
   'wrong-confirmation':E('open','answer-wrong'),'store-read-finished':E('open'),'expiry-reached':E('expired','end-window'),
   'close-requested':E('closed','end-window'),'write-issued':E('open'),'write-fulfilled':E('open'),'write-rejected':E('open'),'write-refused':E('open'),
   'commit-deadline-passed':E('open'),'committed-state-read':E('open'),'host-restarted':E('none'),
  },
  accepting:{
   'open-requested':E('accepting','wait-section-bounded'),'replace-requested':E('accepting','wait-section-bounded'),
   'confirmation-accepted':E('accepting','answer-code-ended'),'wrong-confirmation':E('accepting','answer-code-ended'),
   'store-read-finished':E('committing','issue-write'),'expiry-reached':E('expired','end-window'),
   'close-requested':E('accepting','wait-section-bounded'),'write-issued':E('accepting'),'write-fulfilled':E('accepting'),
   'write-rejected':E('none','end-window','answer-code-ended'),'write-refused':E('none','end-window','answer-code-ended'),'commit-deadline-passed':E('none','end-window'),'committed-state-read':E('accepting'),
   'host-restarted':E('none'),
  },
  committing:{
   'open-requested':E('committing','wait-section-bounded'),'replace-requested':E('committing','wait-section-bounded'),
   'confirmation-accepted':E('committing','answer-code-ended'),'wrong-confirmation':E('committing','answer-code-ended'),
   'store-read-finished':E('committing','issue-write'),'expiry-reached':E('committing'),
   'close-requested':E('committing','wait-section-bounded'),'write-issued':E('committing'),'write-fulfilled':E('paired','answer-paired'),
   'write-rejected':E('none','end-window','answer-code-ended'),'write-refused':E('none','end-window','answer-code-ended'),'commit-deadline-passed':E('unknown','record-unknown','end-window'),
   'committed-state-read':E('committing'),'host-restarted':E('none'),
  },
  unknown:{
   'open-requested':E('unknown','refuse-typed-error'),'replace-requested':E('unknown','refuse-typed-error'),
   'confirmation-accepted':E('unknown','answer-code-ended'),'wrong-confirmation':E('unknown','answer-code-ended'),
   'store-read-finished':E('unknown'),'expiry-reached':E('unknown'),'close-requested':E('unknown'),
   'write-issued':E('unknown'),'write-fulfilled':E('paired','resolve-unknown'),'write-rejected':E('none','resolve-unknown'),'write-refused':E('none','resolve-unknown'),
   'commit-deadline-passed':E('unknown'),'committed-state-read':E('paired','resolve-unknown'),'host-restarted':E('none'),
  },
  paired:{...dead('paired'),'replace-requested':E('paired','end-window')},closed:dead('closed'),expired:dead('expired'),exhausted:dead('exhausted'),replaced:dead('replaced'),
 };
 for(const phase of Object.keys(states) as PairingPhase[])for(const event of events){
  const cell=expected[phase]![event.type];
  assert.ok(cell,`missing expectation for ${phase} x ${event.type}`);
  const decision=nextPairingWindow(structuredClone(states[phase]!),event);
  assert.equal(decision.state.phase,cell.phase,`${phase} x ${event.type} next phase`);
  assert.deepEqual(decision.effects.map(effect=>effect.kind),cell.kinds,`${phase} x ${event.type} effects`);
 }
 // Variant cells the grid cannot show: the clock and counters inside the events.
 const late=nextPairingWindow(states.accepting!,{type:'store-read-finished',now:1000});
 assert.equal(late.state.phase,'expired');assert.deepEqual(late.effects.map(e=>e.kind),['end-window','answer-code-ended']);
 const lateRetry=nextPairingWindow(states.committing!,{type:'store-read-finished',now:1000});
 assert.equal(lateRetry.state.phase,'expired');assert.deepEqual(lateRetry.effects.map(e=>e.kind),['end-window','answer-code-ended']);
 const refused=nextPairingWindow(states.committing!,{type:'write-refused'});
 assert.deepEqual(refused.effects,[{kind:'end-window',sync:false},{kind:'answer-code-ended'}]);
 const counted=nextPairingWindow({...states.open!,wrong:4},{type:'wrong-confirmation'});
 assert.equal(counted.state.phase,'exhausted');assert.deepEqual(counted.effects.map(e=>e.kind),['end-window']);
 const answer=nextPairingWindow({...states.open!,wrong:3},{type:'wrong-confirmation'});
 assert.equal(answer.state.wrong,4);assert.deepEqual(answer.effects,[{kind:'answer-wrong',attemptsLeft:1}]);
 const readPresent=nextPairingWindow(states.unknown!,{type:'committed-state-read',devicePresent:false});
 assert.equal(readPresent.state.phase,'none');assert.deepEqual(readPresent.effects,[{kind:'resolve-unknown',landed:false}]);
 const fulfilUnknown=nextPairingWindow(states.unknown!,{type:'write-fulfilled'});
 assert.equal(fulfilUnknown.state.phase,'paired');assert.deepEqual(fulfilUnknown.effects,[{kind:'resolve-unknown',landed:true}]);
});

test('aggregate readback resolves only a settled pairing outcome',()=>{
 const state:PairingWindowState={phase:'unknown',expiresAt:1000,wrong:0};
 const rows=[[false,'none'],[true,'paired']] as const;
 for(const [devicePresent,expected] of rows){
  const result=nextPairingWindow(state,{type:'committed-state-read',devicePresent});
  assert.equal(result.state.phase,expected,String(devicePresent));
  assert.deepEqual(result.effects,[{kind:'resolve-unknown',landed:devicePresent}]);
 }
});


test('the self-signed certificate assembles DER that Node parses, verifies and handshakes',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),spki=publicKey.export({type:'spki',format:'der'}) as Buffer,deviceId=deviceIdFor(spki.toString('base64'));
 const cert=new X509Certificate(selfSignedDeviceCertificate(privateKey,deviceId));
 assert.equal(cert.subject,`CN=${deviceId}`);
 assert.deepEqual((cert.publicKey.export({type:'spki',format:'der'}) as Buffer).equals(spki),true);
 assert.equal(cert.verify(publicKey),true);
 assert.ok(cert.validToDate.getTime()>Date.now());
 const client=rawIdentity(),serverIdentity=rawIdentity();
 const stub=await rawServer({key:serverIdentity.privateKeyPem,cert:serverIdentity.certPem,requestCert:true},socket=>socket.end());
 try{
  const socket:TLSSocket=await new Promise((resolve,reject)=>{const c=connect({port:(stub.server.address() as {port:number}).port,host:'127.0.0.1',key:client.privateKeyPem,cert:client.certPem,rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);});
  const peerCert=new X509Certificate(socket.getPeerCertificate().raw);
  assert.equal(peerCert.subject,`CN=${serverIdentity.deviceId}`);
  assert.equal(peerCert.verify(createPublicKey({key:Buffer.from(serverIdentity.publicKeyB64,'base64'),format:'der',type:'spki'})),true);
  socket.destroy();
 }finally{await stub.close();}
});

test('the device certificate for a fixed key, device id and clock keeps the exact bytes origin/main produced',()=>{
 const key=createPrivateKey(`-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg2M4FGhX5M6zgz2bi
6865wrh+jBCMhtvvFOdDFqoZMoahRANCAASYHSGMcERjrkFp7E5MLvnjdWuuK4Fn
3ngPIV6yX0YQD63Ms7Ww7okqPPHMLhic57yzyUrfAEHKQI6xLgtdask3
-----END PRIVATE KEY-----`);
 // Node's ECDSA signature is randomized per call, so the pin covers the tbsCertificate and the
 // signatureAlgorithm — every byte the DER writers emit — captured at origin/main (cf96cad).
 const pinnedHex=(certificate:string)=>{
  const raw=new X509Certificate(certificate).raw;
  const contentStart=(at:number)=>{const length=raw[at+1]!,size=length&0x80?length&0x7f:0;return size?at+2+size:at+2;};
  const elementEnd=(at:number)=>{const length=raw[at+1]!,size=length&0x80?length&0x7f:0;if(!size)return at+2+length;let total=0;for(let index=0;index<size;index++)total=total*256+raw[at+2+index]!;return at+2+size+total;};
  const tbs=contentStart(0),signatureAlgorithm=elementEnd(tbs),bitString=elementEnd(signatureAlgorithm);
  return raw.subarray(tbs,bitString).toString('hex');
 };
 assert.equal(pinnedHex(selfSignedDeviceCertificate(key,'pin-device',()=>1794916800000)),'3081cfa003020102021100fdd18e832b9f793c245fe91292f1a344300a06082a8648ce3d04030230153113301106035504030c0a70696e2d6465766963653020170d3236313131363132303030305a180f32313236313132313036343030305a30153113301106035504030c0a70696e2d6465766963653059301306072a8648ce3d020106082a8648ce3d03010703420004981d218c704463ae4169ec4e4c2ef9e3756bae2b8167de780f215eb25f46100fadccb3b5b0ee892a3cf1cc2e189ce7bcb3c94adf0041ca408eb12e0b5d6ac937300a06082a8648ce3d040302');
 assert.equal(pinnedHex(selfSignedDeviceCertificate(key,'pin-device',()=>2566512000000)),'3081d1a003020102021100fdd18e832b9f793c245fe91292f1a344300a06082a8648ce3d04030230153113301106035504030c0a70696e2d6465766963653022180f32303531303433303030303030305a180f32313531303530343138343030305a30153113301106035504030c0a70696e2d6465766963653059301306072a8648ce3d020106082a8648ce3d03010703420004981d218c704463ae4169ec4e4c2ef9e3756bae2b8167de780f215eb25f46100fadccb3b5b0ee892a3cf1cc2e189ce7bcb3c94adf0041ca408eb12e0b5d6ac937300a06082a8648ce3d040302');
});

test('two services pair with the right code and then link over pinned mutual TLS',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  assert.match(window.code!,/^[0-9]{6}$/);
  assert.equal(window.expiresAt>Date.now(),true);
  assert.match(window.address,/127\.0\.0\.1:[0-9]+/);
  assert.equal((await a.service.read()).pairing!.attemptsLeft,5);
  const outcome=await pairFrom(b,window.address,window.code!);
  assert.equal(outcome.status,'paired');
  assert.equal((await a.service.read()).pairing,null,'a successful pairing closes the window');
  const aView=await a.service.read(),bView=await b.service.read();
  assert.equal(aView.peers.length,1);assert.equal(aView.peers[0]!.name,'Laptop');assert.equal(aView.peers[0]!.grants.instruct,true,'the three grants are on by default');
  assert.equal(bView.peers.length,1);assert.equal(bView.peers[0]!.name,aView.identity.name);assert.equal(bView.peers[0]!.addresses[0],window.address);
  const deviceId=bView.peers[0]!.deviceId;
  const connected=await b.service.connect({commandId:`link-${++sequence}`,deviceId});
  assert.equal(connected.status,'connected');
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='connected');
  await assertWindowConsistency(a.service,a.store);
  validateMissionJournalLineage(a.store.inspect());validateMissionJournalLineage(b.store.inspect());
 }finally{await drain(a,b);}
});

test('a wrong code reports the remaining attempts and five wrong codes end the window',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  for(let index=4;index>=1;index--){
   const wrong=await pairFrom(b,window.address,'000000');
   assert.equal(wrong.status,'wrong-code');
   assert.equal(wrong.attemptsLeft,index);
  }
  assert.equal((await pairFrom(b,window.address,'000000')).status,'code-ended','the fifth wrong confirmation reads as an ended code, not a wrong code with zero attempts left');
  assert.equal((await a.service.read()).pairing,null,'the exhausted window is closed');
  const ended=await pairFrom(b,window.address,window.code!);
  assert.equal(ended.status,'code-ended','the right code no longer answers after five wrong confirmations');
  await assertWindowConsistency(a.service,a.store);
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('an expired code is refused like an ended one',async()=>{
 let now=Date.now();const a=await core(()=>now),b=await core();
 try{
  const window=await openWindow(a);
  now+=3e5+1000;
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'code-ended');
  await assertWindowConsistency(a.service,a.store,()=>now);
 }finally{await drain(a,b);}
});

test('a pairing request with no open window gets no answer',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const stored=(await b.service.read()).peers[0]!.addresses[0]!;
  assert.equal((await pairFrom(b,stored,'123456')).status,'code-ended');
  const port=Number(stored.split(':')[1]);
  const stranger=rawIdentity(),socket=await dial(port,stranger),frames=readFrames(socket);
  socket.write(JSON.stringify({kind:'pair-client',peer:{deviceId:stranger.deviceId,publicKey:stranger.publicKeyB64,name:'Stranger',agentName:'Stranger'},supported:{min:1,max:1},A:bigB64(srpClientPublic(SRP_GROUP,randomExponent()))})+'\n');
  await wait(()=>Promise.resolve(socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(socket.destroyed,'the socket is closed');
  assert.ok(!frames.text().includes('pair-server'),'no pairing material is disclosed');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('a self-consistent man in the middle fails at the confirmation comparison',async()=>{
 const a=await core(),b=await core(),relayIdentity=rawIdentity();
 try{
  const window=await openWindow(a),hostPort=Number(window.address.split(':')[1]);
  const relayClaim={deviceId:relayIdentity.deviceId,publicKey:relayIdentity.publicKeyB64,name:'Relay',agentName:'Relay'};
  // The relay presents its own certificate AND its own key in the identity frames of each leg, relaying every SRP value unchanged, so both early key checks pass.
  const pipe=(from:TLSSocket,to:TLSSocket,rewrite:(frame:any)=>any)=>{let buffer='';from.on('data',(chunk:Buffer)=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;try{to.write(JSON.stringify(rewrite(JSON.parse(line)))+'\n');}catch{to.write(line+'\n');}}});};
  const relay=await rawServer({key:relayIdentity.privateKeyPem,cert:relayIdentity.certPem,requestCert:true,rejectUnauthorized:false},client=>{
   const upstream=connect({host:'127.0.0.1',port:hostPort,key:relayIdentity.privateKeyPem,cert:relayIdentity.certPem,minVersion:'TLSv1.3',rejectUnauthorized:false});
   pipe(client,upstream,frame=>frame.kind==='pair-client'?{...frame,peer:relayClaim}:frame);
   pipe(upstream,client,frame=>frame.kind==='pair-server'?{...frame,peer:{deviceId:relayIdentity.deviceId,publicKey:relayIdentity.publicKeyB64,name:frame.peer.name,agentName:frame.peer.agentName}}:frame);
   client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
  });
  try{
   const port=(relay.server.address() as {port:number}).port;
   const outcome=await pairFrom(b,`127.0.0.1:${port}`,window.code!);
   assert.equal(outcome.status,'wrong-code','both early key checks pass and the host rejects the relayed confirmation itself');
   assert.equal(outcome.attemptsLeft,4,'the mismatch is counted at the confirmation comparison, the only path that spends an attempt');
   assert.equal((await a.service.read()).peers.length,0);
   assert.equal((await b.service.read()).peers.length,0);
  }finally{await relay.close();}
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('a confirmation over a transcript without the peer keys is rejected',async()=>{
 const a=await core();
 try{
  const window=await openWindow(a),session=await rawSession(Number(window.address.split(':')[1]),'Unbound');
  session.socket.write(JSON.stringify({kind:'pair-confirm',confirm:session.confirmWithoutKeys(window.code!)})+'\n');
  const reply=(await wait(session.frames.frames,list=>list.some(message=>message.kind==='pair-failed'))).find(message=>message.kind==='pair-failed');
  assert.ok(reply,'the host rejects a confirmation whose transcript omits the peer keys');
  assert.equal(reply.attemptsLeft,4,'the rejection happens at the confirmation comparison');
  assert.equal((await a.service.read()).peers.length,0,'an unbound confirmation never pairs');
  session.socket.destroy();
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a);}
});

test('the code, the verifier and the premaster secret never reach the store or a thrown message',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  assert.equal((await pairFrom(b,window.address,'000000')).status,'wrong-code');
  const conflictId='pair-conflict';
  await b.service.pair({commandId:conflictId,address:window.address,code:'000000',name:'Laptop',agentName:'Claude Code'});
  // A raw client with the right code derives the real session premaster but never confirms.
  const guesser=rawIdentity(),port=Number(window.address.split(':')[1]);
  const socket=await dial(port,guesser),frames=readFrames(socket);
  const exponent=randomExponent(),aPub=srpClientPublic(SRP_GROUP,exponent);
  socket.write(JSON.stringify({kind:'pair-client',peer:{deviceId:guesser.deviceId,publicKey:guesser.publicKeyB64,name:'Guesser',agentName:'Guesser'},supported:{min:1,max:1},A:bigB64(aPub)})+'\n');
  const reply=(await wait(frames.frames,list=>list.some(message=>message.kind==='pair-server'))).find(message=>message.kind==='pair-server')!;
  const salt=Buffer.from(reply.salt,'base64'),bBig=BigInt('0x'+Buffer.from(reply.B,'base64').toString('hex'));
  const secret=`massion-pair:${window.code}`;
  const x=srpX(SRP_GROUP,salt,secret),u=srpU(SRP_GROUP,aPub,bBig);
  const premaster=srpClientSecret(SRP_GROUP,bBig,x,exponent,u),verifier=srpVerifier(SRP_GROUP,salt,secret);
  socket.destroy();
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'paired');
  const thrown=await b.service.pair({commandId:conflictId,address:window.address,code:'000000',name:'Renamed',agentName:'Claude Code'}).then(()=>null,error=>error as Error);
  assert.ok(thrown instanceof Error&&/conflict/i.test(thrown.message),'a changed payload under the same command identity is refused');
  assert.ok(!thrown!.message.includes(window.code!),'a thrown message never carries the code');
  for(const target of [a,b]){
   const operations=target.store.inspect();
   const serialized=JSON.stringify(operations),strings:string[]=[];
   const walk=(value:unknown)=>{if(typeof value==='string')strings.push(value);else if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')Object.values(value).forEach(walk);};
   walk(operations);
   assert.ok(strings.every(text=>!text.includes(window.code!)),'the pairing code never appears as a stored string');
   for(const value of [premaster,verifier])for(const form of [bigB64(value),bigPaddedB64(value)])assert.ok(!serialized.includes(form),'SRP secrets never reach the journal');
  }
  validateMissionJournalLineage(a.store.inspect());
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('A = 0, A = N and B = 0 are refused',async()=>{
 // A short pairing TTL bounds each exchange of the initiator under test, so a missing abort can only show as an assertion failure, never as a wait.
 const a=await core(),b=await core(Date.now,{pairingTtlMs:2000}),confirmations:string[]=[];
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  for(const value of [0n,BigInt('0x'+SRP_GROUP.prime.toString('hex'))]){
   const attacker=rawIdentity(),socket=await dial(port,attacker),frames=readFrames(socket);
   socket.write(JSON.stringify({kind:'pair-client',peer:{deviceId:attacker.deviceId,publicKey:attacker.publicKeyB64,name:'Attacker',agentName:'Attacker'},supported:{min:1,max:1},A:bigB64(value)})+'\n');
   await wait(()=>Promise.resolve(socket.destroyed),destroyed=>destroyed,2000);
   assert.ok(socket.destroyed);assert.ok(!frames.text().includes('pair-server'));
  }
  const stub=await rogueHost(0n,confirmations);
  try{
   const stubPort=(stub.server.address() as {port:number}).port;
   const outcome=await pairFrom(b,`127.0.0.1:${stubPort}`,'123456');
   assert.equal(outcome.status,'code-ended','a zero server value aborts the client exchange');
   assert.deepEqual(confirmations,[],'the initiator sends no confirmation for a zero server value');
   assert.equal((await b.service.read()).peers.length,0);
  }finally{await stub.close();}
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('B = N is refused before the initiator sends a confirmation',async()=>{
 // A short pairing TTL bounds each exchange, so a missing abort can only show as an assertion failure, never as a wait.
 const b=await core(Date.now,{pairingTtlMs:2000}),confirmations:string[]=[];
 const stub=await rogueHost(BigInt('0x'+SRP_GROUP.prime.toString('hex')),confirmations);
 try{
  const port=(stub.server.address() as {port:number}).port;
  const outcome=await pairFrom(b,`127.0.0.1:${port}`,'123456');
  assert.equal(outcome.status,'code-ended','a server value equal to the prime ends the attempt');
  assert.deepEqual(confirmations,[],'the initiator sends no confirmation for a server value equal to the prime');
  assert.equal((await b.service.read()).peers.length,0);
 }finally{await stub.close();await drain(b);}
});

test('a second pairing attempt on one socket is refused',async()=>{
 const a=await core();
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  const attacker=rawIdentity(),socket=await dial(port,attacker),frames=readFrames(socket);
  const claim={deviceId:attacker.deviceId,publicKey:attacker.publicKeyB64,name:'Attacker',agentName:'Attacker'},frame=JSON.stringify({kind:'pair-client',peer:claim,supported:{min:1,max:1},A:bigB64(srpClientPublic(SRP_GROUP,randomExponent()))})+'\n';
  socket.write(frame);
  await wait(frames.frames,list=>list.some(message=>message.kind==='pair-server'));
  socket.write(frame);
  await wait(()=>Promise.resolve(socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(socket.destroyed,'one guess per socket');
  assert.equal(frames.frames().filter(message=>message.kind==='pair-server').length,1,'the second attempt is never answered');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a);}
});

test('opening a window replaces the previous one and closing ends it',async()=>{
 const a=await core(),b=await core();
 try{
  const first=await openWindow(a),second=await openWindow(a);
  assert.notEqual(first.code,second.code);
  assert.equal((await pairFrom(b,second.address,second.code!)).status,'paired');
  const third=await openWindow(a);
  await a.service.closePairing({commandId:`close-${++sequence}`});
  assert.equal((await pairFrom(b,third.address,third.code!)).status,'code-ended','a closed window no longer answers');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('a restart ends a live pairing window',async()=>{
 const a=await core(),b=await core();
 let a2:DeviceLinkService|undefined;
 try{
  const window=await openWindow(a);
  await a.service.drain();
  a2=new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  const outcome=await pairFrom(b,window.address,window.code!);
  assert.equal(outcome.status,'could-not-connect','the window, being memory only, cannot survive a restart');
  await assertWindowConsistency(a2,a.store);
  await a2.drain();
 }finally{await drain(b);}
});

test('journals from the offer era replay and no offer events are ever written',async()=>{
 const store=makeStore(),now=Date.parse('2026-11-15T00:00:00Z');
 const offerCommand={type:'link-owner' as const,action:'create-offer' as const,offerId:'legacy-1',codeHash:'ab'.repeat(32),grants:{view:true,instruct:true,answerApprovals:true},addresses:[],name:'Workshop',created:now,expiresAt:now+3e5};
 const legacyOffer={id:'legacy-1',codeHash:'ab'.repeat(32),grants:{view:true,instruct:true,answerApprovals:true},addresses:[],name:'Workshop',created:now,expiresAt:now+3e5,used:false,wrongCodes:0};
 await store.commit({id:DEVICE_LINK_ID,commandId:'legacy-1',fingerprint:hash({actorId:'local-owner',command:offerCommand}),expectedRevision:0,value:{kind:'device-link',id:DEVICE_LINK_ID,peers:[],offers:[legacyOffer]},events:[{type:'link-owner',actor:'local-owner',command:offerCommand}],outbox:[]});
 const rejectCommand={type:'link-observe' as const,action:'code-rejected' as const,offerId:'legacy-1',attempt:1};
 await store.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(rejectCommand).slice(0,32),fingerprint:hash({actorId:'device-link',command:rejectCommand}),expectedRevision:1,value:{kind:'device-link',id:DEVICE_LINK_ID,peers:[],offers:[{...legacyOffer,wrongCodes:1}]},events:[{type:'link-observe',actor:'device-link',command:rejectCommand}],outbox:[]});
 const legacyPeer={deviceId:'device-legacy',publicKey:'A'.repeat(64),name:'Laptop',agentName:'Laptop',addresses:[],grants:{view:true,instruct:true,answerApprovals:true},pairedAt:now};
 const completeCommand={type:'link-observe' as const,action:'pairing-completed' as const,peer:legacyPeer,offerId:'legacy-1'};
 await store.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(completeCommand).slice(0,32),fingerprint:hash({actorId:'device-link',command:completeCommand}),expectedRevision:2,value:{kind:'device-link',id:DEVICE_LINK_ID,peers:[legacyPeer],offers:[{...legacyOffer,used:true,wrongCodes:1}]},events:[{type:'link-observe',actor:'device-link',command:completeCommand}],outbox:[]});
 validateMissionJournalLineage(store.inspect());
 const secrets=new InMemorySecretSlots(),a:Core={store,secrets,service:new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})},b=await core();
 try{
  assert.equal((await a.service.read()).peers.length,1,'the legacy journal loads');
  const window=await openWindow(a);
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'paired');
  const legacyCount=store.inspect().filter(operation=>{const action=(operation.events[0] as {command:{action?:string}}).command?.action;return action==='create-offer'||action==='code-rejected'||action==='pairing-completed';}).length;
  assert.equal(legacyCount,3,'new operations never write offer events');
  validateMissionJournalLineage(store.inspect());
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('a repeated pairing command with a changed payload is refused',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a),commandId=`pair-${++sequence}`;
  await b.service.pair({commandId,address:window.address,code:'000000',name:'Laptop',agentName:'Claude Code'});
  await assert.rejects(b.service.pair({commandId,address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'}),/conflict/i,'a changed code under the same command identity is a conflict');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('a confirmation cannot complete after the window is closed or the budget is exhausted',async()=>{
 const a=await core(),b=await core();
 try{
  const closedWindow=await openWindow(a),held=await rawSession(Number(closedWindow.address.split(':')[1]),'Closer');
  await a.service.closePairing({commandId:'close-window'});
  held.socket.write(JSON.stringify({kind:'pair-confirm',confirm:held.confirm(closedWindow.code!)})+'\n');
  await wait(()=>Promise.resolve(held.socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(held.socket.destroyed,'closing the window ends every in-flight session of it');
  assert.ok(!held.frames.text().includes('pair-complete'),'a confirmation computed before the close never completes');
  assert.equal((await a.service.read()).peers.length,0);

  const exhaustedWindow=await openWindow(a),late=await rawSession(Number(exhaustedWindow.address.split(':')[1]),'Late');
  for(let index=0;index<4;index++)assert.equal((await pairFrom(b,exhaustedWindow.address,'000000')).status,'wrong-code');
  assert.equal((await pairFrom(b,exhaustedWindow.address,'000000')).status,'code-ended','the fifth wrong confirmation ends the window');
  late.socket.write(JSON.stringify({kind:'pair-confirm',confirm:late.confirm(exhaustedWindow.code!)})+'\n');
  await wait(()=>Promise.resolve(late.socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(late.socket.destroyed,'an exhausted window ends every in-flight session of it');
  assert.ok(!late.frames.text().includes('pair-complete'),'a confirmation after five wrong attempts never completes');
  assert.equal((await a.service.read()).peers.length,0);
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('a restart keeps the persisted listener port instead of the fixed default',async()=>{
 const a=await core(),b=await core();
 let a2:DeviceLinkService|undefined;
 try{
  const window=await link(a,b);
  await a.service.drain();
  a2=new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000});
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  const connected=await b.service.connect({commandId:'keep-port',deviceId});
  assert.equal(connected.status,'connected','the persisted port is rebound, not replaced by the default');
  assert.equal(connected.address,window.address);
 }finally{if(a2)await a2.drain();await drain(b);}
});

test('an unknown commit outcome stays unknown instead of ending the code',async()=>{
 const a=await core(),base=makeStore();
 const failing=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.events?.[0]?.command?.action==='peer-added'&&input.id===DEVICE_LINK_ID)throw new CommitOutcomeUnknownError(input);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
 const secrets=new InMemorySecretSlots();
 const b:Core={store:failing,secrets,service:new DeviceLinkService(failing,failing,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})};
 try{
  const window=await openWindow(a);
  await assert.rejects(b.service.pair({commandId:'p-unknown',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'}),error=>error instanceof CommitOutcomeUnknownError,'only SRP and network failures become code-ended');
  assert.equal((await b.service.read()).peers.length,1,'the peer is durably recorded; only the acknowledgement was lost');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('drain awaits an in-flight inbound pairing commit',async()=>{
 const base=makeStore();let arrived=false,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const guarded=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{if(!arrived&&input.events?.[0]?.command?.action==='peer-added'&&input.id===DEVICE_LINK_ID){arrived=true;await gate;}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
 const secrets=new InMemorySecretSlots();
 const a:Core={store:guarded,secrets,service:new DeviceLinkService(guarded,guarded,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})};
 const b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-drain',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>Promise.resolve(arrived),value=>value,8000);
  const draining=a.service.drain();
  assert.ok(await pending(draining),'drain waits for the in-flight pairing commit instead of returning early');
  release();
  await draining.catch(()=>{});
  assert.equal((await a.service.read()).peers.length,1,'the commit settles before drain reports completion');
  await assertWindowConsistency(a.service,a.store);
 }finally{release();await drain(a,b).catch(()=>{});}
});

test('a commit accepted before the close finishes and counts as paired before the close returns',async()=>{
 const base=makeStore();let arrived=false,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const guarded=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{if(!arrived&&input.events?.[0]?.command?.action==='peer-added'&&input.id===DEVICE_LINK_ID){arrived=true;await gate;}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
 const secrets=new InMemorySecretSlots();
 const a:Core={store:guarded,secrets,service:new DeviceLinkService(guarded,guarded,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})};
 const b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-close-race',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>Promise.resolve(arrived),value=>value,8000);
  const closing=a.service.closePairing({commandId:'close-race'});
  assert.ok(await pending(closing),'the close waits for the accepted commit instead of returning past it');
  release();
  await closing;
  assert.equal((await pairing).status,'paired','the commit that began before the close counts as paired');
  assert.equal((await a.service.read()).peers.length,1);
  assert.equal((await b.service.read()).peers.length,1);
  assert.equal((await a.service.read()).pairing,null);
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'code-ended','nothing can begin after the close');
  await assertWindowConsistency(a.service,a.store);
 }finally{release();await drain(a,b).catch(()=>{});}
});

test('review 2: a pairing write held until after expiry is refused',async()=>{
 let now=Date.now();const base=new InMemoryStore<any>(()=>new Date(now));let arrived=false,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const guarded=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{if(!arrived&&input.events?.[0]?.command?.action==='peer-added'&&input.id===DEVICE_LINK_ID){arrived=true;await gate;}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
 const secrets=new InMemorySecretSlots();
 const a:Core={store:guarded,secrets,service:new DeviceLinkService(guarded,guarded,secrets,{clock:()=>now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000,pairingTtlMs:60000})};
 const b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-expiry-race',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>Promise.resolve(arrived),value=>value,8000);
  now+=61000; // the window expires while the accepted commit is held, without waiting wall time
  release();
  assert.equal((await pairing).status,'code-ended');
  assert.equal((await a.service.read()).peers.length,0);
  assert.equal((await b.service.read()).peers.length,0);
  assert.equal((await a.service.read()).unknownPairingCommit,null);
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'code-ended','nothing can begin after the expiry');
  await assertWindowConsistency(a.service,a.store,()=>now);
 }finally{release();await drain(a,b).catch(()=>{});}
});

test('an unknown host commit outcome surfaces on shutdown instead of ending the code',async()=>{
 const a=await core(),base=makeStore();
 const failing=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.events?.[0]?.command?.action==='peer-added'&&input.id===DEVICE_LINK_ID)throw new CommitOutcomeUnknownError(input);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
 const secrets=new InMemorySecretSlots();
 const host:Core={store:failing,secrets,service:new DeviceLinkService(failing,failing,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})};
 const b=await core();
 try{
  const window=await openWindow(host);
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'code-ended','the client cannot know the outcome');
  assert.equal((await host.service.read()).peers.length,1,'the peer is durably recorded on the host');
  assert.match(String((await host.service.read()).unknownPairingCommit),/Commit outcome is unknown/i,'the owner-facing read shows the unknown outcome at once');
  await assertWindowConsistency(host.service,host.store);
  await assert.rejects(host.service.drain(),error=>error instanceof CommitOutcomeUnknownError,'the unknown outcome reaches the existing error path');
 }finally{await host.service.drain().catch(()=>{});await drain(b);}
});

test('the pre-authentication certificate carries only the device id and key, never a device name',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const port=Number((await b.service.read()).peers[0]!.addresses[0]!.split(':')[1]);
  const socket=await dial(port);
  const cert=new X509Certificate(socket.getPeerCertificate().raw);
  const identity=await a.service.read();
  assert.equal(cert.subject,`CN=${identity.identity.deviceId}`,'the subject is the device id alone');
  assert.equal(cert.subject.includes(hostname()),false,'no device name or other owner-identifying text');
  assert.equal(cert.issuer,`CN=${identity.identity.deviceId}`,'the issuer adds nothing either');
  socket.destroy();
 }finally{await drain(a,b);}
});

// A store whose state reads can be held once, on command, to stretch the commit preparation of a pairing confirmation.
const readGate=()=>{let arm=false,held=false,release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});const base=makeStore();const store=new Proxy(base,{get(target,key){if(key==='readState')return async(...args:Parameters<typeof target.readState>)=>{if(arm&&!held){held=true;await gate;}return target.readState(...args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;return {store,arm:()=>{arm=true;},held:()=>held,release};};

const gatedCore=(gate:ReturnType<typeof readGate>,extra:Partial<{pairingTtlMs:number;commitDeadlineMs:number}>={},clock:()=>number=Date.now)=>{const secrets=new InMemorySecretSlots();return {store:gate.store,secrets,service:new DeviceLinkService(gate.store,gate.store,secrets,{clock,bind:'127.0.0.1',port:0,connectTimeoutMs:1000,...extra})} as Core;};
// Deterministic settlement checks: flush the microtask queue instead of racing real timers.
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
const pending=async(promise:Promise<unknown>)=>{let done=false;promise.then(()=>{done=true;},()=>{done=true;});await flush();return !done;};

test('a store read held past the expiry time never starts a commit',async()=>{
 let now=Date.now();
 const gate=readGate(),a=gatedCore(gate,{pairingTtlMs:60000},()=>now),b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-read-expiry',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>a.service.read(),view=>view.incoming.length===1);
  gate.arm();
  await wait(()=>Promise.resolve(gate.held()),held=>held,8000);
  now+=61000; // the read is still held past the expiry time, without waiting wall time
  gate.release();
  assert.equal((await pairing).status,'code-ended','a confirmation whose preparation crossed the expiry is not accepted');
  assert.equal((await a.service.read()).peers.length,0,'no peer is persisted once the code has expired');
  assert.equal((await a.service.read()).pairing,null);
  await assertWindowConsistency(a.service,a.store,()=>now);
 }finally{gate.release();await drain(a,b).catch(()=>{});}
});

test('opening a new window waits for the old window critical section',async()=>{
 const gate=readGate(),a=gatedCore(gate),b=await core();
 try{
  const first=await openWindow(a);
  const stale=await rawSession(Number(first.address.split(':')[1]),'Stale'); // a session of the old window, confirmation not yet sent
  const pairing=b.service.pair({commandId:'p-replace-race',address:first.address,code:first.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>a.service.read(),view=>view.incoming.length===2);
  gate.arm();
  await wait(()=>Promise.resolve(gate.held()),held=>held,6000);
  const reopening=openWindow(a);
  assert.ok(await pending(reopening),'replacing the window waits for the old critical section');
  gate.release();
  const second=await reopening;
  assert.notEqual(second.code,first.code);
  assert.equal((await pairing).status,'paired','the commit that already began finishes before the new window is returned');
  assert.equal((await a.service.read()).peers.length,1);
  stale.socket.write(JSON.stringify({kind:'pair-confirm',confirm:stale.confirm(first.code!)})+'\n');
  await wait(()=>Promise.resolve(stale.socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(stale.socket.destroyed,'nothing of the old window can begin after the replacement');
  assert.equal((await a.service.read()).peers.length,1,'only the commit that began before the replacement persists');
  await assertWindowConsistency(a.service,a.store);
 }finally{gate.release();await drain(a,b).catch(()=>{});}
});

test('a store read held past a close keeps the close behind the accepted commit',async()=>{
 const gate=readGate(),a=gatedCore(gate),b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-read-close',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>a.service.read(),view=>view.incoming.length===1);
  gate.arm();
  await wait(()=>Promise.resolve(gate.held()),held=>held,6000);
  const closing=a.service.closePairing({commandId:'close-read-race'});
  assert.ok(await pending(closing),'the close waits for the commit that already began');
  gate.release();
  await closing;
  assert.equal((await pairing).status,'paired');
  assert.equal((await a.service.read()).peers.length,1);
  assert.equal((await a.service.read()).pairing,null);
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'code-ended','nothing can begin after the close');
  await assertWindowConsistency(a.service,a.store);
 }finally{gate.release();await drain(a,b).catch(()=>{});}
});

// Each inner await of the commit dispatch, held past the expiry in turn: the write must never start.
for(const held of ['load','lookupOperation','readState'] as const){
 test(`review 3: a ${held} held past the expiry inside the dispatch never starts the write`,async()=>{
  let now=Date.now(),arm=false,calls=0,arrived=false,release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  // For readState the first armed call is the section's own preparation read; the dispatch's admission read is the second.
  const holdAfter=held==='readState'?2:1,base=makeStore();
  const store=new Proxy(base,{get(target,key){if(key===held)return async(...args:any[])=>{if(arm){calls++;if(calls===holdAfter&&!arrived){arrived=true;await gate;}}return (target as any)[key](...args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
  const secrets=new InMemorySecretSlots();
  const a:Core={store,secrets,service:new DeviceLinkService(store,store,secrets,{clock:()=>now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000,pairingTtlMs:60000})};
  const b=await core();
  try{
   const window=await openWindow(a);
   const pairing=b.service.pair({commandId:`p-inner-${held}`,address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
   pairing.catch(()=>{});
   await wait(()=>a.service.read(),view=>view.incoming.length===1,6000);
   arm=true;
   await wait(()=>Promise.resolve(arrived),value=>value,8000);
   now+=61000; // the window expires while the inner read is held
   release();
   assert.equal((await pairing).status,'code-ended','a commit whose transition was evaluated after the expiry is refused');
   assert.equal((await a.service.read()).peers.length,0,'no device is stored');
   await assertWindowConsistency(a.service,a.store,()=>now);
  }finally{release();await drain(a,b).catch(()=>{});}
 });
}

test('a wedged old-window commit makes opening a new window fail as unknown, never hang',async()=>{
 const wedge=wedgedStore('fulfil'),a=wedgedCore(wedge.store),b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-wedged',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>wedge.arrived(),Boolean,8000);
  const reopening=openWindow(a);
  const settled=await Promise.race([reopening.then(()=>'settled',()=>'rejected'),new Promise(resolve=>setTimeout(()=>resolve('hung'),1000))]);
  assert.equal(settled,'rejected','opening a new window settles with the typed error within the deadline instead of hanging');
  await assert.rejects(reopening,error=>error instanceof CommitOutcomeUnknownError);
  assert.equal((await a.service.read()).pairing,null,'no new window exists while the old commit is unresolved');
  assert.match(String((await a.service.read()).unknownPairingCommit),/Commit outcome is unknown/i,'the owner-facing read shows the unknown outcome');
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

// A store whose peer-added commit can be held and later fulfilled, rejected, or held forever.
const wedgedStore=(mode:'fulfil'|'reject'|'hold')=>{
 const base=makeStore();let arrived=false,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const hashId=(value:string)=>createHash('sha256').update(value).digest('hex');
 const transport:QueryTransport={async query(sql,vars){
  if(sql===COMMIT_QUERY){
   if(!arrived&&(vars.events as any[])?.[0]?.command?.action==='peer-added'&&vars.aggregateId===DEVICE_LINK_ID){arrived=true;await gate;if(mode==='reject')throw new StorageQueryError('store failed');if(mode==='hold')return new Promise(()=>{});}
   const state=await base.load(String(vars.aggregateId));
   if(vars.deadlinePassed&&Number(vars.expectedRevision)===(state?.revision??0))return [{status:'conflict',reason:'deadline',revision:state?.revision??0}];
   return [await base.commit({id:String(vars.aggregateId),commandId:String(vars.commandId),fingerprint:String(vars.fingerprint),expectedRevision:Number(vars.expectedRevision),value:vars.value,events:vars.events as unknown[],outbox:vars.outbox as unknown[]})];
  }
  if(sql===LOAD_QUERY){const op=base.inspect().filter(item=>hashId(item.aggregateId)===vars.aggregateKey).at(-1);return [op?{aggregateId:op.aggregateId,revision:op.revision,value:op.value}:null];}
  if(sql===OPERATION_QUERY)return [base.inspect().find(item=>hashId(item.commandId)===vars.operationKey)??null];
  if(sql===READ_STATE_QUERY){const state=await base.readState(),op=base.inspect().filter(item=>hashId(item.aggregateId)===vars.aggregateKey).at(-1);return [{feedId:state.feedId,cursor:state.cursor,state:op?{aggregateId:op.aggregateId,revision:op.revision,value:op.value}:null}];}
  throw new Error('Unexpected storage query');
 }};
 const wrap=()=>{const actual=new SurrealStore<any>(transport);return new Proxy(actual,{get(target,key){if(key==='inspect')return base.inspect.bind(base);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;};
 return {store:wrap(),other:wrap(),arrived:()=>arrived,release};
};
const wedgedCore=(store:ReturnType<typeof makeStore>)=>{const secrets=new InMemorySecretSlots();return {store,secrets,service:new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:100})} as Core;};
const guard=async(promise:Promise<unknown>)=>{const marker=Symbol('timeout');const outcome=await Promise.race([promise.then(()=>'settled',()=>'settled'),new Promise(resolve=>setTimeout(()=>resolve(marker),1500))]);return outcome===marker?'hung':'settled';};

test('review 7 HIGH 2: a timed-out pairing that wins the close race reports its peer',async()=>{
 const wedge=wedgedStore('fulfil'),a=wedgedCore(wedge.store),b=await core();
 try{
  const window=await openWindow(a);
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await wait(()=>wedge.arrived(),Boolean,8000);
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit!==null,2000);
  const closing=a.service.closePairing({commandId:'review7-timeout-pair-wins'});closing.catch(()=>{});
  wedge.release();
  const result=await closing;
  assert.equal(result.status,'paired');
  if(result.status==='paired')assert.equal((await a.service.read()).peers[0]?.deviceId,result.peer.deviceId);
  assert.equal((await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'consumed');
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

test('review 9 q2: a pairing settled by the background settle is returned by the owner\'s close, once',async()=>{
 const wedge=wedgedStore('fulfil'),a=wedgedCore(wedge.store),b=await core();
 try{
  const window=await openWindow(a);
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await wait(()=>wedge.arrived(),Boolean,8000);
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit!==null,2000); // the write ended unknown within its deadline
  wedge.release(); // the late write lands and the background settle is scheduled ahead of the owner
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit===null,8000); // the background settle resolved it first
  const result=await a.service.closePairing({commandId:'background-settled-close'});
  assert.equal(result.status,'paired');
  const view=await a.service.read();
  assert.equal(view.peers.length,1);
  if(result.status==='paired')assert.equal(result.peer.deviceId,view.peers[0]!.deviceId);
  assert.ok(view.lastPairing,'read() reports the settled pairing');
  assert.equal(view.lastPairing!.peer.deviceId,view.peers[0]!.deviceId);
  assert.equal(view.lastPairing!.generation,(await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow.generation);
  assert.equal((await a.service.closePairing({commandId:'background-settled-close-2'})).status,'closed','a later close returns closed');
  assert.equal((await a.service.read()).lastPairing!.peer.deviceId,view.peers[0]!.deviceId,'the read model keeps it until the next window opens');
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

test('review 9 q2: a pairing that landed in time is returned by the owner\'s close, once',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'paired');
  const result=await a.service.closePairing({commandId:'landed-close'});
  assert.equal(result.status,'paired');
  const view=await a.service.read();
  assert.equal(view.peers.length,1);
  if(result.status==='paired')assert.equal(result.peer.deviceId,view.peers[0]!.deviceId);
  assert.ok(view.lastPairing,'read() reports the settled pairing');
  assert.equal(view.lastPairing!.peer.deviceId,view.peers[0]!.deviceId);
  assert.equal((await a.service.closePairing({commandId:'landed-close-2'})).status,'closed','a later close returns closed');
  assert.ok((await a.service.read()).lastPairing,'the read model keeps it until the next window opens');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('review 10 HIGH: an unpaired device is not reported as the last pairing after the owner\'s close',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'paired');
  const deviceId=(await a.service.read()).peers[0]!.deviceId;
  assert.equal((await a.service.closePairing({commandId:'unpair-report-close'})).status,'paired');
  assert.ok((await a.service.read()).lastPairing,'the pairing is reported while the device is still paired');
  await a.service.unpair({commandId:'unpair-report',deviceId});
  const view=await a.service.read();
  assert.equal(view.peers.length,0);
  assert.equal(view.lastPairing,null,'read() drops the stale report once the device is unpaired');
  assert.equal((await a.service.closePairing({commandId:'unpair-report-close-2'})).status,'closed','the close does not return paired for an unpaired device');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('review 10 HIGH: an unpaired device is not returned as paired from the background-settled close',async()=>{
 const wedge=wedgedStore('fulfil'),a=wedgedCore(wedge.store),b=await core();
 try{
  const window=await openWindow(a);
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await wait(()=>wedge.arrived(),Boolean,8000);
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit!==null,2000);
  wedge.release();
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit===null,8000); // the background settle recorded the pairing
  const deviceId=(await a.service.read()).peers[0]!.deviceId;
  await a.service.unpair({commandId:'unpair-after-background',deviceId});
  const view=await a.service.read();
  assert.equal(view.peers.length,0);
  assert.equal(view.lastPairing,null,'read() decides by the stored list, not by memory');
  assert.equal((await a.service.closePairing({commandId:'background-unpaired-close'})).status,'closed','the stale value is dropped, not answered');
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

test('review 10: read() reports the landed pairing before any close',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'paired');
  const view=await a.service.read();
  assert.equal(view.peers.length,1);
  assert.ok(view.lastPairing,'the pairing is reportable from the moment the write landed');
  assert.equal(view.lastPairing!.peer.deviceId,view.peers[0]!.deviceId);
  assert.equal(view.lastPairing!.generation,(await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow.generation);
  assert.equal((await a.service.closePairing({commandId:'landed-before-close'})).status,'paired','the close still returns paired once');
  assert.equal((await a.service.closePairing({commandId:'landed-before-close-2'})).status,'closed');
  assert.match((await openWindow(a)).code,/^[0-9]{6}$/);
  assert.equal((await a.service.read()).lastPairing,null,'the next successful open clears the last pairing');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('review 10: a failed open after the window-opened commit still clears the last pairing',async()=>{
 const base=makeStore();let fail=false,opens=0;
 const store=new Proxy(base,{get(target,key){
  if(key==='commit')return async(input:CommitInput<any>)=>{const result=await target.commit(input);if((input.events[0] as any)?.command?.action==='window-opened'&&++opens>1)fail=true;return result;};
  if(key==='load')return async(...args:Parameters<typeof target.load>)=>{if(fail){fail=false;throw new Error('listener load failed');}return target.load(...args);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }}) as typeof base;
 const a=wedgedCore(store),b=await core();
 try{
  const first=await openWindow(a);
  assert.equal((await pairFrom(b,first.address,first.code!)).status,'paired');
  assert.equal((await a.service.closePairing({commandId:'first-window-close'})).status,'paired');
  assert.ok((await a.service.read()).lastPairing);
  await assert.rejects(openWindow(a),/listener load failed/); // the new window commits, then the listener sync fails
  assert.equal((await a.service.read()).lastPairing,null,'the committed window-opened cleared the last pairing');
  assert.equal((await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'closed','the failed open is settled closed');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b).catch(()=>{});}
});

test('review 6: unknown write settling while open waits keeps the window consistent',async()=>{
 const base=makeStore();let entered=false,release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
 const store=new Proxy(base,{get(target,key){if(key==='commit')return async(input:CommitInput<any>)=>{if((input.events[0] as any)?.command?.windowGeneration){entered=true;await gate;await target.commit(input);throw new CommitOutcomeUnknownError(input);}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof base;
 const secrets=new InMemorySecretSlots(),a:Core={store,secrets,service:new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:5000})},b=await core();
 try{
  const window=await openWindow(a);
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await wait(()=>entered,Boolean,8000);
  const reopening=openWindow(a);reopening.catch(()=>{});
  await flush();release();
  const opened=await reopening;
  assert.match(opened.code,/^[0-9]{6}$/);
  await assertWindowConsistency(a.service,a.store);
 }finally{release();await drain(a,b).catch(()=>{});}
});

test('review 3: a lookup deadline before a write does not create an unknown write',async()=>{
 const base=makeStore();let block=false,entered=false,release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
 const store=new Proxy(base,{get(target,key){if(key==='lookupOperation')return async(...args:Parameters<typeof target.lookupOperation>)=>{if(block){entered=true;await gate;}return target.lookupOperation(...args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof base;
 const a=wedgedCore(store),b=await core();
 try{
  const window=await openWindow(a);
  const pairing=pairFrom(b,window.address,window.code);
  await wait(()=>a.service.read(),view=>view.incoming.length===1,8000);
  block=true;
  await wait(()=>entered,Boolean,8000);
  assert.equal((await pairing).status,'code-ended');
  assert.equal((await a.service.read()).unknownPairingCommit,null);
  assert.equal((await a.service.read()).peers.length,0);
  block=false;release();
  await wait(()=>a.store.load(DEVICE_LINK_ID),snapshot=>snapshot?.value.pairingWindow?.status==='closed');
  await assertWindowConsistency(a.service,a.store);
 }finally{block=false;release();await drain(a,b).catch(()=>{});}
});

test('a committed aggregate resolves an unknown pairing while its reply is still delayed',async()=>{
 const wedge=wedgedStore('fulfil');let input:CommitInput<any>|undefined;
 const store=new Proxy(wedge.store,{get(target,key){if(key==='commit')return (value:CommitInput<any>)=>{if((value.events[0] as any)?.command?.windowGeneration)input=value;return target.commit(value);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof wedge.store;
 const a=wedgedCore(store),b=await core();
 try{
  const window=await openWindow(a);
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await wait(()=>wedge.arrived(),Boolean,8000);
  await assert.rejects(openWindow(a),error=>error instanceof CommitOutcomeUnknownError);
  assert.ok(input);
  assert.equal((await wedge.other.commit(input)).status,'committed');
  const reopening=openWindow(a);reopening.catch(()=>{});
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit===null&&view.peers.length===1);
  wedge.release();
  const reopened=await reopening;
  assert.match(reopened.code,/^[0-9]{6}$/);
  assert.equal((await a.service.read()).peers.length,1);
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

test('review 6: closing an unknown pairing refuses while the store is silent',async()=>{
 const wedge=wedgedStore('fulfil');let settled=()=>{};const written=new Promise<void>(resolve=>{settled=resolve;});
 const store=new Proxy(wedge.store,{get(target,key){if(key==='commit')return (value:CommitInput<any>)=>{const task=target.commit(value);if((value.events[0] as any)?.command?.windowGeneration)void task.then(settled,settled);return task;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof wedge.store;
 const a=wedgedCore(store),b=await core();
 try{
  const window=await openWindow(a);
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await wait(()=>wedge.arrived(),Boolean,8000);
  await assert.rejects(openWindow(a),error=>error instanceof CommitOutcomeUnknownError);
  const before=wedge.store.inspect().length;
  await assert.rejects(a.service.closePairing({commandId:'close-unknown'}),error=>error instanceof CommitOutcomeUnknownError);
  assert.equal(wedge.store.inspect().length,before);
  wedge.release();
  await written;
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit===null);
  assert.equal((await a.service.read()).peers.length,1);
  assert.equal((await a.service.read()).unknownPairingCommit,null);
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

for(const action of ['open','close'] as const)for(const method of ['load','readState','lookupOperation'] as const){
 test(`${action} returns a typed deadline error when ${method} never settles`,async()=>{
  const base=makeStore();let block=false,entered=false,release=()=>{},loads=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const store=new Proxy(base,{get(target,key){if(key===method)return async(...args:any[])=>{if(block&&!(action==='close'&&method==='load'&&++loads===1)){entered=true;await gate;}return (target as any)[key](...args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof base;
  const a=wedgedCore(store);
  try{
   await a.service.read();
   if(action==='close')await openWindow(a);
   block=true;
   const result=action==='open'?openWindow(a):a.service.closePairing({commandId:`bounded-${method}`});
   result.catch(()=>{});
   await wait(()=>entered,value=>value,1000);
   assert.equal(await guard(result),'settled');
   await assert.rejects(result,error=>error instanceof CommitOutcomeUnknownError);
   block=false;release();
   await assertWindowConsistency(a.service,a.store);
  }finally{block=false;release();await new Promise(resolve=>setTimeout(resolve,50));await a.service.drain().catch(()=>{});}
 });
}

test('review 4: restart closes the window before a delayed pairing write settles',async()=>{
 const wedge=wedgedStore('fulfil'),a=wedgedCore(wedge.store),b=await core();let restarted:DeviceLinkService|undefined;
 try{
  const window=await openWindow(a);
  void b.service.pair({commandId:'review-4-restart',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'}).catch(()=>{});
  await wait(()=>Promise.resolve(wedge.arrived()),arrived=>arrived,8000);
  await assert.rejects(openWindow(a),error=>error instanceof CommitOutcomeUnknownError);
  restarted=new DeviceLinkService(wedge.other,wedge.other,a.secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  assert.equal((await restarted.read()).pairing,null);
  wedge.release();
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit===null);
  assert.equal((await restarted.read()).peers.length,0);
  await assertWindowConsistency(restarted,a.store);
 }finally{wedge.release();if(restarted)await restarted.drain().catch(()=>{});await drain(a,b).catch(()=>{});}
});

test('review 5: reopening is bounded when unknown outcome aggregate load never settles',async()=>{
 const wedge=wedgedStore('fulfil');let block=false,entered=false,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const store=new Proxy(wedge.store,{get(target,key){if(key==='load'||key==='readState')return async(...args:any[])=>{if(block){entered=true;await gate;}return (target as any)[key](...args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof wedge.store;
 const a=wedgedCore(store),b=await core();
 try{
  const window=await openWindow(a);
  void b.service.pair({commandId:'review-5-lookup',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'}).catch(()=>{});
  await wait(()=>Promise.resolve(wedge.arrived()),arrived=>arrived,8000);
  await assert.rejects(openWindow(a),error=>error instanceof CommitOutcomeUnknownError);
  block=true;
  const reopening=openWindow(a);reopening.catch(()=>{});
  await wait(()=>Promise.resolve(entered),value=>value,1000);
  assert.equal(await guard(reopening),'settled','the aggregate load must obey the commit deadline');
  await assert.rejects(reopening,error=>error instanceof CommitOutcomeUnknownError);
  block=false;release();
  await assertWindowConsistency(a.service,a.store);
 }finally{block=false;release();wedge.release();await drain(a,b).catch(()=>{});}
});

test('a late-fulfilled old write resolves the unknown outcome and the device is listed',async()=>{
 const wedge=wedgedStore('fulfil'),a=wedgedCore(wedge.store),b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-late-fulfil',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>Promise.resolve(wedge.arrived()),arrived=>arrived,8000); // the store call was actually entered
  const first=openWindow(a);
  assert.equal(await guard(first),'settled');
  await assert.rejects(first,error=>error instanceof CommitOutcomeUnknownError,'the first open after the deadline refuses');
  const second=openWindow(a);
  assert.equal(await guard(second),'settled');
  await assert.rejects(second,error=>error instanceof CommitOutcomeUnknownError,'the second open still refuses while the write is pending');
  wedge.release(); // the held commit now fulfils; the client's socket was already ended, so its own attempt reads as code-ended
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit===null&&view.peers.length===1);
  await assertWindowConsistency(a.service,a.store);
  const reopened=await openWindow(a);
  assert.match(reopened.code!,/^[0-9]{6}$/,'the next open succeeds once the outcome is known');
  assert.equal((await a.service.read()).peers.length,1,'the device registered by the old code is visible to the owner, not silently dropped');
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

test('a late-rejected old write resolves the unknown outcome and nothing is listed',async()=>{
 const wedge=wedgedStore('reject'),a=wedgedCore(wedge.store),b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-late-reject',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>Promise.resolve(wedge.arrived()),arrived=>arrived,8000);
  const refused=openWindow(a);
  await assert.rejects(refused,error=>error instanceof CommitOutcomeUnknownError);
  wedge.release(); // the held commit now rejects
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit===null);
  assert.equal((await a.service.read()).peers.length,0,'nothing was registered');
  assert.equal((await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'closed');
  await assertWindowConsistency(a.service,a.store);
  const reopened=await openWindow(a);
  assert.match(reopened.code!,/^[0-9]{6}$/,'the next open succeeds once the outcome is known');
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

test('review 6: a known rejection after an earlier close deadline closes the durable window',async()=>{
 const wedge=wedgedStore('reject'),secrets=new InMemorySecretSlots(),a:Core={store:wedge.store,secrets,service:new DeviceLinkService(wedge.store,wedge.store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000,commitDeadlineMs:1000})},b=await core();
 try{
  const window=await openWindow(a);
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await wait(()=>wedge.arrived(),Boolean,8000);
  const original=Date.now;let closing:ReturnType<DeviceLinkService['closePairing']>;
  try{Date.now=()=>original()-900;closing=a.service.closePairing({commandId:'earlier-close-deadline'});}
  finally{Date.now=original;}
  await assert.rejects(closing,error=>error instanceof CommitOutcomeUnknownError);
  wedge.release();
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit===null);
  assert.equal((await a.store.load(DEVICE_LINK_ID))!.value.pairingWindow.status,'closed');
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

test('review 6: a failed cleanup is retried before a new window opens',async()=>{
 const wedge=wedgedStore('reject');let closeAttempted=false,failClose=true;
 const store=new Proxy(wedge.store,{get(target,key){if(key==='commit')return async(input:CommitInput<any>)=>{if((input.events[0] as any)?.command?.action==='window-closed'&&failClose){closeAttempted=true;failClose=false;throw new Error('close failed');}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof wedge.store;
 const a=wedgedCore(store),b=await core();
 try{
  const window=await openWindow(a);
  void pairFrom(b,window.address,window.code).catch(()=>{});
  await wait(()=>wedge.arrived(),Boolean,8000);
  await assert.rejects(openWindow(a),error=>error instanceof CommitOutcomeUnknownError);
  wedge.release();
  await wait(()=>closeAttempted,Boolean,2000);
  await wedge.store.commit({id:'review6-recovery-barrier',commandId:'review6-recovery-barrier',fingerprint:'review6-recovery-barrier',expectedRevision:0,value:{},events:[],outbox:[]});
  const reopened=await openWindow(a);
  assert.match(reopened.code,/^[0-9]{6}$/);
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();await drain(a,b).catch(()=>{});}
});

test('while the old write is still pending, opening keeps refusing',async()=>{
 const wedge=wedgedStore('hold'),a=wedgedCore(wedge.store),b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-pending',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>Promise.resolve(wedge.arrived()),arrived=>arrived,8000);
  for(let attempt=0;attempt<3;attempt++){
   const refused=openWindow(a);
   assert.equal(await guard(refused),'settled');
   await assert.rejects(refused,error=>error instanceof CommitOutcomeUnknownError,`refusal ${attempt+1}`);
  }
  assert.equal((await a.service.read()).pairing,null,'no new window exists');
  assert.match(String((await a.service.read()).unknownPairingCommit),/Commit outcome is unknown/i);
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();void a.service.drain().catch(()=>{});await drain(b).catch(()=>{});}
});

test('after a restart the pairing state comes from the store',async()=>{
 const wedge=wedgedStore('fulfil'),a=wedgedCore(wedge.store),b=await core();
 let a2:DeviceLinkService|undefined;
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-restart-unknown',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>Promise.resolve(wedge.arrived()),arrived=>arrived,8000);
  const refused=openWindow(a);
  await assert.rejects(refused,error=>error instanceof CommitOutcomeUnknownError);
  // The old process ends while the outcome is unknown; its late write lands before the restart completes.
  wedge.release();
  await wait(()=>a.service.read(),view=>view.unknownPairingCommit===null&&view.peers.length===1);
  await a.service.drain();
  const fresh={store:a.store,secrets:a.secrets,service:new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})} as Core;
  a2=fresh.service;
  assert.equal((await fresh.service.read()).unknownPairingCommit,null,'the memory-only unknown state is gone after the restart');
  assert.equal((await fresh.service.read()).peers.length,1,'the late device is derived from the store, not silently kept or dropped');
  const reopened=await openWindow(fresh);
  assert.match(reopened.code!,/^[0-9]{6}$/,'a restart opens a window again; the store is the state');
  await assertWindowConsistency(fresh.service,fresh.store);
 }finally{wedge.release();await a.service.drain().catch(()=>{});if(a2)await a2.drain();await drain(b).catch(()=>{});}
});

test('a close during a wedged commit settles within the deadline with the typed outcome',async()=>{
 const wedge=wedgedStore('hold'),a=wedgedCore(wedge.store),b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-close-wedge',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>Promise.resolve(wedge.arrived()),arrived=>arrived,8000);
  const closing=a.service.closePairing({commandId:'close-wedge'});
  assert.equal(await guard(closing),'settled','the close never hangs past the deadline');
  await assert.rejects(closing,error=>error instanceof CommitOutcomeUnknownError,'the wedged write surfaces as the typed unknown outcome');
  assert.match(String((await a.service.read()).unknownPairingCommit),/Commit outcome is unknown/i);
  assert.equal((await a.service.read()).pairing,null);
  await assertWindowConsistency(a.service,a.store);
 }finally{wedge.release();void a.service.drain().catch(()=>{});await drain(b).catch(()=>{});}
});

test('a retried pairing command replays the original outcome without spending attempts',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a),wrong={commandId:'p-retry-wrong',address:window.address,code:'000000',name:'Laptop',agentName:'Claude Code'};
  const first=await b.service.pair(wrong);
  assert.equal(first.status,'wrong-code');
  const retry=await b.service.pair({...wrong});
  assert.equal(retry.status,'wrong-code');
  assert.equal(retry.attemptsLeft,first.attemptsLeft,'the retry replays the original outcome');
  assert.equal((await a.service.read()).pairing!.attemptsLeft,4,'a replayed wrong code spends one attempt, not two');
  const ok={commandId:'p-retry-ok',address:window.address,code:window.code!,name:'Laptop',agentName:'Claude Code'};
  assert.equal((await b.service.pair(ok)).status,'paired');
  assert.equal((await b.service.pair({...ok})).status,'paired','a completed exchange replays instead of dialing a consumed window');
  assert.equal((await b.service.read()).peers.length,1);
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('an unfinished dial is rejected on socket close so drain settles',async()=>{
 const store=makeStore(),secrets=new InMemorySecretSlots();
 const gate=await new Promise<ReturnType<typeof netCreateServer>>(resolve=>{const server=netCreateServer(socket=>{socket.on('data',()=>{});});server.listen(0,'127.0.0.1',()=>resolve(server));});
 const port=(gate.address() as {port:number}).port;
 await seedPeer(store,'device-held',`127.0.0.1:${port}`);
 const service=new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:5000});
 try{
  const connecting=service.connect({commandId:'held',deviceId:'device-held'});connecting.catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,300)); // TCP is up, the TLS handshake never completes
  const marker=Symbol('timeout');
  const settled=await Promise.race([service.drain().catch(error=>error),new Promise(resolve=>setTimeout(()=>resolve(marker),2500))]);
  assert.notEqual(settled,marker,'drain settles once the pending dial is rejected on close');
  const outcome=await connecting.then(()=>'resolved',error=>error as Error);
  assert.ok(outcome instanceof Error,'the dial rejects instead of hanging');
 }finally{await service.drain().catch(()=>{});gate.close();}
});

test('an incompatible inbound protocol range is recorded as update-needed',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const identity=await identityFromSecrets(b.secrets);
  const port=Number((await b.service.read()).peers[0]!.addresses[0]!.split(':')[1]);
  const socket=await dial(port,identity),frames=readFrames(socket);
  socket.write(JSON.stringify({kind:'ping',supported:{min:99,max:99}})+'\n');
  await wait(frames.frames,list=>list.some(message=>message.kind==='pong'));
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='update-needed');
  socket.destroy();
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('a protocol range mismatch on an outbound link reports update needed',async()=>{
 const store=makeStore(),secrets=new InMemorySecretSlots(),identity=rawIdentity();
 const stub=await rawServer({key:identity.privateKeyPem,cert:identity.certPem,requestCert:false},socket=>{socket.end(JSON.stringify({kind:'pong',supported:{min:99,max:99}})+'\n');});
 const port=(stub.server.address() as {port:number}).port,service=new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
 await seedPeer(store,identity.deviceId,`127.0.0.1:${port}`,identity.publicKeyB64);
 try{
  await assert.rejects(service.connect({commandId:'future',deviceId:identity.deviceId}),/update/i);
  assert.equal((await service.read()).peers[0]!.lastStatus,'update-needed');
  validateMissionJournalLineage(store.inspect());
 }finally{await service.drain();await stub.close();}
});

test('grants only widen additively and unpair removes the paired device',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const before=(await a.service.read()).peers[0]!;
  assert.equal(before.grants.view,true);assert.equal(before.grants.instruct,true);assert.equal(before.grants.answerApprovals,true,'pairing turns the three grants on');
  await a.service.widen({commandId:`widen-${++sequence}`,deviceId:before.deviceId,grants:{view:true,instruct:true,answerApprovals:true}});
  assert.equal((await a.service.read()).peers[0]!.grants.instruct,true);
  await assert.rejects(a.service.widen({commandId:`widen-${++sequence}`,deviceId:before.deviceId,grants:{view:true,instruct:false,answerApprovals:true}}),/additively/i,'narrowing is never allowed');
  await a.service.unpair({commandId:`unpair-${++sequence}`,deviceId:before.deviceId});
  assert.equal((await a.service.read()).peers.length,0,'unpair removes the grant and the stored device key');
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('a restarted host restores its listener on the persisted port and its identity',async()=>{
 const a=await core(),b=await core();
 let a2:DeviceLinkService|undefined,b2:DeviceLinkService|undefined;
 try{
  const window=await link(a,b);
  await drain(a,b);
  a2=new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  b2=new DeviceLinkService(b.store,b.store,b.secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  assert.equal((await a2.read()).identity.fingerprint,(await a.service.read()).identity.fingerprint,'the installation key survives restart');
  const deviceId=(await b2.read()).peers[0]!.deviceId;
  const connected=await wait(()=>b2!.connect({commandId:'restart-link',deviceId}).catch(()=>'retrying' as const),value=>value!=='retrying');
  assert.equal((connected as {status:string}).status,'connected','the persisted pairing reopens the same port without a new window');
  assert.equal((await b2.read()).peers[0]!.addresses[0],window.address);
 }finally{if(a2)await a2.drain();if(b2)await b2.drain();}
});

test('a paired device can be unpaired and then paired again',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const first=(await a.service.read()).peers[0]!,stale=(await b.service.read()).peers[0]!;
  await a.service.unpair({commandId:'unpair-1',deviceId:first.deviceId});
  await b.service.unpair({commandId:'unpair-b',deviceId:stale.deviceId});
  await link(a,b);
  const second=(await a.service.read()).peers[0]!;
  assert.equal(second.deviceId,first.deviceId);
  await a.service.unpair({commandId:'unpair-2',deviceId:second.deviceId});
  assert.equal((await a.service.read()).peers.length,0);
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('one pairing code pairs exactly once under concurrent requests',async()=>{
 const a=await core(),b=await core(),c=await core();
 try{
  const window=await openWindow(a);
  const outcomes=await Promise.all([b,c].map(peer=>pairFrom(peer,window.address,window.code!)));
  const paired=outcomes.filter(outcome=>(outcome as {status?:string}).status==='paired');
  assert.equal(paired.length,1,'only the first confirmation consumes the window');
  assert.equal((await a.service.read()).peers.length,1);
  validateMissionJournalLineage(a.store.inspect());
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b,c);}
});

test('a pending pairing exchange settles when drain closes its socket',async()=>{
 const b=await core(),stubIdentity=rawIdentity();
 const stub=await rawServer({key:stubIdentity.privateKeyPem,cert:stubIdentity.certPem,requestCert:true},socket=>{socket.on('data',()=>{});});
 try{
  const port=(stub.server.address() as {port:number}).port;
  const pending=b.service.pair({commandId:'pair-held',address:`127.0.0.1:${port}`,code:'123456',name:'Laptop',agentName:'Claude Code'});
  pending.catch(()=>{});
  const marker=Symbol('timeout');
  const settled=await Promise.race([b.service.drain().catch(error=>error),new Promise(resolve=>setTimeout(()=>resolve(marker),3000))]);
  assert.notEqual(settled,'drain settles instead of waiting out the exchange timeout');
 }finally{await b.service.drain().catch(()=>{});await stub.close();}
});

test('concurrent first uses share one installation identity',async()=>{
 const a=await core();
 try{
  const views=await Promise.all([a.service.read(),a.service.read(),a.service.read()]);
  assert.equal(new Set(views.map(view=>view.identity.fingerprint)).size,1,'all callers observe one generated key');
 }finally{await drain(a);}
});

test('bracketed IPv6 loopback addresses pair and dial',async()=>{
 const a=await core(Date.now,{bind:'::1'}),b=await core();
 try{
  const window=await openWindow(a);
  assert.match(window.address,/\[::1\]:[0-9]+/,'the address keeps the bracketed IPv6 form');
  const outcome=await pairFrom(b,window.address,window.code!);
  assert.equal(outcome.status,'paired');
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  assert.equal((await b.service.connect({commandId:'link-v6',deviceId})).status,'connected');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('a fresh host listens on the fixed default port and a bare address pairs',async()=>{
 const store=makeStore(),secrets=new InMemorySecretSlots();
 const a:Core={store,secrets,service:new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000})};
 const b=await core();
 try{
  const window=await openWindow(a);
  assert.equal(window.address,'127.0.0.1:47831','the initial default port is fixed');
  const outcome=await b.service.pair({commandId:'pair-bare',address:'127.0.0.1',code:window.code,name:'Laptop',agentName:'Claude Code'});
  assert.equal(outcome.status,'paired','a bare host name dials the default port');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('the listener closes when the last window expires with no paired devices',async()=>{
 const a=await core(Date.now,{pairingTtlMs:200}),b=await core();
 try{
  const window=await openWindow(a);
  const port=Number(window.address.split(':')[1]);
  await new Promise(resolve=>setTimeout(resolve,600));
  await assert.rejects(new Promise<TLSSocket>((resolve,reject)=>{const c=connect({port,host:'127.0.0.1',rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);}),/refused|closed/i,'an expired window leaves no listener');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('an expired unused window beside a paired peer does not busy-loop the listener',async()=>{
 let now=Date.now();const a=await core(()=>now),b=await core();
 let restart:DeviceLinkService|undefined;
 try{
  await link(a,b);
  await openWindow(a);
  now+=3e5+1000;
  let loads=0;const base=a.store;
  const counted=new Proxy(base,{get(target,key){if(key==='load')return async(id:string)=>{const snapshot=await target.load(id) as {aggregateId?:string}|null;if(id===DEVICE_LINK_ID&&snapshot?.aggregateId===DEVICE_LINK_ID)loads++;return snapshot;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
  restart=new DeviceLinkService(counted,counted,a.secrets,{clock:()=>now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  await new Promise(resolve=>setTimeout(resolve,300));
  const settled=loads;await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(loads,settled,'the expired window schedules no zero-delay resynchronization');
  assert.ok((await restart.read()).peers.length===1,'the paired peer keeps the listener up');
  await assertWindowConsistency(restart,a.store,()=>now);
 }finally{if(restart)await restart.drain();await drain(a,b);}
});

test('a pre-handshake connection does not hold drain open',async()=>{
 const a=await core();
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  const raw=netConnect({port,host:'127.0.0.1'},()=>{});raw.on('error',()=>{});
  await new Promise(resolve=>setTimeout(resolve,150));
  const marker=Symbol('timeout');
  const settled=await Promise.race([a.service.drain().catch(error=>error),new Promise(resolve=>setTimeout(()=>resolve(marker),2500))]);
  assert.notEqual(settled,marker,'drain destroys sockets that never completed the handshake');
  raw.destroy();
 }finally{await a.service.drain().catch(()=>{});}
});

test('a closed inbound link records the device offline and keeps the last connection',async()=>{
 const a=await core(Date.now,{inboundCoalesceMs:0}),b=await core();
 try{
  await link(a,b);
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  await b.service.connect({commandId:'link-1',deviceId});
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='connected');
  await b.service.disconnect({commandId:'link-2',deviceId});
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='offline');
  assert.ok((await a.service.read()).peers[0]!.lastConnectedAt,'the last connection time survives the disconnect');
 }finally{await drain(a,b);}
});

test('a TLS 1.2-only client cannot reach the link',async()=>{
 const a=await core();
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  await assert.rejects(new Promise<TLSSocket>((resolve,reject)=>{const c=connect({port,host:'127.0.0.1',maxVersion:'TLSv1.2',rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);}),/version|protocol|handshake/i,'the link enforces TLS 1.3');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a);}
});

test('reconnects from new source ports add no durable history',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const identity=await identityFromSecrets(b.secrets),peerId=(await a.service.read()).peers[0]!.deviceId;
  const port=Number((await b.service.read()).peers[0]!.addresses[0]!.split(':')[1]);
  const pingOnce=async()=>{const socket=await dial(port,identity);socket.on('data',()=>{});socket.write(JSON.stringify({kind:'ping',supported:{min:1,max:1}})+'\n');await new Promise(resolve=>setTimeout(resolve,150));socket.destroy();};
  await pingOnce();
  const first=observations(a,peerId);
  for(let index=0;index<4;index++)await pingOnce();
  assert.equal(observations(a,peerId),first,'each reconnect from the same host records one transition');
 }finally{await drain(a,b);}
});

test('drain destroys accepted link sockets, awaits the listener and coalesced pings answer once each',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const identity=await identityFromSecrets(b.secrets),peerId=(await a.service.read()).peers[0]!.deviceId;
  const port=Number((await b.service.read()).peers[0]!.addresses[0]!.split(':')[1]);
  const socket=await dial(port,identity),frames=readFrames(socket);
  for(let index=0;index<5;index++)socket.write(JSON.stringify({kind:'ping',supported:{min:1,max:1}})+'\n');
  await wait(frames.frames,list=>list.filter(message=>message.kind==='pong').length===5);
  const before=observations(a,peerId);
  await wait(()=>a.service.read(),view=>observations(a,view.peers[0]?.deviceId??'')>=before);
  await a.service.drain();
  socket.write(JSON.stringify({kind:'ping',supported:{min:1,max:1}})+'\n');
  await wait(()=>Promise.resolve(socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(socket.destroyed,'drain destroys the accepted socket');
 }finally{await drain(a,b);}
});

test('unauthenticated sockets face a deadline and concurrency caps, plain TCP included',async()=>{
 const a=await core(Date.now,{preAuthTimeoutMs:200}),capped=await core(Date.now,{maxUnauthenticated:2,maxUnauthenticatedPerAddress:2,preAuthTimeoutMs:200});
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  const idle=await dial(port);idle.on('data',()=>{});
  await wait(()=>Promise.resolve(idle.destroyed),destroyed=>destroyed,2000);
  assert.ok(idle.destroyed,'a socket that never authenticates is closed');
  const cappedWindow=await openWindow(capped),cappedPort=Number(cappedWindow.address.split(':')[1]);
  const raws=await Promise.all([0,1,2].map(()=>new Promise<ReturnType<typeof netConnect>>(resolve=>{const raw=netConnect({port:cappedPort,host:'127.0.0.1'},()=>resolve(raw));raw.on('error',()=>{});})));
  await wait(()=>Promise.resolve(raws.some(raw=>raw.destroyed)),destroyed=>destroyed,2000);
  assert.ok(raws.some(raw=>raw.destroyed),'a connection that never handshakes is refused by the caps or the deadline');
  for(const raw of raws)raw.destroy();
  await assertWindowConsistency(a.service,a.store);
  await assertWindowConsistency(capped.service,capped.store);
 }finally{await drain(a,capped);}
});

test('a closed outbound link records the device offline on the dialing side',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  await b.service.connect({commandId:'link-1',deviceId});
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='connected');
  await a.service.drain();
  await wait(()=>b.service.read(),view=>view.peers[0]?.lastStatus==='offline');
 }finally{await drain(b);}
});

test('connecting an already connected device reuses the live link',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  const first=await b.service.connect({commandId:'link-1',deviceId});
  const observed=observations(a,deviceId);
  const second=await b.service.connect({commandId:'link-2',deviceId});
  assert.equal(second.address,first.address,'the same connection is reused');
  assert.equal(observations(a,deviceId),observed,'no second accepted socket replaces the first');
  await b.service.disconnect({commandId:'link-3',deviceId});
 }finally{await drain(a,b);}
});

test('a pairing confirmation whose commit cannot land fails closed',async()=>{
 const base=makeStore();let pairingFailures=5;
 const guarded=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.events?.[0]?.command?.action==='peer-added'&&pairingFailures>0){pairingFailures--;return {status:'conflict',revision:0,reason:'revision' as const};}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
 const secrets=new InMemorySecretSlots();
 const a:Core={store:guarded,secrets,service:new DeviceLinkService(guarded,guarded,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})};
 const b=await core();
 try{
  const window=await openWindow(a);
  const outcome=await pairFrom(b,window.address,window.code!);
  assert.equal(outcome.status,'code-ended','a commit that cannot land completes nothing');
  assert.equal((await a.service.read()).peers.length,0);
  assert.equal((await b.service.read()).peers.length,0);
  await wait(()=>a.store.load(DEVICE_LINK_ID),snapshot=>snapshot?.value.pairingWindow?.status==='closed');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});

test('review 6: a refused pairing can be followed by a usable new window',async()=>{
 const base=makeStore();let failures=3;
 const store=new Proxy(base,{get(target,key){if(key==='commit')return async(input:CommitInput<any>)=>{if((input.events[0] as any)?.command?.action==='peer-added'&&failures-->0)return {status:'conflict' as const,revision:input.expectedRevision,reason:'revision' as const};return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as typeof base;
 const secrets=new InMemorySecretSlots(),a:Core={store,secrets,service:new DeviceLinkService(store,store,secrets,{bind:'127.0.0.1',port:0,connectTimeoutMs:1000})},b=await core();
 try{
  const first=await openWindow(a);
  assert.equal((await pairFrom(b,first.address,first.code)).status,'code-ended');
  const second=await openWindow(a);
  assert.equal((await pairFrom(b,second.address,second.code)).status,'paired');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b).catch(()=>{});}
});

test('an attaching device is visible by name before pairing completes',async()=>{
 const a=await core();
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  const stranger=rawIdentity(),socket=await dial(port,stranger);
  socket.write(JSON.stringify({kind:'pair-client',peer:{deviceId:stranger.deviceId,publicKey:stranger.publicKeyB64,name:'Attaching',agentName:'Attaching'},supported:{min:1,max:1},A:bigB64(srpClientPublic(SRP_GROUP,randomExponent()))})+'\n');
  const view=await wait(()=>a.service.read(),current=>current.incoming.length===1);
  assert.equal(view.incoming[0]!.peer.name,'Attaching');
  socket.destroy();
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a);}
});

test('malformed pairing commands change nothing',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  await assert.rejects(b.service.pair({commandId:'bad-1',address:window.address,code:'12345',name:'Laptop',agentName:'Claude Code'}),/six-digit/i);
  await assert.rejects(b.service.pair({commandId:'bad-2',address:window.address,code:'123456',grants:{view:true,instruct:false} as unknown as never,name:'Laptop',agentName:'Claude Code'}),/exact pairing command/i);
  await assert.rejects(a.service.openPairing({commandId:'bad-3',name:'Extra'}),/window/i);
  assert.ok((await a.service.read()).pairing,'no window was lost');
  await assertWindowConsistency(a.service,a.store);
 }finally{await drain(a,b);}
});
