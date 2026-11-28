// Preloaded into the live keeper by hold-supervisor-startup.mjs for the runs it names
// "keeper PID <EROFS|ENOENT> <before announce|after failed spawn|after stop>", so the keeper's OWN
// removal of its pid file is what the supervisor answers for.
// EROFS fails that removal as a read-only file system would. ENOENT injects nothing: the test
// removes the real file while the keeper is paused.
// A pause writes <pid file>.held (the keeper's pid) and ends when the test writes <pid file>.release.
import fs from 'node:fs/promises';
import {writeFileSync,existsSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';

const [,errno,place]=/^keeper PID (EROFS|ENOENT) (before announce|after failed spawn|after stop)$/.exec(process.env.MASSION_TEST_DRAIN_HOLD??'')??[];
const pidFile=process.argv[6];
if(!errno||!pidFile)throw new Error('The keeper fixture requires its mode and the keeper\'s pid file argument');

async function pause(){
 writeFileSync(pidFile+'.held',String(process.pid));
 for(let waited=0;!existsSync(pidFile+'.release');await delay(5)){
  if((waited+=5)>=10_000)throw new Error('The paused keeper was never released');
 }
}
if(errno==='EROFS'){
 const unlink=fs.unlink;
 fs.unlink=async file=>{if(file===pidFile)throw Object.assign(new Error('read-only file system'),{code:'EROFS'});return unlink(file);};
}
if(place==='before announce'){
 // The pid file is now written; the keeper's next line checks whether it was asked to stop.
 const rename=fs.rename;
 fs.rename=async(from,to)=>{const result=await rename(from,to);if(to===pidFile)await pause();return result;};
}
if(place==='after failed spawn'){
 // Paused inside the announcement; a stop seen right after it makes the keeper report a failed spawn.
 const write=process.stdout.write.bind(process.stdout);
 process.stdout.write=(chunk,callback)=>{void (async()=>{if(String(chunk)==='{"spawning":true}\n')await pause();return write(chunk,callback);})();return true;};
}
syncBuiltinESMExports();
