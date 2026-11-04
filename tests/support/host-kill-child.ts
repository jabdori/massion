import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {join,resolve,basename} from 'node:path';
import {SurrealStore,createHttpRpcTransport} from '../../src/storage.ts';
import type {Mission} from '../../src/domain.ts';
import type {CommitInput} from '../../src/storage.ts';
import {OpenAICompatibleChatAdapter} from '../../src/http-provider.ts';
import {ConfiguredTextRuntime} from '../../src/configured-runtime.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {ProviderRegistry} from '../../src/providers.ts';
import {createWorkbench} from '../../src/server.ts';
assert.ok(process.connected&&process.send,'Fixture must be started as an owned IPC child');
assert.match(basename(process.cwd()),/^massion-owned-host-kill-/);
assert.equal(resolve(process.argv[2]!),join(process.cwd(),process.argv[2]!.endsWith('restart-config.json')?'restart-config.json':'config.json'));
const config=JSON.parse(await readFile(process.argv[2]!,'utf8'));
assert.match(config.database.database,/^hostkill_[a-f0-9]{32}$/);
assert.equal(new URL(config.provider).hostname,'127.0.0.1');
assert.equal(new URL(config.provider).protocol,'http:');
async function pause(boundary:string,input:CommitInput<Mission>){
 process.send?.({type:'boundary',boundary,pid:process.pid});
 await new Promise<void>(()=>{});
}
class PausedStore extends SurrealStore<Mission>{
 override async commit(input:CommitInput<Mission>){
  const event=(input.events[0] as {command?:{type?:string;effect?:{id:string};effectId?:string}}|undefined)?.command;
  const executor=event?.effect?.id==='run:executor'||event?.effectId==='run:executor';
  if(!config.restarted){
   if(config.stage==='before-admission'&&event?.type==='admit-effect'&&executor)await pause('before-effect-admission',input);
   if(config.stage==='before-receipt'&&event?.type==='receipt'&&executor)await pause('provider-returned-before-receipt',input);
   if(config.stage==='artifact-before-receipt'&&event?.type==='receipt'&&event.effectId==='run:artifact')await pause('artifact-written-before-receipt',input);
  }
  const result=await super.commit(input);
  if(!config.restarted){
   if(config.stage==='after-admission'&&event?.type==='admit-effect'&&executor)await pause('effect-admitted-before-invocation',input);
   if(config.stage==='after-receipt'&&event?.type==='receipt'&&executor)await pause('receipt-committed-before-next-stage',input);
  }
  return result;
 }
}
const store=new PausedStore(createHttpRpcTransport(config.database));
function adapter(model:string){return new OpenAICompatibleChatAdapter({provider:'kill-fixture',model,configVersion:'v1',endpoint:config.provider,enabled:true,transportMode:'local-http-mock',bounds:{maxInputBytes:32768,maxOutputTokens:8,maxResponseBytes:65536,timeoutMs:30000},authorization:{provider:'kill-fixture',model,configVersion:'v1',endpoint:config.provider,maxInputBytes:32768,maxOutputTokens:8},transport:fetch});}
const executor=adapter('executor'),verifier=adapter('verifier');
const runtime=new ConfiguredTextRuntime(store,{enabled:!config.restarted,outputTokenCap:8,authorization:config.restarted?undefined:{id:'fixture-grant',scope:'host-kill',mode:'mock-http',executor:executor.descriptor,verifier:verifier.descriptor,maxOutputTokensPerCall:8},executor:{identity:'fixture-executor',adapter:executor},verifier:{identity:'fixture-verifier',adapter:verifier},artifacts:new TextArtifactStore(join(process.cwd(),'artifacts'))});
const server=createWorkbench(store,process.cwd(),{providers:new ProviderRegistry([executor,verifier]),runtime});
server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();if(!address||typeof address!=='object')throw Error('Missing address');
process.send?.({type:'ready',pid:process.pid,cwd:process.cwd(),base:'http://127.0.0.1:'+address.port,restarted:config.restarted,grantEnabled:!config.restarted});
function close(){server.closeAllConnections();server.close(()=>process.exit(0));}
process.on('SIGTERM',close);process.on('disconnect',close);
