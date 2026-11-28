import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,writeFileSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {dirname,join} from 'node:path';
import {discoverSubscriptionCli,parseLoginShellPath,SUBSCRIPTION_CLI_VERSION_PATTERNS,subscriptionCliSearchPath} from '../src/subscription-cli-discovery.ts';
import type {DiscoveredSubscriptionCli,SubscriptionCliSearchResult,SubscriptionDiscoveryAdapters} from '../src/subscription-cli-discovery.ts';
import {cliStamp} from '../src/cli-launcher.ts';
import {cliLauncherEnvironmentNames} from '../src/cli-agent-providers.ts';
import type {CliInvocation,CliResult} from '../src/cli-agent-providers.ts';

const ok=(stdout:string):CliResult=>({spawned:true,exitCode:0,stdout,stderr:'',timedOut:false,aborted:false,overflow:false});
const executable=async(path:string,body='')=>{await mkdir(dirname(path),{recursive:true});writeFileSync(path,body);chmodSync(path,0o755);};
/** A fake --version runner that records every call and never touches a real CLI. */
const runnerFor=(answer:(call:CliInvocation)=>CliResult)=>{const calls:CliInvocation[]=[];return {calls,versionRunner:async(call:CliInvocation)=>{calls.push(call);return answer(call);}};};
const claudeShape='2.1.325 (Claude Code)\n';
const adapters=(root:string,over:Partial<SubscriptionDiscoveryAdapters>={},versionRunner?:SubscriptionDiscoveryAdapters['versionRunner']):SubscriptionDiscoveryAdapters=>({home:()=>join(root,'home'),fixedFolders:()=>[join(root,'first'),join(root,'second'),join(root,'third')],loginShell:()=>undefined,readEnvironment:()=>undefined,...(versionRunner?{versionRunner}:{}),...over});
/** Reads a field of a search result exactly as the previous optional chaining did for null; a search that ended by waiting has no fields. */
const discovered=(found:SubscriptionCliSearchResult):DiscoveredSubscriptionCli|null=>found==='timed-out'?null:found;

test('each fixed folder is searched in order and the first accepted candidate wins',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-order-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const folder of ['first','second','third'])await executable(join(root,folder,'claude'));
 const seen=runnerFor(call=>ok(call.command.includes(join(root,'second'))?'codex-cli 0.1.0\n':claudeShape));
 const found=await discoverSubscriptionCli('claude',undefined,adapters(root,{},seen.versionRunner));
 assert.equal(discovered(found)?.path,await realpath(join(root,'first','claude')));
 assert.deepEqual(seen.calls.map(call=>call.command),[await realpath(join(root,'first','claude'))]);
});

test('a symbolic link chain is resolved to the end and only the resolved path is executed',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-symlink-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'real','claude'));
 await mkdir(join(root,'middle'),{recursive:true});await mkdir(join(root,'first'),{recursive:true});
 await symlink(join(root,'real','claude'),join(root,'middle','claude'));
 await symlink(join(root,'middle','claude'),join(root,'first','claude'));
 const seen=runnerFor(()=>ok(claudeShape));
 const found=await discoverSubscriptionCli('claude',undefined,adapters(root,{},seen.versionRunner));
 const resolved=await realpath(join(root,'real','claude'));
 assert.equal(discovered(found)?.path,resolved);
 assert.deepEqual(seen.calls.map(call=>call.command),[resolved]);
});

test('a candidate answering as another program, nothing, non-zero, past the bound or unexecutably is skipped; all bad is not found',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-bad-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'second','claude'));
 const bad=(kind:string,call:CliInvocation):CliResult=>{
  if(!call.command.startsWith(join(root,'first')))return ok(claudeShape);
  if(kind==='foreign')return ok('claude version 1.2.3 from somewhere else\n');
  if(kind==='empty')return ok('');
  if(kind==='nonzero')return {...ok(claudeShape),exitCode:1};
  return {...ok(''),timedOut:true};
 };
 for(const kind of ['foreign','empty','nonzero','timeout']){
  await executable(join(root,'first','claude'));
  const seen=runnerFor(call=>bad(kind,call));
  const found=await discoverSubscriptionCli('claude',undefined,adapters(root,{},seen.versionRunner));
  assert.equal(discovered(found)?.path,await realpath(join(root,'second','claude')),kind);
 }
 await executable(join(root,'first','claude'));chmodSync(join(root,'first','claude'),0o644);
 const noExec=runnerFor(()=>ok(claudeShape));
 assert.equal(discovered(await discoverSubscriptionCli('claude',undefined,adapters(root,{},noExec.versionRunner)))?.path,await realpath(join(root,'second','claude')));
 assert.deepEqual(noExec.calls.map(call=>call.command),[await realpath(join(root,'second','claude'))]);
 const allBad=runnerFor(()=>ok('some other program\n'));
 assert.equal(await discoverSubscriptionCli('claude',undefined,adapters(root,{},allBad.versionRunner)),null);
});

test('the login shell supplies PATH between markers with noise, and only absolute directories become candidates after the fixed folders gave nothing',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-shellpath-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'abs-b','claude'));
 const absA=join(root,'abs-a'),absB=join(root,'abs-b');
 const noisy='banner noise\n__MASSION_PATH_BEGIN__relative-entry:'+absA+'::'+absB+'__MASSION_PATH_END__\ntrailing noise\n';
 const seen=runnerFor(call=>ok(claudeShape));
 const found=await discoverSubscriptionCli('claude',undefined,adapters(root,{loginShell:()=>join(root,'injected-shell'),runLoginShell:async()=>({stdout:noisy,waited:false})},seen.versionRunner));
 assert.equal(discovered(found)?.path,await realpath(join(absB,'claude')));
 assert.deepEqual(seen.calls.map(call=>call.command),[await realpath(join(absB,'claude'))],'a missing directory is never executed');
 assert.deepEqual(parseLoginShellPath(noisy),['relative-entry',absA,absB]);
 assert.equal(discovered(found)?.searchPath,[join(root,'first'),join(root,'second'),join(root,'third'),absA,absB].join(':'));
});

test('the login shell PATH is obtained once per discovery even when a fixed folder already has the CLI',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-shellalways-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'first','claude'));
 let shellRuns=0;const seen=runnerFor(()=>ok(claudeShape));
 const found=await discoverSubscriptionCli('claude',undefined,adapters(root,{loginShell:()=>join(root,'injected-shell'),runLoginShell:async()=>{shellRuns++;return {stdout:'__MASSION_PATH_BEGIN__'+join(root,'interpreter-dir')+'__MASSION_PATH_END__',waited:false};}},seen.versionRunner));
 assert.equal(shellRuns,1,'the interpreter may live elsewhere, so the shell runs even after a fixed-folder hit');
 assert.ok(discovered(found)!.searchPath.endsWith(join(root,'interpreter-dir')));
 assert.equal(seen.calls.length,1);
});

test('a hanging login shell is killed at the bound with its process group and the search ends timed-out',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-hangshell-'));t.after(()=>rm(root,{recursive:true,force:true}));
 // A node fake shell: it records its own pid, then hangs; the marker command never prints.
 const shell=join(root,'fake-login-shell'),pidFile=join(root,'shell.pid');
 await writeFile(shell,'#!'+process.execPath+'\nrequire(\'node:fs\').writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));setInterval(()=>{},1000);\n');chmodSync(shell,0o755);
 const seen=runnerFor(()=>ok(claudeShape));
 const discovering=discoverSubscriptionCli('claude',undefined,adapters(root,{loginShell:()=>shell,loginShellTimeoutMs:800},seen.versionRunner));
 let pid:number|undefined;const deadline=Date.now()+700;
 while(pid===undefined&&Date.now()<deadline){try{const value=Number(await readFile(pidFile,'utf8'));if(Number.isSafeInteger(value)&&value>0)pid=value;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
 assert.ok(Number.isSafeInteger(pid),'the fake shell was observed running before the bound');
 assert.equal(await discovering,'timed-out','the step ended by waiting without printing a PATH, so the search is not absence');
 await new Promise(resolve=>setTimeout(resolve,100));
 await assert.rejects(async()=>process.kill(pid!,0),{code:'ESRCH'},'the whole process group must be gone');
 assert.deepEqual(seen.calls,[]);
});

test('an aborted login-shell step ends by waiting and the search ends timed-out',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-abortshell-'));t.after(()=>rm(root,{recursive:true,force:true}));
 // A node fake shell: it records its own pid, then hangs; the marker command never prints.
 const shell=join(root,'fake-login-shell'),pidFile=join(root,'shell.pid');
 await writeFile(shell,'#!'+process.execPath+'\nrequire(\'node:fs\').writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));setInterval(()=>{},1000);\n');chmodSync(shell,0o755);
 const seen=runnerFor(()=>ok(claudeShape));
 const controller=new AbortController();
 // The bound stays far away so the timer can never be what ends the step: only the abort can.
 const discovering=discoverSubscriptionCli('claude',undefined,adapters(root,{loginShell:()=>shell,loginShellTimeoutMs:5000},seen.versionRunner),controller.signal);
 let pid:number|undefined;const deadline=Date.now()+3000;
 while(pid===undefined&&Date.now()<deadline){try{const value=Number(await readFile(pidFile,'utf8'));if(Number.isSafeInteger(value)&&value>0)pid=value;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
 assert.ok(Number.isSafeInteger(pid),'the fake shell was observed running before the abort');
 controller.abort();
 assert.equal(await discovering,'timed-out','an aborted step ended by waiting without printing a PATH, so the search is not absence');
 await new Promise(resolve=>setTimeout(resolve,100));
 await assert.rejects(async()=>process.kill(pid!,0),{code:'ESRCH'},'the whole process group must be gone');
 assert.deepEqual(seen.calls,[]);
});

test('a login-shell step that ended by waiting without a PATH ends the search timed-out; a fixed-folder hit is found as today',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-shellwait-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const waitedWithoutPath=async()=>({stdout:'login shell noise without markers',waited:true});
 assert.equal(await discoverSubscriptionCli('claude',undefined,adapters(root,{loginShell:()=>join(root,'injected-shell'),runLoginShell:waitedWithoutPath},runnerFor(()=>ok(claudeShape)).versionRunner)),'timed-out','no candidate was accepted and the shell never delivered its PATH');
 await executable(join(root,'first','claude'));
 assert.equal(discovered(await discoverSubscriptionCli('claude',undefined,adapters(root,{loginShell:()=>join(root,'injected-shell'),runLoginShell:waitedWithoutPath},runnerFor(()=>ok(claudeShape)).versionRunner)))?.path,await realpath(join(root,'first','claude')),'a candidate in a fixed folder is found whatever the shell did');
 // A step that delivered its PATH before waiting out completed the search surface: the shell directories were searched, so nothing accepted is definitive absence, exactly as before.
 await rm(join(root,'first','claude'));
 const waitedAfterPath=async()=>({stdout:'__MASSION_PATH_BEGIN__'+join(root,'shell-dir')+'__MASSION_PATH_END__',waited:true});
 assert.equal(await discoverSubscriptionCli('claude',undefined,adapters(root,{loginShell:()=>join(root,'injected-shell'),runLoginShell:waitedAfterPath},runnerFor(()=>ok(claudeShape)).versionRunner)),null,'the PATH arrived, so the wait is not the waiting defect');
});

test('a single candidate whose check ended by waiting makes the whole search timed-out, for a timeout and for an abort',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-checkwait-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'first','claude'));
 for(const waited of [{timedOut:true,aborted:false},{timedOut:false,aborted:true}] as const){
  const seen=runnerFor(()=>({...ok(''),...waited}));
  assert.equal(await discoverSubscriptionCli('claude',undefined,adapters(root,{},seen.versionRunner)),'timed-out',waited.timedOut?'a check past its bound is not absence':'a check aborted by the host stopping is not absence');
 }
});

test('the version check is bounded at three seconds',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-versionbound-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'first','claude'));
 const seen=runnerFor(()=>ok(claudeShape));
 await discoverSubscriptionCli('claude',undefined,adapters(root,{},seen.versionRunner));
 assert.equal(seen.calls[0]!.timeoutMs,3000,'the probe passes the three-second bound to the runner');
});

test('every probe runs a resolved absolute path with exactly --version under the pinned environment names',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-shape-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'first','claude'));
 const seen=runnerFor(()=>ok(claudeShape));
 const environment:Record<string,string>={'MASSION_UNRELATED':'no',HOME:'/fixture/home',PATH:'/fixture/earlier'};
 const found=await discoverSubscriptionCli('claude',undefined,{...adapters(root,{account:()=>'fixture-account'},seen.versionRunner),readEnvironment:name=>environment[name]});
 const allowed=cliLauncherEnvironmentNames('claude-code-cli/v1');
 for(const call of seen.calls){
  assert.ok(call.command.startsWith('/'),'never a bare name');
  assert.deepEqual(call.args,['--version']);
  assert.deepEqual([...Object.keys(call.env)].sort(),[...new Set([...allowed,'PATH'])].filter(name=>environment[name]!==undefined||name==='PATH'||name==='USER'||name==='LOGNAME').sort());
  assert.equal(call.env.USER,'fixture-account','USER comes from the OS account lookup');
  assert.equal(call.env.LOGNAME,'fixture-account','LOGNAME comes from the OS account lookup');
  assert.equal(call.env.PATH,discovered(found)!.searchPath);
  assert.equal(call.env.HOME,'/fixture/home');
  assert.equal((call.env as Record<string,string|undefined>).MASSION_UNRELATED,undefined);
 }
});

test('the version probe takes USER and LOGNAME from the OS account lookup, never from the environment it reads',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-account-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'first','claude'));
 const inherited:Record<string,string>={USER:'fixture-inherited-user',LOGNAME:'fixture-inherited-logname'};
 // A packaged start: neither name is present, and the account lookup fills both.
 {
  const seen=runnerFor(()=>ok(claudeShape));
  const found=await discoverSubscriptionCli('claude',undefined,{...adapters(root,{account:()=>'fixture-account'},seen.versionRunner),readEnvironment:()=>undefined});
  assert.equal(discovered(found)?.version,claudeShape.trim());
  assert.equal(seen.calls.length,1);
  assert.equal(seen.calls[0]!.env.USER,'fixture-account');
  assert.equal(seen.calls[0]!.env.LOGNAME,'fixture-account');
 }
 // A development start with different inherited values: the account wins over both.
 {
  const seen=runnerFor(()=>ok(claudeShape));
  await discoverSubscriptionCli('claude',undefined,{...adapters(root,{account:()=>'fixture-account'},seen.versionRunner),readEnvironment:name=>inherited[name]});
  assert.equal(seen.calls[0]!.env.USER,'fixture-account','the account name overrides the inherited USER');
  assert.equal(seen.calls[0]!.env.LOGNAME,'fixture-account','the account name overrides the inherited LOGNAME');
 }
 // A failed lookup leaves the two names as inherited (absent here: the read environment has neither; exactly main) and the probe still starts and validates.
 {
  const seen=runnerFor(()=>ok(claudeShape));
  const found=await discoverSubscriptionCli('claude',undefined,{...adapters(root,{account:()=>{throw new Error('account lookup failed');}},seen.versionRunner),readEnvironment:()=>undefined});
  assert.equal(discovered(found)?.version,claudeShape.trim(),'the probe still started and its output still validated');
  assert.equal((seen.calls[0]!.env as Record<string,string|undefined>).USER,undefined);
  assert.equal((seen.calls[0]!.env as Record<string,string|undefined>).LOGNAME,undefined);
 }
});

test('a configured absolute path replaces the search and never falls back to discovery',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-configured-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'configured','claude'));await executable(join(root,'first','claude'));
 const seen=runnerFor(call=>ok(call.command===join(root,'configured','claude')?'nonsense 1.2.3\n':claudeShape));
 assert.equal(await discoverSubscriptionCli('claude',join(root,'configured','claude'),adapters(root,{},seen.versionRunner)),null);
 assert.deepEqual(seen.calls.map(call=>call.command),[await realpath(join(root,'configured','claude'))]);
 const accepting=runnerFor(()=>ok(claudeShape));
 assert.equal(discovered(await discoverSubscriptionCli('claude',join(root,'configured','claude'),adapters(root,{},accepting.versionRunner)))?.path,await realpath(join(root,'configured','claude')));
});

test('a configured absolute path starts no login shell and is validated as it is, with the fixed folders plus the fallback directories as its PATH',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-configured-noshell-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'configured','claude'));await executable(join(root,'first','claude'));
 let shellRuns=0;const seen=runnerFor(()=>ok(claudeShape));
 const shell={loginShell:()=>join(root,'injected-shell'),runLoginShell:async()=>{shellRuns++;return {stdout:'__MASSION_PATH_BEGIN__'+join(root,'shell-dir')+'__MASSION_PATH_END__',waited:false};}};
 const found=await discoverSubscriptionCli('claude',join(root,'configured','claude'),adapters(root,shell,seen.versionRunner));
 assert.equal(shellRuns,0,'an explicit path skips the login-shell step');
 assert.deepEqual(seen.calls.map(call=>call.command),[await realpath(join(root,'configured','claude'))],'only the configured path is probed');
 assert.equal(discovered(found)?.path,await realpath(join(root,'configured','claude')));
 assert.equal(discovered(found)?.version,claudeShape.trim(),'the version line that passed validation is the one reported');
 const searchPath=[join(root,'first'),join(root,'second'),join(root,'third'),'/usr/bin','/bin'].join(':');
 assert.equal(discovered(found)?.searchPath,searchPath,'no shell ran, so the PATH is the one a shell step that delivered nothing already produced');
 assert.equal(seen.calls[0]!.env.PATH,searchPath,'the check itself ran with that PATH');
});

test('a configured path that fails validation starts no login shell either and keeps the answer it has today: absence without fallback, or timed-out when its own check ended by waiting',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-configured-bad-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'first','claude'));
 // kind, the file exists, its version check runs, what the check answers, what the search returns
 const cases:[string,boolean,boolean,CliResult,SubscriptionCliSearchResult][]=[
  ['the file is missing',false,false,ok(claudeShape),null],
  ['the file is not executable',true,false,ok(claudeShape),null],
  ['another program\'s version line',true,true,ok('some other tool 9.9'),null],
  ['its check ended by waiting',true,true,{...ok(''),timedOut:true},'timed-out'],
 ];
 for(const [index,[kind,present,checked,result,expected]] of cases.entries()){
  const configured=join(root,'configured',String(index),'claude');
  if(present){await executable(configured);if(!checked)chmodSync(configured,0o644);}
  let shellRuns=0;const seen=runnerFor(()=>result);
  const found=await discoverSubscriptionCli('claude',configured,adapters(root,{loginShell:()=>join(root,'injected-shell'),runLoginShell:async()=>{shellRuns++;return {stdout:'__MASSION_PATH_BEGIN__'+join(root,'shell-dir')+'__MASSION_PATH_END__',waited:false};}},seen.versionRunner));
  assert.equal(found,expected,kind);
  assert.equal(shellRuns,0,kind+': the login shell is not started for it either');
  assert.deepEqual(seen.calls.map(call=>call.command),checked?[await realpath(configured)]:[],kind+': only the configured path is probed, and the fixed-folder CLI is never used in its place');
 }
});

test('a shebang launcher whose interpreter exists only in the login-shell PATH is found and receives exactly that PATH',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-shebang-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const marker=join(root,'received-path');
 await executable(join(root,'shell-dir','fakenode'),'#!/bin/sh\nprintf %s "$PATH" > '+JSON.stringify(marker)+'\necho \'2.1.0 (Claude Code)\'');
 await executable(join(root,'first','claude'),'#!/usr/bin/env fakenode\n');
 const {spawnCliRunner}=await import('../src/cli-process.ts');
 const calls:CliInvocation[]=[];
 const runReal=async(call:CliInvocation)=>{calls.push(call);return await spawnCliRunner(call);};
 const found=await discoverSubscriptionCli('claude',undefined,adapters(root,{loginShell:()=>join(root,'injected-shell'),runLoginShell:async()=>({stdout:'__MASSION_PATH_BEGIN__'+join(root,'shell-dir')+'__MASSION_PATH_END__',waited:false})},runReal));
 const searchPath=[join(root,'first'),join(root,'second'),join(root,'third'),join(root,'shell-dir')].join(':');
 assert.equal(discovered(found)?.path,await realpath(join(root,'first','claude')));
 assert.equal(await readFile(marker,'utf8'),searchPath);
 assert.equal(discovered(found)?.searchPath,searchPath);
 calls.length=0;
 assert.equal(await discoverSubscriptionCli('claude',undefined,adapters(root,{loginShell:()=>join(root,'injected-shell'),runLoginShell:async()=>({stdout:'no markers at all',waited:false})},runReal)),null,'without the interpreter directory the launcher is another program');
 for(const call of calls)assert.ok(call.command.startsWith('/'),'nothing is ever tried by bare name');
});

test('the two anchored version patterns accept only their provider shapes',()=>{
 const claude=SUBSCRIPTION_CLI_VERSION_PATTERNS.claude,codex=SUBSCRIPTION_CLI_VERSION_PATTERNS.codex;
 for(const value of ['2.1.232 (Claude Code)','2.1.325 (Claude Code)','10.0.0-rc.1 (Claude Code)'])assert.ok(claude.test(value),value);
 for(const value of ['2.1.232(Claude Code)','claude 2.1.232 (Claude Code)','2.1.232 (Claude Code) extra','codex-cli 0.1.0',''])assert.ok(!claude.test(value),value);
 for(const value of ['codex-cli 0.114.0','codex-cli 0.169.0','codex-cli 1.2.3-beta.1','codex-cli 0.1.0+build.7'])assert.ok(codex.test(value),value);
 for(const value of ['codex 0.114.0','codex-cli v0.114.0','0.114.0','codex-cli 0.114.0 (Codex)','2.1.232 (Claude Code)'])assert.ok(!codex.test(value),value);
});

test('a candidate replaced during the --version run is another program, and an accepted stamp is the pre-run stamp',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-discovery-window-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'first','claude'),'one');
 const resolved=await realpath(join(root,'first','claude'));
 const before=cliStamp(resolved);
 const replaced=runnerFor(()=>{writeFileSync(resolved,'two');chmodSync(resolved,0o755);return ok(claudeShape);});
 assert.equal(await discoverSubscriptionCli('claude',undefined,adapters(root,{},replaced.versionRunner)),null,'a file replaced mid-run never passed --version as itself');
 await executable(resolved,'one');
 const stable=runnerFor(()=>ok(claudeShape));
 const freshBefore=cliStamp(resolved);
 const found=await discoverSubscriptionCli('claude',undefined,adapters(root,{},stable.versionRunner));
 assert.equal(discovered(found)?.path,resolved);
 assert.equal(discovered(found)?.stamp,freshBefore,'the recorded stamp is the file as it was before the run');
});

