import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';

test('connection screen fixtures expose production lifecycle projections for distinct host observations',async()=>{
 for(const [screen,status,restart,update] of [['B14','detected','not-required','current'],['B14-expired','detected','not-required','current'],['B14-restart','detected','required','current'],['B14-update','detected','not-required','available']]){
  const fixture=await loadFixture(screen!),view=fixture.routes['/connections/lifecycle']?.body as any;
  assert.ok(view,screen);assert.equal(view.connections[0].observation.status,status,screen);assert.equal(view.connections[0].observation.restart,restart,screen);assert.equal(view.connections[0].observation.update,update,screen);
  assert.ok(view.connections.some((c:any)=>c.canReplaceKey));assert.ok(view.connections.some((c:any)=>c.credentialStorage==='missing'));if(screen==='B14-expired')assert.ok(view.connections.some((c:any)=>c.observation?.status==='expired')); assert.doesNotMatch(JSON.stringify(view),/fixture-secret/);
 }
});

test('device screen fixtures derive both remote rows from approved external-member admission and adapter reads',async()=>{
 const fixture=await loadFixture('B13-devices'),view=fixture.routes['/assistant/devices']?.body as any;assert.ok(view);
 assert.deepEqual(view.devices.map((d:any)=>[d.status,d.available,d.admitted]),[['connected',true,true],['offline',true,true]]);
 assert.ok(view.devices.every((d:any)=>d.decisionId.startsWith('effect-decision:')));
});
