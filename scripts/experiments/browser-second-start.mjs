import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {once} from 'node:events';
import {existsSync,lstatSync,readFileSync,readdirSync,readlinkSync} from 'node:fs';
import {createServer} from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {dirname,join,relative} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

const {HOME:home,TMPDIR:temp,B1_CERT:cert,B1_CHROME:chrome,B1_CONDITION:condition}=process.env;
assert.ok(['immediate','five-seconds','processes-gone','stopped-processes','residue','residue-long'].includes(condition));
const cgroup=join('/sys/fs/cgroup',readFileSync('/proc/self/cgroup','utf8').trim().split('::')[1]);
const ioMax=readFileSync(join(cgroup,'io.max'),'utf8').trim();
assert.match(ioMax,/\brbps=2000000\b/);
console.log('B1_IO',ioMax);
const execFile=childProcess.execFile;
const execute=promisify(execFile);
const rounded=ms=>Math.round(ms*10)/10;
const moment=()=>performance.now();
const emit=(key,data)=>console.log('B1_'+key,JSON.stringify(data));
const commands=[];
let first,proxyPort;

function observedExecFile(...args){
 return execFile(...args);
}

function cliOutcome(error,stdout){
 let envelope;
 try{envelope=JSON.parse(stdout);}catch{}
 return {
  success:!error&&envelope?.success===true,
  code:error?.code??null,signal:error?.signal??null,killed:error?.killed??false,
  reportedSuccess:envelope?.success??null,
 };
}

// Observe the real execution promise without changing its arguments, timeout or return value.
Object.defineProperty(observedExecFile,promisify.custom,{value:(file,args,options)=>{
 if(file!=='agent-browser')return execute(file,args,options);
 const command=args.slice(args.indexOf('--json')+1);
 const recorded={kind:command[0]==='open'&&command.length===1?'blank':command[0],started:moment(),
  session:args[args.indexOf('--session')+1],config:args[args.indexOf('--config')+1],args,options};
 if(!first&&recorded.kind==='blank'){
  first=recorded;
  proxyPort=Number(new URL(JSON.parse(readFileSync(first.config,'utf8')).proxy).port);
 }
 commands.push(recorded);
 const promise=execute(file,args,options);
 promise.then(({stdout})=>finish(null,stdout),error=>finish(error,error.stdout));
 function finish(error,stdout){
  recorded.outcome=cliOutcome(error,stdout);
  recorded.elapsed=rounded(moment()-recorded.started);
  recorded.aborted=options.signal?.aborted??false;
 }
 return promise;
}});
childProcess.execFile=observedExecFile;
syncBuiltinESMExports();
const {localBrowserAdapter}=await import('../../src/headless-browser.ts');
childProcess.execFile=execFile;
syncBuiltinESMExports();

const packageDir=dirname(chrome);
const packageFiles=readdirSync(packageDir,{recursive:true,withFileTypes:true})
 .filter(entry=>entry.isFile()).map(entry=>join(entry.parentPath,entry.name)).sort();
async function cache(stage){
 let result;
 try{
  const {stdout}=await execute('sudo',['-n','fincore','--json','--bytes','--output','RES,SIZE,FILE',...packageFiles]);
  const files=JSON.parse(stdout).fincore;
  const binary=files.find(file=>file.file===chrome);
  assert.ok(binary&&Number.isFinite(Number(binary.res))&&Number(binary.size)>0);
  result={binaryBytes:Number(binary.res),binarySize:Number(binary.size),files:files.map(file=>[relative(packageDir,file.file),Number(file.res),Number(file.size)])};
 }catch(error){
  result={unavailable:error.code??error.name};
 }
 emit('CACHE',{stage,...result});
}

function changingFile(operation){
 try{return operation();}catch(error){
  if(['ENOENT','ESRCH','EACCES','EPERM'].includes(error.code))return undefined;
  throw error;
 }
}

function observe(){
 const listening=new Set(readFileSync('/proc/net/tcp','utf8').trim().split('\n').slice(1)
  .map(line=>line.trim().split(/\s+/)).filter(parts=>parts[3]==='0A'&&parts[1].startsWith('0100007F:'))
  .map(parts=>parseInt(parts[1].split(':')[1],16)));
 const profiles=readdirSync(temp).filter(name=>name.startsWith('agent-browser-chrome-'));
 const ready=profiles.filter(name=>{
  const active=changingFile(()=>readFileSync(join(temp,name,'DevToolsActivePort'),'utf8'));
  return active&&listening.has(Number(active.split('\n')[0]));
 }).length;
 const socket=join(home,'.agent-browser',first.session+'.sock');
 const daemonPid=Number(changingFile(()=>readFileSync(join(home,'.agent-browser',first.session+'.pid'),'utf8')));
 const groups=new Map();
 const binaries=new Set();
 for(const pid of readFileSync(join(cgroup,'cgroup.procs'),'utf8').trim().split('\n')){
  const stat=changingFile(()=>readFileSync('/proc/'+pid+'/stat','utf8'));
  if(!stat)continue;
  const end=stat.lastIndexOf(')');
  const name=stat.slice(stat.indexOf('(')+1,end);
  if(!/^(agent-browser|chrome|chromium)/.test(name))continue;
  const [state,,pgid]=stat.slice(end+2).split(' ');
  const role=Number(pid)===daemonPid?'daemon':name.startsWith('agent-browser')?'agent-browser':'chrome';
  if(name==='chrome'&&state!=='Z'){
   const path=changingFile(()=>readlinkSync('/proc/'+pid+'/exe'));
   if(path)binaries.add(path===chrome?'system-chrome':'other-chrome');
  }
  const key=[name,role,Number(pgid),state==='Z'?'zombie':'live'].join(' ');
  groups.set(key,(groups.get(key)??0)+1);
 }
 const processes=[...groups].sort().map(([key,count])=>{
  const [name,role,pgid,state]=key.split(' ');
  return {name,role,pgid:Number(pgid),state,count};
 });
 return {
  processes,profiles:profiles.length,ready,chromeBinaries:[...binaries].sort(),
  socket:changingFile(()=>lstatSync(socket).isSocket())??false,
  configDirectory:existsSync(dirname(first.config)),proxyListening:listening.has(proxyPort),
 };
}

const state={};
const observations=[];
function sample(label){
 if(!first)return;
 const snapshot=observe(),sinceOpen=rounded(moment()-first.started);
 const {chromeBinaries,...signature}=snapshot;
 for(const binary of chromeBinaries)state[binary]=true;
 const key=JSON.stringify(signature);
 if(label||key!==state.key){
  observations.push({label,sinceOpen,...snapshot});
  state.key=key;
 }
 return snapshot;
}

function listCommands(from){
 return commands.slice(from).map(({kind,session,elapsed,aborted,outcome})=>({kind,session,elapsed,aborted,...outcome}));
}

let requests=0;
const site=createServer({
 key:readFileSync(join(cert,'key.pem')),cert:readFileSync(join(cert,'cert.pem')),
},(_request,response)=>{
 requests++;
 response.setHeader('Content-Type','text/html');
 response.end('<!doctype html><title>Fixture</title><p>Browser read</p>');
});
site.listen(0,'127.0.0.1');
await once(site,'listening');
const origin='https://127.0.0.1:'+site.address().port;
const adapter=localBrowserAdapter({MASSION_BROWSER_READS:'1',MASSION_BROWSER_ORIGINS:origin});

async function read(attempt){
 const from=commands.length,requestsBefore=requests;
 const began=moment();
 let outcome;
 try{
  const page=await adapter.read({address:origin+'/',sessionId:'flake-260',signal:AbortSignal.timeout(180000)});
  assert.equal(page.title,'Fixture');
  assert.deepEqual(page.blocks,['Browser read']);
  outcome={status:'pass'};
 }catch(error){
  outcome={status:'fail',message:error.message==='Local browser startup unavailable'?error.message:error.name};
 }
 return {attempt,...outcome,began,ended:moment(),commands:listCommands(from),requests:requests-requestsBefore};
}

async function lateClose(replay){
 const started=moment();
 const args=replay?[...first.args.slice(0,-1),'close']:['--session',first.session,'--json','close'];
 const options={...first.options,cwd:replay?first.options.cwd:process.cwd(),signal:AbortSignal.timeout(5000)};
 let outcome;
 try{
  const {stdout}=await execute('agent-browser',args,options);
  outcome=cliOutcome(null,stdout);
 }catch(error){
  outcome=cliOutcome(error,error.stdout);
 }
 return {elapsed:rounded(moment()-started),...outcome};
}

async function stopMeasuredProcesses(){
 // The pidfd keeps each signal bound to the inspected process even if its PID is reused.
 await execute('python3',['-c',String.raw`
import os, re, signal, sys
from pathlib import Path

membership = Path("/proc/self/cgroup").read_text()
for pid in Path(sys.argv[1], "cgroup.procs").read_text().split():
    try:
        proc = os.pidfd_open(int(pid))
        try:
            directory = Path("/proc", pid)
            if (directory.joinpath("cgroup").read_text() == membership
                and re.match(r"^(agent-browser|chrome|chromium)", directory.joinpath("comm").read_text())):
                signal.pidfd_send_signal(proc, signal.SIGKILL)
        finally:
            os.close(proc)
    except (FileNotFoundError, ProcessLookupError):
        pass
`,cgroup]);
}

const timer=setInterval(()=>sample(),200);
try{
 await cache('before-first');
 const initial=await read(1);
 const reported=initial.ended;
 sample('failure');
 emit('READ',{...initial,elapsed:rounded(reported-initial.began)});
 const blank=initial.commands[0];
 assert.ok(first&&blank?.kind==='blank');
 assert.equal(initial.message,'Local browser startup unavailable');
 assert.equal(initial.requests,0);
 assert.ok(blank.elapsed>=29900&&blank.elapsed<33000&&blank.killed&&blank.signal==='SIGTERM'&&!blank.aborted);
 await cache('after-first');
 if(condition==='residue'||condition==='residue-long'){
  await delay(Math.max(0,reported+5000-moment()));
  sample('failure+5s');
  await delay(Math.max(0,reported+60000-moment()));
  sample('failure+60s');
  if(condition==='residue-long'){
   await delay(Math.max(0,reported+90000-moment()));
   sample('failure+90s');
  }
  emit('LATE_CLOSE',{replay:await lateClose(true),named:await lateClose(false)});
  await delay(1000);
  sample('after-late-close');
 }else{
  if(condition==='five-seconds')await delay(Math.max(0,reported+5000-moment()));
  if(condition==='processes-gone'||condition==='stopped-processes'){
   const hasLive=snapshot=>snapshot.processes.some(process=>process.state==='live');
   while(hasLive(observe())&&moment()<reported+60000)await delay(200);
   sample('failure+60s-or-gone');
   if(condition==='stopped-processes'&&hasLive(observe())){
    const deadline=moment()+5000;
    while(hasLive(observe())&&moment()<deadline){
     await stopMeasuredProcesses();
     await delay(100);
    }
   }else if(hasLive(observe())){
    emit('GONE_CLOSE',await lateClose(false));
    const deadline=moment()+5000;
    while(hasLive(observe())&&moment()<deadline)await delay(200);
   }
   const gone=observe();
   sample(hasLive(gone)?'still-live':'confirmed-gone');
   assert.ok(!hasLive(gone),'First-session processes still live');
  }
  if(condition!=='immediate')await cache('before-second');
  clearInterval(timer);
  const second=await read(2);
  assert.notEqual(second.commands[0]?.session,first.session);
  emit('READ',{...second,elapsed:rounded(second.ended-second.began),delayAfterFailure:rounded(second.began-reported)});
  await cache('after-second');
 }
}finally{
 clearInterval(timer);
 emit('SAMPLE',{condition,systemChromeSeen:state['system-chrome']===true,observations});
 site.closeAllConnections();
 await new Promise(resolve=>site.close(resolve));
}
