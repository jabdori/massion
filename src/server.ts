import {MAX_REQUEST_BODY_BYTES} from './request-limits.ts';
import type {ConnectionWorkbench} from './connection-workbench.ts';
import {loadHostStartup,createHostConnections} from './host-connections.ts';
import {TextArtifactStore} from './text-artifacts.ts';
/** Loopback-only development workbench. No production authentication or service deployment. */
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import type {Store} from './storage.ts';
import {SurrealStore,createHttpRpcTransport,initializeSurrealSchema,withAdmissionFeed,FeedAdmissionError} from './storage.ts';
import type {Mission} from './domain.ts';
import {runGrowthScenario} from './scenario.ts';
import type {ExecutionChoice} from './selectable-runtime.ts';
import type {WorkRuntime} from './configured-runtime.ts';
import {ProviderRegistry} from './providers.ts';
import {ProductService} from './product.ts';
import {DomainError} from './domain.ts';
import {workbenchPage} from './workbench.ts';
import {SurrealRelationImpact,validateImpactInput,RelationImpactLimitError} from './relation-impact.ts';
import type {RelationImpactReader} from './relation-impact.ts';
class RequestError extends Error { status:number; constructor(status:number,message:string){super(message);this.status=status;} }
function identifier(value:unknown,name:string):asserts value is string {if(typeof value!=='string'||!(/^[a-zA-Z0-9:_-]{1,128}$/).test(value))throw new RequestError(400,`Invalid ${name}`);}

function decodeIdentifier(value:string):string {let decoded:string;try{decoded=decodeURIComponent(value);}catch{throw new RequestError(400,'Invalid identifier encoding');}identifier(decoded,'Mission identifier');return decoded;}

export function createWorkbench(store:Store<Mission>,workspaceRoot:string,options:{providers?:ProviderRegistry;runtime?:WorkRuntime;connections?:ConnectionWorkbench;knowledge?:RelationImpactReader}={}) {
 let running=false;const product=new ProductService(store,options.providers,options.connections??options.runtime);
 const server=createServer(async(req,res)=>{
  let mutationFeed='';
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(mutationFeed && value && typeof value==='object' ? {...value,feedId:mutationFeed} : value));};
  const address=server.address();const port=typeof address==='object'&&address?address.port:0;
  const expected=`127.0.0.1:${port}`;
  if(req.headers.host!==expected){send(403,{error:'Loopback host required'});return;}
  if(req.headers.origin&&req.headers.origin!==`http://${expected}`){send(403,{error:'Cross-origin request denied'});return;}
  const readBody=async():Promise<Record<string,unknown>>=>{
   if(req.headers['content-type']!=='application/json')throw new RequestError(415,'JSON required');
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>MAX_REQUEST_BODY_BYTES)throw new RequestError(413,'Request too large');}
   let input:unknown;try{input=JSON.parse(body);}catch{throw new RequestError(400,'Invalid JSON');}
   if(!input||typeof input!=='object'||Array.isArray(input))throw new RequestError(400,'JSON object required');return input as Record<string,unknown>;
  };
  const sendCommit=(result:{status:string;revision:number},created=false)=>send(result.status==='conflict'?409:created&&result.status==='committed'?201:200,result);
  try{
   const url=new URL(req.url??'/',`http://${expected}`);
   if(req.method==='POST'&&(url.pathname==='/missions'||url.pathname.startsWith('/missions/')||url.pathname==='/fixture-run')){mutationFeed=(await store.readState()).feedId;const requested=req.headers['x-massion-feed'];if(requested!==undefined){identifier(requested,'Feed identity');if(requested!==mutationFeed){send(409,{error:'Database changed before admission',reason:'feed',outcome:'rejected'});return;}}}
   const execute=async()=>{
   if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(workbenchPage);return;}
   if(req.method==='GET'&&url.pathname==='/health'){send(200,{status:'ready',mode:'local-development',provider:'unavailable',fixture:'explicit-development-route-only'});return;}
   if(req.method==='GET'&&url.pathname==='/providers'){send(200,{providers:product.providers.list(),selection:product.providers.select(['text-output']),runtime:product.runtime?.configuration?.()??null});return;}
   if(req.method==='GET'&&url.pathname==='/connections'){if(!options.connections)throw new RequestError(503,'Connection setup is not enabled by this host');send(200,options.connections.list());return;}
   if(req.method==='POST'&&url.pathname==='/connections'){if(!options.connections)throw new RequestError(503,'Connection setup is not enabled by this host');send(200,options.connections.connect(await readBody()));return;}
   if(req.method==='POST'&&url.pathname==='/connection-authorizations'){if(!options.connections)throw new RequestError(503,'Connection setup is not enabled by this host');send(200,options.connections.authorize(await readBody()));return;}
   const connectionRoute=/^\/connections\/([^/]+)\/(models|profiles)$/.exec(url.pathname);
   if(req.method==='POST'&&connectionRoute){if(!options.connections)throw new RequestError(503,'Connection setup is not enabled by this host');const connectionId=decodeIdentifier(connectionRoute[1]!);const input=await readBody();if(connectionRoute[2]==='models'){if(Object.keys(input).length!==1||typeof input.expectedConfigHash!=='string')throw new RequestError(400,'Exact discovery fields required');send(200,await options.connections.discover(connectionId,input.expectedConfigHash));}else send(200,options.connections.selectModel(connectionId,input));return;}
   if(req.method==='GET'&&url.pathname==='/read-state'){const id=url.searchParams.get('mission')??undefined;if(id!==undefined)identifier(id,'Mission identifier');send(200,await store.readState(id));return;}
   if(req.method==='GET'&&url.pathname==='/events'){const after=Number(url.searchParams.get('after')??0);const limit=Number(url.searchParams.get('limit')??100);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new RequestError(400,'Invalid event cursor or limit');const feedId=req.headers['x-massion-feed'];if(feedId!==undefined)identifier(feedId,'Feed identity');send(200,await store.readCatchup(after,feedId,limit));return;}
   if(req.method==='POST'&&url.pathname==='/missions'){
    const body=await readBody();identifier(body.id,'Mission identifier');identifier(body.commandId,'command identity');
    const {id,purpose,scope,constraints,criteria}=body;
    if(!criteria||typeof criteria!=='object'||Array.isArray(criteria))throw new RequestError(400,'Acceptance criteria required');
    sendCommit(await product.create({id,purpose,scope,constraints,criteria} as Parameters<ProductService['create']>[0],body.commandId),true);return;
   }
   const workRoute=/^\/missions\/([^/]+)\/(work|commands|run|preflight|memory)$/.exec(url.pathname);
   if(req.method==='POST'&&workRoute){
    const missionId=decodeIdentifier(workRoute[1]!);const body=await readBody();identifier(body.commandId,'command identity');
    if(!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<1)throw new RequestError(400,'Expected revision required');
    if(workRoute[2]==='memory'){
     if(Object.keys(body).some(key=>!['commandId','expectedRevision','memory'].includes(key)))throw new RequestError(400,'Only explicit memory fields are accepted');
     const memory=body.memory;
     if(!memory||typeof memory!=='object'||Array.isArray(memory)||Object.keys(memory).some(key=>!['id','version','content','source'].includes(key)))throw new RequestError(400,'Explicit memory requires id, version, content and owner-supplied source only');
     identifier((memory as Record<string,unknown>).id,'Memory identifier');
     sendCommit(await product.saveMemory(missionId,body as Parameters<ProductService['saveMemory']>[1]),true);return;
    }
    if(workRoute[2]==='preflight'){identifier(body.workId,'Work identifier');const result=await product.preflight(missionId,body.workId,Number(body.expectedRevision),body.selection as ExecutionChoice);if(!result)throw new RequestError(404,'Unknown Mission or Work');send(result.diagnostics.some(d=>d.code==='revision_conflict')?409:200,result);return;}
    if(workRoute[2]==='run'){identifier(body.workId,'Work identifier');if(!product.runtime){send(503,{error:'No explicitly configured Work runtime. No provider request was made.',outcome:'rejected'});return;}const result=await product.run(missionId,body.workId,body.commandId,Number(body.expectedRevision),body.selection as ExecutionChoice);send(result.status==='conflict'?409:200,result);return;}
    if(workRoute[2]==='work'){identifier(body.workId,'Work identifier');sendCommit(await product.admit(missionId,body as Parameters<ProductService['admit']>[1]),true);return;}
    if(!body.command||typeof body.command!=='object'||!['cancel','steer','quarantine-runtime'].includes((body.command as {type:string}).type))throw new RequestError(400,'Only cancel, steer and quarantine-runtime are exposed');
    identifier((body.command as {workId:unknown}).workId,'Work identifier');sendCommit(await product.intervene(missionId,body as Parameters<ProductService['intervene']>[1]));return;
   }
   const impactRoute=/^\/missions\/([^/]+)\/impact$/.exec(url.pathname);
   if(req.method==='GET'&&impactRoute){
    const id=decodeIdentifier(impactRoute[1]!),entity=url.searchParams.get('entity')??'',version=Number(url.searchParams.get('version'));
    try{validateImpactInput(id,entity,version);}catch{throw new RequestError(400,'A nonempty entity and positive safe version are required');}
    if(!options.knowledge)throw new RequestError(503,'Relation impact queries are not enabled by this host');
    let impact;try{impact=await options.knowledge.readImpact(id,entity,version);}catch(error){if(error instanceof RelationImpactLimitError)throw new RequestError(422,error.message);throw error;}
    send(impact?200:404,impact??{error:'Unknown Mission'});return;
   }
   if(req.method==='GET'&&url.pathname.startsWith('/missions/')){const id=decodeIdentifier(url.pathname.slice(10));const state=await store.load(id);send(state?200:404,state??{error:'Unknown Mission'});return;}
   if(req.method==='POST'&&url.pathname==='/fixture-run'){
    const body=await readBody();
    if(Object.keys(body).length!==0){send(400,{error:'This route accepts only the built-in fixture command'});return;}
    if(running){send(409,{error:'A fixture is already running; observe its state before starting another'});return;}
    running=true;try{const result=await runGrowthScenario(store,workspaceRoot);send(201,{missionId:result.missionId,revision:result.snapshot?.revision,evidenceClass:'fixture'});}finally{running=false;}return;
   }
   send(404,{error:'Unknown route'});
   };
   if(mutationFeed)await withAdmissionFeed(mutationFeed,execute);else await execute();
  }catch(error){if(error instanceof FeedAdmissionError){send(503,{error:error.message,reason:'feed',outcome:'unknown'});return;}if(error instanceof Error&&error.name==='RunUnsettledError'){const run=error as Error&{runId:string;snapshot?:unknown};send(503,{error:run.message,outcome:'admitted-unsettled',retryable:false,runId:run.runId,snapshot:run.snapshot});return;}if(error instanceof RequestError){send(error.status,{error:error.message});return;}if(error instanceof DomainError){send(error.code==='denied'?403:400,{error:error.message});return;}if(error instanceof Error&&error.name==='CommitOutcomeUnknownError'){send(503,{error:'Commit outcome is unknown. Read durable events before deciding any next action.',outcome:'unknown'});return;}if(error instanceof Error&&error.name==='StorageContentionError'){send(503,{error:'The transaction was rolled back due to contention. Refresh before a deliberate retry.',outcome:'rejected',retryable:true});return;}if(error instanceof Error&&error.name==='EventCursorError'){send(409,{error:'Event feed identity or cursor no longer matches this database; read /read-state before resuming catch-up.'});return;}console.error(error instanceof Error?error.message:'Workbench failure');send(500,{error:'Operation failed; inspect local host logs. Unresolved effects are not replayed automatically.'});}
 });
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const hostStartup=await loadHostStartup(process.argv.slice(2));
 const endpoint=process.env.MASSION_SURREAL_RPC??process.env.MASSION_TEST_SURREAL_RPC;
 if(!endpoint)throw new Error('Set MASSION_SURREAL_RPC to an authorized local /rpc endpoint');
 const transport=createHttpRpcTransport({endpoint,namespace:process.env.MASSION_SURREAL_NAMESPACE??process.env.MASSION_TEST_SURREAL_NAMESPACE??'massion',database:process.env.MASSION_SURREAL_DATABASE??process.env.MASSION_TEST_SURREAL_DATABASE??'massion'});
 await initializeSurrealSchema(transport);
 const port=Number(process.env.MASSION_PORT??8765);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid development port');
 const store=new SurrealStore<Mission>(transport);const workspaceRoot=resolve('.runtime/workspaces');const artifacts=new TextArtifactStore(resolve(workspaceRoot,'model-artifacts'));const connections=createHostConnections(store,artifacts,hostStartup,{transport:(url,init)=>fetch(url,init),readEnvironment:name=>process.env[name]});
 const server=createWorkbench(store,workspaceRoot,{connections,knowledge:new SurrealRelationImpact(transport)});
 server.listen(port,'127.0.0.1',()=>console.log(`Massion development workbench: http://127.0.0.1:${port}`));
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{server.close(()=>process.exit(0));});
}
