import {randomUUID} from 'node:crypto';
import {Application} from './application.ts';
import type {Mission,Command,Actor,Artifact,Work} from './domain.ts';
import type {Store} from './storage.ts';
import {BUILTIN_FIXTURE_EXTENSION,FIXTURE_PROVIDER,CALCULATION_CRITERIA_VERSION,DOCUMENT_CRITERIA_VERSION,createFixtureWorkspace,writeCalculationCandidate,independentlyVerifyCalculation,writeDocumentSummaryCandidate,independentlyVerifyDocumentSummary,evaluateCalculationImprovement,chooseFixtureVariant,sealArtifact,assertFixtureCapability} from './execution.ts';
import type {FixtureWorkspace,FixtureVerification,Artifact as FixtureArtifact} from './execution.ts';
export const FIXTURE_ACTORS: readonly Actor[] = [
 {id:'local-owner',roles:['owner']}, {id:'representative',roles:['representative']},
 {id:'specialist',roles:['executor']},{id:'assurance',roles:['verifier']},{id:'growth-evaluator',roles:['evaluator']}
];
function asFixtureArtifact(artifact:Artifact):FixtureArtifact {
 if(artifact.kind!=='code'&&artifact.kind!=='document')throw new Error('Unsupported fixture artifact kind');
 return {...artifact,kind:artifact.kind};
}
const model={provider:FIXTURE_PROVIDER.providerId,model:FIXTURE_PROVIDER.modelId,configVersion:FIXTURE_PROVIDER.configurationVersion,reason:FIXTURE_PROVIDER.selectionReason,evidenceClass:'fixture' as const};
export class FixtureWorkflow {
 readonly app:Application; readonly missionId:string; readonly root:string;
 constructor(store:Store<Mission>,root:string,missionId:string){this.app=new Application(store,FIXTURE_ACTORS);this.root=root;this.missionId=missionId;}
 async send(command:Command,actorId='local-owner') {
  const snapshot=await this.app.store.load(this.missionId); if(!snapshot)throw new Error('Missing Mission');
  const result=await this.app.dispatch({missionId:this.missionId,commandId:randomUUID(),expectedRevision:snapshot.revision,actorId,command});
  if(result.status==='conflict')throw new Error('Concurrent modification; refresh and explicitly resume');
  return result.value;
 }
 async create(oracle=CALCULATION_CRITERIA_VERSION) {
  const result=await this.app.create({id:this.missionId,purpose:'Finish a bounded task and retain trustworthy evidence',scope:'controlled-fixture',constraints:['No network or private inputs','Only built-in controlled artifacts','Independent oracle required'],criteria:{version:1,description:oracle===CALCULATION_CRITERIA_VERSION?'Correct integer-cent totals for independently owned edge cases':'Faithful facts from the pinned source document',oracle}},'local-owner',`${this.missionId}:create`);
  if(result.status==='conflict')throw new Error('Mission identity already used with different content');
 }
 async admit(workId:string,title:string) {
  await this.send({type:'admit-work',workId,title,budget:0});
  await this.send({type:'delegate',workId,taskId:`${workId}:specialist`,parentId:`${workId}:root`},'representative');
  for(const assignment of [
   {id:`${workId}:parent`,actorId:'specialist',role:'executor' as const,taskId:`${workId}:root`},
   {id:`${workId}:author`,actorId:'specialist',role:'executor' as const,taskId:`${workId}:specialist`},
   {id:`${workId}:assurance`,actorId:'assurance',role:'verifier' as const,taskId:`${workId}:root`}
  ])await this.send({type:'assign',workId,assignment:{...assignment,model,extensionVersion:`${BUILTIN_FIXTURE_EXTENSION.id}@${BUILTIN_FIXTURE_EXTENSION.version}`}},'representative');
 }
 async work(workId:string):Promise<Work>{const state=await this.app.store.load(this.missionId);const w=state?.value.works.find(w=>w.id===workId);if(!w)throw new Error('Unknown Work');return w;}
 async execute(workId:string,variant:'wrong'|'correct',kind:'calculation'|'document'='calculation'):Promise<{workspace:FixtureWorkspace;artifact:Artifact}> {
  const assigned=(await this.work(workId)).assignments.find(a=>a.id===`${workId}:author`)!;
  assertFixtureCapability({...assigned.model,extensionVersion:assigned.extensionVersion,capability:kind==='calculation'?'controlled-code-candidate':'controlled-document-summary'});
  const effectId=randomUUID();
  await this.send({type:'admit-effect',workId,effect:{id:effectId,taskId:`${workId}:specialist`,status:'pending',target:`${workId}/${kind}`,authority:`${BUILTIN_FIXTURE_EXTENSION.id}@${BUILTIN_FIXTURE_EXTENSION.version}`},reserve:0},'specialist');
  let workspace:FixtureWorkspace;let artifact:Artifact;
  try{
   workspace=await createFixtureWorkspace(this.root,workId);
   artifact=kind==='calculation'?await writeCalculationCandidate(workspace,variant):await writeDocumentSummaryCandidate(workspace,variant);
  }catch(error){
   await this.send({type:'receipt',workId,effectId,outcome:'unknown',receipt:'Execution raised before a durable receipt; inspect workspace before explicit reconciliation',usage:null},'specialist');
   throw error;
  }
  // A store error here remains an admitted but unresolved effect. Never replay it automatically.
  await this.send({type:'receipt',workId,effectId,outcome:'succeeded',receipt:`Artifact ${artifact.id}@${artifact.version}, sha256:${artifact.sha256}`,usage:0},'specialist');
  await this.send({type:'publish-artifact',workId,artifact},'specialist');
  await this.send({type:'settle-task',workId,taskId:`${workId}:specialist`,result:`Produced ${artifact.id}@${artifact.version}`},'specialist');
  await this.send({type:'settle-task',workId,taskId:`${workId}:root`,result:`Consumed specialist result ${artifact.sha256}`},'specialist');
  return {workspace,artifact};
 }
 async markInterruptedEffectsUnknown(workId:string) {
  // Explicit recovery only after the host has established no prior owner is running.
  // It records uncertainty; it neither infers success nor retries the side effect.
  const work=await this.work(workId);
  for(const effect of work.effects.filter(e=>e.status==='pending'))await this.send({type:'receipt',workId,effectId:effect.id,outcome:'unknown',receipt:'Interrupted host: outcome requires workspace readback and explicit owner reconciliation',usage:null},'specialist');
 }

 async verify(workId:string,workspace:FixtureWorkspace,kind:'calculation'|'document'='calculation'):Promise<FixtureVerification> {
  const w=await this.work(workId);if(!w.artifact)throw new Error('No artifact');
  const assigned=w.assignments.find(a=>a.id===`${workId}:assurance`)!;
  assertFixtureCapability({...assigned.model,extensionVersion:assigned.extensionVersion,capability:kind==='calculation'?'controlled-code-verification':'controlled-document-verification'});
  const check=kind==='calculation'?await independentlyVerifyCalculation(workspace,asFixtureArtifact(w.artifact),w.criteria.oracle):await independentlyVerifyDocumentSummary(workspace,asFixtureArtifact(w.artifact),w.criteria.oracle);
  await this.send({type:'verify',workId,verdict:{id:randomUUID(),verifierAssignmentId:`${workId}:assurance`,artifactSha256:w.artifact.sha256,artifactVersion:w.artifact.version,criteriaVersion:w.criteria.version,status:check.verdict,evidence:check.evidence.map(detail=>({kind:'independent-oracle',detail,source:check.process?.oracleSha256??w.criteria.oracle}))}},'assurance');
  return check;
 }
 async verifyAcceptedForMeasurement(workId:string,workspace:FixtureWorkspace):Promise<number> {
  const w=await this.work(workId);if(!w.artifact||w.acceptance!=='accepted')throw new Error('No accepted candidate');
  const check=await independentlyVerifyCalculation(workspace,asFixtureArtifact(w.artifact),w.criteria.oracle);
  if(check.verdict!=='passed'||!check.process)throw new Error('Measurement oracle failed');
  const report=JSON.parse(check.process.stdout) as {results:{passed:boolean}[]};
  return report.results.filter(result=>result.passed).length;
 }

 async accept(workId:string,workspace:FixtureWorkspace,kind:'calculation'|'document'='calculation') {
  // Re-read and re-verify exact on-disk content immediately before Records acceptance.
  const check=await this.verify(workId,workspace,kind);if(check.verdict!=='passed')throw new Error('Current artifact does not pass independent assurance');
  const current=await this.work(workId);const snapshot=await sealArtifact(workspace,asFixtureArtifact(current.artifact!));
  return this.send({type:'accept',workId,recordId:randomUUID(),artifactSnapshot:snapshot},'representative');
 }
}
export async function runCalculationScenario(store:Store<Mission>,root:string,missionId=`mission-${randomUUID()}`) {
 const flow=new FixtureWorkflow(store,root,missionId);await flow.create();
 await flow.send({type:'save-memory',memory:{id:'rounding',version:1,scope:'controlled-fixture',authority:'explicit',content:'Check totals',source:'Controlled fixture user instruction',effective:true}});
 const workId=`work-${randomUUID()}`;await flow.admit(workId,'Repair order total');
 const wrong=await flow.execute(workId,'wrong');const first=await flow.verify(workId,wrong.workspace);
 if(first.verdict!=='failed')throw new Error('Controlled wrong candidate did not fail');
 await flow.send({type:'revise-work',workId},'representative');
 const corrected=await flow.execute(workId,'correct');await flow.accept(workId,corrected.workspace);
 const snapshot=await store.load(missionId);return {missionId,workId,snapshot,firstVerdict:first.verdict,evidenceClass:'fixture',realProvider:false};
}
export async function runDocumentScenario(store:Store<Mission>,root:string,missionId=`document-${randomUUID()}`) {
 const flow=new FixtureWorkflow(store,root,missionId);await flow.create(DOCUMENT_CRITERIA_VERSION);
 const workId=`work-${randomUUID()}`;await flow.admit(workId,'Extract source-backed document facts');const produced=await flow.execute(workId,'correct','document');await flow.accept(workId,produced.workspace,'document');
 return {missionId,workId,snapshot:await store.load(missionId),evidenceClass:'fixture',realProvider:false};
}

export async function runGrowthScenario(store:Store<Mission>,root:string,missionId=`growth-${randomUUID()}`) {
 const first=await runCalculationScenario(store,root,missionId);
 const flow=new FixtureWorkflow(store,root,missionId);
 await flow.send({type:'save-memory',memory:{id:'rounding',version:2,scope:'controlled-fixture',authority:'learned',content:'Round aggregate once',source:`Accepted fixture Record from ${first.workId}`,effective:false}},'representative');
 await flow.send({type:'propose-growth',proposal:{id:'rounding-growth',proposer:'representative',target:'memory',baseline:'rounding@1',candidate:'rounding@2',counterevidence:'Per-item legal or tax rounding rules may differ; applicable only to this controlled order-total fixture',status:'proposed'}},'representative');
 const evaluation=await evaluateCalculationImprovement();
 await flow.send({type:'evaluate-growth',growthId:'rounding-growth',baseline:evaluation.baseline,candidate:evaluation.candidate,heldOut:JSON.stringify({id:evaluation.heldOut,evidence:evaluation.evidence})},'growth-evaluator');
 await flow.send({type:'adopt-growth',growthId:'rounding-growth'});
 const secondId=`work-${randomUUID()}`;await flow.admit(secondId,'Apply evaluated rounding memory');
 const admitted=await flow.work(secondId);const current=(await store.load(missionId))!.value;
 const contents=current.memories.filter(m=>admitted.appliedMemoryVersions.includes(`${m.id}@${m.version}`)).map(m=>m.content);
 const output=await flow.execute(secondId,chooseFixtureVariant(contents));await flow.accept(secondId,output.workspace);
 const verified=await flow.verifyAcceptedForMeasurement(secondId,output.workspace);
 await flow.send({type:'observe-growth',growthId:'rounding-growth',workId:secondId,metric:verified},'growth-evaluator');
 await flow.send({type:'revert-growth',growthId:'rounding-growth'});
 const afterRevert=`work-${randomUUID()}`;await flow.admit(afterRevert,'Confirm reverted memory binding');
 return {missionId,workA:first.workId,workB:secondId,afterRevert,evaluation,snapshot:await store.load(missionId),evidenceClass:'fixture',realProvider:false};
}
