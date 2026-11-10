import assert from 'node:assert/strict';
import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Application} from '../../src/application.ts';
import {AppsService} from '../../src/apps.ts';
import type {AppPackage} from '../../src/apps.ts';
import type {Mission} from '../../src/domain.ts';
import type {Store} from '../../src/storage.ts';
import type {EffectAdapter,OwnerEffectRequest} from '../../src/effect-decisions.ts';
import type {createWorkbench} from '../../src/server.ts';

export function effectFixtures(store:Store<Mission>,root:string){
 const releases=new Map<string,()=>void>();
 const log=(data:unknown)=>appendFile(join(root,'calls.jsonl'),JSON.stringify(data)+'\n');
 const adapters:EffectAdapter[]=['payment','external-member'].map(kind=>({id:'fixture-'+kind,kind:kind as EffectAdapter['kind'],async send(input){
  const scenario=input.request.kind==='payment'?input.request.checkoutId:input.request.deviceId;
  await log({kind,scenario,idempotencyKey:input.idempotencyKey});
  if(scenario.endsWith('lost'))throw Error('Fixture reply lost after sending');
  if(kind==='external-member')await new Promise<void>(resolve=>releases.set(scenario,resolve));
  return {idempotencyKey:input.idempotencyKey,remoteId:(kind==='payment'?'order-':'arrival-')+scenario,outcome:kind==='payment'?'succeeded' as const:'received' as const,detail:'Fixture receipt'};
 }}));
 const tools=[{name:'comment',description:'Write a fixture comment',inputSchema:{type:'object'},readOnly:false}];
 const mcp={list:async()=>structuredClone(tools),call:async(input:any)=>{
  await log({kind:'mcp-write',scenario:input.arguments.scenario,requestId:input.requestId});
  if(input.arguments.scenario==='timeout')return new Promise((_resolve,reject)=>{input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});});
  return {content:[{type:'text',text:'Fixture write receipt'}]};
 },close:async()=>{},view:async()=>({title:'Fixture MCP',html:`<!doctype html><p id="probe">격리된 앱</p><script>
window.probe={ran:true,parentBlocked:false,networkBlocked:false};
try{parent.document.body.dataset.appEscaped='true';}catch{window.probe.parentBlocked=true;}
fetch('http://127.0.0.1:1/').then(()=>{},()=>{window.probe.networkBlocked=true;document.getElementById('probe').textContent='격리된 앱 · 실행됨';parent.postMessage({type:'resize',height:617},'*');});
</script>`})};
 const apps=new AppsService(store,{mcp,toolTimeoutMs:40});
 async function control(message:any,server:ReturnType<typeof createWorkbench>):Promise<unknown>{
  if(message.type==='propose-effect'){
   assert.ok(['payment','payment-lost','desktop-payment','desktop-payment-lost','external','external-lost'].includes(message.scenario));
   const scenario=message.scenario,payment=scenario.includes('payment'),now=Date.now();
   const app=new Application(store,[{id:'local-owner',roles:['owner']}]);
   const send=async(command:any,suffix:string)=>{const s=(await store.load('intake'))!;const r=await app.dispatch({missionId:'intake',commandId:'e9a2-'+scenario+'-'+suffix,expectedRevision:s.revision,actorId:'local-owner',command});assert.equal(r.status,'committed');};
   await send({type:'admit-work',workId:scenario,title:payment?'프린터 토너 주문':'외부 테스트 수정',budget:8},'work');
   await send({type:'assign',workId:scenario,assignment:{id:scenario+'-executor',actorId:'fixture-executor',role:'executor',taskId:scenario+':root',model:{provider:'fixture',model:'none',configVersion:'v1',reason:'Fixture checkout or handoff step',evidenceClass:'fixture'},extensionVersion:'v1'}},'assign');
   const request:OwnerEffectRequest=payment?{kind:'payment',adapterId:'fixture-payment',checkoutId:scenario,item:'레이저 토너 검정',quantity:1,subtotal:31000,shipping:3000,total:34000,currency:'KRW',merchant:'오피스몰',origin:'https://shop.example.com',destination:'집 · 저장된 주소',method:'카드 끝자리 0000',expiresAt:now+3600000,cancellation:'결제 후 취소 신청 가능',pagesRead:4,startedAt:now-120000}:{kind:'external-member',adapterId:'fixture-external-member',deviceId:scenario,deviceName:'내 노트북',agentId:'fixture-agent',agentName:'Fixture Agent',instruction:'massion 저장소에서 테스트 하나 고쳐 줘.',scope:'massion 저장소',repository:{name:'massion',tests:['tests/domain.test.ts']}};
   return server.effectDecisions.propose({missionId:'intake',workId:scenario,taskId:scenario+':root',stepId:'checkout',request});
  }
  if(message.type==='release-external'){assert.ok(releases.has(message.scenario));releases.get(message.scenario)!();releases.delete(message.scenario);return null;}
  if(message.type==='offer-mcp'){
   const pkg:AppPackage={manifest:{format:'massion.app.v1',id:'fixture-mcp',name:'Fixture MCP',version:'1.0.0',description:'Fixture app',kind:'mcp',mcp:{transport:'http',url:'http://127.0.0.1:4318/mcp',tools},permissions:{read:[],write:['comment'],network:['127.0.0.1'],files:[],secrets:[],events:[]},contributes:{templates:[],skills:[],procedures:[],tools:['comment'],page:{title:'Fixture MCP'}},handlers:['run','page']},source:''};
   return apps.offer({commandId:'assistant-app-e9a2-mcp',pkg,origin:'catalog'});
  }
  if(message.type==='call-mcp')return apps.callTool({commandId:message.commandId,appId:'app-fixture-mcp',name:'comment',arguments:{scenario:message.scenario}});
  throw Error('Unknown fixture control');
 }
 return {adapters,mcp,control};
}
