import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {request} from 'node:http';
import {workbenchPage} from '../src/workbench.ts';
import {hash} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';

const screens='B1 B1-signin B2 B3 B3-run B4 B5 B6 B7 B7-churn B7-done B7-fail B7-unknown B8 B8-done B8-fail B8-unknown B9 B10 B10-preview B11 B11-quill B12 B13 B13-devices B14 B15 B16 B16-later B16-sent B17 B17-empty B18 B18-room-b B19 B19-juno B20 B20-coding B21 B21-name B22 B22-room B22-room-steps B23 B23-github B24 B24-done B24-later B25 B25-done B25-later'.split(' ').sort();
const fixtureDir=new URL('../scripts/ui-contracts/fixtures/',import.meta.url);

test('every approved screen has its own explicit fixture and setup metadata',async()=>{
 const files=await readdir(fixtureDir).catch(()=>[]);
 assert.deepEqual(files.filter(f=>f.endsWith('.json')).sort(),screens.map(s=>s+'.json').sort());
 const states=new Set<string>();
 for(const screen of screens){
  const fixture=JSON.parse(await readFile(new URL(screen+'.json',fixtureDir),'utf8'));
  assert.equal(fixture.screen,screen);
  assert.ok(fixture.description.length>0,screen);
  assert.ok(Array.isArray(fixture.steps),screen);
  assert.ok(Array.isArray(fixture.gaps)&&fixture.gaps.every((g:unknown)=>typeof g==='string'&&g.length>0),screen);
  assert.ok(fixture.readySelector,screen);
  for(const step of fixture.steps){assert.ok(step.selector,screen);assert.ok(['click','fill'].includes(step.action),screen);if(step.action==='fill')assert.equal(typeof step.value,'string');}
  assert.ok(fixture.routes['/assistant/conversation'],screen);
  const state=JSON.stringify([fixture.steps,fixture.routes]);
  assert.ok(!states.has(state),'Duplicate state without distinct setup: '+screen);states.add(state);
 }
});

test('started Work snapshots have assigned executors and consistent task, attempt and acceptance evidence',async()=>{
 const {loadFixture}=await hostModule();
 for(const screen of screens){
  const f=await loadFixture(screen);
  assert.equal(f.now,1793855520000,screen);
  const mission=(f.routes['/missions/intake']?.body as {value:Mission}|undefined)?.value;
  if(!mission)continue;
  const summaries=(f.routes['/assistant/works']!.body as {works:Array<{workId:string;execution:string;acceptance:string;unknown:boolean}>}).works;
  assert.deepEqual(mission.works.map(w=>w.id),summaries.map(w=>w.workId),screen);
  for(const work of mission.works){
   const summary=summaries.find(s=>s.workId===work.id)!;
   assert.equal(work.execution,summary.execution,screen);assert.equal(work.acceptance,summary.acceptance,screen);
   assert.ok(work.assignments.some(a=>a.role==='executor'),screen+' '+work.id+' executor');
   assert.ok(work.tasks.length,screen);assert.notEqual(work.attempts[0]!.status,'queued',screen);
   if(summary.unknown){assert.ok(work.effects.some(e=>e.status==='unknown'),screen);assert.equal(work.record,undefined,screen);}
   if(work.acceptance==='failed'){assert.equal(work.verdict?.status,'failed',screen);assert.equal(work.record,undefined,screen);}
   if(work.acceptance==='accepted'){
    assert.equal(work.verdict?.status,'passed',screen);assert.ok(work.artifact,screen);assert.ok(work.record,screen);
    const {checksum,...record}=work.record!;assert.equal(checksum,hash(record),screen);assert.equal(record.evidenceClass,'fixture',screen);
    const path='/missions/intake/record-artifact?work='+work.id+'&record='+record.id+'&version=1&sha256='+record.artifact.sha256;
    const reply=f.routes[path]!.body as {artifact:{id:string;sha256:string};criteriaVersion:number;recordChecksum:string};
    assert.equal(reply.artifact?.id,record.artifact.id,screen);assert.equal(reply.criteriaVersion,record.criteria.version,screen);assert.equal(reply.recordChecksum,checksum,screen);
   }
  }
 }
});

const hostModule=()=>import('../scripts/ui-contracts/fixture-host.ts');

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
 assert.equal(full.schedules.length,1);assert.deepEqual(empty.schedules,[]);
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
 for(const screen of ['B20','B20-coding'])assert.ok((await loadFixture(screen)).gaps.some(g=>g.includes('editor')),screen);
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
