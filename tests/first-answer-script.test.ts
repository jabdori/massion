import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {chmodSync,realpathSync} from 'node:fs';
import {mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
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
const standIn=(provider:'claude'|'codex',behavior:'ok'|'exit-nonzero'|'invalid-json'|'tool-call')=>[
 '#!'+process.execPath,
 'const args=process.argv.slice(2);',
 "if(args.includes('--version')){console.log("+JSON.stringify(provider==='claude'?'2.1.325 (Claude Code)':'codex-cli 0.167.1')+");process.exit(0);}",
 provider==='claude'
  ?"if(args[0]==='auth'&&args[1]==='status'){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}"
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
const install=async(root:string,name:string,source:string)=>{
 const path=join(root,name);
 await writeFile(path,source,{mode:0o755});
 chmodSync(path,0o755);
 return path;
};
const runScript=(t:test.TestContext,args:string[],environment:Record<string,string>)=>new Promise<{output:string,code:number|null}>((resolveRun,rejectRun)=>{
 const child=spawn(process.execPath,[SCRIPT,...args],{env:{...process.env,...environment}});
 let output='';
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const timer=setTimeout(()=>{child.kill('SIGKILL');rejectRun(new Error('scripts/first-answer.ts timed out after 150s'));},150000);
 t.after(()=>{clearTimeout(timer);child.kill('SIGKILL');});
 child.on('error',error=>{clearTimeout(timer);rejectRun(error);});
 child.on('close',code=>{clearTimeout(timer);resolveRun({output,code});});
});
/** Both providers pinned: the stand-in under test, and a missing path for the other one. */
const pinEnvironment=(root:string,provider:'claude'|'codex',cli:string)=>provider==='claude'
 ?{MASSION_CLAUDE_CLI_COMMAND:cli,MASSION_CODEX_CLI_COMMAND:join(root,'codex-not-installed')}
 :{MASSION_CODEX_CLI_COMMAND:cli,MASSION_CLAUDE_CLI_COMMAND:join(root,'claude-not-installed')};
const leftovers=async()=>(await readdir(realpathSync(tmpdir()))).filter(name=>name.startsWith('massion-first-answer-')).sort();
const everyStepOk=(output:string)=>{for(const step of ['database','host','daemon-secret','discover-logins','subscription-connection','first-message','answer'])assert.match(output,new RegExp('STEP [0-9]+ '+step+': ok'),output);};

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
 assert.match(output,/USAGE inputTokens=9 knownOutputTokens=3/);
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});

test('a stand-in codex CLI answers the first question through every step',{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 const cli=await install(root,'codex',standIn('codex','ok'));
 const {output,code}=await runScript(t,['--provider','codex','--cli',cli],pinEnvironment(root,'codex',cli));
 everyStepOk(output);
 assert.equal(code,0,output);
 assert.match(output,/ANSWER 42/);
 assert.match(output,/PROVIDER codex-cli/);
 assert.match(output,/MODEL gpt-6.1-terra/);
 assert.match(output,/USAGE inputTokens=11 knownOutputTokens=3/);
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
 assert.match(output,/STEP [0-9]+ subscription-connection: STOPPED/);
 assert.match(output,/"providerType":"claude-code-cli","kind":"cli-login","status":"absent"/,'the verbatim GET /connections body shows the product status');
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
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
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

test('a CLI that reports a tool call stops at the answer step',{skip:surrealSkip||macSkip},async t=>{
 const root=await fixtures(t);
 const cli=await install(root,'codex',standIn('codex','tool-call'));
 const {output,code}=await runScript(t,['--provider','codex','--cli',cli],pinEnvironment(root,'codex',cli));
 assert.notEqual(code,0);
 assert.match(output,/STEP [0-9]+ first-message: STOPPED/);
 assert.match(output,/turn status failed/);
 assert.match(output,/processes-remaining: 0/);
 assert.deepEqual(await leftovers(),[],'the run folder was removed');
});
