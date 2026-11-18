import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {access,chmod,copyFile,mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {closeSync,openSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,fork,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {connect,createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {EventEmitter,once} from 'node:events';
import {createInterface} from 'node:readline';
import {control,drainDaemon,launchDaemon,planRuntimeStart,prepareControl,RuntimeStartFailureError} from '../daemon.ts';
import {checkPreviousInstance,createProcessProbe,databaseArgsMatcher,keeperArgsMatcher,stopRecordedProcess} from '../process-probe.ts';
import {decideDatabaseStart,decidePreviousInstance} from '../start-decision.ts';
import type {DatabaseStartDecision,DatabaseStartInputs,PreviousInstanceDecision,PreviousInstanceInputs} from '../start-decision.ts';
import {createPinnedDatabaseFetch,generateStartCertificate} from '../../src/database-tls.ts';
import {tempRoot} from '../../tests/support/temp-root.ts';

const run=promisify(execFile),desktop=join(import.meta.dirname,'..');
const surrealBinary=process.env.MASSION_SURREAL_BINARY??join(desktop,'.runtime','current','surreal');
await access(surrealBinary);
const surrealVersion='4.0.1';
const sha256=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file,{highWaterMark:1<<20}))hash.update(chunk);return hash.digest('hex');};
const surrealSha256=await sha256(surrealBinary);
// The daemon under test must not inherit this test runner's Massion settings.
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MASSION_')));
// A port private to this test run: failed earlier runs and other sessions leave cores behind.
const corePort=18000+(process.pid%1000)*5,runner=join(desktop,'daemon-runner.mjs'),origin='http://127.0.0.1:'+corePort;
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
async function makeRuntime(root:string,binary=surrealBinary,options:{copy?:boolean}={}){
 const runtime=join(root,'runtime');await mkdir(runtime);
 const target=join(runtime,'surreal');
 if(options.copy){await copyFile(binary,target);await chmod(target,0o755);}
 else await symlink(binary,target);
 await writeFile(join(runtime,'manifest.json'),JSON.stringify({node:{version:'24.19.0',sha256:'0'.repeat(64)},surreal:{version:surrealVersion,sha256:await sha256(binary)}})+'\n');
 return runtime;
}
// Direct keeper spawns need the same TLS inputs the supervisor provides: two protected files plus their paths on stdin.
async function keeperTls(root:string){
 const start=generateStartCertificate();
 const certificatePath=join(root,'keeper-tls.crt'),keyPath=join(root,'keeper-tls.key');
 await writeFile(certificatePath,start.certificate,{mode:0o600});
 await writeFile(keyPath,start.privateKey,{mode:0o600});
 return {pathsLine:JSON.stringify({certificate:certificatePath,key:keyPath})+'\n'};
}
async function coreEntry(root:string,stopDelayMs=0,options:{hangOnSigterm?:boolean;listenDelayMs?:number;authFile?:string;authDelayMs?:number;respondAuthOnSigterm?:boolean;authSigtermFile?:string;dieAfterFile?:string}={}){
 const coreStop='setTimeout(()=>process.exit(0),'+stopDelayMs+');';
 const file=join(root,'core-'+stopDelayMs+'-'+Math.random().toString(16).slice(2,6)+'.mjs');
 const listenCall=`server.listen(Number(process.env.MASSION_PORT),'127.0.0.1',()=>writeFileSync(${JSON.stringify(join(root,'core-listening'))},'yes'));`;
 const authHook=options.authFile
  ?options.respondAuthOnSigterm
   ?`if(request.url==='/desktop-auth'){if(sigtermSeen){if(guard(request,response))response.writeHead(404).end();return;}pendingAuth={request,response};writeFileSync(${JSON.stringify(options.authFile)},'yes');return;}`
   :`if(request.url==='/desktop-auth'){writeFileSync(${JSON.stringify(options.authFile)},'yes');setTimeout(()=>{if(guard(request,response))response.writeHead(404).end();},${options.authDelayMs??200});return;}`
  :'';
 const sigtermReply=options.respondAuthOnSigterm
  ?`sigtermSeen=true;if(pendingAuth&&!pendingAuth.response.writableEnded){${options.authSigtermFile?`writeFileSync(${JSON.stringify(options.authSigtermFile)},'yes');`:''}const{request,response}=pendingAuth;pendingAuth=undefined;if(guard(request,response))response.writeHead(404).end();}`
  :'';
 const source=`import {createServer} from 'node:http';
import {closeSync,readFileSync,writeFileSync} from 'node:fs';
import {access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {daemonGuard} from ${JSON.stringify(new URL('../../src/daemon-auth.ts',import.meta.url).href)};
const secret=readFileSync(3,'utf8');closeSync(3);
 const database=process.env.MASSION_SURREAL_AUTH_FD==='4'?readFileSync(4,'utf8'):'';if(process.env.MASSION_SURREAL_AUTH_FD==='4')closeSync(4);
 const certificate=process.env.MASSION_SURREAL_CERT_FD==='5'?readFileSync(5,'utf8'):'';if(process.env.MASSION_SURREAL_CERT_FD==='5')closeSync(5);
 writeFileSync(${JSON.stringify(join(root,'core-evidence.json'))},JSON.stringify({endpoint:process.env.MASSION_SURREAL_RPC,passwordLength:database.length,certificate}));
let pendingAuth,sigtermSeen=false;
const guard=daemonGuard(secret),server=createServer((request,response)=>{${authHook}if(guard(request,response))response.writeHead(404).end();});
server.once('error',error=>{console.error('core listen failed',error.code);process.exit(3);});
${options.listenDelayMs!==undefined?`setTimeout(()=>{${listenCall}},${options.listenDelayMs});`:listenCall}
${options.dieAfterFile?'(async()=>{for(;;){try{await access('+JSON.stringify(options.dieAfterFile)+');process.exit(0);}catch{await delay(5);}}})();':''}
process.on('SIGTERM',()=>{console.error('core SIGTERM');${sigtermReply}${options.hangOnSigterm?'/* this core ignores SIGTERM */':coreStop}});
setInterval(()=>{},1000);`;
 await writeFile(file,source);return file;
}
async function surrealEntry(root:string,options:{stopDelayMs?:number,hangOnSigterm?:boolean,portFile?:string,ackFile?:string,exitAfterLine?:boolean,dieAfterMs?:number,diedFile?:string,dieAfterFile?:string,dieAfterBootstrap?:boolean,dieAfterBootstrapReleaseFile?:string}={}){
 const file=join(root,'surreal-'+Math.random().toString(16).slice(2,8)+'.mjs');
 let detachedResponderBlock='';
 if(options.dieAfterBootstrapReleaseFile){
  const responderFile=join(root,'responder-'+Math.random().toString(16).slice(2,8)+'.mjs');
  const readyFile=join(root,'responder-ready-'+Math.random().toString(16).slice(2,8));
  const exitTriggerFile=join(root,'responder-exit-'+Math.random().toString(16).slice(2,8));
  const responderLines=[
   "import {createServer} from 'node:https';",
   "import {readFileSync,writeFileSync} from 'node:fs';",
   "import {access} from 'node:fs/promises';",
   "import {join} from 'node:path';",
   "import {setTimeout as delay} from 'node:timers/promises';",
   'const [portText,dataDirectory,readyFile,exitTriggerFile,releaseFile,certificatePath,keyPath]=process.argv.slice(2);',
   'const port=Number(portText),password=process.env.SURREAL_PASS;',
   'setTimeout(()=>process.exit(0),5000).unref();',
   'const server=createServer({cert:readFileSync(certificatePath,\'utf8\'),key:readFileSync(keyPath,\'utf8\')},(request,response)=>{',
   " if(request.url==='/health'){response.writeHead(200).end();return;}",
   " if(request.url==='/rpc'&&password!==undefined&&request.headers.authorization==='Basic '+Buffer.from('root:'+password).toString('base64')){",
   "  writeFileSync(join(dataDirectory,'LOCK'),'store');",
   "  response.writeHead(200,{'content-type':'application/json'});",
   "  response.write(JSON.stringify({id:'massion-bootstrap',result:[{result:1,status:'OK'}]}));",
   "  writeFileSync(exitTriggerFile,'yes');",
   '  void (async()=>{for(;;){try{await access(releaseFile);break;}catch{await delay(5);}}response.end(()=>process.exit(0));})();',
   '  return;',
   ' }',
   ' response.writeHead(401).end();',
   '});',
   "server.once('error',()=>process.exit(3));",
   "server.listen(port,'127.0.0.1',()=>writeFileSync(readyFile,'yes'));"
  ];
  await writeFile(responderFile,responderLines.join('\n')+'\n');
  detachedResponderBlock=`const responder=spawn(process.execPath,[${JSON.stringify(responderFile)},String(port),dataDirectory,${JSON.stringify(readyFile)},${JSON.stringify(exitTriggerFile)},${JSON.stringify(options.dieAfterBootstrapReleaseFile)},...tlsPaths],{detached:true,stdio:'ignore',env:process.env});responder.unref();(async()=>{for(;;){try{await access(${JSON.stringify(readyFile)});break;}catch{await delay(5);}}console.log('INFO fixture: Started web server on 127.0.0.1:'+port);for(;;){try{await access(${JSON.stringify(exitTriggerFile)});process.exit(0);}catch{await delay(5);}}})();`;
 }
 const diedWrite=options.diedFile?'writeFileSync('+JSON.stringify(options.diedFile)+',String(Date.now()));':'';
 const serveBlock=options.dieAfterBootstrapReleaseFile
  ?detachedResponderBlock
  :options.exitAfterLine
   ?"console.log('INFO fixture: Started web server on 127.0.0.1:'+port);setTimeout(()=>process.exit(0),50);"
   :options.dieAfterMs!==undefined
    ?'serve();setTimeout(()=>{'+diedWrite+'process.exit(0);},'+options.dieAfterMs+');'
    :'serve();';
 const dieFileBlock=options.dieAfterFile
  ?'(async()=>{for(;;){try{await access('+JSON.stringify(options.dieAfterFile)+');process.exit(0);}catch{await delay(10);}}})();'
  :'';
 const rpcResponse=options.dieAfterBootstrap
  ?"writeFileSync(join(dataDirectory,'LOCK'),'store');response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'massion-bootstrap',result:[{result:1,status:'OK'}]}),()=>process.exit(0));return;"
  :"response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:'massion-bootstrap',result:[{result:1,status:'OK'}]}));return;";
 const portBlock=options.portFile
  ?'writeFileSync('+JSON.stringify(options.portFile)+',String(port));(async()=>{for(;;){try{await access('+JSON.stringify(options.ackFile)+');break;}catch{await delay(50);}}'+serveBlock+'})();'
  :serveBlock;
 const stopBlock=options.hangOnSigterm
  ?'/* this fixture ignores SIGTERM; only SIGKILL ends it */'
  :'setTimeout(()=>process.exit(0),'+(options.stopDelayMs??0)+');';
 const lines=[
  '#!'+process.execPath,
  "import {createServer} from 'node:https';",
  "import {spawn} from 'node:child_process';",
  "import {readFileSync,writeFileSync} from 'node:fs';",
  "import {access} from 'node:fs/promises';",
  "import {join} from 'node:path';",
  "import {setTimeout as delay} from 'node:timers/promises';",
  "const dataDirectory=process.argv[3].slice('surrealkv://'.length);",
  "const port=Number(process.argv[process.argv.indexOf('--bind')+1].split(':').pop());",
  "const tlsPaths=[process.argv[process.argv.indexOf('--web-crt')+1],process.argv[process.argv.indexOf('--web-key')+1]];",
  "const tlsOptions={cert:readFileSync(tlsPaths[0],'utf8'),key:readFileSync(tlsPaths[1],'utf8')};",
  'const password=process.env.SURREAL_PASS;',
  'const serve=()=>{',
  ' const server=createServer(tlsOptions,(request,response)=>{',
  "  if(request.url==='/health'){response.writeHead(200).end();return;}",
  "  if(request.url==='/rpc'&&password!==undefined&&request.headers.authorization==='Basic '+Buffer.from('root:'+password).toString('base64')){"+rpcResponse+'}',
  '  response.writeHead(401).end();',
  ' });',
  " server.once('error',()=>process.exit(3));",
  " server.listen(port,'127.0.0.1',()=>console.log('INFO fixture: Started web server on 127.0.0.1:'+port));",
  '};',
  portBlock,
  dieFileBlock,
  "process.on('SIGTERM',()=>{"+stopBlock+'});',
  'setInterval(()=>{},1000)'];
 await writeFile(file,lines.join('\n')+'\n',{mode:0o755});return file;
}
const start=(root:string,runtime:string,entry:string)=>launchDaemon({node:process.execPath,runner,entry,directory:join(root,'user'),socket:join(root,'user','daemon.sock'),origin,runtimeDirectory:runtime,environment});

async function heldRunner(t:TestContext,mode:string,{managed=false,initialized=false,failedDatabase=false,selfExitCore=false}={}){
 const root=await mkdtemp(join(tempRoot(),'drain-truth-')),socket=join(root,'daemon.sock');
 const coreDie=selfExitCore?join(root,'core-die'):undefined;
 const entry=await coreEntry(root,0,selfExitCore?{dieAfterFile:coreDie}:{});
 let runtime:string|undefined;
 if(managed){
  const database=failedDatabase?join(root,'surreal-exits'):await surrealEntry(root);
  if(failedDatabase)await writeFile(database,'#!/bin/sh\nexit 0\n',{mode:0o755});
  runtime=await makeRuntime(root,database);
 }
 if(initialized){
  const database=join(root,'database'),password='a'.repeat(64),salt='b'.repeat(32);
  await mkdir(database,{mode:0o700});
  await writeFile(join(database,'version'),JSON.stringify({format:1,surreal:surrealVersion}));
  await writeFile(join(database,'password'),password,{mode:0o600});
  await writeFile(join(database,'initialized'),JSON.stringify({salt,digest:digestOf(salt,password)}));
 }
 const server=createServer();
 const listening=once(server,'listening');
 server.listen(0,'127.0.0.1');await listening;
 const coreOrigin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 await new Promise<void>(resolve=>server.close(()=>resolve()));
 const supervisor=fork(runner,[socket,entry,coreOrigin,...runtime?[runtime]:[]],{
  cwd:root,detached:true,execArgv:['--import',new URL('fixtures/hold-supervisor-startup.mjs',import.meta.url).href],
  env:{...environment,MASSION_TEST_DRAIN_HOLD:mode},stdio:['ignore','ignore','inherit','ipc'],
 });
 const exited=once(supervisor,'exit');
 const events:unknown[]=[],notices=new EventEmitter();
 supervisor.on('message',event=>{events.push(event);if(typeof event==='string')notices.emit(event);});
 t.after(async()=>{
  try{if(supervisor.pid!==undefined)process.kill(-supervisor.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  await exited;
  await rm(root,{recursive:true,force:true});
 });
 const observed=(event:string)=>events.includes(event)?Promise.resolve():once(notices,event,{signal:t.signal});
 const coreReady=()=>t.waitFor(()=>access(join(root,'core-listening')),{timeout:8000});
 const drain=()=>control(socket,'drain').then(reply=>reply.status,(error:Error)=>error.message);
 const release=()=>supervisor.send('release');
 async function assertParked(reply:Promise<string>){
  assert.equal(await Promise.race([observed('drain turn ended').then(()=>'checked'),reply]),'checked','drain must leave the connection open while held');
  assert.ok(!events.includes('drain crossed held wait'),'drain must wait before touching processes or files');
 }
 async function assertClean(reply:Promise<string>){
  assert.equal(await reply,'drained');
  await assert.rejects(access(socket+'.pid'),{code:'ENOENT'});
  await assert.rejects(access(join(root,'database.pid')),{code:'ENOENT'});
  const {stdout}=await run('ps',['-ax','-ww','-o','pid=','-o','command=']);
  const survivors=stdout.split('\n').filter(line=>line.includes(root)&&Number(line.trim().split(' ',1)[0])!==supervisor.pid);
  assert.deepEqual(survivors,[],'no fixture keeper, database or core may survive the reply');
  assert.deepEqual(await exited,[0,null]);
  await assert.rejects(access(socket+'.pid'),{code:'ENOENT'});
 }
 return {root,socket,coreDie,supervisor,events,exited,observed,coreReady,drain,release,assertParked,assertClean};
}

for(const [wait,nextStep] of [
 ['checkPreviousInstance','prepare data'],['watchKeeper','check database'],['waitForHealth','core spawned'],
 ['verifyBootstrap','core spawned'],['waitForCore','mark running'],
] as const){
 test(`drain waits for held ${wait} and skips ${nextStep}`,{timeout:15000},async t=>{
  const fixture=await heldRunner(t,wait,{managed:true,initialized:wait==='waitForHealth'});
  await fixture.observed(wait);
  const reply=fixture.drain();
  await fixture.assertParked(reply);
  fixture.release();
  assert.notEqual(await Promise.race([fixture.observed(nextStep).then(()=>nextStep),reply]),nextStep,`${nextStep} must not run`);
  await fixture.assertClean(reply);
  assert.ok(!fixture.events.includes(nextStep),`${nextStep} must not run`);
  if(wait==='verifyBootstrap'){
   const database=join(fixture.root,'database');
   const password=await readFile(join(database,'password'),'utf8');
   const marker=JSON.parse(await readFile(join(database,'initialized'),'utf8')) as {salt:string;digest:string};
   assert.equal(marker.digest,digestOf(marker.salt,password),'a successful proof still commits its initialization marker');
  }
 });
}

test('drain completes when the keeper rejects during a held start',{timeout:15000},async t=>{
 const fixture=await heldRunner(t,'keeper rejects',{managed:true,failedDatabase:true});
 await fixture.observed('watchKeeper');
 const reply=fixture.drain();
 await fixture.assertParked(reply);
 fixture.release();
 await fixture.assertClean(reply);
 assert.ok(!fixture.events.includes('check database'));
});

for(const first of ['drain','restart']){
 test(`drain refuses a settings restart with the core exit held (${first} first)`,{timeout:15000},async t=>{
  const fixture=await heldRunner(t,'core exit');
  await fixture.coreReady();
  function restart(){
   const client=connect(fixture.socket),lines=createInterface({input:client});
   t.after(()=>client.destroy());
   const reply=(async()=>{
    for await(const line of lines){
     const result=JSON.parse(line);
     if(result.id==='restart'){assert.equal(result.status,200);return JSON.parse(result.body).restartStatus as string;}
    }
    throw new Error('settings connection closed before restart replied');
   })();
   client.write('client\n'+JSON.stringify({id:'restart',method:'POST',path:'/desktop/restart'})+'\n');
   return reply;
  }
  let reply:Promise<string>,settings:Promise<string>;
  if(first==='drain'){
   reply=fixture.drain();
   await fixture.observed('held SIGTERM');
   settings=restart();
   assert.equal(await Promise.race([
   settings,fixture.observed('second SIGTERM').then(()=>'second SIGTERM'),
   ]),'unknown','a restart during drain must refuse before signalling the core');
  }else{
   settings=restart();
   await fixture.observed('held SIGTERM');
   reply=fixture.drain();
   await fixture.observed('second SIGTERM');
  }
  fixture.release();
  assert.equal(await settings,'unknown','a restart must not replace the stopped core after drain starts');
  await fixture.assertClean(reply);
  assert.equal(fixture.events.filter(event=>event&&typeof event==='object'&&'core' in event).length,1);
 });
}

test('drain signals the core before joining a held child PID write',{timeout:15000},async t=>{
 const fixture=await heldRunner(t,'child record');
 await fixture.observed('writeFile');
 await fixture.coreReady();
 const reply=fixture.drain();
 await fixture.observed('drain turn ended');
 assert.ok(fixture.events.includes('core SIGTERM sent'),'the held child PID write must not delay SIGTERM');
 assert.equal(await Promise.race([fixture.observed('core exit turn ended').then(()=>'core exited'),reply]),'core exited','drain must leave the connection open while the child PID write is held');
 assert.ok(!fixture.events.includes('unlink PID'),'drain must wait for the held child PID write before unlinking');
 fixture.release();
 await fixture.assertClean(reply);
 assert.deepEqual(fixture.events.filter(event=>event==='child record written'||event==='unlink PID'),['child record written','unlink PID']);
});

test('drain accepted during chmod skips the first PID write',{timeout:15000},async t=>{
 const fixture=await heldRunner(t,'first PID');
 await fixture.observed('chmod');
 const reply=fixture.drain();
 await fixture.observed('drain received');
 fixture.release();
 assert.equal(await Promise.race([fixture.observed('writeFile').then(()=>'first PID write submitted'),reply]),'drained','drain must skip the first PID write after acceptance');
 await fixture.assertClean(reply);
});

test('a chmod failure of an owned socket removes both files and exits failing',{timeout:15000},async t=>{
 const fixture=await heldRunner(t,'chmod fails');
 assert.deepEqual(await fixture.exited,[1,null]);
 await assert.rejects(access(fixture.socket),{code:'ENOENT'});
 await assert.rejects(access(fixture.socket+'.pid'),{code:'ENOENT'});
});

test('a partial first PID write of an owned socket removes both files and exits failing',{timeout:15000},async t=>{
 const fixture=await heldRunner(t,'partial first PID');
 await fixture.observed('partial PID written');
 assert.deepEqual(await fixture.exited,[1,null]);
 await assert.rejects(access(fixture.socket),{code:'ENOENT'});
 await assert.rejects(access(fixture.socket+'.pid'),{code:'ENOENT'});
});

test('a SIGTERM while the first PID write of an owned socket is held ends through the drain cleanup',{timeout:15000},async t=>{
 const fixture=await heldRunner(t,'first PID');
 await fixture.observed('chmod');
 fixture.release();
 await fixture.observed('writeFile');
 process.kill(fixture.supervisor.pid!,'SIGTERM');
 await fixture.observed('SIGTERM taken');
 fixture.release();
 assert.deepEqual(await fixture.exited,[0,null]);
 await assert.rejects(access(fixture.socket),{code:'ENOENT'});
 await assert.rejects(access(fixture.socket+'.pid'),{code:'ENOENT'});
});

test('an address conflict before the socket is owned removes nothing of the other supervisor',{timeout:15000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'owned-socket-')),socket=join(root,'daemon.sock');
 await writeFile(socket,'the socket of another supervisor');
 const supervisor=fork(runner,[socket,'unused-core.mjs','http://127.0.0.1:1'],{
  cwd:root,detached:true,execArgv:['--import',new URL('fixtures/hold-supervisor-startup.mjs',import.meta.url).href],
  env:{...environment,MASSION_TEST_DRAIN_HOLD:'address conflict'},stdio:['ignore','ignore','inherit','ipc'],
 });
 const exited=once(supervisor,'exit');
 t.after(async()=>{
  try{if(supervisor.pid!==undefined)process.kill(-supervisor.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  await rm(root,{recursive:true,force:true});
 });
 assert.deepEqual(await exited,[0,null]);
 assert.equal(await readFile(socket,'utf8'),'the socket of another supervisor');
});

for(const [label,managed] of [['development core',false],['managed runtime',true]] as const){
 test(`a drain arriving during the ${label} self-exit removals answers after one submitted cleanup`,{timeout:15000},async t=>{
  const fixture=await heldRunner(t,'self exit',{managed,selfExitCore:true});
  await fixture.coreReady();
  if(managed)await fixture.observed('mark running');
  const client=connect(fixture.socket);
  t.after(()=>client.destroy());
  const lines=createInterface({input:client});
  const reply=(async()=>{for await(const line of lines)return JSON.parse(line) as {status:string};throw new Error('connection closed before drain replied');})();
  await fixture.observed('control connected');
  client.write('dra');
  await writeFile(fixture.coreDie!,'now');
  await fixture.observed('hold socket unlink');
  await fixture.observed('hold PID unlink');
  client.end('in\n');
  await fixture.observed('drain received');
  assert.equal(await Promise.race([fixture.observed('drain turn ended').then(()=>'parked'),reply.then(()=>'answered')]),'parked','drained must not be answered while the submitted removal is held');
  fixture.release();
  assert.equal((await reply).status,'drained');
  assert.equal(fixture.events.filter(event=>event==='unlink socket').length,1,'the socket removal must be submitted once');
  assert.equal(fixture.events.filter(event=>event==='unlink PID').length,1,'the PID removal must be submitted once');
  await assert.rejects(access(fixture.socket),{code:'ENOENT'});
  await assert.rejects(access(fixture.socket+'.pid'),{code:'ENOENT'});
  assert.deepEqual(await fixture.exited,[0,null]);
 });
}

test('a self-exit waits for a submitted child record before removing the PID file',{timeout:15000},async t=>{
 const fixture=await heldRunner(t,'child record',{selfExitCore:true});
 await fixture.observed('writeFile');
 await fixture.coreReady();
 await writeFile(fixture.coreDie!,'now');
 await fixture.observed('core ended');
 fixture.release();
 assert.equal(await Promise.race([
  fixture.observed('child record written').then(()=>'record'),
  fixture.observed('unlink PID').then(()=>'unlink'),
 ]),'record','the held child record must complete before the PID file is removed');
 await fixture.observed('unlink PID');
 assert.deepEqual(fixture.events.filter(event=>event==='child record written'||event==='unlink PID'),['child record written','unlink PID']);
 assert.deepEqual(await fixture.exited,[0,null]);
 await assert.rejects(access(fixture.socket),{code:'ENOENT'});
 await assert.rejects(access(fixture.socket+'.pid'),{code:'ENOENT'});
});

for(const file of ['socket','PID','database PID']){
 test(`drain answers unsettled if unlink of ${file} returns EROFS`,{timeout:15000},async t=>{
  const database=file==='database PID',fixture=await heldRunner(t,'unlink '+file,{managed:database});
  let reply:Promise<string>;
  if(database){
   await fixture.observed('watchKeeper');
   const keeper=await t.waitFor(async()=>{
    const record=await pidRecord(fixture.root);
    assert.ok(record.keeper&&record.database);
    return record.keeper;
   },{timeout:8000});
   process.kill(keeper,'SIGKILL');
   await fixture.observed('keeper closed');
   reply=fixture.drain();
   await fixture.observed('drain turn ended');
   fixture.release();
  }else{
   await fixture.coreReady();
   reply=fixture.drain();
  }
  assert.equal(await reply,'unsettled');
  assert.deepEqual(await fixture.exited,[1,null]);
  assert.ok(fixture.events.includes('EROFS'),'supervisor must attempt the removal');
 });
}

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
 assert.equal(evidence.endpoint.startsWith('https://127.0.0.1:')&&evidence.endpoint.endsWith('/rpc'),true,'the managed endpoint is TLS on the loopback address');
 const firstRecord=await pidRecord(directory);assert.ok(firstRecord.database,'the supervisor records the database child');
 assert.equal(await environmentHas(firstRecord.database,'SURREAL_PASS='),true,'first creation passes the password through the database child environment only');
 assert.equal(await environmentHas(firstRecord.database,'SURREAL_USER=root'),true);
 // The pinned request built from the certificate the core received is the only way into the port.
 const request=createPinnedDatabaseFetch(evidence.certificate);
 const query=JSON.stringify({id:'runtime-test',method:'query',params:['RETURN 1',{}]});
 const refused=await request(evidence.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:query});
 const refusedBody=await refused.json() as {result?:unknown;error?:unknown};
 assert.equal(refusedBody.result===undefined&&refusedBody.error!==undefined,true,'an unauthenticated request must be refused');
 const allowed=await request(evidence.endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from('root:'+password).toString('base64')},body:query});
 assert.equal(Array.isArray((await allowed.json() as {result?:unknown}).result),true,'the stored password authenticates');
 await assert.rejects(fetch('http://127.0.0.1:'+new URL(evidence.endpoint).port+'/rpc',{method:'POST',body:'{}'}),'a plain http request to the database port fails');
 assert.equal(await stat(join(directory,'database-tls.crt')).then(()=>true,()=>false),false,'the certificate file is gone once the start line was read');
 assert.equal(await stat(join(directory,'database-tls.key')).then(()=>true,()=>false),false,'the key file is gone once the start line was read');
 assert.equal((await readFile(join(directory,'database.pid'),'utf8')).includes('PRIVATE KEY'),false,'the pid record holds no private key');
 const {stdout:databaseCommand}=await run('ps',['-o','command=','-p',String(firstRecord.database)]);
 assert.match(databaseCommand,/database-tls\.crt/,'the database process receives both file paths as arguments');
 assert.match(databaseCommand,/database-tls\.key/);
 const {stdout:keeperCommand}=await run('ps',['-o','command=','-p',String(firstRecord.keeper)]);
 assert.equal(/database-tls\.(crt|key)/.test(keeperCommand),false,'the two file paths appear only in the database process arguments');
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
 assert.equal(evidenceTwo.certificate!==evidence.certificate,true,'a restart makes a new key pair and certificate');
 await drainDaemon(join(directory,'daemon.sock'),origin);
 assert.equal(alive(secondRecord.database),false);
});

test('the real core initialises the schema over the pinned TLS database and restarts on a fresh certificate',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-real-core-tls-'));
 const runtime=await makeRuntime(root),entry=fileURLToPath(new URL('../../src/server.ts',import.meta.url)),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 assert.equal((await control(join(directory,'daemon.sock'),'status')).status,'running','the real core completed schema initialisation over pinned TLS');
 const record=await pidRecord(directory);
 assert.equal(await environmentHas(record.core!,'PRIVATE KEY'),false,'the core holds no private key in its arguments or environment');
 const {stdout:coreCommand}=await run('ps',['-o','command=','-p',String(record.core)]);
 assert.equal(coreCommand.includes('PRIVATE KEY'),false,'the core arguments hold no private key');
 assert.equal(await environmentHas(record.keeper!,'database-tls.crt'),false,'the keeper carries no certificate path in its arguments or environment');
 await drainDaemon(join(directory,'daemon.sock'),origin);
 await start(root,runtime,entry);
 assert.equal((await control(join(directory,'daemon.sock'),'status')).status,'running','a restart succeeds against a fresh key pair and certificate');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

test('the core refuses a managed https endpoint without a usable certificate pipe',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-core-nocert-'));
 const directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 const entry=fileURLToPath(new URL('../../src/server.ts',import.meta.url));
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 // On Linux the runtime may already hold internal pipes at low descriptors, so the unusable case
 // is produced by pointing the descriptor at an empty file: present, readable, not a certificate.
 for(const variant of ['missing descriptor','unusable descriptor'] as const){
  const empty=join(root,'empty-certificate');
  await writeFile(empty,'');
  const emptyFd=openSync(empty,'r');
  try{
   const child=spawn(process.execPath,[entry],{cwd:directory,env:{...environment,MASSION_SURREAL_RPC:'https://127.0.0.1:65534/rpc',MASSION_PORT:String(corePort+9),...(variant==='unusable descriptor'?{MASSION_SURREAL_CERT_FD:'5'}:{})},stdio:['ignore','ignore','pipe','ignore','ignore',...(variant==='unusable descriptor'?[emptyFd]:[])]});
   let stderr='';child.stderr!.setEncoding('utf8');child.stderr!.on('data',chunk=>{stderr+=chunk;});
   const [code]=await once(child,'exit');
   assert.notEqual(code,0,variant+' must refuse to start');
   assert.match(stderr,/certificate/,variant+' states why it refused');
  }finally{
   closeSync(emptyFd);
  }
 }
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

// One authenticated query against the managed database, exactly the way the core issues them:
// over a pinned request built from the certificate this start gave the core.
const databaseQuery=(request:ReturnType<typeof createPinnedDatabaseFetch>,endpoint:string,password:string,params:unknown[])=>request(endpoint,{method:'POST',headers:{'content-type':'application/json','Surreal-NS':'massion','Surreal-DB':'massion',authorization:'Basic '+Buffer.from('root:'+password).toString('base64')},body:JSON.stringify({id:'runtime-test',method:'query',params})});

test('a first start interrupted after verification and before the marker exists is recovered, marked and keeps the data',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-recover-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 assert.equal((await control(join(directory,'daemon.sock'),'status')).status,'running');
 const password=await readFile(join(directory,'database','password'),'utf8');
 // Durable data written through the first start's own pinned endpoint, before the interruption.
 const evidence=JSON.parse(await readFile(join(root,'core-evidence.json'),'utf8'));
 const insert=await databaseQuery(createPinnedDatabaseFetch(evidence.certificate),evidence.endpoint,password,["CREATE recovery_probe:one SET value = 'before-interruption'"]);
 assert.equal(insert.ok&&Array.isArray((await insert.json() as {result?:unknown}).result),true,'the probe record is written before the interruption');
 await drainDaemon(join(directory,'daemon.sock'),origin);
 // A crash between the verification response and the marker rename leaves exactly this folder:
 // password, version and store files, no marker. A clean stop leaves the same folder minus the
 // marker, so removing only the marker reproduces the crashed on-disk state for the next start.
 await rm(join(directory,'database','initialized'));
 await start(root,runtime,entry);
 assert.equal((await control(join(directory,'daemon.sock'),'status')).status,'running','the interrupted start is recovered');
 const marker=JSON.parse(await readFile(join(directory,'database','initialized'),'utf8')) as {salt:string;digest:string};
 assert.equal(marker.digest,digestOf(marker.salt,password),'the recovery writes the marker exactly as a first bootstrap writes it');
 const evidenceTwo=JSON.parse(await readFile(join(root,'core-evidence.json'),'utf8'));
 const read=await databaseQuery(createPinnedDatabaseFetch(evidenceTwo.certificate),evidenceTwo.endpoint,password,['SELECT * FROM recovery_probe']);
 assert.equal(JSON.stringify(await read.json()).includes('before-interruption'),true,'the store data from before the interruption is still there');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

// SurrealDB 4.0.1 maintains its own store bookkeeping: opening a store rewrites LOCK, the
// manifest, the WAL and the value log, and compaction adds new sstables under sstables/. Those
// are the store engine's internal files, not the app's, so they are the only entries allowed to
// appear; every other entry in the data folder must survive a refused proof untouched.
const storeInternal=(name:string)=>name==='LOCK'||name.startsWith('manifest/')||name.startsWith('sstables/')||name.startsWith('vlog/')||name.startsWith('wal/');
async function preservedState(dataDirectory:string){
 const names=await readdir(dataDirectory,{recursive:true});
 const rows=new Map<string,string>();
 for(const name of names){
  const information=await stat(join(dataDirectory,String(name)));
  if(information.isFile()&&(/\.sst$/.test(String(name))||name==='password'||name==='version'))
   rows.set(String(name),await sha256(join(dataDirectory,String(name))));
 }
 return rows;
}

test('store files the stored password cannot open keep refusing with data-credential and lose nothing',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-recover-wrong-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 await drainDaemon(join(directory,'daemon.sock'),origin);
 const dataDirectory=join(directory,'database');
 // Another well-formed password: the recovery proof must fail against the real store.
 await writeFile(join(dataDirectory,'password'),'e'.repeat(64),{mode:0o600});
 await rm(join(dataDirectory,'initialized'));
 const namesBefore=new Set((await readdir(dataDirectory,{recursive:true})).map(String));
 const before=await preservedState(dataDirectory);
 const began=Date.now();
 await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='data-credential'&&error.failure.detail==='existing database files have no valid initialization record');
 assert.ok(Date.now()-began>9000,'the refusal comes only after the recovery proof ran to its bootstrap bound (at main the same state is refused before anything starts)');
 assert.equal(await stat(join(dataDirectory,'initialized')).then(()=>true,()=>false),false,'the marker is not written when the proof fails');
 const namesAfter=new Set((await readdir(dataDirectory,{recursive:true})).map(String));
 for(const name of namesBefore)assert.equal(namesAfter.has(name),true,'no entry in the data folder is deleted: '+name);
 for(const name of namesAfter)assert.equal(namesBefore.has(name)||storeInternal(name),true,'no new file appears beyond SurrealDB store internals: '+name);
 const after=await preservedState(dataDirectory);
 for(const [name,digest] of before)assert.equal(after.get(name),digest,'unchanged bytes after the refused proof: '+name);
});

test('the recovery start gives the database process no credential-setting environment or argument',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-recover-env-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 await drainDaemon(join(directory,'daemon.sock'),origin);
 await rm(join(directory,'database','initialized'));
 await start(root,runtime,entry);
 assert.equal((await control(join(directory,'daemon.sock'),'status')).status,'running');
 const record=await pidRecord(directory);assert.ok(record.database);
 assert.equal(await environmentHas(record.database,'SURREAL_PASS='),false,'the recovery start hands the database no password');
 assert.equal(await environmentHas(record.database,'SURREAL_USER='),false,'the recovery start hands the database no username');
 const {stdout:databaseCommand}=await run('ps',['-o','command=','-p',String(record.database)]);
 assert.equal(/SURREAL_|--pass|--user/.test(databaseCommand),false,'the database arguments carry no credential-setting input');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

test('a recovery-shaped start accepts only the stored password; SURREAL_PASS cannot adopt one',async t=>{
 // The facts the recovery relies on (SurrealDB 4.0.1, pinned with the real binary):
 // surrealdb/core/src/kvs/ds.rs initialise_credentials_attempt creates the root user only when
 // none exists; with an existing root user it logs a warning ("existing root users were found")
 // and rolls back, and the CLI help for SURREAL_PASS says it applies "only if no other root user
 // exists". Observed answer shapes for the exact verifyBootstrap request: no authorization gets
 // HTTP 200 with a JSON-RPC error body (no result array), so response.ok alone proves nothing;
 // a wrong password gets HTTP 401 with a plain-text body; the stored password gets HTTP 200
 // with a result array. The proof below judges exactly the way verifyBootstrap judges.
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-surrealpass-'));
 const dataDirectory=join(root,'database'),temporary=join(root,'db-tmp');
 await mkdir(dataDirectory,{recursive:true,mode:0o700});
 await mkdir(temporary,{recursive:true,mode:0o700});
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 const probeServer=createServer();
 probeServer.listen(0,'127.0.0.1');await once(probeServer,'listening');
 const port=(probeServer.address() as {port:number}).port;
 await new Promise<void>(resolve=>probeServer.close(()=>resolve()));
 const runDatabase=async(password:string|undefined)=>{
  const startCertificate=generateStartCertificate();
  const certificate=join(root,'fact.crt'),key=join(root,'fact.key');
  await writeFile(certificate,startCertificate.certificate,{mode:0o600});
  await writeFile(key,startCertificate.privateKey,{mode:0o600});
  const database=spawn(surrealBinary,['start','surrealkv://'+dataDirectory,'--bind','127.0.0.1:'+port,'--no-banner','--log','info','--temporary-directory',temporary,'--default-namespace','massion','--default-database','massion','--deny-net','--deny-scripting','--web-crt',certificate,'--web-key',key],{env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',...(password?{SURREAL_USER:'root',SURREAL_PASS:password}:{})},stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{
   let output='';
   const timer=setTimeout(()=>reject(new Error('the fixture database did not report its listening address: '+output.slice(-300))),10_000);
   const observe=(chunk:string)=>{output+=chunk;if(output.includes('Started web server on')){clearTimeout(timer);resolve();}};
   database.stdout!.setEncoding('utf8');database.stdout!.on('data',observe);
   database.stderr!.setEncoding('utf8');database.stderr!.on('data',observe);
   database.once('exit',code=>{clearTimeout(timer);reject(new Error('the fixture database exited early: '+code));});
  });
  return {database,request:createPinnedDatabaseFetch(startCertificate.certificate)};
 };
 // The exact request and judgment verifyBootstrap uses: same URL, headers, body, and the
 // body-based success test, so the proof itself is what is pinned here.
 const proof=async(request:ReturnType<typeof createPinnedDatabaseFetch>,password:string|undefined)=>{
  const response=await request('https://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{'content-type':'application/json',...(password===undefined?{}:{authorization:'Basic '+Buffer.from('root:'+password).toString('base64')})},body:JSON.stringify({id:'massion-bootstrap',method:'query',params:['RETURN 1',{}]}),signal:AbortSignal.timeout(3000)});
  let envelope:{result?:unknown;error?:unknown}|null=null;
  try{envelope=JSON.parse(await response.text()) as {result?:unknown;error?:unknown};}catch{}
  return {status:response.status,verified:Boolean(response.ok&&envelope&&Array.isArray(envelope.result)),envelope};
 };
 const firstPassword='f'.repeat(64),secondPassword='9'.repeat(64);
 const first=await runDatabase(firstPassword);
 assert.equal((await proof(first.request,firstPassword)).verified,true,'the first start creates the root user with the given password');
 first.database.kill('SIGTERM');await once(first.database,'exit');
 const recovery=await runDatabase(undefined); // the recovery-shaped start: no credential input
 const anonymous=await proof(recovery.request,undefined);
 assert.equal(anonymous.verified,false,'a request with no authorization header is refused');
 assert.equal(anonymous.status,200,'SurrealDB 4.0.1 answers an anonymous query with HTTP 200, so only the body judgment refuses it');
 assert.equal(anonymous.envelope!==null&&anonymous.envelope.error!==undefined,true,'the anonymous response is a JSON-RPC error envelope without a result array');
 const wrong=await proof(recovery.request,secondPassword);
 assert.equal(wrong.verified,false,'a request with a wrong password is refused');
 assert.equal(wrong.status,401,'the wrong-password response is an authentication failure');
 assert.equal(wrong.envelope,null,'the wrong-password body is plain text, not a JSON envelope');
 const stored=await proof(recovery.request,firstPassword);
 assert.equal(stored.verified,true,'the request with the stored password succeeds');
 recovery.database.kill('SIGTERM');await once(recovery.database,'exit');
 const adopted=await runDatabase(secondPassword); // a different SURREAL_PASS on the existing root user
 assert.equal((await proof(adopted.request,firstPassword)).verified,true,'the original password still authenticates');
 assert.equal((await proof(adopted.request,secondPassword)).verified,false,'the new SURREAL_PASS is not adopted by the existing root user');
 adopted.database.kill('SIGTERM');await once(adopted.database,'exit');
});

// Only what this feature could write: the database folder subtree plus the temporary folder and keeper pid file.
async function dataFootprint(directory:string){
 const database=await readdir(join(directory,'database'),{recursive:true}).catch(()=>[] as string[]);
 const created=(await readdir(directory)).filter(name=>name==='db-tmp'||name==='database.pid');
 return JSON.stringify([...database.map(String).sort(),...created.sort()]);
}

test('a missing, mis-permissioned, foreign-version, wrong-password or planted-folder data folder refuses to start and stays untouched',async t=>{
 for(const variant of ['missing','mode','version','wrong-password','marker-missing-with-data','marker-corrupt-with-data','folder-mode','folder-symlink','temporary-symlink'] as const){
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
    // The two data variants keep no password file: with store files and no marker a usable
    // password now starts the recovery proof (see the real-database tests below), so the
    // refusal they still prove is the password-less side of that state — nothing starts and
    // nothing is written when no password can be presented at all.
    if(variant!=='missing'&&variant!=='marker-missing-with-data'&&variant!=='marker-corrupt-with-data')
     await writeFile(join(directory,'database','password'),variant==='wrong-password'?'c'.repeat(64):'a'.repeat(64),{mode:variant==='mode'?0o644:0o600});
    await writeFile(join(directory,'database','version'),JSON.stringify(variant==='version'?{surreal:'3.3.0',format:1}:{surreal:surrealVersion,format:1})+'\n',{mode:0o600});
    if(variant==='wrong-password'){
     const salt=randomBytes(16).toString('hex');
     await writeFile(join(directory,'database','initialized'),JSON.stringify({surreal:surrealVersion,format:1,salt,digest:digestOf(salt,'d'.repeat(64))})+'\n',{mode:0o600});
    }
    if(variant==='marker-missing-with-data'||variant==='marker-corrupt-with-data'){
     await writeFile(join(directory,'database','sstables'),'store file',{mode:0o600});
     if(variant==='marker-corrupt-with-data')await writeFile(join(directory,'database','initialized'),'garbage',{mode:0o600});
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

 for(const moment of ['database-started','running','shutdown'] as const){
  const root=await mkdtemp(join(await realpath(tmpdir()),{['database-started']:'e4-oa',['running']:'e4-ob',['shutdown']:'e4-oc'}[moment]+'-'));
  const fixture=moment==='shutdown';
  const runtime=await makeRuntime(root,fixture?await surrealEntry(root,{hangOnSigterm:true}):surrealBinary);
  const entry=await coreEntry(root,fixture?200:0),directory=join(root,'user');
  await mkdir(directory,{mode:0o700});
  let orphanRecord:{pid:number;core?:number;keeper?:number;database?:number}|undefined;
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  await start(root,runtime,entry).catch(async (error:unknown)=>{
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
   await start(root,runtime,entry);
   const restarted=await control(join(directory,'daemon.sock'),'status');assert.equal(restarted.status,'running','the data folder is free for the next start');
   await drainDaemon(join(directory,'daemon.sock'),origin);
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


test('the database start decision has an explicit expectation for every input combination',()=>{
 const expect=(inputs:DatabaseStartInputs):DatabaseStartDecision|undefined=>{
  if(inputs.versionRecorded==='other')return {action:'refuse',cause:'data-version',detail:'spec'};
  if(inputs.versionRecorded==='absent')return inputs.folderEmpty?{action:'initialise'}:{action:'refuse',cause:'data-version',detail:'spec'};
  if(inputs.markerValid){
   if(!inputs.passwordUsable)return {action:'refuse',cause:'data-credential',detail:'spec'};
   return inputs.digestMatches?{action:'start'}:{action:'refuse',cause:'data-credential',detail:'spec'};
  }
  if(inputs.databaseFilesPresent)return inputs.passwordUsable?{action:'verify-then-mark'}:{action:'refuse',cause:'data-credential',detail:'spec'};
  if(!inputs.passwordUsable)return {action:'refuse',cause:'data-credential',detail:'spec'};
  return {action:'resume'};
 };
 const seen=new Set<string>();
 for(const versionRecorded of ['absent','matching','other'] as const)
  for(const folderEmpty of [false,true])
   for(const databaseFilesPresent of [false,true])
    for(const passwordUsable of [false,true])
     for(const markerValid of [false,true])
      for(const digestMatches of [false,true]){
       const inputs={versionRecorded,folderEmpty,databaseFilesPresent,passwordUsable,markerValid,digestMatches};
       const expected=expect(inputs);
       assert.ok(expected,'missing table cell for '+JSON.stringify(inputs));
       const actual=decideDatabaseStart(inputs);
       assert.equal(actual.action,expected.action,JSON.stringify(inputs));
       if(expected.action==='refuse')assert.equal((actual as {cause:string}).cause,expected.cause,JSON.stringify(inputs));
       seen.add(JSON.stringify(inputs));
      }
 assert.equal(seen.size,96,'every combination is covered exactly once');
});

test('a partial password line starts nothing and fails the keeper',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-partial-'));
 const spawned=join(root,'spawned'),binary=join(root,'binary.mjs');
 await writeFile(binary,['#!'+process.execPath,"import {writeFileSync} from 'node:fs';",'writeFileSync('+JSON.stringify(spawned)+',"yes");','setInterval(()=>{},1000);'].join('\n'),{mode:0o755});
 await mkdir(join(root,'data'),{recursive:true,mode:0o700});
 await mkdir(join(root,'tmp'),{recursive:true,mode:0o700});
 const pidFile=join(root,'database.pid');
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 const keeper=spawn(process.execPath,[join(desktop,'daemon-keeper.mjs'),binary,join(root,'data'),join(root,'tmp'),'18490',pidFile,'1'],{stdio:['pipe','ignore','ignore']});
 t.after(()=>keeper.kill('SIGKILL'));
 keeper.stdin.write('abc');
 keeper.stdin.destroy();
 const [code]=await once(keeper,'exit');
 assert.notEqual(code,0,'a partial password line must fail the keeper');
 assert.equal(await stat(spawned).then(()=>true,()=>false),false,'the database binary was never started');
 assert.equal(await stat(pidFile).then(()=>true,()=>false),false,'no pid file was written');
});

test('a killed keeper still ends with the database verified gone',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-keeper-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 const record=await pidRecord(directory);
 process.kill(record.keeper!,'SIGKILL');
 // The daemon fails and ends the recorded database itself; its control socket may already be gone.
 await t.waitFor(async()=>{
  if(alive(record.database))throw new Error('the database survived the keeper kill');
  if(alive(record.core))throw new Error('the core survived the keeper kill');
  return true;
 },{timeout:30_000});
});

test('a core that ignores SIGTERM still leaves the database stopped within the shutdown bound',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-wedge-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root,0,{hangOnSigterm:true}),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 const record=await pidRecord(directory);
 const began=Date.now();
 const drained=await drainDaemon(join(directory,'daemon.sock'),origin);
 assert.equal(drained.status,'unsettled','a core that ignores SIGTERM never drains cleanly');
 assert.ok(Date.now()-began<60_000,'the whole shutdown fits the total bound');
 await t.waitFor(async()=>{
  if(alive(record.database))throw new Error('the database survived the wedged core');
  if(alive(record.keeper))throw new Error('the keeper survived the wedged core');
  return true;
 },{timeout:25_000});
});

test('a planted pid file naming an unrelated live process does not block the start',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-pidfile-'));
 const sleeper=spawn('sleep',['60']);
 t.after(async()=>{sleeper.kill('SIGKILL');await rm(root,{recursive:true,force:true});});
 await once(sleeper,'spawn');
 const {stdout}=await run('ps',['-o','lstart=','-p',String(sleeper.pid)]);
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 await writeFile(join(directory,'database.pid'),JSON.stringify({pid:sleeper.pid,startedAt:Date.parse(stdout.trim())}),{mode:0o600});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running','a planted pid is a hint, not an authority');
 assert.equal(alive(sleeper.pid),true,'the unrelated process is never signalled');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

test('a database that exits right after its start line is refused before any credentialed request',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-dies-'));
 const fixture=await surrealEntry(root,{exitAfterLine:true}),runtime=await makeRuntime(root,fixture),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await assert.rejects(start(root,runtime,entry),(error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start','a dead child cannot vouch for the port');
});

test('a database that dies while running stops the core at once',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-dierun-'));
 const fixture=await surrealEntry(root,{dieAfterMs:800}),runtime=await makeRuntime(root,fixture),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 const record=await pidRecord(directory);
 await t.waitFor(async()=>{
  if(alive(record.core))throw new Error('the core still holds the password pipe');
  return true;
 },{timeout:20_000});
});

test('a failing or hanging ps probe classifies live processes as unknown, sends no signal, and stays inside its phase deadlines',async t=>{
 const sleeper=spawn('sleep',['60']);
 t.after(()=>{try{sleeper.kill('SIGKILL');}catch{}});
 await once(sleeper,'spawn');
 const {stdout}=await run('/bin/ps',['-ww','-o','lstart=','-p',String(sleeper.pid)],{env:{LC_ALL:'C',PATH:'/usr/bin:/bin'}});
 const sleeperStartedAt=Date.parse(stdout.trim());

 const failingProbe=createProcessProbe({run:async()=>{throw new Error('ps failed');}});
 assert.equal(await failingProbe.classify(sleeper.pid!,sleeperStartedAt,()=>true),'unknown');
 const unparsableProbe=createProcessProbe({run:async()=>({stdout:'not a valid ps output\n'})});
 assert.equal(await unparsableProbe.classify(sleeper.pid!,sleeperStartedAt,()=>true),'unknown');
 assert.equal(await stopRecordedProcess(failingProbe,{pid:sleeper.pid!,startedAt:sleeperStartedAt,matchesArgs:()=>true},{termMs:250,killMs:150}),false);
 assert.equal(alive(sleeper.pid),true,'stopRecordedProcess must never signal a process classified as unknown');
 assert.equal(sleeper.exitCode,null);
 assert.equal(sleeper.signalCode,null);

 const hangingProbe=createProcessProbe({run:()=>new Promise(()=>{}),timeoutMs:150});
 const classifyStart=Date.now();
 assert.equal(await hangingProbe.classify(sleeper.pid!,sleeperStartedAt,()=>true),'unknown');
 const classifyElapsed=Date.now()-classifyStart;
 assert.ok(classifyElapsed<500,'a hanging ps must time out near timeoutMs ('+classifyElapsed+' ms)');

 const stopStart=Date.now();
 const stopped=await stopRecordedProcess(hangingProbe,{pid:sleeper.pid!,startedAt:sleeperStartedAt,matchesArgs:()=>true},{termMs:250,killMs:150});
 const stopElapsed=Date.now()-stopStart;
 assert.equal(stopped,false);
 assert.ok(stopElapsed<700,'stopRecordedProcess must stay inside its phase deadlines even when ps hangs ('+stopElapsed+' ms)');
 assert.equal(alive(sleeper.pid),true,'a hanging probe must not signal the unverified pid');

 const productionProbe=createProcessProbe();
 assert.equal(await productionProbe.classify(sleeper.pid!,sleeperStartedAt,args=>args.includes('sleep')),'match','a fake run injected into a test probe does not affect the production-built probe');
 assert.equal(await productionProbe.classify(sleeper.pid!,sleeperStartedAt,()=>false),'gone');
});

test('a keeper whose child never exits reports unconfirmed, keeps the pid file and exits non-zero',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-unconfirmed-'));
 const preload=join(root,'ignore-kill-preload.mjs');
 await writeFile(preload,"import {ChildProcess} from 'node:child_process';\nChildProcess.prototype.kill=()=>true;\n");
 const binary=join(root,'stubborn-child.mjs');
 await writeFile(binary,'#!'+process.execPath+"\nsetInterval(()=>{},1000);\n",{mode:0o755});
 await mkdir(join(root,'data'),{recursive:true,mode:0o700});
 await mkdir(join(root,'tmp'),{recursive:true,mode:0o700});
 const pidFile=join(root,'database.pid');
 const tls=await keeperTls(root);
 let childPid:number|undefined;
 t.after(async()=>{
  if(childPid!==undefined)try{process.kill(childPid,'SIGKILL');}catch{}
  await rm(root,{recursive:true,force:true});
 });
 const keeper=spawn(process.execPath,['--import',preload,join(desktop,'daemon-keeper.mjs'),binary,join(root,'data'),join(root,'tmp'),'18491',pidFile,'0'],{stdio:['pipe','pipe','ignore']});
 t.after(()=>{try{keeper.kill('SIGKILL');}catch{}});
 const messages:Array<Record<string,unknown>>=[];
 let pending='';
 keeper.stdout.setEncoding('utf8');
 keeper.stdout.on('data',chunk=>{
  pending+=chunk;
  for(let end=pending.indexOf('\n');end>=0;end=pending.indexOf('\n')){
   const line=pending.slice(0,end);pending=pending.slice(end+1);
   try{messages.push(JSON.parse(line) as Record<string,unknown>);}catch{}
  }
 });
 keeper.stdin.write('\n'+tls.pathsLine);
 const recorded=await t.waitFor(async()=>{
  const raw=await readFile(pidFile,'utf8');
  const parsed=JSON.parse(raw) as {format?:number;keeper?:{pid?:number};database?:{pid?:number;binary?:string}|null};
  if(!parsed.database?.pid)throw new Error('database entry not written yet');
  return parsed;
 },{timeout:5000});
 childPid=recorded.database!.pid;
 assert.equal(recorded.format,2);
 assert.equal(recorded.database!.binary,binary);
 keeper.stdin.end();
 const [code]=await once(keeper,'exit');
 assert.notEqual(code,0,'an unconfirmed database stop must exit non-zero');
 assert.equal(messages.some(message=>message.exited!==undefined),false,'no exited line may be emitted without observing exit');
 assert.equal(messages.some(message=>message.unconfirmed===childPid),true,'keeper must emit unconfirmed with the child pid');
 const after=JSON.parse(await readFile(pidFile,'utf8')) as {database?:{pid?:number}};
 assert.equal(after.database?.pid,childPid,'the pid file must remain with its database entry');
 assert.equal(alive(childPid),true);
});

test('the previous instance decision has an explicit expectation for every input combination',async t=>{
 const expect=(inputs:PreviousInstanceInputs):PreviousInstanceDecision|undefined=>{
  if(inputs.file==='unreadable')
   return {action:'refuse',cause:'database-start',detail:'could not read the previous database pid file to verify whether a previous database is running; try again'};
  if(inputs.scan==='match')
   return {action:'refuse',cause:'database-start',detail:'a previous database for this data folder is still running'};
  if(inputs.scan==='unknown')
   return {action:'refuse',cause:'database-start',detail:'could not complete the process check for a previous database; try again'};
  if(inputs.file==='absent')return {action:'proceed'};
  if(inputs.file==='malformed')return {action:'remove-stale-and-proceed'};
  if(inputs.keeper==='match'||inputs.database==='match')
   return {action:'refuse',cause:'database-start',detail:'a previous database for this data folder is still running'};
  if(inputs.keeper==='unknown'||inputs.database==='unknown')
   return {action:'refuse',cause:'database-start',detail:'could not verify whether a recorded previous database is still running; try again'};
  return {action:'remove-stale-and-proceed'};
 };
 const seen=new Set<string>();
 for(const file of ['absent','unreadable','malformed','present'] as const)
  for(const keeper of ['match','gone','unknown','none'] as const)
   for(const database of ['match','gone','unknown','none'] as const)
    for(const scan of ['clear','match','unknown'] as const){
     const inputs={file,keeper,database,scan};
     const expected=expect(inputs);
     assert.ok(expected,'missing table cell for '+JSON.stringify(inputs));
     assert.deepEqual(decidePreviousInstance(inputs),expected,JSON.stringify(inputs));
     seen.add(JSON.stringify(inputs));
    }
 assert.equal(seen.size,192,'every combination is covered exactly once');
 // Another Massion on a different data folder leaves scan='clear' and recorded entries='gone'|'none'.
 assert.deepEqual(decidePreviousInstance({file:'absent',keeper:'none',database:'none',scan:'clear'}),{action:'proceed'});
 assert.deepEqual(decidePreviousInstance({file:'present',keeper:'gone',database:'gone',scan:'clear'}),{action:'remove-stale-and-proceed'});
 const root=await mkdtemp(join(await realpath(tmpdir()),'e5-matcher-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const folder=join(root,'database'),otherFolder=join(root,'other-database'),symlinkFolder=join(root,'db-link'),prefixFolder=folder+'-backup';
 await mkdir(folder);
 await symlink(folder,symlinkFolder);
 const matchKeeper=keeperArgsMatcher('/app/daemon-keeper.mjs',folder);
 const matchDatabase=databaseArgsMatcher(folder);
 assert.equal(matchKeeper(process.execPath+' /app/daemon-keeper.mjs /app/surreal '+folder+' '+join(root,'db-tmp')+' 1234 '+join(root,'database.pid')+' 0'),true);
 assert.equal(matchKeeper(process.execPath+' /app/daemon-keeper.mjs /old/surreal '+folder+' '+join(root,'db-tmp')+' 1234 '+join(root,'database.pid')+' 0'),true);
 assert.equal(matchKeeper(process.execPath+' /app/daemon-keeper.mjs /app/surreal '+prefixFolder+' '+join(root,'db-tmp')+' 1234 '+join(root,'database.pid')+' 0'),false);
 const matcherCells:[string,string,boolean,'proceed'|'refuse'][]=[
  ['this binary + this folder','/app/surreal start surrealkv://'+folder+' --bind 127.0.0.1:1234',true,'refuse'],
  ['another binary path + this folder','/other/surreal start surrealkv://'+folder+' --bind 127.0.0.1:1234',true,'refuse'],
  ['this binary + another folder','/app/surreal start surrealkv://'+otherFolder+' --bind 127.0.0.1:1234',false,'proceed'],
  ['this folder written through a symlink','/app/surreal start surrealkv://'+symlinkFolder+' --bind 127.0.0.1:1234',true,'refuse'],
  ['interpreter token before binary + this folder',process.execPath+' /tmp/fixture-surreal.mjs start surrealkv://'+folder+' --bind 127.0.0.1:1234',true,'refuse'],
  ['prefix folder <folder>-backup','/app/surreal start surrealkv://'+prefixFolder+' --bind 127.0.0.1:1234',false,'proceed'],
  ['manual start without trailing flags','/usr/local/bin/surreal start surrealkv://'+folder,true,'refuse']
 ];
 for(const [label,args,expectedMatch,expectedAction] of matcherCells){
  const matched=matchDatabase(args);
  assert.equal(matched,expectedMatch,label);
  const decision=decidePreviousInstance({file:'absent',keeper:'none',database:'none',scan:matched?'match':'clear'});
  assert.equal(decision.action,expectedAction,label);
 }
 // A pid file naming an older binary path still classifies record.database.pid by data folder rather than assuming 'gone'.
 const olderBinaryPidFile=join(root,'database.pid');
 await writeFile(olderBinaryPidFile,JSON.stringify({
  format:2,
  keeper:{pid:999998,startedAt:1000},
  database:{pid:process.pid,startedAt:1000,binary:'/old/version/surreal'}
 }),{mode:0o600});
 const pidFileDecision=await checkPreviousInstance({
  probe:{
   async scanProcesses(){return 'clear';},
   async classify(pid){return pid===process.pid?'match':'gone';}
  },
  pidFile:olderBinaryPidFile,
  keeperPath:'/app/daemon-keeper.mjs',
  dataDirectory:folder
 });
 assert.equal(pidFileDecision.action,'refuse');
});

test('a live previous keeper and database are recognised, block the start without unlinking the pid file, and clear once closed',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-prev-live-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 let manualKeeper:import('node:child_process').ChildProcess|undefined;
 let manualDatabasePid:number|undefined;
 t.after(async()=>{
  await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
  if(manualKeeper&&manualKeeper.exitCode===null&&manualKeeper.signalCode===null)try{manualKeeper.kill('SIGKILL');}catch{}
  if(manualDatabasePid!==undefined)try{process.kill(manualDatabasePid,'SIGKILL');}catch{}
  await rm(root,{recursive:true,force:true});
 });
 await start(root,runtime,entry);
 await drainDaemon(join(directory,'daemon.sock'),origin);

 const probeServer=createServer();
 probeServer.listen(0,'127.0.0.1');
 await once(probeServer,'listening');
 const freeDatabasePort=(probeServer.address() as {port:number}).port;
 await new Promise<void>(resolve=>probeServer.close(()=>resolve()));

 const canonicalBinary=await realpath(join(runtime,'surreal'));
 const pidFile=join(directory,'database.pid');
 const tls=await keeperTls(root);
 manualKeeper=spawn(process.execPath,[join(desktop,'daemon-keeper.mjs'),canonicalBinary,join(directory,'database'),join(directory,'db-tmp'),String(freeDatabasePort),pidFile,'0'],{stdio:['pipe','pipe','ignore']});
 manualKeeper.stdout!.resume();
 manualKeeper.stdin!.write('\n'+tls.pathsLine);
 const recorded=await t.waitFor(async()=>{
  const parsed=JSON.parse(await readFile(pidFile,'utf8')) as {format?:number;keeper?:{pid?:number};database?:{pid?:number;binary?:string}|null};
  if(!parsed.database?.pid)throw new Error('database entry not yet recorded');
  return parsed;
 },{timeout:5000});
 manualDatabasePid=recorded.database!.pid;

 await assert.rejects(
  start(root,runtime,entry),
  (error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start'&&error.failure.detail.includes('still running')
 );
 assert.equal(await stat(pidFile).then(()=>true,()=>false),true,'the pid file must stay when a live previous instance blocks start');
 assert.equal(alive(manualKeeper.pid),true,'the previous keeper must not be signalled');
 assert.equal(alive(manualDatabasePid),true,'the previous database must not be signalled');

 await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
 manualKeeper.stdin!.end();
 await once(manualKeeper,'close');
 manualDatabasePid=undefined;

 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');
 assert.equal(status.status,'running','once the previous instance exits, the next start succeeds');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

test('a database started from a copied binary at another path on this data folder refuses start without signalling it',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e5-other-binary-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 const copiedBinary=join(root,'older-surreal');
 await copyFile(surrealBinary,copiedBinary);
 await chmod(copiedBinary,0o755);
 let otherDatabase:import('node:child_process').ChildProcess|undefined;
 t.after(async()=>{
  await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
  if(otherDatabase&&otherDatabase.exitCode===null&&otherDatabase.signalCode===null)try{otherDatabase.kill('SIGKILL');}catch{}
  await rm(root,{recursive:true,force:true});
 });
 await start(root,runtime,entry);
 await drainDaemon(join(directory,'daemon.sock'),origin);

 const probeServer=createServer();
 probeServer.listen(0,'127.0.0.1');
 await once(probeServer,'listening');
 const freePort=(probeServer.address() as {port:number}).port;
 await new Promise<void>(resolve=>probeServer.close(()=>resolve()));

 otherDatabase=spawn(copiedBinary,['start','surrealkv://'+join(directory,'database'),'--bind','127.0.0.1:'+freePort,'--no-banner','--temporary-directory',join(directory,'db-tmp'),'--unauthenticated'],{stdio:['ignore','pipe','pipe']});
 let bound=false;
 const watch=(stream:NodeJS.ReadableStream|null)=>{
  stream?.setEncoding('utf8');
  stream?.on('data',(chunk:string)=>{if(chunk.includes('Started web server on'))bound=true;});
 };
 watch(otherDatabase.stdout);
 watch(otherDatabase.stderr);
 await t.waitFor(()=>{if(!bound)throw new Error('copied binary database did not bind yet');},{timeout:10_000});

 await assert.rejects(
  start(root,runtime,entry),
  (error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start'&&error.failure.detail.includes('still running')
 );
 assert.equal(alive(otherDatabase.pid),true,'the database started from another binary path must not be signalled');
 await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});

 otherDatabase.kill('SIGTERM');
 await once(otherDatabase,'exit');
 otherDatabase=undefined;

 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');
 assert.equal(status.status,'running','once the other-binary database exits, start succeeds');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

test('a planted pid file (format 2 or legacy) naming an unrelated surreal binary does not block the start and is never signalled',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-unrelated-surreal-'));
 const runtime=await makeRuntime(root,surrealBinary,{copy:true}),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 const sleeper=spawn('sleep',['60']);
 const unrelatedSurreal=spawn(surrealBinary,['start','memory','--bind','127.0.0.1:0','--no-banner','--unauthenticated'],{stdio:['ignore','ignore','ignore']});
 t.after(async()=>{
  await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
  try{sleeper.kill('SIGKILL');}catch{}
  try{unrelatedSurreal.kill('SIGKILL');}catch{}
  await rm(root,{recursive:true,force:true});
 });
 await Promise.all([once(sleeper,'spawn'),once(unrelatedSurreal,'spawn')]);
 const [{stdout:sleeperOut},{stdout:surrealOut}]=await Promise.all([
  run('/bin/ps',['-ww','-o','lstart=','-p',String(sleeper.pid)],{env:{LC_ALL:'C',PATH:'/usr/bin:/bin'}}),
  run('/bin/ps',['-ww','-o','lstart=','-p',String(unrelatedSurreal.pid)],{env:{LC_ALL:'C',PATH:'/usr/bin:/bin'}})
 ]);
 const surrealStartedAt=Date.parse(surrealOut.trim());
 // Regression guard for existing behaviour (guards 776bb71 / 8c61a2c, not a new fix):
 // legacy pid files matched comm=surreal regardless of binary path or data folder.
 await writeFile(join(directory,'database.pid'),JSON.stringify({pid:unrelatedSurreal.pid,startedAt:surrealStartedAt}),{mode:0o600});
 await start(root,runtime,entry);
 const legacyStatus=await control(join(directory,'daemon.sock'),'status');
 assert.equal(legacyStatus.status,'running','a legacy pid file naming an unrelated surreal must not block our start');
 assert.equal(alive(unrelatedSurreal.pid),true);
 await drainDaemon(join(directory,'daemon.sock'),origin);

 const canonicalBinary=await realpath(join(runtime,'surreal'));
 await writeFile(join(directory,'database.pid'),JSON.stringify({
  format:2,
  keeper:{pid:sleeper.pid,startedAt:Date.parse(sleeperOut.trim())},
  database:{pid:unrelatedSurreal.pid,startedAt:surrealStartedAt,binary:canonicalBinary}
 }),{mode:0o600});

 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');
 assert.equal(status.status,'running','an unrelated surreal process must not block our start');
 assert.equal(alive(sleeper.pid),true,'the planted keeper pid must not be signalled');
 assert.equal(alive(unrelatedSurreal.pid),true,'the planted unrelated surreal must not be signalled');
 await drainDaemon(join(directory,'daemon.sock'),origin);
 assert.equal(alive(sleeper.pid),true);
 assert.equal(alive(unrelatedSurreal.pid),true);
});

test('a core that ignores SIGTERM is killed within the 500 ms bound after the database dies while running',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-core-loss-'));
 const diedFile=join(root,'db-died');
 const fixture=await surrealEntry(root,{dieAfterMs:1200,diedFile}),runtime=await makeRuntime(root,fixture),entry=await coreEntry(root,0,{hangOnSigterm:true}),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');assert.equal(status.status,'running');
 const record=await pidRecord(directory);
 assert.equal(typeof record.core,'number','the core pid must be recorded');
 assert.equal(alive(record.core),true,'the core must be alive before database death');
 await t.waitFor(async()=>{
  if(alive(record.core))throw new Error('the core survived database death');
  return true;
 },{timeout:5000});
 const stoppedAt=Date.now();
 const diedAt=Number(await readFile(diedFile,'utf8'));
 assert.ok(stoppedAt-diedAt<2500,'core must stop within bound after database dies ('+(stoppedAt-diedAt)+' ms)');
});

test('a database that dies while waiting for the core during startup fails with database-start and stops the core',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-die-during-start-'));
 const killDbFile=join(root,'kill-db');
 const fixture=await surrealEntry(root,{dieAfterFile:killDbFile}),runtime=await makeRuntime(root,fixture),entry=await coreEntry(root,0,{listenDelayMs:5000}),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 const launching=start(root,runtime,entry);
 const record=await t.waitFor(async()=>{
  const current=await pidRecord(directory);
  if(typeof current.core!=='number'||!alive(current.core))throw new Error('core not yet started');
  await access(join(root,'core-evidence.json'));
  return current;
 },{timeout:10_000});
 assert.equal(typeof record.core,'number');
 assert.equal(alive(record.core),true,'the core must be alive while waiting for readiness');
 await writeFile(killDbFile,'go');
 await assert.rejects(
  launching,
  (error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start'
 );
 await t.waitFor(async()=>{
  if(alive(record.core))throw new Error('core survived startup database death');
  return true;
 },{timeout:3000});
 assert.equal(await stat(join(root,'core-listening')).then(()=>true,()=>false),false,'core must be stopped before it finishes starting');
});

test('a keeper whose stdout stays open past both waits causes drain to return unsettled',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-keeper-open-stdout-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 const preload=join(root,'keep-stdout-open-preload.mjs');
 await writeFile(preload,[
  "import {ChildProcess} from 'node:child_process';",
  'const origKill=ChildProcess.prototype.kill;',
  'ChildProcess.prototype.kill=function(signal){',
  " if(signal==='SIGKILL'&&this.spawnargs?.some(arg=>arg.includes('daemon-keeper.mjs')))return true;",
  ' return origKill.call(this,signal);',
  '};',
  'const origSpawn=ChildProcess.prototype.spawn;',
  'ChildProcess.prototype.spawn=function(options){',
  ' const result=origSpawn.call(this,options);',
  " if(this.spawnargs?.some(arg=>arg.includes('daemon-keeper.mjs'))&&this.stdin){",
  '  this.stdin.write=()=>true;',
  '  this.stdin.end=()=>this.stdin;',
  ' }',
  ' return result;',
  '};'
 ].join('\n')+'\n');
 const nodeWrapper=join(root,'node-wrapper.sh');
 await writeFile(nodeWrapper,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(preload)} "$@"\n`,{mode:0o755});
 let recorded:{pid:number;keeper?:number}|undefined;
 t.after(async()=>{
  if(recorded?.keeper)try{process.kill(recorded.keeper,'SIGKILL');}catch{}
  if(recorded?.pid)try{process.kill(recorded.pid,'SIGKILL');}catch{}
  await rm(root,{recursive:true,force:true});
 });
 const launching=launchDaemon({node:nodeWrapper,runner,entry,directory,socket:join(directory,'daemon.sock'),origin,runtimeDirectory:runtime,environment});
 launching.catch(()=>{});
 recorded=await t.waitFor(async()=>{
  const current=await pidRecord(directory);
  if(!current.keeper)throw new Error('keeper not yet spawned');
  return current;
 },{timeout:10_000});
 const drained=await drainDaemon(join(directory,'daemon.sock'),origin);
 assert.equal(drained.status,'unsettled','drain must return unsettled when keeper stdout never closes and keeper is not proved gone');
 assert.equal(alive(recorded.keeper),true);
});

test('a live database with its pid file removed refuses start without signalling it and clears once it exits',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-missing-pidfile-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 let manualKeeper:import('node:child_process').ChildProcess|undefined;
 let manualDatabasePid:number|undefined;
 t.after(async()=>{
  await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
  if(manualKeeper&&manualKeeper.exitCode===null&&manualKeeper.signalCode===null)try{manualKeeper.kill('SIGKILL');}catch{}
  if(manualDatabasePid!==undefined)try{process.kill(manualDatabasePid,'SIGKILL');}catch{}
  await rm(root,{recursive:true,force:true});
 });
 await start(root,runtime,entry);
 await drainDaemon(join(directory,'daemon.sock'),origin);

 const probeServer=createServer();
 probeServer.listen(0,'127.0.0.1');
 await once(probeServer,'listening');
 const freeDatabasePort=(probeServer.address() as {port:number}).port;
 await new Promise<void>(resolve=>probeServer.close(()=>resolve()));

 const canonicalBinary=await realpath(join(runtime,'surreal'));
 const pidFile=join(directory,'database.pid');
 const tls=await keeperTls(root);
 manualKeeper=spawn(process.execPath,[join(desktop,'daemon-keeper.mjs'),canonicalBinary,join(directory,'database'),join(directory,'db-tmp'),String(freeDatabasePort),pidFile,'0'],{stdio:['pipe','pipe','ignore']});
 manualKeeper.stdout!.resume();
 manualKeeper.stdin!.write('\n'+tls.pathsLine);
 const recorded=await t.waitFor(async()=>{
  const parsed=JSON.parse(await readFile(pidFile,'utf8')) as {database?:{pid?:number}|null};
  if(!parsed.database?.pid)throw new Error('database entry not yet recorded');
  return parsed;
 },{timeout:5000});
 manualDatabasePid=recorded.database!.pid;
 await rm(pidFile);

 await assert.rejects(
  start(root,runtime,entry),
  (error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start'&&error.failure.detail.includes('still running')
 );
 assert.equal(alive(manualDatabasePid),true,'the live database must not be signalled even without a pid file');

 await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
 manualKeeper.stdin!.end();
 await once(manualKeeper,'close');
 manualDatabasePid=undefined;

 await start(root,runtime,entry);
 assert.equal((await control(join(directory,'daemon.sock'),'status')).status,'running');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

test('a live database with a pid file saying database null and a dead keeper refuses start',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-null-db-pidfile-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 let manualDatabasePid:number|undefined;
 t.after(async()=>{
  await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
  if(manualDatabasePid!==undefined)try{process.kill(manualDatabasePid,'SIGKILL');}catch{}
  await rm(root,{recursive:true,force:true});
 });
 await start(root,runtime,entry);
 await drainDaemon(join(directory,'daemon.sock'),origin);

 const probeServer=createServer();
 probeServer.listen(0,'127.0.0.1');
 await once(probeServer,'listening');
 const freeDatabasePort=(probeServer.address() as {port:number}).port;
 await new Promise<void>(resolve=>probeServer.close(()=>resolve()));

 const canonicalBinary=await realpath(join(runtime,'surreal'));
 const pidFile=join(directory,'database.pid');
 const tls=await keeperTls(root);
 const manualKeeper=spawn(process.execPath,[join(desktop,'daemon-keeper.mjs'),canonicalBinary,join(directory,'database'),join(directory,'db-tmp'),String(freeDatabasePort),pidFile,'0'],{stdio:['pipe','pipe','ignore']});
 manualKeeper.stdout!.resume();
 manualKeeper.stdin!.write('\n'+tls.pathsLine);
 const recorded=await t.waitFor(async()=>{
  const parsed=JSON.parse(await readFile(pidFile,'utf8')) as {format:number;keeper:{pid:number;startedAt:number};database:{pid?:number}|null};
  if(!parsed.database?.pid)throw new Error('database entry not yet recorded');
  return parsed;
 },{timeout:5000});
 manualDatabasePid=recorded.database!.pid;
 manualKeeper.kill('SIGKILL');
 await once(manualKeeper,'close');
 await writeFile(pidFile,JSON.stringify({format:2,keeper:recorded.keeper,database:null}),{mode:0o600});

 await assert.rejects(
  start(root,runtime,entry),
  (error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start'&&error.failure.detail.includes('still running')
 );
 assert.equal(alive(manualDatabasePid),true);
});

test('an unreadable pid file refuses start',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-unreadable-pidfile-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 const pidFile=join(directory,'database.pid');
 await writeFile(pidFile,'{}',{mode:0o000});
 t.after(async()=>{
  await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
  await chmod(pidFile,0o600).catch(()=>{});
  await rm(root,{recursive:true,force:true});
 });
 await assert.rejects(
  start(root,runtime,entry),
  (error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start'&&error.failure.detail.includes('could not read')&&error.failure.detail.includes('try again')
 );
});

test('a failing or hanging process-list scan refuses previous-instance check with a try-again detail',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-scan-fail-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const failingProbe=createProcessProbe({run:async()=>{throw new Error('ps scan failed');}});
 assert.equal(await failingProbe.scanProcesses(()=>false),'unknown');
 const failedDecision=await checkPreviousInstance({
  probe:failingProbe,
  pidFile:join(root,'database.pid'),
  keeperPath:join(desktop,'daemon-keeper.mjs'),
  dataDirectory:join(root,'database')
 });
 assert.equal(failedDecision.action,'refuse');
 if(failedDecision.action==='refuse'){
  assert.equal(failedDecision.cause,'database-start');
  assert.match(failedDecision.detail,/could not complete.*try again/);
 }
 const hangingProbe=createProcessProbe({run:()=>new Promise(()=>{}),timeoutMs:150});
 const timedOutDecision=await checkPreviousInstance({
  probe:hangingProbe,
  pidFile:join(root,'database.pid'),
  keeperPath:join(desktop,'daemon-keeper.mjs'),
  dataDirectory:join(root,'database')
 });
 assert.equal(timedOutDecision.action,'refuse');
 if(timedOutDecision.action==='refuse'){
  assert.equal(timedOutDecision.cause,'database-start');
  assert.match(timedOutDecision.detail,/could not complete.*try again/);
 }
});

// Regression guard for existing behaviour (passes on 8c61a2c as well, not a new fix):
// another database holding a different data folder must not block our start.
test('a second database of the same bundled binary on a different data folder does not block start and is never signalled',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-other-folder-'));
 const runtime=await makeRuntime(root),entry=await coreEntry(root),directory=join(root,'user'),otherDirectory=join(root,'other-user');
 await mkdir(directory,{mode:0o700});
 await mkdir(join(otherDirectory,'database'),{recursive:true,mode:0o700});
 await mkdir(join(otherDirectory,'db-tmp'),{recursive:true,mode:0o700});
 let otherKeeper:import('node:child_process').ChildProcess|undefined;
 let otherDatabasePid:number|undefined;
 t.after(async()=>{
  await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
  if(otherKeeper&&otherKeeper.exitCode===null&&otherKeeper.signalCode===null)try{otherKeeper.kill('SIGKILL');}catch{}
  if(otherDatabasePid!==undefined)try{process.kill(otherDatabasePid,'SIGKILL');}catch{}
  await rm(root,{recursive:true,force:true});
 });
 const probeServer=createServer();
 probeServer.listen(0,'127.0.0.1');
 await once(probeServer,'listening');
 const freePort=(probeServer.address() as {port:number}).port;
 await new Promise<void>(resolve=>probeServer.close(()=>resolve()));

 const canonicalBinary=await realpath(join(runtime,'surreal'));
 const otherPidFile=join(otherDirectory,'database.pid');
 const tls=await keeperTls(root);
 otherKeeper=spawn(process.execPath,[join(desktop,'daemon-keeper.mjs'),canonicalBinary,join(otherDirectory,'database'),join(otherDirectory,'db-tmp'),String(freePort),otherPidFile,'0'],{stdio:['pipe','pipe','ignore']});
 otherKeeper.stdout!.resume();
 otherKeeper.stdin!.write('\n'+tls.pathsLine);
 const recorded=await t.waitFor(async()=>{
  const parsed=JSON.parse(await readFile(otherPidFile,'utf8')) as {database?:{pid?:number}|null};
  if(!parsed.database?.pid)throw new Error('other database not yet recorded');
  return parsed;
 },{timeout:5000});
 otherDatabasePid=recorded.database!.pid;

 await start(root,runtime,entry);
 const status=await control(join(directory,'daemon.sock'),'status');
 assert.equal(status.status,'running','a second database on another data folder must not block start');
 assert.equal(alive(otherKeeper.pid),true,'the other keeper must not be signalled');
 assert.equal(alive(otherDatabasePid),true,'the other database must not be signalled');
 await drainDaemon(join(directory,'daemon.sock'),origin);
 assert.equal(alive(otherKeeper.pid),true);
 assert.equal(alive(otherDatabasePid),true);
});

test('a database that dies right after bootstrap verification still leaves a valid marker and allows the next start without re-bootstrapping',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-die-after-verify-'));
 const releaseFile=join(root,'rpc-release');
 const failingFixture=await surrealEntry(root,{dieAfterBootstrapReleaseFile:releaseFile});
 const runtime=await makeRuntime(root,failingFixture),entry=await coreEntry(root,0,{listenDelayMs:500}),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 const startPromise=start(root,runtime,entry);
 // Force the race: wait until the database process exits after flushing the verification response body,
 // then give the keeper-to-supervisor stdout pipe time to deliver {exited} before finishing the HTTP response.
 const databasePid=await t.waitFor(async()=>{
  const record=await pidRecord(directory);
  if(record.database===undefined)throw new Error('database pid not yet recorded');
  return record.database;
 },{timeout:5000});
 await t.waitFor(()=>{if(alive(databasePid))throw new Error('database still alive');},{timeout:5000,interval:10});
 await new Promise(resolve=>setTimeout(resolve,200));
 await writeFile(releaseFile,'yes');
 await assert.rejects(
  startPromise,
  (error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start'
 );
 await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});
 const password=await readFile(join(directory,'database','password'),'utf8');
 const marker=JSON.parse(await readFile(join(directory,'database','initialized'),'utf8')) as {salt:string;digest:string};
 assert.equal(marker.digest,digestOf(marker.salt,password),'initialized marker must be written and valid once verifyBootstrap succeeded');

 const healthyFixture=await surrealEntry(root);
 await rm(join(runtime,'surreal'));
 await symlink(healthyFixture,join(runtime,'surreal'));
 await writeFile(join(runtime,'manifest.json'),JSON.stringify({node:{version:'24.19.0',sha256:'0'.repeat(64)},surreal:{version:surrealVersion,sha256:await sha256(healthyFixture)}})+'\n');

 await start(root,runtime,await coreEntry(root));
 const status=await control(join(directory,'daemon.sock'),'status');
 assert.equal(status.status,'running');
 const record=await pidRecord(directory);
 assert.ok(record.database);
 assert.equal(await environmentHas(record.database,'SURREAL_PASS='),false,'the next start must use the existing marker without re-bootstrapping');
 await drainDaemon(join(directory,'daemon.sock'),origin);
});

test('a database that dies while the core readiness response is in flight rejects with database-start and stops the core',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'e4-die-inflight-auth-'));
 const authFile=join(root,'auth-inflight');
 const authSigtermFile=join(root,'auth-sigterm-observed');
 const fixture=await surrealEntry(root,{dieAfterFile:authFile});
 const entry=await coreEntry(root,0,{hangOnSigterm:true,authFile,respondAuthOnSigterm:true,authSigtermFile});
 const runtime=await makeRuntime(root,fixture),directory=join(root,'user');
 await mkdir(directory,{mode:0o700});
 t.after(async()=>{await drainDaemon(join(directory,'daemon.sock'),origin).catch(()=>{});await rm(root,{recursive:true,force:true});});
 const observedStates:string[]=[];
 let polling=true;
 const pollStates=(async()=>{
  while(polling){
   const reply=await control(join(directory,'daemon.sock'),'status').catch(()=>null);
   if(reply)observedStates.push(reply.status);
   await new Promise(resolve=>setTimeout(resolve,10));
  }
 })();
 await assert.rejects(
  start(root,runtime,entry),
  (error:unknown)=>error instanceof RuntimeStartFailureError&&error.failure.cause==='database-start'
 );
 polling=false;
 await pollStates;
 assert.equal(await stat(authSigtermFile).then(()=>true,()=>false),true,'core must only answer /desktop-auth after receiving SIGTERM triggered by the database exit notice');
 assert.equal(observedStates.includes('running'),false,'daemon state must never become running: '+JSON.stringify(observedStates));
 const status=await control(join(directory,'daemon.sock'),'status');
 assert.equal(status.status,'failed','state must never become running when database dies before readiness completes');
 const record=await pidRecord(directory);
 assert.equal(typeof record.core,'number','the core pid must have been recorded');
 assert.equal(alive(record.core),false,'the core must be stopped after database death during readiness');
});
