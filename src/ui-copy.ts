import table from '../docs/product/screens/copy.ko.json' with {type:'json'};

type CopyValues=Record<string,string|number>;
const copyTable:Record<string,{ko:string}>=table;
export function copy(key:string,values:CopyValues={}):string{
 const entry=copyTable[key];
 if(!Object.hasOwn(copyTable,key))throw new Error('Unknown copy key: '+key);
 return entry!.ko.replace(/\{(\w+)\}(이에요|예요|을|를)?/g,(_match,name:string,particle='')=>{
  if(!Object.hasOwn(values,name))throw new Error('Missing copy placeholder: '+key+'.'+name);
  const value=String(values[name]),last=value.charCodeAt(value.length-1);
  if(!particle||!(last>=0xac00&&last<=0xd7a3))return value+particle;
  const consonant=(last-0xac00)%28!==0;
  return value+(particle==='을'||particle==='를'?(consonant?'을':'를'):(consonant?'이에요':'예요'));
 });
}
export const uiCopyClient=`const copyTable=${JSON.stringify(table).replaceAll('<','\\u003c')};\n${copy.toString()}`;
