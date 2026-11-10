/** Only protocol codes enter durable evidence; provider messages can contain secrets. */
export interface CredentialFailure {kind:'invalid'|'expired';code:'invalid_api_key'|'authentication_error'|'API_KEY_INVALID'|'1000'|'1001'|'1003'}
export interface CredentialBlocker {connectionId:string;configHash:string;generation:number;effectId:string;failure:CredentialFailure}
export function credentialFailure(provider:string,status:number,body:unknown):CredentialFailure|null {
 const e=(body as {error?:any}|null)?.error;
 if(!e||typeof e!=='object'||Array.isArray(e))return null;
 if(status===401&&provider==='zai'&&['1000','1001','1003'].includes(e.code))return {kind:e.code==='1003'?'expired':'invalid',code:e.code};
 if(status===401&&provider==='openai'&&e.code==='invalid_api_key')return {kind:'invalid',code:'invalid_api_key'};
 if(status===401&&provider==='anthropic'&&e.type==='authentication_error')return {kind:'invalid',code:'authentication_error'};
 if(status===400&&provider==='gemini'&&Array.isArray(e.details)&&e.details.some((d:any)=>d?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo'&&d.domain==='googleapis.com'&&d.reason==='API_KEY_INVALID'))return {kind:'invalid',code:'API_KEY_INVALID'};
 return null;
}
export function validCredentialFailure(value:unknown):value is CredentialFailure {
 const v=value as CredentialFailure;return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===2&&Object.hasOwn(v,'kind')&&Object.hasOwn(v,'code')&&(v.kind==='invalid'&&['invalid_api_key','authentication_error','API_KEY_INVALID','1000','1001'].includes(v.code)||v.kind==='expired'&&v.code==='1003');
}
export function validCredentialBlocker(value:unknown):value is CredentialBlocker {
 const v=value as CredentialBlocker;return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===5&&['connectionId','configHash','generation','effectId','failure'].every(k=>Object.hasOwn(v,k))&&typeof v.connectionId==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v.connectionId)&&typeof v.configHash==='string'&&/^[a-f0-9]{64}$/.test(v.configHash)&&Number.isSafeInteger(v.generation)&&v.generation>=0&&typeof v.effectId==='string'&&v.effectId.length>0&&v.effectId.length<=512&&validCredentialFailure(v.failure);
}
