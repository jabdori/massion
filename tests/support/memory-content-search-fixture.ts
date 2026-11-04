import type {TestContext} from 'node:test';
import {memoryFindFixture} from './memory-find-fixture.ts';
import {Application} from '../../src/application.ts';
import {FIXTURE_ACTORS} from '../../src/scenario.ts';
export const SEARCH_TEXT='Original',SEARCH_ID_A='  발견\r\n별도😀 A  ',SEARCH_ID_B='  발견\n별도😀 B  ';
export async function memoryContentSearchFixture(t:TestContext,durable=false,cli=false){
 const f=await memoryFindFixture(t,durable,cli,20);
 for(const [id,content,source] of [[SEARCH_ID_A,'Original extra A\r\n원문 😀','Owner A'],[SEARCH_ID_B,'Original extra B\n원문 😀','Owner B'],['Original in ID only','Different content','Owner'],['source-only','Different content','Original source only']])await f.product.saveMemory('mission',{commandId:'search-save-'+id,expectedRevision:(await f.current()).revision,memory:{id:id!,version:1,content:content!,source:source!}});
 await f.product.retireMemory('mission',{commandId:'search-retire-a',expectedRevision:(await f.current()).revision,memoryId:SEARCH_ID_A,version:1,reason:'Keep original inactive search reference'});
 const app=new Application(f.store,FIXTURE_ACTORS);await app.dispatch({missionId:'mission',commandId:'search-learned',expectedRevision:(await f.current()).revision,actorId:'representative',command:{type:'save-memory',memory:{id:f.id,version:22,authority:'learned',scope:'local',content:'Original learned match excluded',source:'Data-only test',effective:false}}});
 await f.product.saveMemory('other',{commandId:'search-other',expectedRevision:(await f.store.load('other'))!.revision,memory:{id:f.id,version:2,content:'Original cross-Mission excluded',source:'Other owner'}});
 return {...f,text:SEARCH_TEXT,chosenID:SEARCH_ID_A};
}
