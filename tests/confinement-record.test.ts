import test from 'node:test';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {realpathSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProductService} from '../src/product.ts';
import {FixtureWorkflow,measurementObservation,runCalculationScenario} from '../src/scenario.ts';
import {CALCULATION_CRITERIA_VERSION,wasConfined} from '../src/execution.ts';
import {validateMissionLineage,validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {exportPortableBackup,parsePortableBackup,restorePortableBackup} from '../src/portable-backup.ts';
import {growthStore,growthJournal,seedGrowth} from './support/growth-fixture.ts';
import {orders} from './support/growth-proposal-fixture.ts';
import {InMemoryStore,SurrealStore} from '../src/storage.ts';
import type {PortableJournal,Store} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import type {Mission} from '../src/domain.ts';

const darwin=process.platform==='darwin';

test('an evaluation record written by origin/main loads and reads as not confined',async()=>{
 const {store}=await growthStore(false);
 const seeded=await seedGrowth(store);
 const mission=(await store.load(seeded.id))!;
 const evaluated=mission.value.growth.find(g=>g.id==='g')!;
 assert.equal(evaluated.status,'evaluated');
 assert.equal(Object.hasOwn(evaluated.scores!,'confined'),false,'the origin/main record carries no confinement field');
 assert.equal(wasConfined(evaluated.scores),false,'absence reads as not confined');
 validateMissionLineage(mission.value);
 validateMissionJournalLineage(await growthJournal(store));
});

test('a real evaluation records the platform confinement and keeps it through save and restore',async t=>{
 const expected=darwin;
 const baseline='rounding@4',candidate='rounding@5';
 const evaluate=async(product:ProductService,id:string,revision:number,growthId:string)=>{
  await product.proposeGrowth(id,{commandId:'propose-'+growthId,expectedRevision:revision,growthId,baseline,candidate:{id:'rounding',version:5,content:'Round aggregate once',source:'Fixture candidate source'},counterevidence:'Fixture counterexample'});
  return product.evaluateGrowth(id,{commandId:'evaluate-'+growthId,expectedRevision:revision+1,growthId,baseline,candidate,oracle:'rounding-calculation/v1',cases:structuredClone(orders)});
 };
 const read=(mission:Mission,growthId:string)=>mission.growth.find(g=>g.id===growthId)!.scores;
 const {store}=await growthStore(false),seeded=await seedGrowth(store);
 await seeded.send({type:'save-memory',memory:{id:'rounding',version:4,scope:'controlled-fixture',authority:'explicit',content:'Round each line',source:'Owner fixture source',effective:true}});
 assert.equal((await evaluate(seeded.product,seeded.id,(await store.load(seeded.id))!.revision,'g2')).status,'committed');
 const stored=(await store.load(seeded.id))!;
 assert.equal(wasConfined(read(stored.value,'g2')),expected,'the stored evaluation records whether the OS sandbox walled the run');
 const saved=JSON.parse(JSON.stringify(stored.value)) as Mission;
 validateMissionLineage(saved);
 assert.equal(wasConfined(read(saved,'g2')),expected,'the fact survives the save/load round trip through the restore validator');
 validateMissionJournalLineage(await growthJournal(store));
 assert.equal((await seeded.product.evaluateGrowth(seeded.id,{commandId:'evaluate-g2',expectedRevision:(await store.load(seeded.id))!.revision-1,growthId:'g2',baseline,candidate,oracle:'rounding-calculation/v1',cases:structuredClone(orders)})).status,'replayed');
 if(!process.env.SURREAL_TEST_RUNTIME)return;
 const durable=await growthStore(true),durableSeeded=await seedGrowth(durable.store);
 await durableSeeded.send({type:'save-memory',memory:{id:'rounding',version:4,scope:'controlled-fixture',authority:'explicit',content:'Round each line',source:'Owner fixture source',effective:true}});
 assert.equal((await evaluate(durableSeeded.product,durableSeeded.id,(await durable.store.load(durableSeeded.id))!.revision,'g2')).status,'committed');
 const artifacts=new TextArtifactStore(await mkdtemp(join(realpathSync(tmpdir()),'massion-confinement-artifacts-')));
 const serialized=await exportPortableBackup(durable.store as SurrealStore<Mission>,artifacts);
 const target=await growthStore(true);
 await restorePortableBackup(serialized,target.store as SurrealStore<Mission>,await mkdtemp(join(realpathSync(tmpdir()),'massion-confinement-restored-')));
 assert.equal(wasConfined(read((await target.store.load(durableSeeded.id))!.value,'g2')),expected,'the fact survives a portable backup restore');
 t.after(()=>rm(artifacts.root,{recursive:true,force:true}));
});

test('fixture verification records confinement on the verdict, its evidence and the accepted record',async t=>{
 const root=await mkdtemp(join(realpathSync(tmpdir()),'massion-confinement-record-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>();
 const scenario=await runCalculationScenario(store,root,'mission-confinement');
 const mission=(await store.load(scenario.missionId))!;
 const work=mission.value.works.find(w=>w.id===scenario.workId)!;
 const expected=darwin;
 assert.equal(wasConfined(work.verdict),expected);
 assert.equal(wasConfined(work.verdict!.evidence.find(e=>e.kind==='independent-oracle')),expected);
 assert.equal(wasConfined(work.record?.verdict),expected);
 // The portable-lineage validators only accept sealed text artifacts, so the calculation-fixture mission is checked through its stored state here; the load path is covered by the two tests above.
});

test('a measurement made without the wall after a confined verdict is stored as not confined',{skip:darwin&&'this host always confines the oracle (fail closed); the unconfined measurement runs on Linux CI'},async t=>{
 const root=await mkdtemp(join(realpathSync(tmpdir()),'massion-measurement-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>();
 const flow=new FixtureWorkflow(store,root,'mission-measure');
 await flow.create();
 await flow.send({type:'save-memory',memory:{id:'rounding',version:1,scope:'controlled-fixture',authority:'explicit',content:'Round each line',source:'Owner fixture source',effective:true}});
 await flow.send({type:'save-memory',memory:{id:'rounding',version:2,scope:'controlled-fixture',authority:'learned',content:'Round aggregate once',source:'Fixture candidate source',effective:false}},'representative');
 await flow.send({type:'propose-growth',proposal:{id:'g',proposer:'representative',target:'memory',baseline:'rounding@1',candidate:'rounding@2',counterevidence:'Fixture counterexample',status:'proposed'}},'representative');
 await flow.send({type:'evaluate-growth',growthId:'g',baseline:1,candidate:2,heldOut:'Fixture evaluation evidence'},'growth-evaluator');
 await flow.send({type:'adopt-growth',growthId:'g'});
 await flow.admit('measure','Measurement under the candidate');
 const produced=await flow.execute('measure','correct');
 // A verdict authored as confined (a stored confined check, however produced) on the same accepted Work.
 const candidate=await flow.work('measure');
 await flow.send({type:'verify',workId:'measure',verdict:{id:'fixture-verdict',verifierAssignmentId:'measure:assurance',artifactSha256:candidate.artifact!.sha256,artifactVersion:candidate.artifact!.version,criteriaVersion:candidate.criteria.version,status:'passed',confined:true,evidence:[{kind:'independent-oracle',detail:'Authored confined verdict',source:'fixture'}]}},'assurance');
 await flow.send({type:'accept',workId:'measure',recordId:'measure-record'},'representative');
 // The separate measurement oracle runs for real (without the wall here) on the same Work and the observation must carry its own value.
 const measurement=await flow.verifyAcceptedForMeasurement('measure',produced.workspace);
 assert.equal(measurement.confined,false);
 assert.equal(measurement.count,8,'the correct candidate passes every held case');
 await flow.send(measurementObservation('g','measure',measurement),'growth-evaluator');
 const mission=(await store.load('mission-measure'))!.value,growth=mission.growth.find(g=>g.id==='g')!,work=mission.works.find(w=>w.id==='measure')!;
 assert.equal(growth.observation!.metric,measurement.count);
 assert.equal(growth.observation!.confined,false,'the stored observation explicitly records confined: false');
 assert.equal(wasConfined(growth.observation),false);
 assert.equal(work.verdict!.confined,true,'the stored verdict says confined');
 // Whole-history lineage validation and portable backup are not called here because calculation Work produces a code artifact (src/execution.ts:377) while portable lineage accepts only sealed text artifacts (src/backup-lineage.ts:94, existing origin/main behaviour); that backup path is tested next.
});

test('an observation whose confinement differs from the verdict survives lineage validation, export, parse and restore',{skip:darwin&&'this host always confines the oracle (fail closed); the unconfined measurement runs on Linux CI'},async t=>{
 // The measurement here is taken from another Work only because a calculation Work cannot be backed up (src/execution.ts:377, src/backup-lineage.ts:94); production (src/scenario.ts:123-124) never attaches one Work's measurement to another.
 const oracleRoot=await mkdtemp(join(realpathSync(tmpdir()),'massion-measurement-oracle-'));
 t.after(()=>rm(oracleRoot,{recursive:true,force:true}));
 const oracleFlow=new FixtureWorkflow(new InMemoryStore<Mission>(),oracleRoot,'mission-oracle');
 await oracleFlow.create();
 await oracleFlow.admit('oracle-work','Run real unconfined measurement oracle');
 const oracleProduced=await oracleFlow.execute('oracle-work','correct');
 await oracleFlow.accept('oracle-work',oracleProduced.workspace);
 const measurement=await oracleFlow.verifyAcceptedForMeasurement('oracle-work',oracleProduced.workspace);
 assert.equal(measurement.confined,false);
 assert.equal(measurement.count,8,'the correct candidate passes every held case');

 const runFlow=async(store:Store<Mission>,missionId:string,artifactsRoot:string)=>{
  const root=await mkdtemp(join(realpathSync(tmpdir()),'massion-measurement-backup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const artifacts=new TextArtifactStore(artifactsRoot);
  t.after(()=>rm(artifactsRoot,{recursive:true,force:true}));
  const flow=new FixtureWorkflow(store,root,missionId);
  await flow.create();
  await flow.send({type:'save-memory',memory:{id:'rounding',version:1,scope:'controlled-fixture',authority:'explicit',content:'Round each line',source:'Owner fixture source',effective:true}});
  await flow.send({type:'save-memory',memory:{id:'rounding',version:2,scope:'controlled-fixture',authority:'learned',content:'Round aggregate once',source:'Fixture candidate source',effective:false}},'representative');
  await flow.send({type:'propose-growth',proposal:{id:'g',proposer:'representative',target:'memory',baseline:'rounding@1',candidate:'rounding@2',counterevidence:'Fixture counterexample',status:'proposed'}},'representative');
  await flow.send({type:'evaluate-growth',growthId:'g',baseline:1,candidate:2,heldOut:'Fixture evaluation evidence'},'growth-evaluator');
  await flow.send({type:'adopt-growth',growthId:'g'});
  await flow.admit('measure','Measurement under the candidate');
  // Portable lineage and backup only accept sealed text artifacts (src/backup-lineage.ts:94), so build the backed-up Work with a text artifact.
  await flow.send({type:'admit-effect',workId:'measure',effect:{id:'measure-effect',taskId:'measure:specialist',status:'pending',target:'measure/text',authority:'fixture'},reserve:0},'specialist');
  const artifact=await artifacts.write('measure',1,'Measured candidate artifact.\n');
  await flow.send({type:'receipt',workId:'measure',effectId:'measure-effect',outcome:'succeeded',receipt:`Artifact ${artifact.id}@${artifact.version}, sha256:${artifact.sha256}`,usage:0},'specialist');
  await flow.send({type:'publish-artifact',workId:'measure',artifact},'specialist');
  await flow.send({type:'settle-task',workId:'measure',taskId:'measure:specialist',result:`Produced ${artifact.id}@${artifact.version}`},'specialist');
  await flow.send({type:'settle-task',workId:'measure',taskId:'measure:root',result:`Consumed specialist result ${artifact.sha256}`},'specialist');
  // A verdict authored as confined (a stored confined check, however produced) on the same accepted Work.
  await flow.send({type:'verify',workId:'measure',verdict:{id:'fixture-verdict',verifierAssignmentId:'measure:assurance',artifactSha256:artifact.sha256,artifactVersion:artifact.version,criteriaVersion:1,status:'passed',confined:true,evidence:[{kind:'independent-oracle',detail:'Authored confined verdict',source:'fixture',confined:true}]}},'assurance');
  await flow.send({type:'accept',workId:'measure',recordId:'measure-record',artifactSnapshot:await artifacts.snapshot(artifact)},'representative');
  await flow.send(measurementObservation('g','measure',measurement),'growth-evaluator');
  const mission=(await store.load(missionId))!.value,growth=mission.growth.find(g=>g.id==='g')!,work=mission.works.find(w=>w.id==='measure')!;
  return {artifacts,growth,work};
 };

 const store=new InMemoryStore<Mission>();
 const memArtifactsRoot=await mkdtemp(join(realpathSync(tmpdir()),'massion-observation-artifacts-'));
 const result=await runFlow(store,'mission-measure',memArtifactsRoot);
 assert.equal(result.growth.observation!.metric,measurement.count);
 assert.equal(result.growth.observation!.confined,false,'the stored observation explicitly records confined: false');
 assert.equal(wasConfined(result.growth.observation),false);
 assert.equal(result.work.verdict!.confined,true,'the stored verdict says confined');
 // The new field must pass the work-history lineage validation that portable backup export and restore run.
 const operations=await growthJournal(store);
 validateMissionJournalLineage(operations);
 const journal:PortableJournal<Mission>={schemaVersion:2,head:operations.length,operations:[...operations]};
 const memSerialized=await exportPortableBackup({exportJournal:async()=>journal},result.artifacts);
 const parsed=parsePortableBackup(memSerialized);
 const parsedObservation=parsed.journal.operations.at(-1)!.value.growth.find(g=>g.id==='g')!.observation!;
 assert.equal(parsedObservation.metric,measurement.count);
 assert.equal(parsedObservation.confined,false,'the parsed observation explicitly records confined: false');
 assert.equal(wasConfined(parsedObservation),false);
 const memRestoredParent=await mkdtemp(join(realpathSync(tmpdir()),'massion-observation-restored-'));
 t.after(()=>rm(memRestoredParent,{recursive:true,force:true}));
 const memRestored=new InMemoryStore<Mission>();
 await restorePortableBackup(memSerialized,{exportJournal:async()=>({schemaVersion:2 as const,head:0,operations:[]}),restoreJournal:async j=>{validateMissionJournalLineage(j.operations);for(const op of j.operations)await memRestored.commit({id:op.aggregateId,expectedRevision:op.expectedRevision,commandId:op.commandId,fingerprint:op.fingerprint,value:op.value,events:op.events,outbox:op.outbox});return {status:'restored' as const,head:j.head,checksum:''};}},join(memRestoredParent,'store'));
 const memRestoredObservation=(await memRestored.load('mission-measure'))!.value.growth.find(g=>g.id==='g')!.observation!;
 assert.equal(memRestoredObservation.metric,measurement.count);
 assert.equal(memRestoredObservation.confined,false,'the restored observation explicitly records confined: false');
 assert.equal(wasConfined(memRestoredObservation),false);

 if(!process.env.SURREAL_TEST_RUNTIME)return;
 const durable=(await growthStore(true)).store;
 const durableArtifactsRoot=await mkdtemp(join(realpathSync(tmpdir()),'massion-observation-durable-artifacts-'));
 const durableResult=await runFlow(durable,'mission-measure',durableArtifactsRoot);
 const serialized=await exportPortableBackup(durable as SurrealStore<Mission>,durableResult.artifacts);
 const target=(await growthStore(true)).store;
 const durableRestoredParent=await mkdtemp(join(realpathSync(tmpdir()),'massion-observation-durable-restored-'));
 t.after(()=>rm(durableRestoredParent,{recursive:true,force:true}));
 await restorePortableBackup(serialized,target as SurrealStore<Mission>,join(durableRestoredParent,'store'));
 const durableRestoredObservation=(await target.load('mission-measure'))!.value.growth.find(g=>g.id==='g')!.observation!;
 assert.equal(durableRestoredObservation.metric,measurement.count);
 assert.equal(durableRestoredObservation.confined,false,'the observation and its confinement survive a portable backup restore');
 assert.equal(wasConfined(durableRestoredObservation),false);
});

test('the observation command cannot be built without the measurement confinement',()=>{
 assert.deepEqual(measurementObservation('g','work',{count:8,confined:false}),{type:'observe-growth',growthId:'g',workId:'work',metric:8,confined:false});
 // @ts-expect-error a bare number is not a measurement: the count cannot reach the observe-growth command without its confinement
 void measurementObservation('g','work',8);
});
