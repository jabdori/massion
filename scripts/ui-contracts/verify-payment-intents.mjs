import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Application} from '../../src/application.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {createWorkbench} from '../../src/server.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';

const exec=promisify(execFile),out=resolve('docs/acceptance/typed-payment-decisions'),root=await mkdtemp(join(tmpdir(),'massion-payment-ui-'));
const session=(await exec('agent-browser',['session','id','--scope','worktree','--prefix','massion-payment'])).stdout.trim();
let colorScheme='light';
const browser=async(...args)=>{const {stdout}=await exec('agent-browser',['--session',session,'--color-scheme',colorScheme,'--allowed-domains','127.0.0.1','--json',...args],{timeout:30000,maxBuffer:2*1024*1024});const r=JSON.parse(stdout);assert.equal(r.success,true,r.error);return r.data;};
const evaluate=async expression=>(await browser('eval',expression)).result;
const report=[];
await mkdir(out,{recursive:true});
try{
 for(const theme of ['light','dark']){
  colorScheme=theme;
  const store=new InMemoryStore(),app=new Application(store,[{id:'local-owner',roles:['owner']}]);
  await app.create({id:'intake',purpose:'결제 요청 확인',scope:'fixture',constraints:[],criteria:{version:1,description:'요청 확인',oracle:'fixture/v1'}},'local-owner','create');
  const server=createWorkbench(store,root,{connections:{list:()=>({representative:{intakeMissionId:'intake',name:'하나'}})},scheduleIntervalMs:0});
  for(const [workId,amountMinor] of [['approve',34000],['decline',12000]]){
   await app.dispatch({missionId:'intake',commandId:'work-'+workId,expectedRevision:(await store.load('intake')).revision,actorId:'local-owner',command:{type:'admit-work',workId,title:'물품 구매',budget:8}});
   await app.dispatch({missionId:'intake',commandId:'assign-'+workId,expectedRevision:(await store.load('intake')).revision,actorId:'local-owner',command:{type:'assign',workId,assignment:{id:workId+'-executor',actorId:'executor',role:'executor',taskId:workId+':root',model:{provider:'fixture',model:'none',configVersion:'v1',reason:'Data-only fixture',evidenceClass:'fixture'},extensionVersion:'v1'}}});
   await server.effectDecisions.propose({missionId:'intake',workId,taskId:workId+':root',stepId:'payment-intent',request:{kind:'payment-intent',payee:'공급처',amountMinor,currency:'KRW',purpose:'물품 구매',sourceReference:'document:quote'}});
  }
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  const capture=async name=>{await writeFile(join(out,theme+'-'+name+'.snapshot.json'),JSON.stringify(await browser('snapshot'),null,2)+'\n');await browser('screenshot',join(out,theme+'-'+name+'.png'));};
  try{
   await browser('open',url);await browser('set','viewport','1440','900');await browser('wait','.chat-decision');assert.equal(await evaluate(`matchMedia('(prefers-color-scheme: dark)').matches`),theme==='dark');await capture('open');
   const decisions=await server.effectDecisions.decisions(),approved=decisions.find(d=>d.effect.workId==='approve'),declined=decisions.find(d=>d.effect.workId==='decline');
   await browser('click','[id="chat-decision-'+approved.id+'"] .chat-actions button:first-child');await browser('wait','--fn',`document.getElementById('chat-log').textContent.includes('승인됨 · Massion 미실행')`);await capture('approved');
   await browser('click','[id="chat-decision-'+declined.id+'"] .chat-actions button:last-child');await browser('wait','--fn',`document.getElementById('chat-log').textContent.includes('거절됨')`);await capture('declined');
   await browser('reload');await browser('wait','--fn',`document.getElementById('chat-log').textContent.includes('승인됨 · Massion 미실행')&&document.getElementById('chat-log').textContent.includes('거절됨')`);
   assert.equal(await evaluate(`document.querySelectorAll('.chat-decision').length`),0);
   await browser('set','viewport','390','844');await browser('click','#sidebar-toggle');await capture('reloaded-mobile');
   const w=(await store.load('intake')).value.works;assert.deepEqual(w.map(w=>w.effects[0].ownerDecision.state),['approved','rejected']);assert.ok(w.every(w=>!w.effects[0].ownerDecision.dispatch&&!w.effects[0].ownerDecision.receipt&&!w.record));validateMissionJournalLineage(store.inspect());
   report.push({theme,states:['open','approved','declined','reloaded-mobile'],paymentCalls:0,ownerAnswers:w.map(w=>w.effects[0].ownerDecision.answers.length)});
  }finally{await browser('close');server.closeAllConnections();await server.drain();}
 }
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await rm(root,{recursive:true,force:true});}
