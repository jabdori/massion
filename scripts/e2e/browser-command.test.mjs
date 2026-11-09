import test from 'node:test';
import assert from 'node:assert/strict';
import {browserCommand} from './browser-command.mjs';

const contextError='Failed to install browser network controls: CDP error (Runtime.evaluate): Cannot find default execution context';
const failure=error=>Object.assign(new Error('command failed'),{stdout:JSON.stringify({success:false,error})});

test('retries the context error once and returns the next result',async()=>{
 let calls=0;const result=await browserCommand(async()=>{if(++calls===1)throw failure(contextError);return {stdout:JSON.stringify({success:true,data:{ok:true}})};});
 assert.equal(calls,2);assert.deepEqual(result,{ok:true});
});

test('other errors and a repeated context error fail',async()=>{
 for(const message of ['other infrastructure error',contextError]){
  let calls=0;await assert.rejects(browserCommand(async()=>{calls++;throw failure(message);}));
  assert.equal(calls,message===contextError?2:1);
 }
});
