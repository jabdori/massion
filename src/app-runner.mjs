// The app worker (docs/architecture/apps.md). Started by app-sandbox.ts under the Node permission model, with an OS network sandbox where Node's does not cover the network, and an empty environment.
// It reads one job line, runs the app script in a vm context with code generation off, and speaks JSON lines: calls out, one result back.
import {constants,createContext,runInContext} from 'node:vm';
import {createInterface} from 'node:readline';
const write=line=>process.stdout.write(JSON.stringify(line)+'\n');
const can=(scope,ref)=>{try{return process.permission.has(scope,ref);}catch{return false;}};
// Refuse to run outside the permission model rather than run unconfined.
if(!process.permission||can('fs.read','/')||can('child')||can('worker')){write({t:'error',message:'Sandbox unavailable'});process.exit(1);}
const probe={permission:true,fsRead:can('fs.read','/etc/hosts'),childProcess:can('child'),worker:can('worker'),env:Object.keys(process.env).filter(k=>!k.startsWith('__CF_')).length};
// Defence in depth for the host realm of this child: what an escape from the context could still reach.
for(const name of ['fetch','WebSocket','EventSource','XMLHttpRequest','navigator'])try{delete globalThis[name];}catch{}
for(const name of ['binding','_linkedBinding','dlopen','getBuiltinModule'])try{process[name]=undefined;}catch{}
const lines=createInterface({input:process.stdin});let bridge=null;
// Only strings cross the boundary: the host never passes a function or object into the context (a host-realm error or prototype would hand the app the host's Function), and reads back nothing but typeof-checked strings.
const drain=()=>{let out;try{out=bridge.drain();}catch{return;}if(typeof out!=='string'||!out)return;for(const raw of out.split('\n')){try{JSON.parse(raw);}catch{continue;}process.stdout.write(raw+'\n');}};
lines.on('line',raw=>{
 let message;try{message=JSON.parse(raw);}catch{process.exit(1);}
 if(bridge){try{bridge.deliver(JSON.stringify(message));}catch{}return;}
 // DONT_CONTEXTIFY: an ordinary global of the new realm, with no host-realm object behind it.
 const context=createContext(constants.DONT_CONTEXTIFY,{codeGeneration:{strings:false,wasm:false}});
 bridge=runInContext(`(()=>{const handlers={},waiting=new Map(),out=[];let next=0;const post=m=>{out.push(JSON.stringify(m));};
  const massion=Object.freeze({handle(name,fn){if(typeof name!=='string'||typeof fn!=='function')throw new TypeError('handle(name, fn)');handlers[name]=fn;},
   fetch(url,options={}){const id=++next;post({t:'call',id,url:String(url),method:String(options.method||'GET'),secret:options.secret===undefined?null:String(options.secret)});return new Promise((resolve,reject)=>waiting.set(id,{resolve,reject}));}});
  globalThis.massion=massion;
  return Object.freeze({drain:()=>{const s=out.join('\\n');out.length=0;return s;},
   run:(handler,input)=>{const fn=handlers[handler];Promise.resolve().then(()=>{if(!fn)throw new Error('No handler: '+handler);return fn(JSON.parse(input));}).then(view=>post({t:'done',view}),error=>post({t:'error',message:String(error&&error.message||error)}));},
   deliver:line=>{const m=JSON.parse(line),w=waiting.get(m.id);if(!w)return;waiting.delete(m.id);if(m.ok)w.resolve(Object.freeze({status:m.status,body:m.body}));else w.reject(new Error(m.error));}});})()`,context);
 const {run,drain:inner,deliver}=bridge;bridge={run,drain:inner,deliver};
 // The context has no timers; its promises settle on this process's microtask queue, so a short poll carries its lines out.
 setInterval(drain,2);
 if(message.probe)write({t:'probe',probe});
 // The host compiles the app script; inside the context no string becomes code.
 try{runInContext(String(message.source),context,{timeout:4000,filename:'app.js'});run(String(message.handler),JSON.stringify(message.input??{}));}
 catch{write({t:'error',message:'App failed'});}
});
