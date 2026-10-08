import {DomainError,hash} from './domain.ts';
import type {Conversation,Mission} from './domain.ts';
import type {Store} from './storage.ts';
export const CONVERSATION_MESSAGE_BYTES=4096,CONVERSATION_MESSAGES=100,CONVERSATION_BYTES=262144,CONVERSATIONS=100,CONVERSATIONS_BYTES=1048576;
export const workConversationId=(missionId:string,workId:string|null)=>'conversation:'+hash({missionId,workId}).slice(0,40);
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const id=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(value);
function valid(condition:unknown,message:string):asserts condition {if(!condition)throw new DomainError(message);}
/** Discussion is separate durable provenance, never runtime input or a permission grant. */
export function validateConversations(mission:Mission):void {
 if(!Object.hasOwn(mission,'conversations'))return;const threads=mission.conversations;valid(Array.isArray(threads)&&threads.length>0&&threads.length<=CONVERSATIONS&&Object.keys(threads).length===threads.length,'Invalid conversation count');
 valid(Buffer.byteLength(JSON.stringify(threads),'utf8')<=CONVERSATIONS_BYTES,'Mission conversation storage bound exceeded');const workIds=new Set<string|null>(),messageIds=new Set<string>();
 for(const thread of threads){valid(exact(thread,['id','workId','messages'])&&(thread.workId===null||id(thread.workId)&&mission.works.filter(w=>w.id===thread.workId).length===1)&&thread.id===workConversationId(mission.id,thread.workId)&&!workIds.has(thread.workId),'Conversation must bind this Mission or one exact existing Work');workIds.add(thread.workId);valid(Array.isArray(thread.messages)&&thread.messages.length>0&&thread.messages.length<=CONVERSATION_MESSAGES&&Object.keys(thread.messages).length===thread.messages.length&&Buffer.byteLength(JSON.stringify(thread),'utf8')<=CONVERSATION_BYTES,'Conversation message storage bound exceeded');const prior=new Set<string>();
  for(const [index,message] of thread.messages.entries()){valid(exact(message,['id','ordinal','actorId','role','replyTo','text'])&&id(message.id)&&!messageIds.has(message.id)&&message.ordinal===index+1&&id(message.actorId)&&message.role==='owner','Invalid conversation owner message');valid(message.replyTo===null||id(message.replyTo)&&prior.has(message.replyTo),'Reply must name an earlier message in this exact conversation');valid(typeof message.text==='string'&&message.text.trim().length>0&&message.text.isWellFormed()&&Buffer.byteLength(message.text,'utf8')<=CONVERSATION_MESSAGE_BYTES,'Message must be bounded nonempty well-formed UTF-8');prior.add(message.id);messageIds.add(message.id);}
 }
}
export class ConversationReadError extends Error {readonly status:409|503;constructor(status:409|503,message:string){super(message);this.status=status;}}
export async function readWorkConversation(store:Store<Mission>,missionId:string,workId:string,feedId?:string){
 const state=await store.readState(missionId);if(feedId!==undefined&&state.feedId!==feedId)throw new ConversationReadError(409,'Database feed changed before exact Work conversation read');const mission=state.snapshot?.value;if(!mission?.works.some(w=>w.id===workId))return null;
 try{validateConversations(mission);}catch{throw new ConversationReadError(503,'Stored conversation failed original identity, order or reply integrity checks');}
 const conversation=mission.conversations?.find(c=>c.workId===workId);return {missionId,workId,revision:state.snapshot!.revision,feedId:state.feedId,cursor:state.cursor,conversation:conversation?structuredClone(conversation):null};
}

export async function readMissionConversation(store:Store<Mission>,missionId:string,feedId?:string){
 const state=await store.readState(missionId);if(feedId!==undefined&&state.feedId!==feedId)throw new ConversationReadError(409,'Database feed changed before exact Mission conversation read');const mission=state.snapshot?.value;if(!mission)return null;try{validateConversations(mission);}catch{throw new ConversationReadError(503,'Stored conversation failed original identity, order or reply integrity checks');}const conversation=mission.conversations?.find(c=>c.workId===null);return {missionId,revision:state.snapshot!.revision,feedId:state.feedId,cursor:state.cursor,conversation:conversation?structuredClone(conversation):null};
}
