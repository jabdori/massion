import {registerHooks} from 'node:module';
import {subscriptionCliHost as realHost} from '../../src/subscription-cli-host.ts';
import {sameCliStamp} from '../../src/cli-launcher.ts';
import {spawnCliRunner} from '../../src/cli-process.ts';

const record=event=>console.log('restore-test '+JSON.stringify(event));
const recordTimer=event=>console.log('restore-timer '+JSON.stringify(event));
export function setTimeout(callback,delay){
 const expire=message=>{if(message==='expire')callback();};
 process.on('message',expire);
 recordTimer(delay);
 return expire;
}
export function clearTimeout(expire){
 process.off('message',expire);
 recordTimer('cleared');
}

export function subscriptionCliHost(readEnvironment,secrets) {
 const mode=process.env.RESTORE_CLI_CASE;
 const gate=Promise.withResolvers();
 let versions=0;
 process.on('message',message=>{
  if(message==='checkpoint')record('checkpoint');
  if(message==='release')gate.resolve();
 });
 const host=realHost(readEnvironment,secrets,{
  home:()=>process.cwd(),
  fixedFolders:()=>[process.cwd()],
  loginShell:()=>'/fixture/login-shell',
  runLoginShell:async()=>{
   record('discovery');
   return null;
  },
  versionRunner:async call=>{
   if(mode==='throws'){
    record('version');
    if(++versions===1)throw new Error('fixture version check failed');
   }
   if(mode==='held'||mode==='late')await gate.promise;
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
 if(mode==='late'){
  const discover=host.discover;
  host.discover=(...args)=>{
   const pending=discover(...args);
   void pending.then(()=>record(host.run['claude-code-cli/v1']?'installed':'not installed'),()=>record('rejected'));
   return pending;
  };
 }
 return host;
}

const host=new URL('../../src/subscription-cli-host.ts',import.meta.url).href;
const server=new URL('../../src/server.ts',import.meta.url).href;
registerHooks({resolve(specifier,context,next){
 if((specifier==='node:timers'&&context.parentURL===server)||
    (specifier==='./subscription-cli-host.ts'&&new URL(specifier,context.parentURL).href===host))
  return {url:import.meta.url,shortCircuit:true};
 return next(specifier,context);
}});
