/** First-answer driver: start the host from this checkout, prove the desktop sign-in handshake,
 * discover the subscription CLIs and get the first answer - or stop at the first failing step.
 *
 * Requires Node >=24.19.0 <25 (the package.json engine range; a machine whose default Node is newer
 * must select a 24 binary first, for example with mise or nvm) and the official SurrealDB 4.0.1 at
 * MASSION_SURREAL_BINARY or on PATH:
 *   node scripts/first-answer.ts                                  # the person's path: one first message over the detected logins
 *   node scripts/first-answer.ts --provider claude                # one provider: claude | codex
 *   node scripts/first-answer.ts --provider claude --cli /usr/local/bin/claude
 *   node scripts/first-answer.ts --message "What is 6 times 7? Reply with only the number."
 *
 * Steps, one line each ("STEP <n> <name>: ok" or ": STOPPED"):
 *   1 database      a disposable SurrealDB 4.0.1 inside a private temporary folder
 *   2 host          node src/server.ts from this checkout (built-in connections) on a free port
 *   3 daemon-secret the desktop's /desktop-auth challenge handshake over the inherited fd 3 secret
 *   4 discover-logins  GET /connections (the host probes each CLI itself; this script never runs a CLI);
 *                   each login prints today's status plus the state (cli-not-found, logged-out, ...)
 *   5 subscription-connection  both with and without --provider, the script turns the chosen
 *                   subscription connection on the way the conversation screen / Settings does
 *                   (POST /connections/<id>/profiles) and checks activation.routeSet before
 *                   sending the first message. Without --provider, detected logins are tried
 *                   in the fixed order (Claude Code, then Codex) and any undetected login is
 *                   skipped. Outcome with routeSet false (login not detected, or the request
 *                   is not the owner's): STOPPED with the verbatim outcome; this route never
 *                   starts a login command. absent/unknown with no other login detected:
 *                   STOPPED - the next human step is the provider's own interactive login.
 *   6 first-message POST /assistant/messages {commandId,segment:1,expectedRevision:0,text}
 *   7 answer        GET /assistant/conversation?segment=1 (the reply also arrives in the POST body);
 *                   the turn's settlement (reason, provider, model, usage) is printed from this view
 *
 * Every STOPPED line is followed by the request that was sent (no secrets), the response status and
 * the response body VERBATIM; the script then exits non-zero. No retries, no fallback route. The host
 * and the database are always stopped and the temporary folder removed (also on Ctrl-C); the final
 * CLEANUP line reports the processes that remain. No step on this path is implemented to call
 * /usr/bin/security: subscription CLIs use their own login and no secret slot is read.
 */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {once} from 'node:events';
import {accessSync,constants,realpathSync,statSync} from 'node:fs';
import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHmac,randomBytes} from 'node:crypto';
import {Agent,request as httpRequest,type IncomingHttpHeaders} from 'node:http';
import {finished,type Writable} from 'node:stream';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const REPOSITORY=resolve(fileURLToPath(import.meta.url),'..','..');
const SERVER=join(REPOSITORY,'src','server.ts');
const DEFAULT_MESSAGE='What is 6 times 7? Reply with only the number.';
const PROVIDERS=[{provider:'claude-code-cli',name:'claude'},{provider:'codex-cli',name:'codex'}] as const;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const now=()=>Date.now();

/** The database child runs with a restricted PATH, so the version check and the spawn must share one absolute
 * resolution (MASSION_SURREAL_BINARY, or the first executable surreal on the caller's PATH). */
let surrealCommand:string|undefined;
function resolveSurreal(){
 if(surrealCommand!==undefined)return surrealCommand;
 const configured=process.env.MASSION_SURREAL_BINARY;
 if(configured){surrealCommand=configured;return surrealCommand;}
 for(const folder of (process.env.PATH??'').split(':')){
  if(!folder)continue;
  const candidate=join(folder,'surreal');
  try{if(!statSync(candidate).isFile())continue;accessSync(candidate,constants.X_OK);surrealCommand=realpathSync(candidate);return surrealCommand;}catch{}
 }
 surrealCommand='surreal';return surrealCommand;
}

/** A step failed; the fields carry exactly what was sent and what came back. */
class Stop extends Error {
 readonly detail:string;readonly request:string;readonly response:string;
 constructor(detail:string,request:string,response:string){super(detail);this.detail=detail;this.request=request;this.response=response;}
}

function parseArguments(argv:string[]){
 let provider:string|undefined,message=DEFAULT_MESSAGE,cli:string|undefined;
 for(let index=0;index<argv.length;index++){
  const argument=argv[index]!;
  if(argument==='--provider'){const value=argv[++index];if(value!=='claude'&&value!=='codex')throw new Error('--provider must be claude or codex');provider=value;}
  else if(argument==='--message'){const value=argv[++index];if(value===undefined||!value.trim())throw new Error('--message must be nonempty text');message=value;}
  else if(argument==='--cli'){cli=argv[++index];if(cli===undefined||!cli.startsWith('/'))throw new Error('--cli must be an absolute path');}
  else throw new Error(`Unknown option ${argument}`);
 }
 if(cli!==undefined&&provider===undefined)throw new Error('--cli requires --provider (it names one provider executable)');
 return {provider,message,cli};
}

async function freePort(){const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();assert.ok(address&&typeof address==='object');const port=address.port;await new Promise<void>(resolve=>probe.close(()=>resolve()));return port;}

interface ApiResponse {status:number;headers:IncomingHttpHeaders;text:string}
interface LoginEntry {providerType:string;status:string;state?:string;unreadableReason?:string;version?:string}
interface Settlement {status:string;reason:string;provider:string;model:string;usage:{inputTokens:number|null,outputTokens:number|null}}
interface FirstMessageBody {error?:string;reason?:string;outcome?:string;message?:{status:string;reason?:string};turn?:{id:string;status:string;reply?:string;settlement?:Settlement}|null}
interface ConversationBody {segment?:{messages?:{role:string,text:string}[]}|null;turns?:{id:string,settlement?:Settlement}[]}
interface ConnectionBody {logins?:LoginEntry[];connections?:{id:string,providerType:string,configHash:string}[];runtime?:{connections?:{id:string,providerKind:string,model:string,label:string}[];representative?:{route:{profileId:string}}|null}}
interface SelectionOutcome {activation?:{status:string,reason:string|null,routeSet:boolean}}

/** One provider's full run: its own temporary folder, database, host, HTTP session and steps. */
class Run {
 readonly timings:{name:string,ms:number}[]=[];
 #stepName='';#stepStarted=now();
 #database:ChildProcessWithoutNullStreams|undefined;
 #host:ChildProcessWithoutNullStreams|undefined;
 #root:string|undefined;
 #hostOutput='';#databaseOutput='';
 #cleanedUp=false;#stopPromise:Promise<void>|undefined;
 #secret='';#origin='';#port=0;#token='';
 #agent=new Agent({keepAlive:true,maxSockets:1});
 readonly providerType:string;readonly #message:string;readonly #cli:string|undefined;
 constructor(providerType:string,message:string,cli:string|undefined){this.providerType=providerType;this.#message=message;this.#cli=cli;}
 /** Runs one step; a thrown Stop becomes this step's STOPPED lines and rethrows. */
 async step<T>(name:string,work:()=>Promise<T>):Promise<T>{
  this.#stepName=name;this.#stepStarted=now();
  try{return await work();}
  catch(error){
   if(error instanceof Stop){
    this.timings.push({name,ms:now()-this.#stepStarted});
    console.log(`STEP ${this.timings.length} ${name}: STOPPED`);
    console.log(`  reason: ${error.detail}`);
    console.log(`  request: ${error.request}`);
    console.log(`  response: ${error.response}`);
   }
   throw error;
  }
 }
 ok(name:string,detail=''){this.timings.push({name,ms:now()-this.#stepStarted});console.log(`STEP ${this.timings.length} ${name}: ok${detail? ' ('+detail+')':''}`);}
 async stopStep(name:string,detail:string,request:string,response:string|Promise<string>){
  this.#stepName=name;this.#stepStarted=now();this.timings.push({name,ms:0});
  console.log(`STEP ${this.timings.length} ${name}: STOPPED`);
  console.log(`  reason: ${detail}`);
  console.log(`  request: ${request}`);
  console.log(`  response: ${await response}`);
 }
 outputTail(){return this.#hostOutput.trim().slice(-4000)||'(no output)';}

 async startDatabase(){
  const root=this.#root=await mkdtemp(join(await realpath(tmpdir()),'massion-first-answer-'));
  const databaseFolder=join(root,'database');
  await mkdir(join(databaseFolder,'tmp'),{recursive:true,mode:0o700});
  // The host's TMPDIR: the subscription launcher requires its massion-cli-* working directories to live directly inside the real temporary root.
  await mkdir(join(root,'tmp'),{recursive:true,mode:0o700});
  const binary=resolveSurreal();
  const version=spawnSync(binary,['version'],{encoding:'utf8',timeout:5000});
  if(version.status!==0||!version.stdout.trim().startsWith('4.0.1'))
   throw new Stop(`SurrealDB 4.0.1 is required (looked up as ${JSON.stringify(binary)})`,`${binary} version`,`${version.status??'no exit'} ${JSON.stringify((version.stdout||version.stderr||'no output').trim())}`);
  const port=await freePort();
  this.#database=spawn(binary,['start','surrealkv://'+join(databaseFolder,'data'),'--bind',`127.0.0.1:${port}`,'--unauthenticated','--no-banner','--log','error','--temporary-directory',join(databaseFolder,'tmp'),'--default-namespace','massion','--default-database','massion','--deny-net','--deny-scripting'],{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin'}}) as unknown as ChildProcessWithoutNullStreams;
  this.#database.stdout.on('data',chunk=>this.#databaseOutput+=chunk);this.#database.stderr.on('data',chunk=>this.#databaseOutput+=chunk);
  const deadline=now()+30000;
  for(;;){
   if(this.#database.exitCode!==null||this.#database.signalCode!==null)
    throw new Stop('the disposable database exited during startup','surreal start surrealkv://<temporary folder>/database/data --bind 127.0.0.1:'+port+' --unauthenticated --deny-net --deny-scripting',this.#databaseOutput.trim()||'(no output)');
   try{if((await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(500)})).ok)break;}catch{}
   if(now()>deadline)throw new Stop('the disposable database was not healthy within 30s','GET http://127.0.0.1:'+port+'/health',this.#databaseOutput.trim()||'(no output)');
   await pause(100);
  }
  this.ok('database',`http://127.0.0.1:${port} (surreal ${binary}, surrealkv under ${root})`);
  return {port,root};
 }

 async startHost(databasePort:number,root:string){
  this.#secret=randomBytes(32).toString('hex');
  this.#port=await freePort();
  this.#origin=`http://127.0.0.1:${this.#port}`;
  const environment:NodeJS.ProcessEnv={...process.env,
   MASSION_PORT:String(this.#port),
   MASSION_SURREAL_RPC:`http://127.0.0.1:${databasePort}/rpc`,
   MASSION_SURREAL_NAMESPACE:'massion',MASSION_SURREAL_DATABASE:'massion',
   MASSION_DESKTOP_AUTH_FD:'3',TMPDIR:join(root,'tmp')};
  delete environment.MASSION_TEST_SURREAL_RPC;delete environment.MASSION_TEST_SURREAL_NAMESPACE;delete environment.MASSION_TEST_SURREAL_DATABASE;
  if(this.#cli)environment[this.providerType==='claude-code-cli'?'MASSION_CLAUDE_CLI_COMMAND':'MASSION_CODEX_CLI_COMMAND']=this.#cli;
  const described='node src/server.ts (cwd '+root+', MASSION_PORT='+this.#port+', MASSION_SURREAL_RPC=http://127.0.0.1:'+databasePort+'/rpc, namespace/database massion, TMPDIR='+join(root,'tmp')+', daemon secret on fd 3'+(this.#cli?', CLI command pinned by --cli':'')+')';
  this.#host=spawn(process.execPath,[SERVER],{cwd:root,env:environment,stdio:['ignore','pipe','pipe','pipe']}) as unknown as ChildProcessWithoutNullStreams;
  (this.#host.stdio[3] as Writable).on('error',()=>{});(this.#host.stdio[3] as Writable).end(this.#secret);
  this.#host.stdout.setEncoding('utf8');this.#host.stderr.setEncoding('utf8');
  this.#host.stdout.on('data',chunk=>this.#hostOutput+=chunk);this.#host.stderr.on('data',chunk=>this.#hostOutput+=chunk);
  await new Promise<void>((resolveReady,rejectReady)=>{
   const timer=setTimeout(()=>rejectReady(new Stop('the host did not report readiness within 30s',described,this.outputTail())),30000);
   this.#host!.stdout.on('data',(chunk:string)=>{if(chunk.includes(`Massion development workbench: http://127.0.0.1:${this.#port}`)){clearTimeout(timer);resolveReady();}});
   this.#host!.once('exit',()=>rejectReady(new Stop('the host exited during startup',described,this.outputTail())));
  });
  this.ok('host',this.#origin+' (built-in connections, daemon secret on fd 3)');
 }

 #proof(role:'client'|'server',challenge:string,nonce:string){return createHmac('sha256',Buffer.from(this.#secret,'hex')).update(JSON.stringify(['massion-desktop-v1',role,this.#origin,challenge,nonce])).digest('hex');}
 async #raw(method:string,path:string,headers:Record<string,string>,body:string|undefined,timeoutMs:number):Promise<ApiResponse>{
  return await new Promise((resolveRaw,rejectRaw)=>{
   const outgoing=httpRequest({host:'127.0.0.1',port:this.#port,path,method,agent:this.#agent,headers:{...headers,...(body!==undefined?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))}:{})}},response=>{
    let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);
    finished(response,error=>{
     if(error||!response.complete){rejectRaw(error??new Error(`HTTP ${method} ${path} response ended prematurely`));return;}
     resolveRaw({status:response.statusCode??0,headers:response.headers,text});
    });
   });
   outgoing.setTimeout(timeoutMs,()=>outgoing.destroy(new Error(`HTTP ${method} ${path} timed out after ${timeoutMs}ms`)));
   outgoing.on('error',rejectRaw);if(body!==undefined)outgoing.write(body);outgoing.end();
  });
 }
 async #handshake(){
  const challenge=randomBytes(32).toString('hex');
  const response=await this.#raw('GET','/desktop-auth',{'X-Massion-Challenge':challenge},undefined,10000);
  const nonce=String(response.headers['x-massion-nonce']??''),proof=String(response.headers['x-massion-proof']??'');
  if(response.status!==204||!/^[a-f0-9]{64}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(proof)||proof!==this.#proof('server',challenge,nonce))
   throw new Stop('the /desktop-auth challenge handshake failed','GET /desktop-auth (X-Massion-Challenge '+challenge+')',response.status+' '+response.text);
  this.#token=this.#proof('client',challenge,nonce);
 }
 async proveDaemonSecret(){await this.#handshake();this.ok('daemon-secret','GET /desktop-auth verified the server proof on '+this.#origin+' (the desktop sign-in path)');}
 async api(method:string,path:string,body:unknown|undefined=undefined,timeoutMs=30000):Promise<ApiResponse>{
  if(!this.#token)await this.#handshake();
  const payload=body===undefined?undefined:JSON.stringify(body);
  const send=()=>this.#raw(method,path,{Authorization:'Bearer '+this.#token},payload,timeoutMs);
  let response=await send();
  if(response.status===401){await this.#handshake();response=await send();}
  return response;
 }
 printSummary(answer:string,model:string|null,usage:{inputTokens:number|null,outputTokens:number|null},answeredBy?:string){
  console.log(`ANSWER ${answer}`);
  console.log(`PROVIDER ${answeredBy||this.providerType}`);
  console.log(`MODEL ${model??'not reported by any route'}`);
  console.log(`USAGE inputTokens=${usage.inputTokens} knownOutputTokens=${usage.outputTokens} (as recorded at GET /assistant/usage)`);
  console.log('TIMINGS '+this.timings.map(step=>step.name+'='+step.ms+'ms').join(' '));
 }
 /** Idempotent: stops the host and the database and removes the temporary folder. */
 async stop(){
  if(this.#stopPromise)return this.#stopPromise;
  this.#stopPromise=(async()=>{
   const stopChild=async(child:ChildProcessWithoutNullStreams,termMs:number)=>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    child.kill('SIGTERM');
    const killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},termMs);
    await once(child,'exit').catch(()=>{});clearTimeout(killTimer);
   };
   if(this.#host)await stopChild(this.#host,12000);
   if(this.#database)await stopChild(this.#database,10000);
   if(this.#root)await rm(this.#root,{recursive:true,force:true});
   this.#agent.destroy();
  })();
  return this.#stopPromise;
 }
 async cleanupLine(){
  if(!this.#cleanedUp){this.#cleanedUp=true;await this.stop();}
  const drain=/\{"hostShutdown":[^}]*\}/.exec(this.#hostOutput)?.[0]??'no hostShutdown line (the host exited before draining)';
  const remaining=[this.#host,this.#database].filter(child=>child!==undefined&&child.exitCode===null&&child.signalCode===null).length;
  console.log(`CLEANUP: host=stopped (${drain}) database=stopped temporary-folder=removed processes-remaining: ${remaining}`);
 }
}

const verbatim=(response:ApiResponse)=>`${response.status} ${response.text}`;
const loginLine=(login:LoginEntry)=>login.providerType+': '+login.status+(login.state?` (${login.state}${login.unreadableReason?': '+login.unreadableReason:''})`:'');
const printSkipped=(login:LoginEntry)=>console.log(`PROVIDER ${login.providerType}: skipped (login ${login.status}${login.state?` (${login.state})`:''}; pass --provider claude|codex --cli <path> to test one executable)`);
const settlementLine=(settlement:Settlement|undefined)=>settlement
 ?`SETTLEMENT status=${settlement.status} reason=${settlement.reason} provider=${settlement.provider||'(none)'} model=${settlement.model||'(none)'} inputTokens=${settlement.usage.inputTokens??'(none)'} outputTokens=${settlement.usage.outputTokens??'(none)'}`
 :'SETTLEMENT none (the conversation view carries no settlement for this turn)';
async function printSettlement(run:Run,turnId:string|undefined){
 try{const response=await run.api('GET','/assistant/conversation?segment=1');
  const turns=(JSON.parse(response.text) as ConversationBody).turns??[];
  console.log(settlementLine((turnId?turns.find(turn=>turn.id===turnId):turns.at(-1))?.settlement));
 }catch{console.log('SETTLEMENT unavailable (the conversation view could not be read)');}
}

// These exact receipts prove that the turn never reached a model call.
const NO_MODEL_CALL_REASONS=new Set([
 'This message turned nothing on and was not sent.',
 'This message turned the connection on, but was not sent.',
 'The connection was already on, but this message was not sent.',
 'invalid_request','provider_not_explicitly_authorized','invalid_request_or_output_bound','input_byte_limit',
 'cli_invocation_capacity','cli_unavailable_not_started',
 'Host deadline reached before invocation; adapter was not called.',
 'invalid_request_or_bound','credential_or_cancellation_before_dispatch','No Representative route is set.',
]);
type Failure='stopped'|'stopped-after-send'|'send-unknown';
type Outcome={status:'answered';logins:LoginEntry[]}|{status:'skipped'|Failure};
let activeStop:(()=>Promise<void>)|undefined;

async function providerRun(providerType:string,message:string,cli:string|undefined,explicit:boolean):Promise<Outcome>{
 const run=new Run(providerType,message,cli);
 activeStop=()=>run.stop();
 let failure:Failure='stopped';
 try{
  const database=await run.step('database',()=>run.startDatabase());
  await run.step('host',()=>run.startHost(database.port,database.root));
  await run.step('daemon-secret',()=>run.proveDaemonSecret());
  const connectionBody=await run.step('discover-logins',async()=>{
   const response=await run.api('GET','/connections');
   const body=JSON.parse(response.text) as ConnectionBody;
   const target=(body.logins??[]).find(login=>login.providerType===providerType);
   if(!target)throw new Stop('the /connections response lists no login for '+providerType,'GET /connections',verbatim(response));
   run.ok('discover-logins',(body.logins??[]).map(login=>loginLine(login)).join(', '));
   return body;
  });
  const target=(connectionBody.logins??[]).find(login=>login.providerType===providerType)!;
  const detected=(connectionBody.logins??[]).filter(login=>login.status==='detected').map(login=>login.providerType);
  const connection=connectionBody.connections?.find(entry=>entry.providerType===providerType);
  const profile=connectionBody.runtime?.connections?.find(entry=>entry.providerKind===providerType);
  if(target.status!=='detected'&&!explicit){
   printSkipped(target);return {status:'skipped'};
  }
  if(target.status!=='detected'&&detected.length===0){
   const reason=target.state==='cli-not-found'
    ?'the host reports status absent (cli-not-found): no usable CLI executable was found. The next human step is to install the provider CLI; POST /connection-login refuses with cli-not-found and starts nothing.'
    :target.state==='logged-out'
    ?'the host reports status absent (logged-out): the CLI executable is installed but not logged in. The next human step is the provider\'s own interactive login (POST /connection-login starts it; it opens the provider\'s browser flow). This script never opens a window.'
    :'the host reports status '+target.status+(target.state?` (${target.state}${target.unreadableReason?': '+target.unreadableReason:''})`:'')+' for this login, so no subscription connection can be made.';
   await run.stopStep('subscription-connection',reason,'GET /connections',verbatim(await run.api('GET','/connections')));
   return {status:'stopped'};
  }
  if(!connection||!profile){
   await run.stopStep('subscription-connection','the built-in connection or its enrolled profile is missing','GET /connections',verbatim(await run.api('GET','/connections')));
   return {status:'stopped'};
  }
  const selection={model:profile.model,label:profile.label,expectedConfigHash:connection.configHash};
  const selectionPath='/connections/'+encodeURIComponent(connection.id)+'/profiles';
  await run.step('subscription-connection',async()=>{
   const response=await run.api('POST',selectionPath,selection);
   let outcome:SelectionOutcome['activation'];
   try{outcome=(JSON.parse(response.text) as SelectionOutcome).activation;}catch{outcome=undefined;}
   if(response.status!==200||!outcome||outcome.routeSet!==true)
    throw new Stop('the model selection did not turn '+connection.id+' on (activation outcome '+(outcome?.status??'absent')+', routeSet '+String(outcome?.routeSet??'absent')+', reason '+(outcome?.reason??(outcome===undefined?'the response carried no activation field':'none'))+')','POST '+selectionPath+' '+JSON.stringify(selection),verbatim(response));
   run.ok('subscription-connection','POST '+selectionPath+' -> activation '+outcome.status+(outcome.routeSet?', the selection became the Representative route':''));
   return outcome;
  });
  const commandId='first-answer-'+randomBytes(8).toString('hex');
  const messageBody={commandId,segment:1,expectedRevision:0,text:message};
  let answeredBy:string|undefined;
  failure='send-unknown';
  const answer=await run.step('first-message',async()=>{
   const response=await run.api('POST','/assistant/messages',messageBody,90000);
   const body=JSON.parse(response.text) as FirstMessageBody,turn=body.turn;
   if(response.status!==200||turn?.status!=='answered'||typeof turn.reply!=='string'){
    // A generic HTTP error can follow admission. Only these specific refusals prove it did not happen.
    if(response.status===401&&body.error==='Daemon authentication required')failure='stopped';
    if(response.status===409&&(body.reason==='feed'&&body.outcome==='rejected'||
     turn===null&&body.message?.status==='conflict'&&(body.message.reason==='revision'||body.message.reason==='idempotency')))failure='stopped';
    if(response.status===200&&(body.message?.status==='committed'||body.message?.status==='replayed')){
     if(turn?.status==='failed'&&turn.settlement?.status==='failed'&&NO_MODEL_CALL_REASONS.has(turn.settlement.reason))failure='stopped';
     if(turn?.status==='not_started')failure='stopped-after-send';
    }
    await printSettlement(run,turn?.id);
    throw new Stop('the first message did not produce an answered turn (turn status '+(turn?.status??'absent')+')','POST /assistant/messages '+JSON.stringify(messageBody),verbatim(response));
   }
   run.ok('first-message','turn '+turn.id+' answered');
   return {reply:turn.reply,id:turn.id};
  });
  failure='stopped-after-send';
  await run.step('answer',async()=>{
   const response=await run.api('GET','/assistant/conversation?segment=1');
   const view=JSON.parse(response.text) as ConversationBody,segment=view.segment;
   if(response.status!==200||!segment?.messages?.some(entry=>entry.role==='representative'&&entry.text===answer.reply))
    throw new Stop('the settled reply is not readable from the conversation route','GET /assistant/conversation?segment=1',verbatim(response));
   const settlement=(view.turns??[]).find(turn=>turn.id===answer.id)?.settlement;
   console.log(settlementLine(settlement));
   answeredBy=settlement?.provider||undefined;
   run.ok('answer','the reply is in the POST response body and in the segment messages');
  });
  const after=JSON.parse((await run.api('GET','/connections')).text) as ConnectionBody;
  const model=after.runtime?.connections?.find(entry=>entry.id===after.runtime?.representative?.route.profileId)?.model??null;
  const usage=JSON.parse((await run.api('GET','/assistant/usage')).text) as {inputTokens?:number|null,knownOutputTokens?:number|null};
  run.printSummary(answer.reply,model,{inputTokens:usage.inputTokens??null,outputTokens:usage.knownOutputTokens??null},answeredBy);
  return {status:'answered',logins:connectionBody.logins??[]};
 }catch(error){
  if(!(error instanceof Stop))console.log('UNEXPECTED '+(error instanceof Error?error.stack:String(error)));
  if(failure==='send-unknown')console.log(`FIRST-MESSAGE STOPPED ${providerType}: the outcome of the sent message is unknown; no further provider was tried to avoid a second model call.`);
  return {status:failure};
 }finally{
  await run.cleanupLine();
  activeStop=undefined;
 }
}

async function main(){
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major!==24||minor===undefined||minor<19){
  console.log('SCRIPT-STOPPED Node '+process.versions.node+' is outside the supported range >=24.19.0 <25 (package.json engines); select a Node 24 binary, for example with mise or nvm.');
  process.exit(1);
 }
 const options=parseArguments(process.argv.slice(2));
 console.log(`SCRIPT node=${process.versions.node} surreal=${resolveSurreal()} message=${JSON.stringify(options.message)}`);
 const selected=options.provider?PROVIDERS.filter(entry=>entry.name===options.provider):PROVIDERS;
 let answered=0,stopped=0,skipped=0;
 for(const [index,entry] of selected.entries()){
  console.log(`PROVIDER-RUN ${entry.provider}${options.cli?' --cli '+options.cli:''}`);
  const outcome=await providerRun(entry.provider,options.message,options.cli,options.provider!==undefined);
  if(outcome.status==='answered'){
   answered++;
   for(const next of selected.slice(index+1)){
    const login=outcome.logins.find(login=>login.providerType===next.provider);
    if(login&&login.status!=='detected'){printSkipped(login);skipped++;}
   }
   break;
  }
  if(outcome.status==='skipped')skipped++;else stopped++;
  if(outcome.status==='send-unknown'||outcome.status==='stopped-after-send')break;
 }
 console.log(`RESULT answered=${answered} stopped=${stopped} skipped=${skipped}`);
 console.log('KEYCHAIN no step on this path is implemented to call /usr/bin/security: subscription CLIs use their own login and no secret slot is read (src/connection-logins.ts, src/subscription-cli-host.ts, src/secret-slots.ts).');
 if(stopped>0||answered===0)process.exitCode=1;
}

let interrupting=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{
 if(interrupting)return;interrupting=true;
 console.log(`INTERRUPT ${signal}: stopping the host and the database, removing the temporary folder`);
 void (async()=>{
  await activeStop?.();
  console.log('CLEANUP: interrupt cleanup finished; exiting');
  process.exit(130);
 })();
});
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await main();}
 catch(error){console.log('SCRIPT-STOPPED '+(error instanceof Error?error.message:String(error)));process.exitCode=1;}
}
