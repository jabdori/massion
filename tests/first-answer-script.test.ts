import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {accessSync,chmodSync,constants,realpathSync,statSync} from 'node:fs';
import {mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The real claude/codex binaries are never executed here: every case pins BOTH providers' configured
// CLI paths (src/subscription-cli-host.ts CONFIG), so host discovery can only probe the stand-in and
// one deliberately missing path.
const SCRIPT=resolve(fileURLToPath(import.meta.url),'..','..','scripts','first-answer.ts');
const surreal=process.env.MASSION_SURREAL_BINARY??'surreal';
const surrealVersion=spawnSync(surreal,['version'],{encoding:'utf8',timeout:5000});
const surrealSkip=surrealVersion.status===0&&surrealVersion.stdout.trim().startsWith('4.0.1')?false:`SurrealDB 4.0.1 binary unavailable (looked up as ${surreal})`;
// The subscription launcher refuses to start any CLI outside macOS (src/cli-launcher.ts prepareMac), so the model-call cases are macOS-only.
const macSkip=process.platform==='darwin'?false:'the subscription CLI launcher starts executables only on macOS';

/** One stand-in subscription CLI: fixed version and login answers, and a model call that computes the product asked for. */
const standIn=(provider:'claude'|'codex',behavior:'ok'|'exit-nonzero'|'invalid-json'|'tool-call'|'logged-out'|'usage-limit'|'unsupported')=>[
 '#!'+process.execPath,
 'const args=process.argv.slice(2);',
 "if(args.includes('--version')){console.log("+JSON.stringify(provider==='claude'?'2.1.325 (Claude Code)':behavior==='unsupported'?'codex-cli 0.167.1':'codex-cli 0.171.0')+");process.exit(0);}",
 "if(args.slice(-2).join(' ')==='features list'){console.log('shell_tool  stable  false\\ncode_mode  under development  false');process.exit(0);}",
 provider==='claude'
  ?behavior==='logged-out'
   ?"if(args[0]==='auth'&&args[1]==='status'){console.log('{\"loggedIn\":false}');process.exit(0);}"
   :"if(args[0]==='auth'&&args[1]==='status'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}"
  :behavior==='logged-out'
   ?"if(args[0]==='login'&&args[1]==='status'){console.error('Not logged in');process.exit(1);}"
   :"if(args[0]==='login'&&args[1]==='status'){console.error('Logged in using ChatGPT');process.exit(0);}",
 "let input='';",
 "process.stdin.on('data',chunk=>input+=chunk);",
 "process.stdin.on('end',()=>{",
 ' const prompt=JSON.parse(input);',
 " const numbers=String(prompt.currentMessage??'').split(/[^0-9]+/).filter(Boolean).map(Number);",
 ' const product=numbers.length>=2?numbers[0]*numbers[1]:0;',
 ' const turn=JSON.stringify({reply:String(product),work:null});',
 behavior==='exit-nonzero'?' process.exit(1);':'',
 behavior==='invalid-json'?" console.log('not json');process.exit(0);":'',
 behavior==='usage-limit'?' console.log('+JSON.stringify(JSON.stringify({type:'turn.failed',error:{message:'You’ve hit your usage limit. Try again at 1:45 AM.'}}))+');process.exit(1);':'',
 provider==='claude'
  ?" console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:turn,num_turns:1,usage:{input_tokens:9,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:3},modelUsage:{'claude-sonnet-5-5':{}}}));"
  :" const lines=["+(behavior==='tool-call'?"{type:'item.completed',item:{type:'command_execution',command:'ls'}},":"")+"{type:'item.completed',item:{type:'agent_message',text:turn}},{type:'turn.completed',usage:{input_tokens:11,output_tokens:3}}];for(const line of lines)console.log(JSON.stringify(line));",
 ' process.exit(0);',
 '});',
 ''].join('\n');

const fixtures=async(t:test.TestContext)=>{
 const root=await mkdtemp(join(realpathSync(tmpdir()),'massion-standin-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return root;
};

/** A stand-in database found only on the caller's PATH: a transparent wrapper around the real SurrealDB binary. */
const realSurreal=()=>{const configured=process.env.MASSION_SURREAL_BINARY;if(configured&&configured.includes('/'))return configured;for(const folder of (process.env.PATH??'').split(':')){if(!folder)continue;const candidate=join(folder,'surreal');try{if(!statSync(candidate).isFile())continue;accessSync(candidate,constants.X_OK);return realpathSync(candidate);}catch{}}return 'surreal';};
const standInSurreal=(real:string)=>[
 '#!'+process.execPath,
 'const {spawn}=require("node:child_process");',
 'const child=spawn('+JSON.stringify(real)+',process.argv.slice(2),{stdio:"inherit"});',
 'for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>{try{child.kill(signal);}catch{}});',
 'child.on("error",error=>{console.error(String(error));process.exit(1);});',
 'child.on("exit",(code,signal)=>process.exit(code??(signal?128:0)));',
 ''].join('\n');

const runScript=(t:test.TestContext,args:string[],environment:Record<string,string|undefined>)=>{
 const merged:{[key:string]:string|undefined}={...process.env,...environment};
 for(const key of Object.keys(merged))if(merged[key]===undefined)delete merged[key];
 return new Promise<{output:string,code:number|null}>((resolveRun,rejectRun)=>{
 const child=spawn(process.execPath,[SCRIPT,...args],{env:merged as NodeJS.ProcessEnv});
 let output='';
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const timer=setTimeout(()=>{
   // SIGTERM first so the script's own interrupt cleanup (host, database, folder) still gets a chance before the kill.
   child.kill('SIGTERM');
   setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},5000).unref();
   rejectRun(new Error('scripts/first-answer.ts timed out after 150s'));
  },150000);
 t.after(()=>{clearTimeout(timer);child.kill('SIGKILL');});
 child.on('error',error=>{clearTimeout(timer);rejectRun(error);});
 child.on('close',code=>{clearTimeout(timer);resolveRun({output,code});});
 });
};
const install=async(root:string,name:string,source:string)=>{
 const path=join(root,name);
 await writeFile(path,source,{mode:0o755});
 chmodSync(path,0o755);
 return path;
};
/** Both providers pinned: the stand-in under test, and a missing path for the other one. */
const pinEnvironment=(root:string,provider:'claude'|'codex',cli:string)=>provider==='claude'
 ?{MASSION_CLAUDE_CLI_COMMAND:cli,MASSION_CODEX_CLI_COMMAND:join(root,'codex-not-installed')}
 :{MASSION_CODEX_CLI_COMMAND:cli,MASSION_CLAUDE_CLI_COMMAND:join(root,'claude-not-installed')};
const leftovers=async()=>(await readdir(realpathSync(tmpdir()))).filter(name=>name.startsWith('massion-first-answer-')).sort();
const everyStepOk=(output:string)=>{for(const step of ['database','host','daemon-secret','discover-logins','subscription-connection','first-message','answer'])assert.match(output,new RegExp('STEP [0-9]+ '+step+': ok'),output);};
const codexRefusal='SETTLEMENT status=failed reason=cli_unavailable_not_started provider=codex-cli model=gpt-6.1-terra inputTokens=(none) outputTokens=(none)';

test('a stand-in claude CLI answers the first question through every step',{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 assert.deepEqual(await leftovers(),[],'no run folder may exist before the case');
 const cli=await install(root,'claude',standIn('claude','ok'));
 const {output,code}=await runScript(t,['--provider','claude','--cli',cli],pinEnvironment(root,'claude',cli));
 everyStepOk(output);
 assert.equal(code,0,output);
 assert.match(output,/ANSWER 42/);
 assert.match(output,/PROVIDER claude-code-cli/);
 assert.match(output,/MODEL claude-sonnet-5-5/);
 assert.match(output,/SETTLEMENT .*model=claude-sonnet-5-5 inputTokens=9 outputTokens=3/,'the settlement from the conversation view carries the model and usage');
 assert.match(output,/USAGE inputTokens=9 knownOutputTokens=3/);
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test('a detected but unsupported Codex CLI refuses the first model call',{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 const cli=await install(root,'codex',standIn('codex','unsupported'));
 const {output,code}=await runScript(t,['--provider','codex','--cli',cli],pinEnvironment(root,'codex',cli));
 assert.notEqual(code,0,output);
 for(const step of ['database','host','daemon-secret','discover-logins','subscription-connection'])assert.match(output,new RegExp('STEP [0-9]+ '+step+': ok'),output);
 assert.match(output,/STEP [0-9]+ first-message: STOPPED/);
 assert.deepEqual(output.match(/^SETTLEMENT .*$/gm),[codexRefusal]);
 assert.doesNotMatch(output,/^ANSWER /m);
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test('a missing CLI stops at the connection step with the product status verbatim',{skip:surrealSkip},async t=>{
 const root=await fixtures(t);
 const missing=join(root,'claude','claude');
 const {output,code}=await runScript(t,['--provider','claude','--cli',missing],pinEnvironment(root,'claude',missing));
 assert.notEqual(code,0);
 assert.match(output,/STEP [0-9]+ discover-logins: ok/);
 assert.match(output,/claude-code-cli: absent/,'the product login status is shown');
 assert.match(output,/claude-code-cli: absent \(cli-not-found\)/,'the discover step reports the new state');
 assert.match(output,/STEP [0-9]+ subscription-connection: STOPPED/);
 assert.match(output,/"providerType":"claude-code-cli","kind":"cli-login","status":"absent"/,'the verbatim GET /connections body shows the product status');
 assert.match(output,/"state":"cli-not-found"/,'the verbatim body carries the state');
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test('a stand-in CLI that is found but not logged in is reported as such and stops at the connection step',{skip:surrealSkip},async t=>{
 const root=await fixtures(t);
 const cli=await install(root,'claude',standIn('claude','logged-out'));
 const {output,code}=await runScript(t,['--provider','claude','--cli',cli],pinEnvironment(root,'claude',cli));
 assert.notEqual(code,0);
 assert.match(output,/claude-code-cli: absent \(logged-out\)/,'the discover step reports the installed-but-not-logged-in state');
 assert.match(output,/STEP [0-9]+ subscription-connection: STOPPED/);
 assert.match(output,/installed but not logged in/,'the stop reason names the state');
 assert.match(output,/"state":"logged-out"/,'the verbatim GET /connections body carries the state');
 assert.doesNotMatch(output,/POST \/connection-login\//,'no interactive login is named or started');
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

for(const provider of ['claude','codex'] as const){
 test(`two detected logins: the Settings model selection uses the ${provider} choice`,{skip:surrealSkip||macSkip},async t=>{
  const root=await fixtures(t);
  const other=provider==='claude'?'codex':'claude';
  const cli=await install(root,provider,standIn(provider,'ok'));
  const otherCli=await install(root,other,standIn(other,'ok'));
  const environment=provider==='claude'
   ?{MASSION_CLAUDE_CLI_COMMAND:cli,MASSION_CODEX_CLI_COMMAND:otherCli}
   :{MASSION_CODEX_CLI_COMMAND:cli,MASSION_CLAUDE_CLI_COMMAND:otherCli};
  const {output,code}=await runScript(t,['--provider',provider,'--cli',cli],environment);
  assert.match(output,/claude-code-cli: detected \(logged-in\), codex-cli: detected \(logged-in\)/,'both logins are detected');
  assert.match(output,new RegExp('STEP [0-9]+ subscription-connection: ok .POST /connections/host%3A'+provider+'%3A[a-f0-9]+/profiles -> activation turned-on, the selection became the Representative route.'),'the Settings model selection is the route that turns the connection on');
  assert.doesNotMatch(output,/POST \/connection-login/,'no interactive login is named or started');
  if(provider==='claude'){
   everyStepOk(output);
   assert.equal(code,0,output);
   assert.match(output,/ANSWER 42/);
   assert.match(output,/MODEL claude-sonnet-5-5/);
   assert.match(output,/SETTLEMENT .*model=claude-sonnet-5-5 inputTokens=9 outputTokens=3/,'the settlement from the conversation view carries the model and usage');
  }else{
   everyStepOk(output);
   assert.equal(code,0,output);
   assert.match(output,/ANSWER 42/);
   assert.match(output,/MODEL gpt-6.1-terra/);
   assert.match(output,/SETTLEMENT .*model=gpt-6.1-terra inputTokens=11 outputTokens=3/,'the Codex selection answers with measured usage');
  }
  assert.match(output,/processes-remaining: 0/);
  assert.deepEqual(await leftovers(),[],'the run folder was removed');
 });
}

test("without --provider with two detected logins the script turns on the first in the fixed order before sending",{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 const claude=await install(root,'claude',standIn('claude','ok'));
 const codex=await install(root,'codex',standIn('codex','ok'));
 const {output,code}=await runScript(t,[],{MASSION_CLAUDE_CLI_COMMAND:claude,MASSION_CODEX_CLI_COMMAND:codex});
 everyStepOk(output);
 assert.equal(code,0,output);
 assert.match(output,/claude-code-cli: detected \(logged-in\), codex-cli: detected \(logged-in\)/,'both logins are detected');
 assert.match(output,/STEP [0-9]+ subscription-connection: ok \(POST \/connections\/host%3Aclaude%3A[a-f0-9]+\/profiles -> activation turned-on, the selection became the Representative route\)/,'the script sends the turn-on request for the first provider before the message');
 assert.match(output,/ANSWER 42/);
 assert.match(output,/PROVIDER claude-code-cli/,'the script reports the provider that answered');
 assert.match(output,/MODEL claude-sonnet-5-5/);
 assert.match(output,/RESULT answered=1 stopped=0 skipped=0/,'one first message, then the run stops');
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test("the selected provider's login not detected while the other is detected stops with the outcome",{skip:surrealSkip},async t=>{
 const root=await fixtures(t);
 const missing=join(root,'claude','claude');
 const other=await install(root,'codex',standIn('codex','ok'));
 const {output,code}=await runScript(t,['--provider','claude','--cli',missing],{MASSION_CLAUDE_CLI_COMMAND:missing,MASSION_CODEX_CLI_COMMAND:other});
 assert.notEqual(code,0);
 assert.match(output,/claude-code-cli: absent \(cli-not-found\), codex-cli: detected \(logged-in\)/,'the chosen login is not detected, the other is');
 assert.match(output,/STEP [0-9]+ subscription-connection: STOPPED/);
 assert.match(output,/the model selection did not turn /);
 assert.match(output,/POST \/connections\/host%3Aclaude%3A[a-f0-9]+\/profiles \{"model":"claude-sonnet-5-5"/,'the Settings request was sent');
 assert.match(output,/"activation":\{"status":"not-turned-on","reason":"login-not-detected","routeSet":false\}/,'the outcome is printed verbatim');
 assert.doesNotMatch(output,/STEP [0-9]+ first-message/,'no message is sent when the connection stays off');
 assert.doesNotMatch(output,/POST \/connection-login/,'no interactive login is named or started');
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test('a CLI that exits non-zero stops at the answer step',{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 const cli=await install(root,'claude',standIn('claude','exit-nonzero'));
 const {output,code}=await runScript(t,['--provider','claude','--cli',cli],pinEnvironment(root,'claude',cli));
 assert.notEqual(code,0);
 assert.match(output,/STEP [0-9]+ first-message: STOPPED/);
 // The stored reason (cli_exit_1_remote_outcome_unknown) is returned by no route; the body the product does return is printed verbatim.
 assert.match(output,/turn status unknown/);
 assert.match(output,/SETTLEMENT .*reason=cli_exit_1_remote_outcome_unknown provider=claude-code-cli/,'the settlement from the conversation view names the stored reason');
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test('a supported Codex CLI reports a usage limit without printing its message',{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 const cli=await install(root,'codex',standIn('codex','usage-limit'));
 const {output,code}=await runScript(t,['--provider','codex','--cli',cli],pinEnvironment(root,'codex',cli));
 assert.notEqual(code,0,output);
 assert.deepEqual(output.match(/^SETTLEMENT .*$/gm),['SETTLEMENT status=unknown reason=cli_usage_limit_reached provider=codex-cli model=gpt-6.1-terra inputTokens=(none) outputTokens=(none)']);
 assert.doesNotMatch(output,/You’ve hit your usage limit|1:45 AM/);
});

test('a CLI that prints invalid JSON stops at the answer step',{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 const cli=await install(root,'claude',standIn('claude','invalid-json'));
 const {output,code}=await runScript(t,['--provider','claude','--cli',cli],pinEnvironment(root,'claude',cli));
 assert.notEqual(code,0);
 assert.match(output,/STEP [0-9]+ first-message: STOPPED/);
 assert.match(output,/turn status unknown/);
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test('a supported Codex CLI that emits a tool call fails the turn',{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 const cli=await install(root,'codex',standIn('codex','tool-call'));
 const {output,code}=await runScript(t,['--provider','codex','--cli',cli],pinEnvironment(root,'codex',cli));
 assert.notEqual(code,0);
 assert.match(output,/STEP [0-9]+ first-message: STOPPED/);
 assert.match(output,/turn status failed/);
 assert.deepEqual(output.match(/^SETTLEMENT .*$/gm),['SETTLEMENT status=failed reason=unsupported_tool_output provider=codex-cli model=gpt-6.1-terra inputTokens=11 outputTokens=3']);
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test('a database binary found only on the caller PATH is resolved once and used for both the version check and the spawn',{skip:surrealSkip},async t=>{
 const root=await fixtures(t);
 const binDir=join(root,'surrealbin');await mkdir(binDir,{recursive:true});
 const binary=await install(binDir,'surreal',standInSurreal(realSurreal()));
 const missing=join(root,'claude','claude');
 const {output,code}=await runScript(t,['--provider','claude','--cli',missing],{MASSION_CLAUDE_CLI_COMMAND:missing,MASSION_CODEX_CLI_COMMAND:join(root,'codex-not-installed'),MASSION_SURREAL_BINARY:undefined,PATH:binDir+':/usr/bin:/bin'});
 assert.notEqual(code,0);
 assert.ok(output.includes('(surreal '+binary+', '),'the resolved absolute path is printed in the step line: '+output);
 assert.match(output,/STEP 2 host: ok/,'the database actually started under the restricted child PATH');
 assert.match(output,/claude-code-cli: absent/);
 assert.match(output,/STEP [0-9]+ subscription-connection: STOPPED/);
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test('without --provider a provider whose login is not detected is skipped while the detected one answers',{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 const cli=await install(root,'claude',standIn('claude','ok'));
 const missing=join(root,'codex-not-installed');
 const {output,code}=await runScript(t,[],{MASSION_CLAUDE_CLI_COMMAND:cli,MASSION_CODEX_CLI_COMMAND:missing});
 assert.equal(code,0,output);
 assert.match(output,/PROVIDER codex-cli: skipped \(login absent/,'the not-detected provider is skipped, not selected');
 assert.doesNotMatch(output,/PROVIDER-RUN codex-cli[\s\S]*profiles/,'no profiles request is sent for the skipped provider');
 assert.match(output,/ANSWER 42/);
 assert.match(output,/RESULT answered=1 stopped=0 skipped=1/);
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});
