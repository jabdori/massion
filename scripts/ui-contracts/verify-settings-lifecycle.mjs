import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {InMemoryStore} from '../../src/storage.ts';
import {InMemorySecretSlots} from '../../src/secret-slots.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {createHostConnections,parseHostManifest} from '../../src/host-connections.ts';
import {LoginConnections} from '../../src/connection-logins.ts';
import {createWorkbench} from '../../src/server.ts';
import {MembersService,MEMBERS_ID,applyMembers,PROPOSAL_PREFIX,proposalDecisionId} from '../../src/members.ts';
import {AppsService,APPS_ID} from '../../src/apps.ts';
import {ASSISTANT_ACTOR_ID} from '../../src/assistant-conversation.ts';
import {hash} from '../../src/domain.ts';

// Actual host commands, in-memory secrets and fixed adapters only. No provider calls.
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'massion-settings-ui-')),out=resolve('docs/acceptance/rc/interaction');
const store=new InMemoryStore(),slots=new InMemorySecretSlots(),members=new MembersService(store,()=>undefined),report=[],contrast=[];
const manifest=parseHostManifest({version:1,revision:'fixture-ui',mode:'https',connections:[{id:'api',label:'OpenAI API',providerType:'openai',baseUrl:'https://api.openai.com/v1/',models:['fixture'],credential:{ref:'fixture-key',slot:'api-key'}},{id:'codex',label:'Codex',providerType:'codex-cli',baseUrl:'cli://codex/',models:['gpt-6.1-terra']}]});
const connections=createHostConnections(store,new TextArtifactStore(root),{manifest,allowLiveExecution:false},{secrets:slots,readEnvironment:()=>undefined,transport:async()=>{throw Error('No network in Settings verification');}});
const logins=new LoginConnections(async call=>({spawned:true,exitCode:0,stdout:call.command.includes('claude')?'{}':'',stderr:call.command.includes('claude')?'':'Logged in using ChatGPT',timedOut:false,aborted:false,overflow:false}));
for(const name of ['퀼','주노']){
 const commandId=PROPOSAL_PREFIX+'settings-ui-'+hash(name).slice(0,8),decisionId=proposalDecisionId(commandId),command={type:'propose-member',decisionId,topic:name,works:[{title:'First fixture Work'},{title:'Second fixture Work'}],count:2},actor={id:ASSISTANT_ACTOR_ID,roles:['assistant']},s=await store.load(MEMBERS_ID),transition=applyMembers(s?.value??null,command,actor,{observedAt:Date.now()});
 await store.commit({id:MEMBERS_ID,expectedRevision:s?.revision??0,commandId,fingerprint:hash({actorId:actor.id,command}),...transition,outbox:[]});await members.decide({commandId:'admit-'+hash(name).slice(0,8),decisionId,answer:'act',member:{name,shape:'square'}});
}
const apps=new AppsService(store,{secrets:slots,members:()=>members.roster()});
await apps.act({commandId:'install-fixture-github',action:'install',catalogId:'github'});const install=(await apps.decisions(null)).find(d=>d.state==='open');await apps.decide({commandId:'approve-fixture-github',decisionId:install.id,answer:'act'});
const targetId=type=>connections.list().connections.find(c=>c.providerType===type).id,control=(kind,type)=>'[id='+JSON.stringify('settings-connection-'+kind+'-'+targetId(type))+']';
const server=createWorkbench(store,root,{connections,logins,appSecrets:slots,scheduleIntervalMs:0,connectionObserver:async()=>({status:'detected',restart:'not-required',update:'current',source:'host'})});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
const session=(await exec('agent-browser',['session','id','--scope','worktree','--prefix','massion-settings'])).stdout.trim();
const browser=async(...args)=>{const {stdout}=await exec('agent-browser',['--session',session,'--allowed-domains','127.0.0.1','--json',...args],{timeout:30000,maxBuffer:2*1024*1024});const result=JSON.parse(stdout);assert.equal(result.success,true,result.error);return result.data;};
const capture=async(name)=>{await browser('snapshot','-i');await browser('screenshot',join(out,name+'.png'));report.push(name);};
const wait=selector=>browser('wait',selector);
try{
 await mkdir(out,{recursive:true});await browser('open',origin);await wait('#rail-me');await browser('click','#rail-me');await browser('click','#me-settings');await wait('#settings-general-body .set-row');
 await browser('click','#settings-nav-connections');await wait(control('recheck','codex-cli'));await browser('click',control('recheck','codex-cli'));
 await browser('wait','--fn',"document.querySelector('#settings-groups').textContent.includes('연결됨')");await capture('connection-rechecked');
 await browser('click',control('key','openai'));await wait('#settings-key-value');await browser('fill','#settings-key-value','ui-fixture-key');await browser('click','#settings-key-save');
 await browser('wait','--fn',"document.querySelector('#settings-groups').textContent.includes('저장됨')");assert.equal(await slots.has({owner:'api',slot:'api-key'}),true);await capture('key-stored');
 await browser('click','#settings-nav-members');const roster=await members.roster(),quill=roster.find(m=>m.name==='퀼');await wait('#settings-member-'+quill.id);await browser('click','#settings-member-'+quill.id);await wait('#settings-member-archive');await browser('click','#settings-member-archive');
 await browser('wait','--fn',"document.querySelector('#settings-members-body').textContent.includes('보관 해제')");assert.equal((await members.read()).archived.length,1);await capture('member-archived');
 await browser('find','role','button','click','--name','보관 해제');await browser('wait','--fn',"!document.querySelector('#settings-members-body').textContent.includes('보관 해제')");assert.equal((await members.read()).archived.length,0);await capture('member-restored');
 const binding=await fetch(origin+'/assistant/apps',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({commandId:'bind-fixture-member',action:'bind-members',appId:'app-github',memberIds:[quill.id]})});assert.equal(binding.status,200);
 await browser('click','#settings-nav-apps');await wait('#settings-app-app-github');await browser('click','#settings-app-app-github');await wait('#settings-app-reconnect');assert.deepEqual((await apps.read()).apps[0].memberIds,[quill.id]);await capture('app-bindings-visible');
 const contrastExpression=`(()=>{const b=document.getElementById('settings-app-reconnect'),fg=getComputedStyle(b).color;let p=b,bg='';while(p){bg=getComputedStyle(p).backgroundColor;if(bg!=='transparent'&&!/rgba\\([^)]*, 0\\)$/.test(bg))break;p=p.parentElement;}const light=c=>{const v=c.match(/[\\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return v[0]*.2126+v[1]*.7152+v[2]*.0722;},a=light(fg),z=light(bg);return {foreground:fg,background:bg,ratio:(Math.max(a,z)+.05)/(Math.min(a,z)+.05)};})()`;
 for(const theme of ['dark','light']){await browser('set','media',theme);await browser('wait','--fn',contrastExpression+'.ratio>=4.5');const measured=(await browser('eval',contrastExpression)).result;assert.ok(measured.ratio>=4.5);contrast.push({theme,...measured});await capture('reconnect-'+theme);}
 await browser('click','#settings-app-reconnect');await browser('wait','--fn',"document.querySelector('#page-chat').hidden===false");const pending=(await apps.decisions(null)).find(d=>d.state==='open'&&d.connection);assert.ok(pending);
 await browser('find','role','button','click','--name','연결');await wait('#app-connect-token');await browser('fill','#app-connect-token','ui-fixture-app-token');await browser('click','#app-connect-submit');
 await browser('wait','--fn',"document.querySelector('#app-connect-panel').hidden===true");assert.equal((await apps.read()).apps[0].credential.state,'saved');await capture('app-token-stored');
 await slots.delete({owner:'app-github',slot:'github-token'});await browser('click','#rail-me');await browser('click','#me-settings');await browser('click','#settings-nav-apps');await wait('#settings-app-app-github');await browser('click','#settings-app-app-github');await wait('#settings-app-reconnect');assert.equal((await apps.read()).apps[0].credential.state,'missing');assert.equal((await store.load(APPS_ID)).value.apps.find(a=>a.id==='app-github').credential.state,'saved');await capture('app-token-missing');
 const serialized=JSON.stringify(store.inspect());assert.ok(!serialized.includes('ui-fixture-key')&&!serialized.includes('ui-fixture-app-token'));await writeFile(join(out,'report.json'),JSON.stringify({states:report,reconnectContrast:contrast,externalNetworkCalls:0,secretValuesInJournal:false},null,2)+'\n');
 console.log(JSON.stringify({states:report,reconnectContrast:contrast,externalNetworkCalls:0,secretValuesInJournal:false}));
}finally{await browser('close').catch(()=>{});await server.drain();await rm(root,{recursive:true,force:true});}
