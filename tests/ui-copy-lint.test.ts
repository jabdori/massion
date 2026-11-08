import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const script=new URL('../scripts/ui-contracts/copy-lint.mjs',import.meta.url);
const copy={send:{ko:'보내기',roles:['button'],used_in:['example']},close:{ko:'닫기'},progress:{ko:'작업 중: {work_title}'},brand:{ko:'Massion'},entity:{ko:'확인 & 닫기'}};
async function run(files:Record<string,string>,table:unknown=copy,nestedScript?:string,generatedTokens?:string){
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
   await writeFile(join(root,'scripts/generate-ui-tokens.mjs'),await readFile(new URL('../scripts/generate-ui-tokens.mjs',import.meta.url)));
   await writeFile(join(root,'docs/product/screens/visual.json'),await readFile(new URL('../docs/product/screens/visual.json',import.meta.url)));
   await writeFile(join(root,'src/ui-tokens.ts'),generatedTokens??await readFile(new URL('../src/ui-tokens.ts',import.meta.url),'utf8'));
   command=join(root,'scripts/check.mjs');
   await writeFile(command,await readFile(new URL('../scripts/check.mjs',import.meta.url)));
   await symlink(new URL('../node_modules',import.meta.url).pathname,join(root,'node_modules'),'dir');
  }
  return spawnSync(process.execPath,[command,root],{cwd:tmpdir(),encoding:'utf8',env:{...process.env,UI_CONTRACTS_BLOCKING:'1'}});
 }finally{await rm(root,{recursive:true,force:true});}
}
function report(result:ReturnType<typeof spawnSync>,status=0){
 assert.equal(result.status,status,String(result.stderr));
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
 assert.equal(result.mode,'scoped-blocking');
 assert.deepEqual(result.findings.map((f:any)=>f.text),['English region','도움말','New action','Search','Picture','Submit','Choice','미승인']);
 assert.equal(result.findings[0].file,'src/sample-panel.ts');
 assert.equal(result.findings[0].line,1);
 assert.equal(result.findings.find((f:any)=>f.text==='New action').line,2);
 assert.ok(result.findings.every((f:any)=>f.column>0));
 assert.equal(result.findings.find((f:any)=>f.text==='미승인').reason,'unapproved-copy');
 assert.equal(result.findings[0].reason,'english-copy');
});

test('copy lint scans DOM writes and the existing element helper without linting selectors or conditions',async()=>{
 const result=report(await run({'sample-panel.ts':[
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
 ].join('\n')}),1);
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

test('copy lint discovers panels, shell, workbench and the two rendered source helpers',async()=>{
 const result=report(await run({'one-panel.ts':'node.textContent="Panel";','surface-shell.ts':'node.textContent="Shell";','workbench.ts':'node.textContent="Workbench";','accepted-result-source-draft.ts':'node.textContent="Accepted source";','owner-file-document-draft.ts':'node.textContent="File source";','server.ts':'node.textContent="Server";','nested/hidden-panel.ts':'node.textContent="Nested";','misc-helper.ts':'node.textContent="Misc";'}),1);
 assert.deepEqual(result.files,['src/accepted-result-source-draft.ts','src/one-panel.ts','src/owner-file-document-draft.ts','src/surface-shell.ts','src/workbench.ts']);
 assert.deepEqual(result.findings.map((f:any)=>f.text),['Accepted source','Panel','File source','Shell','Workbench']);
 assert.ok(result.findings.filter((f:any)=>f.file.endsWith('-draft.ts')).every((f:any)=>f.blocking));
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
 assert.match(valid.stdout,/Copy lint: 1 findings in 1 files \(0 blocking, 1 report-only\)/);
 const invalid=await run(files,copy,'export const = ;');
 assert.notEqual(invalid.status,0);
 assert.match(invalid.stderr,/nested\/probe\.mjs/);
 assert.match(invalid.stderr,/SyntaxError/);
});

test('E3a files block even approved visible literals while legacy panels only report drift',async()=>{
 const files=Object.fromEntries(['surface-shell.ts','assistant-conversation-panel.ts','settings-panel.ts','apps-panel.ts','members-panel.ts','results-panel.ts','schedules-panel.ts','workbench.ts'].map(name=>[name,'node.textContent="보내기";']));
 files['legacy-panel.ts']='node.textContent="보내기"; node.title="Legacy";';
 const result=report(await run(files),1);
 assert.equal(result.findings.filter((f:any)=>f.blocking).length,8);
 assert.ok(result.findings.filter((f:any)=>f.blocking).every((f:any)=>f.reason==='unkeyed-copy'&&f.text==='보내기'));
 assert.deepEqual(result.findings.filter((f:any)=>!f.blocking).map((f:any)=>[f.file,f.text]),[['src/legacy-panel.ts','Legacy']]);
});

test('keyed copy works in DOM, HTML, embedded clients and host interpolations without treating keys as text',async()=>{
 const result=report(await run({'workbench.ts':[
  'node.textContent=copy("send"); node.title=copy("progress",{work_title:work.title});',
  'const page=String.raw`<button title="${copy("close")}">${copy("send")}</button><script>${uiCopyClient}',
  'node.textContent=copy("send"); node.innerHTML="<b></b>";',
  'node.title="${copy("progress",{work_title:"보내기"})}";</script>`;',
  'const shellClient=String.raw`node.title=copy("close"); node.textContent="${copy("send")}";`;',
  'const panel=`<p>${copy("progress",{work_title:"<b>private text</b>"})}</p>`;',
  'node.textContent=work.title; node.textContent="→"; node.textContent="42";'
 ].join('\n')}));
 assert.deepEqual(result.findings,[]);
});

test('keyed files reject approved HTML, DOM and interpolated literal fallbacks',async()=>{
 const result=report(await run({'surface-shell.ts':[
  'const panel=`<button title="보내기">닫기</button><span>${ready ? copy("send") : "보내기"}</span>`;',
  'node.textContent=`작업 중: ${work.title}`;',
  'const shellClient=String.raw`node.title="닫기";`;',
  'node.title=copy("send")+" 닫기";'
 ].join('\n')}),1);
 assert.deepEqual(result.findings.map((f:any)=>f.text),['보내기','닫기','보내기','작업 중: {dynamic}','닫기','{dynamic} 닫기']);
 assert.ok(result.findings.every((f:any)=>f.blocking&&f.reason==='unkeyed-copy'));
});

test('copy calls validate static keys and placeholders even outside visible writes',async()=>{
 const result=report(await run({'settings-panel.ts':[
  'const unknown=copy("missing"); const inherited=copy("toString"); copy();',
  'copy("progress"); copy("progress",{}); copy("progress",{other:"value"});',
  'copy("send",{extra:"value"}); copy("progress",{work_title:work.title,extra:1});',
  'const settingsClient=String.raw`const label=copy("missing.client");`;',
  'const panel=`<button>${copy("missing.host")}</button>`;',
  'copy(key,values); copy("progress",values); copy("progress",{...values});',
  'copy("progress",{work_title}); copy("progress",{"work_title":work.title});',
  'copy("progress",{[field]:work.title});'
 ].join('\n')}),1);
 assert.deepEqual(result.findings.map((f:any)=>[f.line,f.reason]),[
  [1,'unknown-copy-key'],[1,'unknown-copy-key'],[1,'missing-copy-key'],
  [2,'missing-copy-placeholder'],[2,'missing-copy-placeholder'],[2,'missing-copy-placeholder'],[2,'unknown-copy-placeholder'],
  [3,'unknown-copy-placeholder'],[3,'unknown-copy-placeholder'],[4,'unknown-copy-key'],[5,'unknown-copy-key']
 ]);
 assert.ok(result.findings.every((f:any)=>f.blocking));
});

test('copy-call errors in legacy panels remain advisory',async()=>{
 const result=report(await run({'legacy-panel.ts':'node.textContent=copy("missing"); copy("progress");'}));
 assert.deepEqual(result.findings.map((f:any)=>f.reason),['unknown-copy-key','missing-copy-placeholder']);
 assert.ok(result.findings.every((f:any)=>!f.blocking));
});

test('nested host copy calls retain original locations and validate keys and placeholders exactly once',async()=>{
 const result=report(await run({'workbench.ts':[
  'const page=String.raw`<script>${uiCopyClient}',
  'node.title="${copy("missing.inline")}";',
  'node.textContent="${copy("progress")}";</script>`;',
  'const chatClient=String.raw`node.title="${copy("missing.client")}";`;',
  'copy("progress",{work_title:`${copy("missing.nested")}`});'
 ].join('\n')}),1);
 assert.deepEqual(result.findings.map((f:any)=>[f.line,f.column,f.reason,f.text]),[
  [2,15,'unknown-copy-key','missing.inline'],
  [3,21,'missing-copy-placeholder','progress: work_title'],
  [4,43,'unknown-copy-key','missing.client'],
  [5,32,'unknown-copy-key','missing.nested']
 ]);
});

test('copy placeholders validate literal computed names and statically absent values',async()=>{
 const result=report(await run({'settings-panel.ts':[
  'copy("progress",{["other"]:work.title});',
  'copy("progress",undefined); copy("progress",null);',
  'copy("progress",{["work_title"]:work.title});',
  'copy("progress",{...values,extra:1});'
 ].join('\n')}),1);
 assert.deepEqual(result.findings.map((f:any)=>[f.line,f.reason,f.text]),[
  [1,'missing-copy-placeholder','progress: work_title'],[1,'unknown-copy-placeholder','progress: other'],
  [2,'missing-copy-placeholder','progress: work_title'],[2,'missing-copy-placeholder','progress: work_title'],
  [4,'unknown-copy-placeholder','progress: extra']
 ]);
});

test('aggregate checks block E3a copy without changing the full-screen harness switch',async()=>{
 const invalid=await run({'workbench.ts':'node.textContent="보내기";'},copy,'export const value=1;');
 assert.equal(invalid.status,1,invalid.stderr);
 assert.match(invalid.stdout,/src\/workbench.ts:1:1[0-9]: unkeyed-copy: "보내기"/);
 assert.match(invalid.stdout,/1 blocking, 0 report-only/);
 const valid=await run({'workbench.ts':'node.textContent=copy("send");','legacy-panel.ts':'node.textContent="Legacy";'},copy,'export const value=1;');
 assert.equal(valid.status,0,valid.stderr);
 assert.match(valid.stdout,/0 blocking, 1 report-only/);
});

test('aggregate checks reject generated token drift before copy lint from another directory',async()=>{
 const result=await run({'workbench.ts':'node.textContent="보내기";'},copy,'export const value=1;','export const uiTokensStyle="stale";');
 assert.equal(result.status,1,result.stderr);
 assert.match(result.stderr,/UI tokens are out of date/);
 assert.doesNotMatch(result.stdout,/Copy lint:/);
});
