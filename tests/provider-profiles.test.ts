import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionCatalog} from '../src/provider-profiles.ts';
import type {ModelConnectionProfile,ModelAdapterFactory} from '../src/provider-profiles.ts';

const profile=(id='primary'):ModelConnectionProfile=>({id,label:id,backend:'model-provider',providerKind:'fixture-provider',protocol:'fixture-text/v1',model:'exact-v1',endpoint:'http://127.0.0.1:1234/text',revision:'1',enabled:true,auth:{method:'none'},capabilities:['text-output'],usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},limits:{maxInputBytes:4096,maxOutputTokens:64,maxResponseBytes:4096,timeoutMs:1000}});
const factory:ModelAdapterFactory={protocol:'fixture-text/v1',authMethods:['none'],capabilities:['text-output'],evidenceClass:'fixture',validate:()=>[],create:(p)=>({descriptor:{provider:p.providerKind,model:p.model,configVersion:p.revision,enabled:true,capabilities:['text-output'],evidenceClass:'fixture'},invoke:async()=>({status:'completed',output:'Fixture only',usage:{inputTokens:1,outputTokens:1},reason:'fixture'})})};
class PrototypeFactory implements ModelAdapterFactory {
 protocol=factory.protocol;authMethods=[...factory.authMethods];capabilities=[...factory.capabilities];evidenceClass:ModelAdapterFactory['evidenceClass']='fixture';
 readonly #model='exact-v1';readonly #adapterFactory=factory;
 validate(p:Readonly<ModelConnectionProfile>){return p.model===this.#model?[]:[{code:'model_unsupported',message:'Unsupported fixture model.'}];}
 create(p:Readonly<ModelConnectionProfile>){assert.equal(p.model,this.#model);return this.#adapterFactory.create(p);}
}

test('catalog list preserves prototype validation and its original private state',()=>{
 const catalog=new ConnectionCatalog([profile(),{...profile('unsupported'),model:'other'}],[new PrototypeFactory()]);
 const listed=catalog.list();
 assert.deepEqual(listed[0]?.diagnostics,[]);
 assert.deepEqual(listed[1]?.diagnostics,[{code:'model_unsupported',message:'Unsupported fixture model.'}]);
});
test('catalog resolve preserves prototype construction and its original private state',()=>{
 const result=new ConnectionCatalog([profile()],[new PrototypeFactory()]).resolve('primary',['text-output']);
 assert.equal(result.status,'selected');
 if(result.status==='selected'){
  assert.equal(result.adapter.descriptor.model,'exact-v1');
  assert.equal(result.adapter.descriptor.configVersion,result.configHash);
 }
});
test('factory registration snapshots metadata while retaining the original method receiver',()=>{
 const instance=new PrototypeFactory();
 const catalog=new ConnectionCatalog([profile(),{...profile('auth'),auth:{method:'oauth'}},{...profile('capability'),capabilities:['tools']}],[instance]);
 instance.authMethods.splice(0,1,'oauth');instance.capabilities.splice(0,1,'tools');
 instance.protocol='changed';instance.evidenceClass='real-provider';
 assert.equal(catalog.resolve('primary',['text-output']).status,'selected');
 const listed=catalog.list();
 assert.deepEqual(listed[0]?.diagnostics,[]);
 assert.ok(listed[1]?.diagnostics.some(d=>d.code==='auth_unsupported'));
 assert.ok(listed[2]?.diagnostics.some(d=>d.code==='capability_unsupported'));
});

test('catalog never selects the first available connection when a profile is missing',()=>{
 const catalog=new ConnectionCatalog([profile()],[factory]);
 assert.equal(catalog.resolve('missing',['text-output']).status,'unavailable');
 assert.equal(catalog.resolve('primary',['text-output']).status,'selected');
});
test('unknown protocol, authentication and capability are visible preflight diagnostics',()=>{
 for(const [change,code] of [[{protocol:'native-unknown'},'protocol_unsupported'],[{auth:{method:'oauth',secretRef:'opaque'}},'auth_unsupported'],[{capabilities:['tools']},'capability_unsupported']] as const){
  const catalog=new ConnectionCatalog([{...profile(),...change} as ModelConnectionProfile],[factory]);
  const result=catalog.resolve('primary',['text-output']);assert.equal(result.status,'unavailable');
  if(result.status==='unavailable')assert.ok(result.diagnostics.some(d=>d.code===code));
 }
});
test('profile identity is immutable and changes with model, endpoint, limits and secret reference',()=>{
 const p=profile();const catalog=new ConnectionCatalog([p],[factory]);const original=catalog.list()[0]!;
 p.model='changed';const pinned=catalog.list()[0]!;assert.equal(pinned.backend==='model-provider'&&pinned.model,'exact-v1');
 for(const change of [{model:'other'},{endpoint:'http://127.0.0.1:2345/text'},{limits:{...p.limits,maxOutputTokens:32}},{auth:{method:'none',secretRef:'other'}}]){
  const changed=new ConnectionCatalog([{...profile(),...change}],[factory]).list()[0]!;assert.notEqual(changed.configHash,original.configHash);
 }
});
test('duplicate profiles and duplicate factory contracts reject instead of order-dependent routing',()=>{
 assert.throws(()=>new ConnectionCatalog([profile(),profile()],[factory]),/duplicate/i);
 assert.throws(()=>new ConnectionCatalog([profile()],[factory,factory]),/duplicate/i);
});
test('ACP is not silently adapted as raw model inference',()=>{
 const catalog=new ConnectionCatalog([{id:'agent',label:'Agent',backend:'acp-agent',protocolVersion:1,agentId:'example',enabled:false}],[factory]);
 const result=catalog.resolve('agent',['text-output']);assert.equal(result.status,'unavailable');
 if(result.status==='unavailable')assert.ok(result.diagnostics.some(d=>d.code==='backend_unsupported'));
});

test('adapter descriptor cannot silently change selected provider/model or evidence class',()=>{
 const liar={...factory,create:(p:ModelConnectionProfile)=>({...factory.create(p),descriptor:{...factory.create(p).descriptor,model:'fallback-model'}})};
 const result=new ConnectionCatalog([profile()],[liar]).resolve('primary',['text-output']);assert.equal(result.status,'unavailable');
 if(result.status==='unavailable')assert.equal(result.diagnostics[0]?.code,'adapter_contract_mismatch');
});
