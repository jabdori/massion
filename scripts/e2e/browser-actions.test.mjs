import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openBrowserEnvironment} from '../../src/headless-browser.ts';
import {EnvironmentActions} from '../../src/environment-actions.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';

const exec=promisify(execFile);
test('owned browser fills, selects, scrolls, pauses for owner state and submits a synthetic local form once',{timeout:120000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-actions-')),previousPath=process.env.PATH,realBrowser=(await exec('which',['agent-browser'])).stdout.trim(),extra=process.env.MASSION_E2E_BROWSER?['--executable-path',process.env.MASSION_E2E_BROWSER]:[];
 let browser,server,posts=0,posted='',now=1000;const store=new InMemoryStore(),signal=AbortSignal.timeout(110000);
 try{
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
  server=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(join(root,'cert.pem'))},(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');
   if(req.url?.startsWith('/activation-')){const kind=req.url.slice('/activation-'.length),label=kind.startsWith('label'),method=['get','unbound-label','label-submit-post'].includes(kind)?'get':'post',override=kind==='label-submit-post'?' formmethod="post"':kind==='blank'?' formtarget="_blank"':kind==='label-get'?' formmethod="get"':kind==='label-origin'?' formaction="http://127.0.0.1:'+server.address().port+'/log"':'';res.end('<!doctype html><title>Activator fixture</title><form method="'+method+'" action="/log"><label>Private<input id="field" name="private" type="password"></label>'+(label?'<label id="go" for="control">Continue</label>':'')+'<button id="control" type="submit"'+override+'>'+(label?'Continue':kind==='unbound-label'?'<label><span id="go">Continue</span></label>':'<span id="go">Continue</span>')+'</button></form>');return;}
   if(req.url?.startsWith('/log')){server.emit('fixture-delivery',req.method);res.end('<!doctype html><title>Unexpected delivery</title>');return;}
   if(req.url==='/ambiguous'){res.end('<!doctype html><title>Reflected private input</title><p>synthetic-private-value</p><label>Quantity<input id=field name=quantity title=Password value=synthetic-private-value></label>');return;}
   if(req.method==='POST'){posts++;req.on('data',chunk=>posted+=chunk);req.on('end',()=>res.end('<!doctype html><title>Observed receipt</title><p id="receipt">Request received</p>'));return;}
   res.end('<!doctype html><title>Fixture form</title><form method="post" action="/received"><label>Private input<input id="field" name="private" type="password"></label><label>Choice<select id="choice" name="choice"><option value="one">One</option><option value="two">Two</option><optgroup disabled><option value="disabled">Unavailable</option></optgroup></select></label><label id="human-label"><input id="human" type="checkbox"><span id="human-caption">Human check</span></label><label><input id="terms" type="checkbox">Terms</label><button id="submit" type="submit">Submit</button><button id="new-window" type="submit" formtarget="_blank">Other window</button><button id="pay" type="submit">Payment</button></form><div id="scroll" style="height:100px;overflow:auto"><div style="height:2000px">Content</div></div><script>document.body.dataset.scriptRan="yes"</script>');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  // Trust this fixture certificate only in the temporary test wrapper.
  await writeFile(join(root,'agent-browser'),'#!'+process.execPath+'\nconst {spawnSync}=require("node:child_process"),fs=require("node:fs"),a=process.argv.slice(2);fs.writeFileSync('+JSON.stringify(join(root,'session.json'))+',JSON.stringify({session:a[a.indexOf("--session")+1],config:a[a.indexOf("--config")+1]}));const r=spawnSync('+JSON.stringify(realBrowser)+',[...a,"--ignore-https-errors",...'+JSON.stringify(extra)+'],{stdio:"inherit"});process.exit(r.status??1);\n',{mode:0o700});process.env.PATH=root+':'+previousPath;
  const origin='https://127.0.0.1:'+server.address().port,config={environment:'fixture-form',origin,elements:[
   {id:'field',selector:'#field',role:'textbox',label:'Private input',operations:['type'],gates:[]},
   {id:'choice',selector:'#choice',role:'combobox',label:'Choice',operations:['select'],gates:[]},
   {id:'scroll',selector:'#scroll',role:'region',label:'Content',operations:['scroll'],gates:[]},
   {id:'human-caption',selector:'#human-caption',role:'button',label:'Human caption',operations:['click'],gates:[]},
   {id:'new-window',selector:'#new-window',role:'button',label:'Other window',operations:['submit'],gates:[{kind:'irreversible-submit'}]},
   {id:'human-label',selector:'#human-label',role:'button',label:'Human label',operations:['click'],gates:[]},
   {id:'human',selector:'#human',role:'checkbox',label:'Human check',operations:['click'],gates:[],ownerOnly:true},
   {id:'terms',selector:'#terms',role:'checkbox',label:'Terms',operations:['click'],gates:[{kind:'terms-acceptance'}]},
   {id:'submit',selector:'#submit',role:'button',label:'Submit',operations:['submit'],gates:[{kind:'personal-data-submission'},{kind:'account-creation'},{kind:'irreversible-submit'}]},
   {id:'payment',selector:'#pay',role:'button',label:'Payment',operations:['click'],gates:[{kind:'payment',intent:{kind:'payment-intent',payee:'Fixture recipient',amountMinor:100,currency:'USD',purpose:'Fixture request',sourceReference:'work:fixture'}}]},
  ],facts:[{id:'confirmed',selector:'#human',state:'checked'},{id:'received',selector:'#receipt',state:'present'}]};
  await t.test('form observations suppress ambiguous private metadata before any fill',async()=>{const probe=await openBrowserEnvironment({...config,environment:'ambiguous-fields'},origin+'/ambiguous',signal);try{const page=await probe.read({address:origin+'/',sessionId:'fixture',signal});assert.equal(page.privateSession,true);assert.equal(page.title,'');assert.deepEqual(page.blocks,[]);assert.deepEqual(page.fields,[]);}finally{await probe.close();}});
  for(const kind of ['get','blank','label-get','label-origin','unbound-label','label-submit-post'])await t.test('effective activator enforces '+kind+' after private fill',async()=>{
   const environment='activation-'+kind,probe=await openBrowserEnvironment({environment,origin,elements:[config.elements[0],{id:'go',selector:'#go',role:'button',label:'Continue',operations:['click','submit'],gates:[]}],facts:[]},origin+'/activation-'+kind,signal),ledger=new InMemoryStore(),actions=new EnvironmentActions(ledger,ledger,probe,{owner:'local-owner',environment,callTimeoutMs:15000,resolveSecret:async()=>new TextEncoder().encode('synthetic-private-value')});
   try{const fill=await actions.propose('fill','field',{kind:'type',secret:{owner:'local-owner',slot:'fixture-value'}});assert.equal((await actions.execute('fill',fill.hash)).status,'delivered');const positive=kind==='label-submit-post',click=await actions.propose('go','go',{kind:positive?'submit':'click'});await actions.answer('approve-go','go',click.hash,'approve');const delivery=positive?once(server,'fixture-delivery',{signal:AbortSignal.timeout(10000)}).catch(()=>[]):null;assert.equal((await actions.execute('go',click.hash)).status,positive?'delivered':'unknown');if(delivery)assert.equal((await delivery)[0],'POST');assert.equal((await actions.execute('go',click.hash)).status,positive?'delivered':'unknown');}finally{await probe.close();}
  });
  browser=await openBrowserEnvironment(config,origin+'/',signal);
  const session=JSON.parse(await readFile(join(root,'session.json'),'utf8'));
  const command=async(...args)=>{const {stdout}=await exec(realBrowser,['--session',session.session,'--config',session.config,'--headed','false','--ignore-https-errors',...extra,'--json',...args],{timeout:10000});const result=JSON.parse(stdout);assert.equal(result.success,true);return result.data;};
  const owner=async expression=>(await command('eval','-b',Buffer.from(expression).toString('base64'))).result;
  assert.equal(await owner('document.body.dataset.scriptRan===undefined'),true);
  let bytes;const service=new EnvironmentActions(store,store,browser,{owner:'local-owner',environment:config.environment,clock:()=>now,callTimeoutMs:15000,resolveSecret:async()=>bytes=new TextEncoder().encode('synthetic-private-value')});
  const act=async(step,element,input)=>{const e=await service.propose(step,element,input);if(e.status==='waiting'){await assert.rejects(service.execute(step,e.hash),/approval/);await service.answer('approve-'+step,step,e.hash,'approve');}assert.equal((await service.execute(step,e.hash)).status,'delivered');return e;};
  const initial=await browser.read({address:origin+'/',sessionId:'fixture',signal});assert.equal(initial.title,'');assert.ok(initial.privateFields>0);
  const beforeNavigation=await browser.observe(signal);
  await command('open',origin+'/other');
  await command('back');assert.equal((await command('get','url')).url,origin+'/');
  assert.ok((await browser.observe(signal)).binding.generation>beforeNavigation.binding.generation);
  await assert.rejects(browser.act({binding:beforeNavigation.binding,element:'scroll',input:{kind:'scroll',x:0,y:1},gates:[]},{signal}));
  const denied=async(element,input)=>{const observation=await browser.observe(signal),node=observation.structure.find(n=>n.id===element);await assert.rejects(browser.act({binding:observation.binding,element,input,gates:node?.gates??[{kind:'irreversible-submit'}]},{signal}));};
  await t.test('owner-only label descendants cannot toggle the protected control',async()=>{try{await denied('human-caption',{kind:'click'});assert.equal(await owner('document.querySelector("#human").checked'),false);}finally{await owner('document.querySelector("#human").checked=false');}});
  await t.test('disabled optgroup options cannot be selected',async()=>{try{await denied('choice',{kind:'select',option:'disabled'});assert.equal(await owner('document.querySelector("#choice").value'),'one');}finally{await owner('document.querySelector("#choice").value="one"');}});
  await t.test('a submitter target cannot open an unguarded window',async()=>{await denied('new-window',{kind:'submit'});assert.equal(posts,0);});

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
  const submit=await act('submit','submit',{kind:'submit'});await command('wait','--url',origin+'/received');assert.equal(posts,1);assert.equal(new URLSearchParams(posted).get('private'),'synthetic-private-value');assert.equal(new URLSearchParams(posted).get('choice'),'two');
  assert.equal((await service.execute('submit',submit.hash)).status,'delivered');assert.equal(posts,1);
  const observed=await browser.observe(signal);assert.equal(observed.facts.received,true);const privatePage=await browser.read({address:origin+'/',sessionId:'fixture',signal});assert.equal(privatePage.title,'');assert.deepEqual(privatePage.blocks,[]);assert.equal(privatePage.address,origin);
  const journal=JSON.stringify(store.inspect());assert.ok(!journal.includes('synthetic-private-value'));assert.ok(!journal.includes('/received'));assert.ok(!journal.includes('iVBOR'));validateMissionJournalLineage(store.inspect());
 }finally{await browser?.close();process.env.PATH=previousPath;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(root,{recursive:true,force:true});}
});
