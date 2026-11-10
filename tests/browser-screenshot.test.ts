import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizePage,validateBrowserSession,browserText} from '../src/browser-runtime.ts';
import {captureBrowserPage} from '../src/headless-browser.ts';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YkAAAAASUVORK5CYII=';
const screenshot={mimeType:'image/png' as const,data:png,width:1,height:1};
const raw={address:'https://shop.example.com/checkout',title:'Order',blocks:['Order'],fields:[],screenshot};
test('persisted observations contain an image hash, never image bytes',()=>{
 const key=Buffer.alloc(32,1),page=sanitizePage(raw,key);assert.ok(!page.tainted);assert.equal('screenshot' in page,false);assert.match(page.imageHash!,/^hmac-sha256:[a-f0-9]{64}$/);assert.throws(()=>sanitizePage(raw),/key/i);const again=sanitizePage(raw,key),other=sanitizePage(raw,Buffer.alloc(32,2));assert.ok(!again.tainted&&!other.tainted);assert.equal(again.imageHash,page.imageHash);assert.notEqual(other.imageHash,page.imageHash);
 for(const image of [{...screenshot,mimeType:'image/svg+xml'},{...screenshot,width:2},{...screenshot,data:'data:image/png;base64,'+png},{...screenshot,data:'a'.repeat(400000)}])assert.throws(()=>sanitizePage({...raw,screenshot:image} as any),/screenshot|image/i);
 const recorded={readId:'read:1',expectedRevision:1,inputHash:'a'.repeat(64),at:1,...page};assert.doesNotThrow(()=>validateBrowserSession({id:'session',pages:[recorded]}));assert.throws(()=>validateBrowserSession({id:'session',pages:[{...recorded,screenshot}]}),/browser/i);
 assert.equal('imageHash' in sanitizePage({address:raw.address,title:'Legacy',blocks:[],fields:[]}),false);
});
test('capture masks the DOM then takes the PNG only through memory CDP transport',async()=>{
 const calls:string[][]=[];let shots=0;
 const control={assertDocument:async()=>1,screenshot:async()=>{assert.ok(calls.some(c=>c[0]==='eval'));shots++;return png;}};
 const result=await captureBrowserPage(async args=>{calls.push(args);return {result:{address:raw.address,title:raw.title,blocks:[],fields:[]}};},control);
 assert.deepEqual(result.screenshot,screenshot);assert.equal(shots,1);assert.ok(calls.every(c=>c[0]!=='screenshot'));
 await assert.rejects(captureBrowserPage(async()=>{throw Error('Redaction failed');},control));assert.equal(shots,1);
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
 const page=sanitizePage({address:raw.address,title:'Order',blocks:['456'],fields:[{...field,value:'456'}]});assert.ok(page.tainted);assert.equal(page.summary.privateFields,1);assert.doesNotMatch(JSON.stringify(page),/456/);
});
test('only explicit benign field meanings expose their values',()=>{
 const page=sanitizePage({address:raw.address,title:'Order',blocks:[],fields:[{label:'수량',name:'quantity',type:'number',autocomplete:'',value:'2'},{label:'이름',name:'fullName',type:'text',autocomplete:'name',value:'홍길동'},{label:'방',name:'room',type:'select-one',autocomplete:'',value:'스터디룸 B'}]});assert.ok(!page.tainted);assert.deepEqual(page.fields.map(f=>[f.value,f.masked]),[['2',false],['홍길동',false],['스터디룸 B',false]]);
});
test('literal whitespace defence preserves surrounding text',()=>{assert.equal(browserText('Code: 4 5\n6; value: abcd',['456','abc','abcd']),'Code: ••••; value: ••••');});
test('document guard failures prevent screenshot creation before and after DOM redaction',async()=>{
 for(const failAt of [1,2]){let inspections=0,shots=0;await assert.rejects(captureBrowserPage(async()=>({result:raw}),{screenshot:async()=>{shots++;return png;},assertDocument:async()=>{if(++inspections===failAt)throw Error('Unsafe document');return 1;}}),/Unsafe document/);assert.equal(shots,0);}
});


test('empty private fields remain untainted, while frames and pre-mask measurements taint',()=>{
 const empty={address:raw.address,title:'Public',blocks:['Public text'],fields:[{label:'Password',type:'password',autocomplete:'',value:''}]};assert.ok(!sanitizePage(empty).tainted);
 for(const page of [{...empty,frames:1},{...empty,privateFields:1},{...empty,fields:[{...empty.fields[0]!,valueLength:6}]}]){const stored=sanitizePage(page);assert.ok(stored.tainted);assert.equal('title' in stored,false);assert.equal('imageHash' in stored,false);}
});
test('tainted schemas reject page-controlled strings and an origin cannot become untainted',()=>{
 const content=sanitizePage({address:raw.address,title:'Private',blocks:['Private'],fields:[{label:'Password',type:'password',autocomplete:'',value:'private-value'}]}),page={readId:'private',expectedRevision:1,inputHash:'a'.repeat(64),at:1,...content};assert.ok(page.tainted);assert.doesNotThrow(()=>validateBrowserSession({id:'session',pages:[page]}));
 for(const patch of [{title:'leak'},{blocks:['leak']},{fields:[]},{imageHash:'hmac-sha256:'+ 'a'.repeat(64)}])assert.throws(()=>validateBrowserSession({id:'session',pages:[{...page,...patch}]}),/browser/i);
 const publicPage={readId:'public',expectedRevision:2,inputHash:page.inputHash,at:2,...sanitizePage({address:raw.address,title:'Public',blocks:[],fields:[]})};assert.throws(()=>validateBrowserSession({id:'session',pages:[page,publicPage]}),/private/i);
});
