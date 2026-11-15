import {readFile,writeFile} from 'node:fs/promises';
let s=await readFile('src/device-link.ts','utf8');
const reps=[];
const rep=(from,to)=>reps.push([from,to]);

// F5: clear a failed identity initialization so it can be retried
rep(`  async #identityLoad(){return this.#identityPromise??=(async()=>{
  let stored=await this.#secrets.read(IDENTITY_SLOT);`,
`  async #identityLoad(){return this.#identityPromise??=(async()=>{
  try{
  let stored=await this.#secrets.read(IDENTITY_SLOT);`);
rep(`  return {deviceId,fingerprint,publicKey,keyPem,certPem:selfSignedDeviceCertificate(key,deviceId,this.#clock)};
 })();}`,
`  return {deviceId,fingerprint,publicKey,keyPem,certPem:selfSignedDeviceCertificate(key,deviceId,this.#clock)};
  }catch(error){this.#identityPromise=undefined;throw error;}
 })();}`);

// F4: reschedule the listener when the last offer expires; cancel during drain
rep(` #server?:TlsServer;#syncing?:Promise<void>;#drained=false;`,
` #server?:TlsServer;#syncing?:Promise<void>;#drained=false;#expiryTimer?:NodeJS.Timeout;`);
rep(`   if(!want){if(this.#server){this.#server.close();this.#server=undefined;this.#advertised=[];}return;}`,
`   if(!want){if(this.#server){this.#server.close();this.#server=undefined;this.#advertised=[];}return;}
   // The listener must close when the last live offer expires on a host with no paired devices.
   if(this.#expiryTimer)clearTimeout(this.#expiryTimer);
   const expiry=Math.min(...(state?.value.offers??[]).filter(o=>!o.used).map(o=>o.expiresAt));
   if(Number.isFinite(expiry)){const delay=Math.max(0,expiry-now+1);this.#expiryTimer=setTimeout(()=>{this.#expiryTimer=undefined;void this.#syncListener().catch(()=>{});},delay);this.#expiryTimer.unref?.();}`);
rep(` async drain(){this.#drained=true;this.beginDrain();`,
` async drain(){this.#drained=true;if(this.#expiryTimer){clearTimeout(this.#expiryTimer);this.#expiryTimer=undefined;}this.beginDrain();`);

// F1: keep the initiating device's advertised address candidates
rep(`  const reply=await this.#exchange(attempt.socket,{kind:'pair-request',code:attempt.code,peer:{...attempt.publicInfo,addresses:[attempt.address]},grants:attempt.grants},this.#offerTtl,message=>message?.kind==='pair-complete'||message?.kind==='pair-rejected');`,
`  const reply=await this.#exchange(attempt.socket,{kind:'pair-request',code:attempt.code,peer:attempt.publicInfo,grants:attempt.grants},this.#offerTtl,message=>message?.kind==='pair-complete'||message?.kind==='pair-rejected');`);

// F3: reuse the live link instead of leaking the previous socket
rep(` #links=new Map<string,TLSSocket>();#accepted=new Set<TLSSocket>();`,
` #links=new Map<string,TLSSocket>();#versions=new Map<string,number>();#accepted=new Set<TLSSocket>();`);
rep(`    this.#links.set(deviceId,live);live.on('close',()=>{if(this.#links.get(deviceId)===live)this.#links.delete(deviceId);});
    live.on('error',()=>live.destroy());
    await this.#observe(deviceId,'connected',undefined,address);return {address,version:link.version!};`,
`    this.#links.set(deviceId,live);this.#versions.set(deviceId,link.version!);live.on('close',()=>{if(this.#links.get(deviceId)===live){this.#links.delete(deviceId);this.#versions.delete(deviceId);}});
    live.on('error',()=>live.destroy());
    await this.#observe(deviceId,'connected',undefined,address);return {address,version:link.version!};`);
rep(`  let lastCause:LinkCause|undefined;
  for(const address of peer.addresses){`,
`  const existing=this.#links.get(deviceId);
  if(existing&&!existing.destroyed)return {address:peer.lastAddress??peer.addresses[0]!,version:this.#versions.get(deviceId)??1};
  let lastCause:LinkCause|undefined;
  for(const address of peer.addresses){`);
rep(`  this.#links.get(v.deviceId)?.destroy();this.#links.delete(v.deviceId);await this.#observe(v.deviceId,'offline');return {commandId,status:'offline' as const};`,
`  this.#links.get(v.deviceId)?.destroy();this.#links.delete(v.deviceId);this.#versions.delete(v.deviceId);await this.#observe(v.deviceId,'offline');return {commandId,status:'offline' as const};`);

// F2: reject supplied malformed grants; default only when absent
rep(`function offerCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['commandId','name','addresses','grants'].includes(k))&&commandId,'Exact pairing offer command required');return {commandId,name:label(v.name)?v.name:hostname(),addresses:addresses(v.addresses)?[...v.addresses]:[],grants:grants(v.grants)?structuredClone(v.grants):{...DEFAULT_DEVICE_GRANTS}};}`,
`function grantsOf(v:Record<string,unknown>):DeviceGrants {if(v.grants===undefined)return {...DEFAULT_DEVICE_GRANTS};ensure(grants(v.grants),'Exact grants required: view, instruct, answerApprovals');return structuredClone(v.grants);}
function offerCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['commandId','name','addresses','grants'].includes(k))&&commandId,'Exact pairing offer command required');return {commandId,name:label(v.name)?v.name:hostname(),addresses:addresses(v.addresses)?[...v.addresses]:[],grants:grantsOf(v)};}`);
rep(`return {commandId,address:v.address as string,code:v.code as string,fingerprint:v.fingerprint as string,grants:grants(v.grants)?structuredClone(v.grants):{...DEFAULT_DEVICE_GRANTS},name:label(v.name)?v.name as string:hostname(),agentName:label(v.agentName)?v.agentName as string:hostname(),addresses:addresses(v.addresses)?[...v.addresses]:[]};}`,
`return {commandId,address:v.address as string,code:v.code as string,fingerprint:v.fingerprint as string,grants:grantsOf(v),name:label(v.name)?v.name as string:hostname(),agentName:label(v.agentName)?v.agentName as string:hostname(),addresses:addresses(v.addresses)?[...v.addresses]:[]};}`);

for(const [from,to] of reps){if(!s.includes(from))throw new Error('NOT FOUND: '+from.slice(0,80));s=s.replace(from,to);}
await writeFile('src/device-link.ts',s);console.log('applied',reps.length);
