import {DomainError,hash} from './domain.ts';
import type {Mission,Work,ConversationMessage} from './domain.ts';
import {validateConversations,workConversationId} from './work-conversation.ts';
export interface ConversationSelection {workId:string|null;messageId:string;messageHash:string}
export interface ConversationSource extends ConversationSelection {conversationId:string;message:ConversationMessage;actorId:string}
const exact=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
function ensure(value:unknown,message:string):asserts value {if(!value)throw new DomainError(message);}
export function captureConversationSource(mission:Mission,selection:ConversationSelection,actorId:string):ConversationSource {
 ensure(exact(selection,['workId','messageId','messageHash']),'Exact conversation selection fields required');validateConversations(mission);
 const thread=mission.conversations?.find(c=>c.workId===selection.workId),message=thread?.messages.find(m=>m.id===selection.messageId);
 ensure(thread&&message&&hash(message)===selection.messageHash,'Exact same-Mission original owner message required');
 return structuredClone({...selection,conversationId:thread.id,message,actorId});
}
export function conversationSourceInput(work:Work):ConversationSource|undefined {
 if(!Object.hasOwn(work,'conversationSource'))return undefined;const source=work.conversationSource!;
 ensure(exact(source,['workId','messageId','messageHash','conversationId','message','actorId']),'Exact conversation provenance required');
 ensure(typeof source.actorId==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(source.actorId)&&(source.workId===null||typeof source.workId==='string'&&source.workId!==work.id)&&source.messageId===source.message?.id&&source.messageHash===hash(source.message),'Original conversation provenance binding invalid');
 // Reuse the complete owner message validator without granting the copied text authority.
 const temporary={id:'validation',works:[{id:source.workId}],conversations:[{id:workConversationId('validation',source.workId),workId:source.workId,messages:[{...source.message,ordinal:1,replyTo:null}]}]} as Mission;
 validateConversations(temporary);ensure(exact(source.message,['id','ordinal','actorId','role','replyTo','text'])&&Number.isSafeInteger(source.message.ordinal)&&source.message.ordinal>0&&(source.message.replyTo===null||typeof source.message.replyTo==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(source.message.replyTo)),'Original message structure invalid');
 return structuredClone(source);
}
export function validateConversationSources(mission:Mission):void {
 for(const work of mission.works){const source=conversationSourceInput(work);if(!source)continue;const captured=captureConversationSource(mission,{workId:source.workId,messageId:source.messageId,messageHash:source.messageHash},source.actorId);ensure(hash(source)===hash(captured),'Conversation provenance differs from original source');}
}
