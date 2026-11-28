// Preloaded into the live keeper by hold-supervisor-startup.mjs for the runs it names
// "keeper PID <EROFS|ENOENT> <before announce|after failed spawn|after stop>", so the keeper's OWN
// removal of its pid file is what the supervisor answers for.
// EROFS fails that removal as a read-only file system would. ENOENT injects nothing: the test
// removes the real file while the keeper is paused.
// A pause publishes <pid file>.held with the keeper's pid and ends when the test writes <pid file>.release.
import fs from 'node:fs/promises';
import {writeFileSync,renameSync,existsSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';

const mode=process.env.MASSION_TEST_DRAIN_HOLD;
const [,errno,place]=/^keeper PID (EROFS|ENOENT|hold) (before announce|after failed spawn|after stop)$/.exec(mode==='keeper PID late report'?'keeper PID EROFS after stop':mode??'')??[];
const pidFile=process.argv[6];
if(!errno||!pidFile)throw new Error('The keeper fixture requires its mode and the keeper\'s pid file argument');

async function pause(){
 writeFileSync(pidFile+'.held.tmp',String(process.pid));
 renameSync(pidFile+'.held.tmp',pidFile+'.held');
 const deadline=performance.now()+10_000;
 while(!existsSync(pidFile+'.release')){
  if(performance.now()>=deadline)throw new Error('The paused keeper was never released');
  await delay(5);
 }
}
let removalPoint='before announce';
const write=process.stdout.write.bind(process.stdout);
process.stdout.write=(chunk,callback)=>{
 const message=JSON.parse(String(chunk));
 if(message.spawnFailed)removalPoint='after failed spawn';
 if(message.exited!==undefined)removalPoint='after stop';
 if(place==='after failed spawn'&&message.spawning){void pause().then(()=>write(chunk,callback));return true;}
 return write(chunk,callback);
};
const unlink=fs.unlink;
fs.unlink=async file=>{
 if(file===pidFile){
  writeFileSync(pidFile+'.removal-point',removalPoint);
  if(errno==='hold')await pause();
  if(errno==='EROFS')throw Object.assign(new Error('read-only file system'),{code:'EROFS'});
 }
 return unlink(file);
};
if(place!=='after stop'){
 // Run the acknowledgement after all handlers for this signal have returned.
 process.on('SIGTERM',()=>queueMicrotask(()=>writeFileSync(pidFile+'.stopped','yes')));
}
if(place==='before announce'){
 // The pid file is now written; the keeper's next line checks whether it was asked to stop.
 const rename=fs.rename;
 fs.rename=async(from,to)=>{const result=await rename(from,to);if(to===pidFile)await pause();return result;};
}
syncBuiltinESMExports();
