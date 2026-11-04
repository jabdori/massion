import {createContext,runInContext} from 'node:vm';
import {workbenchPage} from '../../src/workbench.ts';

// A deliberately small DOM double runs the actual inline client without dependencies.
// It checks transitions and rendered text, not browser layout/accessibility conformance.
export class Node {
 tagName:string; id=''; className=''; value=''; disabled=false; hidden=false; required=false;
 rows=0; maxLength=0; type=''; htmlFor=''; style:Record<string,string>={}; children:Node[]=[];
 attributes=new Map<string,string>(); listeners=new Map<string,((event:any)=>unknown)[]>();
 private text=''; resets=0;
 constructor(tag='div'){this.tagName=tag.toUpperCase();}
 set textContent(value:string){this.text=String(value);this.children=[];}
 get textContent():string{return this.text+this.children.map(child=>child.textContent).join('');}
 append(...items:Node[]){this.children.push(...items);}
 replaceChildren(...items:Node[]){this.text='';this.children=items;}
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
export function harness(handler:Handler,initial:Record<string,string>={},storageFault?:'read'|'write'|'remove',coordination?:{storage?:Map<string,string>;locks?:SharedWebLocks;noLocks?:boolean;identity?:string;network?:boolean}) {
 const nodes=new Map<string,Node>();
 for(const match of workbenchPage.matchAll(/<([a-z-]+)[^>]*\bid="([^"]+)"[^>]*>/g)){const node=new Node(match[1]);node.id=match[2]!;node.hidden=match[0].includes(' hidden');nodes.set(node.id,node);}
 nodes.get('work-budget')!.value='0';
 const storage=coordination?.storage || new Map(Object.entries(initial)); const calls:{path:string;options:any}[]=[]; const intervals:(()=>unknown)[]=[];
 const all=():Node[]=>{const output:Node[]=[];const visit=(node:Node)=>{output.push(node);node.children.forEach(visit);};nodes.forEach(visit);return output;};
 const listeners=new Map<string,()=>unknown>();
 const document={getElementById:(id:string)=>nodes.get(id),createElement:(tag:string)=>new Node(tag),querySelectorAll:()=>all().filter(node=>node.hasAttribute('data-write')),hidden:false,addEventListener:(name:string,fn:()=>unknown)=>listeners.set(name,fn)};
 const context=createContext({navigator:coordination?.noLocks?{}:{locks:coordination?.locks||new SharedWebLocks()},document,window:{addEventListener(){}},localStorage:{getItem:(key:string)=>{if(storageFault==='read')throw new Error('Storage denied');return storage.get(key)||null;},setItem:(key:string,value:string)=>{if(storageFault==='write')throw new Error('Storage full');storage.set(key,value);},removeItem:(key:string)=>{if(storageFault==='remove')throw new Error('Storage denied');storage.delete(key);}},crypto:{randomUUID:(()=>{let index=0;return()=>`${coordination?.identity||'uuid'}-${++index}`;})()},AbortController,Date,Map,JSON,Number,console,setTimeout:()=>1,clearTimeout(){},setInterval:(fn:()=>unknown)=>intervals.push(fn),fetch:async(path:string,options:any)=>{
  calls.push({path,options});
  const result=coordination?.network?await handler(path,options):path==='/health'?reply({status:'ready'}):path==='/providers'?reply({providers:[],selection:{status:'unavailable',code:'provider_unavailable',reason:'No authorized provider is configured.'}}):await handler(path,options);
  return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.body};
 }});
 const source=workbenchPage.match(/<script>([\s\S]*)<\/script>/)![1]!;
 runInContext(source,context);
 return {node:(id:string)=>nodes.get(id)!,all,calls,storage,context,async tick(){intervals[0]!();await settle();},async submit(id:string){await nodes.get(id)!.fire('submit');await settle();}};
}

export function selectionField(app:ReturnType<typeof harness>,id:string) {return app.all().find(node=>node.id===id)!;}
