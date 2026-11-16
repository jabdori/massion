import test from 'node:test';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {mkdtemp,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {createServer,type AddressInfo} from 'node:net';
import {tempRoot} from './support/temp-root.ts';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {confinedCommand,confinementProfile,confinementStatus,createConfinement,verifyConfinement} from '../src/confined-command.ts';
import type {ChildRun,ChildRunner,ConfinementReason} from '../src/confined-command.ts';
import {runHandler,workerCommand} from '../src/app-sandbox.ts';
import {CALCULATION_CRITERIA_VERSION,createFixtureWorkspace,evaluateCalculationImprovement,independentlyVerifyCalculation,wasConfined,writeCalculationCandidate} from '../src/execution.ts';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {AppPackage} from '../src/apps.ts';

const darwin=process.platform==='darwin';
const mac={skip:!darwin&&'the OS sandbox is macOS-only (A1); this host has no mechanism'};
const linux={skip:darwin&&'this host has the macOS OS sandbox (A1); the Linux no-mechanism branch does not apply'};

// The same attempts the startup probe makes, re-derived here so the wall is tested independently of the module under test: every attempt reports the exact error code, or succeeded. The read attempt targets /private/etc/hosts, which macOS ships everywhere and which no read list names.
const attempts=(port:number)=>'const{spawnSync,fork}=require("node:child_process"),{readFileSync,writeFileSync,unlinkSync}=require("node:fs"),{join}=require("node:path"),{connect}=require("node:net");const temp=join('+JSON.stringify(tempRoot())+',"massion-confinement-"+process.pid),out={},left=new Set(["write","read","spawn","fork","connect"]);const finish=()=>{if(left.size)return;try{unlinkSync(temp);}catch{}process.stdout.write(JSON.stringify(out));process.exit(0);};try{writeFileSync(temp,"probe");out.write="succeeded";}catch(e){out.write=String(e.code||e.message);}left.delete("write");finish();try{readFileSync("/private/etc/hosts");out.read="succeeded";}catch(e){out.read=String(e.code||e.message);}left.delete("read");finish();try{const done=spawnSync("/usr/bin/true");out.spawn=done.error?String(done.error.code||done.message):"succeeded";}catch(e){out.spawn=String(e.code||e.message);}left.delete("spawn");finish();try{const child=fork("/usr/bin/true");child.once("error",e=>{out.fork=String(e.code||e.message);left.delete("fork");finish();});child.once("exit",()=>{if(!Object.hasOwn(out,"fork")){out.fork="succeeded";left.delete("fork");finish();}});}catch(e){out.fork=String(e.code||e.message);left.delete("fork");finish();}const socket=connect('+port+',"127.0.0.1");socket.once("connect",()=>{out.connect="succeeded";left.delete("connect");finish();});socket.once("error",e=>{out.connect=String(e.code||e.message);left.delete("connect");finish();});setTimeout(()=>{for(const probe of left)out[probe]="timeout";try{unlinkSync(temp);}catch{}process.stdout.write(JSON.stringify(out));process.exit(0);},3000);';

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

// The oracle shape (module eval): the child reports its own working directory, what listing it shows, and the refusal code for reading one host file.
const oracleCwdReport=(hostFile:string)=>'import{readdirSync,readFileSync}from"node:fs";const out={cwd:process.cwd()};try{out.entries=readdirSync(process.cwd()).join(",");}catch(e){out.entries=String(e.code||e.message);}try{readFileSync('+JSON.stringify(hostFile)+');out.hostRead="succeeded";}catch(e){out.hostRead=String(e.code||e.message);}process.stdout.write(JSON.stringify(out));';

// Reads attempted from inside a child; each reports the exact error code, or succeeded. The module form is the oracle's (--eval --input-type=module), the require form the worker probe's (-e).
const readAttempts=(targets:readonly(readonly[string,string])[],asModule:boolean)=>
 (asModule?'import{readFileSync}from"node:fs";const out={};':'const{readFileSync}=require("node:fs");const out={};')
 +targets.map(([name,path])=>'try{readFileSync('+JSON.stringify(path)+');out['+JSON.stringify(name)+']="succeeded";}catch(e){out['+JSON.stringify(name)+']=String(e.code||e.message);}').join('')
 +'process.stdout.write(JSON.stringify(out));';

// Before the read narrowing this test proved the one profile verbatim: default-deny, the Node literal, a pathless (allow file-read*) and sysctl-read, and null for Node paths it cannot quote. The profile is now built per child, so the same is proved on every shape: exact rules, no read rule without a named path, and null for any input that cannot be named.
test('the profile is default-deny, names exactly what one child must read and refuses paths it cannot quote plainly',()=>{
 // The self-check shape: the four common rules only.
 assert.equal(confinementProfile('/usr/local/bin/node',{}),'(version 1)(deny default)(allow process-exec (literal "/usr/local/bin/node"))(allow file-read-data (literal "/"))(allow file-read-data (literal "/System/Library/OpenSSL/openssl.cnf"))(allow sysctl-read)');
 // The worker shape: metadata on every ancestor of the script, then the script itself.
 assert.equal(confinementProfile('/usr/local/bin/node',{script:'/private/tmp/massion/worker.mjs'}),'(version 1)(deny default)(allow process-exec (literal "/usr/local/bin/node"))(allow file-read-data (literal "/"))(allow file-read-data (literal "/System/Library/OpenSSL/openssl.cnf"))(allow file-read-metadata (literal "/private"))(allow file-read-metadata (literal "/private/tmp"))(allow file-read-metadata (literal "/private/tmp/massion"))(allow file-read* (literal "/private/tmp/massion/worker.mjs"))(allow sysctl-read)');
 // The oracle shape: its working directory, listable and nothing else there.
 assert.equal(confinementProfile('/usr/local/bin/node',{workingDirectory:'/private/var/folders/work'}),'(version 1)(deny default)(allow process-exec (literal "/usr/local/bin/node"))(allow file-read-data (literal "/"))(allow file-read-data (literal "/System/Library/OpenSSL/openssl.cnf"))(allow file-read* (literal "/private/var/folders/work"))(allow sysctl-read)');
 for(const bad of ['/bin/no"de','/bin/no'+String.fromCharCode(92)+'de','/bin/no'+String.fromCharCode(1)+'de','/bin/no'+String.fromCharCode(127)+'de',''])
  assert.equal(confinementProfile(bad,{}),null);
 for(const bad of [{script:'/bin/no"de.mjs'},{script:'/bin/no'+String.fromCharCode(92)+'de.mjs'},{script:''},{script:'relative/worker.mjs'},{workingDirectory:'/bin/no"de'},{workingDirectory:'relative'}])
  assert.equal(confinementProfile('/usr/local/bin/node',bad),null);
});

test('a confined raw Node child cannot write, read outside the list, connect, spawn or fork',mac,async t=>{
 const command=confinedCommand([]);
 assert.equal(command.status,'confined','macOS must start the children behind a verified OS sandbox');
 const server=await listening(t);
 const probed=confinedCommand(['-e',attempts((server.address() as AddressInfo).port)]);
 assert.equal(probed.status,'confined');
 assert.deepEqual(await probeReport([probed.command,probed.args]),{write:'EPERM',read:'EPERM',spawn:'EPERM',fork:'EPERM',connect:'EPERM'});
});

test('the confined app worker cannot write, read outside its list, connect, spawn or fork from inside',mac,async t=>{
 const command=workerCommand();
 assert.ok(command,'macOS must have an app worker behind the OS sandbox');
 const server=await listening(t);
 const args=[...command[1].slice(0,-1),'-e',attempts((server.address() as AddressInfo).port)];
 // Under the inner permission layer Node refuses with ERR_ACCESS_DENIED before the OS wall's EPERM; on Node 24 the network axis reaches the wall. Either layer refusing is the composed child refusing.
 const report=await probeReport([command[0],args]);
 assert.deepEqual(Object.keys(report).sort(),['connect','fork','read','spawn','write']);
 for(const probe of ['write','read','spawn','fork','connect'])assert.ok(report[probe]==='EPERM'||report[probe]==='ERR_ACCESS_DENIED',probe+' was refused by the OS wall or the inner permission layer, observed '+report[probe]);
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

test('the oracle runs behind the narrowed wall without a workspace, from its dedicated empty working directory',mac,async()=>{
 // The two production callers without a workspace (verifyGrowthCalculation, evaluateCalculationImprovement) send their input on stdin and their source through --eval and read no files, so an empty working directory changes nothing for them. If that directory were not what the profile lists, the module-eval child would die on process.cwd (uv_cwd) and this test could not complete.
 const host=realpathSync(process.cwd());
 const before=new Set((await readdir(tempRoot())).filter(name=>name.startsWith('massion-oracle-')));
 const result=await evaluateCalculationImprovement();
 assert.equal(result.confined,true,'both held-out runs completed behind the OS wall');
 assert.deepEqual([result.baseline,result.candidate],[2,6]);
 // The decided rule, not an inherited host directory: the run created exactly one dedicated directory under the resolved temp root, named massion-oracle-, and it is empty.
 const created=(await readdir(tempRoot())).filter(name=>name.startsWith('massion-oracle-')&&!before.has(name));
 assert.equal(created.length,1,'one dedicated working directory per host process');
 const directory=join(tempRoot(),created[0]!);
 assert.notEqual(directory,host,'the oracle does not run in the host process working directory');
 assert.deepEqual(await readdir(directory),[],'the dedicated working directory is empty');
 // From inside an oracle-shaped child in that directory: the child's own cwd is that directory, listing it shows nothing, and reading a file in the host's working directory is refused with the OS error code.
 const oracle=confinedCommand(['--input-type=module','--eval',oracleCwdReport(join(host,'package.json'))],{workingDirectory:directory});
 assert.ok(oracle.status==='confined');
 const report=await new Promise<{cwd:string;entries:string;hostRead:string}>((resolve,reject)=>{
  const child=spawn(oracle.command,oracle.args,{cwd:directory,env:{},stdio:['ignore','pipe','pipe']});
  let out='';
  child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{out+=chunk;});
  child.on('error',reject);
  child.on('close',()=>{try{resolve(JSON.parse(out));}catch(error){reject(error);}});
 });
 assert.equal(report.cwd,directory,'the child sees the dedicated directory as its own working directory');
 assert.equal(report.entries,'','the child can list its working directory and it is empty');
 assert.equal(report.hostRead,'EPERM','a file in the host working directory is refused with the OS error code');
});

test('inside each child, reading outside every read list is refused',mac,async t=>{
 const root=await mkdtemp(join(tempRoot(),'massion-read-refusal-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const tempFile=join(root,'outside.txt');
 await writeFile(tempFile,'outside');
 const runner=realpathSync(fileURLToPath(new URL('../src/app-runner.mjs',import.meta.url)));
 const besideRunner=join(dirname(runner),'app-sandbox.ts');
 const targets=[['hosts','/private/etc/hosts'],['temp-root',tempFile],['beside-runner',besideRunner]] as const;
 // The oracle shape: module eval, its dedicated empty working directory as cwd, and no inner permission flags, so the OS wall's own refusal code is observable.
 const empty=await mkdtemp(join(tempRoot(),'massion-read-refusal-empty-'));
 t.after(()=>rm(empty,{recursive:true,force:true}));
 const oracle=confinedCommand(['--input-type=module','--eval',readAttempts(targets,true)],{workingDirectory:empty});
 assert.ok(oracle.status==='confined');
 const oracleRun=await new Promise<Record<string,string>>((resolve,reject)=>{
  const child=spawn(oracle.command,oracle.args,{cwd:empty,env:{},stdio:['ignore','pipe','pipe']});
  let out='';
  child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{out+=chunk;});
  child.on('error',reject);
  child.on('close',()=>{try{resolve(JSON.parse(out));}catch(error){reject(error);}});
 });
 assert.deepEqual(oracleRun,{hosts:'EPERM','temp-root':'EPERM','beside-runner':'EPERM'});
 // The worker shape: its inner permission layer refuses first; either layer refusing is the composed child refusing.
 const worker=workerCommand()!;
 const workerRun=await probeReport([worker[0],[...worker[1].slice(0,-1),'-e',readAttempts(targets,false)]]);
 for(const [name] of targets)assert.ok(workerRun[name]==='EPERM'||workerRun[name]==='ERR_ACCESS_DENIED',name+' was refused by the OS wall or the inner permission layer, observed '+workerRun[name]);
 // The worker-shaped profile alone (the profile confinedCommand builds for the runner script) around a child started WITHOUT the inner permission flags: the OS wall itself refuses the three reads.
 const workerShaped=confinedCommand(['-e',readAttempts(targets,false)],{script:runner});
 assert.ok(workerShaped.status==='confined');
 assert.deepEqual(await probeReport([workerShaped.command,workerShaped.args]),{hosts:'EPERM','temp-root':'EPERM','beside-runner':'EPERM'});
});

test('a runner script reached through a symbolic link still starts: the profile lists the resolved path',mac,async t=>{
 const real=await mkdtemp(join(tempRoot(),'massion-runner-link-'));
 t.after(()=>rm(real,{recursive:true,force:true}));
 const script=join(real,'worker.mjs');
 await writeFile(script,'process.stdout.write("resolved-runner-ok");');
 // The given path crosses a symbolic component (as /tmp does to /private/tmp); the sandbox only matches the resolved form, and Node's own entry resolution dies on the spelled symlink (lstat of it is denied), so like the production wiring the child is started with the resolved script while the description came through the link.
 const linked=join(tempRoot(),'massion-runner-link-'+process.pid);
 await rm(linked,{force:true});
 await symlink(real,linked);
 const given=join(linked,'worker.mjs');
 const command=confinedCommand([script],{script:given});
 assert.ok(command.status==='confined');
 assert.ok(command.args[1]!.includes('(allow file-read* (literal "'+script+'"))'),'the profile lists the resolved script '+script);
 assert.ok(!command.args[1]!.includes(linked),'the unresolved link is not what the profile names');
 const out=await new Promise<string>((resolve,reject)=>{
  const child=spawn(command.command,command.args,{env:{},stdio:['ignore','pipe','ignore']});
  let text='';
  child.stdout?.setEncoding('utf8').on('data',(chunk:string)=>{text+=chunk;});
  child.on('error',reject);
  child.on('close',()=>resolve(text));
 });
 assert.equal(out,'resolved-runner-ok');
});

test('removing any common rule stops both children on this machine',mac,async t=>{
 const node=realpathSync(process.execPath);
 const runner=realpathSync(fileURLToPath(new URL('../src/app-runner.mjs',import.meta.url)));
 const workerProfile=confinementProfile(node,{script:runner})!;
 const empty=await mkdtemp(join(tempRoot(),'massion-rule-removal-'));
 t.after(()=>rm(empty,{recursive:true,force:true}));
 const oracleProfile=confinementProfile(node,{workingDirectory:empty})!;
 const common=[['execute the Node binary','(allow process-exec (literal "'+node+'"))'],['read the root directory entry','(allow file-read-data (literal "/"))'],['read the OpenSSL configuration','(allow file-read-data (literal "/System/Library/OpenSSL/openssl.cnf"))'],['read sysctls','(allow sysctl-read)']] as const;
 const cut=(profile:string,rule:string)=>{assert.ok(profile.includes(rule),'the rule is in the profile: '+rule);return profile.replace(rule,'');};
 // The real worker and oracle command lines behind a hand-edited profile: a child that starts reports its line, so no line means it did not start.
 const runWorker=async(profile:string)=>new Promise<boolean>((resolve,reject)=>{
  const child=spawn('/usr/bin/sandbox-exec',['-p',profile,node,'--permission','--allow-fs-read='+runner,'--max-old-space-size=64',runner],{env:{},stdio:['pipe','pipe','ignore']});
  let ran=false;
  child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{if(chunk.includes('"t":"done"')){ran=true;child.kill('SIGKILL');}});
  child.on('error',reject);
  child.on('close',()=>resolve(ran));
  child.stdin.write(JSON.stringify({source:'massion.handle("run",async()=>({title:"R",groups:[]}))',handler:'run',input:{}})+'\n');
  child.stdin.end();
 });
 const runOracle=async(profile:string)=>new Promise<boolean>((resolve,reject)=>{
  const child=spawn('/usr/bin/sandbox-exec',['-p',profile,node,'--permission','--disable-proto=throw','--max-old-space-size=32','--input-type=module','--eval','process.stdout.write("oracle-up")'],{cwd:empty,env:{},stdio:['ignore','pipe','ignore']});
  let out='';
  child.stdout?.setEncoding('utf8').on('data',(chunk:string)=>{out+=chunk;});
  child.on('error',reject);
  child.on('close',()=>resolve(out.includes('oracle-up')));
 });
 for(const [name,rule] of common){
  assert.equal(await runWorker(cut(workerProfile,rule)),false,'the worker did not run without the rule to '+name);
  assert.equal(await runOracle(cut(oracleProfile,rule)),false,'the oracle did not run without the rule to '+name);
 }
 assert.equal(await runWorker(workerProfile),true,'the untouched profile still runs the worker');
 assert.equal(await runOracle(oracleProfile),true,'the untouched profile still runs the oracle');
});

test('a profile that still allows all reads fails the proof with probe-allowed',mac,async()=>{
 // Injected builder, this test only: the profile main used until now, with every read allowed. The read attempt must catch it, or the narrowing is not proved.
 const broad=()=>'(version 1)(deny default)(allow process-exec (literal "'+realpathSync(process.execPath)+'"))(allow file-read*)(allow sysctl-read)';
 assert.deepEqual(await verifyConfinement({buildProfile:broad}),{ok:false,reason:'probe-allowed'});
});

test('the generated worker and oracle profiles are printed for the record',mac,()=>{
 const node=realpathSync(process.execPath);
 const runner=realpathSync(fileURLToPath(new URL('../src/app-runner.mjs',import.meta.url)));
 const worker=confinementProfile(node,{script:runner});
 const oracle=confinementProfile(node,{workingDirectory:realpathSync(process.cwd())});
 assert.ok(worker&&oracle,'both profiles build on this machine');
 console.log('worker profile: '+worker);
 console.log('oracle profile (the working directory is the workspace or the dedicated empty directory; this checkout stands in for it): '+oracle);
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
 const forged=await createConfinement({runChild:async(command,args)=>({code:0,signal:null,timedOut:false,stdout:JSON.stringify(args[0]==='-p'?{write:'EPERM',read:'EPERM',spawn:'EPERM',fork:'EPERM',connect:'EPERM'}:{write:'succeeded',read:'succeeded',spawn:'succeeded',fork:'succeeded',connect:'succeeded'})})});
 assert.equal(forged.confinedCommand([]).status,'confined','the forged instance reports its own state');
 assert.deepEqual(confinedCommand([]),before,'the production instance is unaffected');
 assert.equal((confinedCommand([]) as {args:string[]}).args[1],confinementProfile(realpathSync(process.execPath),{}),'the production profile is still the one built from the canonical Node path');
});

test('on Linux a forged instance is returned unconfined like the production command and no app worker runs',linux,async()=>{
 // Proves the documented Linux behaviour (ADR 0009 condition B): the forged instance returns the same
 // unconfined command as production whatever its runner says, production is unchanged and no app
 // worker runs. The comparison cannot detect a polluted production state here because Linux has no
 // mechanism to claim; when the Linux isolation slice lands (issue #184), this test changes to assert
 // what the macOS test asserts now.
 const before=confinedCommand([]);
 const forged=await createConfinement({runChild:async(command,args)=>({code:0,signal:null,timedOut:false,stdout:JSON.stringify(args[0]==='-p'?{write:'EPERM',read:'EPERM',spawn:'EPERM',fork:'EPERM',connect:'EPERM'}:{write:'succeeded',read:'succeeded',spawn:'succeeded',fork:'succeeded',connect:'succeeded'})})});
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
 const refused={write:'EPERM',read:'EPERM',spawn:'EPERM',fork:'EPERM',connect:'EPERM'};
 const run=(control:ChildRun,probe:ChildRun):ChildRunner=>(command,args)=>Promise.resolve(args[0]==='-p'?probe:control);
 const report=(value:Record<string,string>):ChildRun=>({code:0,signal:null,timedOut:false,stdout:JSON.stringify(value)});
 const control=report({write:'succeeded',read:'succeeded',spawn:'succeeded',fork:'succeeded',connect:'succeeded'});
 const cases:[string,ConfinementReason,ChildRunner][]=[
  ['an empty report is not proof','probe-report-invalid',run(control,report({}))],
  ['a wrong error code is not proof','probe-report-invalid',run(control,report({...refused,write:'ENOENT'}))],
  ['a probe child that crashes is not proof','probe-failed',run(control,{code:1,signal:null,timedOut:false,stdout:''})],
 ];
 // Every attempt has exactly one expected control result (succeeded) and one expected confined result (EPERM): one row per attempt in each direction, so a missing cell fails the test.
 for(const probe of ['write','read','spawn','fork','connect'] as const){
  cases.push([probe+' succeeded inside the wall means the wall failed','probe-allowed',run(control,report({...refused,[probe]:'succeeded'}))]);
  cases.push(['a control whose '+probe+' axis fails proves nothing','control-failed',run(report({write:'succeeded',read:'succeeded',spawn:'succeeded',fork:'succeeded',connect:'succeeded',[probe]:'EPERM'}),report(refused))]);
 }
 cases.push(['a missing read probe is not proof','probe-report-invalid',run(control,report({write:'EPERM',spawn:'EPERM',fork:'EPERM',connect:'EPERM'}))]);
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
