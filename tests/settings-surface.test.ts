import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {copy} from '../src/ui-copy.ts';
import {workbenchPage} from '../src/workbench.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

const sequence=(...parts:string[])=>new RegExp(parts.map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*'));

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

test('Settings search filters sections locally and preserves the current selection',async()=>{
 const {app,state}=fixture();await settle();await open(app,'members');
 const search=app.node('settings-search');assert.ok(search);assert.equal(app.node('settings-nav-advanced').hidden,true);search.value=copy('conversation.button.12');await search.fire('input');
 assert.equal(app.node('settings-nav-connections').hidden,false);assert.equal(app.node('settings-nav-members').hidden,true);
 assert.equal(app.node('settings-members').hidden,false);assert.equal(state.posted.length,0);
 search.value=copy('ui.panel.advanced');await search.fire('input');assert.equal(app.node('settings-nav-advanced').hidden,false);
 await app.node('settings-nav-advanced').fire('click');assert.equal(app.node('settings-advanced').hidden,false);
 search.value='';await search.fire('input');assert.equal(app.node('settings-nav-members').hidden,false);assert.equal(app.node('settings-nav-advanced').hidden,true);
});

function groupFixture(){
 const state={posted:[] as any[],pending:null as ((value:any)=>void)|null};
 const models=[{profileId:'profile-a',configHash:'pin-a',model:'model-a',provider:'openai',family:'openai',label:'A',status:'available'},{profileId:'profile-b',configHash:'pin-b',model:'model-b',provider:'anthropic',family:'anthropic',label:'B',status:'available'}];
 const group={id:'research',name:'Research',description:'Sources',editable:true,models};
 const catalog={modelGroups:[group],configHash:'hash-a',connections:[],runtime:{connections:models.map(m=>({id:m.profileId,model:m.model,label:m.label,providerKind:m.provider,revision:m.configHash,diagnostics:[]})),defaultRoutes:[],authorizations:[]},providerTypes:[]};
 const app=harness(async(path,options)=>{
  if(path==='/model-groups'){const body=JSON.parse(options.body);state.posted.push(body);return new Promise(resolve=>{state.pending=resolve;});}
  if(path==='/connections')return reply(catalog);
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:1,members:[sem],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});
  return reply({});
 });return {app,state,catalog,group};
}

test('Group edits send the existing exact CAS payload once when changes overlap',async()=>{
 const {app,state,catalog}=groupFixture();await settle();await open(app,'connections');
 const row=byId(app,'settings-group-research');assert.ok(row);await row.fire('click');
 const name=byId(app,'settings-group-name')!;assert.ok(name);name.value='Evidence';
 const first=name.fire('change');await settle();assert.equal(state.posted.length,1);
 await name.fire('change');assert.equal(state.posted.length,1);
 assert.deepEqual(state.posted[0],{id:'research',name:'Evidence',description:'Sources',profileIds:['profile-a','profile-b'],expectedConfigHash:'hash-a'});
 state.pending!(reply({...catalog,configHash:'hash-b',modelGroups:[{...catalog.modelGroups[0],name:'Evidence'}]}));await first;await settle();
 assert.ok(!app.calls.some(c=>c.path==='/assistant/decisions'),'group changes never change checking routes');
});

test('A group save settling unlocks the group opened while that save was pending',async()=>{
 const {app,state,catalog,group}=groupFixture(),other={...group,id:'coding',name:'Coding'};catalog.modelGroups.push(other);
 await settle();await open(app,'connections');await byId(app,'settings-group-research')!.fire('click');
 const name=byId(app,'settings-group-name')!;name.value='Evidence';const save=name.fire('change');await settle();
 await button(app.node('settings-groups'),'‹ '+copy('conversation.button.12'))!.fire('click');await byId(app,'settings-group-coding')!.fire('click');
 assert.equal(byId(app,'settings-group-name')!.disabled,true);
 state.pending!(reply({...catalog,configHash:'hash-b',modelGroups:[{...group,name:'Evidence'},other]}));await save;await settle();
 assert.equal(byId(app,'settings-group-name')!.value,'Coding');assert.equal(byId(app,'settings-group-name')!.disabled,false);
 assert.equal(runInContext('settingsGroup',app.context),'coding');assert.equal(state.posted.length,1);
});

test('Adding model sixteen disables remaining choices and the shared save path refuses model seventeen',async()=>{
 const {app,state,catalog,group}=groupFixture(),template=group.models[0]!;
 group.models=Array.from({length:15},(_,i)=>({...template,profileId:'profile-'+i,model:'model-'+i}));
 const sixteenth={...template,profileId:'profile-15',model:'model-15'},seventeenth={...template,profileId:'profile-16',model:'model-16'};
 catalog.runtime.connections=[...group.models,sixteenth,seventeenth].map(m=>({id:m.profileId,model:m.model,label:m.label,providerKind:m.provider,revision:m.configHash,diagnostics:[]}));
 await settle();await open(app,'connections');await byId(app,'settings-group-research')!.fire('click');await byId(app,'settings-group-add')!.fire('click');
 await button(app.node('settings-groups'),sixteenth.model)!.fire('click');await settle();assert.equal(state.posted.length,1);assert.equal(state.posted[0].profileIds.length,16);
 state.pending!(reply({...catalog,configHash:'hash-b',modelGroups:[{...group,models:[...group.models,sixteenth]}]}));await settle();
 const choice=button(app.node('settings-groups'),seventeenth.model)!;assert.ok(choice);assert.equal(choice.disabled,true);
 await choice.fire('click');await settle();assert.equal(state.posted.length,1,'queued or synthetic clicks cannot submit model seventeen');
});

test('A lost group-save response remains unknown and cannot be resent by another edit',async()=>{
 const {app,state}=groupFixture();await settle();await open(app,'connections');await byId(app,'settings-group-research')!.fire('click');
 const name=byId(app,'settings-group-name')!;name.value='Evidence';const first=name.fire('change');await settle();
 state.pending!(Promise.reject(new Error('Response lost')));await first;await settle();
 await name.fire('change');assert.equal(state.posted.length,1);
 assert.equal(runInContext('settingsGroupUnknown',app.context),true);
});

test('Only an explicit pre-admission refusal classifies a failed group response as rejected',async()=>{
 for(const [status,outcome,unknown] of [[500,undefined,true],[503,'unknown',true],[400,undefined,true],[503,'rejected',false]] as const){
  const {app,state}=groupFixture();await settle();await open(app,'connections');await byId(app,'settings-group-research')!.fire('click');
  const name=byId(app,'settings-group-name')!;name.value='Evidence';const save=name.fire('change');await settle();
  state.pending!(reply({error:'Request did not settle',...(outcome?{outcome}:{})},status));await save;await settle();
  assert.equal(runInContext('settingsGroupUnknown',app.context),unknown,String(status)+' '+outcome);
  if(unknown){await name.fire('change');assert.equal(state.posted.length,1);}
 }
});

test('A catalog read started before a group commit cannot restore the previous configuration',async()=>{
 const {app,state,catalog}=groupFixture();await settle();await open(app,'connections');await byId(app,'settings-group-research')!.fire('click');
 runInContext('settingsRead=()=>new Promise(resolve=>{globalThis.catalogResolve=resolve;})',app.context);
 const read=runInContext('settingsLoad("connections")',app.context);await settle();
 const name=byId(app,'settings-group-name')!;name.value='Evidence';const save=name.fire('change');await settle();
 state.pending!(reply({...catalog,configHash:'hash-b',modelGroups:[{...catalog.modelGroups[0],name:'Evidence'}]}));await save;await settle();
 runInContext('catalogResolve',app.context)(catalog);await read;await settle();
 assert.equal(runInContext('settingsCatalog.configHash',app.context),'hash-b');
 assert.equal(byId(app,'settings-group-name')!.value,'Evidence');
});

test('A replaced feed or a newer section read discards earlier Settings data',async()=>{
 const {app}=fixture();await settle();await open(app,'connections');
 let resolveOld!:(value:any)=>void,resolveNew!:(value:any)=>void;
 runInContext('settingsRead=path=>new Promise(resolve=>{globalThis[globalThis.oldRead?"newResolve":"oldResolve"]=resolve;globalThis.oldRead=true;})',app.context);
 const older=runInContext('settingsLoad("connections")',app.context);await settle();const newer=runInContext('settingsLoad("connections")',app.context);await settle();
 resolveOld=runInContext('oldResolve',app.context);resolveNew=runInContext('newResolve',app.context);
 resolveNew({modelGroups:[],connections:[],configHash:'new'});await newer;
 resolveOld({modelGroups:[],connections:[],configHash:'old'});await older;
 assert.equal(runInContext('settingsCatalog.configHash',app.context),'new');
 const stale=runInContext('settingsLoad("connections")',app.context);await settle();
 runInContext('connectionEpoch++',app.context);runInContext('newResolve({modelGroups:[],connections:[],configHash:"replaced"})',app.context);await stale;
 assert.equal(runInContext('settingsCatalog.configHash',app.context),'new');
});

test('Settings opens at General with its own sidebar of sections, and the conversation sidebar comes back with the conversation',async()=>{
 const {app}=fixture();await settle();
 await app.node('me-settings').fire('click');await settle();
 assert.equal(app.node('page-settings').hidden,false);assert.equal(app.node('page-heading').textContent,copy('sidebar.link.11'));
 assert.equal(app.node('side-settings').hidden,false);assert.equal(app.node('side-people').hidden,true);assert.equal(app.node('activity-toggle').hidden,true);
 assert.deepEqual(['general','memory','members','devices','connections','usage','apps','improvements','permissions'].map(s=>new RegExp('id="settings-nav-'+s+'"[^>]*>(?:<svg[\\s\\S]*?</svg>)?<span>([^<]*)</span>').exec(workbenchPage)?.[1]),['sidebar.heading.04','page.heading.03','page.heading.02','sidebar.heading.02','conversation.button.12','sidebar.heading.03','ui.apps','sidebar.link.07','sidebar.heading.01'].map(key=>copy(key)));
 assert.equal(app.node('settings-nav-general').attributes.get('aria-current'),'page');assert.equal(app.node('settings-general').hidden,false);assert.equal(app.node('settings-advanced').hidden,true);
 assert.equal(byId(app,'settings-name')!.value,'하나');assert.equal((byId(app,'settings-name') as any).readOnly,true);assert.match(app.node('settings-general-body').textContent,sequence(copy('page.columnheader.02'),copy('settings.combobox.01'),copy('settings.combobox.02'),copy('settings.heading.04')));
 await app.node('settings-nav-advanced').fire('click');assert.equal(app.node('settings-advanced').hidden,false,'the earlier forms keep a home');assert.equal(app.node('settings-general').hidden,true);
 await app.node('rail-chat').fire('click');await settle();assert.equal(app.node('side-settings').hidden,true);assert.equal(app.node('side-people').hidden,false);
});

test('Memory shows what you said, what was learned with its evidence, and the change history; Stop retires and Revert reverts with exact versions',async()=>{
 const {app,state}=fixture();await settle();await open(app,'memory');
 const body=app.node('settings-memory-body');
 assert.match(body.textContent,sequence(copy('page.heading.04'),'Round each line',copy('ui.panel.memory-version',{version:1}),copy('ui.panel.in-use'),'Plain tone',copy('ui.panel.memory-version',{version:1}),copy('ui.panel.not-in-use')));
 assert.match(body.textContent,sequence(copy('page.heading.06'),'Round the total once',copy('ui.panel.memory-version',{version:2}),copy('ui.waiting'),copy('page.button.08')));
 assert.match(body.textContent,sequence(copy('page.heading.07'),'Short plain tone',copy('settings.button.08'),copy('page.button.09')));
 const evidence=byId(app,'memory-evidence-g-1')!;assert.ok(evidence);assert.match(evidence.textContent,/1 → 3.*3 orders.*Per-line tax rules change the total\./);
 const stop=byId(app,'memory-switch-rounding')!;assert.equal(stop.attributes.get('aria-checked'),'true');assert.equal(byId(app,'memory-switch-tone')!.disabled,true);
 await stop.fire('click');await settle();
 assert.deepEqual(state.posted.at(-1),{path:'/missions/intake/memory-retirement',body:{commandId:state.posted.at(-1)!.body.commandId,expectedRevision:9,memoryId:'rounding',version:1,reason:'Stopped in Settings'}});
 await button(body,copy('page.button.09'))!.fire('click');await settle();
 const revert=state.posted.at(-1)!;assert.equal(revert.path,'/missions/intake/growth');assert.deepEqual({...revert.body,commandId:''},{commandId:'',expectedRevision:9,growthId:'g-2',baseline:'tone@1',candidate:'tone@2',action:'revert'});
 assert.ok(!state.posted.some(p=>/adopt/.test(JSON.stringify(p.body))),'Settings adopts nothing');
});

test('Memory search filters loaded instructions and changes without writing or changing their identities',async()=>{
 const {app,state}=fixture();await settle();await open(app,'memory');
 const query=byId(app,'memory-query')!;query.value='Round';await query.fire('input');
 const body=app.node('settings-memory-body');assert.match(body.textContent,/Round each line/);assert.doesNotMatch(body.textContent,/Plain tone|Short plain tone/);
 assert.ok(byId(app,'memory-switch-rounding'));assert.equal(byId(app,'memory-switch-tone'),undefined);assert.deepEqual(state.posted,[]);
});

test('Members lists the Representative and each member with its model group; a row opens the member page and Message opens that conversation',async()=>{
 const {app}=fixture();await settle();await open(app,'members');
 const body=app.node('settings-members-body');assert.doesNotMatch(body.textContent,/★/);assert.match(body.textContent,sequence('하나',copy('settings.text.01'),'셈','Research'));
 await byId(app,'settings-member-member-a')!.fire('click');await settle();await button(app.node('settings-members-body'),copy('settings.link.02'))!.fire('click');await settle();
 assert.equal(app.node('page-chat').hidden,false);assert.ok(app.calls.some(c=>c.path==='/assistant/conversation?member=member-a'));
 await open(app,'devices');assert.match(app.node('settings-devices-body').textContent,sequence(copy('ui.panel.this-mac'),copy('ui.panel.ready')));
 await open(app,'apps');assert.match(app.node('settings-apps-body').textContent,sequence(copy('ui.settings.installed-count',{count:0}),copy('settings.text.03')));
});

test('Settings member identities preserve the admitted shape and recorded running status',async()=>{
 const {app}=fixture();await settle();await open(app,'members');
 assert.equal(byId(app,'settings-member-member-a')!.children[0]!.attributes.get('data-shape'),'drop');
 runInContext('shellWorks=[{memberId:"member-a",started:true,execution:"active",acceptance:"pending",unknown:false}];renderSettings()',app.context);
 assert.equal(byId(app,'settings-member-member-a')!.children[0]!.attributes.get('aria-label'),copy('sidebar.status.05'));
 runInContext('shellWorks=[];renderSettings()',app.context);
 assert.equal(byId(app,'settings-member-member-a')!.children[0]!.attributes.get('aria-hidden'),'true');
});

test('Connections lists model groups with who uses them, models and providers, then logins and API keys',async()=>{
 const {app}=fixture();await settle();await open(app,'connections');
 const groupsText=app.node('settings-groups').textContent;
 assert.match(groupsText,sequence(copy('settings.heading.03'),copy('settings.text.01'),'하나','claude-sonnet-5-5','gpt-6.1-terra','Research','셈','Finds sources and summarizes them with evidence','glm-5.3',copy('ui.panel.provider-count',{count:2})));
 assert.doesNotMatch(groupsText,/Makes and checks work/,'the Default group carries no host sentence');
 assert.match(groupsText,sequence('Routed','anthropic/claude-sonnet-5-5 Anthropic','claude-sonnet-5-5 Anthropic','local-x '+copy('ui.panel.unknown'),copy('ui.panel.provider-count',{count:2})),'chips and count follow the model family, not the route');assert.doesNotMatch(groupsText,/OpenRouter|Custom/);
 assert.match(groupsText,sequence(copy('settings.heading.02'),'Claude Code',copy('settings.heading.01'),'Z.ai GLM Coding Plan',copy('ui.panel.not-checked'),'OpenAI API',copy('settings.text.03')));
});

test('Permissions: five kinds always asked; Add rule allows a first-kind action, Remove asks again; the second kind is not offered',async()=>{
 const {app,state}=fixture();await settle();await open(app,'permissions');
 const body=app.node('settings-permissions-body');
 assert.match(body.textContent,sequence(...['ui.panel.always-ask','ui.panel.spend-money','ui.panel.send-as-me','ui.panel.delete','ui.panel.hand-to-member','ui.panel.change-check-rules','ui.panel.allow-without-asking','settings.text.03'].map(key=>copy(key))));
 await button(body,copy('ui.panel.add-rule'))!.fire('click');await settle();
 const kind=byId(app,'permission-kind')!;assert.deepEqual(kind.children.map(o=>o.value),['spend','send','delete','delegate'],'check rules cannot be allowed');
 await button(body,copy('conversation.link.25'))!.fire('click');await settle();assert.equal(byId(app,'permission-what'),undefined);assert.equal(state.posted.length,0,'Cancel sends nothing');
 await button(body,copy('ui.panel.add-rule'))!.fire('click');await settle();
 byId(app,'permission-what')!.value='Post the weekly summary to #weekly';byId(app,'permission-kind')!.value='send';
 await byId(app,'permission-form')!.fire('submit');await settle();
 const add=state.posted.at(-1)!;assert.equal(add.path,'/assistant/permissions');assert.deepEqual({...add.body,commandId:''},{commandId:'',action:'allow',what:'Post the weekly summary to #weekly',kind:'send'});
 assert.match(app.node('settings-permissions-body').textContent,sequence('Post the weekly summary to #weekly',copy('ui.panel.send-as-me')+' · ',copy('conversation.link.24')));
 await button(app.node('settings-permissions-body'),copy('conversation.link.24'))!.fire('click');await settle();
 assert.deepEqual({...state.posted.at(-1)!.body,commandId:''},{commandId:'',action:'remove',ruleId:'rule-1'});assert.match(app.node('settings-permissions-body').textContent,sequence(copy('ui.panel.allow-without-asking'),copy('settings.text.03')));
});

test('review 4: Connections has no unapproved discriminator picker or generated description',async()=>{
 const {app,state}=fixture();await settle();await open(app,'connections');assert.equal(byId(app,'settings-discriminator-model'),undefined);assert.doesNotMatch(app.node('settings-groups').textContent,/Discriminator|Moderates between turns/);assert.doesNotMatch(workbenchPage,/Moderates between turns/);assert.equal(state.posted.length,0);
});

test('review 7: unusable discriminator profiles have no selectable control or save path',async()=>{
 const profiles=[{id:'small',limits:{maxOutputTokens:2048},endpoint:'http://127.0.0.1:9999/v1/chat/completions'},{id:'path',limits:{maxOutputTokens:4096},endpoint:'http://127.0.0.1:9999/api/chat/completions'},{id:'live-disabled',limits:{maxOutputTokens:4096},endpoint:'https://example.test/v1/chat/completions'}].map(p=>({...p,providerKind:'compatible',label:p.id,model:p.id,diagnostics:[]}));
 const app=harness(async(path)=>path==='/connections'?reply({configHash:'h',modelGroups:[],connections:[],runtime:{connections:profiles,defaultRoutes:[]},providerTypes:[],grants:[],liveExecutionEnabled:false}):reply({}));await settle();await open(app,'connections');assert.equal(byId(app,'settings-discriminator-model'),undefined);assert.ok(!app.all().some(n=>n.tagName==='OPTION'&&profiles.some(p=>p.id===n.value)));assert.ok(!app.calls.some(c=>c.options?.method==='POST'));
});

test('General unknown selects retain a selected visible dash without claiming a schedule or version',async()=>{
 const {app}=fixture();await settle();await open(app,'general');
 const fields=app.all().filter(n=>n.tagName==='SELECT'&&n.disabled&&n.attributes.has('aria-label'));
 assert.equal(fields.length,2);
 for(const field of fields){assert.equal(field.children[0]!.textContent,copy('ui.settings.unknown-value'));assert.equal((field.children[0] as any).selected,true);}
 });

test('Group detail keeps numbered models and avatar-name-chevron member order with truthful running status',async()=>{
 const {app,state}=groupFixture();await settle();await open(app,'connections');await byId(app,'settings-group-research')!.fire('click');
 const body=app.node('settings-groups'),back=button(body,'‹ '+copy('conversation.button.12'));assert.ok(back);
 const models=app.all().filter(n=>n.className==='set-model-index');assert.deepEqual(models.map(n=>n.textContent),['1','2']);
 const member=app.all().find(n=>n.className==='set-row set-group-member')!;assert.ok(member);
 assert.deepEqual(member.children.map(n=>n.className),['avatar','set-text','set-side']);assert.equal(member.children[1]!.textContent,'셈');
 assert.equal(member.children[0]!.attributes.get('aria-hidden'),'true');assert.equal(member.children[2]!.attributes.get('aria-hidden'),'true');
 runInContext('shellWorks=[{memberId:"member-a",started:true,execution:"active",acceptance:"pending",unknown:false}];renderSettings()',app.context);
 const active=app.all().find(n=>n.className==='set-row set-group-member')!;assert.equal(active.children[0]!.attributes.get('aria-hidden'),'true');const status=active.children[1]!.children.at(-1)!;assert.equal(status.attributes.get('role'),'status');assert.equal(status.textContent,copy('sidebar.status.05'));
 assert.equal(state.posted.length,0);await back.fire('click');assert.equal(byId(app,'settings-group-name'),undefined);
 });

test('Default model selectors show chevrons and subscription provenance only for recorded CLI routes',async()=>{
 const {app}=fixture();await settle();await open(app,'connections');
 runInContext(`settingsCatalog=structuredClone(settingsCatalog);settingsCatalog.modelGroups[0].models[0].profileId='cli-profile';settingsCatalog.modelGroups[0].models[1].profileId='api-profile';settingsCatalog.runtime.connections=[{id:'cli-profile',providerKind:'claude-code-cli'},{id:'api-profile',providerKind:'openai'}];renderSettings()`,app.context);
 const rows=app.all().filter(n=>n.className==='set-row set-default-model');assert.equal(rows.length,2);
 assert.equal(rows[0]!.children[0]!.children[1]!.textContent,'구독 · claude-sonnet-5-5');
 assert.equal(rows[1]!.children[0]!.children[1]!.textContent,'gpt-6.1-terra');
 for(const row of rows){const selector=row.children[1]!;assert.equal(selector.disabled,true);assert.equal(selector.children.at(-1)!.textContent,'⌄');assert.equal(selector.children.at(-1)!.attributes.get('aria-hidden'),'true');}
 assert.doesNotMatch(app.node('settings-groups').textContent,/로그인됨/);
 });
