import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync} from 'node:fs';
import {mkdtemp,rm,utimes,writeFile} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {CliLauncher,cliStamp} from '../src/cli-launcher.ts';
import type {LauncherPolicy} from '../src/cli-launcher.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import type {CliInvocation} from '../src/cli-agent-providers.ts';

// Nothing is injected here: the real prepareMac and the real spawnCliRunner run a real executable file.
const shebang='#!'+process.execPath+'\n';
const reportScript=shebang+'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),envNames:Object.keys(process.env).sort(),path:process.env.PATH??null,cwd:process.cwd()}));\n';
const replacedScript=shebang+"process.stdout.write('replaced-ran');\n";
const fixtures=async(t:test.TestContext)=>{
 const root=await mkdtemp(join(tempRoot(),'massion-cli-real-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'cli');await writeFile(target,reportScript,{mode:0o700});chmodSync(target,0o700);
 const cwd=await mkdtemp(join(tempRoot(),'massion-cli-'));
 const policy=(stamp=cliStamp(target)):LauncherPolicy=>({command:target,stamp,args:['read',/^[a-z][a-z0-9-]{0,31}$/],environment:['PATH','LANG'],secrets:{},readOnly:true});
 const call=(args:readonly string[]=['read','item-1']):CliInvocation=>({command:target,args,stdin:'',cwd,env:{PATH:'/usr/bin:/bin',LANG:'C',NODE_OPTIONS:'--inspect',PRIVATE_TOKEN:'unrelated'},timeoutMs:5000,maxOutputBytes:16384,signal:new AbortController().signal});
 return {root,target,cwd,policy,call};
};

test('a real executable starts through CliLauncher with exactly the allowed arguments, environment names, PATH and working directory',async t=>{
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

test('a discovery target replaced after its stamp is taken is refused and nothing runs',async t=>{
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
