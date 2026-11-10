import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {evidenceBrowser,redactEvidence} from './browser-evidence.mjs';

function fixture({failure,hideFailure=false,visible=false,hasImage=true}={}){
 const styles=new Map(),image={src:'data:image/png;base64,cHJpdmF0ZQ==',style:{visibility:'visible'}},shots=[];
 const document={
  createElement:()=>({remove(){styles.delete(this.id);}}),
  head:{append(style){styles.set(style.id,style);if(hideFailure)throw Error('Hide failed');}},
  getElementById:id=>styles.get(id),
  querySelectorAll:selector=>{assert.equal(selector,'#browser-screenshot');return hasImage?[image]:[];}
 };
 const getComputedStyle=()=>({visibility:!visible&&[...styles.values()].some(style=>/#browser-screenshot\s*\{\s*visibility:\s*hidden\s*!important;[^}]*\}/.test(style.textContent))?'hidden':image.style.visibility});
 const browser=evidenceBrowser(async(command,...args)=>{
  if(command==='eval'){
   assert.equal(args[0],'-b');return {result:runInNewContext(Buffer.from(args[1],'base64').toString(),{document,getComputedStyle})};
  }
  if(command==='screenshot'){
   assert.equal(getComputedStyle(image).visibility,'hidden');shots.push(args);
   if(failure)throw failure;
   return {path:args[0]};
  }
  if(command==='snapshot')return {snapshot:'- img "Page"\n  src: '+image.src+'\n- button "Pay"'};
  if(command==='errors')return {errors:[{message:'Failed to load '+image.src}]};
  throw Error('Unexpected browser command');
 });
 return {browser,styles,image,shots,getComputedStyle};
}

test('evidence capture hides the page image and restores live visibility and source',async()=>{
 const f=fixture(),source=f.image.src;
 assert.deepEqual(await f.browser('screenshot','evidence.png'),{path:'evidence.png'});
 assert.deepEqual(f.shots,[['evidence.png']]);assert.equal(f.styles.size,0);
 assert.equal(f.getComputedStyle(f.image).visibility,'visible');assert.equal(f.image.src,source);
});

test('failed screenshots restore visibility and cannot leak image sources through errors',async()=>{
 const f=fixture({failure:Object.assign(Error('Capture data:image/png;base64,cHJpdmF0ZQ== failed'),{stdout:'data:image/png;base64,cHJpdmF0ZQ=='})});
 await assert.rejects(f.browser('screenshot','failure.png'),error=>{
  assert.match(error.message,/Capture/);assert.doesNotMatch(JSON.stringify(error)+error.stack,/cHJpdmF0ZQ==|data:image/);return true;
 });
 assert.equal(f.styles.size,0);assert.equal(f.getComputedStyle(f.image).visibility,'visible');
});

test('capture refuses failed or ineffective hiding and still removes the injected style',async()=>{
 for(const options of [{hideFailure:true},{visible:true}]){
  const f=fixture(options);await assert.rejects(f.browser('screenshot','unsafe.png'));
  assert.deepEqual(f.shots,[]);assert.equal(f.styles.size,0);
 }
});

test('pages without a browser image can still produce evidence',async()=>{
 const f=fixture({hasImage:false});await f.browser('screenshot','shell.png');assert.equal(f.styles.size,0);
});

test('capture preserves an image that was already hidden',async()=>{
 const f=fixture();f.image.style.visibility='hidden';await f.browser('screenshot','hidden.png');
 assert.equal(f.styles.size,0);assert.equal(f.getComputedStyle(f.image).visibility,'hidden');
});

test('in-memory evaluation remains available for live image verification',async()=>{
 const result={result:{src:'data:image/png;base64,cHJpdmF0ZQ==',width:64,height:64}};
 const browser=evidenceBrowser(async()=>result);assert.equal(await browser('eval','live image assertion'),result);
});

test('snapshots and browser diagnostics omit sources without changing live pane assertions',async()=>{
 const f=fixture();
 const {snapshot}=await f.browser('snapshot');assert.match(snapshot,/- img "Page"/);assert.match(snapshot,/- button "Pay"/);
 assert.doesNotMatch(snapshot+JSON.stringify(await f.browser('errors')),/data:image|cHJpdmF0ZQ==/);
 assert.equal(f.image.src,'data:image/png;base64,cHJpdmF0ZQ==');assert.equal(f.getComputedStyle(f.image).visibility,'visible');
 assert.equal(redactEvidence('src="data:image/png;base64,cHJpdmF0ZQ==" next'), 'src="[ephemeral image]" next');
});
