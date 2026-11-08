import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const contract={artboard:'test',title:'Test',regions:[{region:'rail',elements:[{role:'link',text:'결과물',required:true},{role:'link',text:'예약',required:true}]}],forbidden:['^Results$'],text_budget:{}};
async function check(snapshot:string,expected:unknown=contract){const dir=await mkdtemp(join(tmpdir(),'ui-contract-'));try{
 await writeFile(join(dir,'snapshot.txt'),snapshot);await writeFile(join(dir,'contract.json'),JSON.stringify(expected));
 return spawnSync(process.execPath,['scripts/ui-contracts/contract-check.mjs',join(dir,'snapshot.txt'),join(dir,'contract.json')],{encoding:'utf8'});
}finally{await rm(dir,{recursive:true,force:true});}}
test('contract checker reads text and agent-browser JSON snapshots',async()=>{
 const snapshot='- navigation "Rail":\n  - button "결과물"\n  - button "예약"';
 for(const input of [snapshot,JSON.stringify({success:true,data:{snapshot}})]){const result=await check(input);assert.equal(result.status,0,result.stderr+result.stdout);assert.match(result.stdout,/PASS: 0 failures/);}
});
test('contract checker distinguishes missing, order, region and forbidden failures',async()=>{
 for(const [snapshot,kind] of [
 ['- navigation "Rail":\n  - button "예약"','missing'],
 ['- navigation "Rail":\n  - button "예약"\n  - button "결과물"','order'],
 ['- main:\n  - button "결과물"\n  - button "예약"','region'],
 ['- navigation "Rail":\n  - button "결과물"\n  - button "예약"\n  - button "Results"','forbidden'],
 ] as const){const result=await check(snapshot);assert.equal(result.status,1,result.stderr);assert.match(result.stdout,new RegExp('FAIL  '+kind));}
});
test('shell text budgets fail and optional example data does not become required',async()=>{
 const result=await check('- navigation:\n  - text: This is an unnecessary explanatory sentence.',{...contract,regions:[{region:'rail',elements:[{role:'text',text:'Example',required:false}]}],text_budget:{rail:{chars:0,sentences:0,longest:0}}});
 assert.equal(result.status,1);assert.match(result.stdout,/FAIL  budget rail/);assert.match(result.stdout,/0 required elements/);
});
test('semantic roles cannot be satisfied by plain text or an unrelated control',async()=>{
 for(const role of ['listbox','heading','table','columnheader','listitem','button','checkbox','option']){
  const result=await check('- navigation:\n  - text: 구성원\n  - link "구성원"',{...contract,regions:[{region:'rail',elements:[{role,text:'구성원',required:true}]}]});
  assert.equal(result.status,1,role+' '+result.stdout);
 }
});
test('one time occurrence cannot satisfy two required items and joined text keeps its actual order',async()=>{
 const twice={...contract,regions:[{region:'rail',elements:[{role:'text',text:'{time}',required:true},{role:'text',text:'{time}',required:true}]}]};
 assert.equal((await check('- navigation:\n  - text: 12:30',twice)).status,1);
 assert.equal((await check('- navigation:\n  - text: 12:30 13:30',twice)).status,0);
 const ordered={...contract,regions:[{region:'rail',elements:[{role:'text',text:'첫 번째',required:true},{role:'text',text:'두 번째',required:true}]}]};
 assert.equal((await check('- navigation:\n  - text: 두 번째\n  - text: 첫\n  - text: 번째',ordered)).status,1);
 assert.equal((await check('- navigation:\n  - text: 첫\n  - text: 번째\n  - text: 두 번째',ordered)).status,0);
});
test('shell budgets count control names even when another region has static text, without duplicating child text',async()=>{
 const budget={...contract,regions:[],text_budget:{rail:{chars:0,sentences:0,longest:0}}};
 const result=await check('- navigation:\n  - button "This is an unnecessary explanatory sentence."\n- main:\n  - StaticText "Body"',budget);
 assert.equal(result.status,1,result.stdout);assert.match(result.stdout,/FAIL  budget rail/);
 const short=await check('- navigation:\n  - button "1234567890abcdefghij"\n    - StaticText "1234567890abcdefghij"',budget);
 assert.equal(short.status,0,short.stdout);
});
test('duration placeholders require a duration and can start inside a status label',async()=>{
 const expected={...contract,regions:[{region:'rail',elements:[{role:'status',text:'{duration}',required:true}]}]};
 assert.equal((await check('- navigation:\n  - text: 실행 중 4분',expected)).status,0);
 assert.equal((await check('- navigation:\n  - text: 실행 중',expected)).status,1);
});
