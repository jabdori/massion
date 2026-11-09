import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,createMission,documentContentHash} from '../src/domain.ts';
import {githubReviews,githubReviewDocument} from '../src/github-review.ts';
import {checkView,runHandler,workerCommand} from '../src/app-sandbox.ts';
import {GITHUB_APP,githubFixture} from '../src/app-catalog.ts';

const owner={id:'local-owner',roles:['owner' as const]},target={repository:'jabdori/massion',number:84,headSha:'a'.repeat(40),url:'https://github.com/jabdori/massion/pull/84'};
function mission(){let m=createMission({id:'intake',purpose:'Review',scope:'Code',constraints:[],criteria:{version:1,description:'Review exact bytes',oracle:'review'}},owner);m=apply(m,{type:'admit-work',workId:'review',title:'An exact review',budget:100},owner).value;return m;}

test('GitHub review context comes from an exact pinned document, never the Work title',()=>{
 let m=mission();assert.deepEqual(githubReviews(m,target,0),[]);
 const document=githubReviewDocument(target,'document:review');
 m=apply(m,{type:'capture-document',document},owner).value;
 m=apply(m,{type:'attach-work-source',workId:'review',documentId:document.id,version:1,contentSha256:documentContentHash(document.content),reason:'Review this head'},owner).value;
 assert.equal(githubReviews(m,target,0).length,0,'a queued Work is not an active review');
 m.works[0]!.execution='active';m.works[0]!.runtimeRun={id:'run',authorizationId:'auth',criteriaHash:'a',inputHash:'b',mode:'mock-http',outputTokenCap:10,ownership:{hostSessionId:'host',dispatchId:'dispatch',startedAt:1,deadlineAt:100}};
 const rows=githubReviews(m,target,2);assert.equal(rows.length,1);assert.equal(rows[0]!.workId,'review');
 assert.deepEqual(githubReviews(m,{...target,headSha:'b'.repeat(40)},2),[],'a new head is not this review');
 assert.deepEqual(githubReviews(m,target,100),[],'an elapsed deadline is not active without an event');
 m.documents![0]!.content='changed';assert.deepEqual(githubReviews(m,target,2),[],'a broken source pin fails closed');
});

test('GitHub view validation refuses unsafe URLs and app-authored review state',()=>{
 const v={title:'PR',groups:[],github:target};assert.deepEqual(checkView(v),v);
 for(const url of ['javascript:alert(1)','https://evil.test/pull/84','https://github.com/jabdori/massion/pull/85'])assert.throws(()=>checkView({...v,github:{...target,url}}),/view/);
 assert.throws(()=>checkView({...v,review:{workId:'invented'}}),/view/);
 assert.throws(()=>githubReviewDocument({...target,headSha:'short'},'document:review'));
});

test('the GitHub catalog produces real-shaped external identity and commit history', {skip:workerCommand()===null&&'no network sandbox'},async()=>{
 const called:string[]=[];const {view}=await runHandler({appId:'app-github',pkg:GITHUB_APP,handler:'item',input:{ref:'84'},network:async request=>{called.push(request.url);return githubFixture(request.url);}});
 assert.equal(view.github?.url,target.url);assert.match(view.github!.headSha,/^[a-f0-9]{40}$/);
 const commits=view.groups.find(g=>g.title.startsWith('Commits '));assert.ok(commits);assert.ok(commits.rows.length>0);assert.match(commits.rows[0]!.meta!,/\d\d:\d\d/);
 assert.equal(called.some(url=>url.endsWith('/pulls/84/commits')),true);
});

test('long commit subjects stay within the view boundary without losing the PR details',async()=>{
 const {runInNewContext}=await import('node:vm');
 for(const message of ['x'.repeat(513),'x'.repeat(510)+'😀suffix']){
  const handlers=new Map<string,(input:unknown)=>Promise<unknown>>();
  runInNewContext(GITHUB_APP.source,{massion:{handle:(name:string,fn:(input:unknown)=>Promise<unknown>)=>handlers.set(name,fn),fetch:async(url:string)=>{const r=githubFixture(url);if(url.endsWith('/commits')){const commits=JSON.parse(r.body);commits[0].commit.message=message;return {...r,body:JSON.stringify(commits)};}return r;}}},{timeout:1000,contextCodeGeneration:{strings:false,wasm:false}});
  const view=checkView(await handlers.get('item')!({ref:'84'})),subject=view.groups.find(g=>g.title.startsWith('Commits '))!.rows[0]!.title;
  assert.ok(subject.length<=512);assert.ok(subject.isWellFormed());assert.ok(subject.endsWith('…'));assert.equal(view.github!.number,84);assert.ok(view.groups.some(g=>g.title.startsWith('Files ')));
 }
});
