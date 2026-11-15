import test from 'node:test';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer,type AddressInfo} from 'node:net';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {confinedCommand,confinementProfile,confinementStatus,createConfinement,verifyConfinement} from '../src/confined-command.ts';
import type {ChildRun,ChildRunner,ConfinementReason} from '../src/confined-command.ts';
import {runHandler,workerCommand} from '../src/app-sandbox.ts';
import {CALCULATION_CRITERIA_VERSION,createFixtureWorkspace,independentlyVerifyCalculation,wasConfined,writeCalculationCandidate} from '../src/execution.ts';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {AppPackage} from '../src/apps.ts';

const darwin=process.platform==='darwin';
const mac={skip:!darwin&&'the OS sandbox is macOS-only (A1); this host has no mechanism'};
const linux={skip:darwin&&'this host has the macOS OS sandbox (A1); the Linux no-mechanism branch does not apply'};

// The same attempts the startup probe makes, re-derived here so the wall is tested independently of the module under test: every attempt reports the exact error code, or succeeded.
const attempts=(port:number)=>'const{spawnSync,fork}=require("node:child_process"),{writeFileSync,unlinkSync}=require("node:fs"),{join}=require("node:path"),{connect}=require("node:net");const temp=join('+JSON.stringify(tempRoot())+',"massion-confinement-"+process.pid),out={},left=new Set(["write","spawn","fork","connect"]);const finish=()=>{if(left.size)return;try{unlinkSync(temp);}catch{}process.stdout.write(JSON.stringify(out));process.exit(0);};try{writeFileSync(temp,"probe");out.write="succeeded";}catch(e){out.write=String(e.code||e.message);}left.delete("write");finish();try{const done=spawnSync("/usr/bin/true");out.spawn=done.error?String(done.error.code||done.message):"succeeded";}catch(e){out.spawn=String(e.code||e.message);}left.delete("spawn");finish();try{const child=fork("/usr/bin/true");child.once("error",e=>{out.fork=String(e.code||e.message);left.delete("fork");finish();});child.once("exit",()=>{if(!Object.hasOwn(out,"fork")){out.fork="succeeded";left.delete("fork");finish();}});}catch(e){out.fork=String(e.code||e.message);left.delete("fork");finish();}const socket=connect('+port+',"127.0.0.1");socket.once("connect",()=>{out.connect="succeeded";left.delete("connect");finish();});socket.once("error",e=>{out.connect=String(e.code||e.message);left.delete("connect");finish();});setTimeout(()=>{for(const probe of left)out[probe]="timeout";try{unlinkSync(temp);}catch{}process.stdout.write(JSON.stringify(out));process.exit(0);},3000);';

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
 const root=await mkdtemp(join(tempRoot(),'massion-os-isolation-'));
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

// The macOS worker-refusal assertion: a child is started under a real OS sandbox that denies executing
// /usr/bin/sandbox-exec, so the production self-check inside that child fails for real and its
// confinedCommand reports unavailable. The child then calls the real runHandler/workerCommand.
// Production reads no override, so this is the production wiring refusing, not an injected instance.
const workerRefusalWithoutSandbox=async()=>new Promise<void>((resolve,reject)=>{
 const source='import{runHandler,workerCommand}from '+JSON.stringify(new URL('../src/app-sandbox.ts',import.meta.url).href)+';const command=workerCommand();if(command!==null)throw new Error("workerCommand returned a command");try{await runHandler({appId:"app-probe",pkg:{},handler:"run",input:{},network:undefined});throw new Error("runHandler resolved");}catch(error){if(!/Sandbox unavailable/.test(error.message))throw error;console.log("worker refused: "+error.message);}';
 const child=spawn('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)(deny process-exec (literal "/usr/bin/sandbox-exec"))',process.execPath,'--input-type=module','-e',source],{env:{},stdio:['ignore','pipe','ignore']});
 let out='';
 child.stdout?.setEncoding('utf8').on('data',(chunk:string)=>{out+=chunk;});
 child.on('error',reject);
 child.on('close',(code)=>{try{assert.equal(code,0,'the child exits cleanly after the worker refuses');assert.match(out,/Sandbox unavailable/,'the child observed the real runHandler refusal');resolve();}catch(error){reject(error);}});
});

test('on macOS an unavailable verification yields no command and the worker refuses through the real wiring',mac,async()=>{
 // Proves: an injected missing sandbox path yields unavailable/mechanism-missing, a crashed child run
 // yields unavailable, and the production app worker refuses with Sandbox unavailable when the real
 // self-check cannot prove the mechanism on this host.
 const unavailable=await createConfinement({sandboxExec:'/nonexistent/massion-sandbox-exec'});
 const crashed=await createConfinement({runChild:async()=>({code:1,signal:null,timedOut:false,stdout:''})});
 assert.deepEqual(unavailable.confinedCommand([]),{status:'unavailable',reason:'mechanism-missing'});
 assert.equal(crashed.confinedCommand([]).status,'unavailable');
 await workerRefusalWithoutSandbox();
});

test('on Linux an unavailable verification still returns the unconfined command before any state is read and the worker refuses to start',linux,async()=>{
 // Proves the documented Linux behaviour (ADR 0009 condition B): verifyConfinement reports
 // mechanism-missing, but confinedCommand returns the oracle command unconfined before it reads any
 // verification state, workerCommand() is null and runHandler refuses with Sandbox unavailable.
 // When the Linux isolation slice lands (issue #184), this test changes to assert what the macOS test
 // asserts now: unavailable yields no command and a forged instance cannot change production.
 const unavailable=await createConfinement({sandboxExec:'/nonexistent/massion-sandbox-exec'});
 const crashed=await createConfinement({runChild:async()=>({code:1,signal:null,timedOut:false,stdout:''})});
 assert.deepEqual(await verifyConfinement({sandboxExec:'/nonexistent/massion-sandbox-exec'}),{ok:false,reason:'mechanism-missing'});
 assert.deepEqual(unavailable.confinedCommand([]),{status:'unconfined',command:process.execPath,args:[]});
 assert.deepEqual(crashed.confinedCommand([]),{status:'unconfined',command:process.execPath,args:[]});
 assert.equal(workerCommand(),null);
 await assert.rejects(runHandler({appId:'app-probe',pkg:probePackage('massion.handle("run",async()=>({title:"x",groups:[]}))'),handler:'run',input:{},network:undefined}),/Sandbox unavailable/);
});

test('on macOS a forged instance cannot affect the production confinement',mac,async()=>{
 // Proves: a forged instance whose runner fakes every probe reports confined for itself, while the
 // production instance is deep-equal before and after and still wraps the profile built from the
 // canonical Node path.
 const before=confinedCommand([]);
 const forged=await createConfinement({runChild:async(command,args)=>({code:0,signal:null,timedOut:false,stdout:JSON.stringify(args[0]==='-p'?{write:'EPERM',spawn:'EPERM',fork:'EPERM',connect:'EPERM'}:{write:'succeeded',spawn:'succeeded',fork:'succeeded',connect:'succeeded'})})});
 assert.equal(forged.confinedCommand([]).status,'confined','the forged instance reports its own state');
 assert.deepEqual(confinedCommand([]),before,'the production instance is unaffected');
 assert.equal((confinedCommand([]) as {args:string[]}).args[1],confinementProfile(realpathSync(process.execPath)),'the production profile is still the one built from the canonical Node path');
});

test('on Linux a forged instance is returned unconfined like the production command and no app worker runs',linux,async()=>{
 // Proves the documented Linux behaviour (ADR 0009 condition B): the forged instance returns the same
 // unconfined command as production whatever its runner says, production is unchanged and no app
 // worker runs. The comparison cannot detect a polluted production state here because Linux has no
 // mechanism to claim; when the Linux isolation slice lands (issue #184), this test changes to assert
 // what the macOS test asserts now.
 const before=confinedCommand([]);
 const forged=await createConfinement({runChild:async(command,args)=>({code:0,signal:null,timedOut:false,stdout:JSON.stringify(args[0]==='-p'?{write:'EPERM',spawn:'EPERM',fork:'EPERM',connect:'EPERM'}:{write:'succeeded',spawn:'succeeded',fork:'succeeded',connect:'succeeded'})})});
 assert.deepEqual(forged.confinedCommand([]),{status:'unconfined',command:process.execPath,args:[]},'non-macOS never claims confinement even with a forged runner');
 assert.deepEqual(confinedCommand([]),before,'the production instance is unaffected');
 assert.equal(workerCommand(),null,'no app worker runs on non-macOS');
});

test('no export mutates the production confinement state',async()=>{
 const before=confinedCommand([]);
 const surface=await import('../src/confined-command.ts');
 assert.deepEqual(Object.keys(surface).sort(),['confinedCommand','confinementProfile','confinementStatus','createConfinement','verifyConfinement']);
 for(const hostile of [{sandboxExec:'/nonexistent/massion-sandbox-exec'},{sandboxExec:'/bin/sh'}]){
  const own=await surface.createConfinement(hostile);
  assert.notEqual(own.confinedCommand([]).status,'confined','a foreign sandbox binary path can only disable, never confine');
  await surface.verifyConfinement(hostile);
 }
 assert.equal(surface.confinementProfile('/bin/no"de'),null);
 surface.confinementStatus();
 surface.confinedCommand(['-p','(version 1)(allow default)']);
 assert.deepEqual(confinedCommand([]),before,'no export changed the production result');
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
