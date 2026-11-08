import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=new URL('../',import.meta.url),generator=new URL('scripts/generate-ui-tokens.mjs',root),output=new URL('src/ui-tokens.ts',root);
const visual=JSON.parse(await readFile(new URL('docs/product/screens/visual.json',root),'utf8'));
const source=()=>readFile(output,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
const declarations=(block:string)=>Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m=>[m[1],m[2]!.trim()]));

test('token generation is deterministic, checked in and independent of the caller directory',async t=>{
 assert.ok(existsSync(generator),'The UI token generator must exist');
 const cwd=await mkdtemp(join(tmpdir(),'massion-ui-tokens-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const run=(flag:string)=>{const result=spawnSync(process.execPath,[fileURLToPath(generator),flag],{cwd,encoding:'utf8'});assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return result.stdout;};
 const first=run('--stdout');assert.equal(first,run('--stdout'));assert.equal(first,await source());
 run('--check');
});

test('each semantic color role resolves to its approved concrete palette value in both system themes',async()=>{
 const text=await source();
 const light=text.match(/:root\{([^}]+)\}/)?.[1]||'';
 const dark=text.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\{([^}]+)\}/)?.[1]||'';
 for(const [theme,block] of [['light',light],['dark',dark]]){
  const values=declarations(block!);
  for(const [role,reference] of Object.entries(visual.tokens) as [string,string][]){
   const expected=visual.palettes[theme!][reference.replace('--palette-','')];
   assert.equal(values[reference],expected,theme+' '+reference);
   assert.equal(values[role],expected,theme+' '+role+' must be a concrete color');
  }
 }
 assert.match(text,/export const uiTokensStyle=String\.raw`/);
 assert.match(light,/color-scheme:light;/);assert.match(dark,/color-scheme:dark;/);
 assert.doesNotMatch(text,/data-theme|localStorage/);
});

test('measured geometry, typography, spacing, radii, motion and focus are available to consumers',async()=>{
 const text=await source(),values=declarations(text.match(/:root\{([^}]+)\}/)?.[1]||'');
 for(const [key,value] of Object.entries({
  '--rail-width':'52px','--sidebar-width':'248px','--sidebar-max-width':'288px','--sidebar-wide-viewport-min':'1600px',
  '--pane-width':'600px','--pane-wide-ratio':'0.48','--conversation-min-width':'480px','--conversation-max-width':'680px',
  '--header-height':'44px','--composer-width':'680px','--composer-editor-max-height':'200px',
  '--font-sans':'"Pretendard Variable",Pretendard,Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  '--font-mono':'ui-monospace,SFMono-Regular,Menlo,monospace',
  '--type-pane-heading-size':'17px','--type-pane-heading-weight':'600','--type-pane-heading-line-height':'24px',
  '--conversation-gap':'14px','--space-8':'8px','--composer-padding':'10px 10px 8px 14px','--composer-radius':'20px',
  '--card-pane-radius':'10px','--motion-fast':'.12s','--motion-slow':'.3s','--motion-ease':'cubic-bezier(.32,.72,0,1)',
  '--focus-width':'2px','--focus-ring':'var(--fg-4)','--focus-offset':'4px'
 }))assert.equal(values[key],value,key);
 assert.match(text,/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*--motion-fast:0s;[\s\S]*--motion-slow:0s;/);
 assert.match(text,/Fallback provenance:[\s\S]*src\/workbench\.ts[\s\S]*src\/results-panel\.ts[\s\S]*src\/members-panel\.ts/);
});

test('owned panel styles use semantic colors and shared motion without literal color fallbacks',async()=>{
 for(const file of (await readdir(new URL('src/',root))).filter(file=>file.endsWith('panel.ts')&&file!=='assistant-conversation-panel.ts')){
  const text=await readFile(new URL('src/'+file,root),'utf8');
  for(const match of text.matchAll(/export const \w*Style=String\.raw`([\s\S]*?)`/g)){
   assert.doesNotMatch(match[1]!,/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|color-mix)\(|:\s*(?:white|black)\b/i,file);
   assert.doesNotMatch(match[1]!,/transition:[^;}]*\b[.\d]+m?s\b/,file);
  }
 }
});
