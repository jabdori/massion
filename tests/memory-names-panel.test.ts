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
 const text=f.app.node('settings-memory-body').textContent;assert.match(text,/줄마다 반올림/);assert.match(text,/합계에서 한 번 반올림/);assert.match(text,/Round each line with my custom rule/);assert.deepEqual(JSON.parse(runInContext('JSON.stringify(settingsMission.value.memories.map(m=>m.content))',f.app.context)),['Round each line','Round aggregate once','Round each line with my custom rule']);
});

test('learned memory search includes the name and exact source Work title',async()=>{
 const f=fixture();await f.open();runInContext("const learned={...settingsMission.value.memories[0],id:'learned',version:2,authority:'learned',effective:false,name:'Learned display name'};settingsMission.value.memories.push(learned);settingsMission.value.growth=[{id:'growth',candidate:'learned@2',status:'evaluated',counterevidence:'Original caution'}];renderSettings();",f.app.context);
 for(const query of ['Learned display name','Exact source title']){const input=f.app.all().find(n=>n.id==='memory-query')!;input.value=query;await input.fire('input');assert.match(f.app.node('settings-memory-body').textContent,/Learned display name/);}
});
