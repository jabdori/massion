import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {InMemoryStore} from '../../src/storage.ts';
import {hash} from '../../src/domain.ts';
import {ASSISTANT_ACTOR_ID} from '../../src/assistant-conversation.ts';
import {MEMBERS_ID,MembersService,applyMembers,proposalDecisionId,PROPOSAL_PREFIX} from '../../src/members.ts';
import {createWorkbench} from '../../src/server.ts';
import {workbenchReady} from './report.ts';
const run=promisify(execFile),out=process.cwd()+'/.runtime/rp-interactions',session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-rp'])).stdout.trim();
await mkdir(out,{recursive:true});await writeFile(out+'/browser-config.json','{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
for(const theme of ['dark','light']){
 const store=new InMemoryStore(),members=new MembersService(store,()=>undefined),proposalId=PROPOSAL_PREFIX+'browser',decisionId=proposalDecisionId(proposalId),command={type:'propose-member',decisionId,topic:'자료 정리',works:[{title:'자료 읽기'},{title:'표 정리'}],count:2},actorId=ASSISTANT_ACTOR_ID;
 const derived=applyMembers(null,command,{id:actorId,roles:['assistant']},{observedAt:Date.now()});await store.commit({id:MEMBERS_ID,expectedRevision:0,commandId:proposalId,fingerprint:hash({actorId,command}),...derived,outbox:[]});
 await members.decide({commandId:'browser-admit',decisionId,answer:'act',member:{name:'셈',shape:'drop'}});
 const memberId=(await members.roster())[0].id,server=createWorkbench(store,out,{scheduleIntervalMs:0});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',out+'/browser-config.json','--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 const capture=async name=>{await browser('screenshot',out+'/'+theme+'-'+name+'.png');await writeFile(out+'/'+theme+'-'+name+'.snapshot.txt',(await browser('snapshot')).snapshot+'\n');};
 try{
  await browser('open',origin);await browser('set','viewport','1440','900');await browser('wait','--fn',workbenchReady);await browser('wait','#chat-log .chat-member-added a');await capture('admitted');
  assert.equal(await evaluate(`document.querySelector('#chat-log .chat-member-added a').textContent`),'되돌리기');
  await browser('click','#chat-log .chat-member-added a');await browser('wait','--fn',`document.getElementById('chat-log').textContent.includes('구성원 추가 취소됨')`);await capture('undone');
  assert.ok((await members.member(memberId)).archivedAt!==undefined);assert.deepEqual(await members.roster(),[]);
  const undo=store.inspect().find(o=>o.events.some(e=>e.type==='undo-member-admission'));
  assert.ok(undo);assert.equal((await members.act({commandId:undo.commandId,action:'undo',memberId})).status,'replayed');
  await browser('open',origin);await browser('wait','--fn',workbenchReady);assert.equal(await evaluate(`!!document.querySelector('#chat-log .chat-member-added')`),false);await capture('reloaded');
  await members.act({commandId:'browser-restore',action:'unarchive',memberId});await browser('open',origin);await browser('wait','--fn',workbenchReady);assert.equal((await members.read()).decisions[0].undoable,false);await capture('restored');
  await browser('set','viewport','390','844');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  console.log(theme+': real HTTP undo, replay, reload, restore and mobile overflow checks passed');
 }finally{await browser('close');await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
