import {workerCommand} from '../src/app-sandbox.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AppsService,APPS_ID,applyApps} from '../src/apps.ts';
import {GITHUB_APP} from '../src/app-catalog.ts';
import {InMemoryStore} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

async function setup(){
 const store=new InMemoryStore<any>(),slots=new InMemorySecretSlots();
 let members=[{id:'member-a',name:'A',archived:false},{id:'member-b',name:'B',archived:true}],writes=0;
 const options={members:async()=>members,secrets:{set:async(ref:any,value:string)=>{writes++;await slots.set(ref,value);}},clock:()=>100};
 const service=new AppsService(store,options);
 await service.act({commandId:'install',action:'install',catalogId:'github'});
 await service.decide({commandId:'approve',decisionId:(await service.decisions(null))[0]!.id,answer:'act'});
 return {store,slots,options,service,get writes(){return writes;},setMembers:(next:typeof members)=>{members=next;}};
}

test('member bindings require admitted active members and preserve replay after archive',async()=>{
 const f=await setup(),input={commandId:'bind',action:'bind-members',appId:'app-github',memberIds:['member-a']};
 for(const memberIds of [['missing'],['member-b'],['member-a','member-a']])await assert.rejects(f.service.act({...input,memberIds}),/member|binding/i);
 await f.service.act(input);let read=await f.service.read() as any;
 assert.deepEqual(read.availableMembers,[{id:'member-a',name:'A'}]);
 assert.deepEqual(read.apps[0].memberIds,['member-a']);assert.deepEqual(read.apps[0].members,[{id:'member-a',name:'A'}]);
 f.setMembers([{id:'member-a',name:'A',archived:true}]);
 assert.equal((await f.service.act(input)).status,'replayed');read=await f.service.read();assert.deepEqual(read.apps[0].members,[]);
 assert.deepEqual(read.apps[0].memberIds,['member-a']);validateMissionJournalLineage(f.store.inspect() as any);
});

test('app member read preserves the owner binding order rather than the roster order',async()=>{
 const f=await setup();f.setMembers([{id:'member-a',name:'A',archived:false},{id:'member-b',name:'B',archived:false}]);
 await f.service.act({commandId:'ordered-bind',action:'bind-members',appId:'app-github',memberIds:['member-b','member-a']});
 assert.deepEqual((await f.service.read()).apps[0]!.members.map(m=>m.name),['B','A']);
});

test('binding lookup after a stale load replays the overlapping command',async()=>{
 const f=await setup();let release!:()=>void,loaded!:()=>void;
 const waiting=new Promise<void>(r=>loaded=r),gate=new Promise<void>(r=>release=r);let hold=true;
 const store=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{const s=await target.load(id);if(id===APPS_ID&&hold){hold=false;loaded();await gate;}return s;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const service=new AppsService(store,f.options),input={commandId:'overlap',action:'bind-members',appId:'app-github',memberIds:['member-a']};
 const first=service.act(input);await waiting;assert.equal((await f.service.act(input)).status,'committed');release();assert.equal((await first).status,'replayed');
 assert.equal(f.store.inspect().filter(o=>o.commandId===input.commandId).length,1);
});

test('reconnect uses the existing decision and secret slot, saved is not validity, expiry is identity scoped',async()=>{
 const f=await setup();let read=await f.service.read() as any;assert.equal(read.apps[0].credential.state,'missing');
 await f.service.act({commandId:'reconnect',action:'reconnect',appId:'app-github'});
 const decision=(await f.service.decisions(null)).find(d=>d.state==='open')!;assert.ok(decision.connection);assert.equal(decision.connection.slot,'github-token');
 await assert.rejects(f.service.decide({commandId:'bypass',decisionId:decision.id,answer:'act'}),/token|connect/i);
 const input={commandId:'save',decisionId:decision.id,token:'private-lifecycle-sentinel'};
 const results=await Promise.all([f.service.connect(input),f.service.connect(input)]);assert.ok(results.every(r=>['committed','replayed'].includes(r.status)));assert.equal(f.writes,1);
 read=await f.service.read();assert.deepEqual(read.apps[0].credential,{slot:'github-token',state:'saved',at:100,connectionId:'save'});
 assert.equal(await f.slots.read({owner:'app-github',slot:'github-token'}),input.token);
 await (f.service as any).expireCredential({commandId:'assistant-app-expired',appId:'app-github',connectionId:'save'});
 assert.equal((await f.service.read() as any).apps[0].credential.state,'expired');
 await f.service.act({commandId:'reconnect-next',action:'reconnect',appId:'app-github'});
 const next=(await f.service.decisions(null)).find(d=>d.state==='open')!;await f.service.connect({commandId:'save-next',decisionId:next.id,token:'replacement-sentinel'});
 await assert.rejects((f.service as any).expireCredential({commandId:'assistant-app-stale-expiry',appId:'app-github',connectionId:'save'}),/changed|credential/i);
 assert.equal((await f.service.read() as any).apps[0].credential.state,'saved');
 const serialized=JSON.stringify([f.store.inspect(),await f.service.read(),await f.service.decisions(null),results]);assert.ok(!serialized.includes(input.token));assert.ok(!serialized.includes('replacement-sentinel'));
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('unknown secret write survives restart and refuses a new reconnect or dispatch',async()=>{
 const f=await setup();let writes=0;const service=new AppsService(f.store,{...f.options,secrets:{set:async()=>{writes++;throw Error('private-error-sentinel');}}});
 await service.act({commandId:'reconnect',action:'reconnect',appId:'app-github'});const decision=(await service.decisions(null)).find(d=>d.state==='open')!;
 const input={commandId:'unknown-save',decisionId:decision.id,token:'private-token-sentinel'};assert.equal((await service.connect(input)).status,'unknown');
 const restarted=new AppsService(f.store,{...f.options,secrets:{set:async()=>{writes++;}}});
 assert.equal((await restarted.connect(input)).status,'unknown');assert.equal(writes,1);assert.equal((await restarted.read() as any).apps[0].credential.state,'unknown');
 await assert.rejects(restarted.act({commandId:'new-reconnect',action:'reconnect',appId:'app-github'}),/pending|unknown|unresolved/i);
 assert.ok(!JSON.stringify([f.store.inspect(),await restarted.read()]).includes('sentinel'));
});

test('drain rejects binding and reconnect writes before the secret adapter',async()=>{
 const f=await setup();const guarded=new Proxy(f.store,{get(target,key){if(key==='commit')return async()=>{throw Error('Host draining');};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const service=new AppsService(guarded,{...f.options,admit:async()=>{throw Error('Host draining');}});
 await assert.rejects(service.act({commandId:'bind-drain',action:'bind-members',appId:'app-github',memberIds:['member-a']}),/drain/i);
 await assert.rejects(service.act({commandId:'reconnect-drain',action:'reconnect',appId:'app-github'}),/drain/i);assert.equal(f.writes,0);
});

test('member callback supports nullable archive timestamps and never admits archived members',async()=>{
 const f=await setup(),members=[{id:'active',name:'Active',archivedAt:null},{id:'archived',name:'Archived',archivedAt:50}];
 const service=new AppsService(f.store,{...f.options,members:async()=>members});assert.deepEqual((await service.read()).availableMembers,[{id:'active',name:'Active'}]);
 await assert.rejects(service.act({commandId:'archived-bind',action:'bind-members',appId:'app-github',memberIds:['archived']}),/nonarchived/);
 await service.act({commandId:'active-bind',action:'bind-members',appId:'app-github',memberIds:['active']});
 assert.deepEqual((await service.read()).apps[0]!.members,[{id:'active',name:'Active'}]);
});

test('drain after a durable connection claim prevents the secret effect',async()=>{
 const f=await setup();await f.service.act({commandId:'reconnect',action:'reconnect',appId:'app-github'});const decision=(await f.service.decisions(null)).find(d=>d.state==='open')!;
 let service!:AppsService;
 const guarded=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.commandId==='drain-claim')service.beginDrain();return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 service=new AppsService(guarded,f.options);assert.equal((await service.connect({commandId:'drain-claim',decisionId:decision.id,token:'private-drain-sentinel'})).status,'unknown');assert.equal(f.writes,0);
});


test('legacy connection completion replays without adding new credential metadata',async()=>{
 const owner={id:'local-owner',roles:['owner' as const]},time={observedAt:100},pkg=structuredClone(GITHUB_APP);pkg.manifest.connection={slot:'github-token'};
 const state=applyApps(null,{type:'offer-app',origin:'catalog',pkg,decisionId:'app-decision:legacy'},owner,time).value,decision=state.decisions[0]!;
 const claimed=applyApps(state,{type:'begin-app-connect',decisionId:decision.id,connectionId:'legacy-connect'},owner,time).value;
 const completed=applyApps(claimed,{type:'complete-app-connect',decisionId:decision.id,connectionId:'legacy-connect'},owner,time).value;
 assert.equal(completed.apps[0]!.credential,undefined);assert.equal(completed.decisions.find(d=>d.id===decision.id)!.state,'done');
 const store=new InMemoryStore<any>(),slots=new InMemorySecretSlots(),ref={owner:'app-github',slot:'github-token'};
 await store.commit({id:APPS_ID,expectedRevision:0,commandId:'legacy-snapshot',fingerprint:'legacy',value:completed,events:[],outbox:[]});
 await slots.set(ref,'private-legacy-sentinel');
 const service=new AppsService(store,{secrets:{set:async()=>assert.fail('Settings must not rewrite the token'),has:slots.has.bind(slots)}}),journal=store.inspect();
 assert.deepEqual((await service.read()).apps[0]!.credential,{slot:ref.slot,state:'saved'});
 await slots.delete(ref);assert.equal((await service.read()).apps[0]!.credential!.state,'missing');
 assert.deepEqual(store.inspect(),journal);assert.equal((await store.load(APPS_ID))!.value.apps[0].credential,undefined);
});

test('GitHub reads record invalid credentials from the exact authenticated response without claiming expiry',{skip:workerCommand()===null&&'no network sandbox on this host'},async()=>{
 const f=await setup();await f.service.act({commandId:'reconnect-network',action:'reconnect',appId:'app-github'});
 const decision=(await f.service.decisions(null)).find(d=>d.state==='open')!;await f.service.connect({commandId:'network-key',decisionId:decision.id,token:'never-render-token'});
 const service=new AppsService(f.store,{...f.options,network:async()=>({status:401,body:JSON.stringify({message:'Bad credentials',documentation_url:'https://docs.github.com/rest'})})});
 await assert.rejects(service.view({app:'app-github',handler:'page'}));
 assert.equal((await service.read()).apps[0]!.credential!.state,'invalid');assert.doesNotMatch(JSON.stringify(f.store.inspect()),/never-render-token/);validateMissionJournalLineage(f.store.inspect());
});
