import type {FocusTarget} from './notifications.ts';
declare global {
 interface Window {massionDesktop?:{onFocus(callback:(target:FocusTarget)=>void):()=>void}}
}
