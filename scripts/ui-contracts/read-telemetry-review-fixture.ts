import {resultFactsFixture} from './result-facts-fixtures.ts';
import {loadFixture} from './fixture-host.ts';
import {roomTelemetryWork} from './room-telemetry-fixtures.ts';
import {produceWork} from './regenerate-work-telemetry.ts';
import {workCardFacts} from '../../src/assistant-service.ts';
import type {Mission} from '../../src/domain.ts';

/** Every review state comes from existing domain commands, never a client-state edit. */
export async function readTelemetryReviewFixture(kind:'pending'|'acknowledged'|'created'|'skipped'){
 const notes=kind==='pending'||kind==='acknowledged',fixture=kind==='created'?resultFactsFixture(await loadFixture('B8-done',['read-telemetry-review'])):await loadFixture(notes?'B22-room':'B8-fail');
 const mission=(fixture.routes['/missions/intake']!.body as {value:Mission}).value;
 const selector=fixture.steps.flatMap(s=>s.readySelector??[]).findLast(s=>s.startsWith('#work-heading-'))!,original=mission.works.find(w=>selector==='#work-heading-'+w.id)!;
 const coding=notes?roomTelemetryWork(mission,'coding',fixture.now):undefined,proposed=kind==='pending'?coding!.proposal:undefined,produced=notes?{work:proposed?.works[0]??coding!.work,conversation:proposed?.conversations?.[0]??coding!.conversation}:produceWork(original,mission,fixture.now);
 const work=produced.work;mission.works=mission.works.map(w=>w.id===original.id?work:w);
 mission.conversations=[...(mission.conversations??[]).filter(c=>c.workId!==work.id),...(produced.conversation?[produced.conversation]:[])];
 for(const route of Object.values(fixture.routes) as any[]){const b=route.body;if(b?.snapshot?.value?.id===mission.id)b.snapshot.value=structuredClone(mission);
  for(const row of [...(b?.works??[]),...(b?.turns??[]).flatMap((t:any)=>t.work?[t.work]:[])])if(row.workId===work.id)Object.assign(row,workCardFacts(work));
  if(work.record&&b?.recordId===work.record.id)b.recordChecksum=work.record.checksum;
 }
 fixture.steps=notes?fixture.steps.slice(0,2):fixture.steps;
 return {fixture,workId:work.id};
}
