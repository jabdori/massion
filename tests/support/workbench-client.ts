import {webcrypto} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';
import {workbenchPage} from '../../src/workbench.ts';

// A deliberately small DOM double runs the actual inline client without dependencies.
// It checks transitions and rendered text, not browser layout/accessibility conformance.
export class Node {
 tagName:string; id=''; className=''; value=''; disabled=false; hidden=false; required=false;
 parentElement:Node|null=null; open=false; rows=0; maxLength=0; type=''; htmlFor=''; style:Record<string,string>={}; children:Node[]=[];
 attributes=new Map<string,string>(); listeners=new Map<string,((event:any)=>unknown)[]>();
 private text=''; resets=0; onFocus?:()=>void;
 focus(){this.onFocus?.();}
 contains(node:Node):boolean{return this===node||this.children.some(child=>child.contains(node));}
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 set textContent(value:string){this.text=String(value);this.children=[];}
 get textContent():string{return this.text+this.children.map(child=>child.textContent).join('');}
 append(...items:Node[]){for(const item of items)item.parentElement=this;this.children.push(...items);}
 replaceChildren(...items:Node[]){this.text='';for(const child of this.children)child.parentElement=null;this.children=[];this.append(...items);}
 setAttribute(key:string,value:string){this.attributes.set(key,value);}
 hasAttribute(key:string){return this.attributes.has(key);}
 addEventListener(name:string,fn:(event:any)=>unknown){this.listeners.set(name,[...(this.listeners.get(name)||[]),fn]);}
 async fire(name:string){await Promise.all((this.listeners.get(name)||[]).map(fn=>fn({preventDefault(){}})));}
 reset(){this.resets++;}
}
export type Reply={status:number;body:any};
export type Handler=(path:string,options:any)=>Reply|Promise<Reply>;
export const reply=(body:any,status=200):Reply=>({body,status});
export class SharedWebLocks {
 held=false;waiters:(()=>void)[]=[];
 async request(name:string,options:{ifAvailable:boolean},callback:(lock:{name:string}|null)=>unknown) {
  if(this.held){if(options.ifAvailable)return callback(null);await new Promise<void>(resolve=>this.waiters.push(resolve));}
  this.held=true;
  // Grant asynchronously so two simultaneous clients overlap before either callback.
  await Promise.resolve();
  try{return await callback({name});}finally{this.held=false;this.waiters.shift()?.();}
 }
}
export async function settle(){for(let i=0;i<12;i++)await new Promise<void>(resolve=>setImmediate(resolve));}
export function harness(handler:Handler,initial:Record<string,string>={},storageFault?:'read'|'write'|'remove',coordination?:{storage?:Map<string,string>;locks?:SharedWebLocks;noLocks?:boolean;identity?:string;network?:boolean;fragment?:string}) {
 const nodes=new Map<string,Node>();
 for(const match of workbenchPage.matchAll(/<([a-z-]+)[^>]*\bid="([^"]+)"[^>]*>/g)){const node=new Node(match[1]);node.id=match[2]!;node.hidden=match[0].includes(' hidden');nodes.set(node.id,node);}
 nodes.get('work-budget')!.value='0';
 const storage=coordination?.storage || new Map(Object.entries(initial)); const calls:{path:string;options:any}[]=[]; const intervals:(()=>unknown)[]=[];
 const all=():Node[]=>{const output:Node[]=[];const visit=(node:Node)=>{output.push(node);node.children.forEach(visit);};nodes.forEach(visit);return output;};
 const listeners=new Map<string,()=>unknown>();
 const document={activeElement:new Node('body'),getElementById:(id:string)=>nodes.get(id)||all().find(node=>node.id===id),createElement:(tag:string)=>{const node=new Node(tag);node.onFocus=()=>{document.activeElement=node;};return node;},querySelectorAll:()=>all().filter(node=>node.hasAttribute('data-write')),hidden:false,addEventListener:(name:string,fn:()=>unknown)=>listeners.set(name,fn)};
 for(const node of nodes.values())node.onFocus=()=>{document.activeElement=node;};
 const windowListeners=new Map<string,()=>unknown>(),location={hash:coordination?.fragment||'',pathname:'/',search:''};
 const context=createContext({navigator:coordination?.noLocks?{}:{locks:coordination?.locks||new SharedWebLocks()},document,window:{location,history:{replaceState:(_state:unknown,_title:string,fragment:string)=>{location.hash=fragment.startsWith('#')?fragment:'';}},addEventListener:(name:string,fn:()=>unknown)=>windowListeners.set(name,fn)},localStorage:{getItem:(key:string)=>{if(storageFault==='read')throw new Error('Storage denied');return storage.get(key)||null;},setItem:(key:string,value:string)=>{if(storageFault==='write')throw new Error('Storage full');storage.set(key,value);},removeItem:(key:string)=>{if(storageFault==='remove')throw new Error('Storage denied');storage.delete(key);}},crypto:{subtle:webcrypto.subtle,randomUUID:(()=>{let index=0;return()=>`${coordination?.identity||'uuid'}-${++index}`;})()},AbortController,TextEncoder,Date,Map,JSON,Number,console,setTimeout:()=>1,clearTimeout(){},setInterval:(fn:()=>unknown)=>intervals.push(fn),fetch:async(path:string,options:any)=>{
  calls.push({path,options});
  const result=coordination?.network?await handler(path,options):path==='/health'?reply({status:'ready'}):path==='/providers'?reply({providers:[],selection:{status:'unavailable',code:'provider_unavailable',reason:'No authorized provider is configured.'}}):await handler(path,options);
  return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.body};
 }});
 const source=workbenchPage.match(/<script>([\s\S]*)<\/script>/)![1]!;
 runInContext(source,context);
 return {node:(id:string)=>nodes.get(id)!,all,calls,storage,context,fragment:()=>location.hash,async windowEvent(name:string){windowListeners.get(name)?.();await settle();},async navigateFragment(fragment:string){location.hash=fragment;windowListeners.get('hashchange')?.();await settle();},async tick(){intervals[0]!();await settle();},async submit(id:string){await nodes.get(id)!.fire('submit');await settle();}};
}

export function selectionField(app:ReturnType<typeof harness>,id:string) {return app.all().find(node=>node.id===id)!;}
