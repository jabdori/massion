import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';

export const redactEvidence=text=>text.replace(/data:image\/[^\s"'<>\\)]+/gi,'[ephemeral image]');

export function evidenceBrowser(browser){
 const evaluate=code=>browser('eval','-b',Buffer.from(code).toString('base64'));
 return async(...args)=>{
  try{
   if(args[0]==='screenshot'){
    const id='massion-evidence-'+randomUUID();
    try{
     // A stylesheet also covers images replaced by a live render during capture.
     const hidden=await evaluate(`(()=>{const style=document.createElement('style');style.id=${JSON.stringify(id)};style.textContent='#browser-screenshot { visibility: hidden !important; }';document.head.append(style);return [...document.querySelectorAll('#browser-screenshot')].every(image=>getComputedStyle(image).visibility==='hidden')})()`);
     if(hidden.result!==true)throw Error('Browser page image could not be hidden for evidence');
     return await browser(...args);
    }finally{await evaluate(`document.getElementById(${JSON.stringify(id)})?.remove()`);}
   }
   const result=await browser(...args);
   return ['snapshot','errors'].includes(args[0])?JSON.parse(redactEvidence(JSON.stringify(result))):result;
  }catch(error){throw Error(redactEvidence(inspect(error,{depth:4})));}
 };
}
