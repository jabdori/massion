// A fake authenticated core shared by the Rust carrier end-to-end test and
// the JS relay tests, so the subscription wire shape cannot drift between the
// two. It reads the supervisor secret from fd 3 exactly like the real core
// (src/daemon-auth.ts), answers the protocol routes the relay uses, emits one
// feed event per subscription, and records stream closes and core starts in
// $MASSION_FEED_STATE (default ./feed-core-state.log, one JSON line each).
import {createServer} from 'node:http';
import {appendFile} from 'node:fs/promises';
import {daemonGuard,inheritedDaemonSecret} from '../../../src/daemon-auth.ts';
import {protocolConnection} from '../../../src/protocol.ts';

const secret=inheritedDaemonSecret();
const port=Number(process.env.MASSION_PORT??'0'),state=process.env.MASSION_FEED_STATE??'feed-core-state.log';
// A record this core cannot write, or a request it cannot serve, must reach the
// test as a marked stderr line and a non-zero exit instead of being swallowed.
const fail=error=>{process.stderr.write('feed-core error: '+(error&&error.stack||error)+'\n');process.exit(1);};
const note=kind=>appendFile(state,JSON.stringify({kind,pid:process.pid,at:Date.now()})+'\n').catch(fail);
const authenticate=daemonGuard(secret);
let streams=0;

// One aborted connection must never kill the fake core under concurrent-suite load.
const server=createServer(async(req,res)=>{
 req.on('error',()=>{});
 res.on('error',()=>{});
 try{
  if(!authenticate(req,res))return;
  if(req.url?.startsWith('/protocol/events')){
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});
    const cursor=req.headers['last-event-id']??'["feed",0]';
    res.write('id: '+cursor+'\ndata: {"connected":true}\n\n');
    streams++;await note('stream');
    res.on('close',()=>{streams--;void note('closed');});
    return;
  }
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks).toString('utf8');
  let message={};try{message=JSON.parse(body);}catch{}
  if(req.url==='/protocol/connect'){res.end(JSON.stringify({...message,kind:'reply',status:200,payload:protocolConnection({min:1,max:1})}));return;}
  if(req.url==='/protocol/request'){
    const path=String(message.path??'');
    if(path==='/assistant/works')res.end(JSON.stringify({...message,kind:'reply',status:200,payload:{feedId:'feed',works:[{missionId:'mission',workId:'work',turnId:'turn',title:'Broken work',acceptance:'failed'}]}}));
    else if(path==='/assistant/conversation')res.end(JSON.stringify({...message,kind:'reply',status:200,payload:{feedId:'feed',decisions:[],members:[]}}));
    else res.end(JSON.stringify({...message,kind:'reply',status:200,payload:{}}));
    return;
  }
  res.end('{}');
 }catch(error){fail(error);}
});
server.listen(port,'127.0.0.1',()=>{void note('start');process.stdout.write('listening');});
process.on('SIGTERM',()=>{server.close();setTimeout(()=>process.exit(0),50);});
setInterval(()=>{},1000);
