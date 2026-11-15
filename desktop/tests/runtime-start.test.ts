import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {control,drainDaemon,launchDaemon,planRuntimeStart,prepareControl,RuntimeStartFailureError} from '../daemon.ts';

const run=promisify(execFile),desktop=join(import.meta.dirname,'..');
const surrealBinary=process.env.MASSION_SURREAL_BINARY??join(desktop,'.runtime','current','surreal');
await access(surrealBinary);
const surrealVersion='4.0.1';
const sha256=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file,{highWaterMark:1<<20}))hash.update(chunk);return hash.digest('hex');};
const surrealSha256=await sha256(surrealBinary);
// The daemon under test must not inherit this test runner's Massion settings.
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MASSION_')));
// A quiet port: 8765 is contended by other development processes on shared machines.
const corePort=18765,runner=join(desktop,'daemon-runner.mjs'),origin='http://127.0.0.1:'+corePort;
const pidRecord=async(directory:string)=>JSON.parse(await readFile(join(directory,'daemon.sock.pid'),'utf8')) as {pid:number;core?:number;keeper?:number;database?:number};
function alive(pid?:number){
 if(pid===undefined)return false;
 try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}
async function environmentHas(pid:number,token:string){
 // The output may contain secrets; only the boolean answer is ever used.
 try{const {stdout}=await run('ps',['eww','-p',String(pid),'-o','command=']);return stdout.includes(token);}catch{return false;}
}
const digestOf=(salt:string,password:string)=>createHash('sha256').update(Buffer.from(salt,'hex')).update(password).digest('hex');
async function makeRuntime(root:string,binary=surrealBinary){
 const runtime=join(root,'runtime');await mkdir(runtime);
 await symlink(binary,join(runtime,'surreal'));
 await writeFile(join(runtime,'manifest.json'),JSON.stringify({node:{version:'24.19.0',sha256:'0'.repeat(64)},surreal:{version:surrealVersion,sha256:await sha256(binary)}})+'\n');
 return runtime;
}
async function coreEntry(root:string,stopDelayMs=0){
 const file=join(root,'core-'+stopDelayMs+'-'+Math.random().toString(16).slice(2,6)+'.mjs');
 const source=`import {createServer} from 'node:http';
import {closeSync,readFileSync,writeFileSync} from 'node:fs';
import {daemonGuard} from ${JSON.stringify(new URL('../../src/daemon-auth.ts',import.meta.url).href)};
const secret=readFileSync(3,'utf8');closeSync(3);
const database=process.env.MASSION_SURREAL_AUTH_FD==='4'?readFileSync(4,'utf8'):'';if(process.env.MASSION_SURREAL_AUTH_FD==='4')closeSync(4);
writeFileSync(${JSON.stringify(join(root,'core-evidence.json'))},JSON.stringify({endpoint:process.env.MASSION_SURREAL_RPC,passwordLength:database.length}));
const guard=daemonGuard(secret),server=createServer((request,response)=>{if(guard(request,response))response.writeHead(404).end();});
server.once('error',error=>{console.error('core listen failed',error.code);process.exit(3);});
server.listen(Number(process.env.MASSION_PORT),'127.0.0.1',()=>writeFileSync(${JSON.stringify(join(root,'core-listening'))},'yes'));
process.on('SIGTERM',()=>{console.error('core SIGTERM');setTimeout(()=>process.exit(0),${stopDelayMs});});
setInterval(()=>{},1000);`;
 await writeFile(file,source);return file;
}
async function surrealEntry(root:string,options:{stopDelayMs?:number,hangOnSigterm?:boolean,portFile?:string,ackFile?:string}={}){
 const file=join(root,'surreal-'+Math.random().toString(16).slice(2,8)+'.mjs');
 const portBlock=options.portFile
  ?'writeFileSync('+JSON.stringify(options.portFile)+',String(port));(async()=>{for(;;){try{await access('+JSON.stringify(options.ackFile)+');break;}catch{await delay(50);}}serve();})();'
  :'serve();';
 const stopBlock=options.hangOnSigterm
  ?'/* this fixture ignores SIGTERM; only SIGKILL ends it */'
  :'setTimeout(()=>process.exit(0),'+(options.stopDelayMs??0)+');';
 const lines=[
  '#!'+process.execPath,
  "import {createServer} from 'node:http';",
  "import {writeFileSync} from 'node:fs';",
  "import {access} from 'node:fs/promises';",
  "import {setTimeout as delay} from 'node:timers/promises';",
  "const port=Number(process.argv[process.argv.indexOf('--bind')+1].split(':').pop());",
  'const password=process.env.SURREAL_PASS;',
  'const serve=()=>{',
  ' const server=createServer((request,response)=>{',
  "  if(request.url==='/health'){response.writeHead(200).end();return;}",
  "  if(request.url==='/rpc'&&password!==undefined&&request.headers.authorization==='Basic '+Buffer.from('root:'+password).toString('base64')){response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'massion-bootstrap',result:[{result:1,status:'OK'}]}));return;}",
  '  response.writeHead(401).end();',
  ' });',
  " server.once('error',()=>process.exit(3));",
  " server.listen(port,'127.0.0.1',()=>console.log('INFO fixture: Started web server on 127.0.0.1:'+port));",
  '};',
  portBlock,
  "process.on('SIGTERM',()=>{"+stopBlock+'});',
  'setInterval(()=>{},1000)'];
 await writeFile(file,lines.join('\n')+'\n',{mode:0o755});return file;
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
 const marker=JSON.parse(await readFile(join(directory,'database','initialized'),'utf8'));
 assert.equal(typeof marker.salt==='string'&&/^[a-f0-9]{32}$/.test(marker.salt),true,'the initialization marker stores a salt');
 assert.equal(typeof marker.digest==='string'&&/^[a-f0-9]{64}$/.test(marker.digest),true,'the initialization marker stores a salted password digest');
 assert.equal(marker.digest,digestOf(marker.salt,password));
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
 const marker=JSON.parse(await readFile(join(directory,'database','initialized'),'utf8'));
 assert.equal(marker.digest,digestOf(marker.salt,stored),'the completed bootstrap records the salted digest');
 const evidence=JSON.parse(await readFile(join(root,'core-evidence.json'),'utf8'));
 assert.equal(evidence.passwordLength,64,'the core still receives the stored password over the pipe');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

// Only what this feature could write: the database folder subtree plus the temporary folder and keeper pid file.
async function dataFootprint(directory:string){
 const database=await readdir(join(directory,'database'),{recursive:true}).catch(()=>[] as string[]);
 const created=(await readdir(directory)).filter(name=>name==='db-tmp'||name==='database.pid');
 return JSON.stringify([...database.map(String).sort(),...created.sort()]);
}

test('a missing, mis-permissioned, foreign-version, wrong-password or planted-folder data folder refuses to start and stays untouched',async t=>{
 for(const variant of ['missing','mode','version','wrong-password','folder-mode','folder-symlink','temporary-symlink'] as const){
  const root=await mkdtemp(join(await realpath(tmpdir()),'e4-refuse-'));
  const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
  await mkdir(directory,{mode:0o700});
  const expected=variant==='version'?'data-version':'data-credential';
  if(variant==='folder-symlink'||variant==='temporary-symlink'){
   const elsewhere=join(root,'elsewhere');await mkdir(elsewhere,{mode:0o700});
   await symlink(elsewhere,join(directory,variant==='folder-symlink'?'database':'db-tmp'));
  }
  if(variant!=='folder-symlink'&&variant!=='temporary-symlink'){
   if(variant==='folder-mode')await mkdir(join(directory,'database'),{mode:0o755});
   else await mkdir(join(directory,'database'),{recursive:true,mode:0o700});
   if(variant!=='folder-mode'){
    if(variant!=='missing')await writeFile(join(directory,'database','password'),variant==='wrong-password'?'c'.repeat(64):'a'.repeat(64),{mode:variant==='mode'?0o644:0o600});
    await writeFile(join(directory,'database','version'),JSON.stringify(variant==='version'?{surreal:'3.3.0',format:1}:{surreal:surrealVersion,format:1})+'\n',{mode:0o600});
    if(variant==='wrong-password'){
     const salt=randomBytes(16).toString('hex');
     await writeFile(join(directory,'database','initialized'),JSON.stringify({surreal:surrealVersion,format:1,salt,digest:digestOf(salt,'d'.repeat(64))})+'\n',{mode:0o600});
    }
   }
  }
  const before=await dataFootprint(directory);
  await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause===expected&&!error.failure.detail.includes('aaaa')&&!error.failure.detail.includes('cccc'));
  assert.deepEqual(await dataFootprint(directory),before,'nothing is written on refusal');
 }
});

test('a manifest hash mismatch refuses to start anything',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-damaged-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 await writeFile(join(runtime,'manifest.json'),JSON.stringify({node:{version:'24.19.0',sha256:'0'.repeat(64)},surreal:{version:surrealVersion,sha256:'f'.repeat(64)}})+'\n');
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='runtime-damaged'&&error.failure.detail.includes('SHA-256 mismatch'));
 assert.equal((await readdir(directory)).some(name=>name==='database'||name==='db-tmp'),false,'nothing was started or created');
});

test('the database password is never sent to a port squatter between probe and bind',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-portrace-'));
 const portFile=join(root,'port'),ackFile=join(root,'ack');
 const fixture=await surrealEntry(root,{portFile,ackFile}),runtime=await makeRuntime(root,fixture),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 const received:string[]=[],squatter=createServer();
 squatter.on('connection',connection=>connection.on('data',chunk=>received.push(chunk.toString())));
 t.after(async()=>{squatter.close();await rm(root,{recursive:true,force:true});});
 await assert.rejects((async()=>{
  const launching=start(root,runtime,entry);
  // Wait for the fixture to publish the port the daemon chose, then take it before the fixture binds.
  for(let n=0;n<200;n++){
   try{const port=Number(await readFile(portFile,'utf8'));squatter.listen(port,'127.0.0.1');await once(squatter,'listening');break;}
   catch{await new Promise(resolve=>setTimeout(resolve,50));}
  }
  await writeFile(ackFile,'go');
  return await launching;
 })(),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start');
 assert.equal(received.join('').match(/authorization|basic /i)!==null,false,'the squatter must not receive any credential');
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
 assert.equal(alive(record.keeper),false,'the keeper is stopped after a failed core start');
});

test('another process owning the core port reports core-start and stops the database',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-squat-'));
 const fixtureDatabase=await surrealEntry(root),runtime=await makeRuntime(root,fixtureDatabase),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 const squatter=createServer(),squatterConnections=new Set<import('node:net').Socket>();
 squatter.on('connection',socket=>{squatterConnections.add(socket);socket.once('close',()=>squatterConnections.delete(socket));});
 squatter.listen(corePort,'127.0.0.1');await once(squatter,'listening');
 t.after(async()=>{for(const connection of squatterConnections)connection.destroy();await new Promise<void>(resolve=>squatter.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='core-start','a TCP listener without this daemon\'s key must not count as a started core');
 const failed=await control(join(directory,'daemon.sock'),'status');assert.equal(failed.status,'failed');
 const record=await pidRecord(directory);
 assert.equal(alive(record.database),false,'the database is stopped when the core cannot take its port');
});

test('a slow two-phase shutdown still completes within the drain control budget',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-drain-'));
 const fixtureDatabase=await surrealEntry(root,{hangOnSigterm:true}),runtime=await makeRuntime(root,fixtureDatabase),entry=await coreEntry(root,10_500),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 const began=Date.now();
 assert.equal((await drainDaemon(join(directory,'daemon.sock'),origin)).status,'drained');
 const elapsed=Date.now()-began;
 assert.ok(elapsed>20_000,'both shutdown phases ran: a 10.5 s core plus a database that only SIGKILL ends');
 assert.ok(elapsed<45_000,'the drain stays inside the control budget');
});

test('a killed daemon never leaves the database holding the data folder',async t=>{
 // A port private to this run: development machines carry fixture cores from other sessions.
 const runPort=17000+(process.pid%1000)*7,runOrigin='http://127.0.0.1:'+runPort;
 const startHere=(hereRoot:string,hereRuntime:string,hereEntry:string)=>launchDaemon({node:process.execPath,runner,entry:hereEntry,directory:join(hereRoot,'user'),socket:join(hereRoot,'user','daemon.sock'),origin:runOrigin,runtimeDirectory:hereRuntime,environment});
 for(const moment of ['database-started','running','shutdown'] as const){
  const root=await mkdtemp(join(await realpath(tmpdir()),{['database-started']:'e4-oa',['running']:'e4-ob',['shutdown']:'e4-oc'}[moment]+'-'));
  const fixture=moment==='shutdown';
  const runtime=await makeRuntime(root,fixture?await surrealEntry(root,{hangOnSigterm:true}):surrealBinary);
  const entry=await coreEntry(root,fixture?200:0),directory=join(root,'user');
  await mkdir(directory,{mode:0o700});
  let orphanRecord:{pid:number;core?:number;keeper?:number;database?:number}|undefined;
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  await startHere(root,runtime,entry).catch(async (error:unknown)=>{
   const log=await readFile(join(directory,'daemon.log'),'utf8').catch(()=>'(no log)');
   throw new Error((error as Error).message+'; daemon log tail: '+log.slice(-300),{cause:error});
  });
  const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
  const record=await pidRecord(directory);assert.ok(record.keeper);assert.ok(record.database);
  orphanRecord=record;
  t.after(async()=>{for(const pid of [orphanRecord?.core,orphanRecord?.keeper,orphanRecord?.database])try{process.kill(pid!,'SIGKILL');}catch{}await rm(root,{recursive:true,force:true});});
  if(moment==='shutdown'){
   void control(join(directory,'daemon.sock'),'drain').catch(()=>{});
   // Kill the daemon once the core has exited and only the database stop remains.
   for(let n=0;n<400;n++){if(!alive(record.core))break;await new Promise(resolve=>setTimeout(resolve,50));}
   assert.equal(alive(record.core),false,'the core has stopped before the daemon is killed');
  }
  process.kill(record.pid,'SIGKILL');
  await t.waitFor(async()=>{
   if(alive(record.database))throw new Error('the database survived the supervisor');
   if(alive(record.keeper))throw new Error('the keeper survived the supervisor');
   return true;
  },{timeout:25_000});
  assert.equal(await stat(join(directory,'database.pid')).then(()=>true,()=>false),false,'the keeper removed its pid file');
  // The daemon's death orphans its fixture core; take the port back before the next moment.
  try{process.kill(record.core!,'SIGKILL');}catch{}
  for(let n=0;n<100;n++){if(!alive(record.core))break;await new Promise(resolve=>setTimeout(resolve,50));}
  if(moment==='database-started'){
   await prepareControl(join(directory,'daemon.sock'));
   await startHere(root,runtime,entry);
   const restarted=await control(join(directory,'daemon.sock'),'status');assert.equal(restarted.status,'running','the data folder is free for the next start');
   await drainDaemon(join(directory,'daemon.sock'),runOrigin);
  }
 }
});

test('a packaged start ignores the developer overrides; an unpackaged start honors them',async()=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-plan-'));
 const runtime=join(root,'runtime');await mkdir(runtime);
 const overrides={...environment,MASSION_NODE_BINARY:'/tmp/elsewhere/node',MASSION_SURREAL_RPC:'http://127.0.0.1:9/foreign/rpc'};
 const packaged=planRuntimeStart({packaged:true,runtimeDirectory:runtime,environment:overrides});
 assert.equal(packaged.node,join(runtime,'node'),'a packaged app always runs the bundled Node');
 assert.deepEqual([packaged.verifyNode,packaged.verifySurreal,packaged.managedDatabase],[true,true,true],'both executables are verified and the database is always managed');
 assert.equal(packaged.environment.MASSION_NODE_BINARY,undefined);
 assert.equal(packaged.environment.MASSION_SURREAL_RPC,undefined);
 const dev=planRuntimeStart({packaged:false,runtimeDirectory:runtime,environment:overrides});
 assert.equal(dev.node,'/tmp/elsewhere/node');
 assert.deepEqual([dev.verifyNode,dev.verifySurreal,dev.managedDatabase],[false,false,false]);
 assert.equal(dev.environment.MASSION_SURREAL_RPC,'http://127.0.0.1:9/foreign/rpc');
 const bundled=planRuntimeStart({packaged:false,runtimeDirectory:runtime,environment});
 assert.deepEqual([bundled.verifyNode,bundled.verifySurreal,bundled.managedDatabase],[true,true,true]);
 assert.throws(()=>planRuntimeStart({packaged:false,runtimeDirectory:undefined,environment}),/MASSION_SURREAL_RPC/);
});

