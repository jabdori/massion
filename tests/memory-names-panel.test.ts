import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import {apply,createMission} from '../src/domain.ts';
import {memoryWorkSource} from '../src/memory-candidates.ts';
import {copy} from '../src/ui-copy.ts';

function fixture(){
 const owner={id:'local-owner',roles:['owner'] as const};let mission=createMission({id:'intake',purpose:'P',scope:'local',constraints:[],criteria:{version:1,description:'D',oracle:'manual-review/v1'}},owner);mission=apply(mission,{type:'admit-work',workId:'source',title:'Exact source title',budget:0},owner).value;
 const source=memoryWorkSource(mission,mission.works[0]!);mission=apply(mission,{type:'save-memory',memory:{id:'rounding',version:1,name:'Rounding rule',content:'Instruction remains visible',source:'Unstructured provenance',sourceWork:source,scope:'local',authority:'explicit',effective:true}},owner).value;
 const app=harness(async path=>{if(path==='/connections')return reply({representative:{intakeMissionId:'intake'},modelGroups:[],runtime:{connections:[]}});if(path==='/missions/intake')return reply({id:'intake',revision:3,value:mission});if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:0,members:[],decisions:[],segment:null,turns:[]});if(path==='/assistant/works')return reply({feedId:'feed:a',works:[]});if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});return reply({},503);});
 const hashes:Promise<unknown>[]=[],originalHash=runInContext('sequenceHash',app.context);(app.context as any).sequenceHash=(value:unknown)=>{const task=originalHash(value);hashes.push(task);return task;};
 const sourceSettled=async()=>{await settle();await Promise.all(hashes);await settle();};
 const open=async()=>{await settle();await app.node('me-settings').fire('click');await app.node('settings-nav-memory').fire('click');await settle();};return {app,mission,source,open,sourceSettled};
}

test('B12 names are independent of instructions; source links retain exact Work identity',async()=>{
 const f=fixture();await f.open();const nodes=f.app.all(),toggle=nodes.find(n=>n.id==='memory-switch-rounding')!;assert.equal(toggle.attributes.get('aria-label'),copy('ui.panel.use-memory',{content:'Rounding rule'}));
 const source=nodes.find(n=>n.tagName==='BUTTON'&&n.textContent===f.source.title)!;assert.ok(source);assert.equal(source.attributes.get('role'),'link');assert.equal(source.className,'set-memory-source');assert.match(f.app.node('settings-memory-body').textContent,/Rounding rule/);assert.match(f.app.node('settings-memory-body').textContent,/Instruction remains visible/);
 runInContext("globalThis.opened=[];paneOpen=(...args)=>opened.push(args);loadMission=async()=>{snapshot=structuredClone(settingsMission);return true;}",f.app.context);await source.fire('click');await f.sourceSettled();assert.deepEqual(JSON.parse(runInContext('JSON.stringify(opened)',f.app.context)),[['intake','source','Exact source title']]);
});

test('cached B12 links cannot open across feed replacement, section switch or changed source bytes',async()=>{
 for(const change of ["chatView.feedId='feed:b'","settingsShown='general'","settingsMission=structuredClone(settingsMission)","settingsMission.value.works[0].instructions=[{actorId:'local-owner',text:'Changed'}]"]){const f=fixture();await f.open();const link=f.app.all().find(n=>n.tagName==='BUTTON'&&n.textContent===f.source.title)!;assert.ok(link);runInContext("globalThis.opened=[];paneOpen=(...args)=>opened.push(args);loadMission=async()=>{snapshot=structuredClone(settingsMission);return true;};"+change,f.app.context);await link.fire('click');await f.sourceSettled();assert.equal(runInContext('opened.length',f.app.context),0,change);}
});

test('a slower source read cannot open after a newer source request has completed',async()=>{
 const f=fixture();await f.open();const link=f.app.all().find(n=>n.tagName==='BUTTON'&&n.textContent===f.source.title)!;
 runInContext("globalThis.opened=[];globalThis.releases=[];paneOpen=(...args)=>opened.push(args);loadMission=()=>new Promise(resolve=>releases.push(()=>{snapshot=structuredClone(settingsMission);resolve(true);}));",f.app.context);
 const first=link.fire('click');await settle();const second=link.fire('click');await settle();runInContext('releases[1]()',f.app.context);await second;runInContext('releases[0]()',f.app.context);await first;await f.sourceSettled();assert.equal(runInContext('opened.length',f.app.context),1);
});

test('B12 translates only the two exact calculation policies while stored and arbitrary owner text stay exact',async()=>{
 const f=fixture();await f.open();runInContext("settingsMission.value.memories=[{id:'line',version:1,authority:'explicit',effective:true,name:'Line policy',content:'Round each line'},{id:'aggregate',version:1,authority:'explicit',effective:true,name:'Aggregate policy',content:'Round aggregate once'},{id:'owner',version:1,authority:'explicit',effective:true,content:'Round each line with my custom rule'}];renderSettings();",f.app.context);
 const text=f.app.node('settings-memory-body').textContent;assert.match(text,/줄마다 반올림/);assert.match(text,/합계에서 한 번/);assert.match(text,/Round each line with my custom rule/);assert.deepEqual(JSON.parse(runInContext('JSON.stringify(settingsMission.value.memories.map(m=>m.content))',f.app.context)),['Round each line','Round aggregate once','Round each line with my custom rule']);
});

test('learned memory search includes the name and exact source Work title',async()=>{
 const f=fixture();await f.open();runInContext("const learned={...settingsMission.value.memories[0],id:'learned',version:2,authority:'learned',effective:false,name:'Learned display name'};settingsMission.value.memories.push(learned);settingsMission.value.growth=[{id:'growth',candidate:'learned@2',status:'evaluated',counterevidence:'Original caution'}];renderSettings();",f.app.context);
 for(const query of ['Learned display name','Exact source title']){const input=f.app.all().find(n=>n.id==='settings-search')!;input.value=query;await input.fire('input');assert.match(f.app.node('settings-memory-body').textContent,/Learned display name/);}
});


test('B12 reuses the single Settings search and keeps the explicit detail and source inline',async()=>{
 const f=fixture();await f.open();const nodes=f.app.all(),toggle=nodes.find(n=>n.id==='memory-switch-rounding')!,text=toggle.parentElement!.children[0]!;
 assert.equal(nodes.some(n=>n.id==='memory-query'),false);
 assert.equal(text.children.length,2);assert.equal(text.children[0]!.textContent,'Rounding rule');
 assert.equal(text.children[1]!.textContent,'Instruction remains visible · '+copy('ui.panel.memory-version',{version:1})+' · '+copy('ui.panel.in-use')+' · '+f.source.title);
 assert.equal(text.children[1]!.children[0]!.attributes.get('role'),'link');
 const search=f.app.node('settings-search');search.value='unmatched instruction';await search.fire('input');assert.doesNotMatch(f.app.node('settings-memory-body').textContent,/Rounding rule/);
 search.value='Instruction remains visible';await search.fire('input');assert.match(f.app.node('settings-memory-body').textContent,/Rounding rule/);assert.equal(f.app.node('settings-nav-memory').hidden,false);
 assert.equal(f.app.calls.some(c=>c.options.method==='POST'),false);
});

test('B12 learned rows show one detail line with pending, active and inactive state',async()=>{
 const f=fixture();await f.open();
 for(const [status,effective,label] of [['evaluated',false,copy('sidebar.status.01')],['adopted',true,copy('ui.panel.in-use')],['adopted',false,copy('ui.panel.not-in-use')]] as const){
  runInContext("settingsMission.value.memories.push({...settingsMission.value.memories[0],id:'learned',version:2,authority:'learned',name:'Learned name',content:'Learned instruction',effective:"+effective+"});settingsMission.value.growth=[{id:'growth',candidate:'learned@2',status:'"+status+"',counterevidence:'Caution'}];renderSettings();",f.app.context);
  const title=f.app.all().find(n=>n.tagName==='STRONG'&&n.textContent==='Learned name')!,text=title.parentElement!;
  assert.equal(text.children.length,2);assert.equal(text.children[1]!.textContent,'Learned instruction · '+copy('ui.panel.memory-version',{version:2})+' · '+label);
  runInContext("settingsMission.value.memories.pop()",f.app.context);
 }
});

test('B12 history separates actual adoption and reversion dates and never uses evaluation time',async()=>{
 const f=fixture();await f.open();const adoptedAt=Date.UTC(2026,10,3,9),revertedAt=Date.UTC(2026,10,4,9),evaluatedAt=Date.UTC(2026,10,1,9);
 runInContext("settingsMission.value.memories.push({...settingsMission.value.memories[0],version:2,authority:'learned',content:'Learned instruction',effective:false});settingsMission.value.growth=[{id:'growth',baseline:'rounding@1',candidate:'rounding@2',status:'reverted',adoptedAt:"+adoptedAt+",revertedAt:"+revertedAt+",ruleChange:{at:"+evaluatedAt+",state:'open'}}];renderSettings();",f.app.context);
 const cards=f.app.node('settings-memory-body').children,history=cards[cards.length-1]!;assert.equal(history.children.length,2);
 assert.match(history.children[0]!.textContent,/11월 4일/);assert.match(history.children[0]!.textContent,/Instruction remains visible/);
 assert.match(history.children[1]!.textContent,/11월 3일/);assert.match(history.children[1]!.textContent,/Learned instruction/);assert.doesNotMatch(history.textContent,/11월 1일/);
 runInContext("delete settingsMission.value.growth[0].adoptedAt;delete settingsMission.value.growth[0].revertedAt;renderSettings();",f.app.context);
 const legacy=f.app.node('settings-memory-body').children.at(-1)!;assert.equal(legacy.children.length,1);assert.doesNotMatch(legacy.textContent,/11월|Invalid Date/);
});
