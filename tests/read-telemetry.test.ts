import test from 'node:test';
import assert from 'node:assert/strict';
import {githubReviewDocument} from '../src/github-review.ts';
import {validateProviderDispatch} from '../src/provider-dispatch.ts';
import {documentContentHash} from '../src/domain.ts';
import type {Work,ProviderDispatchClaim} from '../src/domain.ts';
const target={repository:'jabdori/massion',number:84,headSha:'a'.repeat(40),url:'https://github.com/jabdori/massion/pull/84'};

test('file review pins retain full bounded bytes and reject path or byte ambiguity',()=>{
 const files=[{path:'src/a.ts',content:'export const value = 1;\n'}];
 const doc=(githubReviewDocument as any)(target,'source',files),value=JSON.parse(doc.content);
 assert.equal(value.format,'github-review/v2');assert.deepEqual(value.files,files);
 for(const bad of [[{path:'../escape',content:'x'}],[{path:'src/a.ts',content:'x'},{path:'src/a.ts',content:'y'}],[{path:'src/a.ts',content:'x'.repeat(17000)}]])assert.throws(()=>(githubReviewDocument as any)(target,'source',bad),/file|bound|source/i);
});

test('file delivery claims bind exact pinned bytes, assigned effect and original run',()=>{
 const document={...(githubReviewDocument as any)(target,'source',[{path:'src/a.ts',content:'const value = 1;'}]),actorId:'owner'};document.contentSha256=documentContentHash(document.content);
 const work={id:'w',sourceDocuments:[{document,actorId:'owner',reason:'Review'}],runtimeRun:{id:'run',authorizationId:'grant',ownership:{hostSessionId:'host',dispatchId:'dispatch',startedAt:100,deadlineAt:200}},tasks:[{id:'step',parentId:'executor',status:'active',step:{title:'Read',role:'Read',dependsOn:[]}}],assignments:[{id:'assignment',actorId:'worker',taskId:'step',model:{provider:'fixture',model:'fixture',configVersion:'v1'}}]} as unknown as Work;
 const effect={id:'effect',taskId:'step',status:'pending' as const,target:'fixture/fixture',authority:'grant'},claim={id:'claim',runId:'run',hostSessionId:'host',dispatchId:'dispatch',actorId:'worker',assignmentId:'assignment',provider:'fixture',model:'fixture',configVersion:'v1',requestHash:'b'.repeat(64),claimedAt:120,fileInputs:[{documentId:'source',path:'src/a.ts',sha256:documentContentHash('const value = 1;')}]} as unknown as ProviderDispatchClaim;
 assert.doesNotThrow(()=>validateProviderDispatch(work,effect,claim));
 for(const files of [[{documentId:'source',path:'src/missing.ts',sha256:'b'.repeat(64)}],[{documentId:'source',path:'src/a.ts',sha256:'b'.repeat(64)}],[],[null],[...(claim as any).fileInputs,...(claim as any).fileInputs]])assert.throws(()=>validateProviderDispatch(work,effect,{...claim,fileInputs:files} as any),/file|claim/i);
});

test('the GitHub handler fetches pinned full text, omits failed or binary reads, and validates view input bytes',async()=>{
 const {GITHUB_APP,githubFixture}=await import('../src/app-catalog.ts'),{checkView}=await import('../src/app-sandbox.ts'),{runInNewContext}=await import('node:vm');
 const handlers=new Map<string,(input:unknown)=>Promise<unknown>>(),urls:string[]=[];
 runInNewContext(GITHUB_APP.source,{massion:{handle:(key:string,handler:(input:unknown)=>Promise<unknown>)=>handlers.set(key,handler),fetch:async(url:string)=>{urls.push(url);const result=githubFixture(url);if(url.includes('/contents/')){const data=JSON.parse(result.body);if(data.path==='src/assistant-service.ts'){data.content=Buffer.from('const title = "원문";\n').toString('base64');data.size=Buffer.byteLength('const title = "원문";\n');return {status:200,body:JSON.stringify(data)};}if(data.path==='tests/assistant-conversation.test.ts')return {status:404,body:'{}'};if(data.path==='src/assistant-conversation-panel.ts'){data.content='//8=';data.size=2;return {status:200,body:JSON.stringify(data)};}}return result;}}},{timeout:1000,contextCodeGeneration:{strings:false,wasm:false}});
 const view=checkView(await handlers.get('item')!({ref:'84'}));assert.equal(view.sourceFiles!.find(f=>f.path==='src/assistant-service.ts')!.content,'const title = "원문";\n');assert.ok(!view.sourceFiles!.some(f=>['tests/assistant-conversation.test.ts','src/assistant-conversation-panel.ts'].includes(f.path)));assert.ok(urls.filter(u=>u.includes('/contents/')).every(u=>new URL(u).searchParams.get('ref')===view.github!.headSha));
 assert.throws(()=>checkView({...view,sourceFiles:[{path:'../escape',content:'x'}]}),/file/i);assert.throws(()=>checkView({...view,sourceFiles:[{path:'src/a.ts',content:'x'.repeat(17000)}]}),/bound/i);
});
