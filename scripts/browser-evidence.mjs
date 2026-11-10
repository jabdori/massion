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
     const hidden=await evaluate(`(()=>{const style=document.createElement('style');style.id=${JSON.stringify(id)};style.textContent='#browser-screenshot { visibility: hidden !important; display: none !important; } #browser-page-alternative { position: static !important; padding: var(--pages-space-24) !important; margin: 0 !important; width: auto !important; height: auto !important; clip: auto !important; clip-path: none !important; white-space: normal !important; overflow: visible !important; background: var(--bg-0); color: var(--fg); } #browser-page { background: var(--bg-0) !important; color: var(--fg) !important; } #browser-member { display: none !important; }';document.head.append(style);return [...document.querySelectorAll('#browser-screenshot')].every(image=>getComputedStyle(image).visibility==='hidden')})()`);
     if(hidden.result!==true)throw Error('Browser page image could not be hidden for evidence');
     return await browser(...args);
    }finally{await evaluate(`document.getElementById(${JSON.stringify(id)})?.remove()`);}
   }
   const result=await browser(...args);
   return ['snapshot','errors'].includes(args[0])?JSON.parse(redactEvidence(JSON.stringify(result))):result;
  }catch(error){throw Error(redactEvidence(inspect(error,{depth:4})));}
 };
}
