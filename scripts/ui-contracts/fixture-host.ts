import {browserFixture} from './browser-fixtures.ts';
import {MEMORY_SCREENS,memoryFixture} from './memory-fixtures.ts';
import {GROWTH_SCREENS,growthFixture} from './growth-fixtures.ts';
import {protocolConnection,protocolSupport,validHeader,validRange} from '../../src/protocol.ts';
import type {ProtocolHeader} from '../../src/protocol.ts';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {workbenchPage} from '../../src/workbench.ts';
import {daemonGuard} from '../../src/daemon-auth.ts';
import {EFFECT_SCREENS,effectFixture} from './effect-fixtures.ts';

export type FixtureStep={selector:string;action:'click'|'fill';value?:string;readySelector?:string}|{action:'offline';value:'true'|'false';readySelector?:string};
export interface ScreenFixture {
 screen:string;
 description:string;
 now:number;
 readySelector:string;
 steps:FixtureStep[];
 captureScroll?:{selector:string;top:number};
 gaps:string[];
 reuse:string[];
 routes:Record<string,{status:number;body:unknown}>;
 appViews?:Array<{request:{app:string;handler:'page'|'item';ref?:string};body:unknown}>;
}

const fixtureDirectory=new URL('./fixtures/',import.meta.url);
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;

export async function loadFixture(screen:string,parents:string[]=[]):Promise<ScreenFixture>{
 if(!/^B[1-9]\d*(?:-[a-z]+)*$/.test(screen))throw new Error('Unknown fixture screen: '+screen);
 if(parents.includes(screen))throw new Error('Fixture inheritance cycle: '+[...parents,screen].join(' -> '));
 const raw=JSON.parse(await readFile(new URL(screen+'.json',fixtureDirectory),'utf8'));
 if(raw.screen!==screen)throw new Error('Invalid fixture: '+screen);
 if(raw.extends!==undefined&&!text(raw.extends))throw new Error('Invalid fixture parent: '+screen);
 const base=raw.extends?await loadFixture(raw.extends,[...parents,screen]):null;
 const fixture=base?{...base,...raw,routes:{...base.routes,...raw.routes}}:raw;
 if(fixture.screen!==screen||!text(fixture.description)||!Number.isSafeInteger(fixture.now)||!text(fixture.readySelector)||
  !Array.isArray(fixture.gaps)||!fixture.gaps.every(text)||!Array.isArray(fixture.reuse)||!fixture.reuse.every(text)||
  !Array.isArray(fixture.steps)||!fixture.steps.every((s:FixtureStep)=>s&&(s.action==='offline'?['true','false'].includes(s.value):text(s.selector)&&['click','fill'].includes(s.action)&&(s.action!=='fill'||typeof s.value==='string'))&&(s.readySelector===undefined||text(s.readySelector)))||
  !fixture.routes||typeof fixture.routes!=='object'||Array.isArray(fixture.routes))throw new Error('Invalid fixture: '+screen);
 if(fixture.captureScroll&&(!text(fixture.captureScroll.selector)||!Number.isSafeInteger(fixture.captureScroll.top)||fixture.captureScroll.top<0))throw new Error('Invalid capture scroll: '+screen);
 for(const [path,response] of Object.entries(fixture.routes) as [string,{status:number;body:unknown}][]){
  if(!path.startsWith('/')||path.startsWith('//')||path.includes('#')||path.includes('\\')||new URL(path,'http://fixture').pathname.includes('..')||
   !response||!Number.isInteger(response.status)||response.status<200||response.status>599||!Object.hasOwn(response,'body'))throw new Error('Invalid fixture route: '+path);
 }
 if(fixture.appViews!==undefined&&(!Array.isArray(fixture.appViews)||!fixture.appViews.every((view:NonNullable<ScreenFixture['appViews']>[number])=>view&&text(view.request?.app)&&['page','item'].includes(view.request.handler)&&(view.request.ref===undefined||text(view.request.ref))&&Object.hasOwn(view,'body'))))throw new Error('Invalid app views: '+screen);
 if(parents.length!==0)return fixture;const produced=EFFECT_SCREENS.includes(screen)?await effectFixture(fixture):fixture;const observed=['B15','B5','B7'].includes(screen)?await browserFixture(produced):produced;const growth=GROWTH_SCREENS.includes(screen)?await growthFixture(observed):observed;return MEMORY_SCREENS.includes(screen)?memoryFixture(growth):growth;
}

const scriptHashes=[...workbenchPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>"'sha256-"+createHash('sha256').update(match[1]!).digest('base64')+"'");
const csp=["default-src 'self'","script-src 'self' "+scriptHashes.join(' '),"style-src 'self' 'unsafe-inline'","connect-src 'self'","img-src 'self' data:","font-src 'self'","frame-src 'none'","frame-ancestors 'none'","object-src 'none'","base-uri 'none'","form-action 'none'"].join('; ');

export async function startFixtureHost(screen:string|ScreenFixture,options:{daemonSecret?:string;port?:number}={}):Promise<{url:string;fixture:ScreenFixture;close:()=>Promise<void>}>{
 const fixture=typeof screen==='string'?await loadFixture(screen):structuredClone(screen);
 const authenticate=options.daemonSecret===undefined?undefined:daemonGuard(options.daemonSecret);
 let origin='';
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',csp);res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  let envelope:ProtocolHeader|undefined,protocolPayload:Record<string,unknown>|undefined,method=req.method;
  const send=(status:number,payload:unknown)=>{res.statusCode=status;res.end(JSON.stringify(envelope?{...envelope,version:protocolSupport.max,kind:'reply',status,payload}:payload));};
  const fail=(status:number,error:string)=>send(status,{error});
  let appView=method==='POST'&&req.url==='/assistant/apps/view'&&!!fixture.appViews?.length;
  const protocolPost=method==='POST'&&['/protocol/connect','/protocol/request'].includes(req.url??'');
  if(method!=='GET'&&!appView&&!protocolPost){res.setHeader('Allow','GET');fail(405,'Fixture host rejects product commands');return;}
  if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==origin.slice('http://'.length)||req.headers.origin&&req.headers.origin!==origin){fail(403,'Fixture host allows its loopback origin only');return;}
  if(authenticate&&!authenticate(req,res))return;
  let url:URL;
  try{url=new URL(req.url!,origin);}catch{fail(400,'Invalid request URL');return;}
  if(url.origin!==origin){fail(403,'Fixture host allows its loopback origin only');return;}
  let path=url.pathname+url.search;
  if(path==='/protocol/connect'||path==='/protocol/request'){
   if(!protocolPost||req.headers['content-type']!=='application/json'){fail(415,'Protocol requires JSON POST');return;}
   let raw='';try{for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>49152){fail(413,'Fixture protocol body too large');return;}}}catch{fail(400,'Interrupted protocol body');return;}
   let message:Record<string,unknown>;try{message=JSON.parse(raw);}catch{fail(400,'Invalid protocol JSON');return;}
   if(!validHeader(message)){fail(400,'Invalid protocol header');return;}envelope=message;
   if(path==='/protocol/connect'){if(!validRange(message.supported)){fail(400,'Invalid protocol range');return;}const info=protocolConnection(message.supported);send(info.state==='ready'?200:426,info);return;}
   if(message.version<protocolSupport.min||message.version>protocolSupport.max){fail(426,'Unsupported protocol version');return;}
   if(!['command','query'].includes(String(message.kind))||typeof message.path!=='string'||!/^\/(?!\/)/.test(message.path)||message.path.startsWith('/protocol')||/[\\#\r\n]/.test(message.path)){fail(400,'Invalid fixture protocol path');return;}
   url=new URL(message.path,origin);path=url.pathname+url.search;method=message.kind==='command'?'POST':'GET';protocolPayload=message.payload as Record<string,unknown>;
   appView=method==='POST'&&path==='/assistant/apps/view'&&!!fixture.appViews?.length;
   if(method!=='GET'&&!appView){res.setHeader('Allow','GET');fail(405,'Fixture host rejects product commands');return;}
  }
  if(url.pathname==='/protocol/events'){
   const header={version:Number(url.searchParams.get('version')),requestId:url.searchParams.get('requestId'),generation:Number(url.searchParams.get('generation'))};
   if(!validHeader(header)||header.version!==protocolSupport.max){fail(426,'Unsupported feed protocol');return;}
   const position=fixture.routes['/events']!.body as {feedId:string;cursor:number};
   res.setHeader('Content-Type','text/event-stream');res.write('id: '+JSON.stringify([position.feedId,position.cursor])+'\ndata: '+JSON.stringify({...header,kind:'feed',reason:'connected',feedId:position.feedId,cursor:position.cursor})+'\n\n');return;
  }
  if(appView){
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){fail(415,'App view requires JSON');return;}
   let body:Record<string,unknown>;
   if(envelope){body=protocolPayload!;if(body===undefined||Buffer.byteLength(JSON.stringify(body))>8192){fail(413,'App view body exceeds 8192 bytes');return;}}
   else{
   const raw=await new Promise<Buffer|null>(resolve=>{
    let size=0;const chunks:Buffer[]=[];
    req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>8192){chunks.length=0;resolve(null);}else chunks.push(chunk);});
    req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',()=>resolve(null));req.on('aborted',()=>resolve(null));
   });
   if(raw===null){fail(413,'App view body exceeds 8192 bytes or was interrupted');return;}
   try{body=JSON.parse(raw.toString('utf8'));}catch{fail(400,'Invalid app view JSON');return;}
   }
   const view=body&&typeof body==='object'&&!Array.isArray(body)&&fixture.appViews!.find(v=>{
    const expected=v.request as Record<string,unknown>,keys=Object.keys(body);
    return keys.length===Object.keys(expected).length&&keys.every(key=>Object.hasOwn(expected,key)&&body[key]===expected[key]);
   });
   if(!view){fail(404,'No fixture response for this app view');return;}
   send(200,view.body);return;
  }
  if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(workbenchPage);return;}
  if(path==='/__fixture'){send(200,fixture);return;}
  const key=/^\/events\?after=(0|[1-9]\d*)$/.test(path)&&Number.isSafeInteger(Number(url.searchParams.get('after')))?'/events':path;
  if(!Object.hasOwn(fixture.routes,key)){fail(404,'No fixture response for '+path);return;}
  const response=fixture.routes[key]!;send(response.status,response.body);
 });
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);server.listen(options.port??0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
 });
 origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 let closing:Promise<void>|undefined;
 return {url:origin+'/',fixture:structuredClone(fixture),close:()=>closing??=new Promise<void>((resolve,reject)=>{
  server.close(error=>error?reject(error):resolve());server.closeAllConnections();
 })};
}
