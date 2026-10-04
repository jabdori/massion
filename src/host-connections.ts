/** Explicit owner-selected host bindings. No credential search, persistence or startup sends. */
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {DomainError,hash} from './domain.ts';
import {boundedPlainJson} from './bounded-json.ts';
import {ConnectionWorkbench,MODEL_PROVIDER_TYPES} from './connection-workbench.ts';
import type {ConnectionInput,HostConnectionBindings} from './connection-workbench.ts';
import type {CredentialResolver} from './chat-profile-factory.ts';
import {validateModelEndpoint} from './native-model-providers.ts';
import type {HttpProviderTransport} from './http-provider.ts';
import type {Store} from './storage.ts';
import type {Mission} from './domain.ts';
import type {TextArtifactStore} from './text-artifacts.ts';

interface HostConnection {
 id:string;label:string;providerType:ConnectionInput['providerType'];baseUrl:string;models:string[];
 credential?:{ref:string;environment:string};
}
export interface HostManifest {version:1;revision:string;mode:ConnectionInput['mode'];connections:HostConnection[]}
export interface HostStartup {manifest?:HostManifest;allowLiveExecution:boolean}
function requireHost(condition:unknown,message:string):asserts condition {if(!condition)throw new DomainError('Host configuration: '+message);}
function fields(value:unknown,required:string[],optional:string[]=[]):asserts value is Record<string,unknown> {
 requireHost(!!value&&typeof value==='object'&&!Array.isArray(value),'object required');
 requireHost(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>[...required,...optional].includes(k)),'unsupported or missing fields; no raw secrets allowed');
}
function identity(value:unknown):asserts value is string {requireHost(typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,64}$/.test(value),'invalid identity or revision');}
function label(value:unknown):asserts value is string {requireHost(typeof value==='string'&&value.length>0&&value.length<=512&&value.trim()===value&&!/[\u0000-\u001f\u007f]/.test(value),'invalid connection label');}

/** Validate the entire non-secret schema before touching a database, network or value source. */
export function parseHostManifest(value:unknown):HostManifest {
 boundedPlainJson(value);fields(value,['version','revision','mode','connections']);
 requireHost(value.version===1,'unsupported version');identity(value.revision);
 requireHost(value.mode==='https'||value.mode==='local-http-mock','invalid transport mode');
 requireHost(Array.isArray(value.connections)&&value.connections.length>0&&value.connections.length<=32,'1 to 32 connections required');
 const ids=new Set<string>(),references=new Set<string>();let modelCount=0;
 for(const entry of value.connections){
  fields(entry,['id','label','providerType','baseUrl','models'],['credential']);identity(entry.id);label(entry.label);
  const provider=MODEL_PROVIDER_TYPES.find(p=>p.id===entry.providerType);requireHost(provider,'unsupported provider');
  requireHost(typeof entry.baseUrl==='string'&&entry.baseUrl.endsWith('/'),'canonical base URL ending in / required');
  try{validateModelEndpoint(entry.baseUrl+'models',value.mode,'/models');}catch{throw new DomainError('Host configuration: invalid destination URL');}
  requireHost(value.mode!=='https'||provider.id==='compatible'||entry.baseUrl===provider.baseUrl,'custom destinations require the compatible provider');
  requireHost(Array.isArray(entry.models)&&entry.models.length>0,'exact models required');
  const models=new Set<string>();for(const model of entry.models){requireHost(typeof model==='string'&&/^[a-zA-Z0-9._:/-]{1,256}$/.test(model)&&(provider.id!=='gemini'||/^[a-zA-Z0-9._-]{1,128}$/.test(model)),'invalid exact model');requireHost(!models.has(model),'duplicate model');models.add(model);}
  modelCount+=models.size;requireHost(modelCount<=64,'at most 64 models allowed');requireHost(!ids.has(entry.id),'duplicate connection');ids.add(entry.id);
  if(value.mode==='https'){
   fields(entry.credential,['ref','environment']);identity(entry.credential.ref);
   requireHost(typeof entry.credential.environment==='string'&&/^[A-Z_][A-Z0-9_]{0,127}$/.test(entry.credential.environment),'explicit environment name required');
   requireHost(!references.has(entry.credential.ref),'duplicate credential reference');references.add(entry.credential.ref);
  }else requireHost(entry.credential===undefined,'fixture transport cannot carry credential bindings');
 }
 return structuredClone(value) as unknown as HostManifest;
}

/** Read only the explicitly selected regular file, without following symlinks or unbounded reads. */
export async function loadHostManifest(path:string):Promise<HostManifest> {
 let file;try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await file.stat();requireHost(stat.isFile()&&stat.size<=32768,'bounded regular file required');const bytes=Buffer.alloc(32769);let length=0;while(length<bytes.length){const read=await file.read(bytes,length,bytes.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}requireHost(length<=32768,'file byte limit exceeded');let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));}catch{throw new DomainError('Host configuration: invalid UTF-8 JSON');}return parseHostManifest(value);}catch(error){if(error instanceof DomainError)throw error;throw new DomainError('Host configuration: selected file cannot be read');}finally{await file?.close();}
}

/** Manifest selection and live capability are separate explicit startup decisions. */
export async function loadHostStartup(args:readonly string[]):Promise<HostStartup> {
 let path:string|undefined,allowLiveExecution=false;
 for(let index=0;index<args.length;index++){
  const argument=args[index];if(argument==='--host-config'){requireHost(path===undefined&&typeof args[index+1]==='string'&&!args[index+1]!.startsWith('--'),'one explicit host configuration path required');path=args[++index];}
  else if(argument==='--allow-live-model-calls'){requireHost(!allowLiveExecution,'duplicate live option');allowLiveExecution=true;}
  else throw new DomainError('Host configuration: unknown startup option');
 }
 requireHost(!allowLiveExecution||path!==undefined,'live option requires an explicit host manifest');
 const manifest=path===undefined?undefined:await loadHostManifest(path);
 requireHost(!allowLiveExecution||manifest?.mode==='https','live option requires an HTTPS manifest');
 return {manifest,allowLiveExecution};
}

/** Compile immutable identity/destination bindings; construction never calls the supplied accessor. */
export function compileHostBindings(manifest:HostManifest,readEnvironment:(name:string)=>string|undefined) {
 const snapshot=parseHostManifest(manifest),bindingHash=hash(snapshot);
 const entries:HostConnectionBindings['connections']=[];
 const permitted=new Map<string,string>();
 const key=(ref:string,profileId:string,endpoint:string)=>JSON.stringify([ref,profileId,endpoint]);
 for(const entry of snapshot.connections){
  const id='host:'+entry.id+':'+bindingHash.slice(0,16);
  const input:ConnectionInput={id,label:entry.label,providerType:entry.providerType,baseUrl:entry.baseUrl,mode:snapshot.mode,...(entry.credential?{secretRef:entry.credential.ref}:{})};
  entries.push({input,models:[...entry.models]});
  if(!entry.credential)continue;
  permitted.set(key(entry.credential.ref,id,input.baseUrl+'models'),entry.credential.environment);
  for(const model of entry.models){const profileId='profile:'+hash({connectionId:id,configHash:hash(input),model}).slice(0,32);const endpoint=input.baseUrl+(input.providerType==='anthropic'?'messages':input.providerType==='gemini'?'models/'+model+':generateContent':'chat/completions');permitted.set(key(entry.credential.ref,profileId,endpoint),entry.credential.environment);}
 }
 const resolveCredential:CredentialResolver=async request=>{
  request.signal.throwIfAborted();const source=permitted.get(key(request.secretRef,request.profileId,request.endpoint));
  if(!source)throw new Error('Host credential binding unavailable');
  let secret:unknown;try{secret=readEnvironment(source);}catch{throw new Error('Host credential unavailable');}
  request.signal.throwIfAborted();if(typeof secret!=='string'||!secret||secret.length>8192||/[^\x21-\x7e]/.test(secret))throw new Error('Host credential unavailable');return secret;
 };
 return {bindings:{revision:snapshot.revision,bindingHash,connections:entries},resolveCredential};
}

/** Compose the same manager for CLI and tests; fixture mode is explicit and credential-free. */
export function createHostConnections(store:Store<Mission>,artifacts:TextArtifactStore,startup:HostStartup,options:{transport:HttpProviderTransport;readEnvironment:(name:string)=>string|undefined}) {
 if(!startup.manifest){requireHost(!startup.allowLiveExecution,'manifest required for live execution');return new ConnectionWorkbench(store,artifacts,{transport:options.transport});}
 const manifest=parseHostManifest(startup.manifest);requireHost(!startup.allowLiveExecution||manifest.mode==='https','live option requires an HTTPS manifest');
 const host=compileHostBindings(manifest,options.readEnvironment);
 return new ConnectionWorkbench(store,artifacts,{transport:options.transport,hostBindings:host.bindings,...(manifest.mode==='https'?{resolveCredential:host.resolveCredential}:{}),allowFixture:manifest.mode==='local-http-mock',allowLiveExecution:startup.allowLiveExecution});
}
