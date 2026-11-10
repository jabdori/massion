import test from 'node:test';
import assert from 'node:assert/strict';
import {copy} from '../src/ui-copy.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {harness,reply,settle} from './support/workbench-client.ts';

for(const screen of ['B23-github','B23-github-expired'])test(screen+' renders production-approved versions without unsupported settings controls',async()=>{
 const fixture=await loadFixture(screen),posted:any[]=[];
 const app=harness(async(path,options)=>{
  if(path==='/assistant/apps'&&options?.method==='POST'){posted.push(JSON.parse(options.body));return reply({status:'committed',revision:2});}
  const route=fixture.routes[path]??fixture.routes[path.split('?')[0]!];
  return route?reply(structuredClone(route.body),route.status):reply({error:'Not configured'},503);
 });
 await settle();await app.node('me-settings').fire('click');await settle();
 await app.node('settings-nav-apps').fire('click');await settle();
 const body=app.node('settings-apps-body');
 assert.equal(body.children.some(n=>n.tagName==='H3'&&n.textContent===copy('settings.heading.13')),false,'the installed host catalog leaves nothing to recommend');
 await app.all().find(n=>n.id==='settings-app-app-github')!.fire('click');await settle();
 assert.equal(body.children.some(n=>n.tagName==='H3'&&n.textContent===copy('settings.heading.04')),true);
 assert.deepEqual(app.all().filter(n=>n.className==='set-version').map(n=>n.textContent),['1.4.0','1.3.2']);
 assert.equal(app.all().some(n=>n.type==='checkbox'||n.id==='settings-app-bind-members'),false);
 const reconnect=app.all().find(n=>n.id==='settings-app-reconnect');
 assert.equal(!!reconnect,screen==='B23-github-expired');
 if(reconnect){assert.equal(reconnect.disabled,false);assert.ok(reconnect.className.split(' ').includes('secondary'));}
 const rollback=app.all().find(n=>n.tagName==='BUTTON'&&n.textContent===copy('settings.button.13'))!;
 assert.ok(rollback,'the approved previous version has a rollback action');
 await rollback.fire('click');await settle();
 assert.equal(posted.length,1);assert.equal(posted[0].action,'rollback');assert.equal(posted[0].appId,'app-github');assert.equal(posted[0].version,1);
});
