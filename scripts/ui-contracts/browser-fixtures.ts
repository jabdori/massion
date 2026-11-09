import {Application} from '../../src/application.ts';
import {BrowserSessions,browserSummary} from '../../src/browser-runtime.ts';
import type {RawBrowserPage} from '../../src/browser-runtime.ts';
import {InMemoryStore} from '../../src/storage.ts';
import type {Mission} from '../../src/domain.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import type {ScreenFixture} from './fixture-host.ts';

export const checkoutPage:RawBrowserPage={address:'https://shop.example.com/checkout',title:'주문 / 결제',blocks:['오피스몰','주문 / 결제','레이저 토너 검정','상품 금액','31,000원','배송비','3,000원','합계','34,000원'],fields:[{label:'수량',type:'number',value:'1',autocomplete:''},{label:'배송지',type:'text',value:'집 · 저장된 주소',autocomplete:'street-address'},{label:'결제 카드',type:'text',value:'4111111111111111',autocomplete:'cc-number'}]};
export async function capturePages(store:InMemoryStore<Mission>,missionId:string,workId:string,pages:RawBrowserPage[],now:number){
 let current=pages[0]!,clock=now-pages.length*60000;const service=new BrowserSessions(store,store,{adapter:{async read(){return structuredClone(current);}},clock:()=>clock});
 for(const [index,page] of pages.entries()){current=page;clock+=60000;await service.capture({missionId,workId,readId:'fixture-page:'+index,address:page.address});}
 return service;
}
export async function attachBrowserRoute(fixture:ScreenFixture,service:BrowserSessions,missionId:string,workId:string){
 const read=await service.read(missionId,workId),feedId=(fixture.routes['/events']!.body as any).feedId;
 fixture.routes['/missions/'+missionId+'/works/'+workId+'/browser']={status:200,body:{...read,feedId}};
}
export async function browserFixture(template:ScreenFixture){
 const fixture=structuredClone(template),library=fixture.screen==='B15',unknown=fixture.screen==='B5',missionId='intake',store=new InMemoryStore<Mission>();let workId:string;
 if(library||unknown){
  workId=library?'library':'toner';const app=new Application(store,[{id:'local-owner',roles:['owner']}]);
  const original=(fixture.routes['/read-state?mission=intake']!.body as any).snapshot.value;
  await app.create({id:missionId,purpose:original.purpose,scope:original.scope,constraints:original.constraints,criteria:original.criteria},'local-owner','browser-create');
  await app.dispatch({missionId,expectedRevision:1,commandId:'browser-work',actorId:'local-owner',command:{type:'admit-work',workId,title:library?'스터디룸 신청':original.works.find((w:any)=>w.id===workId).title,budget:8}});
 }else{
  const snapshot=(fixture.routes['/read-state?mission=intake']!.body as any).snapshot;workId=snapshot.value.works.find((w:any)=>w.execution==='active'&&w.acceptance==='pending').id;
  await store.commit({id:missionId,expectedRevision:0,commandId:'recorded-fixture-baseline',fingerprint:'recorded-fixture-baseline',value:structuredClone(snapshot.value),events:[],outbox:[]});
 }
 const pages:RawBrowserPage[]=library?[
  {address:'https://library.example.com/guide',title:'이용 안내',blocks:['시립도서관','이용 안내','스터디룸'],fields:[]},
  {address:'https://library.example.com/availability',title:'빈 시간',blocks:['시립도서관','빈 시간','11월 11일 (수)','15:00–17:00'],fields:[]},
  {address:'https://library.example.com/apply',title:'신청',blocks:['시립도서관','이용 안내','신청','스터디룸 신청'],fields:[{label:'이름',type:'text',value:'홍길동',autocomplete:'name'},{label:'연락처',type:'tel',value:'010-0000-0000',autocomplete:'tel'},{label:'날짜',type:'date',value:'11월 11일 (수)',autocomplete:''},{label:'시간',type:'time',value:'15:00–17:00',autocomplete:''},{label:'방',type:'select-one',value:'스터디룸 B',autocomplete:''},{label:'인원',type:'select-one',value:'4명',autocomplete:''}]}
 ]:unknown?[checkoutPage,checkoutPage,checkoutPage,checkoutPage]:[{address:'https://research.example.com/pricing',title:'요금제',blocks:['요금제 비교','공개 요금 안내'],fields:[]},{address:'https://research.example.com/plans',title:'플랜 안내',blocks:['플랜 안내','공개 이용 조건'],fields:[]}];
 const service=await capturePages(store,missionId,workId,pages,fixture.now),snapshot=(await store.load(missionId))!;if(library||unknown)validateMissionJournalLineage(store.inspect());
 const read=fixture.routes['/read-state?mission=intake']!.body as any;if(library)read.snapshot.value.works.unshift(snapshot.value.works[0]);else if(unknown)read.snapshot.value.works.find((w:any)=>w.id===workId).browserSession=snapshot.value.works[0]!.browserSession;else read.snapshot.value=snapshot.value;if(!unknown)read.snapshot.revision=snapshot.revision;
 fixture.routes['/missions/intake']={status:200,body:structuredClone(read.snapshot)};
 const works=(fixture.routes['/assistant/works']!.body as any).works;if(library)works.unshift({missionId,missionRevision:snapshot.revision,workId,title:'스터디룸 신청',memberId:null,execution:'queued',acceptance:'pending',unknown:false,started:false,startedAt:null,endedAt:null,turnId:'assistant-turn:m:library',segment:1,steps:{done:0,total:0}});for(const work of works){work.missionRevision=read.snapshot.revision;const stored=read.snapshot.value.works.find((w:any)=>w.id===work.workId);if(stored?.browserSession)work.browser=browserSummary(stored);}
 const conversation=fixture.routes['/assistant/conversation']!.body as any;for(const turn of conversation.turns??[])if(turn.work?.workId===workId){turn.work.browser=browserSummary(read.snapshot.value.works.find((w:any)=>w.id===workId));turn.work.missionRevision=read.snapshot.revision;}
 await attachBrowserRoute(fixture,service,missionId,workId);(fixture.routes['/missions/'+missionId+'/works/'+workId+'/browser']!.body as any).revision=read.snapshot.revision;
 if(library){fixture.steps=[{action:'click',selector:'[id="side-line-intake/library"]',readySelector:'#work-heading-library'},{action:'click',selector:'#work-browser-library',readySelector:'#pane-effect:not([hidden])'}];fixture.gaps=[];}
 else if(!unknown)fixture.gaps=fixture.gaps.map(g=>g.includes('browser/page-read telemetry')?'No host producer supplies named business steps or per-step timestamps; browser/page-read telemetry is produced by BrowserSessions.':g);
 fixture.reuse.push('scripts/ui-contracts/browser-fixtures.ts: BrowserSessions captures actual adapter read shapes; no network or form submission');return fixture;
}
