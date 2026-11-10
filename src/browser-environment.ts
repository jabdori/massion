import {randomUUID} from 'node:crypto';
import {hash} from './domain.ts';
import {browserOriginRule} from './browser-network.ts';
import {sanitizePage} from './browser-runtime.ts';
import type {BrowserAdapter,RawBrowserPage} from './browser-runtime.ts';
import {environmentFields as exact,environmentId as id,requireEnvironment as ensure,validateObservation,validateAction} from './environment.ts';
import type {EnvironmentAdapter,EnvironmentAction,EnvironmentObservation,EnvironmentElement} from './environment.ts';

export interface BrowserEnvironmentConfig {
 environment:string;origin:string;
 elements:Array<EnvironmentElement&{selector:string;ownerOnly?:boolean}>;
 facts:Array<{id:string;selector:string;state:'present'|'checked'|'value-present'}>;
}
export class BrowserUnsupportedTargetError extends Error {readonly code='unsupported-target';constructor(){super('Unsupported browser target');this.name='BrowserUnsupportedTargetError';}}
export interface BrowserControl {evaluate(expression:string):Promise<any>;close():Promise<void>}
interface Snapshot {document:string;revision:number;available:string[];unsupportedClicks:string[];facts:Record<string,boolean>;page:RawBrowserPage}
export function validateBrowserEnvironment(c:BrowserEnvironmentConfig){
 exact(c,['environment','origin','elements','facts']);ensure(id(c.environment),'Invalid browser environment');browserOriginRule(c.origin);
 ensure(Array.isArray(c.elements)&&c.elements.length>0&&c.elements.length<=64&&Array.isArray(c.facts)&&c.facts.length<=64,'Invalid browser declarations');
 const selector=(s:unknown)=>typeof s==='string'&&s.length>0&&s.length<=512&&!/[\u0000-\u001f]/.test(s);
 for(const e of c.elements){exact(e,['id','selector','role','label','operations','gates',...(Object.hasOwn(e,'ownerOnly')?['ownerOnly']:[])]);ensure(e.operations.every(k=>k!=='key')&&selector(e.selector)&&(!Object.hasOwn(e,'ownerOnly')||typeof e.ownerOnly==='boolean'),'Invalid browser element declaration');}
 for(const f of c.facts){exact(f,['id','selector','state']);ensure(id(f.id)&&selector(f.selector)&&['present','checked','value-present'].includes(f.state),'Invalid browser fact declaration');}
 ensure(new Set(c.facts.map(f=>f.id)).size===c.facts.length,'Duplicate browser fact');
 validateObservation({binding:{environment:c.environment,surface:'validation',origin:c.origin,generation:1,revision:1},structure:c.elements.map(({selector,ownerOnly,...e})=>e),facts:{},image:null});
}

// This function runs synchronously in the owned, script-disabled renderer.
function browserOperation(request:any){
 const {config,key,operation}=request;
 if(location.origin!==config.origin||document.querySelector('iframe,frame,object,embed,[contenteditable]')||document.querySelectorAll('*').length>20000)throw Error('Unsupported browser surface');
 const labelled=(node:Element|null)=>node instanceof HTMLLabelElement?node.control:node;
 const clickTarget=(node:Element|null)=>{const control=labelled(node);return control instanceof HTMLAnchorElement&&control.hasAttribute('href')||control instanceof HTMLButtonElement&&['submit','button'].includes(control.type)||control instanceof HTMLInputElement&&['submit','button','checkbox','radio'].includes(control.type)?control:null;};
 const root:any=globalThis,state=root[key]??(root[key]={document:crypto.randomUUID(),revision:0,fingerprint:'',targets:[],private:false});
 if(request.private)state.private=true;
 const controls=[...document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea')];
 if(controls.length>256||document.documentElement.outerHTML.length>262144)throw Error('Browser document bound exceeded');
 const privateFields=controls.filter(e=>e.value||e.getAttribute('value'));
 // Form metadata is untrusted; every native form control makes this session private.
 if(controls.length)state.private=true;
 const targets=config.elements.map((e:any)=>{const matches=document.querySelectorAll(e.selector);if(matches.length>1)throw Error('Ambiguous browser target');return matches[0]??null;});
 const fingerprint=JSON.stringify([location.href,document.documentElement.outerHTML,controls.map(e=>[e.value,'checked' in e?e.checked:null,e instanceof HTMLSelectElement?[...e.options].map(o=>o.selected):null]),targets.map((e:Element|null)=>e?.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})??false)]);
 if(fingerprint!==state.fingerprint||targets.some((e:Element|null,i:number)=>e!==state.targets[i])){state.revision++;state.fingerprint=fingerprint;state.targets=targets;}
 const ownerTargets=targets.filter((_:Element|null,i:number)=>config.elements[i].ownerOnly).map(labelled);
 const ownerActivation=(node:Element)=>{const control=labelled(node)??node;return ownerTargets.some((owned:Element|null)=>owned&&(owned.contains(node)||owned.contains(control)||control instanceof HTMLInputElement&&control.type==='radio'&&control.name&&owned instanceof HTMLInputElement&&owned.type==='radio'&&owned.name===control.name&&owned.form===control.form&&owned.getRootNode()===control.getRootNode()));};
 const unsupportedClicks=config.elements.filter((e:any,i:number)=>targets[i]&&e.operations.includes('click')&&!clickTarget(targets[i])).map((e:any)=>e.id);
 const available=config.elements.filter((e:any,i:number)=>{const node=targets[i];return node&&!e.ownerOnly&&!ownerActivation(node)&&node.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})&&!node.matches(':disabled,[aria-disabled="true"],[inert]')&&!node.closest('[inert]');}).map((e:any)=>e.id);
 if(operation==='act'){
  const {expected,action}=request;
  if(state.document!==expected.document||state.revision!==expected.revision||!available.includes(action.element))throw Error('Browser target changed');
  const index=config.elements.findIndex((e:any)=>e.id===action.element),declaration=config.elements[index],node=targets[index] as HTMLElement;
  if(!declaration.operations.includes(action.input.kind)||declaration.ownerOnly||action.gates.some((g:any)=>g.kind==='payment'))throw Error('Browser action denied');
  const input=action.input;
  const activator=input.kind==='click'?clickTarget(node):input.kind==='submit'&&node instanceof HTMLLabelElement?clickTarget(node):node;
  if(!activator)return {unsupportedTarget:true};
  if(ownerActivation(activator)||activator.matches(':disabled,[aria-disabled="true"],[inert]')||activator.closest('[inert]'))throw Error('Browser activator unavailable');
  const submitter=activator instanceof HTMLButtonElement&&activator.type==='submit'||activator instanceof HTMLInputElement&&activator.type==='submit'?activator:undefined;
  if(input.kind==='submit'&&!submitter&&!(activator instanceof HTMLFormElement))return {unsupportedTarget:true};
  const form=activator instanceof HTMLFormElement?activator:(activator as HTMLInputElement).form;
  const submitting=input.kind==='submit'||input.kind==='click'&&!!submitter;
  const policies=config.elements.flatMap((e:any,i:number)=>{const control=labelled(targets[i]);return control===activator?e.gates:submitting&&form&&(control as HTMLInputElement|null)?.form===form?e.gates.filter((g:any)=>g.kind==='payment'):[];});
  if(policies.some((g:any)=>g.kind==='payment'||!action.gates.some((approved:any)=>approved.kind===g.kind)))throw Error('Browser activator policy denied');
  const route=(url:string,target:string)=>{target||=document.querySelector<HTMLBaseElement>('base[target]')?.target??'';const u=new URL(url,location.href);if(u.origin!==config.origin||u.username||u.password||target&&target!=='_self')throw Error('Browser route denied');};
  if(input.kind==='click'&&activator instanceof HTMLAnchorElement)route(activator.href,activator.target);
  if(form){let address=form.action,target=form.target,method=form.method;if(submitter){if(submitter.hasAttribute('formaction'))address=submitter.formAction;if(submitter.hasAttribute('formtarget'))target=submitter.formTarget;if(submitter.hasAttribute('formmethod'))method=submitter.formMethod;}route(address,target);
   if(state.private&&['click','submit'].includes(input.kind)&&method.toLowerCase()!=='post')throw Error('Private form requires POST');
  }
  switch(input.kind){
   case 'type':{
    if(!(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement)||node instanceof HTMLInputElement&&['file','hidden','checkbox','radio','button','submit','reset','image'].includes(node.type)||node.readOnly||typeof request.secret!=='string'||!request.secret.length||request.secret.length>4000)throw Error('Browser input unavailable');
    state.private=true;node.value=request.secret;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));break;
   }
   case 'select':{
    if(!(node instanceof HTMLSelectElement)||node.multiple)throw Error('Browser select unavailable');const options=[...node.options],index=options.findIndex(o=>o.value===input.option),option=options[index];if(!option||option.matches(':disabled')||options.filter(o=>o.value===option.value).length!==1||options.filter(o=>o.label===option.label).length!==1)throw Error('Browser option unavailable');node.selectedIndex=index;node.dispatchEvent(new Event('change',{bubbles:true}));break;
   }
   case 'scroll':node.scrollBy({left:input.x,top:input.y,behavior:'instant'});break;
   case 'click':node.click();break;
   case 'submit':if(!form)throw Error('Browser form unavailable');form.requestSubmit(submitter);break;
   default:throw Error('Browser operation unavailable');
  }
  return {delivered:true};
 }
 const facts:Record<string,boolean>={};for(const fact of config.facts){const matches=document.querySelectorAll(fact.selector);if(matches.length>1)throw Error('Ambiguous browser fact');const node=matches[0];facts[fact.id]=fact.state==='present'?!!node:fact.state==='checked'?node instanceof HTMLInputElement&&['checkbox','radio'].includes(node.type)&&node.checked:(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement||node instanceof HTMLSelectElement)&&node.value.length>0;}
 const page:RawBrowserPage={address:location.href,title:state.private?'':document.title,blocks:state.private?[]:[...document.querySelectorAll('h1,h2,h3,p,dt,dd,td,th,li')].filter(e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})).slice(0,64).map(e=>((e as HTMLElement).innerText??'').trim().slice(0,4000)),fields:[],privateFields:privateFields.length,...(state.private?{privateSession:true as const}:{})};
 return {document:state.document,revision:state.revision,available,unsupportedClicks,facts,page};
}

/** Trusted host adapter; neither declarations nor the control channel are model tools. */
export class BrowserEnvironment implements EnvironmentAdapter,BrowserAdapter {
 readonly #control:BrowserControl;readonly #config:BrowserEnvironmentConfig;readonly #key='massion-'+randomUUID();readonly #surface='browser:'+randomUUID();
 #document='';#generation=0;#private=false;#closed=false;
 constructor(control:BrowserControl,config:BrowserEnvironmentConfig){validateBrowserEnvironment(config);this.#control=control;this.#config=structuredClone(config);}
 async #call(request:object,signal:AbortSignal){
  ensure(!this.#closed,'Browser environment closed');signal.throwIfAborted();
  try{const result=await this.#control.evaluate(`(${browserOperation.toString()})(${JSON.stringify({config:this.#config,key:this.#key,private:this.#private,...request})})`);signal.throwIfAborted();if(result?.unsupportedTarget===true)throw new BrowserUnsupportedTargetError();return result;}
  catch(error){this.#private=true;if(error instanceof BrowserUnsupportedTargetError)throw error;throw Error('Browser environment operation unavailable');}
 }
 async #inspect(signal:AbortSignal):Promise<Snapshot>{
  try{const s=await this.#call({operation:'observe'},signal) as Snapshot;
  ensure(s&&typeof s.document==='string'&&s.document.length>0&&s.document.length<=128&&Number.isSafeInteger(s.revision)&&s.revision>0&&[s.available,s.unsupportedClicks].every(list=>Array.isArray(list)&&list.every(v=>this.#config.elements.some(e=>e.id===v))),'Invalid browser observation');
  ensure(new URL(s.page.address).origin===this.#config.origin,'Browser origin changed');const page=sanitizePage(s.page,undefined,this.#private);this.#private||=page.tainted===true;
  if(s.document!==this.#document){this.#document=s.document;this.#generation++;}return s;}catch{this.#private=true;throw Error('Browser observation unavailable');}
 }
 #observation(s:Snapshot):EnvironmentObservation{
  const o:EnvironmentObservation={binding:{environment:this.#config.environment,surface:this.#surface,origin:this.#config.origin,generation:this.#generation,revision:s.revision},structure:this.#config.elements.filter(e=>!e.ownerOnly&&s.available.includes(e.id)).map(({selector,ownerOnly,...e})=>{const operations=e.operations.filter(kind=>kind!=='click'||!s.unsupportedClicks.includes(e.id));return {...e,operations,gates:e.gates.length?structuredClone(e.gates):operations.some(k=>['click','submit','select'].includes(k))?[{kind:'irreversible-submit' as const}]:[]};}).filter(e=>e.operations.length),facts:s.facts,image:null};
  validateObservation(o);return o;
 }
 async observe(signal:AbortSignal){return this.#observation(await this.#inspect(signal));}
 async read(input:Parameters<BrowserAdapter['read']>[0]):Promise<RawBrowserPage>{
  ensure(input.address===this.#config.origin||input.address===this.#config.origin+'/','Current browser address must be origin only');const s=await this.#inspect(input.signal),page=sanitizePage(s.page,undefined,this.#private);
  if(page.tainted)return {address:page.address,title:'',blocks:[],fields:[],privateFields:page.summary.privateFields,privateSession:true};
  return {address:page.address,title:page.title,blocks:page.blocks,fields:page.fields.map(f=>({label:f.label,value:f.value,type:'text',autocomplete:''}))};
 }
 async act(action:EnvironmentAction,context:Parameters<EnvironmentAdapter['act']>[1]){
  validateAction(action);action=structuredClone(action);ensure(!action.gates.some(g=>g.kind==='payment'),'Payment intents are non-executable');let bytes:Uint8Array|undefined;
  const check=async()=>{const s=await this.#inspect(context.signal);if(action.input.kind==='click'&&s.unsupportedClicks.includes(action.element))throw new BrowserUnsupportedTargetError();const o=this.#observation(s),node=o.structure.find(n=>n.id===action.element);ensure(hash(o.binding)===hash(action.binding)&&node&&node.operations.includes(action.input.kind)&&hash(node.gates)===hash(action.gates),'Browser action binding changed');return s;};
  try{await check();if(action.input.kind==='type'){ensure(context.secret,'Secret resolver unavailable');this.#private=true;bytes=await context.secret();ensure(bytes instanceof Uint8Array&&bytes.byteLength>0&&bytes.byteLength<=16000,'Invalid private input');}
   const snapshot=await check();context.signal.throwIfAborted();const secret=bytes?new TextDecoder('utf-8',{fatal:true}).decode(bytes):undefined;
   const result=await this.#call({operation:'act',expected:{document:snapshot.document,revision:snapshot.revision},action,...(secret===undefined?{}:{secret})},context.signal);ensure(result?.delivered===true,'Browser action delivery unknown');
  }catch(error){if(error instanceof BrowserUnsupportedTargetError)throw error;throw Error('Browser action delivery unavailable');}finally{bytes?.fill(0);}
 }
 async close(){this.#closed=true;await this.#control.close();}
}
