import type {TestContext} from 'node:test';
import {Application} from '../../src/application.ts';
import {FIXTURE_ACTORS} from '../../src/scenario.ts';
import {memoryUsagePagesFixture} from './memory-usage-pages-fixture.ts';
export async function memoryFindFixture(t:TestContext,durable=false,cli=false,count=22){
 const f=await memoryUsagePagesFixture(t,durable,cli,2);
 for(let version=2;version<=count;version++)await f.product.saveMemory('mission',{commandId:'find-version-'+version,expectedRevision:(await f.current()).revision,memory:{id:f.id,version,content:'Original explicit version '+version+' <img src=x>',source:'Owner version '+version}});
 const app=new Application(f.store,FIXTURE_ACTORS);await app.dispatch({missionId:'mission',commandId:'find-learned',expectedRevision:(await f.current()).revision,actorId:'representative',command:{type:'save-memory',memory:{id:f.id,version:count+1,authority:'learned',scope:'local',content:'Learned candidate excluded from discovery',source:'Data-only test',effective:false}}});
 await f.product.saveMemory('other',{commandId:'find-other',expectedRevision:(await f.store.load('other'))!.revision,memory:{id:f.id,version:1,content:'Other Mission exact same ID',source:'Other owner'}});
 return f;
}
