import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_CONTAINER_BOUNDARY_VARIABLE,browserSandboxRefusal,browserSandboxState} from '../src/browser-sandbox.ts';

// Every combination of the decision's inputs, each with its explicit expectation.
const table:[string,boolean,boolean,boolean,boolean,string|undefined][]=[
 // boundary mode set: needs the container markers, so refused on macOS and on any machine
 // without them; inside a real container it is allowed whatever the other host state is.
 ['darwin',true,true,true,true,'container-boundary-refused'],
 ['darwin',true,true,true,false,'container-boundary-refused'],
 ['darwin',true,true,false,true,'container-boundary-refused'],
 ['darwin',true,true,false,false,'container-boundary-refused'],
 ['darwin',true,false,true,true,'container-boundary-refused'],
 ['darwin',true,false,true,false,'container-boundary-refused'],
 ['darwin',true,false,false,true,'container-boundary-refused'],
 ['darwin',true,false,false,false,'container-boundary-refused'],
 ['linux',true,true,true,true,undefined],
 ['linux',true,true,true,false,undefined],
 ['linux',true,true,false,true,'container-boundary-refused'],
 ['linux',true,true,false,false,'container-boundary-refused'],
 ['linux',true,false,true,true,undefined],
 ['linux',true,false,true,false,undefined],
 ['linux',true,false,false,true,'container-boundary-refused'],
 ['linux',true,false,false,false,'container-boundary-refused'],
 ['win32',true,true,true,true,undefined],
 ['win32',true,true,true,false,undefined],
 ['win32',true,true,false,true,'container-boundary-refused'],
 ['win32',true,true,false,false,'container-boundary-refused'],
 ['win32',true,false,true,true,undefined],
 ['win32',true,false,true,false,undefined],
 ['win32',true,false,false,true,'container-boundary-refused'],
 ['win32',true,false,false,false,'container-boundary-refused'],
 // no boundary mode: each detection condition refuses, most physical first.
 ['darwin',false,true,true,true,'running-as-root'],
 ['darwin',false,true,true,false,'running-as-root'],
 ['darwin',false,true,false,true,'running-as-root'],
 ['darwin',false,true,false,false,'running-as-root'],
 ['darwin',false,false,true,true,'inside-container'],
 ['darwin',false,false,true,false,'inside-container'],
 ['darwin',false,false,false,true,'ci-environment'],
 ['darwin',false,false,false,false,undefined],
 ['linux',false,true,true,true,'running-as-root'],
 ['linux',false,true,true,false,'running-as-root'],
 ['linux',false,true,false,true,'running-as-root'],
 ['linux',false,true,false,false,'running-as-root'],
 ['linux',false,false,true,true,'inside-container'],
 ['linux',false,false,true,false,'inside-container'],
 ['linux',false,false,false,true,'ci-environment'],
 ['linux',false,false,false,false,undefined],
 ['win32',false,true,true,true,'running-as-root'],
 ['win32',false,true,true,false,'running-as-root'],
 ['win32',false,true,false,true,'running-as-root'],
 ['win32',false,true,false,false,'running-as-root'],
 ['win32',false,false,true,true,'inside-container'],
 ['win32',false,false,true,false,'inside-container'],
 ['win32',false,false,false,true,'ci-environment'],
 ['win32',false,false,false,false,undefined],
];
test('the sandbox decision table covers every input combination',()=>{
 for(const [platform,containerBoundary,runningAsRoot,insideContainer,ci,expected] of table)
  assert.equal(browserSandboxRefusal({platform,containerBoundary,runningAsRoot,insideContainer,childEnv:ci?{CI:'true'}:{}}),expected,JSON.stringify({platform,containerBoundary,runningAsRoot,insideContainer,ci}));
});
test('the boundary mode is read from the owner environment and only as the exact value',()=>{
 assert.equal(browserSandboxState({},{}).containerBoundary,false);
 assert.equal(browserSandboxState({},{[BROWSER_CONTAINER_BOUNDARY_VARIABLE]:'1'}).containerBoundary,true);
 assert.throws(()=>browserSandboxState({},{[BROWSER_CONTAINER_BOUNDARY_VARIABLE]:'yes'}),/boundary/);
 const state=browserSandboxState({},{});
 assert.equal(typeof state.platform,'string');assert.equal(typeof state.runningAsRoot,'boolean');assert.equal(typeof state.insideContainer,'boolean');
});
