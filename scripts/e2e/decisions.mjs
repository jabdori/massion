import assert from 'node:assert/strict';

// Shared unchanged across the browser and the authenticated Electron renderer.
export async function paymentJourney({browser,wait,capture,current,calls,until,control},prefix='payment',seeded=false){
 if(!seeded)await control({type:'propose-effect',scenario:prefix});
 const work=()=>current().then(s=>s.value.works.find(w=>w.id===prefix));
 const effect=()=>work().then(w=>w.effects[0]);
 await browser('reload');await wait(`!!document.getElementById(${JSON.stringify('chat-decision-'+(await effect()).id)})`);
 const eId=(await effect()).id;
 const card='[id="chat-decision-'+(await effect()).id+'"]';
 await capture(prefix+'-checkout',[/34,000/,/레이저 토너/]);
 assert.equal((await work()).execution,'waiting');assert.equal((await effect()).status,'pending');
 assert.equal((await calls()).filter(c=>c.scenario===prefix).length,0);
 await browser('click',card+' .chat-actions button:nth-child(2)');
 await until(async()=>(await effect()).ownerDecision.state==='later');
 await wait(`document.getElementById(${JSON.stringify('chat-system-'+eId)})?.textContent.includes('다시 묻기')`);
 await capture(prefix+'-later',[/다시 묻기/]);
 assert.equal((await calls()).filter(c=>c.scenario===prefix).length,0);
 await browser('click','[id="chat-system-'+eId+'"] button');
 await until(async()=>(await effect()).ownerDecision.state==='open');
 await wait(`!!document.querySelector(${JSON.stringify(card+' .chat-actions button')})`);
 await browser('click',card+' .chat-actions button:first-child');
 await until(async()=>(await effect()).status==='succeeded');
 await wait(`document.getElementById(${JSON.stringify('chat-system-'+eId)})?.textContent.includes('결제')`);
 await capture(prefix+'-paid',[/결제/]);
 const e=await effect();assert.equal(e.ownerDecision.receipt.remoteId,'order-'+prefix);
 assert.deepEqual(e.ownerDecision.answers.map(a=>a.answer),['later','ask','act']);
 assert.equal(e.ownerDecision.receipt.idempotencyKey,e.ownerDecision.dispatch.idempotencyKey);
 assert.equal((await work()).acceptance,'pending');assert.equal((await work()).record,undefined);
 assert.equal((await calls()).filter(c=>c.scenario===prefix).length,1);
 await browser('reload');await capture(prefix+'-persisted',[/결제/]);
 assert.deepEqual(await effect(),e);assert.equal((await calls()).filter(c=>c.scenario===prefix).length,1);
 const scenario=prefix+'-lost';
 if(!seeded)await control({type:'propose-effect',scenario});
 const lostWork=()=>current().then(s=>s.value.works.find(w=>w.id===scenario));
 const id=(await lostWork()).effects[0].id;
 await browser('reload');await wait(`!!document.getElementById(${JSON.stringify('chat-decision-'+id)})`);
 await browser('click','[id="chat-decision-'+id+'"] .chat-actions button:first-child');
 await until(async()=>(await lostWork()).effects[0].ownerDecision.settledAt!==undefined);
 await wait(`!!document.getElementById(${JSON.stringify('chat-exception-owner-effect:'+id)})`);
 await capture(scenario,[/다시 보내지/]);
 const unknown=await lostWork();assert.equal(unknown.effects[0].status,'unknown');assert.equal(unknown.effects[0].ownerDecision.receipt,undefined);assert.ok(unknown.effects[0].ownerDecision.dispatch);assert.equal(unknown.record,undefined);
 await browser('reload');await wait(`!!document.getElementById(${JSON.stringify('chat-exception-owner-effect:'+id)})`);await capture(scenario+'-persisted',[/다시 보내지/]);
 assert.deepEqual(await lostWork(),unknown);assert.equal((await calls()).filter(c=>c.scenario===scenario).length,1);
 return e;
}
