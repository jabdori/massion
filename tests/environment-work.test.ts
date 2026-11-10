import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHostManifest} from '../src/host-connections.ts';

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
