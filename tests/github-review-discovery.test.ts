import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
import {hash,workInputHash} from '../src/domain.ts';
import type {Mission,Command} from '../src/domain.ts';
import {MissionCatalogChangedError} from '../src/mission-catalog.ts';
import type {MissionCatalogReader,MissionCatalogInput} from '../src/mission-catalog.ts';
import * as reviews from '../src/github-review.ts';
import {AppsService} from '../src/apps.ts';
import {createWorkbench} from '../src/server.ts';
import {githubFixture} from '../src/app-catalog.ts';
import {workerCommand} from '../src/app-sandbox.ts';

async function fixture(){
 const store=new InMemoryStore<Mission>(),owner={id:'local-owner',roles:['owner' as const]},rep={id:'runtime-representative',roles:['representative' as const]},executor={id:'executor',roles:['executor' as const]},app=new Application(store,[owner,rep,executor]);
 const ids=Array.from({length:20},(_,i)=>'empty:'+String(i).padStart(2,'0')).concat('ordinary');
 for(const id of ids)await app.create({id,purpose:'Stored '+id,scope:'local',constraints:[],criteria:{version:1,description:'Review exact PR',oracle:'review'}},owner.id,'create:'+id);
 let revision=1;const send=async(command:Command,actorId=owner.id)=>{const result=await app.dispatch({missionId:'ordinary',commandId:'ordinary:'+revision,expectedRevision:revision++,actorId,command});assert.equal(result.status,'committed');};
 const p=JSON.parse(githubFixture('https://api.github.com/repos/jabdori/massion/pulls/84').body),target={repository:'jabdori/massion',number:84,headSha:p.head.sha,url:p.html_url};
 await send({type:'admit-work',workId:'review',title:'Review ordinary PR',budget:100});
 const document=reviews.githubReviewDocument(target,'document:pr-review');await send({type:'capture-document',document});
 const stored=(await store.load('ordinary'))!.value.documents![0]!;await send({type:'attach-work-source',workId:'review',documentId:stored.id,version:stored.version,contentSha256:stored.contentSha256,reason:'Review this head'});
 const w=(await store.load('ordinary'))!.value.works[0]!;await send({type:'activate-runtime',workId:w.id,run:{id:'ordinary-run',authorizationId:'fixture',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:10,ownership:{hostSessionId:'fixture',dispatchId:'fixture',startedAt:Date.now(),deadlineAt:Date.now()+120000}}});
 await send({type:'assign',workId:w.id,assignment:{id:'executor',actorId:executor.id,role:'executor',taskId:w.id+':root',model:{provider:'fixture',model:'deterministic',configVersion:'v1',reason:'Data-only fixture',evidenceClass:'fixture'},extensionVersion:'v1'}},rep.id);
 await send({type:'admit-effect',workId:w.id,effect:{id:'read-pr',taskId:w.id+':root',status:'pending',target:'Local fixture PR read',authority:'fixture'},reserve:1},executor.id);
 const queries:MissionCatalogInput[]=[],catalog:MissionCatalogReader={async readCatalog(input){queries.push(structuredClone(input));const state=await store.readState();if(input.feedId&&input.feedId!==state.feedId)throw new MissionCatalogChangedError('feed');if(input.cursor!==undefined&&input.cursor!==state.cursor)throw new MissionCatalogChangedError('cursor');const remaining=ids.filter(id=>id>(input.after??'')),page=remaining.slice(0,20),items=await Promise.all(page.map(async id=>{const s=(await store.load(id))!;return {missionId:id,revision:s.revision,version:s.value.version,purpose:s.value.purpose,scope:s.value.scope,workCount:s.value.works.length};}));return {feedId:state.feedId,cursor:state.cursor,items,nextAfter:remaining.length>20?page.at(-1)!:null,limit:20};}};
 return {store,catalog,queries,target};
}

test('catalog discovery finds ordinary review Work beyond its first page without conversation provenance',async()=>{
 const f=await fixture(),before=f.store.inspect(),feed=(await f.store.readState()).feedId;
 const missions=await reviews.readGithubReviewMissions(f.store,f.catalog,feed);
 assert.deepEqual(missions.map((m:Mission)=>m.id),['ordinary']);assert.equal(missions[0]!.works[0]!.assistantSource,undefined);assert.deepEqual(reviews.githubReviews(missions[0]!,f.target,Date.now()).map(r=>r.workId),['review']);
 assert.equal(f.queries.length,2);assert.equal(f.queries[1]!.after,'empty:19');assert.equal(f.queries[1]!.feedId,feed);assert.equal(f.queries[1]!.cursor,(await f.store.readState()).cursor);assert.deepEqual(f.store.inspect(),before);
});

test('catalog discovery rejects replaced feeds and changed page boundaries without returning partial reviews',async()=>{
 for(const reason of ['feed','cursor'] as const){const f=await fixture(),read=f.catalog.readCatalog.bind(f.catalog);f.catalog.readCatalog=async input=>{const page=await read(input);return input.after?{...page,...reason==='feed'?{feedId:'replacement'}:{cursor:page.cursor+1}}:page;};await assert.rejects(reviews.readGithubReviewMissions(f.store,f.catalog,(await f.store.readState()).feedId),MissionCatalogChangedError);}
});

test('GitHub page and room item HTTP reads include a bound ordinary Mission', {skip:workerCommand()===null&&'no network sandbox'},async t=>{
 const f=await fixture(),apps=new AppsService(f.store,{network:async r=>githubFixture(r.url)});await apps.act({commandId:'install',action:'install',catalogId:'github'});await apps.decide({commandId:'decide',decisionId:(await apps.decisions(null))[0]!.id,answer:'act'});
 const server=createWorkbench(f.store,process.cwd(),{scheduleIntervalMs:0,catalog:f.catalog,appNetwork:async r=>githubFixture(r.url)});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.drain());
 const before=f.store.inspect(),base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 for(const handler of ['page','item']){const response=await fetch(base+'/assistant/apps/view',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app:'app-github',handler,...handler==='item'?{ref:'84'}:{}})}),body=await response.json() as any;assert.equal(response.status,200);const rows=handler==='item'?body.reviews:body.groups.flatMap((g:any)=>g.rows).find((r:any)=>r.id==='84').reviews;assert.deepEqual(rows.map((r:any)=>[r.missionId,r.workId]),[['ordinary','review']]);}
 assert.deepEqual(f.store.inspect(),before);
});
