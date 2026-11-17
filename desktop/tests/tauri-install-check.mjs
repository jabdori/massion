// CI only (T2 items 3 and 5): the install check on the real unpacked archive.
// The app reports on itself (feedSubscribed is the only pass condition; connectRetries
// and the start time are reported values, three first runs and three second
// runs), the daemon secret is proven required against the packaged daemon and
// the inert-without-the-variable path is proven. Nothing here runs on a
// developer Mac.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {control} from '../daemon.ts';
import {installCheckContamination,installCheckKeys} from '../install-check.ts';

const archive=process.env.MASSION_TAURI_ARCHIVE,out=resolve(process.env.MASSION_INSTALL_OUT||'');
if(!archive||!out)throw new Error('Set MASSION_TAURI_ARCHIVE and MASSION_INSTALL_OUT');
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
const dataDir=home=>join(home,'Library','Application Support','app.massion.desktop');
const reportPath=home=>join(dataDir(home),'install-check.json');
const run=(file,args,options={})=>spawnSync(file,args,{encoding:'utf8',...options});
const measurements=[];
// Redacted diagnostics for the job log only: home and workspace prefixes never
// appear, so the printed lines can be read by anyone without leaking anything.
const redact=(text,home)=>String(text)
 .split(home).join('<home>')
 .split(process.env.GITHUB_WORKSPACE??'\u0000').join('<workspace>')
 .replace(/\/Users\/[A-Za-z0-9._-]+/g,'<user>')
 .replace(/\/home\/[A-Za-z0-9._-]+/g,'<user>');
async function printDiagnostics(name,home,child){
 try{
  const status=await control(join(dataDir(home),'daemon.sock'),'status');
  console.log('['+name+'] supervisor status: '+JSON.stringify(status));
 }catch(error){
  console.log('['+name+'] supervisor status unavailable: '+error.code);
 }
 try{
  const text=(await readFile(join(dataDir(home),'daemon.log'),'utf8')).split('\n').slice(-30).join('\n');
  console.log('['+name+'] supervisor log tail (redacted):\n'+redact(text,home));
 }catch{console.log('['+name+'] no supervisor log');}
 console.log('['+name+'] app log (redacted):\n'+redact(child?.state?.logs??'',home));
}

async function knownSecrets(home){
 // The scan must never run vacuous: the paths are always obtainable, and a
 // secret that exists but could not be read is a failure, not a skip. What is
 // still NOT searched for is said plainly in the PR description.
 const secrets=[home,dataDir(home)];
 const missing=[];
 let status=null;
 try{status=await control(join(dataDir(home),'daemon.sock'),'status');}catch(error){
  if(error.code!=='ENOENT'&&error.code!=='ECONNREFUSED')missing.push('daemon secret (status failed: '+error.code+')');
 }
 if(status&&status.origin){
  const credentials=await control(join(dataDir(home),'daemon.sock'),'credentials').catch(()=>null);
  if(credentials&&credentials.secret)secrets.push(credentials.secret);
  else missing.push('daemon secret (supervisor answered but credentials returned none)');
 }
 try{secrets.push((await readFile(join(dataDir(home),'database','password'),'utf8')).trim());}
 catch(error){missing.push(error.code==='ENOENT'?'database password (never created: the managed start did not reach initialisation)':'database password (read failed: '+error.code+')');}
 return {secrets,missing};
}

async function timeoutEvidence(name,home,child){
 await printDiagnostics(name,home,child);
 const log=join(dataDir(home),'daemon.log');
 let text='';
 try{text=(await readFile(log,'utf8')).split('\n').slice(-200).join('\n');}catch{}
 const partial=existsSync(reportPath(home))?await readFile(reportPath(home),'utf8'):'';
 const {secrets,missing}=await knownSecrets(home);
 if(missing.some(item=>item.startsWith('daemon secret (supervisor answered')))throw new Error('The timeout evidence scan could not obtain a secret that exists: '+missing.join('; '));
 if(missing.length)console.log('['+name+'] secrets not present to search for: '+missing.join('; '));
 const contamination=installCheckContamination(text+partial,secrets);
 if(contamination){
  console.error('The timed-out check '+name+' would upload evidence that contains '+contamination+': refusing to upload; the job fails.');
  await rm(home,{recursive:true,force:true});
  process.exit(1);
 }
 await writeFile(join(out,name+'.timeout.log'),'App alive: '+(child.exitCode===null)+'\n'+text+'\n'+partial);
 await rm(home,{recursive:true,force:true});
 throw new Error('The install check '+name+' timed out; evidence written to '+name+'.timeout.log');
}

async function drainSupervisor(home){
 try{await control(join(dataDir(home),'daemon.sock'),'drain');}catch{}
 for(let n=0;n<100&&existsSync(join(dataDir(home),'daemon.sock'));n++)await delay(200);
}

function startApp(place,home,withVariable){
 // macOS sun_path holds 104 bytes INCLUDING the terminator. A home that makes
 // the supervisor's socket path longer kills the supervisor at listen (EINVAL)
 // and looks like a startup timeout - assert the real length up front.
 const socketBytes=Buffer.byteLength(join(dataDir(home),'daemon.sock'));
 assert.ok(socketBytes<=103,'The supervisor socket path would exceed the macOS sun_path limit: '+socketBytes+' bytes');
 console.log('[check] supervisor socket path '+socketBytes+' bytes (macOS sun_path limit 104)');
 const executable=join(place,'Massion.app','Contents','MacOS','Massion');
 const environment={HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
 if(withVariable)environment.MASSION_INSTALL_CHECK='1';
 const child=spawn(executable,[],{env:environment,stdio:['ignore','pipe','pipe']});
 const state={logs:''};
 child.stdout.on('data',chunk=>state.logs+=chunk);
 child.stderr.on('data',chunk=>state.logs+=chunk);
 child.on('error',error=>state.logs+=error.message);
 child.state=state;
 return child;
}

async function oneCheckRun(name,place,home){
 // A second run in the same place must not read the previous run's report.
 await rm(reportPath(home),{force:true});
 const child=startApp(place,home,true);
 // The supervisor's own serial worst case on a first run (previous-instance
 // probe 30 s + keeper bound 30 s + bootstrap 10 s + core 30 s, plus hashing
 // and process spawning) sits near 106 s; the driver's bound must exceed it
 // with real margin or a healthy slow first start reads as a timeout.
 const deadline=Date.now()+240000;
 while(!existsSync(reportPath(home))){
  if(child.exitCode!==null)throw new Error('The app exited ('+child.exitCode+') before writing the report: '+child.state.logs);
  if(Date.now()>deadline)await timeoutEvidence(name,home,child);
  await delay(250);
 }
 const raw=await readFile(reportPath(home),'utf8');
 const report=JSON.parse(raw);
 assert.deepEqual(Object.keys(report),[...installCheckKeys],'the status file carries exactly the closed key list');
 const {secrets,missing}=await knownSecrets(home);
 assert.deepEqual(missing,[],'the scan must search for every secret it is supposed to find; unobtainable: '+missing.join('; '));
 const contamination=installCheckContamination(raw,secrets);
 assert.equal(contamination,undefined,'the status file must carry no secret and no home path');
 // The app can exit within the same 250 ms poll that found the report; reading
 // exitCode first avoids racing a listener against an already-emitted exit.
 const code=child.exitCode!==null?child.exitCode:await Promise.race([once(child,'exit').then(([code])=>code),delay(15000).then(()=>'alive')]);
 assert.equal(code,0,'the check makes the app exit cleanly: '+child.state.logs);
 assert.equal(report.feedSubscribed,true,'the install check passes only when the feed subscription was acknowledged and delivered');
 assert.equal(report.coreState,'running','the install check passes only when the core reached running');
 assert.equal(report.databaseState,'running','the install check passes only when the database is served');
 assert.equal(report.databaseTls,true,'the install check passes only when the database answers over the pinned TLS connection');
 assert.equal(report.secretRequired,true,'the install check passes only when the daemon secret is required');
 // Issue #182 against the packaged daemon: a request without the secret is refused.
 const status=await control(join(dataDir(home),'daemon.sock'),'status');
 assert.equal((await fetch(status.origin+'/health')).status,401,'the packaged daemon refuses an unauthenticated request');
 await drainSupervisor(home);
 await writeFile(join(out,name+'.install-check.json'),raw);
 measurements.push({run:name,connectRetries:report.connectRetries,feedSubscribed:report.feedSubscribed,startToReadyMs:report.startToReadyMs});
 return report;
}

const places=join(out,'places');
await mkdir(places,{recursive:true});
function unpack(name){
 const place=join(places,name);
 run('rm',['-rf',place]);
 run('mkdir',['-p',place]);
 run('ditto',['-x','-k',resolve(archive),place]);
 run('xattr',['-rc',join(place,'Massion.app')]);
 return place;
}
async function freshHome(name){
 // os.tmpdir() on macOS is usually /var/folders/<2>/<~30>/T (about 49 bytes);
 // with the fixed 60-byte suffix that would exceed sun_path again. An explicit
 // short base keeps the full socket path around 76 bytes.
 const home=await mkdtemp('/tmp/mi-');
 await mkdir(join(home,'Library','Application','Support'),{recursive:true,mode:0o700});
 console.log('[check] '+name+' runs with home '+home+' ('+Buffer.byteLength(join(dataDir(home),'daemon.sock'))+'-byte socket path)');
 return home;
}

// Three first runs (a freshly unpacked app each time) and three second runs
// from the same place: connectRetries, feedSubscribed and the time to ready.
for(let index=1;index<=3;index++){
 const place=unpack('first-'+index),home=await freshHome('first-'+index);
 await oneCheckRun('first-'+index,place,home);
 await oneCheckRun('second-'+index,place,home);
 // The copied reports are the evidence; the run's home (database password, logs)
 // never travels with the artifact.
 await rm(home,{recursive:true,force:true});
}

// Inert without the variable: no report and the app does not exit.
{
 const place=unpack('inert'),home=await freshHome('inert');
 const child=startApp(place,home,false);
 await delay(20000);
 assert.equal(existsSync(reportPath(home)),false,'without the variable no report is written');
 assert.equal(child.exitCode,null,'without the variable the app does not exit: '+child.state.logs);
 child.kill('SIGTERM');
 await Promise.race([once(child,'exit'),delay(10000)]);
 await drainSupervisor(home);
 await rm(home,{recursive:true,force:true});
 measurements.push({run:'inert',connectRetries:null,feedSubscribed:null,startToReadyMs:null});
}

const table=['| run | connectRetries | feedSubscribed | startToReadyMs |','| --- | --- | --- | --- |',...measurements.map(item=>'| '+item.run+' | '+item.connectRetries+' | '+item.feedSubscribed+' | '+item.startToReadyMs+' |')].join('\n');
await writeFile(join(out,'measurements.md'),table+'\n');
await writeFile(join(out,'measurements.json'),JSON.stringify({measurements},null,2)+'\n');
console.log(table);
