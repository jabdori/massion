import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';

const exec=promisify(execFile);
export const nativeForm='<form id="form" method="post" action="/submitted"><label>비공개 입력<input id="field" name="private" type="password"></label><select id="quantity" name="quantity"><option value="one">1</option><option value="two">2</option></select><label><input id="terms" type="checkbox">약관 확인</label><button id="submit" type="submit">신청서 제출</button></form><label><input id="device" type="checkbox">기기 확인</label><form method="post" action="/payment"><button id="pay" type="submit">결제 의도 승인</button></form><div id="scroll" style="height:50px;overflow:auto"><p style="height:900px">신청 자료</p></div><p id="owner-text"></p>';

// 기존 네이티브 테스트와 같은 실행 설정을 보존해 소유자만 별도로 조작합니다.
export async function nativeEnvironmentFixture(root:string){
 await mkdir(root,{recursive:true});
 const previousPath=process.env.PATH,realBrowser=(await exec('which',['agent-browser'])).stdout.trim(),extra=process.env.MASSION_E2E_BROWSER?['--executable-path',process.env.MASSION_E2E_BROWSER]:[];
 let submissions=0,paymentCalls=0,filled=false;
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
 const server=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(join(root,'cert.pem'))},(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');
  if(req.url==='/payment'){paymentCalls++;req.resume();res.writeHead(405);res.end();return;}
  if(req.method==='POST'&&req.url==='/submitted'){
   submissions++;let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{filled=new URLSearchParams(body).get('private')==='SYNTHETIC-PRIVATE-FIELD';res.end('<!doctype html><title>로컬 신청 접수</title><h1>신청 접수</h1>'+nativeForm);});return;
  }
  if(req.method!=='GET'||req.url!=='/'){req.resume();res.writeHead(404);res.end();return;}
  res.end('<!doctype html><title>로컬 주문 자료</title><h1>지난 주문</h1><p>수량 1 · 합계 34,000원</p><div id="form-host"></div><script>document.body.dataset.scriptRan="yes"</script>');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 server.unref();
 const origin='https://127.0.0.1:'+(server.address() as {port:number}).port;
 const envKeys=['PATH','HOME','TMPDIR','AGENT_BROWSER_NO_WEBMCP','AGENT_BROWSER_PLUGINS','AGENT_BROWSER_NO_VERSION_CHECK','AGENT_BROWSER_IDLE_TIMEOUT_MS'];
 await writeFile(join(root,'agent-browser'),'#!'+process.execPath+'\nconst {spawnSync}=require("node:child_process"),fs=require("node:fs"),a=process.argv.slice(2);fs.writeFileSync('+JSON.stringify(join(root,'session.json'))+',JSON.stringify({prefix:a.slice(0,a.indexOf("--json")+1),config:a[a.indexOf("--config")+1],env:Object.fromEntries('+JSON.stringify(envKeys)+'.map(k=>[k,process.env[k]]))}));const r=spawnSync('+JSON.stringify(realBrowser)+',[...a,"--ignore-https-errors",...'+JSON.stringify(extra)+'],{stdio:"inherit"});process.exit(r.status??1);\n',{mode:0o700});
 process.env.PATH=root+':'+previousPath;
 const owner=async(expression:string)=>{
  const session=JSON.parse(await readFile(join(root,'session.json'),'utf8'));
  const {stdout}=await exec(realBrowser,[...session.prefix,'--ignore-https-errors',...extra,'eval','-b',Buffer.from(expression).toString('base64')],{env:session.env,cwd:dirname(session.config),timeout:15000});
  const result=JSON.parse(stdout);assert.equal(result.success,true,result.error);return result.data.result;
 };
 return {origin,owner,counts:()=>({submissions,paymentCalls,filled}),async close(){process.env.PATH=previousPath;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
