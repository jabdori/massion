import {once} from 'node:events';
import {registerHooks} from 'node:module';
import {subscriptionCliHost as realHost} from '../../src/subscription-cli-host.ts';
import {sameCliStamp} from '../../src/cli-launcher.ts';
import {spawnCliRunner} from '../../src/cli-process.ts';

export function subscriptionCliHost(readEnvironment,secrets) {
 const mode=process.env.RESTORE_CLI_CASE;
 const pending=mode==='held'?once(process,'message'):undefined;
 const record=event=>console.log('restore-test '+JSON.stringify(event));
 process.on('message',message=>{if(message==='checkpoint')record('checkpoint');});
 return realHost(readEnvironment,secrets,{
  home:()=>process.cwd(),
  fixedFolders:()=>[process.cwd()],
  loginShell:()=>'/fixture/login-shell',
  runLoginShell:async()=>{
   record('discovery');
   if(mode==='throws')throw new Error('fixture discovery failed');
   return null;
  },
  versionRunner:async call=>{
   await pending;
   const result=await spawnCliRunner(call);
   if(result.timedOut)record('version-timed-out');
   return result;
  },
  launcher:{
   ...(process.platform==='darwin'?{}:{prepare:async(policy,call)=>()=> {
    if(!sameCliStamp(policy.command,policy.stamp))throw new Error('Fixture executable changed');
    return call;
   }}),
   runner:async call=>{record(call.command);return spawnCliRunner(call);}
  }
 });
}

const host=new URL('../../src/subscription-cli-host.ts',import.meta.url).href;
registerHooks({resolve(specifier,context,next){
 if(specifier==='./subscription-cli-host.ts'&&new URL(specifier,context.parentURL).href===host)
  return {url:import.meta.url,shortCircuit:true};
 return next(specifier,context);
}});
