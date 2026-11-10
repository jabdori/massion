import assert from 'node:assert/strict';

export async function browserCommand(run){
 const response=await run();
 const result=JSON.parse(response.stdout);assert.ok(result.success,result.error);return result.data;
}
