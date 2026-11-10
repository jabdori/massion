import {AppsService} from '../../src/apps.ts';
import type {AppMember} from '../../src/apps.ts';
import {GITHUB_APP} from '../../src/app-catalog.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {InMemorySecretSlots} from '../../src/secret-slots.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import type {ScreenFixture} from './fixture-host.ts';

/** Only the GitHub lifecycle is replaced; recorded background Work and self-made apps remain intact. */
export async function appLifecycleFixture(template:ScreenFixture):Promise<ScreenFixture>{
 if(!['B23','B23-github','B23-github-expired'].includes(template.screen))return template;
 const fixture=structuredClone(template),view=fixture.routes['/assistant/conversation']!.body as {feedId:string;members:AppMember[]},previous=fixture.routes['/assistant/apps']!.body as {apps:any[]};
 const github=previous.apps.find(a=>a.id==='app-github');if(!github)throw new Error('GitHub fixture package scope is missing');
 let now=github.installedAt;const store=new InMemoryStore<any>(),secrets=new InMemorySecretSlots(),service=new AppsService(store,{clock:()=>now,secrets,members:async()=>view.members});
 // Recorded versions use the bundled, executable source and the existing fixture's permission scope.
 const history=github.versions.slice().sort((a:any,b:any)=>a.index-b.index);
 for(const version of history){
  now=version.at;const pkg=structuredClone(GITHUB_APP);pkg.manifest.version=version.version;pkg.manifest.permissions=structuredClone(github.permissions);pkg.manifest.contributes=structuredClone(github.contributes);
  await service.offer({commandId:'assistant-app-fixture-version-'+version.index,pkg,origin:'catalog'});
  const decision=(await service.decisions(null)).find(d=>d.state==='open');if(decision)await service.decide({commandId:'fixture-app-approve-'+version.index,decisionId:decision.id,answer:'act'});
 }
 const app=(await service.read()).apps[0];if(!app)throw new Error('GitHub fixture installation failed');
 now=github.installedAt;
 const members=(await service.read()).availableMembers;
 await service.act({commandId:'fixture-app-bind',action:'bind-members',appId:app.id,memberIds:members.slice().reverse().map(m=>m.id)});
 await service.act({commandId:'fixture-app-reconnect',action:'reconnect',appId:app.id});
 const decision=(await service.decisions(null)).find(d=>d.state==='open'&&d.connection);if(!decision)throw new Error('GitHub fixture connection decision is missing');
 const connectionId='fixture-app-save';await service.connect({commandId:connectionId,decisionId:decision.id,token:'app-lifecycle-fixture-private-token'});
 if(fixture.screen==='B23-github-expired')await service.expireCredential({commandId:'assistant-app-fixture-expired',appId:app.id,connectionId});
 validateMissionJournalLineage(store.inspect());
 const read=await service.read(),rail=await service.rail();
 fixture.routes['/assistant/apps']={status:200,body:{feedId:view.feedId,...read,apps:[...read.apps,...previous.apps.filter(a=>a.id!==app.id)]}};
 for(const [path,response] of Object.entries(fixture.routes))if(path.startsWith('/assistant/conversation')){
  const body=response.body as {apps?:{id:string}[]};body.apps=[...rail,...(body.apps??[]).filter(a=>a.id!==app.id)];
 }
 fixture.gaps=fixture.gaps.filter(g=>!/Installed app members are not exposed|Per-member contribution bindings|Token permission labels|AppsService.act\(\) has no token reconnect/.test(g));
 fixture.description='App settings from production install, member binding, secret storage and exact expiry commands; unrelated recorded background retained.';
 const evidence='scripts/ui-contracts/app-lifecycle-fixtures.ts: AppsService commands and validated app journal; InMemorySecretSlots only';if(!fixture.reuse.includes(evidence))fixture.reuse.push(evidence);
 return fixture;
}
