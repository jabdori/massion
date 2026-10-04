import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedPlainJson} from '../src/bounded-json.ts';
import {renderChatCompletionsBody} from '../src/chat-request-renderer.ts';

test('provider values reject lossy or executable objects before access or cloning',()=>{
 let reads=0;const getter=Object.defineProperty({},'value',{enumerable:true,get(){reads++;return 'unsafe';}});
 const cyclic:Record<string,unknown>={};cyclic.self=cyclic;
 for(const value of [getter,cyclic,new Proxy({},{}),new Date(),{hidden:undefined},[undefined],Array(1),{number:-0},{number:NaN},{text:'\ud800'},'x'.repeat(32769),Array(257).fill(null)])assert.throws(()=>boundedPlainJson(value));
 assert.equal(reads,0);const shared={text:'안전한 값'};assert.doesNotThrow(()=>boundedPlainJson({a:shared,b:shared,flags:[null,true,3]}));
});
test('ordinary Chat rendering retains exact preexisting wire bytes for literal references',()=>{
 assert.equal(renderChatCompletionsBody('exact','literal\ntext',[],8),'{'+'"model":"exact","messages":[{"role":"user","content":"literal\\ntext"}],"max_completion_tokens":8,"n":1,"stream":false,"store":false}');
 assert.equal(renderChatCompletionsBody('exact','literal',['source://one'],8),'{'+'"model":"exact","messages":[{"role":"user","content":"literal\\n\\nInput references (identifiers only; their contents have not been loaded):\\n[\\"source://one\\"]"}],"max_completion_tokens":8,"n":1,"stream":false,"store":false}');
});
