import type {DesktopSettings} from './lifecycle.ts';
import type {FocusTarget} from './notifications.ts';
declare global {
 interface Window {massionDesktop?:{getSettings():Promise<DesktopSettings>;saveNotifications(value:boolean):Promise<DesktopSettings>;restart():Promise<DesktopSettings>;onFocus(callback:(target:FocusTarget)=>void):()=>void}}
}
