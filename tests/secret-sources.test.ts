import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OnePasswordVault,SecretSourceError,validateSecretSource,sourceHash} from '../src/secret-sources.ts';
import {SourceSecretSlots} from '../src/source-secret-slots.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {InMemoryStore} from '../src/storage.ts';
import {PermissionsService} from '../src/permissions.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

async function vendor(t:test.TestContext,script:string){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'massion-vault-')));t.after(()=>rm(dir,{recursive:true,force:true}));
 const binary=join(dir,'op');await writeFile(binary,'#!'+process.execPath+'\n'+script,{mode:0o700});
 return {binary,account:'fixture-account',configDirectory:dir,sessionEnvironment:'FIXTURE_SESSION'};
}
const error=(code:string)=>(e:unknown)=>e instanceof SecretSourceError&&e.code===code&&!e.cause&&!String(e.stack).includes('private-vendor');

test('fake vendor receives a reference as one argv, only explicit session environment, no stdin; output never becomes diagnostics',async t=>{
 const reference='op://vault/item $(touch nope)/password';
 const config=await vendor(t,`const a=process.argv.slice(2);if(a.at(-1)!==${JSON.stringify(reference)}||a.at(-2)!=='--'||!a.includes('--cache=false')||!a.includes('--no-newline'))process.exit(2);if(Object.keys(process.env).filter(k=>k!=='__CF_USER_TEXT_ENCODING').sort().join(',')!=='OP_BIOMETRIC_UNLOCK_ENABLED,OP_SESSION'||process.env.OP_BIOMETRIC_UNLOCK_ENABLED!=='false'||process.env.OP_SESSION!=='fake-session')process.exit(3);let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{if(input)process.exit(4);process.stdout.write('fixture-value');});`);
 const vault=new OnePasswordVault(config,name=>{assert.equal(name,'FIXTURE_SESSION');return 'fake-session';});
 assert.equal(await vault.read(reference,new AbortController().signal),'fixture-value');
 assert.doesNotMatch(JSON.stringify(vault),/fake-session|fixture-value/);
});

test('fake vendor failures fail closed with typed, sanitized state',async t=>{
 for(const [message,code] of [['vault is locked','needs-owner-unlock'],['session expired','needs-owner-unlock'],['item not found','reference-not-found'],['permission denied','permission-denied'],['private-vendor-unknown','unavailable']]){
  const config=await vendor(t,`process.stderr.write(${JSON.stringify(message+' private-vendor-value')});process.exit(1);`);
  await assert.rejects(new OnePasswordVault(config,()=> 'fake-session').read('op://v/i/f'),error(code!));
 }
 const config=await vendor(t,"process.stdout.write('invalid\\nvalue');");
 await assert.rejects(new OnePasswordVault(config,()=> 'fake-session').read('op://v/i/f'),error('unavailable'));
 await assert.rejects(new OnePasswordVault(config,()=>undefined).read('op://v/i/f'),error('needs-owner-unlock'));
 await assert.rejects(new OnePasswordVault({...config,binary:join(config.configDirectory,'missing')},()=> 'fake-session').read('op://v/i/f'),error('cli-missing'));
});

test('fake vendor timeout and abort are bounded, and output overflow discards secret prefixes',async t=>{
 const config=await vendor(t,"process.stdout.write('private-vendor-prefix');setInterval(()=>{},1000);");
 await assert.rejects(new OnePasswordVault(config,()=> 'fake-session',{timeoutMs:60}).read('op://v/i/f'),error('timeout'));
 const stop=new AbortController();stop.abort();await assert.rejects(new OnePasswordVault(config,()=> 'fake-session').read('op://v/i/f',stop.signal),error('cancelled'));
 const big=await vendor(t,"process.stdout.write('x'.repeat(8192));");await assert.rejects(new OnePasswordVault(big,()=> 'fake-session').read('op://v/i/f'),error('unavailable'));
});

test('sources accept metadata only and retain exact reference identity',()=>{
 assert.deepEqual(validateSecretSource(undefined),{kind:'own'});
 const source={kind:'external-ref',vendor:'onepassword',reference:'op://v/i/password'};assert.deepEqual(validateSecretSource(source),source);
 assert.notEqual(sourceHash(source),sourceHash({...source,kind:'import'}));
 for(const bad of [{kind:'own',value:'private'}, {...source,value:'private'},{...source,reference:'--debug'}, {...source,reference:'op://v/i/f\n'}, {...source,vendor:'__proto__'}])assert.throws(()=>validateSecretSource(bad));
});

const secret={owner:'fixture-connection',slot:'password'},consumer={kind:'connection' as const,id:'connection-binding'},purpose='model-provider';
async function grant(permissions:PermissionsService,source:unknown,commandId='grant-1'){
 return permissions.act({commandId,action:'grant-secret',secret,sourceHash:sourceHash(source),consumer,purpose});
}
test('external reference requires an exact durable grant and resolves every use without persisting values',async()=>{
 const store=new InMemoryStore<any>(),permissions=new PermissionsService(store),own=new InMemorySecretSlots(),source={kind:'external-ref' as const,vendor:'onepassword' as const,reference:'op://v/i/f'};let reads=0;
 const slots=new SourceSecretSlots(own,[{secret,source}],permissions,consumer,purpose,{onepassword:{read:async()=> 'fixture-value-'+(++reads)}});
 await assert.rejects(slots.read(secret),error('grant-required'));assert.equal(reads,0);
 await Promise.all([grant(permissions,source),grant(permissions,source)]);assert.equal(store.inspect().length,1);
 assert.equal(await slots.read(secret),'fixture-value-1');assert.equal(await slots.read(secret),'fixture-value-2');assert.equal(await own.has(secret),false);
 const journal=store.inspect();validateMissionJournalLineage(journal);assert.doesNotMatch(JSON.stringify(journal),/fixture-value/);
 await permissions.act({commandId:'revoke-1',action:'revoke-secret',grantId:(await permissions.read()).secrets![0]!.id});
 await assert.rejects(slots.read(secret),error('grant-required'));assert.equal(reads,2);
});

test('import is single-use across overlap and restart; provenance has no value; ambiguous writes never repeat',async()=>{
 for(const uncertain of [false,true]){
  const store=new InMemoryStore<any>(),permissions=new PermissionsService(store),own=new InMemorySecretSlots(),source={kind:'import' as const,vendor:'onepassword' as const,reference:'op://v/i/f'};let reads=0,writes=0;
  const set=own.set.bind(own);own.set=async(s,v)=>{writes++;await set(s,v);if(uncertain)throw Error('private-vendor-value');};
  const make=()=>new SourceSecretSlots(own,[{secret,source}],permissions,consumer,purpose,{onepassword:{read:async()=>{reads++;return 'fixture-imported';}}});await grant(permissions,source);
  const both=await Promise.allSettled([make().read(secret),make().read(secret)]);
  assert.equal(writes,1);assert.equal(reads,1);
  if(uncertain){assert.ok(both.every(r=>r.status==='rejected'));await assert.rejects(make().read(secret),error('import-unavailable'));}
  else {assert.ok(both.some(r=>r.status==='fulfilled'&&r.value==='fixture-imported'));assert.equal(await make().read(secret),'fixture-imported');}
  assert.equal(writes,1);assert.equal(reads,1);validateMissionJournalLineage(store.inspect());
  assert.doesNotMatch(JSON.stringify(store.inspect()),/fixture-imported|private-vendor-value/);
 }
});

test('revocation and database replacement during a slow read discard the value',async()=>{
 for(const replace of [false,true]){
  const raw=new InMemoryStore<any>();let changed=false;const store=new Proxy(raw,{get(target,key){if(key==='readState')return async(id?:string)=>{const read=await target.readState(id);return {...read,feedId:changed?'different-feed':read.feedId};};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}}),permissions=new PermissionsService(store),source={kind:'external-ref' as const,vendor:'onepassword' as const,reference:'op://v/i/f'};
  await grant(permissions,source);const slots=new SourceSecretSlots(new InMemorySecretSlots(),[{secret,source}],permissions,consumer,purpose,{onepassword:{read:async()=>{if(replace)changed=true;else await permissions.act({commandId:'revoke',action:'revoke-secret',grantId:(await permissions.read()).secrets![0]!.id});return 'must-not-return';}}});
  await assert.rejects(slots.read(secret),error('grant-required'));
 }
});

test('different sources cannot share a writable own slot grant, and late reads cannot overwrite newer source state',async()=>{
 const store=new InMemoryStore<any>(),permissions=new PermissionsService(store),source={kind:'external-ref' as const,vendor:'onepassword' as const,reference:'op://v/i/f'};
 await grant(permissions,source);await assert.rejects(grant(permissions,{kind:'own'},'different-source'));
 let release!:(v:string)=>void,started!:()=>void,count=0;const ready=new Promise<void>(r=>{started=r;}),held=new Promise<string>(r=>{release=r;});
 const slots=new SourceSecretSlots(new InMemorySecretSlots(),[{secret,source}],permissions,consumer,purpose,{onepassword:{read:async()=>{if(++count===1){started();return held;}throw new SecretSourceError('needs-owner-unlock');}}});
 const old=slots.read(secret);await ready;await assert.rejects(slots.read(secret),error('needs-owner-unlock'));release('old-value');assert.equal(await old,'old-value');assert.equal(slots.describe(secret).state,'needs-owner-unlock');
 slots.beginDrain();await assert.rejects(slots.read(secret),error('cancelled'));assert.equal(count,2);
});
