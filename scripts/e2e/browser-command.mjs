import assert from 'node:assert/strict';

export async function browserCommand(run){
 let response;
 try{response=await run();}catch(error){
  let result;try{result=JSON.parse(error.stdout);}catch{throw error;}
  if(result.success!==false||result.error!=='Failed to install browser network controls: CDP error (Runtime.evaluate): Cannot find default execution context')throw error;
  await new Promise(resolve=>setTimeout(resolve,200));response=await run();
 }
 const result=JSON.parse(response.stdout);assert.ok(result.success,result.error);return result.data;
}
