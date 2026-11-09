import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseCheck} from './report.ts';

export interface Diagnostic {screen:string;theme:string;kind:string;diagnostic:string;occurrence:number}
export interface AllowEntry extends Diagnostic {category:string;reason:string;ledger:string}
interface AllowList {source:{commit:string;run:string};entries:AllowEntry[]}
const root=fileURLToPath(new URL('../../',import.meta.url));
const listPath=join(root,'scripts/ui-contracts/allow-list.json');
const identity=(item:Diagnostic)=>JSON.stringify([item.screen,item.theme,item.kind,item.diagnostic,item.occurrence]);
const normalize=(text:string)=>text.replace(/\s+/g,' ').trim();

export function diagnostics(screen:string,theme:string,kind:string,messages:string[]):Diagnostic[]{
 const counts=new Map<string,number>();
 return messages.map(message=>{const diagnostic=normalize(message),occurrence=(counts.get(diagnostic)||0)+1;counts.set(diagnostic,occurrence);return {screen,theme,kind,diagnostic,occurrence};});
}
export function copyDiagnostics<T extends {file:string;context:string;reason:string;text:string}>(findings:T[]):Diagnostic[]{
 const counts=new Map<string,number>();
 return findings.map(item=>{
  const diagnostic=JSON.stringify([item.context,item.reason,item.text]),key=JSON.stringify([item.file,diagnostic]),occurrence=(counts.get(key)||0)+1;
  counts.set(key,occurrence);return {screen:item.file,theme:'source',kind:'copy',diagnostic,occurrence};
 });
}
function validateEntries(entries:AllowEntry[]){
 const seen=new Set<string>();
 for(const item of entries){
  if(!item.screen||!item.theme||!['contract','visual','gap','copy'].includes(item.kind)||!item.diagnostic||!Number.isSafeInteger(item.occurrence)||item.occurrence<1)throw Error('Invalid diagnostic identity');
  if(!item.category?.trim()||!item.reason?.trim()||!/^docs\/acceptance\/[^#]+\.md(?:#[\w-]+)?$/.test(item.ledger)||item.ledger.includes('..'))throw Error('Every exception needs a category, reason and residual ledger link');
  const key=identity(item);if(seen.has(key))throw Error('Duplicate exception: '+key);seen.add(key);
 }
}
export function evaluateGate(current:Diagnostic[],allowed:AllowEntry[],errors:string[]=[]){
 validateEntries(allowed);
 const live=new Set(current.map(identity)),known=new Set(allowed.map(identity));
 const added=current.filter(item=>!known.has(identity(item))),resolved=allowed.filter(item=>!live.has(identity(item)));
 return {code:errors.length||added.length||resolved.length?1:0,added,resolved,errors};
}
export function updateAllowList(current:Diagnostic[],allowed:AllowEntry[],allowAdditions=false,reasons:AllowEntry[]=[]){
 const result=evaluateGate(current,allowed);
 const retained=allowed.filter(item=>!result.resolved.includes(item));
 if(!allowAdditions)return retained;
 validateEntries(reasons);
 if(result.added.length&&!reasons.length)throw Error('Missing ledger reasons for additions');
 for(const item of result.added){const reason=reasons.find(entry=>identity(entry)===identity(item));if(reason)retained.push({...reason,...item});}
 return retained;
}
export async function readCapture(out:string,expected:string[]){
 const report=JSON.parse(await readFile(join(out,'report.json'),'utf8'));
 const rows=report.rows as {screen:string;theme:string;failed:number;visualFailures:string[];gaps:string[];errors:string[]}[];
 if(!Array.isArray(rows)||rows.length!==expected.length||new Set(rows.map(row=>`${row.screen}/${row.theme}`)).size!==expected.length||rows.some(row=>!expected.includes(`${row.screen}/${row.theme}`)))throw Error('Incomplete screen/theme coverage');
 const current:Diagnostic[]=[],errors:string[]=[];
 for(const row of rows){
  if(![row.errors,row.visualFailures,row.gaps].every(items=>Array.isArray(items)&&items.every(item=>typeof item==='string')))throw Error('Invalid capture row');
  errors.push(...row.errors.map(error=>`${row.screen}/${row.theme}: ${error}`));
  if(row.errors.length)continue;
  const output=await readFile(join(out,'checks',row.theme,row.screen+'.txt'),'utf8');
  const messages=[...output.matchAll(/^  FAIL  (.+)$/gm)].map(match=>match[1]!);
  if(parseCheck(output).failed!==row.failed||messages.length!==row.failed)throw Error('Checker failure count mismatch: '+row.screen+'/'+row.theme);
  current.push(...diagnostics(row.screen,row.theme,'contract',messages),...diagnostics(row.screen,row.theme,'visual',row.visualFailures),...diagnostics(row.screen,row.theme,'gap',row.gaps));
 }
 return {diagnostics:current,errors};
}
async function checkLedgers(entries:AllowEntry[]){
 for(const ledger of new Set(entries.map(entry=>entry.ledger.split('#')[0]!)))await readFile(join(root,ledger),'utf8');
}
export async function runGate(out:string,args:string[]=[]){
 if(args.some((arg,index)=>!['--update','--allow-additions','--reasons'].includes(arg)&&args[index-1]!=='--reasons')||args.includes('--allow-additions')&&!args.includes('--update')||args.includes('--reasons')&&!args.includes('--allow-additions'))throw Error('Usage: gate.ts [--update [--allow-additions --reasons <json>]]');
 const screens=(await readdir(join(root,'docs/product/screens/contracts'))).filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5));
 const capture=await readCapture(out,screens.flatMap(screen=>['dark','light'].map(theme=>screen+'/'+theme)));
 const {lintCopy}=await import(new URL('./copy-lint.mjs',import.meta.url).href);
 const copy=await lintCopy(root),current=[...capture.diagnostics,...copyDiagnostics(copy.findings)];
 const list=JSON.parse(await readFile(listPath,'utf8')) as AllowList;
 validateEntries(list.entries);await checkLedgers(list.entries);
 if(args.includes('--update')){
  if(capture.errors.length)throw Error('Cannot update from infrastructure-failed capture: '+capture.errors.join('\n'));
  const reasonIndex=args.indexOf('--reasons');
  const reasons=reasonIndex===-1?[]:JSON.parse(await readFile(resolve(args[reasonIndex+1]||''),'utf8')) as AllowEntry[];
  const entries=updateAllowList(current,list.entries,args.includes('--allow-additions'),reasons);await checkLedgers(entries);
  await writeFile(listPath,JSON.stringify({...list,entries},null,2)+'\n');
  console.log(`Allow-list: ${list.entries.length} -> ${entries.length} entries`);
  return 0;
 }
 const result=evaluateGate(current,list.entries,capture.errors);
 const lines=['## Blocking diagnostic gate','',`${current.length} occurrences; ${result.added.length} new; ${result.resolved.length} resolved — remove from the list; ${result.errors.length} infrastructure errors.`];
 for(const error of result.errors)lines.push(`- Infrastructure: ${JSON.stringify(error)}`);
 for(const item of result.added)lines.push(`- New: ${identity(item)}`);
 for(const item of result.resolved)lines.push(`- Resolved — remove from the list: ${identity(item)}`);
 const text=lines.join('\n')+'\n';console.log(text);
 await writeFile(join(out,'gate.json'),JSON.stringify(result,null,2)+'\n');await writeFile(join(out,'gate.md'),text);
 return result.code;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{process.exitCode=await runGate(resolve(root,process.env.UI_CONTRACTS_OUTPUT||'.runtime/ui-contracts'),process.argv.slice(2));}
 catch(error){console.error('Gate infrastructure error:',error);process.exitCode=1;}
}
