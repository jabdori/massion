import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {InMemoryStore} from '../../src/storage.ts';
import {InMemorySecretSlots} from '../../src/secret-slots.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {createHostConnections,parseHostManifest} from '../../src/host-connections.ts';
import {createWorkbench} from '../../src/server.ts';
import {ProductService} from '../../src/product.ts';
import {TEXT_REVIEW_ORACLE} from '../../src/configured-runtime.ts';
import {AppsService} from '../../src/apps.ts';
import {githubFixture} from '../../src/app-catalog.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';

const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'credential-browser-')),out=resolve('.runtime/credential-repair'),store=new InMemoryStore(),secrets=new InMemorySecretSlots();
await mkdir(out,{recursive:true});await secrets.set({owner:'api',slot:'api-key'},'fixture-old-key');
let rejected=false,inference=0,representative=0,checks=0,githubInvalid=true;
const completion=(model,content)=>Response.json({id:'chatcmpl-fixture',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
const manifest=parseHostManifest({version:1,revision:'browser-repair',mode:'https',connections:[{id:'api',label:'Z.ai',providerType:'zai',baseUrl:'https://api.z.ai/api/coding/paas/v4/',models:['glm-fixture'],credential:{ref:'fixture-ref',slot:'api-key'}}]});
const connections=createHostConnections(store,new TextArtifactStore(root),{manifest,allowLiveExecution:true},{secrets,readEnvironment:()=>assert.fail('No environment reads'),transport:async(_url,init)=>{
 const body=JSON.parse(init.body),prompt=JSON.parse(body.messages[0].content);
 if(Object.hasOwn(prompt,'currentMessage')){representative++;return completion(body.model,JSON.stringify({reply:'자료를 정리하겠습니다.',work:{title:'자료 정리'}}));}
 if(prompt.artifact){checks++;return completion(body.model,JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'확인한 자료',reason:'원문 확인'}]}));}
 inference++;if(!rejected){rejected=true;return Response.json({error:{code:'1003',message:'Fixture expiry'}},{status:401});}
 assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture-new-key');return completion(body.model,'확인한 자료입니다.');
}});
const profile=connections.configuration().connections[0];connections.authorize({id:'grant',scope:'fixture',executorProfileId:profile.id,verifierProfileId:profile.id,maxOutputTokensPerCall:256,expectedConfigHash:connections.list().configHash});connections.setDefaultRoute({authorizationId:'grant',outputTokenCap:256,expectedConfigHash:connections.list().configHash});
await new ProductService(store).create({id:'intake',purpose:'자료 정리',scope:'fixture',constraints:[],criteria:{version:1,description:'요청한 자료를 정리한다',oracle:TEXT_REVIEW_ORACLE}},'create');connections.setRepresentative({profileId:profile.id,outputTokenCap:256,intakeMissionId:'intake',expectedConfigHash:connections.list().configHash});
const appNetwork=async request=>githubInvalid?{status:401,body:'{"message":"Bad credentials"}'}:githubFixture(request.url);
const apps=new AppsService(store,{secrets,network:appNetwork});await apps.act({commandId:'github-install',action:'install',catalogId:'github'});await apps.decide({commandId:'github-approve',decisionId:(await apps.decisions(null))[0].id,answer:'act'});await apps.act({commandId:'github-reconnect',action:'reconnect',appId:'app-github'});await apps.connect({commandId:'github-key',decisionId:(await apps.decisions(null)).find(d=>d.state==='open').id,token:'fixture-github-key'});await assert.rejects(apps.view({app:'app-github',handler:'page'}));
const server=createWorkbench(store,root,{connections,scheduleIntervalMs:0,appSecrets:secrets,appNetwork});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port,session=(await exec('agent-browser',['session','id','--scope','worktree','--prefix','massion-credential'])).stdout.trim();
const browser=async(...args)=>{const {stdout}=await exec('agent-browser',['--session',session,'--allowed-domains','127.0.0.1','--json',...args],{timeout:30000,maxBuffer:2*1024*1024});const result=JSON.parse(stdout);assert.equal(result.success,true,result.error);return result.data;};
const evalValue=async text=>(await browser('eval','-b',Buffer.from(text).toString('base64'))).result;
const capture=async name=>{await writeFile(join(out,name+'.snapshot.txt'),JSON.stringify(await browser('snapshot','--json'),null,2));await browser('screenshot',join(out,name+'.png'));};
try{
 await browser('open',origin);await browser('wait','#chat-input');await browser('fill','#chat-input','자료를 정리해 주세요.');await browser('click','#chat-send');await browser('wait','.chat-exception');
 await capture('work-expired');assert.equal(await evalValue('document.querySelector(".chat-exception").textContent.includes("만료됨")'),true);
 const turn=(await (await fetch(origin+'/assistant/conversation')).json()).turns.find(t=>t.work?.credentialRepair),repairId='#chat-credential-repair-'+turn.id,retryId='#chat-credential-retry-'+turn.id;
 await browser('click','[id='+JSON.stringify(repairId.slice(1))+']');await browser('wait','#settings-key-value');assert.equal(await evalValue('document.querySelector("#settings-key-value").type'),'password');
 await browser('fill','#settings-key-value','fixture-new-key');await browser('click','#settings-key-save');await browser('wait','--fn','!document.querySelector("#settings-key-value")');await capture('key-replaced');
 await browser('click','#rail-chat');await browser('wait','[id='+JSON.stringify(retryId.slice(1))+']:not([disabled])');await browser('click','[id='+JSON.stringify(retryId.slice(1))+']');
 const deadline=Date.now()+5000;let work;while(Date.now()<deadline){work=(await store.load('intake')).value.works[0];if(work.acceptance==='accepted')break;await new Promise(r=>setTimeout(r,20));}assert.equal(work.acceptance,'accepted');assert.equal(inference,2);assert.equal(checks,1);assert.equal(representative,1);await browser('wait','--fn','!document.querySelector(".chat-exception")');await capture('work-accepted');
 await browser('click','#rail-me');await browser('click','#me-settings');await browser('click','#settings-nav-apps');await browser('wait','#settings-app-app-github');await browser('click','#settings-app-app-github');await browser('wait','#settings-app-reconnect');await capture('github-invalid');
 await browser('click','#settings-app-reconnect');await browser('wait','[id^="chat-decision-"]');
 const tokenButton=await evalValue('Array.from(document.querySelectorAll(".chat-decision button")).find(b=>b.textContent.includes("연결"))?.id');
 if(tokenButton)await browser('click','[id='+JSON.stringify(tokenButton)+']');else await browser('find','role','button','click','--name','연결');
 await browser('wait','#app-connect-token');await browser('fill','#app-connect-token','fixture-github-replaced');githubInvalid=false;await browser('click','#app-connect-submit');await browser('wait','--fn','document.querySelector("#app-connect-panel").hidden');
 assert.equal((await apps.read()).apps[0].credential.state,'saved');await capture('github-reconnected');validateMissionJournalLineage(store.inspect());
 const report={inference,checks,representative,screens:['work-expired','key-replaced','work-accepted','github-invalid','github-reconnected'],secretsInJournal:false};assert.doesNotMatch(JSON.stringify(store.inspect()),/fixture-(?:old|new|github)-key|fixture-github-replaced/);await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser('close').catch(()=>{});await server.drain();await rm(root,{recursive:true,force:true});}
