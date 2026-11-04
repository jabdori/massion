import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,createMission,affectedBy,hash} from '../src/domain.ts';
import type {Mission,Command,Actor,Assignment} from '../src/domain.ts';
const owner:Actor={id:'user',roles:['owner']};
const rep:Actor={id:'representative',roles:['representative']};
const exec:Actor={id:'specialist',roles:['executor']};
const verifier:Actor={id:'assurance',roles:['verifier']};
const evaluator:Actor={id:'growth-evaluator',roles:['evaluator']};
const model={provider:'fixture',model:'controlled-v1',configVersion:'1',reason:'Deterministic acceptance fixture, not model competence',evidenceClass:'fixture' as const};
const artifact={id:'calculation',version:1,sha256:'a'.repeat(64),path:'calculation.mjs',kind:'code'};
function fresh():Mission {return createMission({id:'m',purpose:'Reliable calculation',scope:'sample',constraints:['No network'],criteria:{version:1,description:'Pass held-out oracle',oracle:'calculation-total/v1'}},owner);}
function command(m:Mission,c:Command,a=owner):Mission{return apply(m,c,a).value;}
function assigned():Mission {
 let m=command(fresh(),{type:'admit-work',workId:'a',title:'Fix total',budget:2});
 for(const [id,actorId,role] of [['author','specialist','executor'],['check','assurance','verifier']] as const) m=command(m,{type:'assign',workId:'a',assignment:{id,actorId,role,taskId:'a:root',model,extensionVersion:'builtin@1'}},rep);
 return m;
}
function ready():Mission {
 let m=assigned(); m=command(m,{type:'admit-effect',workId:'a',effect:{id:'write',taskId:'a:root',status:'pending',target:'calculation.mjs',authority:'builtin@1'},reserve:1},exec);
 m=command(m,{type:'receipt',workId:'a',effectId:'write',outcome:'succeeded',receipt:'sha256:'+artifact.sha256,usage:0},exec);
 m=command(m,{type:'publish-artifact',workId:'a',artifact},exec);
 m=command(m,{type:'settle-task',workId:'a',taskId:'a:root',result:'Candidate written'},exec);
 return m;
}
function checked():Mission {return command(ready(),{type:'verify',workId:'a',verdict:{id:'v',verifierAssignmentId:'check',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:1,status:'passed',evidence:[{kind:'oracle',detail:'Independent cases passed',source:'oracle-v1'}]}},verifier);}
function accepted():Mission {return command(checked(),{type:'accept',workId:'a',recordId:'record-a'},rep);}

test('Mission revision is prospective; admitted criteria stay pinned',()=>{
 let m=assigned(); m=command(m,{type:'revise-mission',purpose:'New goal',criteria:{version:2,description:'New oracle',oracle:'next'}});
 assert.equal(m.works[0]?.criteria.version,1); assert.equal(m.version,2);
 m=command(m,{type:'admit-work',workId:'b',title:'New Work',budget:0}); assert.equal(m.works[1]?.criteria.version,2);
});
test('execution completion is not independent pass or Records acceptance',()=>{
 const m=ready(); assert.equal(m.works[0]?.execution,'settled'); assert.equal(m.works[0]?.acceptance,'pending');
 assert.throws(()=>command(m,{type:'accept',workId:'a',recordId:'r'},rep),/Independent pass/);
 const done=accepted(); assert.equal(done.works[0]?.acceptance,'accepted'); const record=done.works[0]!.record!;
 const {checksum,...bundle}=record; assert.equal(hash(bundle),checksum); assert.equal(record.evidenceClass,'fixture');
 assert.throws(()=>command(done,{type:'publish-artifact',workId:'a',artifact:{...artifact,version:2}},exec),/no longer/);
});
test('self-verification and unknown assignment are denied without partial writes',()=>{
 const m=ready(); const original=structuredClone(m);
 assert.throws(()=>command(m,{type:'assign',workId:'a',assignment:{id:'fake',actorId:'specialist',role:'verifier',taskId:'a:root',model,extensionVersion:'builtin@1'}},rep),/independent/);
 assert.throws(()=>command(m,{type:'verify',workId:'a',verdict:{id:'fake',verifierAssignmentId:'check',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:1,status:'passed',evidence:[]}},exec),/role/);
 assert.deepEqual(m,original);
});
test('new artifact invalidates old verification and prevents stale acceptance',()=>{
 let m=checked(); m=command(m,{type:'publish-artifact',workId:'a',artifact:{...artifact,version:2,sha256:'b'.repeat(64)}},exec);
 assert.equal(m.works[0]?.acceptance,'stale'); assert.throws(()=>command(m,{type:'accept',workId:'a',recordId:'r'},rep),/Stale/);
});
test('unknown effect blocks replay and requires evidence-bearing explicit resolution',()=>{
 let m=assigned(); const effect={id:'write',taskId:'a:root',status:'pending' as const,target:'output',authority:'builtin@1'};
 m=command(m,{type:'admit-effect',workId:'a',effect,reserve:1},exec);
 m=command(m,{type:'receipt',workId:'a',effectId:'write',outcome:'unknown',receipt:'Host crashed before receipt',usage:null},exec);
 assert.equal(m.works[0]?.execution,'blocked'); assert.equal(m.works[0]?.budget.measured,null);
 assert.throws(()=>command(m,{type:'admit-effect',workId:'a',effect:{...effect,id:'retry'},reserve:0},exec),/requires reconciliation/);
 assert.throws(()=>command(m,{type:'settle-task',workId:'a',taskId:'a:root',result:'done'},exec),/unsettled/);
 m=command(m,{type:'reconcile-effect',workId:'a',effectId:'write',outcome:'succeeded',receipt:'Readback matches intended hash'});
 assert.equal(m.works[0]?.effects[0]?.status,'succeeded');
});
test('cancel stops admission but does not lose an in-flight receipt',()=>{
 let m=assigned(); const effect={id:'write',taskId:'a:root',status:'pending' as const,target:'output',authority:'builtin@1'};
 m=command(m,{type:'admit-effect',workId:'a',effect,reserve:1},exec); m=command(m,{type:'cancel',workId:'a'});
 assert.throws(()=>command(m,{type:'admit-effect',workId:'a',effect:{...effect,id:'new'},reserve:0},exec),/no longer/);
 m=command(m,{type:'receipt',workId:'a',effectId:'write',outcome:'succeeded',receipt:'Actual completed write',usage:0},exec);
 assert.equal(m.works[0]?.execution,'cancelled'); assert.equal(m.works[0]?.effects[0]?.status,'succeeded');
});
test('delegation requires child settlement, assignment and parent consumption',()=>{
 let m=assigned(); m=command(m,{type:'delegate',workId:'a',taskId:'child',parentId:'a:root'},rep);
 assert.throws(()=>command(m,{type:'settle-task',workId:'a',taskId:'a:root',result:'done'},exec),/Child result/);
 m=command(m,{type:'assign',workId:'a',assignment:{id:'child-author',actorId:'specialist',role:'executor',taskId:'child',model,extensionVersion:'builtin@1'}},rep);
 m=command(m,{type:'settle-task',workId:'a',taskId:'child',result:'Investigation found rounding defect'},exec);
 m=command(m,{type:'settle-task',workId:'a',taskId:'a:root',result:'Consumed investigation result'},exec);
 assert.equal(m.works[0]?.execution,'settled');
});
test('budget enforces configured reservation; no fake zero for unknown usage',()=>{
 const m=assigned(); assert.throws(()=>command(m,{type:'admit-effect',workId:'a',effect:{id:'over',taskId:'a:root',status:'pending',target:'x',authority:'builtin'},reserve:3},exec),/Budget exhausted/);
});
test('memory authority, evaluated adoption and revert preserve historical pins',()=>{
 let m=fresh(); m=command(m,{type:'save-memory',memory:{id:'rounding',version:1,scope:'sample',authority:'explicit',content:'Check totals',source:'user instruction',effective:true}});
 m=command(m,{type:'save-memory',memory:{id:'rounding',version:2,scope:'sample',authority:'learned',content:'Round aggregate once',source:'accepted record',effective:false}},rep);
 assert.throws(()=>command(m,{type:'save-memory',memory:{id:'bad',version:1,scope:'sample',authority:'learned',content:'Trust me',source:'inference',effective:true}},rep),/evaluated adoption/);
 m=command(m,{type:'propose-growth',proposal:{id:'g',proposer:rep.id,target:'memory',baseline:'rounding@1',candidate:'rounding@2',counterevidence:'Does not apply to jurisdiction-specific per-item rounding',status:'proposed'}},rep);
 m=command(m,{type:'evaluate-growth',growthId:'g',baseline:1,candidate:3,heldOut:'rounding-oracle-heldout.json'},evaluator);
 m=command(m,{type:'adopt-growth',growthId:'g'});
 m=command(m,{type:'admit-work',workId:'b',title:'Apply learning',budget:0}); assert.deepEqual(m.works[0]?.appliedMemoryVersions,['rounding@2']);
 m=command(m,{type:'revert-growth',growthId:'g'});
 m=command(m,{type:'admit-work',workId:'c',title:'Baseline restored',budget:0}); assert.deepEqual(m.works[1]?.appliedMemoryVersions,['rounding@1']); assert.deepEqual(m.works[0]?.appliedMemoryVersions,['rounding@2']);
});
test('typed versioned multi-hop relationships find only matching impacted evidence',()=>{
 let m=fresh(); for(const [from,to] of [['file','function'],['verdict','file'],['record','verdict']]) m=command(m,{type:'relate',relation:{from:from!,to:to!,type:'evidenced-by',fromVersion:1,toVersion:1,provenance:'oracle run',inferred:false}},rep);
 assert.deepEqual(affectedBy(m,'function',1),['file@1','record@1','verdict@1']); assert.deepEqual(affectedBy(m,'function',2),[]);
});
test('a different task executor cannot settle another task effect',()=>{
 let m=assigned();m=command(m,{type:'delegate',workId:'a',taskId:'other',parentId:'a:root'},rep);m=command(m,{type:'assign',workId:'a',assignment:{id:'other-author',actorId:'other-author',role:'executor',taskId:'other',model,extensionVersion:'builtin@1'}},rep);
 m=command(m,{type:'admit-effect',workId:'a',effect:{id:'write',taskId:'a:root',status:'pending',target:'output',authority:'builtin@1'},reserve:0},exec);
 assert.throws(()=>command(m,{type:'receipt',workId:'a',effectId:'write',outcome:'succeeded',receipt:'Forged',usage:0},{id:'other-author',roles:['executor']}),/effect task/);
});
test('new attempt clears current task result and retains previous attempt history',()=>{
 let m=ready();m=command(m,{type:'verify',workId:'a',verdict:{id:'failed',verifierAssignmentId:'check',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:1,status:'failed',evidence:[{kind:'oracle',detail:'Failed',source:'oracle'}]}},verifier);
 m=command(m,{type:'revise-work',workId:'a'},rep);assert.equal(m.works[0]?.tasks[0]?.result,undefined);assert.equal(m.works[0]?.attempts[0]?.results?.[0]?.result,'Candidate written');
});
test('explicit memory update leaves only one effective version',()=>{
 let m=fresh();for(const version of [1,2])m=command(m,{type:'save-memory',memory:{id:'m',version,scope:'sample',authority:'explicit',content:'User revision',source:'user',effective:true}});
 assert.deepEqual(m.memories.filter(x=>x.effective).map(x=>x.version),[2]);
});
