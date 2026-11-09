import test from 'node:test';
import assert from 'node:assert/strict';
import {callTool,ToolCallError,TOOL_TIMEOUT_MS} from '../src/tool-call.ts';
import {CliLauncher} from '../src/cli-launcher.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';

test('host timeout cancels an uncooperative read as failed and a write as unknown',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const readOnly of [true,false]){
  let signal:AbortSignal|undefined,calls=0;
  const pending=callTool(s=>{calls++;signal=s;return new Promise(()=>{});},{readOnly});
  const check=assert.rejects(pending,e=>e instanceof ToolCallError&&e.outcome===(readOnly?'failed':'unknown'));
  t.mock.timers.tick(TOOL_TIMEOUT_MS);await check;assert.equal(calls,1);assert.equal(signal?.aborted,true);
 }
});

test('abort before dispatch never calls the tool; abort after dispatch is unknown for writes',async()=>{
 const before=new AbortController();before.abort(new Error('private'));
 await assert.rejects(callTool(async()=>assert.fail('not started'),{signal:before.signal}),e=>e instanceof ToolCallError&&e.outcome==='failed'&&!e.cause&&!e.message.includes('private'));
 const during=new AbortController();let calls=0;
 const pending=callTool(async()=>{calls++;during.abort();return 'late';},{signal:during.signal});
 await assert.rejects(pending,e=>e instanceof ToolCallError&&e.outcome==='unknown');assert.equal(calls,1);
});

test('a timed-out write launch stays single-send across overlap and later replay',async()=>{
 let calls=0;const policy={command:process.execPath,args:['write'],environment:[],secrets:{},readOnly:false,signature:{teamId:'FIXTURE123',identifier:'test.fixture'}};
 const launcher=new CliLauncher(policy,new InMemorySecretSlots(),{prepare:async()=>async()=>{},runner:async()=>{calls++;return new Promise(()=>{});}});
 const invocation={command:process.execPath,args:['write'],stdin:'',cwd:process.cwd(),env:{},timeoutMs:15,maxOutputBytes:1000,signal:new AbortController().signal};
 const [a,b]=await Promise.all([launcher.launch('write-1',invocation),launcher.launch('write-1',invocation)]);
 assert.equal(a.timedOut,true);assert.equal(a.spawned,true);assert.deepEqual(a,b);assert.deepEqual(await launcher.launch('write-1',invocation),a);assert.equal(calls,1);
});

test('owned invocation itself enforces its deadline when the adapter and caller ignore cancellation',async()=>{
 const {invokeOwned}=await import('../src/runtime-lifetime.ts');let signal:AbortSignal|undefined;
 const adapter={descriptor:{provider:'fixture',model:'test',configVersion:'v1',enabled:true,capabilities:['text-output'],evidenceClass:'fixture' as const},invoke:async(request:import('../src/providers.ts').ProviderRequest)=>{signal=request.signal;return new Promise<never>(()=>{});}};
 const startedAt=Date.now(),pending=invokeOwned(adapter,{invocationId:'i',workId:'w',instruction:'fixture',inputReferences:[],signal:new AbortController().signal},{hostSessionId:'h',dispatchId:'d',startedAt,deadlineAt:startedAt+20});
 const observed=await Promise.race([pending,new Promise<'unbounded'>(r=>setTimeout(()=>r('unbounded'),150))]);
 assert.notEqual(observed,'unbounded');assert.equal((observed as {status:string}).status,'unknown');assert.equal(signal?.aborted,true);
});
