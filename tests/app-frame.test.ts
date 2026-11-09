import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';

test('app HTML has an opaque sandbox origin and cannot turn messages into host commands',async()=>{
 const app=harness(async()=>reply({error:'unavailable'},503));await settle();
 const frames=runInContext('appsViewNodes({title:"Example",groups:[],frame:{html:"<script>parent.postMessage({type: \'tool-call\'}, \'*\')</script>"}})',app.context);
 const frame=frames.find((n:any)=>n.tagName==='IFRAME');assert.ok(frame,'app markup is enclosed in an iframe');
 assert.equal(frame.attributes.get('sandbox'),'allow-scripts');assert.equal(frame.attributes.get('referrerpolicy'),'no-referrer');
 assert.match(frame.srcdoc,/default-src &#39;none&#39;/);assert.match(frame.srcdoc,/connect-src &#39;none&#39;/);assert.match(frame.srcdoc,/form-action &#39;none&#39;/);
 frame.contentWindow={};frame.isConnected=true;await frame.fire('load');
 const before=frame.style.height;
 (app.context as any).__frame=frame;
 runInContext('appFrameMessage({source:__frame.contentWindow,origin:"https://other.app",data:{type:"resize",height:500}})',app.context);
 assert.equal(frame.style.height,before);
 runInContext('appFrameMessage({source:{},origin:"null",data:{type:"resize",height:500}})',app.context);assert.equal(frame.style.height,before);
 runInContext('appFrameMessage({source:__frame.contentWindow,origin:"null",data:{type:"tool-call",name:"delete"}})',app.context);assert.equal(frame.style.height,before);
 runInContext('appFrameMessage({source:__frame.contentWindow,origin:"null",data:{type:"resize",height:500,secret:"x"}})',app.context);assert.equal(frame.style.height,before);
 runInContext('appFrameMessage({source:__frame.contentWindow,origin:"null",data:{type:"resize",height:500}})',app.context);assert.equal(frame.style.height,'500px');
});
