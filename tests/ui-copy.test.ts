import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {copy,uiCopyClient} from '../src/ui-copy.ts';

test('Korean copy uses approved keys and named placeholders without interpreting replacement text',()=>{
 assert.equal(copy('composer.button.03'),'보내기');
 assert.equal(copy('pane.textbox.01',{work_title:'$& <script> {count}'}),'$& <script> {count} 토큰');
 assert.throws(()=>copy('missing.key'),/Unknown copy key/);
 assert.throws(()=>copy('pane.textbox.01'),/Missing copy placeholder/);
});

test('the embedded client uses the same lookup and cannot terminate its script',()=>{
 const client=runInNewContext(uiCopyClient+'; copy');
 assert.equal(client('pane.textbox.01',{work_title:'원본'}),copy('pane.textbox.01',{work_title:'원본'}));
 assert.equal(uiCopyClient.includes('</script'),false);
});

test('conversation fidelity copy retains approved artboard provenance',()=>{
 assert.equal(copy('ui.scroll-bottom'),'맨 아래로');
 assert.equal(copy('ui.interrupted',{time:'21:12'}),'응답이 끊겼어요 · 21:12');
});
