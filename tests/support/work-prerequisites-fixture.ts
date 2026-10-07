import {textFixture} from './record-artifact-fixture.ts';
import {growthStore,growthJournal} from './growth-fixture.ts';
import {ConfiguredTextRuntime} from '../../src/configured-runtime.ts';
import {ProductService} from '../../src/product.ts';
import {ProviderRegistry} from '../../src/providers.ts';
import type {ProviderAdapter,ProviderRequest} from '../../src/providers.ts';
import {hash,workInputHash} from '../../src/domain.ts';
/** Deterministic independent role adapters. No real model, account or permission changes. */
export async function prerequisiteFixture(t:import('node:test').TestContext,durable=false,cli=false){
 const {store,transport}=await growthStore(durable),f=await textFixture(t,store,cli),original=(await store.load('mission'))!,calls:{role:string;input:any}[]=[],adapter=(role:string):ProviderAdapter=>({descriptor:{provider:'controlled-prerequisite-fixture',model:role,configVersion:'fixture-v1',enabled:true,capabilities:['text-output'],evidenceClass:'fixture'},async invoke(req:ProviderRequest){const input=JSON.parse(req.instruction);calls.push({role,input});return {status:'completed',output:role==='executor'?'Independent bounded prerequisite output':JSON.stringify({artifactSha256:input.binding.artifactSha256,criteriaVersion:input.criteria.version,criteriaHash:input.binding.criteriaHash,verdict:'passed',checks:[{criterion:input.criteria.description,passed:true,quote:'Independent bounded',reason:'Controlled independent verifier fixture'}]}),usage:{inputTokens:1,outputTokens:1},reason:'Credential-free fixture'};}}),executor=adapter('executor'),verifier=adapter('verifier'),runtime=new ConfiguredTextRuntime(store,{enabled:true,outputTokenCap:4,authorization:{id:'controlled-prerequisite-only',scope:'local',mode:'mock-http',executor:executor.descriptor,verifier:verifier.descriptor,maxOutputTokensPerCall:4},executor:{identity:'host-executor',adapter:executor},verifier:{identity:'host-verifier',adapter:verifier},artifacts:f.artifacts}),product=new ProductService(store,new ProviderRegistry([executor,verifier]),runtime);
 const current=async()=>(await store.load('mission'))!;
 await product.reviseMission('mission',{commandId:'prereq-criteria',expectedRevision:original.revision,purpose:original.value.purpose,criteria:{version:2,description:'Independent bounded prerequisite output',oracle:'bounded-text-review/v1'}});
 async function admit(id:string){return product.admit('mission',{commandId:'admit-'+id,expectedRevision:(await current()).revision,workId:id,title:'Responsibility '+id,budget:8});}
 async function pin(workId:string,prerequisiteId:string,commandId='pin-'+workId+'-'+prerequisiteId){const s=await current(),target=s.value.works.find(w=>w.id===prerequisiteId)!;return {commandId,expectedRevision:s.revision,workId,prerequisiteId,inputHash:workInputHash(target),criteriaHash:hash(target.criteria),reason:'Owner causal decision <img src=x> '+workId+' requires '+prerequisiteId};}
 return {...f,transport,original,current,admit,pin,calls,runtime,product,journal:()=>growthJournal(store)};
}
