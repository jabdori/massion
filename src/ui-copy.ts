import table from '../docs/product/screens/copy.ko.json' with {type:'json'};

type CopyValues=Record<string,string|number>;
const copyTable:Record<string,{ko:string}>=table;
export function copy(key:string,values:CopyValues={}):string{
 const entry=copyTable[key];
 if(!Object.hasOwn(copyTable,key))throw new Error('Unknown copy key: '+key);
 return entry!.ko.replace(/\{(\w+)\}/g,(_match,name:string)=>{
  if(!Object.hasOwn(values,name))throw new Error('Missing copy placeholder: '+key+'.'+name);
  return String(values[name]);
 });
}
export const uiCopyClient=`const copyTable=${JSON.stringify(table).replaceAll('<','\\u003c')};\n${copy.toString()}`;
