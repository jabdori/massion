import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpsServer} from 'node:https';
import {createServer as httpServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localBrowserAdapter} from '../../src/headless-browser.ts';

const exec=promisify(execFile);
test('production browser grants only one HTTPS origin before parser requests and redirects',{timeout:120000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-origin-')),originalPath=process.env.PATH,realBrowser=(await exec('which',['agent-browser'])).stdout.trim();
 const downloads=join(root,'downloads');await mkdir(downloads);const servers=[];let denied=0,wrongScheme=0;const allowed=[];
 const listen=async server=>{servers.push(server);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;};
 try{
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
  const tls={key:await readFile(join(root,'key.pem')),cert:await readFile(join(root,'cert.pem'))};
  const forbidden=httpsServer(tls,(_req,res)=>res.end('Forbidden origin'));forbidden.on('connection',()=>denied++);const otherPort=await listen(forbidden);
  const insecure=httpServer((_req,res)=>res.end('Forbidden scheme'));insecure.on('connection',()=>denied++);const httpPort=await listen(insecure);
  let port;const source=httpsServer(tls,(req,res)=>{allowed.push(req.url);res.setHeader('Cache-Control','no-store');
   if(req.url==='/download'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename=fixture.txt'});res.end('Fixture attachment');return;}
   if(req.url==='/redirect'){res.writeHead(302,{Location:'https://127.0.0.1:'+otherPort+'/redirect-target'});res.end();return;}
   if(req.url==='/scheme'){res.writeHead(302,{Location:'http://127.0.0.1:'+port+'/scheme-target'});res.end();return;}
   if(req.url==='/good.css'){res.setHeader('Content-Type','text/css');res.end('body{margin:12px}');return;}
   res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Allowed page</title><link rel="stylesheet" href="/good.css"><p>Allowed read</p><img src="https://127.0.0.1:'+otherPort+'/parser-image"><img src="http://127.0.0.1:'+httpPort+'/parser-http">');
  });source.on('tlsClientError',error=>{if(error.code==='ERR_SSL_HTTP_REQUEST'||/http request/i.test(error.message))wrongScheme++;});port=await listen(source);
  // The fixture certificate is trusted only by this test wrapper, never by product configuration.
  await writeFile(join(root,'agent-browser'),'#!'+process.execPath+'\nconst {spawnSync}=require("node:child_process");const result=spawnSync('+JSON.stringify(realBrowser)+',[...process.argv.slice(2),"--ignore-https-errors","--download-path",'+JSON.stringify(downloads)+'],{stdio:"inherit"});process.exit(result.status??1);\n',{mode:0o700});process.env.PATH=root+':'+originalPath;
  const origin='https://127.0.0.1:'+port,adapter=localBrowserAdapter({MASSION_BROWSER_READS:'1',MASSION_BROWSER_ORIGINS:origin});
  const read=path=>adapter.read({address:origin+path,sessionId:'origin-fixture',signal:AbortSignal.timeout(30000)});
  const page=await read('/page');assert.equal(page.title,'Allowed page');assert.ok(page.screenshot);assert.ok(allowed.includes('/good.css'));assert.equal(denied,0,'Parser resources must not connect to other ports');
  await read('/redirect').catch(()=>{});assert.ok(allowed.includes('/redirect'));assert.equal(denied,0,'A redirect must be blocked before the target sees a connection');
  await read('/scheme').catch(()=>{});assert.ok(allowed.includes('/scheme'));assert.equal(wrongScheme,0,'HTTP must not connect to the granted HTTPS port');assert.ok(!allowed.includes('/scheme-target'));
  await read('/download').catch(()=>{});assert.ok(allowed.includes('/download'));assert.deepEqual(await readdir(downloads),[],'Read-only navigation must never write an attachment');
 }finally{process.env.PATH=originalPath;for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(root,{recursive:true,force:true});}
});
