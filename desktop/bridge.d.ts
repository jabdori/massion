import type {DesktopSettings} from './lifecycle.ts';
import type {FocusTarget} from './notifications.ts';
export type DesktopViewSettings=DesktopSettings & {showMenuBarItem?:boolean};
declare global {
 interface Window {massionDesktop?:{getSettings():Promise<DesktopViewSettings>;saveNotifications(value:boolean):Promise<DesktopSettings>;saveMenuBarItem?(value:boolean):Promise<boolean>;restart():Promise<DesktopSettings>;onFocus(callback:(target:FocusTarget)=>void):()=>void}}
}
