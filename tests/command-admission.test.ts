import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import type {Envelope} from '../src/application.ts';
import type {Mission} from '../src/domain.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import {verifyDisposableDatabase} from './support/owned-process.ts';

for(const durable of [false,true])for(const boundary of ['lookup','load'] as const)test(`${durable?'actual SurrealDB':'in-memory fixture'} command admission survives caller mutation during ${boundary}`,{skip:durable&&(process.platform!=='linux'||!process.env.SURREAL_TEST_RUNTIME)},async()=>{
 let transport;
 if(durable){await verifyDisposableDatabase();const database='command_capture_'+crypto.randomUUID().replaceAll('-','');transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);}
 const store=transport?new SurrealStore<Mission>(transport):new InMemoryStore<Mission>(),owner={id:'owner',roles:['owner'] as const};const app=new Application(store,[owner]);
 await app.create({id:'mission',purpose:'Owner intervention',scope:'owned',constraints:[],criteria:{version:1,description:'Retain exact instruction',oracle:'manual-review/v1'}},'owner','create');
 for(const [index,workId] of ['a','b'].entries())await app.dispatch({missionId:'mission',commandId:'admit-'+workId,expectedRevision:1+index,actorId:'owner',command:{type:'admit-work',workId,title:workId,budget:0}});
 const before=(await store.load('mission'))!,original:Envelope={missionId:'mission',commandId:'steer-a',expectedRevision:3,actorId:'owner',command:{type:'steer',workId:'a',instruction:'Original owner instruction'}},submitted=structuredClone(original);
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const lookup=store.lookupOperation.bind(store),load=store.load.bind(store);let first=true;
 if(boundary==='lookup')store.lookupOperation=async identity=>{if(first){first=false;entered();await held;}return lookup(identity);};
 else store.load=async id=>{if(first){first=false;entered();await held;}return load(id);};
 const pending=app.dispatch(submitted);await started;
 if(submitted.command.type==='steer'){submitted.command.instruction='Changed instruction';submitted.command.workId='b';}
 submitted.command={type:'cancel',workId:'b'};submitted.missionId='other';submitted.commandId='changed';submitted.expectedRevision=99;submitted.actorId='stranger';
 release();const result=await pending;store.lookupOperation=lookup;store.load=load;
 assert.equal(result.status,'committed');const current=(await load('mission'))!;assert.equal(current.revision,4);assert.deepEqual(current.value.works[1],before.value.works[1]);assert.deepEqual(current.value.works[0]!.instructions,[{actorId:'owner',text:'Original owner instruction'}]);
 const journal=()=>store instanceof SurrealStore?store.exportJournal():Promise.resolve(store.inspect());const committed=await journal();const events=await store.readEvents(3);assert.equal(events.events.length,1);assert.equal(events.events[0]!.commandId,'steer-a');
 const fresh=new Application(store,[owner]);assert.equal((await fresh.dispatch(original)).status,'replayed');assert.deepEqual(await journal(),committed);
 const changed=await fresh.dispatch({...original,command:{type:'cancel',workId:'b'}});assert.equal(changed.status,'conflict');if(changed.status==='conflict')assert.equal(changed.reason,'idempotency');assert.deepEqual(await journal(),committed);assert.equal(await load('other'),null);
});
