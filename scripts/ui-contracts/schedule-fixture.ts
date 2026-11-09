import {SchedulesService} from '../../src/schedules.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {copy} from '../../src/ui-copy.ts';
import type {ScreenFixture} from './fixture-host.ts';

/** 추가 일정은 실제 생성 명령과 조회 결과를 사용합니다. 실행 결과를 만들어 넣지 않습니다. */
export async function scheduleScreenFixture(template:ScreenFixture){
 const fixture=structuredClone(template),store=new InMemoryStore<any>(),service=new SchedulesService(store,async()=>({turns:[]}),()=>fixture.now);
 for(const [kind,title,minute] of [['weekly-expenses',undefined,540],['weekly-review','경쟁사 가격',540],['price-watch','노트북 거치대 가격 보기',1080]] as const){
  await service.act({commandId:'fixture-'+kind,action:'create',kind,...title?{title}:{},request:copy('ui.schedules.'+kind+'-request'),minute,offset:540,budget:{runs:30}});
 }
 const route=fixture.routes['/assistant/schedules']!,body=route.body as {schedules:unknown[]};body.schedules.push(...(await service.read()).schedules);
 return fixture;
}
