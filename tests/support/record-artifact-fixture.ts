import type {TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Application} from '../../src/application.ts';
import type {Mission,Command} from '../../src/domain.ts';
import {InMemoryStore} from '../../src/storage.ts';
import type {Store} from '../../src/storage.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
/** Data-only accepted fixture; no provider call or competence claim. */
export async function textFixture(t: TestContext, store: Store<Mission> = new InMemoryStore<Mission>(), cli=false, content='Exact accepted fixture <img src=x onerror=alert(1)>\n한글 🌙\n') {
  const root = await mkdtemp(join(tmpdir(), 'massion-owned-record-text-')); t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = new TextArtifactStore(join(root,cli?'.runtime/workspaces/model-artifacts':'original'));
  const app = new Application(store, [{id:'owner',roles:['owner']},{id:'executor',roles:['executor']},{id:'verifier',roles:['verifier']}]);
  let revision = 1;
  await app.create({id:'mission',purpose:'Fixture restore evidence',scope:'local',constraints:[],criteria:{version:1,description:'Retain exact fixture bytes',oracle:'fixture-restore/v1'}},'owner','create');
  const send = async(command:Command, actorId='owner') => { await app.dispatch({missionId:'mission',commandId:`command-${revision}`,expectedRevision:revision++,actorId,command}); };
  await send({type:'admit-work',workId:'work',title:'Portable accepted fixture',budget:2});
  const model = {provider:'fixture',model:'deterministic',configVersion:'v1',reason:'Data-only backup fixture, no model invocation',evidenceClass:'fixture' as const};
  for(const role of ['executor','verifier'] as const) await send({type:'assign',workId:'work',assignment:{id:role,actorId:role,role,taskId:'work:root',model,extensionVersion:'v1'}});
  await send({type:'admit-effect',workId:'work',effect:{id:'effect',taskId:'work:root',status:'pending',target:'fixture text',authority:'local fixture'},reserve:1},'executor');
  await send({type:'receipt',workId:'work',effectId:'effect',outcome:'succeeded',receipt:'Fixture bytes prepared without a provider',usage:1},'executor');
  const artifact = await artifacts.write('work',1,content);
  await send({type:'publish-artifact',workId:'work',artifact},'executor');
  await send({type:'verify',workId:'work',verdict:{id:'verdict',verifierAssignmentId:'verifier',artifactSha256:artifact.sha256,artifactVersion:1,criteriaVersion:1,status:'passed',evidence:[{kind:'fixture',detail:'Deterministic data-only test',source:'test'}]}},'verifier');
  await send({type:'settle-task',workId:'work',taskId:'work:root',result:'Fixture settled'},'executor');
  await send({type:'accept',workId:'work',recordId:'record',artifactSnapshot:await artifacts.snapshot(artifact)});
  return {store,root,artifacts,artifact};
}
