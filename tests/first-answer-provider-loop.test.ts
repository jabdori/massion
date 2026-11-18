import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Script} from 'node:vm';

const scriptUrl=new URL('../scripts/first-answer.ts',import.meta.url);
const source=readFileSync(scriptUrl,'utf8').replace(/^import .*;$/gm,'').replaceAll('import.meta.url','scriptUrl');
// A separate context per case supplies no process launch or network primitives.
const script=new Script(`(async()=>{${stripTypeScriptTypes(source)}
 Object.assign(Run.prototype,runDoubles);
 await main();
})()`,{filename:fileURLToPath(scriptUrl)});

const providers=['claude-code-cli','codex-cli'];
const feedId='00000000-0000-4000-8000-000000000002';
const messageId='message-1',turnId='turn-1';
const pending={id:turnId,status:'pending'};
const storedPending={...pending,messageId,route:{profileId:providers[0],provider:providers[0],model:'fixture-model',configHash:'fixture-hash',mode:'live',outputTokenCap:100},ownership:{hostSessionId:'fixture',dispatchId:'dispatch-1',startedAt:1,deadlineAt:2},requestHash:'a'.repeat(64),contextMessageIds:[]};
const message={status:'committed',revision:1,value:{kind:'assistant-conversation',id:'assistant-conversation:1',segment:1,previous:null,closed:false,timeWatermark:1,messages:[{id:messageId,ordinal:1,actorId:'owner',role:'owner',text:'fixture prompt',origin:'owner-typed',at:1}],turns:[storedPending]}};
const answered={id:turnId,status:'answered',reply:'42',settlement:{status:'answered',reason:'completed',provider:providers[0],model:'fixture-model',warnings:0,usage:{inputTokens:9,outputTokens:3,known:true}}};
const failed=(reason:string,called=false)=>({id:turnId,status:'failed',settlement:{...answered.settlement,status:'failed',reason,usage:called?answered.settlement.usage:{inputTokens:null,outputTokens:null,known:false}}});
const response=(status:number,body:object)=>({status,headers:{},text:JSON.stringify({...body,feedId})});
const accepted=<T extends {status:string;diagnostics?:object[]}>(turn:T)=>response(200,{message:turn.status==='not_started'?{...message,value:{...message.value,turns:[{id:turnId,messageId,status:turn.status,diagnostics:turn.diagnostics}]}}:message,turn});
const stopLine="FIRST-MESSAGE STOPPED claude-code-cli: the outcome of the sent message is unknown; no further provider was tried to avoid a second model call.";

async function runLoop(first:ReturnType<typeof response>|Error,options:{explicit?:boolean,oneLogin?:boolean,unreadableAnswer?:boolean,beforePost?:boolean}={}){
 const posts:{provider:string,body:{commandId:string,text:string}}[]=[],output:string[]=[];
 const scriptProcess={versions:{node:'24.19.0'},argv:['node',undefined,'--message','fixture prompt',...(options.explicit?['--provider','claude']:[])],env:{MASSION_SURREAL_BINARY:'/fake/surreal'},on(){},exitCode:0};
 let nextId=0,lastTurn:{status:string;reply?:string}|null|undefined;
 await script.runInNewContext({
  scriptUrl,join,resolve,fileURLToPath,process:scriptProcess,Agent:class {},Date:{now:()=>1},
  console:{log:(line:string)=>output.push(line)},randomBytes:(size:number)=>Buffer.alloc(size,++nextId),
  runDoubles:{
   async startDatabase(){return {port:1,root:'/fake'};},async startHost(){},async proveDaemonSecret(){},async cleanupLine(){},
   async api(this:{providerType:string},method:string,path:string,body:{commandId:string,text:string}){
    if(method==='POST'&&path==='/assistant/messages'){
     posts.push({provider:this.providerType,body});
     const result=posts.length===1?first:accepted(answered);
     if(result instanceof Error)throw result;
     try{lastTurn=JSON.parse(result.text).turn;}catch{lastTurn=undefined;}
     return result;
    }
    if(method==='POST'&&path.startsWith('/connections/'))return response(200,{activation:{status:'turned-on',reason:null,routeSet:true}});
    if(method==='GET'&&path==='/connections')return response(200,{
     logins:providers.map((providerType,index)=>({providerType,status:options.oneLogin&&index===1&&this.providerType===providers[0]?'absent':'detected'})),
     connections:providers.filter(providerType=>!options.beforePost||providerType!==providers[0]).map(providerType=>({id:providerType,providerType,configHash:'fixture-hash'})),
     runtime:{connections:providers.map(providerKind=>({id:providerKind,providerKind,model:'fixture-model',label:'Fixture'})),representative:{route:{profileId:this.providerType}}},
    });
    if(method==='GET'&&path==='/assistant/conversation?segment=1')return options.unreadableAnswer&&this.providerType===providers[0]
     ?response(500,{error:'Operation failed; inspect local host logs. Unresolved effects are not replayed automatically.'})
     :response(200,{segment:lastTurn?{messages:[...message.value.messages,...(lastTurn.status==='answered'?[{role:'representative',text:lastTurn.reply}]:[])]}:null,turns:lastTurn?[lastTurn]:[]});
    if(method==='GET'&&path==='/assistant/usage')return response(200,{inputTokens:9,knownOutputTokens:3});
    assert.fail(`Unexpected request ${method} ${path}`);
   },
  },
 });
 return {posts,output,code:scriptProcess.exitCode,attempted:output.filter(line=>line.startsWith('PROVIDER-RUN ')).map(line=>line.slice('PROVIDER-RUN '.length))};
}

const timeout=new Error('HTTP POST /assistant/messages timed out after 90000ms');
const feedError={error:'Database feed changed before this transaction could admit a mutation. Earlier request effects may still be unresolved.',reason:'feed'};
const firstMessageFailures=[
 ['a committed pending turn',accepted(pending)],
 ['the 503 feed error',response(503,{...feedError,outcome:'unknown'})],
 ['a plain 500',response(500,{error:'Operation failed; inspect local host logs. Unresolved effects are not replayed automatically.'})],
 ['a POST timeout',timeout],
 ['an accepted unknown turn',accepted({id:turnId,status:'unknown',settlement:{...answered.settlement,status:'unknown',reason:'cli_exit_1_remote_outcome_unknown',usage:{inputTokens:null,outputTokens:null,known:false}}})],
 ['an unparseable POST response',{status:200,headers:{},text:'{'}],
 ['a 503 labelled rejected',response(503,{error:'Local host is draining. No new mutation was admitted.',outcome:'rejected',retryable:false})],
 ['an unclassified 409',response(409,{error:'Connection changed'})],
 ['a failed turn without proof of no model call',accepted(failed('unsupported_tool_output',true))],
] as const;
for(const [scenario,first] of firstMessageFailures){
 test(`first-answer stops after ${scenario}`,async()=>{
  const {posts,output,code,attempted}=await runLoop(first);
  assert.equal(posts.length,1,'total first-message POSTs');
  assert.deepEqual(attempted,[providers[0]],'no second provider run');
  assert.deepEqual(output.filter(line=>line.startsWith('FIRST-MESSAGE STOPPED ')),[stopLine]);
  assert.equal(code,1);
 });
}

test('first-answer tries the next provider after an explicit admission refusal',async()=>{
 for(const first of [
  response(409,{message:{status:'conflict',revision:1,reason:'revision'},turn:null}),
  response(409,{message:{status:'conflict',revision:1,reason:'idempotency'},turn:null}),
  response(409,{error:'Database changed before admission',reason:'feed',outcome:'rejected'}),
  {status:401,headers:{},text:'{"error":"Daemon authentication required"}'},
 ]){
  const {posts,output}=await runLoop(first);
  assert.deepEqual(posts.map(post=>post.provider),providers,first.text);
  assert.equal(posts[0]!.body.text,posts[1]!.body.text);
  assert.notEqual(posts[0]!.body.commandId,posts[1]!.body.commandId);
  assert.ok(!output.includes(stopLine));
 }
});

test('first-answer tries the next provider after a settled failed turn that proves no model call',async()=>{
 for(const reason of [
  'This message turned nothing on and was not sent.',
  'This message turned the connection on, but was not sent.',
  'The connection was already on, but this message was not sent.',
  'cli_unavailable_not_started','cli_invocation_capacity','input_byte_limit',
  'invalid_request','invalid_request_or_output_bound','provider_not_explicitly_authorized',
 ]){
  const {posts,output}=await runLoop(accepted(failed(reason)));
  assert.deepEqual(posts.map(post=>post.provider),providers,reason);
  assert.ok(!output.includes(stopLine));
 }
});

test('first-answer stops after an answered turn',async()=>{
 const {posts,output,code}=await runLoop(accepted(answered));
 assert.equal(posts.length,1,'total first-message POSTs');
 assert.ok(output.includes('ANSWER 42'));
 assert.equal(code,0);
});

test('first-answer stops after an answered turn with only one login detected initially',async()=>{
 const {posts,attempted}=await runLoop(accepted(answered),{oneLogin:true});
 assert.equal(posts.length,1,'total first-message POSTs');
 assert.deepEqual(attempted,[providers[0]]);
});

test('first-answer stops if the answer is known but the follow-up conversation read fails',async()=>{
 const {posts,output,code}=await runLoop(accepted(answered),{unreadableAnswer:true});
 assert.equal(posts.length,1,'total first-message POSTs');
 assert.ok(!output.includes(stopLine),'the POST already confirmed an answer');
 assert.equal(code,1);
});

test('first-answer stops after an accepted not-started turn',async()=>{
 const turn={id:turnId,status:'not_started',diagnostics:[{code:'assistant_route_missing',message:'No Representative route is set.'}]};
 const {posts,output,code}=await runLoop(accepted(turn));
 assert.equal(posts.length,1,'total first-message POSTs');
 assert.ok(!output.includes(stopLine),'the POST confirmed no turn started');
 assert.equal(code,1);
});

test('first-answer tries the next provider after a failure before the first-message POST',async()=>{
 const {posts,attempted}=await runLoop(accepted(answered),{beforePost:true});
 assert.deepEqual(attempted,providers,'providers started');
 assert.deepEqual(posts.map(post=>post.provider),[providers[1]],'providers receiving the first-message POST');
});

test('first-answer with an explicit provider reports a POST timeout as unknown',async()=>{
 const {posts,output,code}=await runLoop(timeout,{explicit:true});
 assert.equal(posts.length,1,'total first-message POSTs');
 assert.deepEqual(output.filter(line=>line.startsWith('FIRST-MESSAGE STOPPED ')),[stopLine]);
 assert.equal(code,1);
});
