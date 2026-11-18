import {registerHooks} from 'node:module';
import {subscriptionCliHost as realHost} from '../../src/subscription-cli-host.ts';
import {sameCliStamp} from '../../src/cli-launcher.ts';
import {spawnCliRunner} from '../../src/cli-process.ts';

const record=event=>console.log('restore-test '+JSON.stringify(event));
const mode=process.env.RESTORE_CLI_CASE;
// Keep the server entry point's clock still while the database and HTTP fixtures use real I/O.
export function setTimeout(){return {};}
export function clearTimeout(){}

export function subscriptionCliHost(readEnvironment,secrets) {
 const gate=Promise.withResolvers();
 let versions=0;
 process.on('message',message=>{
  if(message==='checkpoint')record('checkpoint');
  if(message==='release'){
   gate.resolve();
   setImmediate(()=>record('discovery-turn-ended'));
  }
  if(message==='reject'){
   gate.reject(new Error('fixture version check failed'));
   setImmediate(()=>record('rejection-turn-ended'));
  }
 });
 const host=realHost(readEnvironment,secrets,{
  home:()=>process.cwd(),
  fixedFolders:()=>[process.cwd()],
  loginShell:()=>'/fixture/login-shell',
  runLoginShell:async()=>{
   record('shell');
   return null;
  },
  versionRunner:async()=>{
   const timedOut=mode==='timed-out';
   record(timedOut?'version-timed-out':'version');
   if(mode==='never'||mode==='late'||(mode==='throws'&&++versions===1))await gate.promise;
   return {spawned:true,exitCode:timedOut?null:0,stdout:timedOut?'':'2.1.0 (Claude Code)',stderr:'',timedOut,aborted:false,overflow:false};
  },
  launcher:{
   ...(process.platform==='darwin'?{}:{prepare:async(policy,call)=>()=> {
    if(!sameCliStamp(policy.command,policy.stamp))throw new Error('Fixture executable changed');
    return call;
   }}),
   runner:async call=>{record(call.command);return spawnCliRunner(call);}
  }
 });
 const discover=host.discover;
 host.discover=(provider,signal)=>{
  record('discover:'+provider);
  return discover(provider,signal);
 };
 return host;
}

const host=new URL('../../src/subscription-cli-host.ts',import.meta.url).href;
const server=new URL('../../src/server.ts',import.meta.url).href;
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===server&&((mode==='never'&&specifier==='node:timers')||
    (specifier==='./subscription-cli-host.ts'&&new URL(specifier,context.parentURL).href===host)))
  return {url:import.meta.url,shortCircuit:true};
 return next(specifier,context);
}});
