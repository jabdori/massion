import test from 'node:test';
import assert from 'node:assert/strict';
import {browserCommand} from './browser-command.mjs';

const contextError='Failed to install browser network controls: CDP error (Runtime.evaluate): Cannot find default execution context';
const failure=error=>Object.assign(new Error('command failed'),{stdout:JSON.stringify({success:false,error})});

test('returns successful command data',async()=>{
 const result=await browserCommand(async()=>({stdout:JSON.stringify({success:true,data:{ok:true}})}));
 assert.deepEqual(result,{ok:true});
});

test('command failures are never retried, including errors that close the browser',async()=>{
 for(const message of ['other infrastructure error',contextError]){
  let calls=0;const error=failure(message);await assert.rejects(browserCommand(async()=>{calls++;throw error;}),e=>e===error);
  assert.equal(calls,1);
 }
});
