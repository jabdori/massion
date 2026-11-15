import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {control,drainDaemon,launchDaemon,RuntimeStartFailureError} from '../daemon.ts';

const run=promisify(execFile),desktop=join(import.meta.dirname,'..');
const surrealBinary=process.env.MASSION_SURREAL_BINARY??join(desktop,'.runtime','current','surreal');
await access(surrealBinary);
const surrealVersion='4.0.1';
const sha256=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file,{highWaterMark:1<<20}))hash.update(chunk);return hash.digest('hex');};
// The daemon under test must not inherit this test runner's Massion settings.
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MASSION_')));
const runner=join(desktop,'daemon-runner.mjs'),origin='http://127.0.0.1:8765';
const pidRecord=async(directory:string)=>JSON.parse(await readFile(join(directory,'daemon.sock.pid'),'utf8')) as {pid:number;core?:number;database?:number};
function alive(pid?:number){
 if(pid===undefined)return false;
 try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}
async function environmentHas(pid:number,token:string){
 // The output may contain secrets; only the boolean answer is ever used.
 try{const {stdout}=await run('ps',['eww','-p',String(pid),'-o','command=']);return stdout.includes(token);}catch{return false;}
}
async function makeRuntime(root:string,binary=surrealBinary){
 const runtime=join(root,'runtime');await mkdir(runtime);
 await symlink(binary,join(runtime,'surreal'));
 await writeFile(join(runtime,'manifest.json'),JSON.stringify({node:{version:'24.19.0',sha256:'0'.repeat(64)},surreal:{version:surrealVersion,sha256:await sha256(binary)}})+'\n');
 return runtime;
}
async function coreEntry(root:string,stopDelayMs=0){
 const file=join(root,'core-'+stopDelayMs+'.mjs');
 const source=`import {createServer} from 'node:http';
import {closeSync,readFileSync,writeFileSync} from 'node:fs';
import {daemonGuard} from ${JSON.stringify(new URL('../../src/daemon-auth.ts',import.meta.url).href)};
const secret=readFileSync(3,'utf8');closeSync(3);
const database=process.env.MASSION_SURREAL_AUTH_FD==='4'?readFileSync(4,'utf8'):'';if(process.env.MASSION_SURREAL_AUTH_FD==='4')closeSync(4);
writeFileSync(${JSON.stringify(join(root,'core-evidence.json'))},JSON.stringify({endpoint:process.env.MASSION_SURREAL_RPC,passwordLength:database.length}));
const guard=daemonGuard(secret),server=createServer((request,response)=>{if(guard(request,response))response.writeHead(404).end();});
server.once('error',()=>process.exit(3));
server.listen(Number(process.env.MASSION_PORT),'127.0.0.1',()=>writeFileSync(${JSON.stringify(join(root,'core-listening'))},'yes'));
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),${stopDelayMs}));
setInterval(()=>{},1000);`;
 await writeFile(file,source);return file;
}
async function surrealEntry(root:string,stopDelayMs:number){
 const file=join(root,'surreal-'+stopDelayMs+'.mjs');
 const source=`#!${process.execPath}
import {createServer} from 'node:http';
const port=Number(process.argv[process.argv.indexOf('--bind')+1].split(':').pop());
const password=process.env.SURREAL_PASS;
const server=createServer((request,response)=>{
 if(request.url==='/health'){response.writeHead(200).end();return;}
 if(request.url==='/rpc'&&password!==undefined&&request.headers.authorization==='Basic '+Buffer.from('root:'+password).toString('base64')){response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'massion-bootstrap',result:[{result:1,status:'OK'}]}));return;}
 response.writeHead(401).end();
});
server.listen(port,'127.0.0.1',()=>console.log('fixture database ready'));
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),${stopDelayMs}));
setInterval(()=>{},1000);`;
 await writeFile(file,source,{mode:0o755});return file;
}
const start=(root:string,runtime:string,entry:string)=>launchDaemon({node:process.execPath,runner,entry,directory:join(root,'user'),socket:join(root,'user','daemon.sock'),origin,runtimeDirectory:runtime,environment});

test('the bundled runtime starts a password-protected database, reuses the data and passes the password only once through SURREAL_PASS',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-runtime-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 const passwordFile=join(directory,'database','password'),password=await readFile(passwordFile,'utf8');
 assert.equal((await stat(passwordFile)).mode&0o777,0o600);
 assert.deepEqual(JSON.parse(await readFile(join(directory,'database','version'),'utf8')),{surreal:surrealVersion,format:1});
 assert.ok(await stat(join(directory,'database','initialized')).then(()=>true,()=>false),'first creation completes the bootstrap and records it');
 const evidence=JSON.parse(await readFile(join(root,'core-evidence.json'),'utf8'));
 assert.equal(evidence.passwordLength,64,'the core receives the password over the anonymous pipe');
 assert.equal(evidence.endpoint.endsWith('/rpc'),true);
 const firstRecord=await pidRecord(directory);assert.ok(firstRecord.database,'the supervisor records the database child');
 assert.equal(await environmentHas(firstRecord.database,'SURREAL_PASS='),true,'first creation passes the password through the database child environment only');
 assert.equal(await environmentHas(firstRecord.database,'SURREAL_USER=root'),true);
 const query=JSON.stringify({id:'runtime-test',method:'query',params:['RETURN 1',{}]});
 const refused=await fetch(evidence.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:query});
 const refusedBody=await refused.json() as {result?:unknown;error?:unknown};
 assert.equal(refusedBody.result===undefined&&refusedBody.error!==undefined,true,'an unauthenticated request must be refused');
 const allowed=await fetch(evidence.endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from('root:'+password).toString('base64')},body:query});
 assert.equal(Array.isArray((await allowed.json() as {result?:unknown}).result),true,'the stored password authenticates');
 assert.equal((await readFile(join(directory,'daemon.log'),'utf8')).includes(password),false);
 await drainDaemon(join(directory,'daemon.sock'),origin);
 assert.equal(alive(firstRecord.database),false,'the database child is gone after drain');
 await start(root,runtime,entry);
 const statusTwo=await control(join(directory,'daemon.sock'),'status');assert.equal(statusTwo.status,'running');
 const secondRecord=await pidRecord(directory);assert.ok(secondRecord.database);
 assert.equal(await environmentHas(secondRecord.database,'SURREAL_PASS='),false,'later starts pass no password to the database');
 assert.equal(await environmentHas(secondRecord.database,'SURREAL_USER='),false);
 assert.equal(await readFile(passwordFile,'utf8'),password,'the password file is reused, never recreated');
 const evidenceTwo=JSON.parse(await readFile(join(root,'core-evidence.json'),'utf8'));
 assert.equal(evidenceTwo.passwordLength,64);
 await drainDaemon(join(directory,'daemon.sock'),origin);
 assert.equal(alive(secondRecord.database),false);
});

test('an interrupted first creation resumes the bootstrap with the stored password',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-resume-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(join(directory,'database'),{recursive:true,mode:0o700});
 // The previous launch wrote the files but died before the database created its root user: no marker.
 const stored='b'.repeat(64),passwordFile=join(directory,'database','password');
 await writeFile(passwordFile,stored,{mode:0o600});
 await writeFile(join(directory,'database','version'),JSON.stringify({surreal:surrealVersion,format:1})+'\n',{mode:0o600});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 assert.equal(await readFile(passwordFile,'utf8'),stored,'the same stored password is reused, never regenerated');
 const record=await pidRecord(directory);assert.ok(record.database);
 assert.equal(await environmentHas(record.database,'SURREAL_PASS='),true,'the resumed bootstrap hands the stored password to the database again');
 assert.equal(await environmentHas(record.database,'SURREAL_USER=root'),true);
 assert.ok(await stat(join(directory,'database','initialized')).then(()=>true,()=>false),'the completed bootstrap is recorded');
 const evidence=JSON.parse(await readFile(join(root,'core-evidence.json'),'utf8'));
 assert.equal(evidence.passwordLength,64,'the core still receives the stored password over the pipe');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

test('a missing, mis-permissioned or foreign-version data folder refuses to start and stays untouched',async t=>{
 for(const variant of ['missing','mode','version'] as const){
  const root=await mkdtemp(join(await realpath(tmpdir()),'e4-refuse-'));
  const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
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
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await writeFile(join(runtime,'manifest.json'),JSON.stringify({node:{version:'24.19.0',sha256:'0'.repeat(64)},surreal:{version:surrealVersion,sha256:'f'.repeat(64)}})+'\n');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='runtime-damaged'&&error.failure.detail.includes('SHA-256 mismatch'));
 assert.equal((await readdir(directory)).some(name=>name==='database'||name==='db-tmp'),false,'nothing was started or created');
});

test('a failed core start still stops the database',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-core-'));
 const runtime=await makeRuntime(root),entry=join(root,'core-exit.mjs'),directory=join(root,'user');
 await writeFile(entry,'process.exit(3);');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='core-start');
 const failed=await control(join(directory,'daemon.sock'),'status');assert.equal(failed.status,'failed');
 const record=await pidRecord(directory);
 assert.equal(alive(record.database),false,'the database is stopped after a failed core start');
});

test('another process owning the core port reports core-start and stops the database',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-squat-'));
 const fixtureDatabase=await surrealEntry(root,0),runtime=await makeRuntime(root,fixtureDatabase),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 const squatter=createServer(),squatterConnections=new Set<import('node:net').Socket>();
 squatter.on('connection',socket=>{squatterConnections.add(socket);socket.once('close',()=>squatterConnections.delete(socket));});
 squatter.listen(8765,'127.0.0.1');await once(squatter,'listening');
 // A connection the daemon's readiness probe opened may still sit in the squatter's queue; force it shut.
 t.after(async()=>{for(const connection of squatterConnections)connection.destroy();await new Promise<void>(resolve=>squatter.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='core-start','a TCP listener without this daemon\'s key must not count as a started core');
 const failed=await control(join(directory,'daemon.sock'),'status');assert.equal(failed.status,'failed');
 const record=await pidRecord(directory);
 assert.equal(alive(record.database),false,'the database is stopped when the core cannot take its port');
});

test('a slow two-phase shutdown still completes within the drain control budget',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-drain-'));
 const fixtureDatabase=await surrealEntry(root,9000),runtime=await makeRuntime(root,fixtureDatabase),entry=await coreEntry(root,4000),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 const began=Date.now();
 assert.equal((await drainDaemon(join(directory,'daemon.sock'),origin)).status,'drained');
 assert.ok(Date.now()-began>12_000,'both shutdown phases completed: 4 s core plus 9 s database');
});

test('a killed daemon does not leave the database holding the data folder',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-orphan-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 // Discover the children through the supervisor's own bookkeeping, not through process listings.
 const record=await pidRecord(directory);
 assert.ok(record.database);assert.ok(record.core);
 t.after(async()=>{for(const pid of [record.core,record.database])try{process.kill(pid!,'SIGKILL');}catch{}});
 process.kill(record.pid,'SIGKILL');
 await t.waitFor(async()=>{if(alive(record.database))throw new Error('the database survived the supervisor');return true;},{timeout:10_000});
 try{process.kill(record.core!,'SIGTERM');}catch{}
});

