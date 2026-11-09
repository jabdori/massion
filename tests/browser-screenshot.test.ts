import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizePage,validateBrowserSession} from '../src/browser-runtime.ts';
import {captureBrowserPage} from '../src/headless-browser.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YkAAAAASUVORK5CYII=';
const screenshot={mimeType:'image/png' as const,data:png,width:1,height:1};
const raw={address:'https://shop.example.com/checkout',title:'Order',blocks:['Order'],fields:[],screenshot};
test('sanitized PNG observations retain the image and bind its byte dimensions',()=>{
 assert.deepEqual(sanitizePage(raw).screenshot,screenshot);
 for(const image of [{...screenshot,mimeType:'image/svg+xml'},{...screenshot,width:2},{...screenshot,data:'data:image/png;base64,'+png},{...screenshot,data:'a'.repeat(400000)}])assert.throws(()=>sanitizePage({...raw,screenshot:image} as any),/screenshot|image/i);
 const page={readId:'read:1',expectedRevision:1,inputHash:'a'.repeat(64),at:1,...sanitizePage(raw)};assert.doesNotThrow(()=>validateBrowserSession({id:'session',pages:[page]}));assert.throws(()=>validateBrowserSession({id:'session',pages:[{...page,screenshot:{...screenshot,height:2}}]}),/screenshot|image/i);
 assert.equal(sanitizePage({address:raw.address,title:'Legacy',blocks:[],fields:[]}).screenshot,undefined);
});
test('capture masks the DOM before the only screenshot command and returns only the resulting PNG',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'browser-shot-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'page.png'),calls:string[][]=[];
 const result=await captureBrowserPage(async args=>{calls.push(args);if(args[0]==='eval')return {result:{address:raw.address,title:raw.title,blocks:[],fields:[]}};if(args[0]==='screenshot'){assert.ok(calls.some(c=>c[0]==='eval'));await writeFile(path,Buffer.from(png,'base64'));}return {};},path);
 assert.deepEqual(result.screenshot,screenshot);assert.equal(calls.filter(c=>c[0]==='screenshot').length,1);assert.ok(Buffer.from(calls.find(c=>c[0]==='eval')![2]!,'base64').toString().includes('maskBrowserField'));
 let screenshots=0;await assert.rejects(captureBrowserPage(async args=>{if(args[0]==='screenshot')screenshots++;if(args[0]==='eval')throw Error('Redaction failed');return {};},path));assert.equal(screenshots,0);
});
for(const field of [
 {label:'보안 코드',type:'number',name:'field',autocomplete:''},
 {label:'Security code',type:'number',name:'field',autocomplete:''},
 {label:'수량',type:'number',name:'csc',autocomplete:''},
 {label:'수량',type:'number',name:'quantity',autocomplete:'cc-csc'},
 {label:'Other',type:'number',name:'other',autocomplete:''},
 {label:'Other',type:'text',name:'other',autocomplete:''},
 {label:'Other',type:'tel',name:'other',autocomplete:''},
 ])test('private field masks '+JSON.stringify(field),()=>{
 const page=sanitizePage({address:raw.address,title:'Order',blocks:['456'],fields:[{...field,value:'456'}]});assert.equal(page.fields[0]!.masked,true);assert.doesNotMatch(JSON.stringify(page),/456/);
});
test('only explicit benign field meanings expose their values',()=>{
 const page=sanitizePage({address:raw.address,title:'Order',blocks:[],fields:[{label:'수량',name:'quantity',type:'number',autocomplete:'',value:'2'},{label:'이름',name:'fullName',type:'text',autocomplete:'name',value:'홍길동'},{label:'방',name:'room',type:'select-one',autocomplete:'',value:'스터디룸 B'}]});assert.deepEqual(page.fields.map(f=>[f.value,f.masked]),[['2',false],['홍길동',false],['스터디룸 B',false]]);
});
