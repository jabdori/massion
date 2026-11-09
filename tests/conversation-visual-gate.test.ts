import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

async function unknownScene(){
 const scene=await loadFixture('B5');let wait:Promise<void>|null=null;const posted:string[]=[];
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){posted.push(path);return reply({error:'Read-only fixture'},405);}
  if((path==='/missions/intake'||path==='/read-state?mission=intake')&&wait)await wait;
  const response=scene.routes[path]??(/^\/events\?/.test(path)?scene.routes['/events']:undefined);
  return response?reply(structuredClone(response.body),response.status):reply({error:'Not configured'},503);
 });await settle();
 const card=()=>app.all().find(n=>n.id==='chat-exception-assistant-turn:m:toner')!;
 const action=(name:string)=>card().children.flatMap(function all(n:Node):Node[]{return [n,...n.children.flatMap(all)];}).find(n=>n.tagName==='BUTTON'&&n.textContent===name);
 return {app,scene,posted,card,action,hold(value:Promise<void>){wait=value;}};
}

test('unknown payment presentation uses the stored interruption time and approved fact',async()=>{
 const {card,scene}=await unknownScene();const turn=(scene.routes['/assistant/conversation']!.body as any).turns[0];
 assert.match(card().textContent,/결제 요청에 응답 없음 · 다시 보내지 않음/);assert.ok(card().textContent.includes(new Date(turn.work.exception.at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})));
});

test('unknown Work date includes its original owner-turn time rather than interruption time',async()=>{
 const {app,scene}=await unknownScene();const turn=(scene.routes['/assistant/conversation']!.body as any).turns[0];
 const date=app.node('chat-log').children.find(n=>n.className==='chat-date')!;
 assert.equal(date.textContent,runInContext('chatDay('+turn.at+')+" "+chatTime('+turn.at+')',app.context));
 assert.ok(!date.textContent.endsWith(new Date(turn.work.exception.at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})));
});

test('unknown Close opens exact existing quarantine review without submitting or settling anything',async()=>{
 const {app,posted,action}=await unknownScene();const close=action('닫기');assert.ok(close);assert.equal(action('다시 시도'),undefined);
 await close.fire('click');await settle();const reason=app.all().find(n=>n.id==='quarantine-reason-toner')!;assert.ok(reason);assert.equal(app.context.document.activeElement,reason);
 const work=(app.context as any);assert.equal(runInContext("snapshot.value.works.find(w=>w.id==='toner').effects[0].status",work),'unknown');assert.equal(posted.length,0);assert.equal(runInContext("snapshot.value.works.find(w=>w.id==='toner').runtimeRecovery",work),undefined);
});

for(const change of ['thread','pane','run','epoch','focus'] as const)test('a late unknown-closure read cannot steal focus after '+change+' changes',async()=>{
 const {app,scene,posted,action,hold}=await unknownScene();let release=()=>{};hold(new Promise<void>(resolve=>{release=resolve;}));
 const close=action('닫기');assert.ok(close);close.focus();await close.fire('click');await settle();
 if(change==='thread')runInContext("chatOpenThread('member-quill')",app.context);
 if(change==='epoch')runInContext('++connectionEpoch',app.context);
 if(change==='pane')await app.node('pane-close').fire('click');
 if(change==='run')for(const path of ['/missions/intake','/read-state?mission=intake']){const body=scene.routes[path]!.body as any;(body.value??body.snapshot.value).works.find((w:any)=>w.id==='toner').runtimeRun.id='replacement-run';}
 app.node('chat-input').focus();release();await settle();assert.equal(app.context.document.activeElement.id,'chat-input');assert.equal(posted.length,0);
});
