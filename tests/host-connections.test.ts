import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseHostManifest,compileHostBindings,createHostConnections,loadHostStartup,loadHostManifest} from '../src/host-connections.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {harness,reply} from './support/workbench-client.ts';
const manifest=()=>({version:1,revision:'owner-v1',mode:'https',connections:[{id:'account',label:'Owner account',providerType:'compatible',baseUrl:'https://owner.example/v1/',models:['exec','review'],credential:{ref:'owner-ref',environment:'OWNER_MODEL_SECRET'}}]});
async function root(t:test.TestContext){const root=await mkdtemp(join(tmpdir(),'massion-host-binding-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('host resolver lazily enforces exact reference, discovery/profile identity, endpoint and cancellation',async t=>{
 const directory=await root(t),input=parseHostManifest(manifest());let reads=0;const sources:string[]=[];
 const host=compileHostBindings(input,name=>{reads++;sources.push(name);return 'synthetic-secret';});
 const manager=createHostConnections(new InMemoryStore<Mission>(),new TextArtifactStore(directory),{manifest:input,allowLiveExecution:false},{readEnvironment:()=>{assert.fail('Readiness cannot read credentials');},transport:async()=>{assert.fail('Readiness cannot send');}});
 const connection=manager.list().connections[0]!,profile=manager.list().runtime.connections[0]!;assert.ok('endpoint' in profile&&typeof profile.endpoint==='string');
 const discover={secretRef:'owner-ref',profileId:connection.id,endpoint:connection.baseUrl+'models',signal:new AbortController().signal};const inference={...discover,profileId:profile.id,endpoint:profile.endpoint};
 assert.equal(reads,0);for(const change of [{secretRef:'other'},{profileId:'other'},{endpoint:'https://attacker.example/v1/models'},{endpoint:discover.endpoint+'?key=private'}])await assert.rejects(host.resolveCredential({...discover,...change}),/binding/);
 await assert.rejects(host.resolveCredential({...inference,profileId:connection.id}),/binding/);await assert.rejects(host.resolveCredential({...discover,profileId:profile.id}),/binding/);assert.equal(reads,0);
 const aborted=new AbortController();aborted.abort();await assert.rejects(host.resolveCredential({...inference,signal:aborted.signal}));assert.equal(reads,0);
 assert.equal(await host.resolveCredential(discover),'synthetic-secret');assert.equal(await host.resolveCredential(inference),'synthetic-secret');assert.deepEqual(sources,['OWNER_MODEL_SECRET','OWNER_MODEL_SECRET']);
 const changed=manifest();changed.revision='owner-v2';const next=compileHostBindings(parseHostManifest(changed),()=>{assert.fail('Old identities cannot resolve after a host revision change');});await assert.rejects(next.resolveCredential(inference),/binding/);assert.notEqual(next.bindings.connections[0]!.input.id,connection.id);
 for(const accessor of [()=>undefined,()=>{throw Error('private-synthetic-value');},()=> 'secret\n']){const unavailable=compileHostBindings(input,accessor);await assert.rejects(unavailable.resolveCredential(discover),error=>error instanceof Error&&error.message==='Host credential unavailable');}
 const controller=new AbortController();const cancelled=compileHostBindings(input,()=>{controller.abort();return 'synthetic-secret';});await assert.rejects(cancelled.resolveCredential({...inference,signal:controller.signal}));
});

test('normal host composition exposes only declared models and gates live grants without reading values',async t=>{
 const directory=await root(t),input=parseHostManifest(manifest());let reads=0,sends=0;const manager=createHostConnections(new InMemoryStore<Mission>(),new TextArtifactStore(directory),{manifest:input,allowLiveExecution:false},{readEnvironment:()=>{reads++;return 'synthetic-secret';},transport:async(url,init)=>{sends++;assert.equal(url,'https://owner.example/v1/models');assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-secret');return new Response(JSON.stringify({data:[{id:'exec'},{id:'review'},{id:'not-declared'}]}),{headers:{'content-type':'application/json'}});}});
 const catalog=manager.list();assert.equal(catalog.host?.revision,'owner-v1');assert.equal(catalog.runtime.connections.length,2);assert.equal(reads,0);assert.equal(sends,0);assert.equal(catalog.liveExecutionEnabled,false);assert.doesNotMatch(JSON.stringify(catalog),/OWNER_MODEL_SECRET|owner-ref|synthetic-secret/);
 const connection=catalog.connections[0]!;assert.throws(()=>manager.connect({id:connection.id,label:connection.label,providerType:'compatible',baseUrl:'https://attacker.example/v1/',mode:'https',secretRef:'owner-ref'}),/manifest/);
 assert.throws(()=>manager.selectModel(connection.id,{model:'not-declared',label:'Other',expectedConfigHash:connection.configHash}),/not declared/);
 const profiles=catalog.runtime.connections;assert.throws(()=>manager.authorize({id:'grant',scope:'owner-scope',executorProfileId:profiles[0]!.id,verifierProfileId:profiles[1]!.id,maxOutputTokensPerCall:8,expectedConfigHash:catalog.configHash}),/separately authorized/);assert.equal(reads,0);assert.equal(sends,0);
 const result=await manager.discover(connection.id,connection.configHash);assert.equal(result.status,'listed');assert.deepEqual(result.models.map(m=>m.id),['exec','review']);assert.equal(reads,1);assert.equal(sends,1);
 const unavailable=createHostConnections(new InMemoryStore<Mission>(),new TextArtifactStore(directory),{manifest:input,allowLiveExecution:true},{readEnvironment:()=>undefined,transport:async()=>{assert.fail('Missing value must not dispatch');}});const missing=unavailable.list().connections[0]!;assert.equal((await unavailable.discover(missing.id,missing.configHash)).status,'unavailable');
 const maximumLabel=manifest();maximumLabel.connections[0]!.label='L'.repeat(512);const labeled=createHostConnections(new InMemoryStore<Mission>(),new TextArtifactStore(directory),{manifest:parseHostManifest(maximumLabel),allowLiveExecution:false},{readEnvironment:()=>{assert.fail('Enrollment cannot read credentials');},transport:async()=>{assert.fail('Enrollment cannot send');}});assert.equal(labeled.list().connections[0]!.label.length,512);assert.equal(labeled.list().runtime.connections.length,2);
 const defaultManager=createHostConnections(new InMemoryStore<Mission>(),new TextArtifactStore(directory),{allowLiveExecution:false},{readEnvironment:()=>{assert.fail('No implicit environment lookup');},transport:async()=>{assert.fail('Default startup must not send');}});assert.equal(defaultManager.list().host,null);assert.equal(defaultManager.list().runtime.connections.length,0);
});

test('host manifest schema and selected-file loader reject tampering, implicit sources and invalid startup options',async t=>{
 const directory=await root(t),file=join(directory,'host.json'),original=manifest();await writeFile(file,JSON.stringify(original));const start=await loadHostStartup(['--host-config',file]);assert.equal(start.allowLiveExecution,false);assert.equal((await loadHostStartup(['--host-config',file,'--allow-live-model-calls'])).allowLiveExecution,true);
 for(const args of [['--allow-live-model-calls'],['--host-config'],['--host-config',file,'--host-config',file],['--host-config',file,'--allow-live-model-calls','--allow-live-model-calls'],['--unknown']])await assert.rejects(loadHostStartup(args));
 const changed=structuredClone(original);changed.connections[0]!.baseUrl='https://other.example/v1/';assert.notEqual(compileHostBindings(parseHostManifest(changed),()=>undefined).bindings.bindingHash,compileHostBindings(parseHostManifest(original),()=>undefined).bindings.bindingHash);
 for(const change of [{...original,version:2},{...original,apiKey:'must-not-be-logged'},{...original,connections:[{...original.connections[0],baseUrl:'https://owner.example/v1'}]},{...original,connections:[{...original.connections[0],credential:{ref:'owner-ref',file:'~/.keys'}}]},{...original,connections:[{...original.connections[0],credential:{ref:'owner-ref',environment:'BAD-NAME'}}]},{...original,mode:'local-http-mock'},{...original,connections:[original.connections[0],original.connections[0]]}])assert.throws(()=>parseHostManifest(change));
 await symlink(file,join(directory,'symlink.json'));await assert.rejects(loadHostManifest(join(directory,'symlink.json')),/cannot be read/);await assert.rejects(loadHostManifest(directory));await writeFile(file,' '.repeat(32769));await assert.rejects(loadHostManifest(file),/bounded regular/);await writeFile(file,Buffer.from([0xff]));await assert.rejects(loadHostManifest(file),/UTF-8 JSON/);
 const tooLong=manifest();tooLong.connections[0]!.baseUrl='https://owner.example/'+'a'.repeat(477)+'/';assert.equal(tooLong.connections[0]!.baseUrl.length,500);assert.throws(()=>parseHostManifest(tooLong),/inference endpoint/);const boundary=manifest();boundary.connections[0]!.baseUrl='https://owner.example/'+'a'.repeat(473)+'/';assert.equal(boundary.connections[0]!.baseUrl.length+16,512);assert.doesNotThrow(()=>parseHostManifest(boundary));
 const fixture={version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['exec','review']}]};await writeFile(file,JSON.stringify(fixture));await assert.rejects(loadHostStartup(['--host-config',file,'--allow-live-model-calls']),/HTTPS/);
});

test('managed host UI displays revision/live gate, keeps declared model selection and blocks connection mutation',async t=>{
 const directory=await root(t),manager=createHostConnections(new InMemoryStore<Mission>(),new TextArtifactStore(directory),{manifest:parseHostManifest(manifest()),allowLiveExecution:false},{readEnvironment:()=>{assert.fail('Rendering must not resolve');},transport:async()=>{assert.fail('Rendering must not send');}});
 const app=harness(async path=>path==='/connections'?reply(manager.list()):path==='/providers'?reply({providers:[],selection:{status:'unavailable'},runtime:manager.configuration()}):path==='/health'?reply({status:'ready'}):reply({head:0,events:[]}));
 const end=Date.now()+5000;while(!app.node('connection-status').textContent.includes('owner-v1')){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,5));}
 assert.match(app.node('connection-status').textContent,/Live model calls disabled/);assert.equal(app.node('connection-fields').disabled,true);assert.equal(app.all().find(n=>n.textContent==='Explore models')!.disabled,false);const count=app.calls.length;await app.submit('connection-form');assert.equal(app.calls.length,count);
});
