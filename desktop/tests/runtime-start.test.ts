import test from 'node:test';
import assert from 'node:assert/strict';
import {access,chmod,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {control,drainDaemon,launchDaemon,RuntimeStartFailureError} from '../daemon.ts';

const run=promisify(execFile),desktop=join(import.meta.dirname,'..');
const surrealBinary=process.env.MASSION_SURREAL_BINARY??join(desktop,'.runtime','current','surreal');
await access(surrealBinary);
const surrealVersion='4.0.1';
const sha256=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file,{highWaterMark:1<<20}))hash.update(chunk);return hash.digest('hex');};
const surrealSha256=await sha256(surrealBinary);
// The daemon under test must not inherit this test runner's Massion settings.
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MASSION_')));
const runner=join(desktop,'daemon-runner.mjs'),origin='http://127.0.0.1:8765';

async function children(parent:number){
 try{return (await run('pgrep',['-P',String(parent)])).stdout.split('\n').filter(Boolean).map(Number);}catch{return [];}
}
async function commandName(pid:number){
 try{return (await run('ps',['-o','comm=','-p',String(pid)])).stdout.trim();}catch{return '';}
}
async function childByName(parent:number,pattern:RegExp){
 for(const pid of await children(parent))if(pattern.test(await commandName(pid)))return pid;
 return undefined;
}
const databaseChild=(parent:number)=>childByName(parent,/surreal/);
const coreChild=(parent:number)=>childByName(parent,/node/);
function alive(pid?:number){
 if(pid===undefined)return false;
 try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}
async function environmentHas(pid:number,token:string){
 // The output may contain secrets; only the boolean answer is ever used.
 try{const {stdout}=await run('ps',['eww','-p',String(pid),'-o','command=']);return stdout.includes(token);}catch{return false;}
}
async function makeRuntime(root:string,sha=surrealSha256){
 const runtime=join(root,'runtime');await mkdir(runtime);
 await symlink(surrealBinary,join(runtime,'surreal'));
 await writeFile(join(runtime,'manifest.json'),JSON.stringify({node:{version:'24.19.0',sha256:'0'.repeat(64)},surreal:{version:surrealVersion,sha256:sha}})+'\n');
 return runtime;
}
async function coreEntry(root:string,behavior:'listen'|'exit'){
 const file=join(root,'core-'+behavior+'.mjs');
 const source=behavior==='exit'?'process.exit(3);':`import {createServer} from 'node:net';import {closeSync,readFileSync,writeFileSync} from 'node:fs';
const database=process.env.MASSION_SURREAL_AUTH_FD==='4'?readFileSync(4,'utf8'):'';if(process.env.MASSION_SURREAL_AUTH_FD==='4')closeSync(4);
writeFileSync(${JSON.stringify(join(root,'core-evidence.json'))},JSON.stringify({endpoint:process.env.MASSION_SURREAL_RPC,passwordLength:database.length}));
const server=createServer();server.listen(Number(process.env.MASSION_PORT),'127.0.0.1',()=>writeFileSync(${JSON.stringify(join(root,'core-listening'))},'yes'));
process.on('SIGTERM',()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),2000);});
setInterval(()=>{},1000);`;
 await writeFile(file,source);return file;
}
const start=(root:string,runtime:string,entry:string)=>launchDaemon({node:process.execPath,runner,entry,directory:join(root,'user'),socket:join(root,'user','daemon.sock'),origin,runtimeDirectory:runtime,environment});

test('the bundled runtime starts a password-protected database, reuses the data and passes the password only once through SURREAL_PASS',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-runtime-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root,'listen'),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 const passwordFile=join(directory,'database','password'),password=await readFile(passwordFile,'utf8');
 assert.equal((await stat(passwordFile)).mode&0o777,0o600);
 assert.deepEqual(JSON.parse(await readFile(join(directory,'database','version'),'utf8')),{surreal:surrealVersion,format:1});
 const evidence=JSON.parse(await readFile(join(root,'core-evidence.json'),'utf8'));
 assert.equal(evidence.passwordLength,64,'the core receives the password over the anonymous pipe');
 assert.equal(evidence.endpoint.endsWith('/rpc'),true);
 const databaseOne=await databaseChild(status.pid!);assert.ok(databaseOne,'database child is running');
 assert.equal(await environmentHas(databaseOne,'SURREAL_PASS='),true,'first creation passes the password through the database child environment only');
 assert.equal(await environmentHas(databaseOne,'SURREAL_USER=root'),true);
 const query=JSON.stringify({id:'runtime-test',method:'query',params:['RETURN 1',{}]});
 const refused=await fetch(evidence.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:query});
 const refusedBody=await refused.json() as {result?:unknown;error?:unknown};
 assert.equal(refusedBody.result===undefined&&refusedBody.error!==undefined,true,'an unauthenticated request must be refused');
 const allowed=await fetch(evidence.endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from('root:'+password).toString('base64')},body:query});
 assert.equal(Array.isArray((await allowed.json() as {result?:unknown}).result),true,'the stored password authenticates');
 assert.equal((await readFile(join(directory,'daemon.log'),'utf8')).includes(password),false);
 await drainDaemon(join(directory,'daemon.sock'),origin);
 assert.equal(alive(databaseOne),false,'the database child is gone after drain');
 await start(root,runtime,entry);
 const statusTwo=await control(join(directory,'daemon.sock'),'status');assert.equal(statusTwo.status,'running');
 const databaseTwo=await databaseChild(statusTwo.pid!);assert.ok(databaseTwo);
 assert.equal(await environmentHas(databaseTwo,'SURREAL_PASS='),false,'later starts pass no password to the database');
 assert.equal(await environmentHas(databaseTwo,'SURREAL_USER='),false);
 assert.equal(await readFile(passwordFile,'utf8'),password,'the password file is reused, never recreated');
 const evidenceTwo=JSON.parse(await readFile(join(root,'core-evidence.json'),'utf8'));
 assert.equal(evidenceTwo.passwordLength,64);
 await drainDaemon(join(directory,'daemon.sock'),origin);
 assert.equal(alive(databaseTwo),false);
});

test('a missing, mis-permissioned or foreign-version data folder refuses to start and stays untouched',async t=>{
 for(const variant of ['missing','mode','version'] as const){
  const root=await mkdtemp(join(await realpath(tmpdir()),'e4-refuse-'));
  const runtime=await makeRuntime(root),entry=await coreEntry(root,'listen'),directory=join(root,'user');
  await mkdir(join(directory,'database'),{recursive:true,mode:0o700});
  const expected=variant==='version'?'data-version':'data-credential';
  if(variant!=='missing')await writeFile(join(directory,'database','password'),'a'.repeat(64),{mode:variant==='mode'?0o644:0o600});
  await writeFile(join(directory,'database','version'),JSON.stringify(variant==='version'?{surreal:'3.3.0',format:1}:{surreal:surrealVersion,format:1})+'\n',{mode:0o600});
  const before=await readdir(join(directory,'database'));
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause===expected&&!error.failure.detail.includes('aaaa')&&!error.failure.detail.includes(root));
  assert.deepEqual(await readdir(join(directory,'database')),before);
  assert.equal((await readdir(directory)).includes('db-tmp'),false,'no temporary folder is created');
 }
});

test('a manifest hash mismatch refuses to start anything',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-damaged-'));
 const runtime=await makeRuntime(root,'f'.repeat(64)),entry=await coreEntry(root,'listen'),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='runtime-damaged'&&error.failure.detail.includes('SHA-256 mismatch'));
 assert.equal((await readdir(directory)).some(name=>name==='database'||name==='db-tmp'),false,'nothing was started or created');
});

test('a failed core start still stops the database',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-core-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root,'exit'),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='core-start');
 const failed=await control(join(directory,'daemon.sock'),'status');assert.equal(failed.status,'failed');
 assert.equal(await databaseChild(failed.pid!),undefined,'the database is stopped after a failed core start');
});

test('a killed daemon does not leave the database holding the data folder',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-orphan-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root,'listen'),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 const database=await databaseChild(status.pid!),core=await coreChild(status.pid!);
 assert.ok(database);assert.ok(core);
 t.after(async()=>{for(const pid of [core,database])try{process.kill(pid!,'SIGKILL');}catch{}});
 process.kill(status.pid!,'SIGKILL');
 await t.waitFor(async()=>{if(alive(database))throw new Error('the database survived the supervisor');return true;},{timeout:10_000});
 try{process.kill(core!,'SIGTERM');}catch{}
});

