import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {request} from 'node:http';
import {workbenchPage} from '../src/workbench.ts';
import {hash,workInputHash} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';

const screens=(await readdir(new URL('../docs/product/screens/contracts/',import.meta.url))).filter(f=>f.endsWith('.json')).map(f=>f.slice(0,-5)).sort();
const fixtureDir=new URL('../scripts/ui-contracts/fixtures/',import.meta.url);

test('every approved screen has its own explicit fixture and setup metadata',async()=>{
 const files=await readdir(fixtureDir).catch(()=>[]);
 assert.deepEqual(files.filter(f=>f.endsWith('.json')).sort(),screens.map(s=>s+'.json').sort());
 assert.equal(screens.length,75);
 const {loadFixture}=await hostModule();
 const states=new Set<string>();
 for(const screen of screens){
  const raw=JSON.parse(await readFile(new URL(screen+'.json',fixtureDir),'utf8'));
  const fixture=await loadFixture(screen);
  assert.equal(fixture.screen,screen);
  assert.ok(fixture.description.length>0,screen);
  assert.ok(Array.isArray(fixture.steps),screen);
  assert.ok(Array.isArray(fixture.gaps)&&fixture.gaps.every((g:unknown)=>typeof g==='string'&&g.length>0),screen);
  assert.ok(fixture.readySelector,screen);
  for(const step of fixture.steps){if(step.action==='offline')assert.ok(['true','false'].includes(step.value));else{assert.ok(step.selector,screen);assert.ok(['click','fill'].includes(step.action),screen);if(step.action==='fill')assert.equal(typeof step.value,'string');}}
  assert.ok(fixture.routes['/assistant/conversation'],screen);
  const state=JSON.stringify([fixture.steps,fixture.routes]);
  assert.ok(!states.has(state)||raw.extends&&raw.gaps?.length,'Duplicate state without explicit unsupported-state gap: '+screen);states.add(state);
 }
});

test('started Work snapshots have assigned executors and consistent task, attempt and acceptance evidence',async()=>{
 const {loadFixture}=await hostModule();
 for(const screen of screens){
  const f=await loadFixture(screen);
  assert.equal(f.now,screen==='B22-room-steps'?Date.UTC(2026,10,5,1,44):screen==='B16'?Date.UTC(2026,10,5,0,12):['B16-sent','B16-later'].includes(screen)?Date.UTC(2026,10,5,0,13):1793855520000,screen);
  const mission=(f.routes['/missions/intake']?.body as {value:Mission}|undefined)?.value;
  if(!mission)continue;
  const summaries=(f.routes['/assistant/works']!.body as {works:Array<{workId:string;execution:string;acceptance:string;unknown:boolean;started:boolean}>}).works;
  assert.ok(summaries.every(s=>mission.works.some(w=>w.id===s.workId)),screen);
  for(const work of mission.works){
   const summary=summaries.find(s=>s.workId===work.id);
   if(!summary){assert.equal(work.id,'rounding-source');assert.equal(work.execution,'queued');assert.equal(work.runtimeRun,undefined);assert.equal(work.assistantSource,undefined);assert.deepEqual(work.effects,[]);continue;}
   assert.equal(work.execution,summary.execution,screen);assert.equal(work.acceptance,summary.acceptance,screen);
   if(!summary.started&&work.browserSession){assert.equal(work.execution,'queued');assert.equal(work.attempts[0]!.status,'queued');assert.equal(work.effects.length,0);continue;}
   assert.ok(work.assignments.some(a=>a.role==='executor'),screen+' '+work.id+' executor');
   assert.ok(work.tasks.length,screen);assert.notEqual(work.attempts[0]!.status,'queued',screen);
   if(summary.unknown){assert.ok(work.effects.some(e=>e.status==='unknown'),screen);assert.equal(work.record,undefined,screen);}
   if(work.acceptance==='failed'){assert.equal(work.verdict?.status,'failed',screen);assert.equal(work.record,undefined,screen);}
   if(work.acceptance==='accepted'){
    assert.equal(work.verdict?.status,'passed',screen);assert.ok(work.artifact,screen);assert.ok(work.record,screen);
    const {checksum,...record}=work.record!;assert.equal(checksum,hash(record),screen);assert.equal(record.evidenceClass,'fixture',screen);
    const binary=record.artifact.kind!=='text',encode=binary?encodeURIComponent:(value:string)=>value;
    const path='/missions/intake/'+(binary?'record-binary-artifact':'record-artifact')+'?work='+encode(work.id)+'&record='+encode(record.id)+'&version=1&sha256='+record.artifact.sha256;
    assert.ok(f.routes[path],screen+' exact accepted route: '+path);
    const reply=f.routes[path]!.body as {artifact:{id:string;sha256:string};criteriaVersion:number;recordChecksum:string};
    assert.equal(reply.artifact?.id,record.artifact.id,screen);assert.equal(reply.criteriaVersion,record.criteria.version,screen);assert.equal(reply.recordChecksum,checksum,screen);
   }
  }
 }
});

const hostModule=()=>import('../scripts/ui-contracts/fixture-host.ts');

test('B24 and B25 installation fixtures retain background Work, result replies and source identity',async()=>{
 const {loadFixture}=await hostModule();
 for(const screen of ['B24','B24-done','B24-later','B25','B25-done','B25-later']){
  const fixture=await loadFixture(screen),works=(fixture.routes['/assistant/works']!.body as any).works;
  assert.ok(works.some((w:any)=>w.workId==='churn'&&w.execution==='active'),screen);
  assert.ok(works.some((w:any)=>w.workId==='pricing'&&w.execution===(screen.startsWith('B24')?'active':'waiting')),screen);
  const view=fixture.routes[screen.startsWith('B25')?'/assistant/conversation?member=member-juno':'/assistant/conversation']!.body as any;
  if(screen.startsWith('B24')&&screen!=='B24')assert.ok(view.segment.messages.some((m:any)=>m.role==='representative'),screen);
  if(screen==='B25'){
   assert.deepEqual(view.decisions[0].source,{missionId:'intake',workId:'pr84',title:'PR #84 검토'});
   assert.ok(view.decisions[0].at>view.turns[0].at,'the install proposal follows its source Work');
  }
 }
});

test('the host serves the real page and isolated deterministic screen responses on loopback',async t=>{
 const {startFixtureHost,loadFixture}=await hostModule();
 const a=await startFixtureHost('B17'),b=await startFixtureHost('B17-empty');
 t.after(()=>a.close());t.after(()=>b.close());
 assert.equal(new URL(a.url).hostname,'127.0.0.1');assert.notEqual(a.url,b.url);
 const page=await fetch(a.url);assert.equal(await page.text(),workbenchPage);
 const policy=page.headers.get('content-security-policy')!;
 for(const directive of ["default-src 'self'","connect-src 'self'","form-action 'none'","base-uri 'none'","object-src 'none'"])assert.ok(policy.includes(directive),directive);
 assert.match(policy,/script-src 'self' 'sha256-/);assert.ok(!/script-src[^;]*unsafe/.test(policy));
 assert.equal(page.headers.get('cache-control'),'no-store');
 assert.deepEqual(await (await fetch(a.url+'__fixture')).json(),await loadFixture('B17'));
 const full=await (await fetch(a.url+'assistant/schedules')).json();
 const empty=await (await fetch(b.url+'assistant/schedules')).json();
 assert.equal(full.schedules.length,4);assert.deepEqual(empty.schedules,[]);
 assert.deepEqual(await (await fetch(a.url+'assistant/schedules')).json(),full);
 const loaded=await loadFixture('B17');loaded.gaps.push('Local mutation');
 assert.ok(!(await loadFixture('B17')).gaps.includes('Local mutation'));
 await a.close();await a.close();await assert.rejects(fetch(a.url));
 assert.equal((await fetch(b.url)).status,200);
});

test('unknown screens, routes, query values and all write methods fail closed',async t=>{
 const {startFixtureHost,loadFixture}=await hostModule();
 for(const screen of ['B999','../B2','B2.json','/B2','B2%2f..',''])await assert.rejects(loadFixture(screen));
 const host=await startFixtureHost('B2');t.after(()=>host.close());
 for(const path of ['unknown','src/workbench.ts','assistant/conversation?member=missing','assistant/conversation?unexpected=1','events?after=-1','events?after=1&extra=1'])assert.equal((await fetch(host.url+path)).status,404,path);
 for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS','HEAD'])for(const path of ['','__fixture','assistant/conversation','assistant/apps/view','fixture-run']){
  const reply=await fetch(host.url+path,{method});assert.equal(reply.status,405,method+' '+path);assert.equal(reply.headers.get('allow'),'GET');
 }
 assert.equal((await fetch(host.url+'events?after=999')).status,200);
 assert.equal((await fetch(host.url,{headers:{Origin:'https://example.invalid'}})).status,403);
 const status=await new Promise<number>(resolve=>{
  const req=request(host.url,{headers:{Host:'example.invalid'}},res=>{res.resume();resolve(res.statusCode!);});req.end();
 });assert.equal(status,403);
});

test('state variants preserve acceptance and uncertainty instead of pretending to be a generic conversation',async()=>{
 const {loadFixture}=await hostModule();
 for(const [screen,execution,acceptance,unknown] of [
  ['B3','active','pending',false],['B3-run','active','pending',false],
  ['B7','active','pending',false],['B7-done','settled','accepted',false],
  ['B7-fail','settled','failed',false],['B7-unknown','blocked','pending',true],
 ] as const){
  const f=await loadFixture(screen),body=f.routes['/assistant/works']!.body as {works:Array<{execution:string;acceptance:string;unknown:boolean}>};
  assert.equal(body.works[0]!.execution,execution,screen);assert.equal(body.works[0]!.acceptance,acceptance,screen);assert.equal(body.works[0]!.unknown,unknown,screen);
 }
 for(const screen of ['B22','B22-room'])assert.ok((await loadFixture(screen)).appViews?.length,screen);
 for(const screen of ['B20','B20-coding']){
  const fixture=await loadFixture(screen),group=screen==='B20'?'research':'coding';
  assert.ok(fixture.steps.some(s=>'selector' in s&&s.selector==='#settings-group-'+group&&s.readySelector==='#settings-group-name'),screen);
  const catalog=fixture.routes['/connections']!.body as {modelGroups:Array<{id:string;models:Array<{profileId:string;configHash:string}>}>};
  assert.ok(catalog.modelGroups.find(g=>g.id===group)!.models.every(m=>m.profileId&&/^[a-f0-9]{64}$/.test(m.configHash)),screen);
 }
});

test('only declared read-only app views accept bounded exact JSON POST bodies',async t=>{
 const {startFixtureHost}=await hostModule(),host=await startFixtureHost('B22');t.after(()=>host.close());
 const post=(body:string,path='assistant/apps/view')=>fetch(host.url+path,{method:'POST',headers:{'content-type':'application/json'},body});
 const page=await post(JSON.stringify({app:'app-github',handler:'page'}));assert.equal(page.status,200);assert.equal((await page.json()).title,'GitHub');
 const item=await post(JSON.stringify({ref:'84',handler:'item',app:'app-github'}));assert.equal(item.status,200);assert.match((await item.json()).title,/#84/);
 for(const body of [{app:'unknown',handler:'page'},{app:'app-github',handler:'item',ref:'missing'},{app:'app-github',handler:'page',command:'install'}])assert.equal((await post(JSON.stringify(body))).status,404);
 assert.equal((await post('{')).status,400);assert.equal((await post('"'+'x'.repeat(9000)+'"')).status,413);
 assert.equal((await post('{}','assistant/apps')).status,405);
 assert.equal((await fetch(host.url+'assistant/apps/view',{method:'POST',headers:{Origin:'https://example.invalid','content-type':'application/json'},body:'{}'})).status,403);
});

test('inherited fixtures resolve routes without aliasing parents and reject cycles and invalid parent paths',async t=>{
 const {loadFixture}=await hostModule();
 const {writeFile,rm}=await import('node:fs/promises');
 const paths=['B99','B98'].map(s=>new URL(s+'.json',fixtureDir));
 t.after(async()=>{for(const path of paths)await rm(path,{force:true});});
 await writeFile(paths[0]!,JSON.stringify({screen:'B99',extends:'../B2'}));
 await assert.rejects(loadFixture('B99'),/Unknown fixture/);
 await writeFile(paths[0]!,JSON.stringify({screen:'B99',extends:'B98'}));
 await writeFile(paths[1]!,JSON.stringify({screen:'B98',extends:'B99'}));
 await assert.rejects(loadFixture('B99'),/cycle/i);
 const parent=await loadFixture('B13'),child=await loadFixture('B13-general');
 assert.deepEqual(child.routes,parent.routes);
 assert.notDeepEqual(child.steps,parent.steps);
 child.routes['/assistant/conversation']!.status=500;
 assert.equal((await loadFixture('B13')).routes['/assistant/conversation']!.status,200);
});

test('completed and deferred v2 decisions render the declared readiness node without submitting commands',async()=>{
 const {harness,reply,settle}=await import('./support/workbench-client.ts');
 const {loadFixture}=await hostModule();
 for(const screen of ['B21-done-hana','B24-connect-later']){
  const f=await loadFixture(screen);
  const app=harness(async(path,options)=>{
   assert.notEqual(options?.method,'POST');
   const response=f.routes[path]||f.routes[path.startsWith('/events?')?'/events':''];
   return reply(response?.body??{error:'No fixture response'},response?.status??404);
  });
  await settle();
  assert.ok(app.all().some(n=>n.id===f.readySelector.slice(1)),screen+' readiness node must be rendered');
  if(screen==='B21-done-hana'){const memberId=(f.routes['/assistant/conversation']!.body as {decisions:{memberId:string}[]}).decisions[0]!.memberId;assert.ok(app.all().some(n=>n.id==='side-member-'+memberId),'the actually admitted member must appear in the sidebar');}
  for(const d of (f.routes['/assistant/conversation']!.body as {decisions:{id:string}[]}).decisions)
   assert.ok(app.all().some(n=>n.id==='chat-system-'+d.id),screen+' completed/deferred decision must not be discarded');
 }
});
test('screen fixtures serve the versioned client and idle SSE without admitting product writes',async t=>{
 const {startFixtureHost}=await hostModule(),host=await startFixtureHost('B22');t.after(()=>host.close());
 const post=async(path:string,body:unknown)=>fetch(host.url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const header={version:1,requestId:'fixture-protocol',generation:1};
 const hello=await post('protocol/connect',{...header,supported:{min:1,max:1}});assert.equal(hello.status,200);assert.equal((await hello.json()).payload.state,'ready');
 const query=await post('protocol/request',{...header,kind:'query',path:'/assistant/conversation'});assert.equal(query.status,200);assert.deepEqual((await query.json()).payload,host.fixture.routes['/assistant/conversation']!.body);
 const command=await post('protocol/request',{...header,kind:'command',path:'/missions',payload:{}});assert.equal(command.status,405);assert.equal((await command.json()).requestId,header.requestId);
 const appView=await post('protocol/request',{...header,kind:'command',path:'/assistant/apps/view',payload:{app:'app-github',handler:'page'}});assert.equal(appView.status,200);assert.equal((await appView.json()).payload.title,'GitHub');
 const incompatible=await post('protocol/request',{...header,version:99,kind:'query',path:'/assistant/conversation'});assert.equal(incompatible.status,426);
 const abort=new AbortController();t.after(()=>abort.abort());const stream=await fetch(host.url+'protocol/events?version=1&requestId=fixture-feed&generation=2&after=0',{signal:abort.signal});assert.equal(stream.status,200);const frame=new TextDecoder().decode((await stream.body!.getReader().read()).value);assert.match(frame,/"kind":"feed"/);assert.match(frame,/"reason":"connected"/);abort.abort();
});

test('offline fixtures use browser disconnection and failed send stays local before any product write',async()=>{
 const {loadFixture}=await hostModule();
 const offline=await loadFixture('B2-offline'),failed=await loadFixture('B2-offline-failed');
 assert.equal(offline.gaps.length,0);assert.equal(failed.gaps.length,0);
 assert.ok(offline.steps.some(step=>step.action==='offline'));
 assert.ok(failed.steps.some(step=>step.action==='offline'));
 assert.deepEqual(failed.steps.filter(step=>step.action==='offline').map(step=>step.value),['true','false']);
 const click=failed.steps.findIndex(step=>step.action==='click'&&step.selector==='#chat-send'),disconnected=failed.steps.findIndex(step=>step.action==='offline'&&step.value==='true'),connected=failed.steps.findIndex(step=>step.action==='offline'&&step.value==='false');assert.ok(disconnected<click&&click<connected);
 const host=await (await hostModule()).startFixtureHost('B2-offline-failed');
 try{assert.equal((await fetch(host.url+'assistant/messages',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,405);}finally{await host.close();}
});


test('recorded example hues remain stable and regenerated admission uses the host palette',async()=>{
 const {loadFixture}=await hostModule();
 for(const screen of ['B2','B12','B13','B14']){
  const fixture=await loadFixture(screen),view=fixture.routes['/assistant/conversation']!.body as {members:{id:string;name:string;look:{color:string}}[]};
  assert.equal(view.members.find(m=>m.name==='주노')!.look.color,screen==='B13'?'agent-2':'agent-6',screen);
  assert.equal(view.members.find(m=>m.name==='퀼')!.look.color,'agent-1',screen);
 }
});

test('conversation fixtures keep the supported histories and navigation of their approved states',async()=>{
 const {loadFixture}=await hostModule();
 const picker=await loadFixture('B11'),view=picker.routes['/assistant/conversation']!.body as any;
 assert.equal(view.segment.messages.length,2,'B11 is one calculation before the picker, not the unrelated B2 backlog');assert.deepEqual(view.decisions,[]);
 const member=await loadFixture('B6');assert.ok(member.steps.some(step=>step.action==='click'&&step.selector==='#side-member-member-quill'));
 const activity=await loadFixture('B16');assert.ok(activity.steps.some(step=>step.action==='click'&&step.selector==='#activity-toggle'));
 for(const screen of ['B4','B5','B6','B6-token','B18','B26','B26-later']){
  const state=await loadFixture(screen),body=state.routes['/assistant/conversation']!.body as any;
  assert.ok(body.apps.some((app:any)=>app.id==='github'&&app.page),screen+' installed rail app is real fixture data');
 }
});

test('B22 steps setup opens the Work room without expanding legacy evidence',async()=>{
 const {loadFixture}=await hostModule(),fixture=await loadFixture('B22-room-steps');
 assert.equal(fixture.steps.length,2);
 assert.ok(fixture.steps.every(s=>!('selector' in s)||!s.selector.includes('evidence')&&!s.selector.includes('work-room-check')));
 const work=(fixture.routes['/missions/intake']!.body as any).value.works[0];assert.deepEqual(work.tasks.filter((t:any)=>t.step).map((t:any)=>t.step.title),['읽기','테스트 돌리기']);
});

test('E6c effect fixtures use production decision sources',async()=>{
 const {loadFixture}=await hostModule();
 for(const screen of ['B4','B16','B16-sent','B16-later']){
  const fixture=await loadFixture(screen);
  for(const [path,response] of Object.entries(fixture.routes))if(path.startsWith('/assistant/conversation')){
   const view=response.body as any;
   if(['B26','B26-later'].includes(screen)||path!=='/assistant/conversation')assert.deepEqual(view.decisions??[],[],screen+' '+path+' must not imply an unimplemented owner decision');
   else {assert.equal(view.decisions.filter((d:any)=>d.effect).length,1);const d=view.decisions.find((d:any)=>d.effect),mission=(fixture.routes['/missions/intake']!.body as any).value,source=mission.works.find((w:any)=>w.id===d.effect.workId).effects.find((e:any)=>e.id===d.id);assert.deepEqual(d.effect.request,source.ownerDecision.request);assert.equal(d.effect.status,source.status);assert.equal(d.state,screen==='B16-sent'?'done':screen==='B16-later'?'later':'open');}
  }
  if(screen.startsWith('B16')){const decisions=(fixture.routes['/assistant/conversation']!.body as any).decisions;assert.ok(decisions.some((d:any)=>d.ruleChange?.cases?.orders.length===3));assert.ok(!fixture.gaps.some(g=>g.includes('rounding-rule')));}else if(screen!=='B4')assert.ok(fixture.gaps.length,screen+' must explain the remaining absent producer');
 }
});

test('E3e member room reads reuse exact host Work sources and child tasks',async()=>{
 const {loadFixture}=await hostModule();
 for(const screen of ['B6','B18-room-b']){
  const f=await loadFixture(screen),mission=(f.routes['/missions/intake']!.body as any).value;
  assert.ok(mission.works.every((w:any)=>w.assistantSource&&w.tasks.some((t:any)=>t.parentId!==null)),screen);
  const member=(f.routes['/assistant/conversation?member=member-quill']!.body as any);
  assert.ok(member.turns.every((t:any)=>!t.work&&!t.proposal&&!t.outcome),screen+' member discussion cannot admit Work');
 }
});

test('B26 budget fallbacks never expose the unrelated rounding evaluation conversation',async()=>{
 const {loadFixture}=await hostModule();
 for(const screen of ['B26','B26-later']){
  const fixture=await loadFixture(screen);
  assert.doesNotMatch(JSON.stringify(fixture),/TOTAL: [34] cents/);
  for(const [path,response] of Object.entries(fixture.routes))if(path.startsWith('/assistant/conversation')){
   const view=response.body as any;
   assert.doesNotMatch(JSON.stringify(view.segment?.messages??[]),/TOTAL: [34] cents|3센트 상품|반올림/);
  }
 }
});

test('memory screen candidates come from answered production turns and remain owner proposals',async()=>{const {loadFixture}=await hostModule();for(const screen of ['B6','B7-churn','B7-fail','B18','B18-room-b']){const fixture=await loadFixture(screen),view=fixture.routes['/assistant/conversation?member=member-quill']!.body as any,turn=view.turns.find((t:any)=>t.memoryCandidate);assert.equal(turn.status,'answered');assert.equal(turn.memoryCandidate.status,'proposed');assert.equal(turn.memoryCandidate.memberId,'member-quill');assert.ok(view.segment.messages.some((m:any)=>m.turnId===turn.id));}});

test('rule capture keeps the proposal visible and briefings refer to decisions instead of phantom Work',async()=>{const {loadFixture}=await hostModule();for(const screen of ['B2','B9','B9-restart','B9-update']){const f=await loadFixture(screen),view=f.routes['/assistant/conversation']!.body as any,summaries=f.routes['/assistant/works']!.body as any;assert.deepEqual(f.captureScroll,{selector:'#chat-scroll',top:0});assert.equal(view.decisions.find((d:any)=>d.ruleChange).ruleChange.revision,(f.routes['/missions/intake']!.body as any).revision);assert.ok(!summaries.works.some((w:any)=>w.workId==='rounding-work'));assert.ok(view.briefings.some((b:any)=>b.decisionIds.includes(view.decisions.find((d:any)=>d.ruleChange).id)));}});
test('R-A fixtures come from timed command producers and retain named worker dependencies and skips',async()=>{
 const {loadFixture}=await hostModule();
 for(const screen of ['B7','B7-churn','B7-done','B7-fail','B7-unknown']){
  const fixture=await loadFixture(screen),work=(fixture.routes['/missions/intake']!.body as any).value.works[0];
  assert.ok(Number.isSafeInteger(work.admittedAt),screen+' admission observation');
  if(work.verdict)assert.ok(Number.isSafeInteger(work.verdict.checkedAt),screen+' check observation');
  if(screen==='B7-churn'){
   const steps=work.tasks.filter((t:any)=>t.step);assert.equal(steps.length,5);assert.ok(steps[1].step.dependsOn.includes(steps[0].id));
   assert.ok(Number.isSafeInteger(steps[0].startedAt));assert.ok(steps[0].endedAt>=steps[0].startedAt);
   assert.equal(steps[3].startedAt,undefined);assert.ok(Number.isSafeInteger(steps[3].endedAt));
  }
 }
});

test('browser fixture reads retain their exact Work inputs and redacted form values',async()=>{
 const {loadFixture}=await hostModule();
 for(const screen of ['B4','B5','B15','B7']){const f=await loadFixture(screen),mission=(f.routes['/missions/intake']!.body as {value:Mission}).value,w=mission.works.find(w=>w.browserSession)!;assert.ok(w,screen);for(const page of w.browserSession!.pages){assert.equal(page.inputHash,workInputHash(w),screen);if(page.tainted)assert.equal('title' in page,false);else assert.ok(page.fields.filter(f=>f.masked).every(f=>f.value===''));}const query=f.routes['/missions/intake/works/'+w.id+'/browser']!.body as any;assert.equal(query.session.pagesRead,w.browserSession!.pages.length);assert.deepEqual(query.session.page,w.browserSession!.pages.at(-1));if(screen==='B7')assert.ok(!f.gaps.some(g=>g.includes('browser/page-read telemetry is absent')));}
});

test('failed churn keeps its command-produced procedure, worker messages and failed independent check',async()=>{
 const {loadFixture}=await hostModule(),fixture=await loadFixture('B7-fail'),mission=(fixture.routes['/missions/intake']!.body as any).value as Mission,work=mission.works[0]!,steps=work.tasks.filter(t=>t.step);
 assert.deepEqual(steps.map(t=>t.step!.title),['범위 정하기','자료 모으기','나누기','설문 다시 보내기','원인 정리']);
 assert.ok(steps.every(t=>t.status==='settled'&&Number.isSafeInteger(t.endedAt)));
 assert.equal(steps[3]!.startedAt,undefined);assert.equal(steps[3]!.step!.skipReason,'지난달 설문 있음');
 assert.equal(steps.filter(t=>t.step!.instruction&&t.result&&!t.step!.skipReason).length,3);
 assert.ok(work.tasks.every(t=>t.status==='settled'));assert.equal(work.acceptance,'failed');assert.equal(work.verdict!.status,'failed');assert.equal(work.record,undefined);
 for(const route of Object.values(fixture.routes) as any[])for(const row of [...(route.body?.works??[]),...(route.body?.turns??[]).flatMap((t:any)=>t.work?[t.work]:[])])if(row.workId===work.id){assert.equal(row.workerSteps.length,5);assert.deepEqual(row.steps,{done:5,total:5});}
});

test('E8 monthly decision fixtures carry the production budget read and explicit owner deferral',async()=>{
 const {loadFixture}=await hostModule();for(const screen of ['B26','B26-later']){const fixture=await loadFixture(screen),conversation=fixture.routes['/assistant/conversation']!.body as any,usage=fixture.routes['/assistant/usage']!.body as any;assert.equal(conversation.decisions.length,1);const d=conversation.decisions[0];assert.ok(d.id.startsWith('monthly-budget:'));assert.equal(d.state,screen==='B26'?'open':'later');assert.equal(d.budget.revision,usage.revision);assert.equal(usage.unit,'output-tokens');assert.equal(usage.cost,null);assert.deepEqual(fixture.gaps,[]);assert.doesNotMatch(JSON.stringify(conversation),/TOTAL: [34] cents/);}
});
