import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import {proposalFixture} from './support/growth-proposal-fixture.ts';
import {RuleChangesService} from '../src/rule-changes.ts';

async function setup(t:any){const f=await proposalFixture(t);await f.product.proposeGrowth('mission',f.proposal);await f.product.evaluateGrowth('mission',{...f.evaluation(),expectedRevision:(await f.store.load('mission'))!.revision});const decisions=await new RuleChangesService(f.store,()=> 'mission').decisions();return {snapshot:(await f.store.load('mission'))!,decisions,view:{feedId:'feed:rules',cursor:1,head:1,segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[],decisions}};}
test('approved case link opens exact Memory evidence without creating a pane or exposing version IDs',async t=>{
 const f=await setup(t),app=harness(async path=>path==='/assistant/conversation'?reply(structuredClone(f.view)):reply({feedId:'feed:rules',head:0,segment:null,turns:[]}));await settle();
 (app.context as any).reviewMission=structuredClone(f.snapshot);runInContext("globalThis.memoryOpened=[];shellShow=name=>{memoryOpened.push(name);$('page-settings').hidden=false;};settingsOpen=name=>{memoryOpened.push(name);settingsShown=name;settingsGen.memory=(settingsGen.memory||0)+1;settingsMission=reviewMission;return Promise.resolve();};",app.context);const binding=runInContext('chatDecisionBinding(chatDecisions()[0])',app.context);
 await runInContext('chatRuleOpen(chatDecisionBinding(chatDecisions()[0]))',app.context);assert.deepEqual(JSON.parse(runInContext('JSON.stringify(memoryOpened)',app.context)),['settings','memory']);assert.equal(runInContext('settingsEvidence.has(chatDecisions()[0].ruleChange.growthId)',app.context),true);assert.equal(runInContext('paneTabs.length',app.context),0);assert.ok(!app.all().some(n=>n.id==='pane-rule'));assert.doesNotMatch(app.node('chat-log').textContent,/rounding@/);
 (app.context as any).oldRuleBinding=binding;runInContext("chatGeneration++;chatRuleOpen(oldRuleBinding)",app.context);assert.equal(runInContext('memoryOpened.length',app.context),2);
});
test('a late rule answer never repaints another thread and its unknown marker blocks another send',async t=>{
 const f=await setup(t);let release!:(v:any)=>void;const app=harness(async(path,options)=>path==='/assistant/conversation'?reply(structuredClone(f.view)):path==='/assistant/decisions'?new Promise(resolve=>release=resolve):reply({feedId:'feed:rules',head:0,segment:null,turns:[]}));await settle();
 runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);await settle();runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);await settle();assert.equal(app.calls.filter(c=>c.path==='/assistant/decisions').length,1);
 runInContext("chatOpenThread('member:other','다른 구성원')",app.context);await settle();const before=app.calls.length;release(reply({status:'committed'}));await settle();assert.equal(app.calls.length,before);assert.equal(app.node('chat-log').textContent,'');
});

test('an unknown rule answer stays locked after an unrelated Mission revision and feed changes invalidate its inspector',async t=>{
 const f=await setup(t);let fail=false;const app=harness(async(path,options)=>{if(path==='/assistant/decisions'){fail=true;throw Error('Lost answer');}if(path==='/assistant/conversation')return reply(structuredClone(f.view));return reply({feedId:'feed:rules',head:0,segment:null,turns:[]});});await settle();
 await runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);await settle();assert.equal(fail,true);f.view.decisions[0]!.ruleChange.revision++;await app.node('chat-latest').fire('click');await settle();await runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);assert.equal(app.calls.filter(c=>c.path==='/assistant/decisions').length,1);
 f.view.feedId='feed:replacement';await app.node('chat-latest').fire('click');await settle();assert.equal(runInContext('paneTabs.length',app.context),0);
});

test('a definite rule refusal clears its receipt so the owner can defer the unchanged proposal',async t=>{
 const f=await setup(t);let posts=0;const app=harness(async(path,options)=>{if(path==='/assistant/conversation')return reply(structuredClone(f.view));if(path==='/assistant/decisions'){posts++;if(posts===1)return reply({error:'Baseline changed',outcome:'rejected',phase:'admission',feedId:f.view.feedId},400);f.view.decisions[0]!.state='later';return reply({status:'committed'});}return reply({feedId:f.view.feedId,head:0,segment:null,turns:[]});});await settle();
 await runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);await settle();assert.equal(posts,1);assert.equal([...app.storage.keys()].filter(k=>k.startsWith('massion.workbench.effect-decision:')).length,0);
 await runInContext("chatDecide(chatDecisions()[0].id,'later')",app.context);await settle();assert.equal(posts,2);assert.match(app.node('chat-log').textContent,/다시 묻기/);
});

test('a scheduled briefing links the exact pending decision without adding a Work entry',async t=>{
 const f=await setup(t),id=f.decisions[0]!.id,view={...f.view,briefings:[{id:'morning',at:Date.now(),title:'아침 브리핑',turnIds:[],decisionIds:[id]}]},app=harness(async path=>path==='/assistant/conversation'?reply(structuredClone(view)):reply({feedId:'feed:rules',works:[]}));await settle();
 const brief=app.all().find(n=>n.id==='chat-briefing-morning')!;assert.ok(brief);assert.match(brief.textContent,/반올림 규칙 결정 대기/);const link=brief.children.flatMap(n=>n.children).flatMap(n=>[n,...n.children]).find(n=>n.tagName==='BUTTON'&&n.textContent==='반올림 규칙');assert.ok(link);await link!.fire('click');await settle();assert.equal(runInContext('paneTabs.length',app.context),0);
});

test('case evidence waits for the exact Mission read and ignores older navigation requests',async t=>{
 const f=await setup(t),app=harness(async path=>path==='/assistant/conversation'?reply(structuredClone(f.view)):reply({feedId:f.view.feedId,works:[]}));await settle();(app.context as any).reviewMission=structuredClone(f.snapshot);
 runInContext("globalThis.caseReads=[];globalThis.caseRenders=0;shellShow=()=>{$('page-settings').hidden=false;};renderSettings=()=>caseRenders++;settingsOpen=name=>{settingsShown=name;settingsGen.memory=(settingsGen.memory||0)+1;return new Promise(resolve=>caseReads.push(()=>{settingsMission=reviewMission;resolve();}));};",app.context);
 const first=runInContext('chatRuleOpen(chatDecisionBinding(chatDecisions()[0]))',app.context),second=runInContext('chatRuleOpen(chatDecisionBinding(chatDecisions()[0]))',app.context);runInContext('caseReads[0]()',app.context);await first;assert.equal(runInContext('settingsEvidence.size',app.context),0);runInContext('caseReads[1]()',app.context);await second;assert.equal(runInContext('settingsEvidence.size',app.context),1);assert.equal(runInContext('caseRenders',app.context),1);
 runInContext("reviewMission.value.id='other-mission'",app.context);const stale=runInContext('chatRuleOpen(chatDecisionBinding(chatDecisions()[0]))',app.context);runInContext('caseReads[2]()',app.context);await stale;assert.equal(runInContext('settingsEvidence.size',app.context),0);
});
