import test from 'node:test';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {realpathSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProductService} from '../src/product.ts';
import {FixtureWorkflow,runCalculationScenario} from '../src/scenario.ts';
import {CALCULATION_CRITERIA_VERSION,wasConfined} from '../src/execution.ts';
import {validateMissionLineage,validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {exportPortableBackup,restorePortableBackup} from '../src/portable-backup.ts';
import {growthStore,growthJournal,seedGrowth} from './support/growth-fixture.ts';
import {orders} from './support/growth-proposal-fixture.ts';
import {InMemoryStore,SurrealStore} from '../src/storage.ts';
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
 const store=new InMemoryStore<Mission>(),flow=new FixtureWorkflow(store,root,'mission-measure');
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
 // The separate measurement oracle runs for real (without the wall here) and the observation must carry its own value.
 const measurement=await flow.verifyAcceptedForMeasurement('measure',produced.workspace);
 assert.equal(measurement.confined,false);
 await flow.send({type:'observe-growth',growthId:'g',workId:'measure',metric:measurement.count,confined:measurement.confined},'growth-evaluator');
 const mission=(await store.load('mission-measure'))!.value,growth=mission.growth.find(g=>g.id==='g')!,work=mission.works.find(w=>w.id==='measure')!;
 assert.equal(work.verdict!.confined,true,'the stored verdict says confined');
 assert.equal(wasConfined(growth.observation),false,'the observation records the measurement, not the verdict');
 assert.equal(growth.observation!.metric,measurement.count);
 assert.equal(measurement.count,8,'the correct candidate passes every held case');
});
