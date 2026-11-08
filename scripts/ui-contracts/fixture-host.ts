import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {workbenchPage} from '../../src/workbench.ts';

export interface FixtureStep {
 selector:string;
 action:'click'|'fill';
 value?:string;
 readySelector?:string;
}
export interface ScreenFixture {
 screen:string;
 description:string;
 now:number;
 readySelector:string;
 steps:FixtureStep[];
 gaps:string[];
 reuse:string[];
 routes:Record<string,{status:number;body:unknown}>;
 appViews?:Array<{request:{app:string;handler:'page'|'item';ref?:string};body:unknown}>;
}

const fixtureDirectory=new URL('./fixtures/',import.meta.url);
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;

export async function loadFixture(screen:string):Promise<ScreenFixture>{
 if(!/^B(?:[1-9]|1\d|2[0-5])(?:-[a-z]+)*$/.test(screen))throw new Error('Unknown fixture screen: '+screen);
 const fixture=JSON.parse(await readFile(new URL(screen+'.json',fixtureDirectory),'utf8'));
 if(fixture.screen!==screen||!text(fixture.description)||!Number.isSafeInteger(fixture.now)||!text(fixture.readySelector)||
  !Array.isArray(fixture.gaps)||!fixture.gaps.every(text)||!Array.isArray(fixture.reuse)||!fixture.reuse.every(text)||
  !Array.isArray(fixture.steps)||!fixture.steps.every((s:FixtureStep)=>s&&text(s.selector)&&['click','fill'].includes(s.action)&&(s.action!=='fill'||typeof s.value==='string')&&(s.readySelector===undefined||text(s.readySelector)))||
  !fixture.routes||typeof fixture.routes!=='object'||Array.isArray(fixture.routes))throw new Error('Invalid fixture: '+screen);
 for(const [path,response] of Object.entries(fixture.routes) as [string,{status:number;body:unknown}][]){
  if(!path.startsWith('/')||path.startsWith('//')||path.includes('#')||path.includes('\\')||new URL(path,'http://fixture').pathname.includes('..')||
   !response||!Number.isInteger(response.status)||response.status<200||response.status>599||!Object.hasOwn(response,'body'))throw new Error('Invalid fixture route: '+path);
 }
 if(fixture.appViews!==undefined&&(!Array.isArray(fixture.appViews)||!fixture.appViews.every((view:NonNullable<ScreenFixture['appViews']>[number])=>view&&text(view.request?.app)&&['page','item'].includes(view.request.handler)&&(view.request.ref===undefined||text(view.request.ref))&&Object.hasOwn(view,'body'))))throw new Error('Invalid app views: '+screen);
 return fixture;
}

const scriptHashes=[...workbenchPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>"'sha256-"+createHash('sha256').update(match[1]!).digest('base64')+"'");
const csp=["default-src 'self'","script-src 'self' "+scriptHashes.join(' '),"style-src 'self' 'unsafe-inline'","connect-src 'self'","img-src 'self' data:","font-src 'self'","frame-src 'none'","frame-ancestors 'none'","object-src 'none'","base-uri 'none'","form-action 'none'"].join('; ');

export async function startFixtureHost(screen:string):Promise<{url:string;fixture:ScreenFixture;close:()=>Promise<void>}>{
 const fixture=await loadFixture(screen);
 let origin='';
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',csp);res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const fail=(status:number,error:string)=>{res.statusCode=status;res.end(JSON.stringify({error}));};
  const appView=req.method==='POST'&&req.url==='/assistant/apps/view'&&!!fixture.appViews?.length;
  if(req.method!=='GET'&&!appView){res.setHeader('Allow','GET');fail(405,'Fixture host rejects product commands');return;}
  if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==origin.slice('http://'.length)||req.headers.origin&&req.headers.origin!==origin){fail(403,'Fixture host allows its loopback origin only');return;}
  let url:URL;
  try{url=new URL(req.url!,origin);}catch{fail(400,'Invalid request URL');return;}
  if(url.origin!==origin){fail(403,'Fixture host allows its loopback origin only');return;}
  const path=url.pathname+url.search;
  if(appView){
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){fail(415,'App view requires JSON');return;}
   const raw=await new Promise<Buffer|null>(resolve=>{
    let size=0;const chunks:Buffer[]=[];
    req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>8192){chunks.length=0;resolve(null);}else chunks.push(chunk);});
    req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',()=>resolve(null));req.on('aborted',()=>resolve(null));
   });
   if(raw===null){fail(413,'App view body exceeds 8192 bytes or was interrupted');return;}
   let body:Record<string,unknown>;
   try{body=JSON.parse(raw.toString('utf8'));}catch{fail(400,'Invalid app view JSON');return;}
   const view=body&&typeof body==='object'&&!Array.isArray(body)&&fixture.appViews!.find(v=>{
    const expected=v.request as Record<string,unknown>,keys=Object.keys(body);
    return keys.length===Object.keys(expected).length&&keys.every(key=>Object.hasOwn(expected,key)&&body[key]===expected[key]);
   });
   if(!view){fail(404,'No fixture response for this app view');return;}
   res.end(JSON.stringify(view.body));return;
  }
  if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(workbenchPage);return;}
  if(path==='/__fixture'){res.end(JSON.stringify(fixture));return;}
  const key=/^\/events\?after=(0|[1-9]\d*)$/.test(path)&&Number.isSafeInteger(Number(url.searchParams.get('after')))?'/events':path;
  if(!Object.hasOwn(fixture.routes,key)){fail(404,'No fixture response for '+path);return;}
  const response=fixture.routes[key]!;res.statusCode=response.status;res.end(JSON.stringify(response.body));
 });
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
 });
 origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 let closing:Promise<void>|undefined;
 return {url:origin+'/',fixture:structuredClone(fixture),close:()=>closing??=new Promise<void>((resolve,reject)=>{
  server.close(error=>error?reject(error):resolve());server.closeAllConnections();
 })};
}
