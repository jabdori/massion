import {spawn} from 'node:child_process';
import type {CliRunner} from './cli-agent-providers.ts';

/** Default runner: argv only (no shell), own process group, bounded raw bytes, bounded group cleanup on timeout/abort/overflow. */
export const spawnCliRunner:CliRunner=invocation=>new Promise(resolve=>{
 const empty={exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:true,overflow:false};
 if(invocation.signal.aborted){resolve({spawned:false,...empty});return;}
 const out:Buffer[]=[],err:Buffer[]=[];let outBytes=0,errBytes=0,overflow=false,timedOut=false,aborted=false,settled=false,grace:ReturnType<typeof setTimeout>|undefined;
 const child=spawn(invocation.command,[...invocation.args],{cwd:invocation.cwd,env:{...invocation.env},stdio:['pipe','pipe','pipe'],shell:false,detached:true});
 const decode=(chunks:Buffer[])=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{return null;}};
 const finish=(spawned:boolean,exitCode:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);if(grace)clearTimeout(grace);invocation.signal.removeEventListener('abort',onAbort);
  const stdout=decode(out),stderr=decode(err)??'';
  // Invalid UTF-8 after a started process is reported as an overflow-class unknown, never as text.
  resolve({spawned,exitCode,stdout:stdout??'',stderr:stderr.slice(0,8192),timedOut,aborted,overflow:overflow||stdout===null});};
 const signalGroup=(signal:'SIGTERM'|'SIGKILL')=>{if(child.pid!==undefined){try{process.kill(-child.pid,signal);}catch{try{child.kill(signal);}catch{}}}};
 const kill=()=>{if(grace)return;signalGroup('SIGTERM');
  // Closing the direct child does not prove its process group stopped.
  setTimeout(()=>signalGroup('SIGKILL'),100);
  // A descendant may still hold pipes open after the cleanup grace.
  grace=setTimeout(()=>{signalGroup('SIGKILL');child.stdout.destroy();child.stderr.destroy();finish(true,null);},1000);};
 const onAbort=()=>{aborted=true;kill();};
 const timer=setTimeout(()=>{timedOut=true;kill();},invocation.timeoutMs);
 invocation.signal.addEventListener('abort',onAbort,{once:true});if(invocation.signal.aborted)onAbort();
 child.stdout.on('data',(chunk:Buffer)=>{if(overflow)return;outBytes+=chunk.length;if(outBytes>invocation.maxOutputBytes){overflow=true;kill();return;}out.push(chunk);});
 child.stderr.on('data',(chunk:Buffer)=>{if(errBytes<8192){err.push(chunk.subarray(0,8192-errBytes));errBytes+=chunk.length;}});
 // ENOENT/EACCES arrive here before any request could be sent.
 child.on('error',()=>finish(child.pid!==undefined,null));
 child.on('close',code=>finish(true,code));
 child.stdin.on('error',()=>{});child.stdin.end(invocation.stdin);
});
