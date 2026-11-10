import type {ProviderAdapter,ProviderRequest} from '../../src/providers.ts';
import type {ConfiguredRuntimeOptions} from '../../src/configured-runtime.ts';
import type {TextArtifactStore} from '../../src/text-artifacts.ts';
export function fixtureOptions(artifacts:TextArtifactStore,calls:{id:string;prompt:any}[],hook?:(request:ProviderRequest,prompt:any)=>Promise<void>):ConfiguredRuntimeOptions {
 const adapter=(model:string):ProviderAdapter=>({descriptor:{provider:'fixture',model,configVersion:'v1',evidenceClass:'fixture',enabled:true,capabilities:['text-output']},async invoke(request){
  const p=JSON.parse(request.instruction);calls.push({id:request.invocationId,prompt:p});await hook?.(request,p);
  const output=p.teamPlanning?JSON.stringify({steps:p.teamPlanning.steps.map((title:string,i:number)=>({role:'Read',title,dependsOn:i?[0]:[]}))}):p.step?'Worker evidence':p.roomTurn?JSON.stringify({kind:p.roomTurn==='challenge'?'challenge':'concede',text:'Check evidence',quote:p.roomTurn==='challenge'?'Answer':''}):p.artifact?JSON.stringify({artifactSha256:p.artifact.sha256,criteriaHash:p.binding.criteriaHash,criteriaVersion:1,verdict:'passed',checks:[{criterion:p.criteria.description,passed:true,quote:'Answer',reason:'Fixture evidence'}]}):'Answer '+(p.work.instructions.at(-1)?.text??'original');
  return {status:'completed',output,usage:{inputTokens:1,outputTokens:1},reason:'Fixture'};
 }});
 const executor=adapter('producer'),verifier=adapter('checker');
 const options:ConfiguredRuntimeOptions={enabled:true,authorization:{id:'grant',scope:'test',mode:'mock-http',executor:executor.descriptor,verifier:verifier.descriptor,maxOutputTokensPerCall:10},outputTokenCap:10,executor:{identity:'producer',adapter:executor},verifier:{identity:'checker',adapter:verifier},artifacts};
 return options;
}
