import test from 'node:test';
import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer,type AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {confinedCommand,confinementProfile} from '../src/confined-command.ts';
import {runHandler,workerCommand} from '../src/app-sandbox.ts';
import {CALCULATION_CRITERIA_VERSION,createFixtureWorkspace,evaluateCalculationImprovement,independentlyVerifyCalculation,writeCalculationCandidate} from '../src/execution.ts';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {AppPackage} from '../src/apps.ts';

const darwin=process.platform==='darwin';
const mac={skip:!darwin&&'the OS sandbox is macOS-only (A1); this host has no mechanism'};

// The same attempts the startup probe makes, re-derived here so the wall is tested independently of the module under test.
const attempts=(port:number)=>'const{spawnSync,fork}=require("node:child_process"),{writeFileSync}=require("node:fs"),{tmpdir}=require("node:os"),{join}=require("node:path"),{connect}=require("node:net");const out={};const settle=(attempt,refused)=>{out[attempt]=refused?"refused":"allowed";};(async()=>{try{writeFileSync(join(tmpdir(),"massion-confinement-"+process.pid),"probe");settle("write",false);}catch{settle("write",true);}try{settle("spawn",!!spawnSync("/usr/bin/true").error);}catch{settle("spawn",true);}await new Promise(resolve=>{try{const child=fork("/usr/bin/true");child.once("error",()=>{settle("fork",true);resolve();});child.once("exit",()=>{settle("fork",false);resolve();});}catch{settle("fork",true);resolve();}});await new Promise(resolve=>{try{const socket=connect('+port+',"127.0.0.1");socket.once("connect",()=>{settle("connect",false);socket.destroy();resolve();});socket.once("error",()=>{settle("connect",true);resolve();});}catch{settle("connect",true);resolve();}});process.stdout.write(JSON.stringify(out));})();';

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
 assert.deepEqual(await probeReport([probed.command,probed.args]),{write:'refused',spawn:'refused',fork:'refused',connect:'refused'});
});

test('the confined app worker cannot write, connect, spawn or fork from inside',mac,async t=>{
 const command=workerCommand();
 assert.ok(command,'macOS must have an app worker behind the OS sandbox');
 const server=await listening(t);
 const args=[...command[1].slice(0,-1),'-e',attempts((server.address() as AddressInfo).port)];
 assert.deepEqual(await probeReport([command[0],args]),{write:'refused',spawn:'refused',fork:'refused',connect:'refused'});
});

test('the confined oracle still verifies a real calculation and records the wall',mac,async t=>{
 const root=await mkdtemp(join(realpathSync(tmpdir()),'massion-os-isolation-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const workspace=await createFixtureWorkspace(root,'work-a');
 const artifact=await writeCalculationCandidate(workspace,'correct');
 const passed=await independentlyVerifyCalculation(workspace,artifact,CALCULATION_CRITERIA_VERSION);
 assert.equal(passed.verdict,'passed');
 assert.equal(passed.process?.exitCode,0);
 assert.equal(passed.process?.confined,true);
});

test('the confined worker still runs a real handler',mac,async()=>{
 const result=await runHandler({appId:'app-probe',pkg:probePackage('massion.handle("run",async()=>({title:"Confined",groups:[]}))'),handler:'run',input:{},network:undefined});
 assert.equal(result.view.title,'Confined');
});

test('with the mechanism unavailable both children refuse to start',mac,async t=>{
 t.after(()=>{delete process.env.MASSION_SANDBOX_EXEC;});
 process.env.MASSION_SANDBOX_EXEC='/nonexistent/massion-sandbox-exec';
 assert.equal(workerCommand(),null);
 await assert.rejects(runHandler({appId:'app-probe',pkg:probePackage('massion.handle("run",async()=>({title:"x",groups:[]}))'),handler:'run',input:{},network:undefined}),/Sandbox unavailable/);
 await assert.rejects(evaluateCalculationImprovement(),/Held-out oracle execution did not complete/);
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
