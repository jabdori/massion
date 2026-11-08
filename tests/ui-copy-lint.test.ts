import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const script=new URL('../scripts/ui-contracts/copy-lint.mjs',import.meta.url);
const copy={send:{ko:'보내기',roles:['button'],used_in:['example']},close:{ko:'닫기'},progress:{ko:'작업 중: {work_title}'},brand:{ko:'Massion'},entity:{ko:'확인 & 닫기'}};
async function run(files:Record<string,string>,table:unknown=copy,nestedScript?:string){
 const root=await mkdtemp(join(tmpdir(),'massion-copy-lint-'));
 try{
  await mkdir(join(root,'src','nested'),{recursive:true});
  await mkdir(join(root,'docs/product/screens'),{recursive:true});
  for(const [name,source] of Object.entries(files))await writeFile(join(root,'src',name),source);
  if(table!==null)await writeFile(join(root,'docs/product/screens/copy.ko.json'),typeof table==='string'?table:JSON.stringify(table));
  let command=script.pathname;
  if(nestedScript!==undefined){
   await mkdir(join(root,'tests'));
   await mkdir(join(root,'scripts/ui-contracts/nested'),{recursive:true});
   await writeFile(join(root,'scripts/ui-contracts/nested/probe.mjs'),nestedScript);
   await writeFile(join(root,'scripts/ui-contracts/copy-lint.mjs'),await readFile(script));
   command=join(root,'scripts/check.mjs');
   await writeFile(command,await readFile(new URL('../scripts/check.mjs',import.meta.url)));
   await symlink(new URL('../node_modules',import.meta.url).pathname,join(root,'node_modules'),'dir');
  }
  return spawnSync(process.execPath,[command,root],{encoding:'utf8',env:{...process.env,UI_CONTRACTS_BLOCKING:'1'}});
 }finally{await rm(root,{recursive:true,force:true});}
}
function report(result:ReturnType<typeof spawnSync>){
 assert.equal(result.status,0,String(result.stderr));
 return JSON.parse(String(result.stdout));
}

test('copy lint reports English and unapproved Korean in HTML text and visible attributes with locations',async()=>{
 const result=report(await run({'sample-panel.ts':[
  'export const panel=String.raw`<section id="internal" data-label="internal" aria-label="English region">',
  '<button title="도움말">New action</button><input placeholder="Search" value="internal">',
  '<img alt="Picture"><input type="submit" value="Submit"><option label="Choice">미승인</option>',
  '<button>보내기</button><span>확인 &amp; 닫기</span><span>&#xB2EB;&#xAE30;</span>',
  '<!-- Ignore this --><style>.x{content:"CSS text"}</style></section>`;'
 ].join('\n')}));
 assert.equal(result.mode,'report-only');
 assert.deepEqual(result.findings.map((f:any)=>f.text),['English region','도움말','New action','Search','Picture','Submit','Choice','미승인']);
 assert.equal(result.findings[0].file,'src/sample-panel.ts');
 assert.equal(result.findings[0].line,1);
 assert.equal(result.findings.find((f:any)=>f.text==='New action').line,2);
 assert.ok(result.findings.every((f:any)=>f.column>0));
 assert.equal(result.findings.find((f:any)=>f.text==='미승인').reason,'unapproved-copy');
 assert.equal(result.findings[0].reason,'english-copy');
});

test('copy lint scans DOM writes and the existing element helper without linting selectors or conditions',async()=>{
 const result=report(await run({'surface-shell.ts':[
  'node.textContent=ready ? "Ready" : "대기 중";',
  'node["innerText"]="Other"; node.title="Tooltip"; node.placeholder="Type here";',
  'node.setAttribute("aria-label","Label"); node.setAttribute("data-state","internal");',
  'element("button","Click","internal-class"); document.createTextNode("Text node");',
  'node.append("Appended"); node.replaceChildren("Replacement");',
  'node.textContent=state==="pending" ? "보내기" : "닫기";',
  'node.textContent=document.querySelector(".internal").value;',
  'const path="/api/private"; const state="pending"; console.log("debug");'
 ].join('\n')}));
 assert.deepEqual(result.findings.map((f:any)=>f.text),['Ready','대기 중','Other','Tooltip','Type here','Label','Click','Text node','Appended','Replacement']);
});

test('copy lint parses embedded raw clients and inline scripts without executing source',async()=>{
 const result=report(await run({'workbench.ts':[
  'throw new Error("Must never execute");',
  'export const page=String.raw`<h1>Heading</h1><script>',
  'const selector="internal"; node.textContent="Inline status";',
  '</script>`;',
  'export const shellClient=String.raw`',
  'node.innerText="Client status"; element("span","Client helper");',
  '`;'
 ].join('\n')}));
 assert.deepEqual(result.findings.map((f:any)=>[f.text,f.line]),[['Heading',2],['Inline status',3],['Client status',6],['Client helper',6]]);
});

test('copy lint recognizes approved templates but reports unapproved static parts and ignores dynamic data',async()=>{
 const result=report(await run({'sample-panel.ts':[
  'const panel=`<p>작업 중: ${work.title}</p><button>${ready ? "보내기" : "Cancel"}</button>`;',
  'node.textContent=`작업 중: ${work.title}`;',
  'node.textContent="작업 중: "+work.title;',
  'node.textContent=`Unknown ${work.title}`;',
  'node.textContent="Unknown "+work.title;',
  'node.textContent=work.title; node.textContent="Massion";',
  'node.textContent="   보내기   "; node.textContent="→"; node.textContent="42";'
 ].join('\n')}));
 assert.deepEqual(result.findings.map((f:any)=>f.text),['Cancel','Unknown {dynamic}','Unknown {dynamic}']);
});

test('copy lint limits discovery to top-level panels, shell and workbench and exposes extraction limits',async()=>{
 const result=report(await run({'one-panel.ts':'node.textContent="Panel";','surface-shell.ts':'node.textContent="Shell";','workbench.ts':'node.textContent="Workbench";','server.ts':'node.textContent="Server";','nested/hidden-panel.ts':'node.textContent="Nested";'}));
 assert.deepEqual(result.files,['src/one-panel.ts','src/surface-shell.ts','src/workbench.ts']);
 assert.deepEqual(result.findings.map((f:any)=>f.text),['Panel','Shell','Workbench']);
 assert.match(result.limits.join(' '),/dynamic|indirect/i);
});

test('copy lint handles HTML writes and interpolated visible attributes without inspecting internal attributes',async()=>{
 const result=report(await run({'sample-panel.ts':[
  'node.innerHTML=`Greeting ${user.name}`;',
  'node.insertAdjacentHTML("beforeend","Inserted text");',
  'const panel=`<button data-state="${ready ? "internal" : "other"}" aria-label="${ready ? "보내기" : "Cancel"}">닫기</button>`;',
  'node.innerHTML="<button>Nested</button>";',
  'node.textContent=ready && "Visible";',
  'const style=String.raw`.box::before{content:"CSS text"}`;'
 ].join('\n')}));
 assert.deepEqual(result.findings.map((f:any)=>f.text),['Greeting {dynamic}','Inserted text','Cancel','Nested','Visible']);
});

test('copy lint reports missing or malformed approval tables as infrastructure errors',async()=>{
 for(const table of [null,{}, {send:{ko:42}},'invalid JSON']){
  const result=await run({'one-panel.ts':'node.textContent="Hello";'},table);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/copy\.ko\.json/);
 }
});

test('aggregate checks recurse into contract scripts and remain advisory for copy findings',async()=>{
 const files={'one-panel.ts':'node.textContent="Hello";'};
 const valid=await run(files,copy,'export const value=1;');
 assert.equal(valid.status,0,valid.stderr);
 assert.match(valid.stdout,/Copy lint: 1 findings in 1 files \(report-only\)/);
 const invalid=await run(files,copy,'export const = ;');
 assert.notEqual(invalid.status,0);
 assert.match(invalid.stderr,/nested\/probe\.mjs/);
 assert.match(invalid.stderr,/SyntaxError/);
});
