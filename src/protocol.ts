export interface ProtocolRange { min:number;max:number }
export interface ProtocolFeatures { commands:boolean;queries:boolean;feedPush:boolean }
export interface ProtocolHeader { version:number;requestId:string;generation:number }
export interface ProtocolRequest extends ProtocolHeader {
 kind:'command'|'query';path:string;payload?:Record<string,unknown>;feedId?:string;
}
export interface ProtocolReply extends ProtocolHeader { kind:'reply';status:number;payload:unknown }
export interface ProtocolConnection {
 state:'ready'|'update-needed'|'restart-needed';supported:ProtocolRange;
 features:ProtocolFeatures;version:number|null;
}
export interface FeedHint extends ProtocolHeader {
 kind:'feed';reason:'connected'|'revision'|'reset';feedId:string;cursor:number;
 aggregateId?:string;revision?:number;
}
export interface FeedSubscription extends ProtocolHeader { after:number;feedId?:string }
export interface ProtocolTransport {
 connect(message:ProtocolHeader&{supported:ProtocolRange},signal:AbortSignal):Promise<ProtocolReply>;
 request(message:ProtocolRequest,signal:AbortSignal):Promise<ProtocolReply>;
 subscribe(message:FeedSubscription,onEvent:(event:FeedHint)=>void,onDisconnect:()=>void):()=>void;
}
// Reserved seam only: chunk transfer is not an advertised v1 feature.
export type TransferMessage = ProtocolHeader & ({kind:'chunk';transferId:string;sequence:number;final:boolean;data:string}|{kind:'ack';transferId:string;sequence:number});
export const protocolSupport:ProtocolRange={min:1,max:1};
export const protocolFeatures:ProtocolFeatures={commands:true,queries:true,feedPush:true};
export function validRange(value:unknown):value is ProtocolRange {
 const range=value as ProtocolRange|undefined;
 return !!range&&Number.isSafeInteger(range.min)&&Number.isSafeInteger(range.max)&&range.min>0&&range.max>=range.min;
}
export function validHeader(value:unknown):value is ProtocolHeader {
 const header=value as ProtocolHeader|undefined;
 return !!header&&Number.isSafeInteger(header.version)&&header.version>0&&typeof header.requestId==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(header.requestId)&&Number.isSafeInteger(header.generation)&&header.generation>=0;
}
export function protocolConnection(client:ProtocolRange,supported:ProtocolRange=protocolSupport,installed?:ProtocolRange,features:ProtocolFeatures=protocolFeatures):ProtocolConnection {
 if(!validRange(client)||!validRange(supported)||installed&&!validRange(installed))throw new TypeError('Invalid protocol range');
 const version=Math.min(client.max,supported.max),ready=version>=Math.max(client.min,supported.min);
 const restart=!ready&&supported.max<client.min&&installed&&Math.min(client.max,installed.max)>=Math.max(client.min,installed.min);
 return {state:ready?'ready':restart?'restart-needed':'update-needed',supported,features,version:ready?version:null};
}
