import type {TestContext} from 'node:test';
import {growthStore,growthJournal} from './growth-fixture.ts';
import {textFixture} from './record-artifact-fixture.ts';
import {ProductService} from '../../src/product.ts';
import {Application} from '../../src/application.ts';
import {memoryVersionHash} from '../../src/domain.ts';
/** Data-only originals/accepted Record/unknown effect. No model or adapter invocation. */
export async function memoryConflictFixture(t:TestContext,durable=false,cli=false){
 const {store,transport}=await growthStore(durable),f=await textFixture(t,store,cli),product=new ProductService(store),current=async()=>(await store.load('mission'))!;
 for(const [id,content] of [['a','  Original A <img src=x>\r\n원문 😀  '],['b','Original B\ncontrasting instruction']])await product.saveMemory('mission',{commandId:'save-'+id,expectedRevision:(await current()).revision,memory:{id:id!,version:1,content:content!,source:'Literal owner source'}});
 const app=new Application(store,[{id:'local-owner',roles:['owner']},{id:'executor',roles:['executor']}]);let sequence=0;const send=async(command:any,actorId='local-owner')=>app.dispatch({missionId:'mission',commandId:'data-only-'+(++sequence),expectedRevision:(await current()).revision,actorId,command});
 await send({type:'admit-work',workId:'old',title:'Old pinned fresh Work',budget:8});await send({type:'admit-work',workId:'unknown',title:'Original unknown effect',budget:8});await send({type:'assign',workId:'unknown',assignment:{id:'unknown-executor',actorId:'executor',role:'executor',taskId:'unknown:root',model:{provider:'fixture',model:'data-only',configVersion:'v1',reason:'Data-only intent/receipt, no invocation',evidenceClass:'fixture'},extensionVersion:'v1'}});await send({type:'admit-effect',workId:'unknown',effect:{id:'unknown-effect',taskId:'unknown:root',status:'pending',target:'Data-only original target',authority:'Data-only owner fixture'},reserve:1},'executor');await send({type:'receipt',workId:'unknown',effectId:'unknown-effect',outcome:'unknown',receipt:'Data-only unresolved evidence; no external call',usage:null},'executor');
 await product.create({id:'other',purpose:'Other Mission',scope:'local',constraints:[],criteria:{version:1,description:'Other',oracle:'manual-review/v1'}},'other-create');for(const id of ['a','b'])await product.saveMemory('other',{commandId:'other-'+id,expectedRevision:(await store.load('other'))!.revision,memory:{id,version:1,content:'Different other-Mission '+id,source:'Other source'}});
 const reference=(id:string)=>{const m=(currentValue!.memories.find(m=>m.id===id&&m.version===1))!;return {id:m.id,version:m.version,hash:memoryVersionHash(m)};};let currentValue=(await current()).value;
 const input=async(conflictId='conflict:one',commandId='declare-one')=>{currentValue=(await current()).value;return {commandId,expectedRevision:(await current()).revision,conflictId,first:reference('a'),second:reference('b'),reason:'Owner declares exact versions conflict <img src=x>\n원문 😀'};};
 async function until(check:()=>boolean){const deadline=Date.now()+12000;while(!check()){if(Date.now()>deadline)throw Error('Memory conflict fixture deadline');await new Promise(r=>setTimeout(r,5));}}
 return {...f,transport,product,current,send,input,until,journal:()=>growthJournal(store)};
}
