import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHostManifest} from '../src/host-connections.ts';
import * as environmentWork from '../src/environment-work.ts';
import type {EnvironmentWorkDefinition} from '../src/environment-work.ts';
import {DomainError} from '../src/domain.ts';

const definition={memberId:'fixture-member',origin:'https://fixture.example',elements:[
 {id:'input',selector:'#input',role:'textbox',label:'입력값',operations:['type'],gates:[]},
 {id:'confirm',selector:'#confirm',role:'checkbox',label:'기기 확인',operations:['click'],gates:[],ownerOnly:true},
],facts:[{id:'entered',selector:'#input',state:'value-present',label:'입력 확인',kind:'state'},{id:'confirmed',selector:'#confirm',state:'checked',label:'기기 확인',kind:'state'}],waits:[{id:'device',request:{kind:'confirm-on-device',who:'사용자',what:'기기 확인',where:'개인 기기',fact:'confirmed',from:false,to:true,timeoutMs:10000,maxPolls:3,intervalMs:1000}}],secrets:[{id:'identity',label:'입력 정보',purpose:'선언된 필드에 입력',fields:[{slot:'identity',label:'입력값',kind:'id',element:'input'}]}]};
const manifest=()=>({version:1,revision:'fixture',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['fixture']}],environments:[structuredClone(definition)]});

test('the normal host manifest retains a bounded member environment without reading values or opening a browser',()=>{
 const input=manifest();let parsed:any;assert.doesNotThrow(()=>{parsed=parseHostManifest(input);});assert.deepEqual(parsed.environments,[definition]);input.environments[0]!.origin='https://changed.example';assert.equal(parsed.environments[0].origin,'https://fixture.example');
});

test('environment declarations reject raw secrets, unknown references and ambiguous member or slot bindings',()=>{
 const changes=[
  (d:any)=>{d.origin='http://fixture.example';},
  (d:any)=>{d.secrets[0].fields[0].value='never-log-fixture';},
  (d:any)=>{d.secrets[0].fields[0].element='missing';},
  (d:any)=>{d.secrets[0].fields[0].element='confirm';},
  (d:any)=>{d.waits[0].request.fact='missing';},
  (d:any)=>{d.facts.push({...d.facts[0]});},
  (d:any)=>{d.secrets.push({...structuredClone(d.secrets[0]),id:'duplicate'});},
 ];
 for(const change of changes){const input=manifest();change(input.environments[0]);assert.throws(()=>parseHostManifest(input),e=>e instanceof Error&&!e.message.includes('never-log-fixture'));}
 const duplicate=manifest();duplicate.environments.push(structuredClone(definition));assert.throws(()=>parseHostManifest(duplicate));
});

const planDefinition=()=>structuredClone(definition) as EnvironmentWorkDefinition;
const observe={kind:'observe',facts:['entered','confirmed']};
const plan=(operations:unknown[]=[observe])=>({format:'massion-environment/v1',operations});
const parse=(value:unknown,d=planDefinition())=>environmentWork.parseEnvironmentWorkPlan(JSON.stringify(value),d);
const invalid=(value:unknown,d=planDefinition())=>assert.throws(()=>parse(value,d),e=>e instanceof DomainError&&e.message==='Invalid environment Work plan');

test('environment Work parser exports a callable boundary and leaves ordinary output alone',()=>{
 assert.equal(typeof environmentWork.parseEnvironmentWorkPlan,'function');
 for(const output of ['ordinary text','{"format":','```json\n{}\n```','null','[]','42','"text"','{}','{"format":"massion-step/v1"}','{"format":"massion-environment/v2"}','{"format":"massion-environment/v1 "}'])assert.equal(environmentWork.parseEnvironmentWorkPlan(output,planDefinition()),null);
});

test('environment Work plans retain declared actions, waits and a final independent observation',()=>{
 const d=planDefinition();d.elements.push({id:'control',selector:'#control',role:'button',label:'Control',operations:['click','select','scroll','submit'],gates:[{kind:'irreversible-submit'}]});
 const expected=plan([
  {kind:'act',element:'input',input:{kind:'type',secret:{owner:'local-owner',slot:'identity'}}},
  {kind:'act',element:'control',input:{kind:'click'}},
  {kind:'act',element:'control',input:{kind:'select',option:'one'}},
  {kind:'act',element:'control',input:{kind:'scroll',x:-10000,y:10000}},
  {kind:'act',element:'control',input:{kind:'submit'}},
  {kind:'wait',id:'device'},observe,
 ]);
 assert.deepEqual(parse(expected,d),expected);assert.deepEqual(parse(plan()),plan());assert.deepEqual(parse(plan([{kind:'observe',facts:[]}])),plan([{kind:'observe',facts:[]}]));
 const eight=plan([...Array.from({length:7},()=>({kind:'wait',id:'device'})),observe]);assert.deepEqual(parse(eight),eight);
});

test('recognized environment Work plans require exact fields, bounded operations and final observation',()=>{
 for(const value of [
  {format:'massion-environment/v1'}, {...plan(),extra:'never-log-fixture'}, {...plan(),origin:'https://fixture.example'},
  {...plan(),operations:null}, {...plan(),operations:{}}, plan([]),plan(Array(9).fill(observe)),
  plan([{kind:'wait',id:'device'}]),plan([observe,{kind:'act',element:'input',input:{kind:'type',secret:{owner:'local-owner',slot:'identity'}}}]),
  plan([null,observe]),plan([[],observe]),plan([{kind:'unknown'},observe]),plan([{kind:'wait',id:'device',request:{}},observe]),
  plan([{kind:'observe',facts:['entered'],selector:'#input'}]),plan([{kind:'observe'}]),
 ])invalid(value);
});

test('environment actions reject undeclared, owner-only or mismatched operations and model authority',()=>{
 for(const operation of [
  {kind:'act',element:'missing',input:{kind:'click'}}, {kind:'act',element:'confirm',input:{kind:'click'}},
  {kind:'act',element:'input',input:{kind:'click'}}, {kind:'act',element:'input'},
  {kind:'act',element:'input',input:{kind:'type',value:'never-log-fixture'}},
  {kind:'act',element:'input',input:{kind:'type',secret:{owner:'local-owner',slot:'identity'},value:'never-log-fixture'}},
  ...['selector','origin','gates','literal','__proto__'].map(key=>JSON.parse('{"kind":"act","element":"input","input":{"kind":"type","secret":{"owner":"local-owner","slot":"identity"}},"'+key+'":"never-log-fixture"}')),
 ])invalid(plan([operation,observe]));
 const d=planDefinition();d.elements[0]!.operations=['select','scroll'];
 for(const input of [{kind:'select',option:''},{kind:'scroll',x:10001,y:0},{kind:'scroll',x:0.5,y:0},{kind:'scroll',x:0,y:0,extra:true}])invalid(plan([{kind:'act',element:'input',input},observe]),d);
});

test('typed secret references must belong to the local owner and the exact declared target',()=>{
 const d=planDefinition();d.elements.push({...d.elements[0]!,id:'other',selector:'#other'});
 for(const [element,secret] of [
  ['input',{owner:'remote-owner',slot:'identity'}],['input',{owner:'local-owner',slot:'missing'}],
  ['other',{owner:'local-owner',slot:'identity'}],['input',{owner:'local-owner',slot:'identity',value:'never-log-fixture'}],
  ['input',{owner:'local-owner',slot:'identity',element:'input'}],['input',null],
 ] as const)invalid(plan([{kind:'act',element,input:{kind:'type',secret}},observe]),d);
 d.secrets[0]!.id='request-name';assert.deepEqual(parse(plan([{kind:'act',element:'input',input:{kind:'type',secret:{owner:'local-owner',slot:'identity'}}},observe]),d),plan([{kind:'act',element:'input',input:{kind:'type',secret:{owner:'local-owner',slot:'identity'}}},observe]));
});

test('wait and observation identifiers must be declared and fact lists must be unique and bounded',()=>{
 for(const operation of [
  {kind:'wait',id:'missing'},{kind:'wait',id:1},{kind:'wait',id:'device',timeoutMs:1000},
  {kind:'observe',facts:['missing']},{kind:'observe',facts:['entered','entered']},{kind:'observe',facts:[1]},
  {kind:'observe',facts:'entered'},{kind:'observe',facts:null},
 ])invalid(plan([operation,observe]));
 const d=planDefinition();d.facts=Array.from({length:64},(_,i)=>({...d.facts[0]!,id:'fact-'+i}));
 const expected=plan([{kind:'observe',facts:d.facts.map(f=>f.id)}]);assert.deepEqual(parse(expected,d),expected);
 d.facts.push({...d.facts[0]!,id:'fact-64'});invalid(plan([{kind:'observe',facts:d.facts.map(f=>f.id)}]),d);
});

test('recognized plans enforce shared JSON bounds and never echo untrusted values in errors',()=>{
 for(const input of [
  {kind:'select',option:'never-log-fixture'.repeat(3000)},
  {kind:'select',option:'\ud800'},
  {kind:'scroll',x:Number.MAX_SAFE_INTEGER+1,y:0},
 ])invalid(plan([{kind:'act',element:'input',input},observe]));
 invalid({...plan(),extra:Array.from({length:257},()=>null)});
 let nested:unknown='never-log-fixture';for(let i=0;i<17;i++)nested={nested};invalid({...plan(),extra:nested});
});
