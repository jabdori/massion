import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchPage} from '../src/workbench.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

// docs/architecture/settings.md, Surface: the Settings layout (B12, B13, B13-devices, B14, B23) opened from the owner's menu.
const T0=Date.UTC(2026,10,4,12,0);
const sem={id:'member-a',name:'셈',look:{shape:'drop',color:'agent-4'},modelGroup:'research'};
const mission={id:'intake',version:9,purpose:'Owner requests',scope:'local',constraints:[],criteria:{version:1,description:'Answer',oracle:'bounded-text-review/v1'},works:[],relations:[],
 memories:[
  {id:'rounding',version:1,scope:'local',authority:'explicit',content:'Round each line',source:'owner',effective:true},
  {id:'rounding',version:2,scope:'local',authority:'learned',content:'Round the total once',source:'growth',effective:false},
  {id:'tone',version:1,scope:'local',authority:'explicit',content:'Plain tone',source:'owner',effective:false},
  {id:'tone',version:2,scope:'local',authority:'learned',content:'Short plain tone',source:'growth',effective:true}],
 growth:[
  {id:'g-1',proposer:'r',target:'memory',baseline:'rounding@1',candidate:'rounding@2',counterevidence:'Per-line tax rules change the total.',evaluator:'e',scores:{baseline:1,candidate:3,heldOut:'3 orders'},status:'evaluated'},
  {id:'g-2',proposer:'r',target:'memory',baseline:'tone@1',candidate:'tone@2',counterevidence:'Long reports may lose detail.',evaluator:'e',scores:{baseline:2,candidate:4,heldOut:'4 replies'},status:'adopted',previousEffective:['rounding@1','tone@1']}]};
const groups=[{id:'default',name:'Default',description:'Makes and checks work unless another group is chosen.',editable:false,models:[{provider:'claude-code-cli',model:'claude-sonnet-5-5',label:'Claude Code',family:'anthropic',status:'available'},{provider:'codex-cli',model:'gpt-6.1-terra',label:'Codex',family:'openai',status:'available'}]},
 {id:'research',name:'Research',description:'Finds sources and summarizes them with evidence',editable:true,models:[{provider:'anthropic',model:'claude-sonnet-5-5',label:'Anthropic',family:'anthropic',status:'available'},{provider:'zai',model:'glm-5.3',label:'Z.ai',family:'zhipu',status:'unavailable'}]},
 {id:'routed',name:'Routed',description:'Same family by two routes',editable:true,models:[{provider:'openrouter',model:'anthropic/claude-sonnet-5-5',label:'OpenRouter',family:'anthropic',status:'available'},{provider:'anthropic',model:'claude-sonnet-5-5',label:'Anthropic',family:'anthropic',status:'available'},{provider:'custom',model:'local-x',label:'Local',family:null,status:'available'}]}];
const connections=[{id:'cc',label:'Claude Code',providerType:'claude-code-cli',connectionStatus:'cli-login-unverified',credentialConfigured:true,models:[],configHash:'h'},{id:'z',label:'Z.ai GLM Coding Plan',providerType:'zai',connectionStatus:'configured-unverified',credentialConfigured:true,models:[],configHash:'h'},{id:'o',label:'OpenAI API',providerType:'openai',connectionStatus:'credential-required',credentialConfigured:false,models:[],configHash:'h'}];
function fixture(){
 const state={allow:[] as any[],posted:[] as {path:string;body:any}[]};
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){const body=JSON.parse(options.body);state.posted.push({path,body});
   if(path==='/assistant/permissions'&&body.action==='allow')state.allow.push({id:'rule-1',what:body.what,kind:body.kind,label:'Send as me',at:T0});
   if(path==='/assistant/permissions'&&body.action==='remove')state.allow=state.allow.filter(r=>r.id!==body.ruleId);
   return reply({status:'committed',revision:2});}
  if(path==='/connections')return reply({host:null,providerTypes:[],connections,runtime:{connections:[],defaultRoutes:[]},configHash:'h',grants:[],representative:{intakeMissionId:'intake'},modelGroups:groups,fixtureModeEnabled:false,liveExecutionEnabled:false});
  if(path==='/missions/intake')return reply({id:'intake',revision:9,value:mission});
  if(path==='/assistant/permissions')return reply({feedId:'feed:a',revision:1,ask:[['spend','Spend money'],['send','Send as me'],['delete','Delete'],['delegate','Hand to a new member'],['check-rules','Change check rules']].map(([kind,label])=>({kind,label})),allow:state.allow});
  if(path==='/assistant/schedules')return reply({feedId:'feed:a',revision:1,schedules:[{id:'s',title:'Morning briefing',active:true,nextAt:T0,minute:480,offset:540,budget:{runs:30,used:1},runs:[]}]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:1,members:[sem],decisions:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});
  return reply({error:'Not configured'},503);
 });
 return {app,state};
}
const byId=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id);
const button=(node:Node,label:string)=>{const found:Node[]=[];const visit=(n:Node)=>{if(n.tagName==='BUTTON'&&n.textContent===label)found.push(n);n.children.forEach(visit);};visit(node);return found[0];};
const open=async(app:ReturnType<typeof harness>,section:string)=>{await app.node('me-settings').fire('click');await settle();await app.node('settings-nav-'+section).fire('click');await settle();};

test('Settings opens at General with its own sidebar of sections, and the conversation sidebar comes back with the conversation',async()=>{
 const {app}=fixture();await settle();
 await app.node('me-settings').fire('click');await settle();
 assert.equal(app.node('page-settings').hidden,false);assert.equal(app.node('page-heading').textContent,'Settings');
 assert.equal(app.node('side-settings').hidden,false);assert.equal(app.node('side-people').hidden,true);assert.equal(app.node('activity-toggle').hidden,true);
 assert.deepEqual(['general','memory','members','devices','connections','apps','improvements','permissions','advanced'].map(s=>new RegExp('id="settings-nav-'+s+'"[^>]*>(?:<svg[\\s\\S]*?</svg>)?<span>([^<]*)</span>').exec(workbenchPage)?.[1]),['General','Memory','Members','Devices','Connections','Apps','Improvements','Permissions','Advanced']);
 assert.equal(app.node('settings-nav-general').attributes.get('aria-current'),'page');assert.equal(app.node('settings-general').hidden,false);assert.equal(app.node('settings-advanced').hidden,true);
 assert.match(app.node('settings-general-body').textContent,/Name.*하나.*Morning briefing.*Daily 08:00/);
 await app.node('settings-nav-advanced').fire('click');assert.equal(app.node('settings-advanced').hidden,false,'the earlier forms keep a home');assert.equal(app.node('settings-general').hidden,true);
 await app.node('rail-chat').fire('click');await settle();assert.equal(app.node('side-settings').hidden,true);assert.equal(app.node('side-people').hidden,false);
});

test('Memory shows what you said, what was learned with its evidence, and the change history; Stop retires and Revert reverts with exact versions',async()=>{
 const {app,state}=fixture();await settle();await open(app,'memory');
 const body=app.node('settings-memory-body');
 assert.match(body.textContent,/You said.*Round each line.*version 1 · In use.*Plain tone.*version 1 · Not in use/);
 assert.match(body.textContent,/Learned.*Round the total once.*version 2 · Pending.*Evidence/);
 assert.match(body.textContent,/Change history.*Short plain tone.*Changed.*Revert/);
 const evidence=byId(app,'memory-evidence-g-1')!;assert.ok(evidence);assert.match(evidence.textContent,/1 → 3.*3 orders.*Per-line tax rules change the total\./);
 const stop=byId(app,'memory-switch-rounding')!;assert.equal(stop.attributes.get('aria-checked'),'true');assert.equal(byId(app,'memory-switch-tone')!.disabled,true);
 await stop.fire('click');await settle();
 assert.deepEqual(state.posted.at(-1),{path:'/missions/intake/memory-retirement',body:{commandId:state.posted.at(-1)!.body.commandId,expectedRevision:9,memoryId:'rounding',version:1,reason:'Stopped in Settings'}});
 await button(body,'Revert')!.fire('click');await settle();
 const revert=state.posted.at(-1)!;assert.equal(revert.path,'/missions/intake/growth');assert.deepEqual({...revert.body,commandId:''},{commandId:'',expectedRevision:9,growthId:'g-2',baseline:'tone@1',candidate:'tone@2',action:'revert'});
 assert.ok(!state.posted.some(p=>/adopt/.test(JSON.stringify(p.body))),'Settings adopts nothing');
});

test('Members lists the Representative and each member with its model group; a row opens the member page and Message opens that conversation',async()=>{
 const {app}=fixture();await settle();await open(app,'members');
 const body=app.node('settings-members-body');assert.match(body.textContent,/하나.*★.*Default.*셈.*Research/);
 await byId(app,'settings-member-member-a')!.fire('click');await settle();await button(app.node('settings-members-body'),'Message')!.fire('click');await settle();
 assert.equal(app.node('page-chat').hidden,false);assert.ok(app.calls.some(c=>c.path==='/assistant/conversation?member=member-a'));
 await open(app,'devices');assert.match(app.node('settings-devices-body').textContent,/This Mac.*Ready/);
 await open(app,'apps');assert.match(app.node('settings-apps-body').textContent,/No apps installed/);
});

test('Connections lists model groups with who uses them, models and providers, then logins and API keys',async()=>{
 const {app}=fixture();await settle();await open(app,'connections');
 const groupsText=app.node('settings-groups').textContent;
 assert.match(groupsText,/Model groups.*Default.*하나.*claude-sonnet-5-5.*gpt-6\.1-terra.*2 providers.*Research.*셈.*Finds sources and summarizes them with evidence.*glm-5\.3.*2 providers/);
 assert.doesNotMatch(groupsText,/Makes and checks work/,'the Default group carries no host sentence');
 assert.match(groupsText,/Routed.*anthropic\/claude-sonnet-5-5Anthropic.*claude-sonnet-5-5Anthropic.*local-xUnknown.*2 providers/,'chips and count follow the model family, not the route');assert.doesNotMatch(groupsText,/OpenRouter|Custom/);
 assert.match(groupsText,/Subscription logins.*Claude Code.*API keys.*Z\.ai GLM Coding Plan.*Connected.*OpenAI API.*None/);
});

test('Permissions: five kinds always asked; Add rule allows a first-kind action, Remove asks again; the second kind is not offered',async()=>{
 const {app,state}=fixture();await settle();await open(app,'permissions');
 const body=app.node('settings-permissions-body');
 assert.match(body.textContent,/Always ask.*Spend money.*Send as me.*Delete.*Hand to a new member.*Change check rules.*Allow without asking.*None/);
 await button(body,'Add rule')!.fire('click');await settle();
 const kind=byId(app,'permission-kind')!;assert.deepEqual(kind.children.map(o=>o.value),['spend','send','delete','delegate'],'check rules cannot be allowed');
 await button(body,'Cancel')!.fire('click');await settle();assert.equal(byId(app,'permission-what'),undefined);assert.equal(state.posted.length,0,'Cancel sends nothing');
 await button(body,'Add rule')!.fire('click');await settle();
 byId(app,'permission-what')!.value='Post the weekly summary to #weekly';byId(app,'permission-kind')!.value='send';
 await byId(app,'permission-form')!.fire('submit');await settle();
 const add=state.posted.at(-1)!;assert.equal(add.path,'/assistant/permissions');assert.deepEqual({...add.body,commandId:''},{commandId:'',action:'allow',what:'Post the weekly summary to #weekly',kind:'send'});
 assert.match(app.node('settings-permissions-body').textContent,/Post the weekly summary to #weekly.*Send as me · .*Remove/);
 await button(app.node('settings-permissions-body'),'Remove')!.fire('click');await settle();
 assert.deepEqual({...state.posted.at(-1)!.body,commandId:''},{commandId:'',action:'remove',ruleId:'rule-1'});assert.match(app.node('settings-permissions-body').textContent,/Allow without asking.*None/);
});
