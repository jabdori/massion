import assert from 'node:assert/strict';
import type {ChildProcess} from 'node:child_process';
import {readFile,readlink,realpath,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
async function processIdentity(pid:number){
 const raw=await readFile('/proc/'+pid+'/stat','utf8');
 return {parentPid:Number(raw.slice(raw.lastIndexOf(')')+2).split(' ')[1]),argv:(await readFile('/proc/'+pid+'/cmdline','utf8')).split('\0').filter(Boolean),cwd:await readlink('/proc/'+pid+'/cwd')};
}
/** Signals are permitted only for the direct spawn and its exact launch identity. */
export async function verifyOwnedChild(child:ChildProcess,expected:{cwd:string;argv:string[]}){
 assert.ok(child.pid&&child.pid!==process.pid&&child.exitCode===null&&child.signalCode===null);
 const identity=await processIdentity(child.pid);
 assert.equal(identity.parentPid,process.pid);
 assert.equal(identity.cwd,expected.cwd);
 assert.equal(await realpath(expected.cwd),expected.cwd);
 assert.equal(resolve(expected.cwd,'..'),await realpath(tmpdir()));
 assert.match(expected.cwd.split('/').at(-1)!,/^massion-owned-/);
 assert.equal((await stat(expected.cwd)).uid,process.getuid!());
 assert.deepEqual(identity.argv,expected.argv);
 return {pid:child.pid,parentPid:identity.parentPid,temporaryCwd:expected.cwd.split('/').at(-1),argvVerified:true};
}
export async function stopOwnedChild(child:ChildProcess,expected:{cwd:string;argv:string[]}){
 if(child.exitCode!==null||child.signalCode!==null)return;
 await verifyOwnedChild(child,expected);
 const exited=once(child,'exit');child.kill('SIGTERM');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const finished=await Promise.race([exited.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),3000);})]);
  if(!finished&&child.exitCode===null&&child.signalCode===null){await verifyOwnedChild(child,expected);child.kill('SIGKILL');}
  await exited;
 }finally{clearTimeout(timer);}
}
/** Reject unrelated RPC services before any database request or process signal. */
export async function verifyDisposableDatabase(){
 const root=process.env.SURREAL_TEST_RUNTIME!;
 assert.equal(await realpath(root),root);
 assert.equal(resolve(root,'..'),await realpath(tmpdir()));
 assert.match(root.split('/').at(-1)!,/^disposable-/);
 assert.equal((await stat(root)).uid,process.getuid!());
 const metadata=JSON.parse(await readFile(join(root,'server.json'),'utf8'));
 const pid=Number(process.env.SURREAL_TEST_PID);
 assert.ok(Number.isSafeInteger(pid)&&pid>1);
 assert.equal(metadata.pid_in_this_exec_namespace,pid);
 assert.equal(metadata.runtime,root);
 assert.equal(metadata.url+'/rpc',process.env.MASSION_TEST_SURREAL_RPC);
 assert.equal(metadata.version,'3.3.0');
 const identity=await processIdentity(pid);
 assert.equal(await realpath(identity.argv[0]!),await realpath(metadata.binary));
 assert.ok(identity.argv.includes('surrealkv://'+join(root,'data')));
 assert.ok(identity.argv.includes('127.0.0.1:'+new URL(metadata.url).port));
 let ancestor=process.pid,found=false;
 for(let depth=0;depth<12&&ancestor>1;depth++){
  if(ancestor===identity.parentPid){found=true;break;}
  ancestor=(await processIdentity(ancestor)).parentPid;
 }
 assert.ok(found,'Disposable server must belong to this test command’s launcher');
 const launcher=await processIdentity(identity.parentPid);
 assert.equal(await realpath(resolve(launcher.cwd,launcher.argv[1]!)),fileURLToPath(new URL('../../scripts/with-surreal.py',import.meta.url)));
}
