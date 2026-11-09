import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';

const member={id:'member-quill',name:'퀼',look:{shape:'square',color:'agent-1'},modelGroup:'default',archivedAt:null,workCount:2,scheduleCount:0,lastActiveAt:1000};
function fixture(){
 const state={posted:[] as {path:string;body:any}[],pending:null as ((value:any)=>void)|null,members:[member],devices:[{id:'laptop',name:'내 노트북',agent:'Codex',status:'offline',available:true,admitted:true,decisionId:'remote'}]};
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){state.posted.push({path,body:JSON.parse(options.body)});return new Promise(resolve=>{state.pending=resolve;});}
  if(path==='/assistant/members')return reply({feedId:'feed:a',revision:1,members:state.members,archived:[]});
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

test('member archive uses the owner command and a stored response refreshes the member list',async()=>{
 const {app,state}=fixture();await settle();await open(app,'members');await byId(app,'settings-member-member-quill').fire('click');
 const archive=byId(app,'settings-member-archive');assert.ok(archive);const first=archive.fire('click');await settle();
 assert.equal(state.posted[0]!.path,'/assistant/members');assert.deepEqual({...state.posted[0]!.body,commandId:'fixed'},{commandId:'fixed',memberId:'member-quill',action:'archive'});
 state.members=[];state.pending!(reply({status:'committed',revision:2}));await first;await settle();assert.ok(!byId(app,'settings-member-member-quill'));
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
