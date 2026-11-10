import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openBrowserEnvironment} from '../../src/headless-browser.ts';
import {EnvironmentActions} from '../../src/environment-actions.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';

const exec=promisify(execFile);
test('owned browser fills, selects, scrolls, pauses for owner state and submits a synthetic local form once',{timeout:120000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'massion-actions-')),previousPath=process.env.PATH,realBrowser=(await exec('which',['agent-browser'])).stdout.trim(),extra=process.env.MASSION_E2E_BROWSER?['--executable-path',process.env.MASSION_E2E_BROWSER]:[];
 let browser,server,posts=0,posted='',now=1000;const store=new InMemoryStore(),signal=AbortSignal.timeout(110000);
 try{
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
  server=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(join(root,'cert.pem'))},(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');
   if(req.method==='POST'){posts++;req.on('data',chunk=>posted+=chunk);req.on('end',()=>res.end('<!doctype html><title>Observed receipt</title><p id="receipt">Request received</p>'));return;}
   res.end('<!doctype html><title>Fixture form</title><form method="post" action="/received"><label>Private input<input id="field" name="private" type="password"></label><label>Choice<select id="choice" name="choice"><option value="one">One</option><option value="two">Two</option></select></label><label id="human-label"><input id="human" type="checkbox">Human check</label><label><input id="terms" type="checkbox">Terms</label><button id="submit" type="submit">Submit</button><button id="pay" type="submit">Payment</button></form><div id="scroll" style="height:100px;overflow:auto"><div style="height:2000px">Content</div></div><script>document.body.dataset.scriptRan="yes"</script>');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  // Trust this fixture certificate only in the temporary test wrapper.
  await writeFile(join(root,'agent-browser'),'#!'+process.execPath+'\nconst {spawnSync}=require("node:child_process"),fs=require("node:fs"),a=process.argv.slice(2);fs.writeFileSync('+JSON.stringify(join(root,'session.json'))+',JSON.stringify({session:a[a.indexOf("--session")+1],config:a[a.indexOf("--config")+1]}));const r=spawnSync('+JSON.stringify(realBrowser)+',[...a,"--ignore-https-errors",...'+JSON.stringify(extra)+'],{stdio:"inherit"});process.exit(r.status??1);\n',{mode:0o700});process.env.PATH=root+':'+previousPath;
  const origin='https://127.0.0.1:'+server.address().port,config={environment:'fixture-form',origin,elements:[
   {id:'field',selector:'#field',role:'textbox',label:'Private input',operations:['type'],gates:[]},
   {id:'choice',selector:'#choice',role:'combobox',label:'Choice',operations:['select'],gates:[]},
   {id:'scroll',selector:'#scroll',role:'region',label:'Content',operations:['scroll'],gates:[]},
   {id:'human-label',selector:'#human-label',role:'button',label:'Human label',operations:['click'],gates:[]},
   {id:'human',selector:'#human',role:'checkbox',label:'Human check',operations:['click'],gates:[],ownerOnly:true},
   {id:'terms',selector:'#terms',role:'checkbox',label:'Terms',operations:['click'],gates:[{kind:'terms-acceptance'}]},
   {id:'submit',selector:'#submit',role:'button',label:'Submit',operations:['submit'],gates:[{kind:'personal-data-submission'},{kind:'account-creation'},{kind:'irreversible-submit'}]},
   {id:'payment',selector:'#pay',role:'button',label:'Payment',operations:['click'],gates:[{kind:'payment',intent:{kind:'payment-intent',payee:'Fixture recipient',amountMinor:100,currency:'USD',purpose:'Fixture request',sourceReference:'work:fixture'}}]},
  ],facts:[{id:'confirmed',selector:'#human',state:'checked'},{id:'received',selector:'#receipt',state:'present'}]};
  browser=await openBrowserEnvironment(config,origin+'/',signal);
  const session=JSON.parse(await readFile(join(root,'session.json'),'utf8'));
  const owner=async expression=>{const {stdout}=await exec(realBrowser,['--session',session.session,'--config',session.config,'--json','eval','-b',Buffer.from(expression).toString('base64')],{timeout:10000});const result=JSON.parse(stdout);assert.equal(result.success,true);return result.data.result;};
  assert.equal(await owner('document.body.dataset.scriptRan===undefined'),true);
  let bytes;const service=new EnvironmentActions(store,store,browser,{owner:'local-owner',environment:config.environment,clock:()=>now,callTimeoutMs:15000,resolveSecret:async()=>bytes=new TextEncoder().encode('synthetic-private-value')});
  const act=async(step,element,input)=>{const e=await service.propose(step,element,input);if(e.status==='waiting'){await assert.rejects(service.execute(step,e.hash),/approval/);await service.answer('approve-'+step,step,e.hash,'approve');}assert.equal((await service.execute(step,e.hash)).status,'delivered');return e;};
  const initial=await browser.read({address:origin+'/',sessionId:'fixture',signal});assert.equal(initial.title,'');assert.ok(initial.privateFields>0);
  const beforeNavigation=await browser.observe(signal);
  await owner('location.href='+JSON.stringify(origin+'/other'));await exec(realBrowser,['--session',session.session,'--config',session.config,'wait','--url',origin+'/other'],{timeout:10000});
  await owner('history.back()');await exec(realBrowser,['--session',session.session,'--config',session.config,'wait','--url',origin+'/'],{timeout:10000});
  assert.ok((await browser.observe(signal)).binding.generation>beforeNavigation.binding.generation);
  await assert.rejects(browser.act({binding:beforeNavigation.binding,element:'scroll',input:{kind:'scroll',x:0,y:1},gates:[]},{signal}));
  await act('fill','field',{kind:'type',secret:{owner:'local-owner',slot:'fixture-value'}});assert.ok(bytes.every(b=>b===0));
  await act('select','choice',{kind:'select',option:'two'});await act('scroll','scroll',{kind:'scroll',x:0,y:300});assert.equal(await owner('document.querySelector("#scroll").scrollTop'),300);
  await assert.rejects(service.propose('human','human',{kind:'click'}),/unavailable/);
  await assert.rejects(service.propose('human-label','human-label',{kind:'click'}),/unavailable/);assert.equal(await owner('document.querySelector("#human").checked'),false);
  const wait=await service.wait('confirm',{kind:'human-check',who:'Owner',what:'Confirm on own device',where:'Fixture page',fact:'confirmed',from:false,to:true,timeoutMs:10000,maxPolls:3,intervalMs:1000});
  await owner('document.querySelector("#human").parentElement.append(" confirmed done success")');await service.poll('confirm');assert.equal((await service.state()).entries.find(e=>e.id===wait.id).status,'waiting');
  // The fixture owner changes the actual checkbox; the member never executes the human check.
  await owner('document.querySelector("#human").checked=true');now+=1000;assert.equal((await service.poll('confirm')).status,'completed');
  await act('terms','terms',{kind:'click'});
  const payment=await service.propose('payment','payment',{kind:'click'});await service.answer('approve-payment','payment',payment.hash,'approve');await assert.rejects(service.execute('payment',payment.hash),/non-executable/);assert.equal(posts,0);await service.answer('cancel-payment','payment',payment.hash,'cancel');
  const submit=await act('submit','submit',{kind:'submit'});await exec(realBrowser,['--session',session.session,'--config',session.config,'wait','--url',origin+'/received'],{timeout:10000});assert.equal(posts,1);assert.equal(new URLSearchParams(posted).get('private'),'synthetic-private-value');assert.equal(new URLSearchParams(posted).get('choice'),'two');
  assert.equal((await service.execute('submit',submit.hash)).status,'delivered');assert.equal(posts,1);
  const observed=await browser.observe(signal);assert.equal(observed.facts.received,true);const privatePage=await browser.read({address:origin+'/',sessionId:'fixture',signal});assert.equal(privatePage.title,'');assert.deepEqual(privatePage.blocks,[]);assert.equal(privatePage.address,origin);
  const journal=JSON.stringify(store.inspect());assert.ok(!journal.includes('synthetic-private-value'));assert.ok(!journal.includes('/received'));assert.ok(!journal.includes('iVBOR'));validateMissionJournalLineage(store.inspect());
 }finally{await browser?.close();process.env.PATH=previousPath;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(root,{recursive:true,force:true});}
});
