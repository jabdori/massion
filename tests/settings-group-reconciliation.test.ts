import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {harness,reply,settle} from './support/workbench-client.ts';

test('a lost group save stays readonly until a later fresh catalog read; reconciliation never resends',async()=>{
 const fixture=await loadFixture('B20');
 let catalog=structuredClone(fixture.routes['/connections']!.body) as any,posted=0,holdRead=false,resolveRead!:(value:any)=>void,rejectSave!:(reason:Error)=>void;
 const app=harness(async(path,options)=>{
  if(path==='/model-groups'){posted++;return new Promise((_,reject)=>{rejectSave=reject;});}
  if(path==='/connections'){if(holdRead){holdRead=false;return new Promise(resolve=>{resolveRead=resolve;});}return reply(catalog);}
  const route=fixture.routes[path];return route?reply(route.body,route.status):reply({},503);
 });
 await settle();await app.node('me-settings').fire('click');await settle();await app.node('settings-nav-connections').fire('click');await settle();
 await app.all().find(n=>n.id==='settings-group-research')!.fire('click');
 const field=()=>app.all().find(n=>n.id==='settings-group-name')!;
 field().value='Unconfirmed private change';const save=field().fire('change');await settle();
 holdRead=true;const earlierRead=runInContext('settingsLoad("connections")',app.context);await settle();
 rejectSave(new Error('Reply lost'));await save;await settle();
 assert.equal(field().disabled,true);assert.equal(runInContext('settingsGroupUnknown',app.context),true);
 resolveRead(reply(catalog));await earlierRead;await settle();
 assert.equal(field().disabled,true,'a read started before the uncertain outcome cannot reconcile it');
 catalog={...catalog,configHash:'fresh-host-hash',modelGroups:catalog.modelGroups.map((g:any)=>({...g,name:'Host state after recovery'}))};
 await runInContext('settingsLoad("connections")',app.context);await settle();
 assert.equal(field().disabled,false);assert.equal(field().value,'Host state after recovery');
 assert.equal(runInContext('settingsGroupUnknown',app.context),false);assert.equal(posted,1,'a fresh read never resends the lost command');
});

test('failed or malformed catalog reads cannot unlock an uncertain group save',async()=>{
 const fixture=await loadFixture('B20');let response:any=reply(fixture.routes['/connections']!.body);
 const app=harness(async(path)=>path==='/connections'?response:fixture.routes[path]?reply(fixture.routes[path]!.body,fixture.routes[path]!.status):reply({},503));
 await settle();await app.node('me-settings').fire('click');await settle();await app.node('settings-nav-connections').fire('click');await settle();
 runInContext('settingsGroupUnknown=true',app.context);
 for(const invalid of [reply({},503),reply({configHash:'fresh'}),reply({modelGroups:[],configHash:''})]){
  response=invalid;await runInContext('settingsLoad("connections")',app.context);await settle();
  assert.equal(runInContext('settingsGroupUnknown',app.context),true);
 }
 assert.ok(!app.calls.some(c=>c.options?.method==='POST'));
});
