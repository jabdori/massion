/** Neutral bounded plain-JSON value validation; no runtime or authorization behavior. */
import {DomainError} from './domain.ts';
import {types} from 'node:util';
function requireValue(condition:unknown,message:string):asserts condition {if(!condition)throw new DomainError('JSON value: '+message);}

/** Reject lossy/non-JSON JavaScript inputs before canonical hashing or cloning. */
export function boundedPlainJson(value:unknown,depth=0,seen=new Set<object>(),count={nodes:0,bytes:0}):void {
 const add=(bytes:number)=>{count.bytes+=bytes;requireValue(count.bytes<=32768,'JSON byte limit exceeded');};
 requireValue(depth<=16&&++count.nodes<=2048,'JSON complexity limit exceeded');
 if(value===null||typeof value==='boolean'){add(JSON.stringify(value).length);return;}
 if(typeof value==='string'){requireValue(value.isWellFormed()&&value.length<=32768,'invalid Unicode or string size');add(Buffer.byteLength(JSON.stringify(value),'utf8'));return;}
 if(typeof value==='number'){requireValue(Number.isSafeInteger(value)&&!Object.is(value,-0),'unsafe or noncanonical number');add(JSON.stringify(value).length);return;}
 requireValue(typeof value==='object','only plain JSON values are supported');
 requireValue(!types.isProxy(value),'proxy objects are unsupported');
 requireValue(!seen.has(value),'cyclic JSON is unsupported');seen.add(value);
 const prototype=Object.getPrototypeOf(value);
 requireValue(Array.isArray(value)?prototype===Array.prototype:prototype===Object.prototype||prototype===null,'non-JSON prototype');
 const keys=Reflect.ownKeys(value);
 requireValue(keys.length<=257,'JSON collection limit exceeded');
 requireValue(keys.every(key=>typeof key==='string'),'symbol properties are unsupported');
 if(Array.isArray(value)){
  requireValue(value.length<=256&&keys.length===value.length+1,'sparse or extended array');
  for(let i=0;i<value.length;i++)requireValue(Object.hasOwn(value,i),'sparse array');
 }
 const entries=Array.isArray(value)?value.length:keys.length;
 add(2+Math.max(0,entries-1));
 for(const key of keys){
  if(Array.isArray(value)&&key==='length')continue;
  requireValue(typeof key==='string'&&key.isWellFormed()&&key.length<=128,'invalid key');
  if(!Array.isArray(value))add(Buffer.byteLength(JSON.stringify(key),'utf8')+1);
  const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
  requireValue(Object.hasOwn(descriptor,'value')&&descriptor.enumerable,'accessor or hidden field');
  boundedPlainJson(descriptor.value,depth+1,seen,count);
 }
 seen.delete(value);
}
