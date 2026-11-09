import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {readCapture,evaluateGate,copyDiagnostics} from '../../../scripts/ui-contracts/gate.ts';
import {lintCopy} from '../../../scripts/ui-contracts/copy-lint.mjs';

// Use the production gate with the fixed E5b scope; the full CLI requires all 150 captures.
const screens=['B24','B24-done','B24-later','B25','B25-done','B25-later','B24-connect','B24-connect-token','B24-connect-connected','B24-connect-later','B24-connect-mail'];
const files=['src/app-connect-panel.ts','src/app-frame.ts','src/apps-panel.ts','src/assistant-conversation-panel.ts','src/first-experience.ts','src/surface-shell.ts','src/workbench.ts'];
const out=resolve(process.env.UI_CONTRACTS_OUTPUT||'docs/acceptance/e5b/p2-contracts'),path=resolve('scripts/ui-contracts/allow-list.json');
assert.ok(process.argv.slice(2).every(arg=>arg==='--remove-resolved'),'Only removal of resolved entries is supported');
const capture=await readCapture(out,screens.flatMap(screen=>['dark','light'].map(theme=>screen+'/'+theme))),copy=await lintCopy(process.cwd());
const current=[...capture.diagnostics,...copyDiagnostics(copy.findings.filter(f=>files.includes(f.file)))],list=JSON.parse(await readFile(path,'utf8'));
const inScope=e=>screens.includes(e.screen)&&['dark','light'].includes(e.theme)||e.kind==='copy'&&files.includes(e.screen);
for(const ledger of new Set(list.entries.filter(inScope).map(e=>e.ledger.split('#')[0])))await readFile(resolve(ledger),'utf8');
let result=evaluateGate(current,list.entries.filter(inScope),capture.errors);const removed=[];
if(process.argv.includes('--remove-resolved')){
 assert.equal(result.errors.length,0,'Capture errors cannot be waived');assert.equal(result.added.length,0,'New diagnostics must be fixed; this command cannot add exceptions');
 const ids=new Set(result.resolved.map(e=>JSON.stringify([e.screen,e.theme,e.kind,e.diagnostic,e.occurrence])));
 list.entries=list.entries.filter(e=>{if(ids.has(JSON.stringify([e.screen,e.theme,e.kind,e.diagnostic,e.occurrence]))){removed.push(e);return false;}return true;});
 await writeFile(path,JSON.stringify(list,null,2)+'\n');result=evaluateGate(current,list.entries.filter(inScope),capture.errors);
}
await writeFile(join(out,'scoped-gate.json'),JSON.stringify({scope:{screens,files},removed,result},null,2)+'\n');
console.log(JSON.stringify({scoped:true,current:current.length,allowed:list.entries.filter(inScope).length,new:result.added.length,stale:result.resolved.length,errors:result.errors.length,removed:removed.length}));
for(const e of result.added)console.log('New:',JSON.stringify(e));
for(const e of result.resolved)console.log('Stale:',JSON.stringify(e));
process.exitCode=result.code;
