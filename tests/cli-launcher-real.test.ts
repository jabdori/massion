import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync} from 'node:fs';
import {mkdtemp,rm,utimes,writeFile} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {basename,join} from 'node:path';
import {CliLauncher,cliStamp} from '../src/cli-launcher.ts';
import type {LauncherPolicy} from '../src/cli-launcher.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import type {CliInvocation} from '../src/cli-agent-providers.ts';

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
