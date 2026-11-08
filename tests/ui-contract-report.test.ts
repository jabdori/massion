import {test} from 'node:test';
import assert from 'node:assert/strict';
const {parseCheck,exitCode,checkVisual,reportMarkdown}=await import('../scripts/ui-contracts/report.ts');
test('checker counts keep required element matches separate from forbidden and budget failures',()=>{
 const result=parseCheck('  ok    rail link "결과물"\n  FAIL  missing header\n  FAIL  forbidden /English/\nFAIL: 2 failures, 1 warnings, 2 required elements\n');
 assert.deepEqual(result,{passed:1,failed:2,warnings:1,required:2});
 assert.throws(()=>parseCheck('invalid snapshot'),/summary/);
});
test('report-only permits drift, blocking rejects drift and infrastructure errors always fail',()=>{
 const drift=[{failed:2,visualFailures:['rail'],gaps:['missing screen'],errors:[]}];
 assert.equal(exitCode(drift,false),0);assert.equal(exitCode(drift,true),1);
 assert.equal(exitCode([{...drift[0]!, errors:['Chrome unavailable']}],false),1);
 assert.equal(exitCode([{failed:0,visualFailures:[],gaps:[],errors:[]}],true),0);
 assert.equal(exitCode([{failed:0,visualFailures:[],gaps:['no artboard'],errors:[]}],true),1);
});
test('visual checks catch missing tokens, hidden regions and geometry drift with a two pixel tolerance',()=>{
 const contract={visual:{regions:{rail:[0,0,52,900] as [number,number,number,number]}}};const spec={tokens:{'--bg-0':'rgb(11, 12, 14)'}};
 assert.deepEqual(checkVisual(contract,spec,{tokens:spec.tokens,regions:{rail:[1,0,52,900]}}),[]);
 assert.equal(checkVisual(contract,spec,{tokens:{},regions:{rail:null}}).length,2);
 assert.equal(checkVisual(contract,spec,{tokens:spec.tokens,regions:{rail:[0,0,58,900]}}).length,1);
});
test('Markdown reports each screen with links to evidence and explicit setup gaps',()=>{
 const text=reportMarkdown([{screen:'B1',theme:'light',passed:2,failed:3,required:4,warnings:1,visualFailures:['rail'],gaps:['not implemented'],errors:[],pair:'pairs/light/B1.png'}],false);
 assert.match(text,/REPORT-ONLY/);assert.match(text,/\| B1 \| light \|/);assert.match(text,/not implemented/);assert.match(text,/pairs\/light\/B1.png/);
});
test('only structured missing-control failures are setup gaps; IPC and process failures stay errors',async()=>{
 const {isInteractionGap}=await import('../scripts/ui-contracts/report.ts');
 assert.equal(isInteractionGap({code:1,stdout:JSON.stringify({success:false,error:'Element not found: #missing. Verify the selector.'})}),true);
 assert.equal(isInteractionGap({code:1,stdout:JSON.stringify({success:false,error:'Wait timed out after 5000ms'})}),true);
 assert.equal(isInteractionGap({code:1,stdout:JSON.stringify({success:false,error:'IPC connection reset'})}),false);
 assert.equal(isInteractionGap({code:1,stdout:'not JSON'}),false);
 assert.equal(isInteractionGap({code:'ETIMEDOUT',stdout:JSON.stringify({success:false,error:'Element not found: #missing'})}),false);
});
test('browser interactions wait for initial synchronization and release of busy/loading guards',async()=>{
 const {workbenchReady}=await import('../scripts/ui-contracts/report.ts');
 const {runInNewContext}=await import('node:vm');
 const ready={chatView:{},busy:false,loading:false,reconnectRequired:false};
 assert.equal(runInNewContext(workbenchReady,ready),true);
 for(const flag of ['busy','loading','reconnectRequired'])assert.equal(runInNewContext(workbenchReady,{...ready,[flag]:true}),false,flag);
 assert.equal(runInNewContext(workbenchReady,{...ready,chatView:null}),false);
});

test('v2 resolves role tokens through the requested palette and catches light drift',async()=>{
 const {readFile}=await import('node:fs/promises');
 const spec=JSON.parse(await readFile(new URL('../docs/product/screens/visual.json',import.meta.url),'utf8'));
 for(const theme of ['dark','light'] as const){
  const palette=spec.palettes[theme];
  const tokens=Object.fromEntries(Object.entries(spec.tokens).map(([role,ref])=>[role,palette[String(ref).replace('--palette-','')]]));
  assert.deepEqual(checkVisual({},spec,{tokens,regions:{}},theme),[]);
  assert.ok(checkVisual({},spec,{tokens:{...tokens,'--bg-0':'wrong'},regions:{}},theme).some(f=>f.includes('--bg-0')));
 }
});
test('reports keep both theme rows and every evidence link distinct',()=>{
 const rows=(['dark','light'] as const).map(theme=>({screen:'B2',theme,passed:1,failed:2,required:3,warnings:0,visualFailures:[],gaps:[],errors:[],pair:`pairs/${theme}/B2.png`}));
 const text=reportMarkdown(rows,false);
 for(const theme of ['dark','light']){
  assert.ok(text.includes(`| B2 | ${theme} |`));
  for(const [dir,ext] of [['snapshots','txt'],['checks','txt'],['screenshots','png'],['visual','json']])assert.ok(text.includes(`${dir}/${theme}/B2.${ext}`));
 }
});
