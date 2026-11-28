import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync} from 'node:fs';
import {mkdtemp,readFile,rm,stat,utimes,writeFile} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {basename,join} from 'node:path';
import {CliLauncher,cliStamp} from '../src/cli-launcher.ts';
import type {LauncherPolicy} from '../src/cli-launcher.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {cliProfileFactory,runCodexText,spawnCliRunner} from '../src/cli-agent-providers.ts';
import type {CliInvocation} from '../src/cli-agent-providers.ts';
import {subscriptionCliHost} from '../src/subscription-cli-host.ts';
import {codexFeatureListing,codexMcpServerListing,codexProbeResult} from './support/codex-probes.ts';

// Nothing is injected here: the real prepareMac and the real spawnCliRunner run a real executable file.
const shebang='#!'+process.execPath+'\n';
const reportScript=shebang+'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),envNames:Object.keys(process.env).sort(),path:process.env.PATH??null,cwd:process.cwd()}));\n';
const replacedScript=shebang+"process.stdout.write('replaced-ran');\n";
const macOnly={skip:process.platform!=='darwin'&&'the unwrapped launcher path is macOS-only'};
const fixtures=async(t:test.TestContext)=>{
 const root=await mkdtemp(join(tempRoot(),'massion-cli-real-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'cli');await writeFile(target,reportScript,{mode:0o700});chmodSync(target,0o700);
 const cwd=await mkdtemp(join(tempRoot(),'massion-cli-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const policy=(stamp=cliStamp(target)):LauncherPolicy=>({command:target,stamp,args:['read',/^[a-z][a-z0-9-]{0,31}$/],environment:['PATH','LANG'],secrets:{},readOnly:true});
 const call=(args:readonly string[]=['read','item-1']):CliInvocation=>({command:target,args,stdin:'',cwd,env:{PATH:'/usr/bin:/bin',LANG:'C',NODE_OPTIONS:'--inspect',PRIVATE_TOKEN:'unrelated'},timeoutMs:5000,maxOutputBytes:16384,signal:new AbortController().signal});
 return {root,target,cwd,policy,call};
};

test('a real executable starts through CliLauncher with exactly the allowed arguments, environment names, PATH and working directory',macOnly,async t=>{
 const {policy,call,cwd}=await fixtures(t);
 const result=await new CliLauncher(policy(),new InMemorySecretSlots()).launch('real-child',call());
 assert.equal(result.spawned,true);assert.equal(result.exitCode,0);assert.equal(result.stderr,'');
 const report=JSON.parse(result.stdout);
 assert.deepEqual(report.argv,['read','item-1']);
 // Node's async spawn adds __CF_USER_TEXT_ENCODING to children on macOS (a name on the product allow-list); nothing else may appear.
 const runtimeAdded=process.platform==='darwin'?['__CF_USER_TEXT_ENCODING']:[];
 assert.deepEqual(report.envNames,['LANG','PATH',...runtimeAdded].sort(),'the child sees only the allow-listed names that were present');
 assert.equal(report.path,'/usr/bin:/bin');
 assert.equal(report.cwd,cwd);
});

test('a discovery target replaced after its stamp is taken is refused and nothing runs',macOnly,async t=>{
 const {target,policy,call}=await fixtures(t);
 const launcher=new CliLauncher(policy(),new InMemorySecretSlots());
 await writeFile(target,replacedScript);
 await utimes(target,new Date(),new Date(Date.now()+2000));
 const result=await launcher.launch('replaced',call());
 assert.equal(result.spawned,false);assert.equal(result.exitCode,null);assert.equal(result.stdout,'','the replaced program never ran');
});

test('a policy that hands a secret to the executable is refused before anything is spawned',async t=>{
 const {policy}=await fixtures(t);
 const secrets=new InMemorySecretSlots();await secrets.set({owner:'fixture',slot:'token'},'sentinel');
 assert.throws(()=>new CliLauncher({...policy(),secrets:{TOOL_TOKEN:{owner:'fixture',slot:'token'}}},secrets),/CLI launcher unavailable/);
});

test('a forbidden argument and a forbidden environment name are refused without injected adapters',async t=>{
 const {policy,call}=await fixtures(t);
 const launcher=new CliLauncher(policy(),new InMemorySecretSlots());
 await assert.rejects(launcher.launch('bad-argument',call(['read','--write'])),/CLI arguments refused/);
 assert.throws(()=>new CliLauncher({...policy(),environment:['NODE_OPTIONS']},new InMemorySecretSlots()),/CLI launcher unavailable/);
});

test('a launch without an injected prepare is refused on platforms other than macOS',{skip:process.platform==='darwin'&&'refused here only by accident of a missing sandbox-exec before this change'},async t=>{
 const {policy,call}=await fixtures(t);
 const result=await new CliLauncher(policy(),new InMemorySecretSlots()).launch('non-darwin',call());
 assert.equal(result.spawned,false);assert.equal(result.exitCode,null);assert.equal(result.stdout,'');
});

test('a real child that overflows the cap or outlives the time limit returns no stdout',async t=>{
 const {target,cwd,policy,call}=await fixtures(t);
 await writeFile(target,shebang+"process.stdout.write('x'.repeat(65536));\n");
 const flooded=await new CliLauncher(policy(cliStamp(target)),new InMemorySecretSlots(),{prepare:async()=>async()=>{}}).launch('flooded',call());
 assert.equal(flooded.spawned,true);assert.equal(flooded.overflow,true);assert.equal(flooded.stdout,'','the overflowing output is not returned');
 await writeFile(target,shebang+"process.stdout.write('partial-output-');setInterval(()=>{},1000);\n");
 const late=await new CliLauncher(policy(cliStamp(target)),new InMemorySecretSlots(),{prepare:async()=>async()=>{}}).launch('late',{...call(),timeoutMs:300});
 assert.equal(late.spawned,true);assert.equal(late.timedOut,true);assert.equal(late.stdout,'','the partial output of a timed-out child is not returned');
});

test('a working directory outside the temp root, without the prefix, or with group or other bits is refused',macOnly,async t=>{
 const {policy,call}=await fixtures(t);
 const outside=await mkdtemp(join(process.cwd(),'massion-cli-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 const unprefixed=await mkdtemp(join(tempRoot(),'other-prefix-'));t.after(()=>rm(unprefixed,{recursive:true,force:true}));
 const permissive=await mkdtemp(join(tempRoot(),'massion-cli-'));chmodSync(permissive,0o750);t.after(()=>rm(permissive,{recursive:true,force:true}));
 const launcher=new CliLauncher(policy(),new InMemorySecretSlots());
 for(const cwd of [outside,unprefixed,permissive]){
  const result=await launcher.launch('refused-'+basename(cwd),{...call(),cwd});
  assert.deepEqual(result,{spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false});
 }
});

const codexFixture=async(t:test.TestContext,options:{version?:string;listing?:string;listingExit?:number;mcpList?:string;mcpExit?:number;toolEvent?:object;injected?:boolean;interrupt?:'overflow'|'timeout'|'cancel';userConfig?:boolean}={})=>{
 const {root,target}=await fixtures(t);
 const log=join(root,'calls');
 const previous=process.env.CODEX_HOME;
 process.env.CODEX_HOME=root;
 t.after(()=>{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;});
 if(options.userConfig)await writeFile(join(root,'config.toml'),'[features]\nrespect_system_proxy = false\n');
 const controller=new AbortController();
 const events=[{type:'thread.started',thread_id:'fixture'},{type:'turn.started'},...(options.toolEvent?[options.toolEvent]:[]),
  {type:'item.completed',item:{id:'answer',type:'agent_message',text:'OK'}},
  {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}];
 await writeFile(target,shebang+[
  'const {appendFileSync,readFileSync,statSync}=require("node:fs");',
  'const args=process.argv.slice(2), stdin=readFileSync(0,"utf8");',
  'const catalogArg=args.find(a=>a.startsWith("model_catalog_json="));',
  'const catalogPath=catalogArg&&JSON.parse(catalogArg.split("=").slice(1).join("="));',
  `appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin,catalogPath,catalog:catalogPath&&JSON.parse(readFileSync(catalogPath,"utf8")),catalogMode:catalogPath&&(statSync(catalogPath).mode&0o777),cwd:process.cwd()})+"\\n");`,
  `if(args[0]==="--version")console.log(${JSON.stringify(options.version??'codex-cli 0.171.0')});`,
  `else if(args.slice(-2).join(" ")==="features list"){process.stdout.write(${JSON.stringify(options.listing??codexFeatureListing)});process.exitCode=${options.listingExit??0};}`,
  `else if(args.slice(-3).join(" ")==="mcp list --json"){console.log(${JSON.stringify(options.mcpList??'[]')});process.exitCode=${options.mcpExit??0};}`,
  `else if(args.includes("exec")){process.stdout.write(${JSON.stringify(events.map(event=>JSON.stringify(event)).join('\n')+'\n')},()=>{${options.interrupt==='overflow'?"process.stdout.write('x'.repeat(20000));":options.interrupt?'setTimeout(()=>process.exit(1),5000);':''}});}`,
  'else process.exitCode=1;',
 ].join('\n')+'\n');
 const host=subscriptionCliHost(name=>name==='MASSION_CODEX_CLI_COMMAND'?target:undefined,new InMemorySecretSlots(),{
  home:()=>root,fixedFolders:()=>[],loginShell:()=>undefined,readEnvironment:()=>undefined,
 });
 const found=await host.discover('codex-cli');
 assert.ok(found&&found!=='timed-out');
 const launcher=host.run['codex-cli/v1']!;
 const adapter=cliProfileFactory('codex-cli/v1',options.injected?{mode:'https',command:target,runner:spawnCliRunner}:options.interrupt==='cancel'?{mode:'https',command:target,runner:call=>launcher.launch(call.invocationId!,!call.onStdoutLine?call:{...call,onStdoutLine:line=>{
  call.onStdoutLine?.(line);
  if(JSON.parse(line).type==='tool_call')controller.abort();
 }})}:{mode:'https',launcher}).create({
  id:'codex',label:'Codex',backend:'model-provider',providerKind:'codex-cli',protocol:'codex-cli/v1',model:'model',
  endpoint:'cli://codex/',revision:'fixture',enabled:true,auth:{method:'cli-login'},capabilities:['text-output'],
  usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},
  limits:{maxInputBytes:256,maxOutputTokens:64,maxResponseBytes:16384,timeoutMs:5000},
 });
 const result=await adapter.invoke({invocationId:'codex-fixture',workId:'work',instruction:'Answer using a tool.',inputReferences:[],maxOutputTokens:64,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});
 if(options.interrupt==='cancel')assert.equal(controller.signal.aborted,true);
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {args:string[];stdin:string;catalogPath?:string;catalog?:{models:Record<string,unknown>[]};catalogMode?:number;cwd:string});
 return {result,calls};
};

const replaceFeature=(key:string,value:string)=>codexFeatureListing.replace(new RegExp(`^(${key}\\s+.*?\\s+)(true|false)$`,'m'),`$1${value}`);
const mcpChecks=['--version','--version','features list','mcp list --json'];
const commandOf=({args}:{args:string[]})=>args[0]==='--version'?args[0]:args.includes('exec')?'exec':args.at(-1)==='--json'?args.slice(-3).join(' '):args.slice(-2).join(' ');

for(const [name,options,checks] of [
 ['unknown enabled feature',{listing:codexFeatureListing+'new_tool  stable  true\n'},['--version','--version','features list']],
 ['overridden feature still enabled',{listing:replaceFeature('hooks','true')},['--version','--version','features list']],
 ['unparseable listing',{listing:replaceFeature('shell_tool','unknown')},['--version','--version','features list']],
 ['failed listing command',{listingExit:1},['--version','--version','features list']],
 ['unsupported version',{version:'codex-cli 0.171.1'},['--version','--version']],
 ['injected runner with an unknown enabled feature',{injected:true,listing:codexFeatureListing+'new_tool  stable  true\n'},['--version','--version','features list']],
 ['the final listing row missing',{listing:codexFeatureListing.trimEnd().split('\n').slice(0,-1).join('\n')},['--version','--version','features list']],
 ['a configured MCP server',{mcpList:codexMcpServerListing},mcpChecks],
 ['invalid MCP JSON',{mcpList:'null'},mcpChecks],
 ['a failed MCP listing command',{mcpExit:1},mcpChecks],
 ['a user config the probes cannot ignore',{userConfig:true},['--version','--version']],
] as const)test(`Codex refuses before dispatch with ${name}`,{...macOnly,timeout:10000},async t=>{
 const {result,calls}=await codexFixture(t,options);
 assert.equal(result.reason,'cli_unavailable_not_started');
 assert.equal(result.status,'failed');
 assert.equal(result.output,null);
 assert.deepEqual(calls.map(commandOf),checks);
 assert.ok(calls.every(({stdin})=>stdin===''));
});

test('supported Codex runs only after listing and uses the one tool-free model in its private catalogue',{...macOnly,timeout:10000},async t=>{
 const {result,calls}=await codexFixture(t);
 assert.equal(result.status,'completed');
 assert.equal(result.output,'OK');
 assert.equal(calls.length,5);
 assert.deepEqual(calls[2]!.args.slice(-2),['features','list']);
 assert.ok(calls[2]!.args.includes('features.shell_tool=false'));
 assert.deepEqual(calls.slice(0,4).map(({stdin})=>stdin),['','','','']);
 const {args,stdin,catalogPath,catalog,catalogMode,cwd}=calls[4]!;
 const overrides=(argv:string[])=>argv.flatMap((arg,i)=>arg==='-c'?[argv[i+1]]:[]);
 assert.deepEqual(overrides(calls[2]!.args),overrides(args));
 assert.deepEqual(overrides(calls[3]!.args),overrides(args));
 assert.ok(overrides(args).includes('features.respect_system_proxy=false'));
 assert.equal(stdin,'Answer using a tool.');
 assert.deepEqual(args.slice(args.indexOf('--sandbox'),args.indexOf('--sandbox')+2),['--sandbox','read-only']);
 assert.equal(catalogPath,join(cwd,'model-catalog.json'));
 assert.equal(catalogMode,0o600);
 assert.equal(catalog?.models.length,1);
 const model=catalog!.models[0]!;
 assert.equal(model.slug,args[args.indexOf('-m')+1]);
 assert.equal(model.shell_type,'disabled');
 assert.equal(Object.hasOwn(model,'apply_patch_tool_type'),false);
 assert.deepEqual(model.experimental_supported_tools,[]);
 assert.deepEqual(model.model_messages,{instructions_template:'You produce bounded plain-text answers for an independent review workflow. Follow the user instruction exactly. Do not use tools.'});
 await assert.rejects(readFile(catalogPath!));
});

test('a Codex CLI result containing an unexpected tool event is refused',{...macOnly,timeout:10000},async t=>{
 const {result,calls}=await codexFixture(t,{toolEvent:{type:'tool_call',name:'example'},injected:true});
 assert.equal(result.reason,'unsupported_tool_output');
 assert.equal(result.status,'failed');
 assert.equal(result.output,null);
 assert.deepEqual(calls.map(({args})=>args.at(-1)),['--version','--version','list','--json','-']);
});

for(const interrupt of ['overflow','timeout','cancel'] as const)test(`a tool event survives ${interrupt} through the installed launcher`,{...macOnly,timeout:10000},async t=>{
 const {result,calls}=await codexFixture(t,{interrupt,toolEvent:{type:'tool_call',name:'example'}});
 assert.deepEqual(calls.map(commandOf),[...mcpChecks,'exec']);
 assert.equal(result.status,'failed');
 assert.equal(result.reason,'unsupported_tool_output');
 assert.equal(result.output,null);
});

test('Codex spends one deadline across all probes and exec',{timeout:10000},async t=>{
 const {root,cwd,call}=await fixtures(t);
 let now=0;
 t.mock.method(performance,'now',()=>now);
 const bounds:number[]=[];
 const execution=await runCodexText('model',{...call(),env:{CODEX_HOME:root},timeoutMs:4000},async invocation=>{
  bounds.push(invocation.timeoutMs);
  now+=1000;
  return codexProbeResult(invocation)??{spawned:true,exitCode:0,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};
 });
 assert.equal(execution.status,'ran');
 assert.deepEqual(bounds,[4000,3000,2000,1000]);
 const expiredStages:string[]=[];
 const expired=await runCodexText('model',{...call(),env:{CODEX_HOME:root},timeoutMs:1000},async invocation=>{
  expiredStages.push(invocation.args[0]!);
  now+=1000;
  return codexProbeResult(invocation)!;
 });
 assert.notEqual(expired.status,'ran');
 assert.deepEqual(expiredStages,['--version']);
 assert.equal((await stat(cwd)).isDirectory(),true);
});

test('the shared Codex runner unlinks its catalogue in a caller-owned directory',{timeout:10000},async t=>{
 const {root,cwd,call}=await fixtures(t);
 const path=join(cwd,'model-catalog.json');
 const execution=await runCodexText('model',{...call(),env:{CODEX_HOME:root}},async invocation=>{
  const probe=codexProbeResult(invocation);
  if(probe)return probe;
  assert.equal((await stat(path)).mode&0o777,0o600);
  return {spawned:true,exitCode:0,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};
 });
 assert.equal(execution.status,'ran');
 await assert.rejects(stat(path),{code:'ENOENT'});
 assert.equal((await stat(cwd)).isDirectory(),true);
});
