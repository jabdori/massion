import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizePage,validateBrowserSession} from '../src/browser-runtime.ts';
import {captureBrowserPage} from '../src/headless-browser.ts';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YkAAAAASUVORK5CYII=';
const screenshot={mimeType:'image/png' as const,data:png,width:1,height:1};
const raw={address:'https://shop.example.com/checkout',title:'Order',blocks:['Order'],fields:[],screenshot};
test('persisted observations contain an image hash, never image bytes',()=>{
 const page=sanitizePage(raw);assert.equal('screenshot' in page,false);assert.match(page.imageHash!,/^[a-f0-9]{64}$/);
 for(const image of [{...screenshot,mimeType:'image/svg+xml'},{...screenshot,width:2},{...screenshot,data:'data:image/png;base64,'+png},{...screenshot,data:'a'.repeat(400000)}])assert.throws(()=>sanitizePage({...raw,screenshot:image} as any),/screenshot|image/i);
 const recorded={readId:'read:1',expectedRevision:1,inputHash:'a'.repeat(64),at:1,...page};assert.doesNotThrow(()=>validateBrowserSession({id:'session',pages:[recorded]}));assert.throws(()=>validateBrowserSession({id:'session',pages:[{...recorded,screenshot}]}),/browser/i);
 assert.equal(sanitizePage({address:raw.address,title:'Legacy',blocks:[],fields:[]}).imageHash,undefined);
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
 const page=sanitizePage({address:raw.address,title:'Order',blocks:['456'],fields:[{...field,value:'456'}]});assert.equal(page.fields[0]!.masked,true);assert.doesNotMatch(JSON.stringify(page),/456/);
});
test('only explicit benign field meanings expose their values',()=>{
 const page=sanitizePage({address:raw.address,title:'Order',blocks:[],fields:[{label:'수량',name:'quantity',type:'number',autocomplete:'',value:'2'},{label:'이름',name:'fullName',type:'text',autocomplete:'name',value:'홍길동'},{label:'방',name:'room',type:'select-one',autocomplete:'',value:'스터디룸 B'}]});assert.deepEqual(page.fields.map(f=>[f.value,f.masked]),[['2',false],['홍길동',false],['스터디룸 B',false]]);
});
test('private text ranges join whitespace and mask overlapping values without exposing suffixes',()=>{
 const page=sanitizePage({address:raw.address,title:'Order',blocks:['Code: 4 5\n6','Value: abcd'],fields:[{label:'Security code',type:'number',autocomplete:'',value:'456'},{label:'Secret',type:'password',autocomplete:'',value:'abc'},{label:'Password',type:'password',autocomplete:'',value:'abcd'}]});assert.deepEqual(page.blocks,['Code: ••••','Value: ••••']);
});
test('document guard failures prevent screenshot creation before and after DOM redaction',async()=>{
 for(const failAt of [1,2]){let inspections=0,shots=0;await assert.rejects(captureBrowserPage(async()=>({result:raw}),{screenshot:async()=>{shots++;return png;},assertDocument:async()=>{if(++inspections===failAt)throw Error('Unsafe document');return 1;}}),/Unsafe document/);assert.equal(shots,0);}
});

test('format-separated card and token patterns are removed without a matching input field',()=>{const page=sanitizePage({address:raw.address,title:'Order',blocks:['4111\u200b1111\u20601111\uFE0F1111','token=pri\u200bvate'],fields:[]});assert.deepEqual(page.blocks,['••••','••••']);});

test('durable unmasked fields require an explicit benign label',()=>{const safe=sanitizePage({address:raw.address,title:'Order',blocks:[],fields:[{label:'',name:'quantity',type:'number',autocomplete:'',value:'2'}]});assert.equal(safe.fields[0]!.label,'quantity');const page={readId:'read:1',expectedRevision:1,inputHash:'a'.repeat(64),at:1,...safe};assert.doesNotThrow(()=>validateBrowserSession({id:'session',pages:[page]}));page.fields[0]!.label='Verification number';assert.throws(()=>validateBrowserSession({id:'session',pages:[page]}),/browser/i);});

test('standalone card and API-key text uses the same display normalization as known fields',()=>{const page=sanitizePage({address:raw.address,title:'Order',blocks:['٤١١١–١١١١–١١١١–١١١١','4111\n1111\n1111\n1111','api key: private-value'],fields:[]});assert.deepEqual(page.blocks,['••••','••••','••••']);});

test('literal punctuation secrets are still masked when grouped matching removes separators',()=>{const page=sanitizePage({address:raw.address,title:'Order',blocks:['a---b'],fields:[{label:'Password',type:'password',autocomplete:'',value:'---'}]});assert.deepEqual(page.blocks,['a••••b']);});
