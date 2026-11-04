import {ProductService} from '../../src/product.ts';
import {Application} from '../../src/application.ts';
import {runCalculationScenario,FIXTURE_ACTORS} from '../../src/scenario.ts';
import type {Mission,Command} from '../../src/domain.ts';
import type {Store} from '../../src/storage.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../../src/storage.ts';
import {verifyDisposableDatabase} from './owned-process.ts';
export async function growthStore(durable:boolean){
 if(!durable)return {store:new InMemoryStore<Mission>(),transport:undefined};
 await verifyDisposableDatabase();const database='owner_growth_'+crypto.randomUUID().replaceAll('-','');const transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE!,database});await transport.query('DEFINE DATABASE '+database+';',{});await initializeSurrealSchema(transport);return {store:new SurrealStore<Mission>(transport),transport};
}
/** Credential-free stored evaluator fixture; never normal API caller-certified evaluation. */
export async function seedGrowth(store:Store<Mission>,id='mission:growth',acceptedRoot?:string){
 const product=new ProductService(store),fixture=new Application(store,FIXTURE_ACTORS);let sequence=0;
 const send=async(command:Command,actorId='local-owner')=>fixture.dispatch({missionId:id,commandId:'fixture-'+id+'-'+(++sequence),expectedRevision:(await store.load(id))!.revision,actorId,command});
 if(acceptedRoot)await runCalculationScenario(store,acceptedRoot,id);
 else {await product.create({id,purpose:'Inspect stored evaluated memory before owner action',scope:'controlled-fixture',constraints:[],criteria:{version:1,description:'Preserve exact versions and old Work pins',oracle:'manual-review/v1'}},'create-'+id);await product.saveMemory(id,{commandId:'baseline-'+id,expectedRevision:1,memory:{id:'rounding',version:1,content:'Original baseline instruction',source:'Owner fixture source'}});await product.admit(id,{commandId:'old-'+id,expectedRevision:2,workId:'old',title:'Previously pinned Work',budget:0});}
 await send({type:'save-memory',memory:{id:'other',version:1,scope:'controlled-fixture',authority:'explicit',content:'Unrelated owner instruction',source:'Owner fixture',effective:true}});
 await send({type:'save-memory',memory:{id:'rounding',version:2,scope:'controlled-fixture',authority:'learned',content:'Candidate <img src=x> exact instruction',source:'Credential-free fixture evidence source',effective:false}},'representative');
 await send({type:'propose-growth',proposal:{id:'g',proposer:'representative',target:'memory',baseline:'rounding@1',candidate:'rounding@2',counterevidence:'Stored counterexample <img src=x> outside fixture scope',status:'proposed'}},'representative');
 await send({type:'evaluate-growth',growthId:'g',baseline:1,candidate:2,heldOut:'Credential-free evaluator fixture <img src=x>\nNot a live-model certificate'},'growth-evaluator');
 const input=()=>({growthId:'g',baseline:'rounding@1',candidate:'rounding@2',expectedRevision:0,commandId:''});
 return {product,fixture,send,id,input};
}
export const growthJournal=async(store:Store<Mission>)=>store instanceof SurrealStore?(await store.exportJournal()).operations:(store as InMemoryStore<Mission>).inspect();
