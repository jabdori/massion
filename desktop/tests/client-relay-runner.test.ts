import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {once} from 'node:events';
import {access,mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {control} from '../daemon.ts';

test('the real supervisor serves the client connection kind beside the one-shot commands',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-runner-')),socket=join(root,'daemon.sock'),document=join(root,'app.html'),core=join(root,'core.mjs');
 const html='<html><body>fixture</body></html>';
 await writeFile(document,html);
 await writeFile(core,'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0));');
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 const runner=new URL('../daemon-runner.mjs',import.meta.url).pathname;
 const child=spawn(process.execPath,[runner,socket,core,'http://127.0.0.1:8799'],{env:{...process.env,MASSION_DESKTOP_HTML:document},stdio:['ignore','ignore','inherit']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 for(let n=0;n<50;n++){try{await control(socket,'status');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 const status=await control(socket,'status');
 assert.equal(status.status,'running');assert.ok(status.pid);

 const client=connect(socket);
 const lines:string[]=[];let buffer='';
 client.on('data',chunk=>{
  buffer+=String(chunk);let index;
  while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line)lines.push(line);}
 });
 client.write('client\n');
 await new Promise(resolve=>setTimeout(resolve,150));
 client.write(JSON.stringify({id:'doc',method:'GET',path:'/'})+'\n');
 client.write(JSON.stringify({id:'no',method:'GET',path:'/health'})+'\n');
 const deadline=Date.now()+5000;
 while(Date.now()<deadline&&lines.length<2)await new Promise(resolve=>setTimeout(resolve,20));
 const replies=lines.map(line=>JSON.parse(line));
 const served=replies.find(value=>value.id==='doc'),refused=replies.find(value=>value.id==='no');
 assert.equal(served.status,200);assert.equal(served.body,html);
 assert.match(served.headers['Content-Security-Policy'],/connect-src 'self' ipc: http:\/\/ipc\.localhost/);
 assert.equal(refused.error.code,'path');
 assert.equal((await control(socket,'status')).pid,status.pid,'the one-shot commands still answer while a client is attached');
 client.destroy();
});

test('data buffered while the relay initialises is bounded in bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'relay-backlog-')),socket=join(root,'daemon.sock'),document=join(root,'app.html'),core=join(root,'core.mjs');
 await writeFile(document,'<html>ok</html>');
 await writeFile(core,'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0));');
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 const runner=new URL('../daemon-runner.mjs',import.meta.url).pathname;
 const child=spawn(process.execPath,[runner,socket,core,'http://127.0.0.1:8798'],{env:{...process.env,MASSION_DESKTOP_HTML:document},stdio:['ignore','ignore','inherit']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 for(let n=0;n<50;n++){try{await control(socket,'status');break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
 const client=connect(socket);
 client.on('error',()=>{});
 const closed=new Promise(resolve=>client.once('close',resolve));
 const payload='가'.repeat(23470); // 23,470 UTF-16 units but 70,410 UTF-8 bytes, no newline
 client.write('client\n'+payload);
 await closed;
});

test('the default development core entry resolves inside the repository',async()=>{
 const source=await readFile(new URL('../daemon-runner.mjs',import.meta.url),'utf8');
 const match=source.match(/const entry=entryArgument\?\?fileURLToPath\(new URL\('([^']+)',import\.meta\.url\)\)/);
 assert.ok(match,'the runner must derive a default core entry');
 await access(new URL(match[1]!,new URL('../daemon-runner.mjs',import.meta.url)));
});
