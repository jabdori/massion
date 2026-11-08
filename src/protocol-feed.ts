import type {ServerResponse} from 'node:http';
import type {Store,FeedPosition} from './storage.ts';
import type {FeedHint,FeedSubscription} from './protocol.ts';

/** One observer per host, active only while clients subscribe. It never writes. */
export function createProtocolFeed(store:Pick<Store<unknown>,'readState'|'readCatchup'>){
 type Client={response:ServerResponse;message:FeedSubscription;position:FeedPosition};
 const clients=new Set<Client>();
 let timer:ReturnType<typeof setInterval>|undefined,reading=false,again=false,closed=false;
 function remove(client:Client){
  clients.delete(client);if(!clients.size){clearInterval(timer);timer=undefined;}
 }
 function emit(client:Client,hint:Omit<FeedHint,'version'|'requestId'|'generation'|'kind'>){
  if(!clients.has(client))return;
  const {version,requestId,generation}=client.message,event:FeedHint={version,requestId,generation,kind:'feed',...hint};
  const position={feedId:hint.feedId,cursor:hint.cursor};
  if(!client.response.write('id: '+JSON.stringify([position.feedId,position.cursor])+'\ndata: '+JSON.stringify(event)+'\n\n')){
   remove(client);client.response.destroy();return;
  }
  client.position=position;
 }
 async function wake(){
  if(closed||!clients.size)return;if(reading){again=true;return;}reading=true;
  try{do{again=false;const head=await store.readState();
   await Promise.all([...clients].map(async client=>{
    if(!clients.has(client))return;
    const {feedId,cursor}=client.position;
    if(feedId!==head.feedId||cursor>head.cursor){emit(client,{reason:'reset',feedId:head.feedId,cursor:head.cursor});return;}
    if(cursor===head.cursor)return;
    try{
     const page=await store.readCatchup(cursor,feedId,100);
     let after=cursor;
     for(const batch of page.events){
      if(batch.cursor!==after+1){emit(client,{reason:'reset',feedId:head.feedId,cursor:head.cursor});return;}
      emit(client,{reason:'revision',feedId:page.feedId,cursor:batch.cursor,aggregateId:batch.aggregateId,revision:batch.revision});after=batch.cursor;
     }
     if(after===cursor&&after<head.cursor){emit(client,{reason:'reset',feedId:head.feedId,cursor:head.cursor});return;}
     if(clients.has(client)&&page.cursor<head.cursor)again=true;
    }catch{remove(client);client.response.destroy();}
   }));
  }while(again&&!closed&&clients.size);}catch{for(const client of clients){client.response.destroy();}clients.clear();clearInterval(timer);timer=undefined;}finally{reading=false;}
 }
 async function subscribe(response:ServerResponse,message:FeedSubscription){
  const head=await store.readState();if(closed){response.end();return;}
  response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});
  const client={response,message,position:{feedId:message.feedId??head.feedId,cursor:message.after}};clients.add(client);response.on('close',()=>remove(client));
  emit(client,{reason:'connected',...client.position});
  if(clients.size&&!timer){timer=setInterval(()=>void wake(),1000);timer.unref();}
  void wake();
 }
 function close(){closed=true;clearInterval(timer);timer=undefined;for(const client of clients)client.response.end();clients.clear();}
 return {subscribe,wake,close};
}
