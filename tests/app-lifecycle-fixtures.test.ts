import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appLifecycleFixture} from '../scripts/ui-contracts/app-lifecycle-fixtures.ts';
import type {ScreenFixture} from '../scripts/ui-contracts/fixture-host.ts';

async function template(screen:string):Promise<ScreenFixture>{
 const raw=JSON.parse(await readFile(new URL('../scripts/ui-contracts/fixtures/'+screen+'.json',import.meta.url),'utf8'));
 if(!raw.extends)return raw;
 const parent=await template(raw.extends);return {...parent,...raw,routes:{...parent.routes,...raw.routes}};
}

test('app lifecycle fixtures derive binding and credential reads from commands and preserve backgrounds',async()=>{
 for(const screen of ['B23','B23-github','B23-github-expired']){
  const original=await template(screen),before=structuredClone(original),fixture=await appLifecycleFixture(original),read=fixture.routes['/assistant/apps']!.body as any;
  assert.deepEqual(original,before,'template is not mutated');
  const github=read.apps.find((a:any)=>a.id==='app-github');
  assert.deepEqual(github.members,[{id:'member-juno',name:'주노'},{id:'member-quill',name:'퀼'}]);
  assert.deepEqual(github.memberIds,['member-juno','member-quill']);
  assert.equal(github.credential.state,screen==='B23-github-expired'?'expired':'saved');assert.equal(github.credential.slot,'github-token');assert.ok(github.credential.connectionId);
  assert.deepEqual(read.catalog.filter((c:any)=>c.available).map((c:any)=>[c.id,c.installed]),[['github',true]]);
  const unavailable=read.catalog.filter((c:any)=>!c.available);assert.equal(unavailable.length,6);assert.ok(unavailable.every((c:any)=>c.installed===false));
  for(const [path,response] of Object.entries(before.routes))if(path!=='/assistant/apps'&&!path.startsWith('/assistant/conversation'))assert.deepEqual(fixture.routes[path],response,path);
  for(const [path,response] of Object.entries(before.routes))if(path.startsWith('/assistant/conversation')){
   const {apps:oldApps,...oldBody}=response.body as any,{apps:newApps,...newBody}=fixture.routes[path]!.body as any;assert.deepEqual(newBody,oldBody,path);assert.ok(newApps.some((a:any)=>a.id===github.id));
  }
  assert.ok(!fixture.gaps.some(g=>/not exposed by AppsService.read|Per-member contribution|Token permission labels|no token reconnect/.test(g)));
  assert.ok(!JSON.stringify(fixture).includes('app-lifecycle-fixture-private-token'));
  assert.ok(fixture.reuse.some(r=>r.includes('app-lifecycle-fixtures.ts')));
 }
});

test('app lifecycle generator leaves other screens untouched and retains the recommendation gap',async()=>{
 const other=await template('B24-connect');assert.equal(await appLifecycleFixture(other),other);
 const fixture=await appLifecycleFixture(await template('B23'));assert.ok(fixture.gaps.some(g=>g.includes('six other recommended apps')));
});
