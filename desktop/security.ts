import {createHash} from 'node:crypto';

export const appOrigin='massion://app';
export const channels={ready:'desktop:ready',focus:'desktop:focus'} as const;
export function isAppURL(value:string){
 try{const url=new URL(value);return url.protocol==='massion:'&&url.host==='app'&&!url.username&&!url.password&&url.pathname==='/'&&!url.search;}catch{return false;}
}
export function allowRequest(value:string){
 try{const url=new URL(value);return url.protocol==='massion:'&&url.host==='app'&&!url.username&&!url.password&&['/','/protocol/connect','/protocol/request','/protocol/events'].includes(url.pathname);}catch{return false;}
}
export function validSender(event:{sender:unknown;senderFrame:{url:string}|null},contents:{mainFrame:unknown}){
 return event.sender===contents&&event.senderFrame===contents.mainFrame&&!!event.senderFrame&&isAppURL(event.senderFrame.url);
}
export function windowOptions(preload:string){
 return {width:1440,height:960,minWidth:650,minHeight:600,show:false,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false}};
}
export function contentPolicy(html:string){
 const hashes=(tag:string)=>[...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`,'g'))].map(match=>`'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`).join(' ');
 return `default-src 'none'; script-src ${hashes('script')}; style-src ${hashes('style')}; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
