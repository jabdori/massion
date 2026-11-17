import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {installCheckContamination,installCheckKeys,installCheckStatus} from '../install-check.ts';

const facts=()=>({
 schema:1,
 appVersion:'1.0.0-rc.1',
 nodeVersion:'24.19.0',
 surrealVersion:'4.0.1',
 coreState:'running',
 databaseState:'running',
 databaseTls:true,
 secretRequired:true,
 feedSubscribed:true,
 connectRetries:2,
 databaseRequests:3,
 databaseRequestTotalMs:417,
 startToReadyMs:6543,
});

test('the status file is exactly the closed key list with typed values',()=>{
 const text=installCheckStatus(facts());
 const parsed=JSON.parse(text);
 assert.deepEqual(Object.keys(parsed),[...installCheckKeys]);
 assert.equal(parsed.connectRetries,2);
 assert.equal(parsed.feedSubscribed,true);
 assert.equal(text.endsWith('\n'),true);
});

test('a key outside the closed list is refused',()=>{
 assert.throws(()=>installCheckStatus({...facts(),feedResubscriptions:1}),/closed list/);
 const missing={...facts()} as Record<string,unknown>;
 delete missing.connectRetries;
 assert.throws(()=>installCheckStatus(missing),/closed list/);
});

test('wrong types and free-form strings are refused',()=>{
 assert.throws(()=>installCheckStatus({...facts(),feedSubscribed:'yes'}),/boolean/);
 assert.throws(()=>installCheckStatus({...facts(),connectRetries:-1}),/non-negative integer/);
 assert.throws(()=>installCheckStatus({...facts(),connectRetries:1.5}),/non-negative integer/);
 assert.throws(()=>installCheckStatus({...facts(),coreState:'exploded'}),/coreState/);
 assert.throws(()=>installCheckStatus({...facts(),databaseState:'ok'}),/databaseState/);
 assert.throws(()=>installCheckStatus({...facts(),appVersion:'/Users/me'}),/version-like/);
 assert.throws(()=>installCheckStatus({...facts(),surrealVersion:'4.0.1 /Users/me'}),/version-like/);
 assert.throws(()=>installCheckStatus({...facts(),schema:2}),/schema/);
});

test('a valid file carries no secret and no home path in its bytes',()=>{
 const text=installCheckStatus(facts());
 assert.equal(installCheckContamination(text,[]),undefined);
});

test('the contamination scan finds secrets, key material and home paths',()=>{
 const secret=randomBytes(32).toString('hex'),password=randomBytes(32).toString('hex');
 assert.match(installCheckContamination('log line '+secret,[secret]) ?? '',/secret value/);
 assert.match(installCheckContamination('value '+password,[password]) ?? '',/secret value/);
 assert.match(installCheckContamination('-----BEGIN PRIVATE KEY-----x',[]) ?? '',/key material/);
 assert.match(installCheckContamination('failed in /Users/runner/work/x',[]) ?? '',/home-directory path/);
 assert.match(installCheckContamination('tmp /home/runner/x',[]) ?? '',/home-directory path/);
 assert.equal(installCheckContamination('plain line',[undefined,'']) ,undefined);
});
