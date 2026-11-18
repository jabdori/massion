import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:https';
import {join} from 'node:path';
import {localBrowserAdapter} from '../../src/headless-browser.ts';

const [certificateDirectory]=process.argv.slice(2);
assert.equal(process.env.MASSION_E2E_BROWSER,undefined);
const site=createServer({
 key:await readFile(join(certificateDirectory,'key.pem')),
 cert:await readFile(join(certificateDirectory,'cert.pem')),
},(_request,response)=>{
 console.log('FLAKE-260 synthetic HTTPS origin reached');
 response.setHeader('Content-Type','text/html');
 response.end('<!doctype html><title>Fixture</title><p>Browser read</p>');
});
site.listen(0,'127.0.0.1');
await once(site,'listening');
const origin='https://127.0.0.1:'+site.address().port;
const adapter=localBrowserAdapter({MASSION_BROWSER_READS:'1',MASSION_BROWSER_ORIGINS:origin});
const started=performance.now();
try{
 const page=await adapter.read({address:origin+'/',sessionId:'flake-260',signal:AbortSignal.timeout(180000)});
 assert.equal(page.title,'Fixture');
 assert.deepEqual(page.blocks,['Browser read']);
 console.log('FLAKE-260 standalone product read passed',Math.round(performance.now()-started));
}catch(error){
 console.error('FLAKE-260 standalone product read failed',Math.round(performance.now()-started),error);
 throw error;
}finally{
 site.closeAllConnections();
 await new Promise(resolve=>site.close(resolve));
}
