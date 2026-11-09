import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';

const member={id:'member-quill',name:'퀼',look:{shape:'square',color:'agent-1'},modelGroup:'default',archivedAt:null,workCount:2,scheduleCount:0,lastActiveAt:1000};
function fixture(){
 const state={posted:[] as {path:string;body:any}[],pending:null as ((value:any)=>void)|null,members:[member],archived:[] as (typeof member)[],receipts:new Set<string>(),devices:[{id:'laptop',name:'내 노트북',agent:'Codex',status:'offline',available:true,admitted:true,decisionId:'remote'}]};
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){state.posted.push({path,body:JSON.parse(options.body)});return new Promise(resolve=>{state.pending=resolve;});}
  if(path.startsWith('/assistant/members?')){const commandId=new URL('http://fixture'+path).searchParams.get('commandId')!;return reply({feedId:'feed:a',commandId,status:state.receipts.has(commandId)?'replayed':'unknown'});}
  if(path.startsWith('/assistant/devices?')){const commandId=new URL('http://fixture'+path).searchParams.get('commandId')!;return reply({feedId:'feed:a',commandId,status:state.receipts.has(commandId)?'settled':'unknown'});}
  if(path==='/assistant/members')return reply({feedId:'feed:a',revision:1,members:state.members,archived:state.archived});
  if(path==='/assistant/devices')return reply({feedId:'feed:a',revision:0,devices:state.devices});
  if(path==='/connections')return reply({connections:[],modelGroups:[],runtime:{connections:[],defaultRoutes:[]},configHash:'hash-a'});
  if(path==='/assistant/skills')return reply({skills:[],improvements:[]});
  if(path==='/assistant/apps')return reply({apps:[],catalog:[]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:1,members:[member],decisions:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});return reply({});
 });return {app,state};
}
const byId=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id)!;
const open=async(app:ReturnType<typeof harness>,name:string)=>{await app.node('me-settings').fire('click');await settle();await app.node('settings-nav-'+name).fire('click');await settle();};

test('device reconnect sends once while overlapping and remains locked after an unknown response',async()=>{
 const {app,state}=fixture();await settle();await open(app,'devices');const button=byId(app,'settings-device-laptop');assert.ok(button);
 const first=button.fire('click');await settle();await button.fire('click');assert.equal(state.posted.length,1);assert.equal(state.posted[0]!.path,'/assistant/devices');assert.equal(state.posted[0]!.body.action,'connect');
 state.pending!(Promise.reject(Error('Lost response')));await first;await settle();await byId(app,'settings-device-laptop').fire('click');assert.equal(state.posted.length,1);
});

test('a lost device reply unlocks disconnect only after the exact operation has settled',async()=>{
 const {app,state}=fixture();await settle();await open(app,'devices');const first=byId(app,'settings-device-laptop').fire('click');await settle();
 const commandId=state.posted[0]!.body.commandId;state.devices[0]!.status='connected';state.pending!(Promise.reject(Error('Lost connect reply')));await first;await settle();
 assert.equal(byId(app,'settings-device-laptop').disabled,true,'Inspection cannot settle an uncertain command');
 state.receipts.add(commandId);await runInContext('settingsLoad("devices")',app.context);assert.equal(byId(app,'settings-device-laptop').disabled,false);assert.equal(state.posted.length,1);
 const inverse=byId(app,'settings-device-laptop').fire('click');await settle();assert.equal(state.posted[1]!.body.action,'disconnect');assert.notEqual(state.posted[1]!.body.commandId,commandId);state.pending!(reply({status:'committed',revision:4}));await inverse;
});

test('a superseded read-only recheck is settled while a stale key write stays fenced',async()=>{
 const {app,state}=fixture();await settle();await open(app,'devices');
 for(const action of ['recheck','key']){
  const first=runInContext(`settingsLifecyclePost('connection:${action}','/connections/${action}/${action}',{expectedConfigHash:'hash'})`,app.context);await settle();state.pending!(reply({status:'stale'}));await first;
  assert.equal(runInContext(`settingsLifecycleLocked('connection:${action}')`,app.context),action==='key');
 }
});

test('a lost completed key reply reconciles its non-secret identity before enabling controls',async()=>{
 const configHash='a'.repeat(64),posted:any[]=[];let answer!:(value:any)=>void,confirmed=false,stored=false;
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){posted.push(JSON.parse(options.body));return new Promise(resolve=>answer=resolve);}
  if(path.startsWith('/connections/lifecycle?'))return reply({feedId:'feed:a',commandId:posted[0].commandId,status:confirmed?'settled':'unknown'});
  if(path==='/connections')return reply({configHash,connections:[{id:'api',label:'API',providerType:'openai',configHash,credentialConfigured:stored}],modelGroups:[],runtime:{connections:[],defaultRoutes:[]}});
  if(path==='/connections/lifecycle')return reply({feedId:'feed:a',connections:[{connectionId:'api',configHash,canReplaceKey:true,credentialWriteStatus:stored?'stored':'idle',observation:null}]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:1,members:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});return reply({});
 });await settle();await open(app,'connections');await byId(app,'settings-connection-key-api').fire('click');byId(app,'settings-key-value').value='fixture-lost-key';const saving=byId(app,'settings-key-save').fire('click');await settle();stored=true;answer(Promise.reject(Error('Lost key reply')));await saving;await settle();
 assert.equal(byId(app,'settings-connection-key-api').disabled,true,'Slot presence alone cannot reconcile this command');
 const retained=runInContext('JSON.stringify([...settingsConnectionUnknown.values()])',app.context);assert.doesNotMatch(retained,/fixture-lost-key|apiKey/);assert.ok(retained.includes(posted[0].commandId));assert.ok(!JSON.stringify([...app.storage]).includes('fixture-lost-key'));
 confirmed=true;await runInContext('settingsLoad("connections")',app.context);assert.equal(byId(app,'settings-connection-key-api').disabled,false);assert.equal(runInContext("settingsLifecycleLocked('connection:api')",app.context),false);assert.equal(posted.length,1);
});

test('member archive uses the owner command and a stored response refreshes the member list',async()=>{
 const {app,state}=fixture();await settle();await open(app,'members');await byId(app,'settings-member-member-quill').fire('click');
 const archive=byId(app,'settings-member-archive');assert.ok(archive);const first=archive.fire('click');await settle();
 assert.equal(state.posted[0]!.path,'/assistant/members');assert.deepEqual({...state.posted[0]!.body,commandId:'fixed'},{commandId:'fixed',memberId:'member-quill',action:'archive'});
 state.members=[];state.pending!(reply({status:'committed',revision:2}));await first;await settle();assert.ok(!byId(app,'settings-member-member-quill'));
});

for(const action of ['archive','unarchive'] as const)test('lost '+action+' response unlocks the inverse only after its exact receipt is confirmed',async()=>{
 const {app,state}=fixture();if(action==='unarchive'){state.members=[];state.archived=[member];}await settle();await open(app,'members');
 const first=runInContext(`settingsLifecyclePost('member:member-quill','/assistant/members',{memberId:'member-quill',action:'${action}'})`,app.context);await settle();
 const commandId=state.posted[0]!.body.commandId;state.members=action==='archive'?[]:[member];state.archived=action==='archive'?[member]:[];
 state.pending!(Promise.reject(Error('Lost member response')));await first;await settle();
 assert.equal(runInContext("settingsLifecycleLocked('member:member-quill')",app.context),true,'State alone cannot certify the command');
 state.receipts.add(commandId);await runInContext('settingsLoad("members")',app.context);
 assert.equal(runInContext("settingsLifecycleLocked('member:member-quill')",app.context),false);assert.equal(state.posted.length,1);
 const inverse=runInContext(`settingsLifecyclePost('member:member-quill','/assistant/members',{memberId:'member-quill',action:'${action==='archive'?'unarchive':'archive'}'})`,app.context);await settle();assert.equal(state.posted.length,2);assert.notEqual(state.posted[1]!.body.commandId,commandId);state.pending!(reply({status:'committed',revision:3}));await inverse;
});

test('late lifecycle reads cannot replace a newer device read or survive a database feed change',async()=>{
 const {app}=fixture();await settle();await open(app,'devices');
 runInContext('settingsRead=path=>path==="/assistant/devices"?new Promise(resolve=>{(globalThis.deviceReads??=[]).push(resolve);}):Promise.resolve({status:"ready"})',app.context);
 const first=runInContext('settingsLoad("devices")',app.context);await settle();const second=runInContext('settingsLoad("devices")',app.context);await settle();
 const reads=runInContext('deviceReads',app.context);reads[1]({feedId:'feed:a',devices:[{id:'new',name:'새 기기',agent:'Codex',status:'offline',available:true,admitted:true}]});await second;
 reads[0]({feedId:'feed:a',devices:[{id:'old',name:'오래된 기기'}]});await first;assert.ok(byId(app,'settings-device-new'));assert.ok(!byId(app,'settings-device-old'));
 runInContext('connectionEpoch++;renderSettings()',app.context);assert.ok(!byId(app,'settings-device-new'),'previous database controls disappear immediately');
});

test('connection recheck and masked key replacement use exact identities without retaining the secret input',async()=>{
 const posted:{path:string;body:any}[]=[],configHash='a'.repeat(64),app=harness(async(path,options)=>{
  if(options?.method==='POST'){posted.push({path,body:JSON.parse(options.body)});return reply({status:'completed'});}
  if(path==='/connections')return reply({configHash,connections:[{id:'cc',label:'Codex',providerType:'codex-cli',configHash},{id:'api',label:'API',providerType:'openai',configHash,credentialConfigured:false}],modelGroups:[],runtime:{connections:[],defaultRoutes:[]}});
  if(path==='/connections/lifecycle')return reply({feedId:'feed:a',connections:[{connectionId:'cc',configHash,canReplaceKey:false,observation:{status:'expired',restart:'unknown',update:'unknown'}},{connectionId:'api',configHash,canReplaceKey:true,credentialWriteStatus:'idle',observation:null}]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:1,members:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});return reply({});
 });await settle();await open(app,'connections');
 await byId(app,'settings-connection-recheck-cc').fire('click');await settle();assert.equal(posted[0]!.path,'/connections/cc/recheck');assert.equal(posted[0]!.body.expectedConfigHash,configHash);
 await byId(app,'settings-connection-key-api').fire('click');const input=byId(app,'settings-key-value');assert.equal(input.type,'password');input.value='fixture-secret';
 await byId(app,'settings-key-save').fire('click');await settle();assert.equal(posted[1]!.path,'/connections/api/key');assert.equal(posted[1]!.body.apiKey,'fixture-secret');assert.equal(input.value,'');
 assert.ok(!JSON.stringify([...app.storage]).includes('fixture-secret'));
});

test('an explicit pre-write refusal keeps lifecycle controls usable after a fresh read',async()=>{
 const {app,state}=fixture();await settle();await open(app,'devices');
 const start=()=>runInContext("settingsLifecyclePost('connection:api','/connections/api/key',{expectedConfigHash:'hash',apiKey:'fixture-key'})",app.context);
 const first=start();await settle();state.pending!(reply({outcome:'rejected',error:'Active turn'},409));assert.equal(await first,false);
 await runInContext('settingsLoad("devices")',app.context);assert.equal(runInContext("settingsLifecycleLocked('connection:api')",app.context),false);
 const second=start();await settle();assert.equal(state.posted.length,2);state.pending!(reply({status:'completed'}));assert.equal(await second,true);
});

test('a protocol-confirmed unsent lifecycle command does not become an unknown effect',async()=>{
 const {app,state}=fixture();await settle();await open(app,'devices');const start=()=>runInContext("settingsLifecyclePost('connection:api','/connections/api/key',{expectedConfigHash:'hash',apiKey:'fixture-key'})",app.context);
 const first=start();await settle();state.pending!(Promise.reject(Object.assign(Error('Transport was not attempted'),{commandNotSent:true})));assert.equal(await first,false);assert.equal(runInContext("settingsLifecycleLocked('connection:api')",app.context),false);
 const second=start();await settle();assert.equal(state.posted.length,2);state.pending!(reply({status:'completed'}));assert.equal(await second,true);
});
