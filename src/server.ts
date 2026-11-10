import {canResume,currentOwnership} from './runtime-continuation.ts';
import {RuleChangesService,RULE_DECISION_PREFIX,withRuleBriefings} from './rule-changes.ts';
import {MonthlyBudgetService,BUDGET_DECISION_PREFIX} from './monthly-budget.ts';
import {createAppDocumentHost} from './app-documents.ts';
import {EffectDecisionsService,EFFECT_DECISION_PREFIX,EffectAdmissionRejectedError} from './effect-decisions.ts';
import type {EffectAdapter} from './effect-decisions.ts';
import {daemonGuard,inheritedDaemonSecret} from './daemon-auth.ts';
import {createProtocolFeed} from './protocol-feed.ts';
import {protocolSupport,protocolFeatures,protocolConnection,validHeader,validRange} from './protocol.ts';
import type {ProtocolHeader,ProtocolRange,ProtocolFeatures,ProtocolRequest} from './protocol.ts';
import {SurrealNeighborhood,neighborhoodInput,NeighborhoodChangedError,NeighborhoodLimitError} from './knowledge-neighborhood.ts';
import type {NeighborhoodReader} from './knowledge-neighborhood.ts';
import {SurrealWorkInbox,WorkInboxChangedError} from './work-inbox.ts';
import type {WorkInboxReader} from './work-inbox.ts';
import {SurrealMissionCatalog,MissionCatalogChangedError} from './mission-catalog.ts';
import type {MissionCatalogReader} from './mission-catalog.ts';
import {readMemoryUsage,MemoryUsageError} from './memory-usage.ts';
import {findMemoryVersions} from './memory-find.ts';
import {searchMemoryContent} from './memory-content-search.ts';
import {loadRestoredArtifactReader} from './restored-artifact-reader.ts';
import {HOST_SESSION_ID,HostDrainError} from './runtime-lifetime.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import {AssistantService} from './assistant-service.ts';
import {LoginConnections} from './connection-logins.ts';
import {ConnectionLifecycle,ConnectionLifecycleRefusedError} from './connection-lifecycle.ts';
import type {ConnectionFacts,ConnectionTarget} from './connection-lifecycle.ts';
import {copy} from './ui-copy.ts';
import {MembersService} from './members.ts';
import {DevicesService,DeviceAdmissionRefusedError} from './devices.ts';
import type {DeviceAdapter} from './devices.ts';
import {SchedulesService,scheduleWorkProducer} from './schedules.ts';
import {githubReviews,readGithubReviewMissions} from './github-review.ts';
import {PermissionsService} from './permissions.ts';
import {DECISION_PREFIX,SkillsService} from './skills.ts';
import {AppsService,DECISION_PREFIX as APP_DECISION_PREFIX} from './apps.ts';
import type {AppNetwork} from './apps.ts';
import type {AppSecrets,McpAdapter} from './mcp-apps.ts';
import {KeychainSecretSlots} from './secret-slots.ts';
import {ConversationReadError} from './work-conversation.ts';
import {RuntimeOwnershipError} from './runtime-lifetime.ts';
import {searchDocuments,readDocument,readDocumentUsage,DocumentReadError} from './documents.ts';
import {MAX_REQUEST_BODY_BYTES} from './request-limits.ts';
import type {ConnectionWorkbench} from './connection-workbench.ts';
import {loadHostStartup,createHostConnections} from './host-connections.ts';
import {RecordArtifactError,readBinaryRecordArtifact} from './record-artifact.ts';
import {BinaryArtifactStore} from './binary-artifacts.ts';
import type {ArtifactReader} from './record-artifact.ts';
import {TextArtifactStore} from './text-artifacts.ts';
/** Loopback-only development workbench. No production authentication or service deployment. */
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import type {Store} from './storage.ts';
import {SurrealStore,SurrealHostSettings,createHttpRpcTransport,initializeSurrealSchema,withAdmissionFeed,FeedAdmissionError} from './storage.ts';
import type {Mission} from './domain.ts';
import {runGrowthScenario} from './scenario.ts';
import type {ExecutionChoice} from './selectable-runtime.ts';
import type {WorkRuntime} from './configured-runtime.ts';
import {ProviderRegistry} from './providers.ts';
import {ProductService} from './product.ts';
import {readWorkBudgetHistory,readWorkInterventionHistory} from './work-budget-history.ts';
import {DomainError} from './domain.ts';
import {workbenchPage} from './workbench.ts';
import {SurrealRelationImpact,validateImpactInput,RelationImpactLimitError} from './relation-impact.ts';
import type {RelationImpactReader} from './relation-impact.ts';
class RequestError extends Error { status:number; constructor(status:number,message:string){super(message);this.status=status;} }
function identifier(value:unknown,name:string):asserts value is string {if(typeof value!=='string'||!(/^[a-zA-Z0-9:_-]{1,128}$/).test(value))throw new RequestError(400,`Invalid ${name}`);}

/** Absent selection means the saved default route; anything present must be an object. */
function selection(body:Record<string,unknown>):ExecutionChoice|undefined {if(!Object.hasOwn(body,'selection'))return undefined;const value=body.selection;if(!value||typeof value!=='object'||Array.isArray(value))throw new RequestError(400,'Selection must be an object when present');return value as ExecutionChoice;}
/** Conversation segments never reach a Mission reader. */
function missionIdentifier(value:unknown):asserts value is string {identifier(value,'Mission identifier');if(value.startsWith(ASSISTANT_CONVERSATION_PREFIX))throw new RequestError(400,'Conversation segments are not Missions');}
function decodeIdentifier(value:string,name:string):string {let decoded:string;try{decoded=decodeURIComponent(value);}catch{throw new RequestError(400,'Invalid identifier encoding');}identifier(decoded,name);return decoded;}
/** Single entry point for every Mission ID route; other path identifiers (connections) skip the segment refusal. */
function decodeMissionIdentifier(value:string):string {const decoded=decodeIdentifier(value,'Mission identifier');missionIdentifier(decoded);return decoded;}
/** Host steps own every `assistant-` command and run ID, so no caller can occupy one. */
function callerCommand(value:unknown):asserts value is string {identifier(value,'command identity');if(value.startsWith('assistant-'))throw new RequestError(400,'assistant- command identities are reserved for host steps');}

export function createWorkbench(store:Store<Mission>,workspaceRoot:string,options:{connectionObserver?:(target:ConnectionTarget,signal:AbortSignal)=>Promise<ConnectionFacts>;deviceAdapters?:DeviceAdapter[];effectAdapters?:EffectAdapter[];effectTimeoutMs?:number;logins?:LoginConnections;daemonSecret?:string;neighborhood?:NeighborhoodReader;inbox?:WorkInboxReader;catalog?:MissionCatalogReader;drainTimeoutMs?:number;providers?:ProviderRegistry;runtime?:WorkRuntime;connections?:ConnectionWorkbench;knowledge?:RelationImpactReader;artifacts?:ArtifactReader;scheduleIntervalMs?:number;appNetwork?:AppNetwork;appSecrets?:AppSecrets;mcp?:McpAdapter;protocol?:{supported?:ProtocolRange;installed?:ProtocolRange;features?:ProtocolFeatures}}={}) {
 const appDocuments=createAppDocumentHost();
 const authenticate=options.daemonSecret===undefined?undefined:daemonGuard(options.daemonSecret);
 const supported=options.protocol?.supported??protocolSupport,features=options.protocol?.features??protocolFeatures;
 protocolConnection(supported,supported,options.protocol?.installed,features);
 const drainTimeoutMs=options.drainTimeoutMs??10000;if(!Number.isSafeInteger(drainTimeoutMs)||drainTimeoutMs<1||drainTimeoutMs>30000)throw new Error('Invalid bounded host drain timeout');let draining=false,unsettled=false,drainPromise:Promise<{status:'drained'|'unsettled';timedOut:boolean}>|undefined;let running=false;const ownerStore=new Proxy(store,{get(target,key){if(key==='commit')return (input:Parameters<typeof store.commit>[0])=>{if(draining)throw new HostDrainError();return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});const product=new ProductService(ownerStore,options.providers,options.connections??options.runtime,options.artifacts);
 // Conversation host steps (settle, outcome) must still commit while draining; new owner turns are refused by the service itself.
 const assistant=new AssistantService(store,product,options.connections,{members:()=>members.roster(),ownerStore});
 // One conversation per member (members.md), kept so drain reaches its turns too; one created after drain starts is born draining.
 // Owner decisions, permission rules and schedule actions commit through the drain-aware store, so a command resuming after drain starts is refused.
 const ruleChanges=new RuleChangesService(ownerStore,()=>options.connections?.list().representative?.intakeMissionId);
 const monthlyBudget=new MonthlyBudgetService(ownerStore);
 let budgetTask:Promise<void>|undefined,budgetAgain=false;
 const startupResume=Promise.resolve().then(async()=>{
  if(!product.runtime?.resume)return;const snapshot=await monthlyBudget.snapshot();
  for(const r of snapshot.budget?.value.reservations??[]){
   if(draining)break;const w=snapshot.missions.get(r.missionId)?.value.works.find(w=>w.id===r.workId);
   if(r.state!=='reserved'||r.feedId!==snapshot.feedId||!w||w.runtimeRun?.id!==r.runId||!canResume(w,Date.now())||currentOwnership(w)?.hostSessionId===HOST_SESSION_ID)continue;
   try{await withAdmissionFeed(snapshot.feedId,()=>product.runtime!.resume!(r.missionId,r.workId));}catch(error){if(!(error instanceof HostDrainError)&&!(error instanceof DomainError))unsettled=true;}
  }
 }).catch(()=>{unsettled=true;});
 const queueMonthlyReconcile=()=>{
  if(draining)return;budgetAgain=true;if(budgetTask)return;
  budgetTask=Promise.resolve().then(async()=>{do{budgetAgain=false;await startupResume;if(draining)return;try{await monthlyBudget.reconcile(undefined,async(r,revision)=>{if(product.runtime)await product.run(r.missionId,r.workId,r.runId,revision,r.selection);},async(r,revision)=>!!product.runtime&&!product.runtime.hasActiveAdmission?.()&&!!(await product.preflight(r.missionId,r.workId,revision,r.selection))?.ready,()=>product.runtime?.hasActiveAdmission?.()??false);}catch(error){if(!(error instanceof HostDrainError)&&!(error instanceof DomainError))unsettled=true;}}while(budgetAgain&&!draining);}).finally(()=>{budgetTask=undefined;if(budgetAgain&&!draining)queueMonthlyReconcile();});
 };
 const effects=new EffectDecisionsService(store,ownerStore,()=>options.connections?.list().representative?.intakeMissionId,{adapters:options.effectAdapters,timeoutMs:options.effectTimeoutMs});
 const connectionLifecycle=options.connections?new ConnectionLifecycle(ownerStore,options.connections,{logins:options.logins,observe:options.connectionObserver}):undefined;
 const devices=new DevicesService(store,ownerStore,()=>effects.decisions(),options.deviceAdapters);
 const members=new MembersService(ownerStore,()=>options.connections?.list().representative?.intakeMissionId),memberChats=new Map<string,AssistantService>();
 // The host scheduler (results-and-schedules.md) writes the briefing from the Representative's conversation read; it stops when the host drains or closes.
 // drain waits for a tick already in flight and reports `unsettled` when any schedule write met an unknown commit, read again once HTTP has closed so a Run now finishing during drain counts, so `drained` means its writes settled.
 let ticking:Promise<unknown>|undefined;const permissions=new PermissionsService(ownerStore),skills=new SkillsService(ownerStore),apps=new AppsService(ownerStore,{network:options.appNetwork,secrets:options.appSecrets,mcp:options.mcp,members:async()=>(await members.roster()),admit:async()=>{if(draining)throw new HostDrainError();}});const schedules=new SchedulesService(store,n=>assistant.read(n),Date.now,ownerStore,scheduleWorkProducer(assistant),{member:id=>members.member(id),readMember:async(id,n)=>(await memberChat(id)).chat.read(n),produceMember:scheduleWorkProducer(assistant)}),scheduleIntervalMs=options.scheduleIntervalMs??30000,scheduler=scheduleIntervalMs?setInterval(()=>{if(!draining&&!ticking)ticking=schedules.tick().catch(()=>{}).finally(()=>{ticking=undefined;});},scheduleIntervalMs):undefined;scheduler?.unref();
 const memberChat=async(value:unknown)=>{identifier(value,'member identifier');const member=await members.member(value);if(!member)throw new RequestError(404,'Unknown member');let chat=memberChats.get(member.id);if(!chat){chat=new AssistantService(store,product,options.connections,{member:{id:member.id,name:member.name,modelGroup:member.modelGroup},members:()=>members.roster(),ownerStore});if(draining)chat.beginDrain();memberChats.set(member.id,chat);}return {member,chat};};
 const feed=createProtocolFeed(store);
 const server=createServer(async(req,res)=>{
  let mutationFeed='',method=req.method,budgetCommand=false;let envelope:ProtocolHeader|undefined,protocolPayload:Record<string,unknown>|undefined;
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(draining?{'Connection':'close'}:{})});const payload=mutationFeed && value && typeof value==='object' ? {...value,feedId:mutationFeed} : value;res.end(JSON.stringify(envelope?{version:Math.min(supported.max,Math.max(supported.min,envelope.version)),requestId:envelope.requestId,generation:envelope.generation,kind:'reply',status,payload}:payload));};
  const address=server.address();const port=typeof address==='object'&&address?address.port:0;
  const expected=`127.0.0.1:${port}`;
  if(req.headers.host!==expected){send(403,{error:'Loopback host required'});return;}
  if(req.headers.origin&&req.headers.origin!==`http://${expected}`){send(403,{error:'Cross-origin request denied'});return;}
  if(authenticate&&!authenticate(req,res))return;
  const readBody=async(protocolEnvelope=false):Promise<Record<string,unknown>>=>{
   if(protocolPayload){if(draining)throw new HostDrainError();return protocolPayload;}
   if(req.headers['content-type']!=='application/json')throw new RequestError(415,'JSON required');
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>MAX_REQUEST_BODY_BYTES+(protocolEnvelope?16384:0))throw new RequestError(413,'Request too large');}
   let input:unknown;try{input=JSON.parse(body);}catch{throw new RequestError(400,'Invalid JSON');}
   if(!input||typeof input!=='object'||Array.isArray(input))throw new RequestError(400,'JSON object required');if(draining&&!protocolEnvelope)throw new HostDrainError();return input as Record<string,unknown>;
  };
  const sendCommit=(result:{status:string;revision:number},created=false)=>send(result.status==='conflict'?409:created&&result.status==='committed'?201:200,result);
  try{
   let url=new URL(req.url??'/',`http://${expected}`);
   if(url.pathname==='/protocol/events'){
    const message={version:Number(url.searchParams.get('version')),requestId:url.searchParams.get('requestId'),generation:Number(url.searchParams.get('generation'))};
    if(!validHeader(message))throw new RequestError(400,'Invalid protocol header');envelope=message;
    if(method!=='GET'||message.version<supported.min||message.version>supported.max||!features.feedPush){send(426,{error:'Unsupported feed protocol',outcome:'rejected'});return;}
    if(draining)throw new HostDrainError();
    let after=Number(url.searchParams.get('after')??0),feedId=url.searchParams.get('feedId')??undefined;
    const last=req.headers['last-event-id'];
    if(last!==undefined){let position;try{position=JSON.parse(String(last));}catch{throw new RequestError(400,'Invalid resume cursor');}if(!Array.isArray(position)||position.length!==2)throw new RequestError(400,'Invalid resume cursor');[feedId,after]=position;}
    if(!Number.isSafeInteger(after)||after<0)throw new RequestError(400,'Invalid resume cursor');if(feedId!==undefined)identifier(feedId,'Feed identity');
    await feed.subscribe(res,{...message,after,...(feedId?{feedId}:{})});return;
   }
   if(url.pathname==='/protocol/connect'||url.pathname==='/protocol/request'){
    if(method!=='POST')throw new RequestError(405,'Protocol messages require POST');
    const input=await readBody(true);
    if(!validHeader(input))throw new RequestError(400,'Invalid protocol header');
    envelope=input;
    if(url.pathname==='/protocol/connect'){
     if(!validRange(input.supported))throw new RequestError(400,'Invalid protocol range');
     const connection=protocolConnection(input.supported,supported,options.protocol?.installed,features);
     send(connection.state==='ready'?200:426,connection);return;
    }
    if(input.version<supported.min||input.version>supported.max){send(426,{error:'Unsupported protocol version',outcome:'rejected',...protocolConnection({min:input.version,max:input.version},supported,options.protocol?.installed,features)});return;}
    if(!['command','query'].includes(String(input.kind))||typeof input.path!=='string'||input.path.length>8192||!/^\/(?!\/)/.test(input.path)||/[\\#\r\n]/.test(input.path))throw new RequestError(400,'Invalid protocol request');
    url=new URL(input.path,`http://${expected}`);
    if(url.origin!==`http://${expected}`||url.pathname==='/'||url.pathname.startsWith('/protocol'))throw new RequestError(400,'Invalid protocol target');
    if(!features[input.kind==='command'?'commands':'queries']){send(426,{error:'Protocol feature unavailable',outcome:'rejected',state:'update-needed'});return;}
    if(input.kind==='command'&&(!input.payload||typeof input.payload!=='object'||Array.isArray(input.payload))||input.kind==='query'&&input.payload!==undefined)throw new RequestError(400,'Invalid protocol payload');
    if(input.payload!==undefined&&Buffer.byteLength(JSON.stringify(input.payload))>MAX_REQUEST_BODY_BYTES)throw new RequestError(413,'Request too large');
    if(input.feedId!==undefined){identifier(input.feedId,'Feed identity');req.headers['x-massion-feed']=input.feedId;}
    method=input.kind==='command'?'POST':'GET';protocolPayload=input.payload as ProtocolRequest['payload'];
   }
   if(method==='POST'&&(url.pathname==='/missions'||url.pathname.startsWith('/missions/')||url.pathname==='/fixture-run'||url.pathname==='/assistant/messages'||url.pathname==='/assistant/steering'||url.pathname==='/assistant/memory-candidates'||url.pathname==='/members/group'||url.pathname==='/assistant/usage'||url.pathname==='/assistant/members'||url.pathname==='/assistant/devices'||/^\/connections\/[^/]+\/(?:recheck|key|retry)$/.test(url.pathname)||url.pathname==='/assistant/decisions'||url.pathname==='/assistant/schedules'||url.pathname==='/assistant/permissions'||url.pathname==='/assistant/skills'||url.pathname==='/assistant/apps'||url.pathname==='/assistant/apps/view'||url.pathname==='/assistant/apps/connect')){mutationFeed=(await store.readState()).feedId;const requested=req.headers['x-massion-feed'];if(requested!==undefined){identifier(requested,'Feed identity');if(requested!==mutationFeed){send(409,{error:'Database changed before admission',reason:'feed',outcome:'rejected'});return;}}}
   budgetCommand=method==='POST'&&url.pathname==='/assistant/usage';
   const execute=async()=>{
   if(draining&&method!=='GET'){send(503,{error:'Local host is draining. No new mutation was admitted.',outcome:'rejected',retryable:false});return;}
   if(method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src "+await appDocuments.origin()+"; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(workbenchPage);return;}
   if(method==='GET'&&url.pathname==='/health'){send(200,{status:'ready',mode:'local-development',provider:'unavailable',fixture:'explicit-development-route-only'});return;}
   if(method==='GET'&&url.pathname==='/providers'){send(200,{providers:product.providers.list(),selection:product.providers.select(['text-output']),runtime:product.runtime?.configuration?.()??null});return;}
   if(method==='GET'&&url.pathname==='/connections'){if(!options.connections)throw new RequestError(503,'Connection setup is not enabled by this host');const logins=options.logins?await options.logins.list():undefined;send(200,{...options.connections.list(),...(logins?{logins}:{})});return;}
   if(method==='GET'&&url.pathname==='/connections/lifecycle'){if(!connectionLifecycle)throw new RequestError(503,'Connection setup is not enabled by this host');if(url.searchParams.size&&url.searchParams.size!==4)throw new RequestError(400,'Exact lifecycle receipt query required');const state=await store.readState(),view=url.searchParams.size?await connectionLifecycle.outcome(Object.fromEntries(url.searchParams)):await connectionLifecycle.read();if(view.feedId!==state.feedId||(await store.readState()).feedId!==state.feedId)throw new FeedAdmissionError();send(200,view);return;}
   const lifecycleRoute=/^\/connections\/([^/]+)\/(recheck|key|retry)$/.exec(url.pathname);
   if(method==='POST'&&lifecycleRoute){if(!connectionLifecycle)throw new RequestError(503,'Connection setup is not enabled by this host');const body=await readBody();callerCommand(body.commandId);const result=await connectionLifecycle[lifecycleRoute[2]==='key'?'replaceKey':lifecycleRoute[2]==='retry'?'retry':'recheck']({...body,connectionId:decodeIdentifier(lifecycleRoute[1]!,'connection identifier')});if(result.status==='unknown')unsettled=true;send(200,result);return;}
   if(method==='POST'&&url.pathname==='/connection-login'){if(!options.logins)throw new RequestError(503,'Login is not enabled by this host');const body=await readBody();callerCommand(body.commandId);send(200,await options.logins.start(body));return;}
   const settingsRoute={'/connections':'connect','/connection-authorizations':'authorize','/connection-authorizations/revoke':'revoke','/connection-defaults':'setDefaultRoute','/connection-defaults/remove':'removeDefaultRoute','/model-groups':'saveModelGroup','/model-groups/remove':'removeModelGroup'} as const;
   if(method==='POST'&&Object.hasOwn(settingsRoute,url.pathname)){const connections=options.connections;if(!connections)throw new RequestError(503,'Connection setup is not enabled by this host');const method=settingsRoute[url.pathname as keyof typeof settingsRoute],body=await readBody();await connections.save(()=>connections[method](body));send(200,connections.list());return;}
   if(method==='GET'&&url.pathname==='/assistant/works'){if([...url.searchParams.keys()].length)throw new RequestError(400,'No query is accepted');send(200,await assistant.works());return;}
   if(method==='GET'&&(url.pathname==='/assistant/members'||url.pathname==='/assistant/devices')){if(url.searchParams.size&&url.searchParams.size!==3)throw new RequestError(400,'Exact lifecycle receipt query required');const state=await store.readState(),service=url.pathname==='/assistant/members'?members:devices,view=url.searchParams.size?await service.outcome(Object.fromEntries(url.searchParams)):await service.read();if((await store.readState()).feedId!==state.feedId)throw new FeedAdmissionError();send(200,{...view,feedId:state.feedId});return;}
   if(method==='POST'&&url.pathname==='/assistant/members'){const body=await readBody();callerCommand(body.commandId);try{sendCommit(await members.act(body));}catch(error){if(error instanceof DomainError)send(error.code==='denied'?403:error.code==='conflict'?409:400,{error:error.message,outcome:'rejected',phase:'admission'});else throw error;}return;}
   if(method==='POST'&&url.pathname==='/assistant/devices'){const body=await readBody();callerCommand(body.commandId);try{sendCommit(await devices.act(body,mutationFeed));}catch(error){if(error instanceof DeviceAdmissionRefusedError)send(error.code==='denied'?403:error.code==='conflict'?409:400,{error:error.message,outcome:'rejected',phase:'admission'});else throw error;}return;}
   if(method==='POST'&&url.pathname==='/members/group'){if(!options.connections)throw new RequestError(503,'Connection setup is not enabled by this host');const body=await readBody();callerCommand(body.commandId);sendCommit(await members.setGroup(body,options.connections));return;}
   if(method==='GET'&&url.pathname==='/assistant/conversation'){if([...url.searchParams.keys()].some(k=>k!=='segment'&&k!=='member')||url.searchParams.getAll('segment').length>1||url.searchParams.getAll('member').length>1)throw new RequestError(400,'Only an optional segment and member query are accepted');const raw=url.searchParams.get('segment'),who=url.searchParams.get('member');if(raw!==null&&!/^[1-9][0-9]{0,15}$/.test(raw))throw new RequestError(400,'Invalid segment');queueMonthlyReconcile();
    // The Representative's read carries the admission decisions; every read lists members for the sidebar.
    const thread=who===null?null:await memberChat(who),view=await (thread?thread.chat:assistant).read(raw===null?undefined:Number(raw)),org=await members.read(),rules=thread?[]:await ruleChanges.decisions(view.feedId),scheduled=await schedules.conversation(view.segment?.number,thread?.member.id);const result={...view,...(thread&&(!view.segment||view.segment.number===1)?{greeting:{id:'greeting:'+thread.member.id,text:copy('ui.first.member-greeting',{member:thread.member.name,topic:org.decisions.find(d=>d.memberId===thread.member.id)?.title??''})}}:{}),members:org.members,apps:await apps.rail(),...(thread?{...scheduled,member:{id:thread.member.id,name:thread.member.name},decisions:[...await skills.decisions(thread.member.id),...await apps.decisions(thread.member.id)]}:{decisions:[...org.decisions,...await apps.decisions(null),...await effects.decisions(view.feedId),...rules,...(await monthlyBudget.read()).decisions],...scheduled,briefings:withRuleBriefings(scheduled!.briefings,rules)})};if(org.feedId!==view.feedId||(await store.readState()).feedId!==view.feedId)throw new FeedAdmissionError();send(200,result);return;}
   if(method==='POST'&&url.pathname==='/assistant/memory-candidates'){try{const body=await readBody(),{member,...decision}=body;const {chat}=await memberChat(member);const result=await chat.decideMemory(decision);send(result.status==='conflict'?409:200,result);}catch(error){if(error instanceof DomainError||error instanceof RequestError){send(error instanceof RequestError?error.status:error.code==='denied'?403:error.code==='conflict'?409:400,{error:error.message,outcome:'rejected',phase:'admission'});}else throw error;}return;}
   if(url.pathname==='/assistant/usage'){if([...url.searchParams.keys()].length)throw new RequestError(400,'No query is accepted');if(method==='GET'){queueMonthlyReconcile();send(200,await monthlyBudget.read());return;}if(method==='POST'){const body=await readBody();callerCommand(body.commandId);sendCommit(await monthlyBudget.configure(body));return;}}
   if(method==='POST'&&url.pathname==='/assistant/steering'){try{const body=await readBody();const {member,...confirmation}=body;const target=await memberChat(member);if(target.member.archivedAt!==undefined)throw new RequestError(409,'Member is archived');send(200,await target.chat.confirmSteer(confirmation));}catch(error){if(error instanceof DomainError||error instanceof RequestError){send(error instanceof RequestError?error.status:error.code==='denied'?403:error.code==='conflict'?409:400,{error:error.message,outcome:'rejected'});}else throw error;}return;}
   if(method==='POST'&&url.pathname==='/assistant/messages'){const body=await readBody();const {member:who,...message}=body;if(Object.keys(message).length!==4||!['commandId','segment','expectedRevision','text'].every(k=>Object.hasOwn(message,k)))throw new RequestError(400,'Exact conversation message fields required');callerCommand(body.commandId);if(!Number.isSafeInteger(body.segment)||Number(body.segment)<1||!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<0||typeof body.text!=='string')throw new RequestError(400,'Invalid segment, expected revision or text');const target=Object.hasOwn(body,'member')?await memberChat(who):null;if(target?.member.archivedAt!==undefined)throw new RequestError(409,'Member is archived');const result=await (target?.chat??assistant).send(message);send(result.message.status==='conflict'?409:200,result);return;}
   if(method==='GET'&&(url.pathname==='/assistant/results'||url.pathname==='/assistant/schedules'||url.pathname==='/assistant/permissions'||url.pathname==='/assistant/skills'||url.pathname==='/assistant/apps')){if([...url.searchParams.keys()].length)throw new RequestError(400,'No query is accepted');const state=await store.readState(),view=url.pathname==='/assistant/results'?await assistant.results():{feedId:state.feedId,...await (url.pathname==='/assistant/schedules'?schedules:url.pathname==='/assistant/skills'?skills:url.pathname==='/assistant/apps'?apps:permissions).read()};if((await store.readState()).feedId!==state.feedId)throw new FeedAdmissionError();send(200,view);return;}
   // A view runs app code that may call out with a secret: POST with a JSON body, so another site cannot start it without a preflight.
   if(method==='POST'&&url.pathname==='/assistant/apps/connect'){const body=await readBody();callerCommand(body.commandId);const admissionFeed=mutationFeed;const result=await apps.connect(body);if(result.status==='unknown')unsettled=true;if((await store.readState()).feedId!==admissionFeed){send(409,{status:'unknown'});return;}send(result.status==='conflict'?409:200,result);return;}
   if(method==='POST'&&url.pathname==='/assistant/apps/view'){
    const body=await readBody();if(Object.keys(body).some(k=>!['app','handler','ref'].includes(k)))throw new RequestError(400,'Only app, handler and an optional ref are accepted');
    const feedId=mutationFeed!,view=await apps.view({app:body.app,handler:body.handler,...('ref' in body?{ref:body.ref}:{})});
    if(body.app==='app-github'){
     let missions:Mission[]=[];
     if(options.catalog){try{missions=await readGithubReviewMissions(store,options.catalog,feedId);}catch(error){if(error instanceof MissionCatalogChangedError)throw new RequestError(409,'Database changed during app read');throw error;}}
     else{
      const works=await assistant.works();if(works.feedId!==feedId)throw new RequestError(409,'Database changed during app read');
      const ids=new Set(works.works.map(w=>w.missionId)),intake=options.connections?.list().representative?.intakeMissionId;if(intake)ids.add(intake);
      for(const id of ids){const read=await store.readState(id);if(read.feedId!==feedId)throw new RequestError(409,'Database changed during app read');if(read.snapshot)missions.push(read.snapshot.value);}
     }
     const reviews=(target:NonNullable<typeof view.github>)=>missions.flatMap(m=>githubReviews(m,target,Date.now()));
     if(view.github)view.reviews=reviews(view.github);for(const group of view.groups)for(const row of group.rows)if(row.github)row.reviews=reviews(row.github);
    }
    if((await store.readState()).feedId!==feedId)throw new RequestError(409,'Database changed during app read');if(draining)throw new HostDrainError();
    send(200,{...view,feedId,...view.frame&&!authenticate?{frame:{url:await appDocuments.publish(view.frame.html)}}:{}});return;
   }
   if(method==='POST'&&url.pathname==='/assistant/apps'){const body=await readBody();callerCommand(body.commandId);sendCommit(await apps.act(body),body.action==='install');return;}
   if(method==='POST'&&url.pathname==='/assistant/skills'){const body=await readBody();callerCommand(body.commandId);sendCommit(await skills.act(body));return;}
   if(method==='POST'&&url.pathname==='/assistant/permissions'){const body=await readBody();callerCommand(body.commandId);sendCommit(await permissions.act(body),body.action==='allow');return;}
   if(method==='POST'&&url.pathname==='/assistant/schedules'){const body=await readBody();callerCommand(body.commandId);sendCommit(await schedules.act(body),body.action==='create');return;}
   if(method==='POST'&&url.pathname==='/assistant/decisions'){const body=await readBody();callerCommand(body.commandId);if(typeof body.decisionId==='string'&&body.decisionId.startsWith(BUDGET_DECISION_PREFIX)){budgetCommand=true;const result=await monthlyBudget.decide(body);sendCommit(result);if(result.status==='committed'&&body.answer==='act')queueMonthlyReconcile();return;}if(typeof body.decisionId==='string'&&body.decisionId.startsWith(RULE_DECISION_PREFIX)){try{sendCommit(await ruleChanges.decide(body));}catch(error){if(error instanceof DomainError)send(error.code==='denied'?403:error.code==='conflict'?409:400,{error:error.message,outcome:'rejected',phase:'admission'});else throw error;}return;}sendCommit(await (typeof body.decisionId==='string'&&body.decisionId.startsWith(EFFECT_DECISION_PREFIX)?effects:typeof body.decisionId==='string'&&body.decisionId.startsWith(DECISION_PREFIX)?skills:typeof body.decisionId==='string'&&body.decisionId.startsWith(APP_DECISION_PREFIX)?apps:members).decide(body));return;}
   if(method==='POST'&&(url.pathname==='/assistant-settings'||url.pathname==='/assistant-settings/remove')){if(!options.connections)throw new RequestError(503,'Connection setup is not enabled by this host');const body=await readBody();send(200,url.pathname==='/assistant-settings'?await assistant.setSettings(body):await assistant.removeSettings(body));return;}
   const connectionRoute=/^\/connections\/([^/]+)\/(models|profiles)$/.exec(url.pathname);
   if(method==='POST'&&connectionRoute){if(!options.connections)throw new RequestError(503,'Connection setup is not enabled by this host');const connectionId=decodeIdentifier(connectionRoute[1]!,'connection identifier');const input=await readBody();if(connectionRoute[2]==='models'){if(Object.keys(input).length!==1||typeof input.expectedConfigHash!=='string')throw new RequestError(400,'Exact discovery fields required');send(200,await options.connections.discover(connectionId,input.expectedConfigHash));}else{const connections=options.connections;const {profileId}=await connections.save(()=>connections.selectModel(connectionId,input));send(200,{profileId,...connections.list()});}return;}
   if(method==='GET'&&url.pathname==='/work-inbox'){
    if(!options.inbox)throw new RequestError(503,'Unresolved Work inbox is not enabled by this host');
    const feedId=req.headers['x-massion-feed'];if(feedId!==undefined)identifier(feedId,'Feed identity');const keys=['afterMission','afterWork','cursor'];if([...url.searchParams.keys()].some(k=>!keys.includes(k))||keys.some(k=>url.searchParams.getAll(k).length>1))throw new RequestError(400,'Exact Work inbox query fields required');
    const afterMission=url.searchParams.get('afterMission'),afterWork=url.searchParams.get('afterWork'),cursor=url.searchParams.get('cursor');
    if([afterMission,afterWork,cursor].some(v=>v===null)&&[afterMission,afterWork,cursor].some(v=>v!==null))throw new RequestError(400,'Exact Work page boundary required');if(afterMission!==null){identifier(afterMission,'Mission page identity');identifier(afterWork,'Work page identity');}if(cursor!==null&&(!/^\d+$/.test(cursor)||!Number.isSafeInteger(Number(cursor))))throw new RequestError(400,'Invalid Work inbox cursor');
    try{send(200,await options.inbox.readInbox({... (afterMission!==null?{afterMission,afterWork:afterWork!,cursor:Number(cursor)}:{}),...(feedId!==undefined?{feedId}: {})}));}catch(error){if(error instanceof WorkInboxChangedError){send(409,{error:error.message,reason:error.reason});return;}if(error instanceof TypeError)throw new RequestError(400,error.message);throw error;}return;
   }
   if(method==='GET'&&url.pathname==='/mission-catalog'){
    if(!options.catalog)throw new RequestError(503,'Stored Mission discovery is not enabled by this host');
    if([...url.searchParams.keys()].some(k=>!['after','cursor'].includes(k))||['after','cursor'].some(k=>url.searchParams.getAll(k).length>1))throw new RequestError(400,'Exact Mission catalog query fields required');
    const after=url.searchParams.get('after'),cursor=url.searchParams.get('cursor'),feedId=req.headers['x-massion-feed'];if(feedId!==undefined)identifier(feedId,'Feed identity');
    if((after===null)!==(cursor===null))throw new RequestError(400,'Exact page boundary required');if(after!==null)identifier(after,'Mission page identity');if(cursor!==null&&(!/^\d+$/.test(cursor)||!Number.isSafeInteger(Number(cursor))))throw new RequestError(400,'Invalid Mission catalog cursor');
    try{send(200,await options.catalog.readCatalog({... (after!==null?{after,cursor:Number(cursor)}:{}),...(feedId!==undefined?{feedId}: {})}));}catch(error){if(error instanceof MissionCatalogChangedError){send(409,{error:error.message,reason:error.reason});return;}if(error instanceof TypeError)throw new RequestError(400,error.message);throw error;}return;
   }
   const neighborhoodRoute=/^\/missions\/([^/]+)\/neighborhood$/.exec(url.pathname);
   if(method==='GET'&&neighborhoodRoute){if(!options.neighborhood)throw new RequestError(503,'Knowledge neighborhood is not enabled by this host');const keys=['entity','version','revision','after','cursor'];if([...url.searchParams.keys()].some(k=>!keys.includes(k))||keys.some(k=>url.searchParams.getAll(k).length>1))throw new RequestError(400,'Exact neighborhood query fields required');const feedId=req.headers['x-massion-feed'];if(feedId!==undefined)identifier(feedId,'Feed identity');const number=(key:string)=>{const v=url.searchParams.get(key);if(v===null)return undefined;if(!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v)))throw new RequestError(400,'Invalid neighborhood '+key);return Number(v);};const input={missionId:decodeMissionIdentifier(neighborhoodRoute[1]!),referenceId:url.searchParams.get('entity')!,version:number('version')!,...(feedId!==undefined?{feedId}:{}),... (url.searchParams.has('revision')?{revision:number('revision')}:{}),...(url.searchParams.has('after')?{after:number('after')}:{}),...(url.searchParams.has('cursor')?{cursor:number('cursor')}:{})};try{neighborhoodInput(input);const result=await options.neighborhood.readNeighborhood(input);send(result?200:404,result??{error:'Unknown Mission'});}catch(error){if(error instanceof NeighborhoodChangedError){send(409,{error:error.message,reason:error.reason});return;}if(error instanceof NeighborhoodLimitError){send(503,{error:error.message});return;}if(error instanceof TypeError)throw new RequestError(400,error.message);throw error;}return;}
   if(method==='GET'&&url.pathname==='/read-state'){const id=url.searchParams.get('mission')??undefined;if(id!==undefined)missionIdentifier(id);send(200,await store.readState(id));return;}
   if(method==='GET'&&url.pathname==='/events'){const after=Number(url.searchParams.get('after')??0);const limit=Number(url.searchParams.get('limit')??100);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new RequestError(400,'Invalid event cursor or limit');const feedId=req.headers['x-massion-feed'];if(feedId!==undefined)identifier(feedId,'Feed identity');send(200,await store.readCatchup(after,feedId,limit));return;}
   if(method==='POST'&&url.pathname==='/missions'){
    const body=await readBody();identifier(body.id,'Mission identifier');callerCommand(body.commandId);
    const {id,purpose,scope,constraints,criteria}=body;
    if(!criteria||typeof criteria!=='object'||Array.isArray(criteria))throw new RequestError(400,'Acceptance criteria required');
    sendCommit(await product.create({id,purpose,scope,constraints,criteria} as Parameters<ProductService['create']>[0],body.commandId),true);return;
   }
   const workRoute=/^\/missions\/([^/]+)\/(work|commands|run|run-sequence|preflight|memory|memory-conflict|memory-expiry|memory-retirement|relations|documents|work-source|work-prerequisite|work-question|work-answer|work-message|mission-message|organization|revision|mission-constraints|work-budget|growth|growth-proposals|growth-evaluation)$/.exec(url.pathname);
   if(method==='POST'&&workRoute){
    const missionId=decodeMissionIdentifier(workRoute[1]!);const body=await readBody();callerCommand(body.commandId);
    if(!Number.isSafeInteger(body.expectedRevision)||Number(body.expectedRevision)<1)throw new RequestError(400,'Expected revision required');
    if(workRoute[2]==='growth-proposals'||workRoute[2]==='growth-evaluation'){
     identifier(body.growthId,'Growth identifier');
     if(workRoute[2]==='growth-proposals'){
      if(!body.candidate||typeof body.candidate!=='object'||Array.isArray(body.candidate))throw new RequestError(400,'Exact candidate memory required');identifier((body.candidate as Record<string,unknown>).id,'Memory identifier');
      sendCommit(await product.proposeGrowth(missionId,body as Parameters<ProductService['proposeGrowth']>[1]));
     }else sendCommit(await product.evaluateGrowth(missionId,body as Parameters<ProductService['evaluateGrowth']>[1]));return;
    }
    if(workRoute[2]==='growth'){
     if(Object.keys(body).some(key=>!['commandId','expectedRevision','growthId','baseline','candidate','action'].includes(key)))throw new RequestError(400,'Only exact owner Growth action fields are accepted');
     identifier(body.growthId,'Growth identifier');
     for(const key of ['baseline','candidate'])if(typeof body[key]!=='string'||!/^.+@[1-9]\d*$/.test(body[key] as string)||(body[key] as string).length>16000)throw new RequestError(400,'Exact Growth memory version required');
     if(body.action!=='adopt'&&body.action!=='revert')throw new RequestError(400,'Only deliberate adopt or revert is accepted');
     const input=body as Parameters<ProductService['adoptGrowth']>[1];sendCommit(await (body.action==='adopt'?product.adoptGrowth(missionId,input):product.revertGrowth(missionId,input)));return;
    }
    if(workRoute[2]==='work-budget'){
     if(Object.keys(body).some(key=>!['commandId','expectedRevision','workId','limit','reason'].includes(key)))throw new RequestError(400,'Only owner Work budget fields are accepted');
     identifier(body.workId,'Work identifier');
     sendCommit(await product.reviseBudget(missionId,body as Parameters<ProductService['reviseBudget']>[1]));return;
    }
    if((workRoute[2]==='work-question'||workRoute[2]==='work-answer')){identifier(body.workId,'Work identifier');identifier(body.questionId,'Question identifier');sendCommit(await product.clarifyWork(missionId,body as Parameters<ProductService['clarifyWork']>[1],workRoute[2]==='work-answer'));return;}
    if(workRoute[2]==='mission-message'){sendCommit(await product.appendMissionMessage(missionId,body as Parameters<ProductService['appendMissionMessage']>[1]));return;}
    if(workRoute[2]==='memory-expiry'){sendCommit(await product.declareMemoryExpiry(missionId,body as Parameters<ProductService['declareMemoryExpiry']>[1]));return;}
    if(workRoute[2]==='memory-conflict'){sendCommit(await product.declareMemoryConflict(missionId,body as Parameters<ProductService['declareMemoryConflict']>[1]));return;}
    if(workRoute[2]==='work-message'){identifier(body.workId,'Work identifier');identifier(body.messageId,'Message identifier');if(body.replyTo!==null)identifier(body.replyTo,'Reply message identifier');sendCommit(await product.appendWorkMessage(missionId,body as Parameters<ProductService['appendWorkMessage']>[1]));return;}
    if(workRoute[2]==='work-prerequisite'){identifier(body.workId,'Work identifier');identifier(body.prerequisiteId,'Prerequisite Work identifier');sendCommit(await product.attachWorkPrerequisite(missionId,body as Parameters<ProductService['attachWorkPrerequisite']>[1]));return;}
    if(workRoute[2]==='work-source'){identifier(body.workId,'Work identifier');sendCommit(await product.attachWorkSource(missionId,body as Parameters<ProductService['attachWorkSource']>[1]));return;}
    if(workRoute[2]==='documents'){sendCommit(await product.captureDocument(missionId,body as Parameters<ProductService['captureDocument']>[1]));return;}
    if(workRoute[2]==='relations'){sendCommit(await product.recordRelation(missionId,body as Parameters<ProductService['recordRelation']>[1]));return;}
    if(workRoute[2]==='organization'){sendCommit(await product.reviseOrganization(missionId,body as Parameters<ProductService['reviseOrganization']>[1]));return;}
    if(workRoute[2]==='mission-constraints'){sendCommit(await product.reviseMissionConstraints(missionId,body as Parameters<ProductService['reviseMissionConstraints']>[1]));return;}
    if(workRoute[2]==='revision'){
     if(Object.keys(body).some(key=>!['commandId','expectedRevision','purpose','criteria'].includes(key)))throw new RequestError(400,'Only Mission purpose and acceptance revision fields are accepted');
     const criteria=body.criteria;
     if(!criteria||typeof criteria!=='object'||Array.isArray(criteria)||Object.keys(criteria).some(key=>!['version','description','oracle'].includes(key)))throw new RequestError(400,'Acceptance criteria require version, description and oracle only');
     sendCommit(await product.reviseMission(missionId,body as Parameters<ProductService['reviseMission']>[1]));return;
    }
    if(workRoute[2]==='memory-retirement'){
     if(Object.keys(body).some(key=>!['commandId','expectedRevision','memoryId','version','reason'].includes(key)))throw new RequestError(400,'Only explicit memory retirement fields are accepted');
     identifier(body.memoryId,'Memory identifier');
     sendCommit(await product.retireMemory(missionId,body as Parameters<ProductService['retireMemory']>[1]));return;
    }
    if(workRoute[2]==='memory'){
     if(Object.keys(body).some(key=>!['commandId','expectedRevision','memory'].includes(key)))throw new RequestError(400,'Only explicit memory fields are accepted');
     const memory=body.memory;
     if(!memory||typeof memory!=='object'||Array.isArray(memory)||Object.keys(memory).some(key=>!['id','version','content','source','name','sourceWork'].includes(key)))throw new RequestError(400,'Explicit memory requires id, version, content, source and optional exact display metadata');
     identifier((memory as Record<string,unknown>).id,'Memory identifier');
     sendCommit(await product.saveMemory(missionId,body as Parameters<ProductService['saveMemory']>[1]),true);return;
    }
    if(workRoute[2]==='preflight'){identifier(body.workId,'Work identifier');const result=await product.preflight(missionId,body.workId,Number(body.expectedRevision),selection(body));if(!result)throw new RequestError(404,'Unknown Mission or Work');send(result.diagnostics.some(d=>d.code==='revision_conflict')?409:200,result);return;}
    if(workRoute[2]==='run-sequence'){selection(body);const result=await product.runSequence(missionId,body as unknown as Parameters<ProductService['runSequence']>[1]);send(result.results.at(-1)?.status==='conflict'?409:200,result);return;}
    if(workRoute[2]==='run'){identifier(body.workId,'Work identifier');if(!product.runtime){send(503,{error:'No explicitly configured Work runtime. No provider request was made.',outcome:'rejected'});return;}const result=await product.run(missionId,body.workId,body.commandId,Number(body.expectedRevision),selection(body));send(result.status==='conflict'?409:200,result);return;}
    if(workRoute[2]==='work'){identifier(body.workId,'Work identifier');sendCommit(await product.admit(missionId,body as Parameters<ProductService['admit']>[1]),true);return;}
    if(!body.command||typeof body.command!=='object'||!['cancel','steer','quarantine-runtime','close-expired-runtime'].includes((body.command as {type:string}).type))throw new RequestError(400,'Only cancel, steer, quarantine-runtime and close-expired-runtime are exposed');
    identifier((body.command as {workId:unknown}).workId,'Work identifier');sendCommit(await product.intervene(missionId,body as Parameters<ProductService['intervene']>[1]));return;
   }
   const memorySearchRoute=/^\/missions\/([^/]+)\/memory-search$/.exec(url.pathname);
   if(method==='GET'&&memorySearchRoute){const missionId=decodeMissionIdentifier(memorySearchRoute[1]!),required=['text','revision'],allowed=[...required,'after'];if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1)||required.some(k=>!url.searchParams.has(k)))throw new RequestError(400,'Unique literal content search query fields required');const feed=req.headers['x-massion-feed'];identifier(feed,'Original feed identity');const pageNumber=(key:string)=>{const raw=url.searchParams.get(key)!;if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new RequestError(400,'Invalid content search '+key);return Number(raw);};const result=await searchMemoryContent(store,missionId,{text:url.searchParams.get('text')!,feedId:feed as string,revision:pageNumber('revision'),...(url.searchParams.has('after')?{after:pageNumber('after')}:{})});send(result?200:404,result??{error:'Unknown Mission'});return;}
   const memoryFindRoute=/^\/missions\/([^/]+)\/memory-versions$/.exec(url.pathname);
   if(method==='GET'&&memoryFindRoute){const missionId=decodeMissionIdentifier(memoryFindRoute[1]!),required=['id','revision'],allowed=[...required,'after'];if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1)||required.some(k=>!url.searchParams.has(k)))throw new RequestError(400,'Unique literal memory discovery query fields required');const feed=req.headers['x-massion-feed'];identifier(feed,'Original feed identity');const pageNumber=(key:string)=>{const raw=url.searchParams.get(key)!;if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new RequestError(400,'Invalid memory discovery '+key);return Number(raw);};const result=await findMemoryVersions(store,missionId,{id:url.searchParams.get('id')!,feedId:feed as string,revision:pageNumber('revision'),...(url.searchParams.has('after')?{after:pageNumber('after')}:{})});send(result?200:404,result??{error:'Unknown Mission'});return;}
   const memoryUsageRoute=/^\/missions\/([^/]+)\/memory-usage$/.exec(url.pathname);
   if(method==='GET'&&memoryUsageRoute){const missionId=decodeMissionIdentifier(memoryUsageRoute[1]!),required=['id','version','hash'],allowed=[...required,'revision','after'];if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1)||required.some(k=>!url.searchParams.has(k)))throw new RequestError(400,'Unique exact memory query fields required');const feed=req.headers['x-massion-feed'];if(feed!==undefined)identifier(feed,'Feed identity');const pageNumber=(key:string)=>{const raw=url.searchParams.get(key)!;if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new RequestError(400,'Invalid memory usage '+key);return Number(raw);};const result=await readMemoryUsage(store,missionId,{id:url.searchParams.get('id')!,version:Number(url.searchParams.get('version')),versionHash:url.searchParams.get('hash')!,...(feed===undefined?{}:{feedId:feed}),...(url.searchParams.has('revision')?{revision:pageNumber('revision')}:{}) ,...(url.searchParams.has('after')?{after:pageNumber('after')}:{})});send(result?200:404,result??{error:'Unknown Mission or exact memory version'});return;}
   const missionConversationRoute=/^\/missions\/([^/]+)\/mission-conversation$/.exec(url.pathname);
   if(method==='GET'&&missionConversationRoute){if([...url.searchParams.keys()].length)throw new RequestError(400,'Mission conversation has no query fields');const missionId=decodeMissionIdentifier(missionConversationRoute[1]!),feed=req.headers['x-massion-feed'];if(feed!==undefined)identifier(feed,'Feed identity');const result=await product.readMissionConversation(missionId,feed);send(result?200:404,result??{error:'Unknown Mission'});return;}
   const conversationRoute=/^\/missions\/([^/]+)\/work-conversation$/.exec(url.pathname);
   if(method==='GET'&&conversationRoute){const missionId=decodeMissionIdentifier(conversationRoute[1]!),workId=url.searchParams.get('work'),feed=req.headers['x-massion-feed'];if([...url.searchParams.keys()].length!==1||url.searchParams.getAll('work').length!==1)throw new RequestError(400,'Unique exact conversation Work query required');identifier(workId,'Work identifier');if(feed!==undefined)identifier(feed,'Feed identity');const result=await product.readWorkConversation(missionId,workId,feed);send(result?200:404,result??{error:'Unknown Mission or Work'});return;}
   const ownershipRoute=/^\/missions\/([^/]+)\/run-ownership$/.exec(url.pathname);
   if(method==='GET'&&ownershipRoute){const missionId=decodeMissionIdentifier(ownershipRoute[1]!),workId=url.searchParams.get('work'),feed=req.headers['x-massion-feed'];if([...url.searchParams.keys()].length!==1||url.searchParams.getAll('work').length!==1)throw new RequestError(400,'Unique exact ownership Work query required');identifier(workId,'Work identifier');if(feed!==undefined)identifier(feed,'Feed identity');const result=await product.readRunOwnership(missionId,workId,feed);send(result?200:404,result??{error:'Unknown Mission or Work'});return;}
   const documentRoute=/^\/missions\/([^/]+)\/(documents|document|document-usage)$/.exec(url.pathname);
   if(method==='GET'&&documentRoute){
    const id=decodeMissionIdentifier(documentRoute[1]!),feedId=req.headers['x-massion-feed'];if(feedId!==undefined)identifier(feedId,'Feed identity');
    const search=documentRoute[2]==='documents',allowed=search?['query']:['id','version','sha256'];if([...url.searchParams.keys()].some(key=>!allowed.includes(key)||url.searchParams.getAll(key).length!==1)||allowed.some(key=>!url.searchParams.has(key)))throw new RequestError(400,'Unique exact document query fields required');
    const result=search?await searchDocuments(store,id,{query:url.searchParams.get('query')!,...(feedId===undefined?{}:{feedId})}):await (documentRoute[2]==='document-usage'?readDocumentUsage:readDocument)(store,id,{id:url.searchParams.get('id')!,version:Number(url.searchParams.get('version')),contentSha256:url.searchParams.get('sha256')!,...(feedId===undefined?{}:{feedId})});send(result?200:404,result??{error:'Unknown Mission or document version'});return;
   }
   const trailRoute=/^\/missions\/([^/]+)\/reflection-trail$/.exec(url.pathname);
   if(method==='GET'&&trailRoute){
    const id=decodeMissionIdentifier(trailRoute[1]!),workId=url.searchParams.get('workId'),revision=url.searchParams.get('revision');identifier(workId,'Work identifier');
    if([...url.searchParams.keys()].some(k=>!['workId','revision'].includes(k)||url.searchParams.getAll(k).length!==1)||!revision||!/^\d+$/.test(revision)||!Number.isSafeInteger(Number(revision)))throw new RequestError(400,'Unique Work and revision query fields required');
    const feedId=req.headers['x-massion-feed'];if(feedId!==undefined)identifier(feedId,'Feed identity');const result=await product.reflectionTrail(id,workId,Number(revision),feedId);send(result?200:404,result??{error:'Unknown Mission or Work'});return;
   }
   const rejectedRoute=/^\/missions\/([^/]+)\/rejected-artifact$/.exec(url.pathname);
   if(method==='GET'&&rejectedRoute){
    const id=decodeMissionIdentifier(rejectedRoute[1]!),workId=url.searchParams.get('work'),binding=url.searchParams.get('binding'),version=url.searchParams.get('version'),sha256=url.searchParams.get('sha256');identifier(workId,'Work identifier');const allowed=['work','binding','version','sha256'];
    if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1)||!binding||!/^[a-f0-9]{64}$/.test(binding)||!version||!/^\d+$/.test(version)||!Number.isSafeInteger(Number(version))||Number(version)<1||!sha256||!/^[a-f0-9]{64}$/.test(sha256))throw new RequestError(400,'Unique exact rejected candidate query fields required');
    const feedId=req.headers['x-massion-feed'];if(feedId!==undefined)identifier(feedId,'Feed identity');const result=await product.readRejectedText(id,workId,{binding,artifactVersion:Number(version),artifactSha256:sha256,...(feedId===undefined?{}:{feedId})});send(result?200:404,result??{error:'Unknown Mission or Work'});return;
   }
   const recordArtifactRoute=/^\/missions\/([^/]+)\/(record-artifact|record-binary-artifact)$/.exec(url.pathname);
   if(method==='GET'&&recordArtifactRoute){
    const id=decodeMissionIdentifier(recordArtifactRoute[1]!),workId=url.searchParams.get('work'),recordId=url.searchParams.get('record'),version=url.searchParams.get('version'),sha256=url.searchParams.get('sha256');identifier(workId,'Work identifier');identifier(recordId,'Record identifier');
    const allowed=['work','record','version','sha256'];if([...url.searchParams.keys()].some(key=>!allowed.includes(key)||url.searchParams.getAll(key).length!==1)||!version||!/^\d+$/.test(version)||!Number.isSafeInteger(Number(version))||Number(version)<1||!sha256||!/^[a-f0-9]{64}$/.test(sha256))throw new RequestError(400,'Unique exact accepted Record/artifact query fields required');
    const feedId=req.headers['x-massion-feed'];if(feedId!==undefined)identifier(feedId,'Feed identity');const input={recordId,artifactVersion:Number(version),artifactSha256:sha256,...(feedId===undefined?{}:{feedId})},result=recordArtifactRoute[2]==='record-binary-artifact'?await readBinaryRecordArtifact(store,options.artifacts,id,workId,input):await product.readAcceptedText(id,workId,input);send(result?200:404,result??{error:'Unknown Mission or Work'});return;
   }
   const budgetHistoryRoute=/^\/missions\/([^/]+)\/work-(budget|intervention)-history$/.exec(url.pathname);
   if(method==='GET'&&budgetHistoryRoute){
    const id=decodeMissionIdentifier(budgetHistoryRoute[1]!),workId=url.searchParams.get('work');identifier(workId,'Work identifier');
    const allowed=['work','after','limit','through'];
    if([...url.searchParams.keys()].some(key=>!allowed.includes(key)||url.searchParams.getAll(key).length!==1))throw new RequestError(400,'Only unique Work history query fields are accepted');
    const bound=(key:string,fallback?:number)=>{const raw=url.searchParams.get(key);if(raw===null)return fallback;if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new RequestError(400,'Invalid Work history '+key);return Number(raw);};
    const after=bound('after',0)!,limit=bound('limit',100)!,through=bound('through'),feedId=req.headers['x-massion-feed'];
    if(feedId!==undefined)identifier(feedId,'Feed identity');
    if(limit<1||limit>100||through!==undefined&&through<after||after>0&&through===undefined||(after>0||through!==undefined)&&!feedId)throw new RequestError(400,'Invalid Work history bounds or missing continuation feed/boundary');
    const history=await (budgetHistoryRoute[2]==='intervention'?readWorkInterventionHistory:readWorkBudgetHistory)(store,id,workId,{after,limit,...(through===undefined?{}:{through}),...(feedId===undefined?{}:{feedId})});
    send(history?200:404,history??{error:'Unknown Mission or Work'});return;
   }
   const impactRoute=/^\/missions\/([^/]+)\/impact$/.exec(url.pathname);
   if(method==='GET'&&impactRoute){
    const id=decodeMissionIdentifier(impactRoute[1]!),entity=url.searchParams.get('entity')??'',version=Number(url.searchParams.get('version'));
    try{validateImpactInput(id,entity,version);}catch{throw new RequestError(400,'A nonempty entity and positive safe version are required');}
    if(!options.knowledge)throw new RequestError(503,'Relation impact queries are not enabled by this host');
    let impact;try{impact=await options.knowledge.readImpact(id,entity,version);}catch(error){if(error instanceof RelationImpactLimitError)throw new RequestError(422,error.message);throw error;}
    send(impact?200:404,impact??{error:'Unknown Mission'});return;
   }
   if(method==='GET'&&url.pathname.startsWith('/missions/')){const id=decodeMissionIdentifier(url.pathname.slice(10));const state=await store.load(id);send(state?200:404,state??{error:'Unknown Mission'});return;}
   if(method==='POST'&&url.pathname==='/fixture-run'){
    const body=await readBody();
    if(Object.keys(body).length!==0){send(400,{error:'This route accepts only the built-in fixture command'});return;}
    if(running){send(409,{error:'A fixture is already running; observe its state before starting another'});return;}
    running=true;try{const result=await runGrowthScenario(store,workspaceRoot);send(201,{missionId:result.missionId,revision:result.snapshot?.revision,evidenceClass:'fixture'});}finally{running=false;}return;
   }
   send(404,{error:'Unknown route'});
   };
   if(mutationFeed)await withAdmissionFeed(mutationFeed,execute);else await execute();
  }catch(error){if(error instanceof HostDrainError){send(503,{error:error.message,outcome:'rejected',retryable:false});return;}if(error instanceof Error&&['RunUnsettledError','RunAdmissionUnknownError','CommitOutcomeUnknownError'].includes(error.name))unsettled=true;if(error instanceof Error&&error.name==='RunAdmissionUnknownError'){send(503,{error:error.message,outcome:'unknown',retryable:false,runId:(error as Error&{runId:string}).runId});return;}if(error instanceof ConversationReadError||error instanceof RuntimeOwnershipError){send(error.status,{error:error.message});return;}if(error instanceof MemoryUsageError){send(error.status,{error:error.message});return;}if(error instanceof DocumentReadError){send(error.status,{error:error.message});return;}if(error instanceof RecordArtifactError){send(error.status,{error:error.message});return;}if(error instanceof FeedAdmissionError){send(503,{error:error.message,reason:'feed',outcome:'unknown'});return;}if(error instanceof Error&&error.name==='RunUnsettledError'){const run=error as Error&{runId:string;snapshot?:unknown};send(503,{error:run.message,outcome:'admitted-unsettled',retryable:false,runId:run.runId,snapshot:run.snapshot});return;}if(error instanceof RequestError){send(error.status,{error:error.message,...(budgetCommand?{outcome:'rejected'}:{})});return;}if(error instanceof DomainError||error instanceof EffectAdmissionRejectedError){send(error.code==='denied'?403:error.code==='conflict'?409:400,{error:error.message,...(budgetCommand?{outcome:'rejected'}:{}),...(error instanceof EffectAdmissionRejectedError||error instanceof ConnectionLifecycleRefusedError?{outcome:'rejected',phase:'admission'}:{})});return;}if(error instanceof Error&&error.name==='CommitOutcomeUnknownError'){send(503,{error:'Commit outcome is unknown. Read durable events before deciding any next action.',outcome:'unknown'});return;}if(error instanceof Error&&error.name==='StorageContentionError'){send(503,{error:'The transaction was rolled back due to contention. Refresh before a deliberate retry.',outcome:'rejected',retryable:true});return;}if(error instanceof Error&&error.name==='EventCursorError'){send(409,{error:'Event feed identity or cursor no longer matches this database; read /read-state before resuming catch-up.'});return;}console.error(error instanceof Error?error.message:'Workbench failure');send(500,{error:'Operation failed; inspect local host logs. Unresolved effects are not replayed automatically.'});}
  finally{if(method==='POST'){void feed.wake();queueMonthlyReconcile();}}
 });
 server.on('close',()=>{clearInterval(scheduler);feed.close();void appDocuments.close();});
 queueMonthlyReconcile();
 return Object.assign(server,{effectDecisions:effects,drain(){if(drainPromise)return drainPromise;draining=true;connectionLifecycle?.beginDrain();devices.beginDrain();apps.beginDrain();effects.beginDrain();feed.close();clearInterval(scheduler);product.runtime?.beginDrain?.();assistant.beginDrain();options.logins?.beginDrain();for(const chat of memberChats.values())chat.beginDrain();drainPromise=new Promise(resolve=>{let done=false,timedOut=false,httpClosed=false,runtimeSettled=false;const finish=()=>{if(done||!timedOut&&(!httpClosed||!runtimeSettled))return;done=true;clearTimeout(timer);resolve({status:timedOut||unsettled||schedules.unsettled?'unsettled':'drained',timedOut});};const timer=setTimeout(()=>{timedOut=true;server.closeAllConnections();finish();},drainTimeoutMs);void (async()=>{const results=await Promise.allSettled([product.runtime?.drain?.(),assistant.drain(),startupResume,budgetTask,effects.drain(),devices.drain(),connectionLifecycle?.drain(),options.logins?.drain(),(async()=>{await ticking;if(schedules.unsettled)throw new Error('A scheduled step is unsettled; inspect durable state before any next action.');})(),...[...memberChats.values()].map(chat=>chat.drain())]);if(results.some(result=>result.status==='rejected'))unsettled=true;})().then(()=>{runtimeSettled=true;finish();},()=>{unsettled=true;runtimeSettled=true;finish();});server.close(()=>{void appDocuments.close().then(()=>{httpClosed=true;finish();},()=>{unsettled=true;httpClosed=true;finish();});});});return drainPromise;}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const stopping=new AbortController();let server:ReturnType<typeof createWorkbench>|undefined,shutdown:Promise<void>|undefined;
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{
  if(shutdown)return;stopping.abort();const draining=server?.drain();
  const timer=setTimeout(()=>{console.error(JSON.stringify({hostShutdown:{status:'unsettled',timedOut:true}}));process.exit(1);},10000);
  shutdown=(async()=>{try{await startup;const result=await draining??{status:'drained',timedOut:false};console.log(JSON.stringify({hostShutdown:result}));process.exit(result.status==='drained'?0:1);}catch(error){console.error('Local host startup/drain unsettled; inspect the stored schema and original durable state. No write retry or remote stop inferred.',error instanceof Error?error.message:String(error));process.exit(1);}finally{clearTimeout(timer);}})();
 });
 const startup=(async()=>{
 const daemonSecret=inheritedDaemonSecret();
 const hostStartup=await loadHostStartup(process.argv.slice(2));
 stopping.signal.throwIfAborted();
 const workspaceRoot=resolve('.runtime/workspaces'),artifacts=new TextArtifactStore(resolve(workspaceRoot,'model-artifacts'));
 const textReader=hostStartup.restoredArtifacts?await loadRestoredArtifactReader(hostStartup.restoredArtifacts,artifacts):artifacts,binaryArtifacts=new BinaryArtifactStore(resolve(artifacts.root,'binary-results'));
 const artifactReader:ArtifactReader={read:a=>textReader.read(a),readBytes:a=>binaryArtifacts.readBytes(a)};
 const endpoint=process.env.MASSION_SURREAL_RPC??process.env.MASSION_TEST_SURREAL_RPC;
 if(!endpoint)throw new Error('Set MASSION_SURREAL_RPC to an authorized local /rpc endpoint');
 const transport=createHttpRpcTransport({endpoint,namespace:process.env.MASSION_SURREAL_NAMESPACE??process.env.MASSION_TEST_SURREAL_NAMESPACE??'massion',database:process.env.MASSION_SURREAL_DATABASE??process.env.MASSION_TEST_SURREAL_DATABASE??'massion'});
 await initializeSurrealSchema(transport,stopping.signal);
 const port=Number(process.env.MASSION_PORT??8765);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid development port');
 const store=new SurrealStore<Mission>(transport);const connections=createHostConnections(store,artifacts,hostStartup,{transport:(url,init)=>fetch(url,init),readEnvironment:name=>process.env[name],settings:new SurrealHostSettings(transport)});
 await connections.restoreSettings();{const restored=connections.list();if(restored.persistence)console.log(JSON.stringify({hostSettings:{revision:restored.persistence.revision,grants:restored.grants.length,activeLiveGrants:restored.grants.filter(g=>g.mode==='live'&&g.status==='active').length,liveDisabledGrants:restored.grants.filter(g=>g.status==='live-disabled').length,defaultRoutes:restored.runtime.defaultRoutes.length,representativeRoute:restored.representative?.status??'off'}}));}
 stopping.signal.throwIfAborted();
 server=createWorkbench(store,workspaceRoot,{logins:new LoginConnections(),daemonSecret,appSecrets:new KeychainSecretSlots(),connections,artifacts:artifactReader,neighborhood:new SurrealNeighborhood(transport),inbox:new SurrealWorkInbox(transport),catalog:new SurrealMissionCatalog(transport),knowledge:new SurrealRelationImpact(transport)});
 server.listen(port,'127.0.0.1',()=>console.log(`Massion development workbench: http://127.0.0.1:${port}`));
 })().catch(error=>{if(error!==stopping.signal.reason)throw error;});
 try{await startup;}catch(error){if(!stopping.signal.aborted)throw error;}
}
