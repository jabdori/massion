import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {apply} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';
import {InMemoryStore} from '../src/storage.ts';
import {HostDrainError} from '../src/runtime-lifetime.ts';
import {validateMissionJournalLineage,validateMissionLineage} from '../src/backup-lineage.ts';
import {BrowserSessions,sanitizePage,BROWSER_HOST} from '../src/browser-runtime.ts';
import type {BrowserAdapter,RawBrowserPage} from '../src/browser-runtime.ts';
const now=Date.UTC(2026,10,5,5,11),url='https://shop.example.com/checkout';
const raw:RawBrowserPage={address:url,title:'주문 확인',blocks:['레이저 토너 검정','31,000원','3,000원','34,000원'],fields:[{label:'수량',type:'number',value:'1',autocomplete:''}]};
const request={missionId:'intake',workId:'work',readId:'page:1',address:url};
async function setup(read:BrowserAdapter['read']=async()=>structuredClone(raw)){
 const store=new InMemoryStore<Mission>(),app=new Application(store,[{id:'local-owner',roles:['owner']}]);
 await app.create({id:'intake',purpose:'Browser fixture',scope:'local',constraints:[],criteria:{version:1,description:'Observed page',oracle:'bounded-text-review/v1'}},'local-owner','create');
 await app.dispatch({missionId:'intake',expectedRevision:1,commandId:'work',actorId:'local-owner',command:{type:'admit-work',workId:'work',title:'Read checkout',budget:8}});
 const service=new BrowserSessions(store,store,{adapter:{read},clock:()=>now});return {store,app,service};
}
test('sanitized observations omit credentials, query secrets, payment and password values everywhere',()=>{
 const page=sanitizePage({...raw,address:'https://user:password@shop.example.com/checkout?token=private#secret',title:'Receipt 4111 1111 1111 1111',blocks:['password hunter2','card 4111111111111111','token=abc123secret'],fields:[{label:'Password',type:'password',value:'hunter2',autocomplete:'current-password'},{label:'Card',type:'text',value:'4111111111111111',autocomplete:'cc-number'},{label:'CVV',type:'text',value:'123',autocomplete:''},{label:'수량',type:'number',value:'1',autocomplete:''}]});
 assert.equal(page.address,url);assert.equal(page.fields[3]!.value,'1');assert.ok(page.fields.slice(0,3).every(f=>f.masked&&f.value==='••••'));
 assert.doesNotMatch(JSON.stringify(page),/hunter2|4111|abc123secret|user:password|token=private/);
 assert.throws(()=>sanitizePage({...raw,blocks:['x'.repeat(20000)]}),/bound|Invalid/);
});
test('overlapping identical reads commit once, replay after restart, and preserve journal lineage',async()=>{
 let calls=0,release!:()=>void;const held=new Promise<void>(r=>release=r);
 const s=await setup(async()=>{calls++;await held;return raw;});const a=s.service.capture(request),b=s.service.capture({...request});release();
 const results=await Promise.all([a,b]);assert.ok(results.every(r=>['committed','replayed'].includes(r.status)));assert.equal(calls,1);
 const read=await s.service.read('intake','work');assert.equal(read.session?.pagesRead,1);assert.equal(read.session?.page.title,'주문 확인');
 const restarted=new BrowserSessions(s.store,s.store,{adapter:{async read(){throw Error('Replay invoked adapter');}},clock:()=>now});
 assert.equal((await restarted.capture(request)).status,'replayed');validateMissionJournalLineage(s.store.inspect());
 await assert.rejects(restarted.capture({...request,address:'https://shop.example.com/other'}),/identity|conflict/i);
});
test('drain-aware owner store refuses a write resumed after a read',async()=>{
 let draining=false,release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),s=await setup();
 const owner=new Proxy(s.store,{get(target,key){if(key==='commit')return (input:any)=>{if(draining)throw new HostDrainError();return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const service=new BrowserSessions(s.store,owner,{adapter:{async read(){entered();await held;return raw;}},clock:()=>now});const capture=service.capture(request);await started;draining=true;release();await assert.rejects(capture,HostDrainError);assert.equal((await service.read('intake','work')).session,null);
});
test('newer reads supersede late responses without replacing current page',async()=>{
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let calls=0;
 const s=await setup(async()=>{if(++calls===1){entered();await held;return {...raw,title:'Old'};}return {...raw,title:'New'};});
 const old=s.service.capture(request);await started;await s.service.capture({...request,readId:'page:2'});release();await assert.rejects(old,/superseded/i);assert.equal((await s.service.read('intake','work')).session?.page.title,'New');
});
test('feed replacement, stopped Work and expired runtime refuse late browser observations',async()=>{
 for(const change of ['feed','stop','deadline']){
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const s=await setup(async()=>{entered();await held;return raw;});
  if(change==='deadline'){const snapshot=(await s.store.load('intake'))!;snapshot.value.works[0]!.runtimeRun={id:'run',authorizationId:'grant',criteriaHash:'',inputHash:'',mode:'mock-http',outputTokenCap:1,ownership:{deadlineAt:now-1} as any};await s.store.commit({id:'intake',expectedRevision:2,commandId:'fixture-deadline',fingerprint:'fixture',value:snapshot.value,events:[],outbox:[]});await assert.rejects(s.service.capture(request),/deadline|expired/);continue;}
  const capture=s.service.capture(request);await started;
  if(change==='stop')await s.app.dispatch({missionId:'intake',expectedRevision:2,commandId:'stop',actorId:'local-owner',command:{type:'cancel',workId:'work'}});
  else {const readState=s.store.readState.bind(s.store);s.store.readState=async(...args)=>({...await readState(...args),feedId:'replacement'});}
  release();await assert.rejects(capture,/feed|revision|Work|changed/i);assert.equal((await s.service.read('intake','work')).session,null);
 }
});
test('browser actor cannot approve effects and owners cannot fabricate observations',async()=>{
 const s=await setup();await s.service.capture(request);const mission=(await s.store.load('intake'))!.value;
 assert.throws(()=>apply(mission,{type:'cancel',workId:'work'},{id:BROWSER_HOST,roles:['owner']}),/browser.only|browser-only/i);
 const event=s.store.inspect().at(-1)!.events[0] as any;assert.throws(()=>apply(mission,event.command,{id:'local-owner',roles:['owner']}),/authority|host/i);
});
test('raw URL secret values are removed from retained page text and form labels',()=>{
 const page=sanitizePage({...raw,address:url+'?token=private-value#fragment-secret',title:'private-value',blocks:['fragment-secret'],fields:[]});assert.doesNotMatch(JSON.stringify(page),/private-value|fragment-secret/);
});
test('unknown commit remains unsettled during drain and a durable result is read back without another read',async()=>{
 let calls=0;const s=await setup(async()=>{calls++;return raw;}),commit=s.store.commit.bind(s.store);s.store.commit=async input=>{await commit(input);const e=new Error('Unknown fixture commit');e.name='CommitOutcomeUnknownError';throw e;};
 await assert.rejects(s.service.capture(request),/Unknown fixture commit/);await assert.rejects(s.service.drain(),/unsettled/i);s.store.commit=commit;
 const restored=new BrowserSessions(s.store,s.store,{adapter:{async read(){calls++;return raw;}}});assert.equal((await restored.capture(request)).status,'replayed');assert.equal(calls,1);
});
test('HTTP and protocol queries return only stored sanitized pages and expose no browser action route',async t=>{
 const {createWorkbench}=await import('../src/server.ts'),s=await setup(),server=createWorkbench(s.store,'.',{browserAdapter:{async read(){return {...raw,fields:[{label:'Card',type:'text',value:'4111111111111111',autocomplete:'cc-number'}]};}},scheduleIntervalMs:0});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,path='/missions/intake/works/work/browser';
 assert.equal((await (await fetch(origin+path)).json()).session,null);await server.browserSessions.capture(request);
 const page=await (await fetch(origin+path)).json();assert.equal(page.session.pagesRead,1);assert.doesNotMatch(JSON.stringify(page),/4111111111111111/);
 const response=await fetch(origin+'/protocol/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,requestId:'browser-query',generation:3,kind:'query',path})});const body=await response.json();assert.equal(body.status,200);assert.equal(body.generation,3);assert.deepEqual(body.payload,page);
 assert.equal((await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);assert.equal((await server.drain()).status,'drained');
});
test('restored browser pages reject unmasked payment fields and secret-shaped text',async()=>{
 const s=await setup();await s.service.capture(request);
 for(const tamper of [(p:any)=>p.fields.push({label:'Card',value:'4242424242424242',masked:false}),(p:any)=>p.blocks.push('token=restore-secret')]){const operations=structuredClone(s.store.inspect());tamper(operations.at(-1)!.value.works[0]!.browserSession!.pages[0]);assert.throws(()=>validateMissionLineage(operations.at(-1)!.value),/browser/i);}
});
test('one-time-code inputs are masked even when numeric and removed from page text',()=>{
 const page=sanitizePage({...raw,blocks:['Your code is 123456'],fields:[{label:'Verification code',type:'number',value:'123456',autocomplete:'one-time-code'}]});assert.equal(page.fields[0]!.masked,true);assert.equal(page.fields[0]!.value,'••••');assert.doesNotMatch(JSON.stringify(page),/123456/);
});
test('a read superseded while application lookup is held cannot cross commit admission',async()=>{
 let oldLookupEntered!:()=>void,releaseOld!:()=>void,newReadEntered!:()=>void,releaseNew!:()=>void;
 const lookupEntered=new Promise<void>(r=>oldLookupEntered=r),oldGate=new Promise<void>(r=>releaseOld=r),readEntered=new Promise<void>(r=>newReadEntered=r),newGate=new Promise<void>(r=>releaseNew=r);let reads=0;
 const s=await setup(async()=>{if(++reads===2){newReadEntered();await newGate;return {...raw,title:'New'};}return {...raw,title:'Old'};});const lookup=s.store.lookupOperation.bind(s.store);let lookups=0;
 s.store.lookupOperation=async identity=>{if(++lookups===1){oldLookupEntered();await oldGate;}return lookup(identity);};
 const old=s.service.capture(request);await lookupEntered;const next=s.service.capture({...request,readId:'page:2'});await readEntered;releaseOld();
 const oldResult=await old.catch(error=>error);releaseNew();const nextResult=await next.catch(error=>error);assert.match(oldResult.message??'',/superseded/i);assert.equal(nextResult.status,'committed');assert.equal((await s.service.read('intake','work')).session?.page.title,'New');
});
test('runtime expiry during application lookup rejects commit admission',async()=>{
 const {hash,workInputHash}=await import('../src/domain.ts'),s=await setup(),w=(await s.store.load('intake'))!.value.works[0]!;let clock=now;
 await s.app.dispatch({missionId:'intake',expectedRevision:2,commandId:'start',actorId:'local-owner',command:{type:'activate-runtime',workId:'work',run:{id:'run',authorizationId:'fixture',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:1,ownership:{hostSessionId:'host',dispatchId:'dispatch',startedAt:now-1,deadlineAt:now+1000}}}});
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),lookup=s.store.lookupOperation.bind(s.store);let lookups=0;
 s.store.lookupOperation=async identity=>{if(++lookups===1){entered();await gate;}return lookup(identity);};
 const service=new BrowserSessions(s.store,s.store,{adapter:{async read(){return raw;}},clock:()=>clock}),capture=service.capture(request);await started;clock+=2000;release();await assert.rejects(capture,/deadline|expired/);assert.equal((await service.read('intake','work')).session,null);
});

test('security labels, names and autocomplete never commit a numeric security code',async()=>{
 for(const field of [{label:'보안 코드',name:'field',autocomplete:''},{label:'Security code',name:'field',autocomplete:''},{label:'수량',name:'csc',autocomplete:''},{label:'수량',name:'quantity',autocomplete:'cc-csc'}]){
  const s=await setup(async()=>({...raw,blocks:['Reflected value: 456'],fields:[{...field,type:'number',value:'456'}]}));await s.service.capture(request);const read=await s.service.read('intake','work'),operation=s.store.inspect().at(-1)!;assert.equal(read.session!.page.fields[0]!.masked,true);assert.equal(read.session!.page.fields[0]!.value,'••••');assert.equal(read.session!.page.blocks[0],'Reflected value: ••••');assert.doesNotMatch(JSON.stringify(operation),/"value":"456"|Reflected value: 456/);
 }
});

test('host drain waits for interrupted browser cleanup and reports its deadline honestly',async t=>{
 const {createWorkbench}=await import('../src/server.ts');
 for(const timeout of [false,true]){
  const s=await setup();let entered!:()=>void,cleanupEntered!:()=>void,release!:()=>void,cleaned=false;
  const reading=new Promise<void>(r=>entered=r),cleaning=new Promise<void>(r=>cleanupEntered=r),cleanup=new Promise<void>(r=>release=r);
  const server=createWorkbench(s.store,'.',{scheduleIntervalMs:0,drainTimeoutMs:timeout?20:2000,browserAdapter:{async read({signal}){entered();try{await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return raw;}finally{cleanupEntered();await cleanup;cleaned=true;}}}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{release();server.close();});const capture=server.browserSessions.capture(request).catch(error=>error);await reading;
  const closed=new Promise<void>(r=>server.once('close',r));let finished=false;const drain=server.drain().then(result=>{finished=true;return result;});await cleaning;await closed;await new Promise<void>(r=>setImmediate(r));
  if(timeout){const result=await drain;assert.equal(result.status,'unsettled');assert.equal(result.timedOut,true);assert.equal(cleaned,false);release();}
  else{assert.equal(finished,false,'drain must wait for adapter finally');release();assert.deepEqual(await drain,{status:'drained',timedOut:false});assert.equal(cleaned,true);}
  await capture;await server.browserSessions.drain();
 }
});

test('monthly budget waiting and journal replay preserve the same browser observation',async()=>{
 const s=await setup();await s.service.capture(request);const page=(await s.service.read('intake','work')).session!.page;
 const app=new Application(s.store,[{id:'runtime-representative',roles:['representative']},{id:'local-owner',roles:['owner']}]);
 await app.dispatch({missionId:'intake',expectedRevision:3,commandId:'monthly-wait',actorId:'runtime-representative',command:{type:'wait-monthly-budget',workId:'work',decisionId:'monthly-budget:fixture'}});
 const waiting=(await s.store.load('intake'))!.value.works[0]!;assert.equal(waiting.execution,'budget-waiting');assert.equal(waiting.monthlyBudgetDecision,'monthly-budget:fixture');assert.deepEqual(waiting.browserSession!.pages[0],page);validateMissionJournalLineage(s.store.inspect());
 await app.dispatch({missionId:'intake',expectedRevision:4,commandId:'monthly-resume',actorId:'local-owner',command:{type:'resume-monthly-budget',workId:'work',decisionId:'monthly-budget:fixture'}});assert.deepEqual((await s.service.read('intake','work')).session!.page,page);validateMissionJournalLineage(s.store.inspect());
});
