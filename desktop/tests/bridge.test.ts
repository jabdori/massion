import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('notification waits for an in-flight member switch before focusing its decision',async()=>{
 const script=await readFile(new URL('../host-client.js',import.meta.url),'utf8');let callback!:(target:unknown)=>Promise<void>,focused='';
 const state={busy:false,loading:false,reconnectRequired:false,chatReading:false,chatView:{feedId:'feed'} as {feedId:string}|null,shellWorksFeed:'feed',
  window:{massionDesktop:{onFocus(fn:typeof callback){callback=fn;}}},setTimeout,
  async readChat(){return !state.chatReading;},async shellWorksLoad(){},
  chatOpenThread(){state.chatView=null;state.chatReading=true;setTimeout(()=>{state.chatView={feedId:'feed'};state.chatReading=false;},10);return true;},
  document:{getElementById(id:string){return {querySelector(){return {focus(){focused=id;}};}};}}
 };
 runInNewContext(script,state);
 await callback({feedId:'feed',memberId:'member',decisionId:'decision'});assert.equal(focused,'chat-decision-decision');
 focused='';await callback({feedId:'replaced-feed',memberId:'member',decisionId:'decision'});assert.equal(focused,'');
});

test('a newer notification click supersedes a delayed read from an older target',async()=>{
 const script=await readFile(new URL('../host-client.js',import.meta.url),'utf8');let callback!:(target:unknown)=>Promise<void>,release!:()=>void,calls=0;const opened:string[]=[];
 const held=new Promise<void>(resolve=>release=resolve),works=['old','new'].map(id=>({missionId:'mission',workId:id,turnId:id}));
 const state={busy:false,loading:false,reconnectRequired:false,shellWorksFeed:'feed',shellWorks:works,setTimeout,
  window:{massionDesktop:{onFocus(fn:typeof callback){callback=fn;}}},async readChat(){if(++calls===1)await held;},async shellWorksLoad(){},async shellOpenWork(id:string){opened.push(id);}
 };
 runInNewContext(script,state);const older=callback({feedId:'feed',...works[0]});await callback({feedId:'feed',...works[1]});release();await older;
 assert.deepEqual(opened,['new']);
});
