/** Test-only composition: production daemon, storage and services; no real accounts. */
import assert from 'node:assert/strict';
import {readFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createWorkbench} from '../../src/server.ts';
import {createHostConnections,parseHostManifest} from '../../src/host-connections.ts';
import {SurrealStore,SurrealHostSettings,createHttpRpcTransport,initializeSurrealSchema} from '../../src/storage.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {openRestoredArtifacts} from '../../src/portable-backup.ts';
import {ProductService} from '../../src/product.ts';
import {AssistantService} from '../../src/assistant-service.ts';
import {MembersService} from '../../src/members.ts';
import {LoginConnections} from '../../src/connection-logins.ts';
import type {Mission} from '../../src/domain.ts';

const config=JSON.parse(await readFile(process.argv[2]!,'utf8'));
const rpc=createHttpRpcTransport(config.database);await initializeSurrealSchema(rpc);
const store=new SurrealStore<Mission>(rpc),artifacts=new TextArtifactStore(join(process.cwd(),'artifacts'));
const transport=async(_url:string|URL|Request,init?:RequestInit)=>{
 assert.match(String(_url),/^http:\/\/127\.0\.0\.1:1\/v1\/chat\/completions$/);
 const body=JSON.parse(String(init?.body)),prompt=JSON.parse(body.messages[0].content.split('\n\nInput references')[0]);
 assert.ok(['openai/gpt-rep','openai/gpt-exec','google/gemini-check'].includes(body.model),'Unexpected fixture model');
 assert.ok(Object.hasOwn(prompt,'currentMessage')||prompt.work||prompt.roomTurn||prompt.artifact,'Unexpected fixture prompt');
 const kind=Object.hasOwn(prompt,'currentMessage')?'conversation':prompt.teamPlanning?'plan':prompt.roomTurn??(prompt.artifact?'check':prompt.step?'step':'produce');
 await appendFile(join(process.cwd(),'calls.jsonl'),JSON.stringify({model:body.model,kind,title:prompt.work?.title??prompt.currentMessage??null})+'\n');
 let content:string;
 if(kind==='conversation')content=JSON.stringify(prompt.member?{reply:'Fixture member reply',work:null,steer:null}:prompt.currentMessage==='direct'?{reply:'Fixture conversation reply',work:null}:{reply:'Fixture handoff',work:{title:prompt.currentMessage,member:prompt.currentMessage.includes('team')?'Quill':null}});
 else if(kind==='plan')content=JSON.stringify({steps:prompt.teamPlanning.steps.map((title:string,i:number)=>({title,role:i?'Writing':'Research',dependsOn:i?[i-1]:[]}))});
 else if(kind==='challenge'||kind==='answer')content=JSON.stringify(kind==='challenge'?{kind:'challenge',text:'Name the evidence behind this fixture output',quote:'fixture output'}:{kind:'concede',text:'The fixture has no outside evidence',quote:''});
 else if(kind==='check'){
  const passed=prompt.artifact.content.startsWith('Accepted');
  content=JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:passed?'passed':'failed',checks:[{criterion:prompt.criteria.description,passed,quote:passed?'Accepted fixture output':'Rejected fixture output',reason:'Separate deterministic fixture checker'}]});
 }else{
  if(prompt.work?.title==='unknown')throw new Error('Fixture response lost after admission');
  if(prompt.work?.title==='drain')await new Promise<void>((_resolve,reject)=>{const signal=init!.signal!;if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  content=prompt.work?.title==='fail'?'Rejected fixture output':'Accepted fixture output';
 }
 return new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
};
const manifest=config.mode==='configured'?parseHostManifest({version:1,revision:'e9a-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'E9a local fixtures',providerType:'openrouter',baseUrl:'http://127.0.0.1:1/v1/',models:['openai/gpt-rep','openai/gpt-exec','google/gemini-check']}]}):undefined;
const connections=createHostConnections(store,artifacts,{manifest,allowLiveExecution:false},{transport,readEnvironment:()=>{throw new Error('Fixtures must not read credentials');},settings:new SurrealHostSettings(rpc)});
await connections.restoreSettings();
if(config.mode==='configured'&&!await store.load('intake')){
 const product=new ProductService(store,undefined,connections),assistant=new AssistantService(store,product,connections);
 await product.create({id:'intake',purpose:'Owner requests',scope:'local',constraints:['Fixtures only'],criteria:{version:1,description:'Accepted fixture output',oracle:'bounded-text-review/v1'}},'e9a-create');
 const profile=(model:string)=>(connections.list().runtime.connections as {id:string;model:string}[]).find(p=>p.model===model)!.id;
 await connections.save(()=>connections.authorize({id:'e9a-grant',scope:'local',executorProfileId:profile('openai/gpt-exec'),verifierProfileId:profile('google/gemini-check'),maxOutputTokensPerCall:4,expectedConfigHash:connections.list().configHash}));
 await connections.save(()=>connections.setDefaultRoute({authorizationId:'e9a-grant',outputTokenCap:4,expectedConfigHash:connections.list().configHash}));
 await assistant.setSettings({profileId:profile('openai/gpt-rep'),outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:connections.list().configHash});
}
const logins=new LoginConnections(async input=>({spawned:true,exitCode:input.command==='codex'&&config.mode==='found'?0:1,signal:null,stdout:input.command==='claude'?'{"loggedIn":false}':'',stderr:input.command==='codex'?(config.mode==='found'?'Logged in using ChatGPT':'Not logged in'):'',timedOut:false,aborted:false,overflow:false}));
const reader=config.restoredBundle?openRestoredArtifacts(await readFile(config.restoredBundle,'utf8'),config.restoredRoot):artifacts;
const server=createWorkbench(store,process.cwd(),{connections,artifacts:reader,logins,scheduleIntervalMs:0});
server.listen(0,'127.0.0.1',()=>process.send?.({type:'ready',url:'http://127.0.0.1:'+(server.address() as {port:number}).port}));
process.on('message',async(message:any)=>{
 try{
  if(message.type!=='propose-member')throw new Error('Unknown test control');
  const mission=(await store.load('intake'))!;
  await new MembersService(store,()=>'intake').propose({topic:'Fixture analysis',workIds:mission.value.works.filter(w=>w.acceptance==='accepted').slice(0,2).map(w=>w.id)});
  process.send?.({type:'proposed'});
 }catch(error){process.send?.({type:'error',error:String(error)});}
});
process.once('SIGTERM',()=>{void server.drain().then(result=>{process.send?.({type:'shutdown',...result});process.exit(result.status==='drained'?0:1);});});
