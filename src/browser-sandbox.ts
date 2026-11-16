// Host rule (owner, 2026-11-17): on a host Massion never turns Chrome's sandbox off by itself.
// agent-browser 0.41.2 adds --no-sandbox on its own when it sees CI, root or container markers
// (chrome.rs should_disable_sandbox), with no way to turn that off, so those conditions are
// refused here before the CLI starts. The only excuse is the explicit container-boundary mode.
import {existsSync,readFileSync} from 'node:fs';

export type BrowserSandboxRefusal='running-as-root'|'ci-environment'|'inside-container'|'container-boundary-refused';
// Deliberately unmistakable: setting it states that this container (or CI VM) is itself the
// isolation boundary, so Chrome's own sandbox may be off. Refused on macOS.
export const BROWSER_CONTAINER_BOUNDARY_VARIABLE='MASSION_BROWSER_CONTAINER_IS_SANDBOX_BOUNDARY';
export interface BrowserSandboxState {platform:string;runningAsRoot:boolean;insideContainer:boolean;containerBoundary:boolean}

/** One pure decision for both CLI spawn sites; every input combination is table-tested. */
export function browserSandboxRefusal(state:BrowserSandboxState&{childEnv:Record<string,string|undefined>}):BrowserSandboxRefusal|undefined{
 if(state.containerBoundary)return state.platform==='darwin'?'container-boundary-refused':undefined;
 if(state.runningAsRoot)return 'running-as-root';
 if(state.insideContainer)return 'inside-container';
 if(state.childEnv.CI!==undefined)return 'ci-environment';
 return undefined;
}

export class BrowserSandboxRefusedError extends Error {
 readonly refusal:BrowserSandboxRefusal;
 constructor(refusal:BrowserSandboxRefusal,message:string){super(message);this.name='BrowserSandboxRefusedError';this.refusal=refusal;}
}

function containerMarkers(){
 if(process.platform==='win32')return false;
 try{
  if(existsSync('/.dockerenv')||existsSync('/run/.containerenv'))return true;
  const cgroup=readFileSync('/proc/1/cgroup','utf8');
  return cgroup.includes('docker')||cgroup.includes('kubepods')||cgroup.includes('lxc');
 }catch{return false;}
}

/** Gathers the host facts the decision needs; the child env is the one the caller is about to pass. */
export function browserSandboxState(childEnv:Record<string,string|undefined>,ownerEnv:Record<string,string|undefined>=process.env):BrowserSandboxState{
 const boundary=ownerEnv[BROWSER_CONTAINER_BOUNDARY_VARIABLE];
 if(boundary!==undefined&&boundary!=='1')throw Error('Invalid browser container boundary setting');
 return {platform:process.platform,runningAsRoot:process.geteuid?.()===0,insideContainer:containerMarkers(),containerBoundary:boundary==='1'};
}
