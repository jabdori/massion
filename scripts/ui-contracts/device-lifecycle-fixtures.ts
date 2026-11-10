import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopLifecycle} from '../../desktop/lifecycle.ts';
import type {ScreenFixture} from './fixture-host.ts';
export const DEVICE_SCREENS=['B9','B9-restart','B9-update','B13-general','B13-general-restart','B13-devices'];
export const UPDATE_GAP='Application update availability is unknown: no release channel or signed manifest is configured; download, signing and publishing remain owner-only.';
export const CLI_RESTART_GAP='A CLI restart observation does not identify a supervised CLI process. Massion restart cannot confirm an external CLI restart.';
export async function deviceLifecycleFixture(template:ScreenFixture):Promise<ScreenFixture>{
 const fixture=structuredClone(template),directory=await mkdtemp(join(tmpdir(),'massion-native-fixture-'));
 try{
  const host=await DesktopLifecycle.open(join(directory,'notifications.json'),'1.0.0-rc.1',async()=>({status:'drained'}),()=>{});
  if(['B9-restart','B13-general-restart'].includes(fixture.screen))await host.saveNotifications(false);
  fixture.desktopSettings=host.read();
  if(fixture.screen!=='B13-devices')fixture.gaps=fixture.screen==='B9-update'?[UPDATE_GAP]:[];
  return fixture;
 }finally{await rm(directory,{recursive:true,force:true});}
}
