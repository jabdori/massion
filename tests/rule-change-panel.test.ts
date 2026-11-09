import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import {proposalFixture} from './support/growth-proposal-fixture.ts';
import {RuleChangesService} from '../src/rule-changes.ts';

async function setup(t:any){const f=await proposalFixture(t);await f.product.proposeGrowth('mission',f.proposal);await f.product.evaluateGrowth('mission',{...f.evaluation(),expectedRevision:(await f.store.load('mission'))!.revision});const decisions=await new RuleChangesService(f.store,()=> 'mission').decisions();return {decisions,view:{feedId:'feed:rules',cursor:1,head:1,segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[],decisions}};}
test('rule cases use exact stored evidence and leave the old pane unavailable after thread replacement',async t=>{
 const f=await setup(t),app=harness(async path=>path==='/assistant/conversation'?reply(structuredClone(f.view)):reply({feedId:'feed:rules',head:0,segment:null,turns:[]}));await settle();
 assert.match(app.node('chat-log').textContent,/사례 보기/);runInContext('chatRuleOpen(chatDecisionBinding(chatDecisions()[0]))',app.context);assert.match(app.all().find(n=>n.id==='pane-rule')!.textContent,/사례 1/);assert.match(app.all().find(n=>n.id==='pane-rule')!.textContent,/4/);assert.match(app.all().find(n=>n.id==='pane-rule')!.textContent,/3/);
 runInContext("chatOpenThread('member:other','다른 구성원')",app.context);await settle();assert.doesNotMatch(app.all().find(n=>n.id==='pane-rule')!.textContent,/사례 1/);
});
test('a late rule answer never repaints another thread and its unknown marker blocks another send',async t=>{
 const f=await setup(t);let release!:(v:any)=>void;const app=harness(async(path,options)=>path==='/assistant/conversation'?reply(structuredClone(f.view)):path==='/assistant/decisions'?new Promise(resolve=>release=resolve):reply({feedId:'feed:rules',head:0,segment:null,turns:[]}));await settle();
 runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);await settle();runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);await settle();assert.equal(app.calls.filter(c=>c.path==='/assistant/decisions').length,1);
 runInContext("chatOpenThread('member:other','다른 구성원')",app.context);await settle();const before=app.calls.length;release(reply({status:'committed'}));await settle();assert.equal(app.calls.length,before);assert.equal(app.node('chat-log').textContent,'');
});

test('an unknown rule answer stays locked after an unrelated Mission revision and feed changes invalidate its inspector',async t=>{
 const f=await setup(t);let fail=false;const app=harness(async(path,options)=>{if(path==='/assistant/decisions'){fail=true;throw Error('Lost answer');}if(path==='/assistant/conversation')return reply(structuredClone(f.view));return reply({feedId:'feed:rules',head:0,segment:null,turns:[]});});await settle();
 await runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);await settle();assert.equal(fail,true);f.view.decisions[0]!.ruleChange.revision++;await app.node('chat-latest').fire('click');await settle();await runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);assert.equal(app.calls.filter(c=>c.path==='/assistant/decisions').length,1);
 runInContext('chatRuleOpen(chatDecisionBinding(chatDecisions()[0]))',app.context);assert.match(app.all().find(n=>n.id==='pane-rule')!.textContent,/사례 1/);f.view.feedId='feed:replacement';await app.node('chat-latest').fire('click');await settle();assert.doesNotMatch(app.all().find(n=>n.id==='pane-rule')!.textContent,/사례 1/);
});

test('a definite rule refusal clears its receipt so the owner can defer the unchanged proposal',async t=>{
 const f=await setup(t);let posts=0;const app=harness(async(path,options)=>{if(path==='/assistant/conversation')return reply(structuredClone(f.view));if(path==='/assistant/decisions'){posts++;if(posts===1)return reply({error:'Baseline changed',outcome:'rejected',phase:'admission',feedId:f.view.feedId},400);f.view.decisions[0]!.state='later';return reply({status:'committed'});}return reply({feedId:f.view.feedId,head:0,segment:null,turns:[]});});await settle();
 await runInContext("chatDecide(chatDecisions()[0].id,'act')",app.context);await settle();assert.equal(posts,1);assert.equal([...app.storage.keys()].filter(k=>k.startsWith('massion.workbench.effect-decision:')).length,0);
 await runInContext("chatDecide(chatDecisions()[0].id,'later')",app.context);await settle();assert.equal(posts,2);assert.match(app.node('chat-log').textContent,/다시 묻기/);
});
