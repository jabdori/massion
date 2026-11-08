import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {SCHEMA_QUERY,initializeSurrealSchema,assertStorageVersion,createHttpRpcTransport,StorageQueryError,StorageContentionError,StorageProtocolError,SurrealStore} from '../src/storage.ts';

test('startup abort fences schema submission and late acknowledgement',async()=>{
 const abort=new AbortController();abort.abort();let writes=0;
 await assert.rejects(initializeSurrealSchema({query:async()=>{writes++;return [true];}},abort.signal),{name:'AbortError'});
 assert.equal(writes,0);
 const late=new AbortController();
 await assert.rejects(initializeSurrealSchema({query:async()=>{writes++;late.abort();return [true];}},late.signal),{name:'AbortError'});
 assert.equal(writes,1);
});

test('lost migration response or overlapping initializer reads committed version once without resubmission',async()=>{
 for(const error of [new Error('lost ACK'),new StorageContentionError('overlap')]){
  let writes=0,reads=0;
  await initializeSurrealSchema({query:async sql=>{
   if(sql===SCHEMA_QUERY){writes++;throw error;}reads++;
   return [{storageVersion:1,schemaVersion:2,feedId:'original-feed'}];
  }});
  assert.equal(writes,1);assert.equal(reads,1);
 }
});

test('unconfirmed migration is not retried or treated as an open database',async()=>{
 for(const result of [null,{storageVersion:0},{storageVersion:2},{storageVersion:1,schemaVersion:2}]){
  let writes=0,reads=0;
  await assert.rejects(initializeSurrealSchema({query:async sql=>{
   if(sql===SCHEMA_QUERY){writes++;throw new Error('lost ACK');}reads++;return [result];
  }}),/unconfirmed|unknown/i);
  assert.equal(writes,1);assert.equal(reads,1);
 }
 let calls=0;
 await assert.rejects(initializeSurrealSchema({query:async()=>{calls++;throw new StorageQueryError('newer schema');}}),/newer schema/);
 assert.equal(calls,1);
});

test('failed schema readback retains original connection/HTTP failure and both causes without retry',async()=>{
 for(const original of [new TypeError('connect ECONNREFUSED'),new StorageProtocolError('SurrealDB HTTP status 403'),new Error('write response lost')]){
  const readback=new TypeError('readback connection refused');let calls=0;
  await assert.rejects(initializeSurrealSchema({query:async()=>{throw ++calls===1?original:readback;}}),error=>{
   assert.ok(error instanceof Error);assert.ok(error.message.includes(original.message));assert.ok(error.message.includes(readback.message));
   assert.ok(error.cause instanceof AggregateError);assert.deepEqual(error.cause.errors,[original,readback]);return true;
  });assert.equal(calls,2);
 }
 const original=new Error('write response lost');let calls=0;
 await assert.rejects(initializeSurrealSchema({query:async()=>{if(++calls===1)throw original;return [null];}}),error=>{
  assert.ok(error instanceof Error);assert.match(error.message,/unconfirmed/);assert.equal(error.cause,original);return true;
 });assert.equal(calls,2);
});

test('read-only export compatibility accepts legacy/current markers and refuses malformed or future schemas',async()=>{
 for(const feed of [{schemaVersion:2},{schemaVersion:2,storageVersion:0},{schemaVersion:2,storageVersion:1},null,
  ...[2,-1,0.5,null,'1',true].map(storageVersion=>({schemaVersion:2,storageVersion})),{schemaVersion:3,storageVersion:1}]){
  let calls=0;const check=assertStorageVersion({query:async sql=>{calls++;assert.match(sql,/^RETURN SELECT /);assert.doesNotMatch(sql,/DEFINE|UPDATE|CREATE/);return [feed];}});
  if(feed&&feed.schemaVersion===2&&(!('storageVersion' in feed)||feed.storageVersion===0||feed.storageVersion===1))await check;
  else await assert.rejects(check,/Unsupported storage schema version/);
  assert.equal(calls,1);
 }
});

const endpoint=process.env.MASSION_TEST_SURREAL_RPC;
async function database(){
 const namespace='schema_'+randomUUID().replaceAll('-','');
 const admin=createHttpRpcTransport({endpoint:endpoint!,namespace:'massion_storage_tests',database:'massion_storage_tests'});
 await admin.query(`DEFINE NAMESPACE ${namespace}; USE NS ${namespace}; DEFINE DATABASE isolated;`,{});
 return createHttpRpcTransport({endpoint:endpoint!,namespace,database:'isolated'});
}
const contents=`RETURN {schema:(INFO FOR DB),feed:(SELECT * FROM massion_feed),settings:(SELECT * FROM massion_host_settings),
 states:(SELECT * FROM massion_state),operations:(SELECT * FROM massion_operation),audits:(SELECT * FROM massion_audit),events:(SELECT * FROM massion_event),outbox:(SELECT * FROM massion_outbox)};`;

test('actual schema upgrades legacy metadata once, preserves settings and feed identity, and refuses future/malformed versions atomically',{skip:!endpoint},async()=>{
 const transport=await database();
 await transport.query(await readFile(new URL('./fixtures/schema-v0.surql',import.meta.url),'utf8'),{feedId:'original-feed'});
 await transport.query("CREATE massion_host_settings:local CONTENT {revision:7,value:{name:'Retained settings'}};",{});
 const before=(await transport.query(contents,{}))[0] as any;
 await initializeSurrealSchema(transport);
 const after=(await transport.query(contents,{}))[0] as any;
 assert.equal(after.feed[0].storageVersion,1);assert.equal(after.feed[0].feedId,'original-feed');
 delete after.feed[0].storageVersion;assert.deepEqual(after,before);
 await initializeSurrealSchema(transport);
 const current=await transport.query(contents,{});
 await initializeSurrealSchema(transport);assert.deepEqual(await transport.query(contents,{}),current);
 for(const version of [2,-1,0.5,'1',null]){
  await transport.query('UPDATE massion_feed:global SET storageVersion=$version;',{version});
  const original=await transport.query(contents,{});
  await assert.rejects(initializeSurrealSchema(transport),/storage schema version/i);
  assert.deepEqual(await transport.query(contents,{}),original);
 }
});

test('actual forward step creates missing legacy identity, rolls back on failure, and opens concurrently without changing data',{skip:!endpoint},async()=>{
 const transport=await database();
 await transport.query(await readFile(new URL('./fixtures/schema-v0.surql',import.meta.url),'utf8'),{feedId:'legacy'});
 await transport.query('UPDATE massion_feed:global UNSET feedId;',{});
 const before=await transport.query(contents,{});
 await assert.rejects(initializeSurrealSchema({query:(sql,vars)=>transport.query(sql.replace('RETURN true;',"THROW 'injected migration failure';"),vars)}),StorageQueryError);
 assert.deepEqual(await transport.query(contents,{}),before);
 await Promise.all([initializeSurrealSchema(transport),initializeSurrealSchema(transport)]);
 const feed=(await transport.query('SELECT * FROM ONLY massion_feed:global;',{}))[0] as any;
 assert.equal(feed.storageVersion,1);assert.ok(feed.feedId);
 const empty=await database();await initializeSurrealSchema(empty);
 assert.equal((await empty.query('RETURN massion_feed:global.storageVersion;',{}))[0],1);
 assert.deepEqual(await new SurrealStore(empty).exportJournal(),{schemaVersion:2,head:0,operations:[]});
});

test('actual explicit version zero upgrades but current version without identity refuses unchanged',{skip:!endpoint},async()=>{
 const transport=await database();
 await transport.query(await readFile(new URL('./fixtures/schema-v0.surql',import.meta.url),'utf8'),{feedId:'explicit-zero-feed'});
 await transport.query('UPDATE massion_feed:global SET storageVersion=0;',{});
 await initializeSurrealSchema(transport);
 assert.equal((await transport.query('RETURN massion_feed:global.storageVersion;',{}))[0],1);
 assert.equal((await transport.query('RETURN massion_feed:global.feedId;',{}))[0],'explicit-zero-feed');
 await transport.query('UPDATE massion_feed:global UNSET feedId;',{});
 const before=await transport.query(contents,{});
 await assert.rejects(initializeSurrealSchema(transport),/Storage feed identity is not initialized/);
 assert.deepEqual(await transport.query(contents,{}),before);
});
