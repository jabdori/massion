import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const runner=readFileSync(new URL('../desktop/daemon-runner.mjs',import.meta.url),'utf8');
const budget=runner.match(/^const readinessDeadlineMs=([\d_]+)/m)?.[1];
assert.ok(budget);
const readinessDeadlineMs=Number(budget.replaceAll('_',''));

function waitForCoreAt(readyAt:number):Promise<void>{
 let now=0;
 const origin='http://127.0.0.1:8765',secret='ab'.repeat(32),nonce='cd'.repeat(32);
 const source=runner.slice(runner.indexOf('const coreProof='),runner.indexOf('async function failRuntime('));
 return runInNewContext(source+'\nwaitForCore()',{
  readinessDeadlineMs,origin,secret,Buffer,createHmac,randomBytes,timingSafeEqual,AbortSignal,
  databaseUsable:()=>true,child:{exitCode:null,signalCode:null},
  startFailure:(causeCode:string,detail:string)=>Object.assign(new Error(detail),{causeCode}),
  Date:{now:()=>now},delay:async(ms:number)=>{now+=ms;assert.ok(now<=readyAt,'polling continued after the core was ready');},
  fetch:async(_url:string,{headers}:{headers:Record<string,string>})=>{
   if(now<readyAt)throw new Error('Connection refused');
   const proof=createHmac('sha256',Buffer.from(secret,'hex'))
    .update(JSON.stringify(['massion-desktop-v1','server',origin,headers['X-Massion-Challenge'],nonce])).digest('hex');
   return new Response(null,{status:204,headers:{'x-massion-nonce':nonce,'x-massion-proof':proof}});
  }
 }) as Promise<void>;
}

test('the supervisor accepts a core that authenticates at 32 seconds',async()=>{
 await waitForCoreAt(32_000);
});

test('the supervisor refuses a core that cannot authenticate until 34 seconds',async()=>{
 await assert.rejects(waitForCoreAt(34_000),{causeCode:'core-start'});
});

test('the supervisor readiness budget adds exactly the startup discovery bound to 30 seconds',()=>{
 const server=readFileSync(new URL('../src/server.ts',import.meta.url),'utf8');
 const discovery=server.match(/^const START_DISCOVERY_WAIT=([\d_]+)/m)?.[1];
 assert.ok(discovery);
 assert.equal(readinessDeadlineMs,30_000+Number(discovery.replaceAll('_','')));
});
