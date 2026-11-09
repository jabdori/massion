import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnostics,copyDiagnostics,evaluateGate,updateAllowList,readCapture} from '../scripts/ui-contracts/gate.ts';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const diagnostic={screen:'B1',theme:'dark',kind:'contract',diagnostic:'missing header button "보내기"',occurrence:1};
const entry={...diagnostic,category:'capability',reason:'No producer.',ledger:'docs/acceptance/E3e/residuals.md#b1-dark'};
test('allowed occurrences pass, new failures and stale exceptions fail',()=>{
 assert.equal(evaluateGate([diagnostic],[entry]).code,0);
 assert.equal(evaluateGate([diagnostic],[]).code,1);
 const stale=evaluateGate([],[entry]);assert.equal(stale.code,1);assert.equal(stale.resolved.length,1);
});
test('infrastructure errors always fail even with matching exceptions',()=>{
 assert.equal(evaluateGate([diagnostic],[entry],['Chrome unavailable']).code,1);
});
test('diagnostic multiplicity is retained independently of unrelated output order',()=>{
 const rows=diagnostics('B1','dark','contract',['missing header','another failure','missing header']);
 assert.deepEqual(rows.map(row=>row.occurrence),[1,1,2]);
 assert.equal(evaluateGate(rows,[{...rows[0]!,...{category:entry.category,reason:entry.reason,ledger:entry.ledger}}]).added.length,2);
});
test('every copy finding is gated and source line changes preserve identity',()=>{
 const finding={file:'src/example-panel.ts',context:'html-text',reason:'english-copy',text:'Hello',blocking:false,line:1,column:2};
 const before=copyDiagnostics([finding]);
 assert.deepEqual(before,copyDiagnostics([{...finding,line:20,column:40}]));
 assert.equal(evaluateGate(before,[]).code,1);
});
test('updates only remove; additions require both an explicit flag and ledger reasons',()=>{
 const extra={...diagnostic,diagnostic:'new failure'};
 assert.deepEqual(updateAllowList([diagnostic,extra],[entry]),[entry]);
 assert.deepEqual(updateAllowList([],[entry]),[]);
 assert.throws(()=>updateAllowList([extra],[],true,[]),/reason/);
 assert.deepEqual(updateAllowList([extra],[],true,[{...entry,...extra}]),[{...entry,...extra}]);
 assert.deepEqual(updateAllowList([diagnostic,extra],[],true,[entry]),[entry]);
 assert.throws(()=>evaluateGate([diagnostic],[{...entry,ledger:''}]),/ledger/);
 assert.throws(()=>evaluateGate([diagnostic],[entry,entry]),/Duplicate/);
});
test('capture reader rejects missing rows, missing checker output and mismatched counts',async()=>{
 const out=await mkdtemp(join(tmpdir(),'massion-gate-'));
 try{
  const row={screen:'B1',theme:'dark',failed:1,visualFailures:[],gaps:[],errors:[]};
  await writeFile(join(out,'report.json'),JSON.stringify({rows:[row]}));
  await assert.rejects(readCapture(out,['B1/dark','B1/light']),/coverage/);
  await assert.rejects(readCapture(out,['B1/dark']),/ENOENT/);
  await mkdir(join(out,'checks/dark'),{recursive:true});
  await writeFile(join(out,'checks/dark/B1.txt'),'PASS: 0 failures, 0 warnings, 1 required elements\n');
  await assert.rejects(readCapture(out,['B1/dark']),/count/);
  await writeFile(join(out,'checks/dark/B1.txt'),'  FAIL  missing header\nFAIL: 1 failures, 0 warnings, 1 required elements\n');
  assert.equal((await readCapture(out,['B1/dark'])).diagnostics.length,1);
  await writeFile(join(out,'report.json'),JSON.stringify({rows:[{...row,errors:['Chrome unavailable']}]}));
  assert.equal((await readCapture(out,['B1/dark'])).errors.length,1);
 }finally{await rm(out,{recursive:true,force:true});}
});
