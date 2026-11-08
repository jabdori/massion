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
 assert.equal((await check('- navigation:\n  - text: 12:30 · 13:30',twice)).status,0);
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
test('duration placeholders require a whole duration segment',async()=>{
 const expected={...contract,regions:[{region:'rail',elements:[{role:'status',text:'{duration}',required:true}]}]};
 assert.equal((await check('- navigation:\n  - text: 실행 중 · 4분',expected)).status,0);
 assert.equal((await check('- navigation:\n  - text: 실행 중',expected)).status,1);
});
test('ancestor and descendant text aliases cannot satisfy repeated requirements',async()=>{
 const times=(count:number)=>({...contract,regions:[{region:'rail',elements:Array.from({length:count},()=>({role:'text',text:'{time}',required:true}))}]});
 for(const [snapshot,count,status] of [
  ['- navigation:\n  - button "12:30"\n    - text: 12:30',2,1],
  ['- navigation:\n  - button "12:30"\n    - generic "12:30"\n      - StaticText "12:30"',2,1],
  ['- navigation:\n  - button "12:30"\n    - text: 12:30\n  - button "12:30"\n    - text: 12:30',2,0],
  ['- navigation:\n  - button "12:30 13:30"\n    - text: 13:30',2,0],
  ['- navigation:\n  - button "12:30 13:30"\n    - text: 13:30',3,1],
  ['- navigation:\n  - button "12:30 12:30"\n    - text: 12:30\n    - text: 12:30',2,0],
  ['- navigation:\n  - button "12:30 12:30"\n    - text: 12:30\n    - text: 12:30',3,1],
 ] as const){
  const result=await check(snapshot,times(count));assert.equal(result.status,status,result.stdout+result.stderr);
 }
});
test('semantic and joined text matches consume the same descendant occurrences',async()=>{
 const expected={...contract,regions:[{region:'rail',elements:[{role:'heading',text:'첫 번째',required:true},{role:'text',text:'첫 번째',required:true}]}]};
 const snapshot='- navigation:\n  - heading "첫 번째"\n    - text: 첫\n    - text: 번째';
 assert.equal((await check(snapshot,expected)).status,1);
 assert.equal((await check(snapshot+'\n  - text: 첫\n  - text: 번째',expected)).status,0);
 const repeated={...contract,regions:[{region:'rail',elements:[{role:'text',text:'12:30 12:30',required:true}]}]};
 assert.equal((await check('- navigation:\n  - heading "12:30"\n    - text: 12:30',repeated)).status,1);
});

for(const {name,snapshot,elements,passed,failed} of [
 {name:'unrepresented landmark text cannot satisfy a requirement',snapshot:'- navigation \"분기 보고서\":\n  - text: 보고서',elements:['분기 보고서'],passed:0,failed:1},
 {name:'one title cannot satisfy three placeholders',snapshot:'- text: 분기 보고서',elements:['{work_title}','{work_title}','{work_title}'],passed:1,failed:2},
 {name:'named description-list terms retain their occurrence',snapshot:'- term \"분기 보고서\"',elements:['{work_title}','{work_title}'],passed:1,failed:1},
 {name:'equal sibling titles remain independent',snapshot:'- text: 분기 보고서\n- text: 분기 보고서\n- text: 분기 보고서',elements:['{work_title}','{work_title}','{work_title}'],passed:3,failed:0},
 {name:'standalone content consumes a whole label',snapshot:'- text: 분기 보고서',elements:['{content}','{content}'],passed:1,failed:1},
 {name:'bullet and semicolon delimit whole segments',snapshot:'- text: 첫 보고서 • 둘 보고서; 셋 보고서',elements:['{work_title}','{work_title}','{work_title}'],passed:3,failed:0},
 {name:'spaces inside a title are not separators',snapshot:'- text: 분기 보고서',elements:['{work_title}','보고서'],passed:1,failed:1},
 {name:'explicit separator segments are consumed whole',snapshot:'- text: 분기 보고서 · 주간 보고서',elements:['{work_title}','{work_title}','{work_title}'],passed:2,failed:1},
 {name:'typed placeholders cannot consume a partial segment',snapshot:'- text: 12:30 13:30',elements:['{time}','{time}'],passed:0,failed:2},
 {name:'typed placeholders consume distinct separated segments',snapshot:'- text: 12:30 | 13:30',elements:['{time}','{time}'],passed:2,failed:0},
 {name:'joined labels are not limited to four text nodes',snapshot:'- text: 이번\n- text: 분기\n- text: 매출\n- text: 보고서\n- text: 완료',elements:['이번 분기 매출 보고서 완료'],passed:1,failed:0},
 {name:'embedded template consumes its entire segment',snapshot:'- text: 알림: 분기 보고서 완료 · 다음',elements:['{work_title} 완료','보고서','다음'],passed:2,failed:1},
 {name:'a parent alias cannot move later text before an earlier sibling',snapshot:'- button "나중"\n  - text: 먼저\n  - text: 나중',elements:['나중','먼저'],passed:1,failed:1},
 {name:'partial parent aliases retain canonical child order',snapshot:'- button "먼저 · 나중"\n  - text: 나중',elements:['먼저','나중'],passed:2,failed:0},
 {name:'reordered ancestor labels do not manufacture occurrences',snapshot:'- button \"나중 먼저\"\n  - text: 먼저\n  - text: 나중',elements:['나중','먼저'],passed:1,failed:1},
 {name:'escaped newlines delimit complete title segments',snapshot:'- text \"분기 보고서\\n주간 보고서\"',elements:['{work_title}','{work_title}'],passed:2,failed:0},
 {name:'nested aliases do not create extra occurrences',snapshot:'- button "분기 보고서"\n  - generic "분기 보고서"\n    - text: 분기 보고서',elements:['{work_title}','{work_title}'],passed:1,failed:1},
])test('occurrence matching: '+name,async()=>{
 const result=await check('- navigation:\n'+snapshot.split('\n').map(line=>'  '+line).join('\n'),{...contract,forbidden:[],regions:[{region:'rail',elements:elements.map(text=>({role:'text',text,required:true}))}]});
 assert.equal((result.stdout.match(/^  ok    /gm)||[]).length,passed,result.stdout+result.stderr);
 assert.match(result.stdout,new RegExp(`(?:PASS|FAIL): ${failed} failures,`));
 assert.equal(result.status,failed?1:0);
});

const repeatedSentence='This sentence is repeated in separate nodes.';
for(const {name,snapshot,chars,strings,sentences,failures} of [
 {name:'equal sibling sentences count twice',snapshot:`- text: ${repeatedSentence}\n- text: ${repeatedSentence}`,chars:88,strings:2,sentences:2,failures:2},
 {name:'equal named terms count twice',snapshot:`- term \"${repeatedSentence}\"\n- term \"${repeatedSentence}\"`,chars:88,strings:2,sentences:2,failures:2},
 {name:'parent and text child count once',snapshot:`- button "${repeatedSentence}"\n  - text: ${repeatedSentence}`,chars:44,strings:1,sentences:1,failures:0},
 {name:'equal sibling containers count twice',snapshot:`- button "${repeatedSentence}"\n  - text: ${repeatedSentence}\n- button "${repeatedSentence}"\n  - text: ${repeatedSentence}`,chars:88,strings:2,sentences:2,failures:2},
 {name:'overlapping sibling labels retain their full identities',snapshot:'- button \"보고서 보고\"\n  - text: 보고\n  - text: 보고서',chars:5,strings:2,sentences:0,failures:0},
 {name:'unmatched parent text and its child count once each',snapshot:'- button \"Report Results\"\n  - text: Results',chars:13,strings:2,sentences:0,failures:0},
 {name:'reordered ancestor names do not add budget text',snapshot:'- button \"나중 먼저\"\n  - text: 먼저\n  - text: 나중',chars:4,strings:2,sentences:0,failures:0},
 {name:'named heading and split text count the leaf occurrences',snapshot:'- heading "첫 번째"\n  - text: 첫\n  - text: 번째',chars:3,strings:2,sentences:0,failures:0},
])test('occurrence budgets: '+name,async()=>{
 const result=await check('- navigation:\n'+snapshot.split('\n').map(line=>'  '+line).join('\n'),{...contract,forbidden:[],regions:[],text_budget:{rail:{chars:43,strings:1,sentences:1,longest:44}}});
 const match=/app (\{[^\n]+\}) proto/.exec(result.stdout);assert.ok(match,result.stdout+result.stderr);
 const got=JSON.parse(match[1]!);assert.equal(got.chars,chars);assert.equal(got.strings,strings);assert.equal(got.sentences,sentences);
 assert.match(result.stdout,new RegExp(`(?:PASS|FAIL): ${failures} failures,`));
});

for(const {name,snapshot,pattern,hits} of [
 {name:'unrepresented landmark prefix creates no forbidden occurrence',snapshot:'- navigation \"분기 보고서\":\n  - text: 보고서',pattern:'^분기 보고서$',hits:0},
 {name:'overlapping matches reach every affected occurrence',snapshot:'- heading \"go go go\"\n  - text: go go\n  - text: go',pattern:'go go',hits:2},
 {name:'named terms participate in forbidden checks',snapshot:'- term \"Results\"',pattern:'^Results$',hits:1},
 {name:'parent and child are one forbidden occurrence',snapshot:'- button "Results"\n  - text: Results',pattern:'^Results$',hits:1},
 {name:'identical siblings are two forbidden occurrences',snapshot:'- button "Results"\n  - text: Results\n- button "Results"\n  - text: Results',pattern:'^Results$',hits:2},
 {name:'nested aliases do not add forbidden hits',snapshot:'- button "Results"\n  - generic "Results"\n    - text: Results',pattern:'Results',hits:1},
 {name:'reordered ancestor aliases do not add forbidden hits',snapshot:'- button \"Results Later\"\n  - text: Later\n  - text: Results',pattern:'Results',hits:1},
 {name:'a folded label preserves a cross-node forbidden pattern',snapshot:'- heading "Bad copy"\n  - text: Bad\n  - text: copy',pattern:'^Bad copy$',hits:2},
])test('occurrence forbidden checks: '+name,async()=>{
 const result=await check('- navigation:\n'+snapshot.split('\n').map(line=>'  '+line).join('\n'),{...contract,regions:[],forbidden:[pattern]});
 assert.equal((result.stdout.match(/^  FAIL  forbidden /gm)||[]).length,hits,result.stdout+result.stderr);
 assert.equal(result.status,hits?1:0);
});

for(const {name,snapshot,elements,passed,failed} of [
 {name:'textbox labels do not gain suffix matching',snapshot:'- textbox \"다른 답변 입력\"',elements:[['textbox','답변 입력']],passed:0,failed:1},
 {name:'one control cannot fulfill two structural requirements',snapshot:'- button "하나 · 퀼"\n  - text: 하나\n  - text: 퀼',elements:[['button','{member}'],['button','{member}']],passed:1,failed:1},
 {name:'separate controls can have identical labels',snapshot:'- button "하나"\n  - text: 하나\n- button "하나"\n  - text: 하나',elements:[['button','{member}'],['button','{member}']],passed:2,failed:0},
 {name:'control and text requirements cannot reuse one occurrence',snapshot:'- button "12:30"\n  - text: 12:30',elements:[['button','{time}'],['text','{time}']],passed:1,failed:1},
 {name:'a control can be followed by distinct status text',snapshot:'- button "분기 보고서 완료"\n  - text: 분기 보고서\n  - text: 완료',elements:[['link','{work_title}'],['status','완료']],passed:2,failed:0},
])test('occurrence roles: '+name,async()=>{
 const result=await check('- navigation:\n'+snapshot.split('\n').map(line=>'  '+line).join('\n'),{...contract,forbidden:[],regions:[{region:'rail',elements:elements.map(([role,text])=>({role,text,required:true}))}]});
 assert.equal((result.stdout.match(/^  ok    /gm)||[]).length,passed,result.stdout+result.stderr);
 assert.match(result.stdout,new RegExp(`(?:PASS|FAIL): ${failed} failures,`));
});

for(const [description,label,passed,failed] of [
 ['삭제된 보고서','삭제된 보고서',0,1],
 ['보고서','보고서',1,0],
] as const)test('occurrence descriptions: '+description,async()=>{
 const snapshot=JSON.stringify({tree:{role:'webarea',children:[{role:'navigation',children:[{role:'button',name:'보고서',description}]}]}});
 const result=await check(snapshot,{...contract,regions:[{region:'rail',elements:[{role:'button',text:label,required:true}]}],forbidden:['^삭제된 보고서$'],text_budget:{rail:{chars:3,strings:1,sentences:0,longest:3}}});
 assert.equal((result.stdout.match(/^  ok    /gm)||[]).length,passed,result.stdout+result.stderr);
 assert.equal((result.stdout.match(/^  FAIL  forbidden /gm)||[]).length,0,result.stdout);
 assert.match(result.stdout,new RegExp(`(?:PASS|FAIL): ${failed} failures,`));
 assert.match(result.stdout,/app {"chars":3,"strings":1,"sentences":0,"longest":3}/);
});
