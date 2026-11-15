import test from 'node:test';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer,type AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {confinedCommand,confinementProfile,confinementStatus,reinitializeConfinementForTests,verifyConfinement} from '../src/confined-command.ts';
import type {ChildRun,ChildRunner,ConfinementReason} from '../src/confined-command.ts';
import {runHandler,workerCommand} from '../src/app-sandbox.ts';
import {CALCULATION_CRITERIA_VERSION,createFixtureWorkspace,evaluateCalculationImprovement,independentlyVerifyCalculation,wasConfined,writeCalculationCandidate} from '../src/execution.ts';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {AppPackage} from '../src/apps.ts';

const darwin=process.platform==='darwin';
const mac={skip:!darwin&&'the OS sandbox is macOS-only (A1); this host has no mechanism'};

// The same attempts the startup probe makes, re-derived here so the wall is tested independently of the module under test: every attempt reports the exact error code, or succeeded.
const attempts=(port:number)=>'const{spawnSync,fork}=require("node:child_process"),{writeFileSync,unlinkSync}=require("node:fs"),{tmpdir}=require("node:os"),{join}=require("node:path"),{connect}=require("node:net");const temp=join(tmpdir(),"massion-confinement-"+process.pid),out={},left=new Set(["write","spawn","fork","connect"]);const finish=()=>{if(left.size)return;try{unlinkSync(temp);}catch{}process.stdout.write(JSON.stringify(out));process.exit(0);};try{writeFileSync(temp,"probe");out.write="succeeded";}catch(e){out.write=String(e.code||e.message);}left.delete("write");finish();try{const done=spawnSync("/usr/bin/true");out.spawn=done.error?String(done.error.code||done.message):"succeeded";}catch(e){out.spawn=String(e.code||e.message);}left.delete("spawn");finish();try{const child=fork("/usr/bin/true");child.once("error",e=>{out.fork=String(e.code||e.message);left.delete("fork");finish();});child.once("exit",()=>{if(!Object.hasOwn(out,"fork")){out.fork="succeeded";left.delete("fork");finish();}});}catch(e){out.fork=String(e.code||e.message);left.delete("fork");finish();}const socket=connect('+port+',"127.0.0.1");socket.once("connect",()=>{out.connect="succeeded";left.delete("connect");finish();});socket.once("error",e=>{out.connect=String(e.code||e.message);left.delete("connect");finish();});setTimeout(()=>{for(const probe of left)out[probe]="timeout";try{unlinkSync(temp);}catch{}process.stdout.write(JSON.stringify(out));process.exit(0);},3000);';

const listening=async(t:TestContext)=>{const server=createServer(socket=>socket.destroy());await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());return server;};

function probeReport(command:[string,string[]]):Promise<Record<string,string>>{
 return new Promise((resolve,reject)=>{
  const child=spawn(command[0],command[1],{env:{},stdio:['ignore','pipe','ignore']});
  let out='';
  child.stdout?.setEncoding('utf8').on('data',(chunk:string)=>{out+=chunk;});
  child.on('error',reject);
  child.on('close',()=>{try{resolve(JSON.parse(out.trim().split('\n').at(-1)!));}catch{reject(new Error('the probe child returned no report'));}});
 });
}

const probePackage=(source:string):AppPackage=>({manifest:{format:'massion.app.v1',id:'probe',name:'Probe',version:'0.1.0',description:'Probe',permissions:{read:[],write:[],network:[],files:[],secrets:[],events:[]},contributes:{templates:[],skills:[],procedures:[],tools:[]},handlers:['run']},source});

test('the profile is default-deny and refuses node paths it cannot quote plainly',()=>{
 assert.equal(confinementProfile('/usr/local/bin/node'),'(version 1)(deny default)(allow process-exec (literal "/usr/local/bin/node"))(allow file-read*)(allow sysctl-read)');
 for(const bad of ['/bin/no"de','/bin/no'+String.fromCharCode(92)+'de','/bin/no'+String.fromCharCode(1)+'de','/bin/no'+String.fromCharCode(127)+'de',''])
  assert.equal(confinementProfile(bad),null);
});

test('a confined raw Node child cannot write, connect, spawn or fork',mac,async t=>{
 const command=confinedCommand([]);
 assert.equal(command.status,'confined','macOS must start the children behind a verified OS sandbox');
 const server=await listening(t);
 const probed=confinedCommand(['-e',attempts((server.address() as AddressInfo).port)]);
 assert.equal(probed.status,'confined');
 assert.deepEqual(await probeReport([probed.command,probed.args]),{write:'EPERM',spawn:'EPERM',fork:'EPERM',connect:'EPERM'});
});

test('the confined app worker cannot write, connect, spawn or fork from inside',mac,async t=>{
 const command=workerCommand();
 assert.ok(command,'macOS must have an app worker behind the OS sandbox');
 const server=await listening(t);
 const args=[...command[1].slice(0,-1),'-e',attempts((server.address() as AddressInfo).port)];
 // Under the inner permission layer Node refuses with ERR_ACCESS_DENIED before the OS wall's EPERM; on Node 24 the network axis reaches the wall. Either layer refusing is the composed child refusing.
 const report=await probeReport([command[0],args]);
 assert.deepEqual(Object.keys(report).sort(),['connect','fork','spawn','write']);
 for(const probe of ['write','spawn','fork','connect'])assert.ok(report[probe]==='EPERM'||report[probe]==='ERR_ACCESS_DENIED',probe+' was refused by the OS wall or the inner permission layer, observed '+report[probe]);
});

test('the confined oracle still verifies a real calculation and records the wall',mac,async t=>{
 const root=await mkdtemp(join(realpathSync(tmpdir()),'massion-os-isolation-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=await createFixtureWorkspace(root,'work-a');
 const artifact=await writeCalculationCandidate(workspace,'correct');
 const passed=await independentlyVerifyCalculation(workspace,artifact,CALCULATION_CRITERIA_VERSION);
 assert.equal(passed.verdict,'passed');
 assert.equal(passed.process?.exitCode,0);
 assert.equal(wasConfined(passed.process),true);
});

test('the confined worker still runs a real handler',mac,async()=>{
 const result=await runHandler({appId:'app-probe',pkg:probePackage('massion.handle("run",async()=>({title:"Confined",groups:[]}))'),handler:'run',input:{},network:undefined});
 assert.equal(result.view.title,'Confined');
});

test('with the mechanism unavailable both children refuse to start',mac,async t=>{
 t.after(()=>reinitializeConfinementForTests());
 await reinitializeConfinementForTests({sandboxExec:'/nonexistent/massion-sandbox-exec'});
 assert.equal(workerCommand(),null);
 await assert.rejects(runHandler({appId:'app-probe',pkg:probePackage('massion.handle("run",async()=>({title:"x",groups:[]}))'),handler:'run',input:{},network:undefined}),/Sandbox unavailable/);
 await assert.rejects(evaluateCalculationImprovement(),/Held-out oracle execution did not complete/);
});

test('no environment override exists: MASSION_SANDBOX_EXEC has no effect on production',mac,t=>{
 t.after(()=>{delete process.env.MASSION_SANDBOX_EXEC;});
 process.env.MASSION_SANDBOX_EXEC='/nonexistent/massion-sandbox-exec';
 assert.equal(confinedCommand([]).status,'confined');
 assert.deepEqual(confinementStatus(),{state:'confined'});
});

// Self-check judgment: each runChild replaces both real child runs; args[0] distinguishes the control run from the wrapped probe.
test('the self-check demands every probe refused with exactly EPERM and a working control',async()=>{
 const refused={write:'EPERM',spawn:'EPERM',fork:'EPERM',connect:'EPERM'};
 const run=(control:ChildRun,probe:ChildRun):ChildRunner=>(command,args)=>Promise.resolve(args[0]==='-p'?probe:control);
 const report=(value:Record<string,string>):ChildRun=>({code:0,signal:null,timedOut:false,stdout:JSON.stringify(value)});
 const control=report({write:'succeeded',spawn:'succeeded',fork:'succeeded',connect:'succeeded'});
 const cases:[string,ConfinementReason,ChildRunner][]=[
  ['an empty report is not proof','probe-report-invalid',run(control,report({}))],
  ['a wrong error code is not proof','probe-report-invalid',run(control,report({...refused,write:'ENOENT'}))],
  ['a missing probe is not proof','probe-report-invalid',run(control,report({write:'EPERM',spawn:'EPERM',fork:'EPERM'}))],
  ['an attempt that succeeded means the wall failed','probe-allowed',run(control,report({...refused,connect:'succeeded'}))],
  ['a probe child that crashes is not proof','probe-failed',run(control,{code:1,signal:null,timedOut:false,stdout:''})],
  ['a control that cannot write cannot prove anything','control-failed',run(report({write:'EACCES',spawn:'succeeded',fork:'succeeded',connect:'succeeded'}),report(refused))],
  ['a control whose fork axis fails proves nothing','control-failed',run(report({write:'succeeded',spawn:'succeeded',fork:'EPERM',connect:'succeeded'}),report(refused))],
 ];
 for(const [name,reason,runner] of cases){
  const result=await verifyConfinement({runChild:runner});
  assert.deepEqual(result,{ok:false,reason},name);
 }
 assert.equal((await verifyConfinement({runChild:run(control,report(refused))})).ok,true);
});

test('no export can make confinedCommand wrap a profile other than the built one',async t=>{
 t.after(()=>reinitializeConfinementForTests());
 const surface=await import('../src/confined-command.ts');
 assert.deepEqual(Object.keys(surface).sort(),['confinedCommand','confinementProfile','confinementStatus','reinitializeConfinementForTests','verifyConfinement']);
 for(const hostile of [{sandboxExec:'/nonexistent/massion-sandbox-exec'},{sandboxExec:'/bin/sh'}]){
  await reinitializeConfinementForTests(hostile);
  assert.notEqual(confinedCommand([]).status,'confined','a foreign sandbox binary path can only disable, never confine');
 }
 await reinitializeConfinementForTests();
 if(!darwin)return;
 const command=confinedCommand([]);
 assert.equal(command.status,'confined');
 assert.equal(command.args[1],confinementProfile(realpathSync(process.execPath)),'the only wrapped profile is the one built from the canonical Node path');
});

test('the health surface reports the OS sandbox state',async t=>{
 const store=new InMemoryStore<any>();
 const server=createWorkbench(store,process.cwd(),{scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>server.close());
 const response=await fetch('http://127.0.0.1:'+(server.address() as AddressInfo).port+'/health');
 assert.equal(response.status,200);
 const body=await response.json() as {osSandbox:{state:string}};
 assert.equal(body.osSandbox.state,darwin?'confined':'unconfined');
});
