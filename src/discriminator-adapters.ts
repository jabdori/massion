import {hash} from './domain.ts';
import {boundedModeration,buildQuestion,exactModeration,requireModeration,validateAnswer,validatePin,validateQuestion,validDiscriminatorModel} from './discriminator.ts';
import type {DiscriminatorPin,ModerationInput,TypedQuestion} from './discriminator.ts';
import {readBoundedJson} from './http-provider.ts';
import type {HttpProviderTransport} from './http-provider.ts';
import {credentialHeaders,validateModelEndpoint} from './native-model-providers.ts';
import type {CredentialResolver} from './chat-profile-factory.ts';
export interface DiscriminatorReply {output:unknown;rawOutput:unknown;model:string;usage:{inputTokens:number;outputTokens:number}|null}
export interface DiscriminatorAdapter {pin:DiscriminatorPin;invoke(question:TypedQuestion,input:ModerationInput,signal:AbortSignal):Promise<DiscriminatorReply>}
export function fixtureDiscriminator(pin:DiscriminatorPin,respond:(question:TypedQuestion)=>unknown|Promise<unknown>):DiscriminatorAdapter {validatePin(pin);return {pin:structuredClone(pin),async invoke(q,input,signal){validateQuestion(q);buildQuestion(input);signal.throwIfAborted();const output=await respond(structuredClone(q));signal.throwIfAborted();return {output,rawOutput:output,model:pin.model,usage:{inputTokens:0,outputTokens:0}};}};}
export function httpDiscriminator(options:{pin:DiscriminatorPin;endpoint:string;mode:'https'|'local-http-mock';transport:HttpProviderTransport;secretRef?:string;resolveCredential?:CredentialResolver}):DiscriminatorAdapter {
 const {endpoint,mode,transport,secretRef,resolveCredential}=options,pin=structuredClone(options.pin);validatePin(pin);validateModelEndpoint(endpoint,mode,'/v1/systemone');requireModeration(mode==='https'?!!secretRef&&!!resolveCredential:secretRef===undefined,'credential boundary');
 return {pin,async invoke(question,input,signal){validateQuestion(question);buildQuestion(input);signal.throwIfAborted();const criteria=question.kind==='score'?question.options:Object.fromEntries(question.options.map(o=>[o,o]));const body=JSON.stringify({model:pin.model,state:{features:input.features,quotes:input.quotes},questions:{moderation:{type:question.kind,instructions:question.question,criteria}}});requireModeration(Buffer.byteLength(body)<=32768,'request byte bound');
 const headers=await credentialHeaders(mode==='local-http-mock'?'none':'bearer',{secretRef,profileId:pin.profileId,endpoint,signal},resolveCredential);signal.throwIfAborted();const response=await transport(endpoint,{method:'POST',headers,body,redirect:'error',credentials:'omit',cache:'no-store',signal});signal.throwIfAborted();
 if(!(response instanceof Response)||response.status!==200||response.redirected||response.url&&response.url!==endpoint||!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(response.headers.get('content-type')??'')){void response.body?.cancel().catch(()=>{});throw Error('Invalid discriminator HTTP response');}
 const raw=await readBoundedJson(response,32768,signal);signal.throwIfAborted();boundedModeration(raw);
 const reply:DiscriminatorReply={output:null,rawOutput:null,model:pin.model,usage:null};
 try {
  if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
   const fields=raw as Record<string,any>;reply.rawOutput=fields.answers&&typeof fields.answers==='object'&&!Array.isArray(fields.answers)&&Object.hasOwn(fields.answers,'moderation')?fields.answers.moderation:null;
   if(fields.usage&&typeof fields.usage==='object'&&[fields.usage.input_tokens,fields.usage.output_tokens].every(n=>Number.isSafeInteger(n)&&n>=0))reply.usage={inputTokens:fields.usage.input_tokens,outputTokens:fields.usage.output_tokens};
  }
  exactModeration(raw,['model','answers','usage']);requireModeration(validDiscriminatorModel(raw.model),'response model');reply.model=raw.model;exactModeration(raw.answers,['moderation']);exactModeration(raw.usage,['input_tokens','output_tokens']);requireModeration(reply.usage,'response usage');
  const a=raw.answers.moderation;exactModeration(a,question.kind==='noul'?['type','noul']:question.kind==='score'?['type','score','legend','probabilities','confidence']:['type','choice','probabilities','confidence']);requireModeration(a.type===question.kind,'response kind');
  const keys=question.kind==='score'?question.options.map((_,i)=>String(i)):question.options;let distribution:number[],confidence:number;
  if(question.kind==='noul'){requireModeration(typeof a.noul==='number'&&Number.isFinite(a.noul)&&a.noul>=0&&a.noul<=1,'noul probability');distribution=[a.noul,1-a.noul];confidence=0;}else {exactModeration(a.probabilities,keys);distribution=keys.map(k=>a.probabilities[k]);confidence=a.confidence;
   if(question.kind==='choice')requireModeration(question.options.includes(a.choice)&&a.probabilities[a.choice]===Math.max(...distribution),'choice mismatch');else {exactModeration(a.legend,keys);requireModeration(hash(keys.map(k=>a.legend[k]))===hash(question.options)&&typeof a.score==='number'&&Math.abs(a.score-distribution.reduce((sum,p,i)=>sum+p*i,0))<=0.000001,'score mismatch');}}
  const output={kind:question.kind,options:[...question.options],distribution,confidence};validateAnswer(question,output);reply.output=output;
 }catch{/* Preserve bounded answer evidence and valid usage; the host records invalid, never an exception message. */}
 return reply;
 }};
}
