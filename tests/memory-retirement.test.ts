import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,createMission,DomainError} from '../src/domain.ts';
import type {Actor,Command} from '../src/domain.ts';
import {pinnedMemoryInput} from '../src/memory-input.ts';
const owner:Actor={id:'owner',roles:['owner']};
const send=(m:ReturnType<typeof createMission>,command:Command,actor=owner)=>apply(m,command,actor).value;
function fixture(){let m=createMission({id:'mission',purpose:'Retain historical memory',scope:'owned',constraints:[],criteria:{version:1,description:'Preserve pins',oracle:'manual-review/v1'}},owner);for(const id of ['instruction','other'])m=send(m,{type:'save-memory',memory:{id,version:1,content:'Original '+id,source:'Owner source',scope:'owned',authority:'explicit',effective:true}});return send(m,{type:'admit-work',workId:'old',title:'Old pinned Work',budget:0});}
test('retirement changes only exact effective explicit flag; old input stays exact and other future memory remains',()=>{
 const before=fixture(),old=structuredClone(before.works[0]),memory=structuredClone(before.memories),original=pinnedMemoryInput(before,old!);
 let after=send(before,{type:'retire-memory',memoryId:'instruction',version:1,reason:'No future application'});assert.deepEqual(before,fixture());assert.deepEqual(after.works[0],old);assert.deepEqual(after.memories,[{...memory[0]!,effective:false},memory[1]!]);assert.deepEqual(pinnedMemoryInput(after,old!),original);
 after=send(after,{type:'admit-work',workId:'future',title:'Future Work',budget:0});assert.deepEqual(after.works[1]?.appliedMemoryVersions,['other@1']);
 after=send(after,{type:'save-memory',memory:{...memory[0]!,version:2,content:'Deliberate reactivation',effective:true}});after=send(after,{type:'admit-work',workId:'reactivated',title:'Later Work',budget:0});assert.deepEqual(after.works[0],old);assert.deepEqual(after.works[1]?.appliedMemoryVersions,['other@1']);assert.deepEqual(after.works[2]?.appliedMemoryVersions,['other@1','instruction@2']);
});
test('retirement rejects non-owner, inactive/superseded/learned/missing/scope and invalid fields without mutating input',()=>{
 const before=fixture(),original=structuredClone(before),command:Command={type:'retire-memory',memoryId:'instruction',version:1,reason:'Stop future use'};
 for(const roles of [['representative'],['executor'],['verifier'],['evaluator']] as Actor['roles'][])assert.throws(()=>send(before,command,{id:'non-owner',roles}),e=>e instanceof DomainError&&e.code==='denied');
 for(const c of [{...command,memoryId:'missing'},{...command,version:0},{...command,version:2},{...command,reason:''},{...command,reason:' '.repeat(3)},{...command,reason:'x'.repeat(16001)}])assert.throws(()=>send(before,c));
 const retired=send(before,command);assert.throws(()=>send(retired,command),/not effective/);
 const superseded=send(before,{type:'save-memory',memory:{...before.memories[0]!,version:2,effective:true}});assert.throws(()=>send(superseded,command),/not effective/);
 const learned=send(before,{type:'save-memory',memory:{id:'learned',version:1,content:'Candidate',source:'Fixture proposal',scope:'owned',authority:'learned',effective:false}},{id:'representative',roles:['representative']});assert.throws(()=>send(learned,{...command,memoryId:'learned'}),/Only explicit/);
 const wrongScope=structuredClone(before);wrongScope.memories[0]!.scope='outside';const untouched=structuredClone(wrongScope);assert.throws(()=>send(wrongScope,command),/scope/);assert.deepEqual(wrongScope,untouched);assert.deepEqual(before,original);
});
