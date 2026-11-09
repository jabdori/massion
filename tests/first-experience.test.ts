import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {workbenchPage} from '../src/workbench.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';

const find=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id);
async function first(screen='B1'){
 const f=await loadFixture(screen),posted:any[]=[];
 const app=harness(async(path,options)=>{if(options?.method==='POST'){posted.push({path,body:JSON.parse(options.body)});return reply({});}const route=f.routes[path]??(path.startsWith('/events?')?f.routes['/events']:undefined);return reply(route?.body??{},route?.status??503);});
 await settle();return {app,posted};
}
test('first suggestions open an owner picker; selection and mail deferral make no command',async()=>{
 const {app,posted}=await first();assert.ok(find(app,'first-calculation'));
 await find(app,'first-calculation')!.fire('click');await settle();assert.ok(find(app,'first-assign'));assert.equal(find(app,'first-mail-connect')!.tagName,'BUTTON');
 await find(app,'first-mail-later')!.fire('click');await settle();assert.match(app.node('chat-log').textContent,/나중에: Gmail 앱/);assert.equal(posted.length,0);
 await find(app,'first-mail-ask')!.fire('click');await settle();assert.ok(find(app,'first-mail-later'));assert.equal(posted.length,0);
 await find(app,'first-assign')!.fire('click');await settle();assert.equal(posted.filter(p=>p.path==='/assistant/messages').length,1);
 assert.equal(posted.find(p=>p.path==='/assistant/messages').body.text,'3센트 상품 두 개, 주문 전체 50% 할인. 할인 후 합계를 구해 줘. 정확히 한 줄로만 답해.');
});
test('no login shows the provider page without any credential inputs; existing login skips it',async()=>{
 const {app,posted}=await first('B1-signin');assert.equal(app.node('first-signin').hidden,false);
 assert.match(workbenchPage,/Claude로 계속하기.*ChatGPT로 계속하기/);assert.equal(posted.length,0);
 const connected=await first();assert.equal(connected.app.node('first-signin').hidden,true);
});
test('login probes retain kind only and overlapping login commands never launch twice',async()=>{
 const module=await import('../src/connection-logins.ts');
 let launches=0;const calls:any[]=[];
 const logins=new module.LoginConnections(async(call:any)=>{calls.push(call);if(call.args.join(' ')==='login')launches++;return {spawned:true,exitCode:0,stdout:call.command==='claude'?JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'private@example.test'}):'',stderr:call.command==='codex'?'Logged in using ChatGPT':'',timedOut:false,aborted:false,overflow:false};});
 const detected=await logins.list();assert.deepEqual(detected.map((d:any)=>[d.providerType,d.status]),[['claude-code-cli','detected'],['codex-cli','detected']]);assert.ok(!JSON.stringify(detected).includes('private'));
 await Promise.all([logins.start({providerType:'codex-cli',commandId:'login:a'}),logins.start({providerType:'codex-cli',commandId:'login:a'})]);assert.equal(launches,1);
 await assert.rejects(()=>logins.start({providerType:'claude-code-cli',commandId:'login:a'}),/identity/);
 await assert.rejects(()=>logins.start({providerType:'shell',commandId:'login:b'}),/provider/);
 assert.ok(calls.every(c=>c.env.OPENAI_API_KEY===undefined&&c.env.NODE_OPTIONS===undefined));
});
test('ambiguous status and API-key login do not count as detected subscriptions; unknown login is never restarted',async()=>{
 const {LoginConnections}=await import('../src/connection-logins.ts');let launched=0;
 const logins=new LoginConnections(async call=>{if(call.args.join(' ')==='login')launched++;return {spawned:true,exitCode:0,stdout:call.command==='claude'?JSON.stringify({loggedIn:true,authMethod:'api_key'}):'',stderr:'Unexpected account data',timedOut:call.args.join(' ')==='login',aborted:false,overflow:false};});
 const found=await logins.list();assert.deepEqual(found.map(d=>d.status),['absent','unknown']);
 await logins.start({commandId:'unknown:a',providerType:'codex-cli'});await settle();
 await logins.start({commandId:'unknown:a',providerType:'codex-cli'});assert.equal(launched,1);
 await assert.rejects(()=>logins.start({commandId:'unknown:b',providerType:'codex-cli'}),/already|unresolved/);assert.equal(launched,1);
});
test('HTTP login uses fixed providers, host origin guards and command identity, without exposing account details',async t=>{
 const {createWorkbench}=await import('../src/server.ts'),{ConnectionWorkbench}=await import('../src/connection-workbench.ts'),{LoginConnections}=await import('../src/connection-logins.ts'),{InMemoryStore}=await import('../src/storage.ts'),{TextArtifactStore}=await import('../src/text-artifacts.ts');
 const store=new InMemoryStore<any>(),artifacts=new TextArtifactStore('/fixture-never-written');let launches=0;
 const logins=new LoginConnections(async call=>{if(call.args.join(' ')==='login')launches++;return {spawned:true,exitCode:call.command==='codex'&&call.args.includes('status')?1:0,stdout:call.command==='claude'?JSON.stringify({loggedIn:false,email:'private@example.test'}):'',stderr:'Not logged in',timedOut:false,aborted:false,overflow:false};});
 const connections=new ConnectionWorkbench(store,artifacts,{transport:async()=>{throw Error('No model transport permitted');}}),server=createWorkbench(store,'/fixture-never-written',{connections,logins,scheduleIntervalMs:0});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const status=await fetch(origin+'/connections').then(r=>r.json()) as any;assert.deepEqual(status.logins.map((s:any)=>s.status),['absent','absent']);assert.ok(!JSON.stringify(status).includes('private'));
 const post=(body:unknown,headers={})=>fetch(origin+'/connection-login',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const command={providerType:'codex-cli',commandId:'login:http'};
 assert.equal((await post(command,{Origin:'https://foreign.example'})).status,403);assert.equal(launches,0);
 assert.equal((await post({...command,secret:'never-accepted'})).status,400);assert.equal(launches,0);
 const results=await Promise.all([post(command),post(command)]);assert.ok(results.every(r=>r.status===200));assert.equal(launches,1);
 assert.equal((await post({...command,providerType:'claude-code-cli'})).status,409);assert.equal(launches,1);
});
test('provider button starts one login; a status recheck discovers it without another login command',async()=>{
 const f=await loadFixture('B1-signin');let release=()=>{},starts=0;const gate=new Promise<void>(resolve=>{release=resolve;});
 const app=harness(async(path,options)=>{if(path==='/connection-login'){starts++;await gate;return reply({status:'started'});}const route=f.routes[path]??(path.startsWith('/events?')?f.routes['/events']:undefined);return reply(route?.body??{},route?.status??503);});await settle();
 const pending=app.node('first-chatgpt').fire('click');await settle();await app.node('first-chatgpt').fire('click');assert.equal(starts,1);
 release();await pending;await settle();assert.equal(app.node('first-login-check').hidden,false);
 (f.routes['/connections']!.body as any).logins=[{providerType:'codex-cli',kind:'cli-login',status:'detected'}];
 await app.node('first-login-check').fire('click');await settle();assert.equal(app.node('first-signin').hidden,true);assert.equal(app.node('app').hidden,false);assert.equal(starts,1);
});
test('the first picker preserves an owner draft and never appears inside a member thread',async()=>{
 const f=await loadFixture('B1'),body=f.routes['/assistant/conversation']!.body as any;
 body.members=[{id:'member:first',name:'셈',look:{shape:'round',color:'agent-2'}}];
 const app=harness(async(path,options)=>{const route=path.includes('member=')?{status:200,body:{...body,segment:null,greeting:{id:'greeting:member:first',text:'안녕하세요, 셈이에요.'}}}:f.routes[path]??(path.startsWith('/events?')?f.routes['/events']:undefined);return reply(route?.body??{},route?.status??503);});await settle();
 await find(app,'first-calculation')!.fire('click');app.node('chat-input').value='Keep my own request';await find(app,'first-assign')!.fire('click');await settle();
 assert.equal(app.node('chat-input').value,'Keep my own request');assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
 await find(app,'side-member-member:first')!.fire('click');await settle();assert.ok(!app.node('chat-log').textContent.includes('Gmail'));assert.ok(!app.node('chat-log').textContent.includes('할인 후 합계 계산'));assert.match(app.node('chat-log').textContent,/안녕하세요, 셈이에요/);
});
test('host drain aborts a pending provider login and refuses new starts',async()=>{
 const {LoginConnections}=await import('../src/connection-logins.ts');let signal:AbortSignal|undefined;
 const logins=new LoginConnections(call=>new Promise(resolve=>{signal=call.signal;call.signal.addEventListener('abort',()=>resolve({spawned:true,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:true,overflow:false}),{once:true});}));
 await logins.start({commandId:'login:drain',providerType:'codex-cli'});assert.equal(typeof (logins as any).drain,'function');
 await logins.drain();assert.equal(signal?.aborted,true);await assert.rejects(()=>logins.start({commandId:'login:after-drain',providerType:'claude-code-cli'}),/draining/);
});
test('a new conversation without a stored segment shows the same greeting and reply prompt as B1',async()=>{
 const f=await loadFixture('B1');(f.routes['/assistant/conversation']!.body as any).segment=null;
 const app=harness(async path=>{const route=f.routes[path]??(path.startsWith('/events?')?f.routes['/events']:undefined);return reply(route?.body??{},route?.status??503);});await settle();
 assert.match(app.node('chat-log').textContent,/안녕하세요, 하나예요/);assert.equal(app.node('chat-input').attributes.get('aria-label'),'답변을 입력하거나 다른 이야기를 하세요');
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});
test('B1 keeps its greeting separate from the four lettered choices and omits the extra header menu',async()=>{
 const {app}=await first();const greeting=find(app,'chat-message-first-greeting')!,card=find(app,'chat-first-suggestions')!;
 assert.equal(greeting.textContent,'안녕하세요, 하나예요.');assert.equal(card.tagName,'SECTION');assert.match(card.className,/first-picker/);
 assert.equal(card.children[0]!.textContent,'무엇부터 맡길까요?');assert.equal(card.children.length,5);
 assert.deepEqual(card.children.slice(1).map(row=>[row.tagName,row.children[0]!.textContent,row.children[0]!.attributes.get('aria-hidden')]),['A','B','C','D'].map(letter=>['A',letter,'true']));
 assert.equal(app.node('header-more').hidden,true);
 await find(app,'first-calculation')!.fire('click');assert.equal(app.node('header-more').hidden,false);
});
test('deferring Gmail replaces the decision card with a plain paragraph and a text link, then restores the card on ask again',async()=>{
 const {app}=await first();await find(app,'first-calculation')!.fire('click');await find(app,'first-mail-later')!.fire('click');
 const ask=find(app,'first-mail-ask')!,line=ask.parentElement!;assert.equal(line.tagName,'P');assert.equal(line.className,'chat-system');assert.equal(line.children[0]!.textContent,'나중에: Gmail 앱');assert.equal(ask.tagName,'A');
 await ask.fire('click');const later=find(app,'first-mail-later')!;assert.equal(later.parentElement!.tagName,'SECTION');assert.match(later.parentElement!.className,/chat-decision/);
});
test('a database reset cannot restart onboarding from a cached or refreshed login catalog',async()=>{
 const {app,posted}=await first();assert.ok(find(app,'chat-first-suggestions'));
 await runInContext('chatReset()',app.context);await settle();assert.equal(app.node('chat-log').textContent,'');
 await runInContext('refreshConnections()',app.context);await settle();assert.equal(app.node('chat-log').textContent,'');assert.equal(app.node('first-signin').hidden,true);assert.equal(app.node('app').hidden,false);assert.equal(posted.length,0);
});
test('an established configured connection opens conversation even when subscription detection finds nothing',async()=>{
 const f=await loadFixture('B1-signin');(f.routes['/connections']!.body as any).connections=[{id:'existing',providerType:'compatible',label:'Existing',models:[]}];
 const app=harness(async path=>{const route=f.routes[path]??(path.startsWith('/events?')?f.routes['/events']:undefined);return reply(route?.body??{},route?.status??503);});await settle();
 assert.equal(app.node('first-signin').hidden,true);assert.equal(app.node('app').hidden,false);assert.equal(app.node('page-chat').hidden,false);assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});
test('a conflicting login stays pending while an unavailable login reports disconnection, without another command',async()=>{
 for(const [status,expected] of [[409,'로그인을 마친 뒤 확인해주세요.'],[503,'연결 끊김']] as const){
  const f=await loadFixture('B1-signin');let starts=0;
  const app=harness(async(path)=>{if(path==='/connection-login'){starts++;return reply({error:'Login already started or unresolved'},status);}const route=f.routes[path]??(path.startsWith('/events?')?f.routes['/events']:undefined);return reply(route?.body??{},route?.status??503);});await settle();
  await app.node('first-chatgpt').fire('click');await settle();assert.equal(app.node('first-login-status').textContent,expected);assert.equal(app.node('first-login-check').hidden,false);assert.equal(starts,1);
 }
});
test('an installed Gmail rail app suppresses its first-work connection proposal',async()=>{
 const f=await loadFixture('B1');(f.routes['/assistant/conversation']!.body as any).apps=[{id:'app-gmail',name:'Gmail',page:true,item:false,roomTab:null}];
 const app=harness(async path=>{const route=f.routes[path]??(path.startsWith('/events?')?f.routes['/events']:undefined);return reply(route?.body??{},route?.status??503);});await settle();
 await find(app,'first-calculation')!.fire('click');assert.ok(find(app,'first-assign'));assert.ok(!app.node('chat-log').textContent.includes('Gmail을 연결할까요?'));assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});
