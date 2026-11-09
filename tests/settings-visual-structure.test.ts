import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import type {ScreenFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

async function fixture(screen:string,setup?:(f:ScreenFixture)=>void){
 const f=await loadFixture(screen);setup?.(f);const posts:string[]=[],app=harness(async(path,options)=>{if(options?.method==='POST'){posts.push(path);return reply({status:'committed'});}const route=f.routes[path];return route?reply(route.body,route.status):reply({},404);});
 await settle();await app.node('me-settings').fire('click');await settle();return {f,app,posts};
}
const byId=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id)!;
function descendants(node:Node):Node[]{return node.children.flatMap(child=>[child,...descendants(child)]);}

test('connection maintenance replaces the credential subline and uses the matching action',async()=>{
 for(const [screen,text] of [['B14-restart','다시 시작 필요'],['B14-update','업데이트 필요']]){
  const {f,app,posts}=await fixture(screen!);await app.node('settings-nav-connections').fire('click');await settle();
  const target=(f.routes['/connections']!.body as any).connections.find((c:any)=>c.providerType==='codex-cli'),control=byId(app,(screen==='B14-restart'?'settings-connection-restart-':'settings-connection-recheck-')+target.id);assert.ok(control);
  const row=control.parentElement!,subline=row.children[0]!.children[1]!;assert.equal(subline.textContent,text);assert.ok(!row.children.slice(1).some(n=>n.textContent===text));
  if(screen==='B14-restart'){assert.equal(control.textContent,'다시 시작');assert.equal(control.disabled,true);await control.fire('click');assert.equal(posts.length,0,'no restart executor is fabricated');}
 }
});

test('member header keeps activity metadata under the name beside the avatar',async()=>{
 const {f,app}=await fixture('B19-juno');await app.node('settings-nav-members').fire('click');await settle();
 const member=(f.routes['/assistant/members']!.body as any).members.find((m:any)=>m.name==='주노');await byId(app,'settings-member-'+member.id).fire('click');
 const heading=app.all().find(n=>n.tagName==='H2'&&n.textContent==='주노')!,name=heading.parentElement!;
 assert.ok(name.textContent.includes('일 0개 · 예약 0개'));assert.notEqual(name.className,'set-head');assert.ok(!app.node('settings-members-body').textContent.match(/\([월화수목금토일]\)/));
 assert.ok(!app.node('settings-members-body').textContent.includes('사용 불가'),'missing member-bound producers do not add capability placeholder cards');
});

test('archived member rows retain the avatar, archive date and completed-work count',async()=>{
 const {f,app}=await fixture('B13');await app.node('settings-nav-members').fire('click');await settle();
 const archived=(f.routes['/assistant/members']!.body as any).archived[0];assert.match(archived.name,/^[가-힣]+$/);
 const label=app.all().find(n=>n.tagName==='STRONG'&&n.textContent===archived.name)!,row=label.parentElement!.parentElement!;
 assert.equal(row.children[0]!.attributes.get('data-shape'),archived.look.shape);assert.match(row.textContent,/\d+월 \d+일 보관 · 완료한 일 0개/);assert.ok(descendants(row).some(n=>n.tagName==='BUTTON'&&n.textContent==='보관 해제'));
});

test('a member waiting for monthly budget is not labelled as currently working',async()=>{
 const {f,app}=await fixture('B13',f=>{const view=f.routes['/assistant/members']!.body as any,m=view.members.find((m:any)=>m.name==='퀼');m.openWorkCount=1;m.workCount=1;for(const w of (f.routes['/assistant/works']!.body as any).works)if(w.memberId===m.id){w.execution='budget-waiting';w.started=false;w.startedAt=null;w.unknown=false;if(w.steps)w.steps.done=0;}});
 await app.node('settings-nav-members').fire('click');await settle();const member=(f.routes['/assistant/members']!.body as any).members.find((m:any)=>m.name==='퀼'),row=byId(app,'settings-member-'+member.id);
 assert.ok(!row.attributes.get('aria-label')!.includes('작업 중'));assert.equal(row.children[0]!.attributes.get('data-busy'),'false');
});
