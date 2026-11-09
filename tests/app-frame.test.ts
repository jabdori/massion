import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';

test('app HTML has an opaque sandbox origin and cannot turn messages into host commands',async()=>{
 const app=harness(async()=>reply({error:'unavailable'},503));await settle();
 const frame=runInContext('appFrame("Example","massion-app://document/"+"a".repeat(64))',app.context);
 assert.equal(frame.tagName,'IFRAME');
 assert.equal(frame.attributes.get('sandbox'),'allow-scripts');assert.equal(frame.attributes.get('referrerpolicy'),'no-referrer');
 assert.equal(frame.src,'massion-app://document/'+'a'.repeat(64));assert.equal(frame.srcdoc,undefined);
 frame.contentWindow={};frame.isConnected=true;await settle();
 const before=frame.style.height;
 (app.context as any).__frame=frame;
 runInContext('appFrameMessage({source:__frame.contentWindow,origin:"https://other.app",data:{type:"resize",height:500}})',app.context);
 assert.equal(frame.style.height,before);
 runInContext('appFrameMessage({source:{},origin:"null",data:{type:"resize",height:500}})',app.context);assert.equal(frame.style.height,before);
 runInContext('appFrameMessage({source:__frame.contentWindow,origin:"null",data:{type:"tool-call",name:"delete"}})',app.context);assert.equal(frame.style.height,before);
 runInContext('appFrameMessage({source:__frame.contentWindow,origin:"null",data:{type:"resize",height:500,secret:"x"}})',app.context);assert.equal(frame.style.height,before);
 runInContext('appFrameMessage({source:__frame.contentWindow,origin:"null",data:{type:"resize",height:500}})',app.context);assert.equal(frame.style.height,'500px');
 for(const height of [79,1201,500.5,NaN,'500']){(app.context as any).__height=height;runInContext('appFrameMessage({source:__frame.contentWindow,origin:"null",data:{type:"resize",height:__height}})',app.context);assert.equal(frame.style.height,'500px');}
 frame.isConnected=false;runInContext('appFrameMessage({source:__frame.contentWindow,origin:"null",data:{type:"resize",height:600}})',app.context);assert.equal(frame.style.height,'500px');
});

test('the frame client refuses raw HTML, arbitrary origins and decorated document URLs',async()=>{
 const app=harness(async()=>reply({error:'unavailable'},503));await settle();
 for(const url of ['<script>alert(1)</script>','https://example.org/app','blob:http://127.0.0.1/id','massion-app://document/'+'a'.repeat(64)+'?x']){
  (app.context as any).__url=url;assert.throws(()=>runInContext('appFrame("Probe",__url)',app.context),/Invalid hosted app document/);
 }
});

test('the app panel renders a hosted document URL instead of accepting inline HTML',async()=>{
 const app=harness(async()=>reply({error:'unavailable'},503));await settle();
 const nodes=runInContext('appsViewNodes({title:"Probe",groups:[],frame:{url:"http://127.0.0.1:12345/"+"a".repeat(64)}})',app.context);
 const frame=nodes.find((node:any)=>node.tagName==='IFRAME');assert.ok(frame,'the panel creates the isolated document frame');
 assert.equal(frame.src,'http://127.0.0.1:12345/'+'a'.repeat(64));assert.equal(frame.srcdoc,undefined);
 const raw=runInContext('appsViewNodes({title:"Probe",groups:[],frame:{html:"<script>window.bad=true</script>"}})',app.context);
 assert.equal(raw.some((node:any)=>node.tagName==='IFRAME'),false);
});
