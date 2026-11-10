import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {openBrowserEnvironment} from '../../src/headless-browser.ts';
import {EnvironmentActions} from '../../src/environment-actions.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';

const exec=promisify(execFile),gate={kind:'irreversible-submit'},intent={kind:'payment-intent',payee:'Fixture recipient',amountMinor:100,currency:'USD',purpose:'Fixture request',sourceReference:'work:fixture'};
const targets=[
 ['anchor','<a id="candidate" href="/no-navigation">Link</a>',true],
 ['submit button','<button id="candidate" type="submit">Submit</button>',true],
 ['button','<button id="candidate" type="button">Button</button>',true],
 ...['submit','button','checkbox','radio'].map(type=>['input '+type,`<input id="candidate" type="${type}" value="Native">`,true]),
 ...['submit','button'].map(type=>['label button '+type,`<label id="candidate" for="control">Label</label><button id="control" type="${type}">Control</button>`,true]),
 ...['submit','button','checkbox','radio'].map(type=>['label input '+type,`<label id="candidate" for="control">Label</label><input id="control" type="${type}" value="Native">`,true]),
 ['reset button','<button id="candidate" type="reset">Reset</button>',false],
 ['reset input','<input id="candidate" type="reset">',false],
 ['label reset','<label id="candidate" for="control">Reset</label><button id="control" type="reset">Reset</button>',false],
 ['span inside submit','<button type="submit"><span id="candidate">Child</span></button>',false],
 ['div inside submit','<button type="submit"><div id="candidate">Child</div></button>',false],
 ['SVG inside submit','<button type="submit"><svg id="candidate" width="20" height="20"><rect width="20" height="20"/></svg></button>',false],
 ['role button','<div id="candidate" role="button">Role</div>',false],
 ['image map','<map name="map"><area id="candidate" shape="rect" coords="0,0,20,20" href="#map"></map><img usemap="#map" width="20" height="20">',false],
 ['summary','<details><summary id="candidate">Summary</summary></details>',false],
 ['handler only','<div id="candidate" onclick="this.dataset.clicked=1">Handler</div>',false],
 ['image input','<input id="candidate" type="image">',false],
 ['text input','<input id="candidate" type="text">',false],
 ['anchor without href','<a id="candidate">No link</a>',false],
 ['unbound label','<button type="submit"><label id="candidate">No control</label></button>',false],
 ['label text input','<label id="candidate" for="control">Text</label><input id="control" type="text">',false],
 ['form click','<form id="candidate"></form>',false],
];

test('owned browser applies its native allowlist and completes a guarded synthetic form',{timeout:120000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-actions-')),previousPath=process.env.PATH,realBrowser=(await exec('which',['agent-browser'])).stdout.trim(),extra=process.env.MASSION_E2E_BROWSER?['--executable-path',process.env.MASSION_E2E_BROWSER]:[];
 let browser,server,posts=0,posted='',now=1000;const store=new InMemoryStore(),signal=AbortSignal.timeout(110000);
 try{
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
  server=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(join(root,'cert.pem'))},(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');
   if(req.url?.startsWith('/no-navigation')){req.resume();res.writeHead(204);res.end();return;}
   if(req.url==='/ambiguous'){res.end('<!doctype html><title>Reflected private input</title><p>synthetic-private-value</p><label>Quantity<input id=field name=quantity title=Password value=synthetic-private-value></label>');return;}
   if(req.method==='POST'){posts++;req.on('data',chunk=>posted+=chunk);req.on('end',()=>res.end('<!doctype html><title>Observed receipt</title><p id="receipt">Request received</p>'));return;}
   res.end('<!doctype html><title>Fixture form</title><form id="form" method="post" action="/no-navigation"><label>Private<input id="field" name="private" type="password"></label><select id="choice" name="choice"><option value="one">One</option><option value="two">Two</option></select><label id="human-label"><input id="human" type="checkbox" checked>Human check</label><label><input id="terms" type="checkbox">Terms</label><button id="submit" type="submit">Submit</button></form><form id="payment-form" method="post" action="/no-navigation"><button id="pay" type="submit">Payment</button></form><div id="case"></div><div id="scroll" style="height:100px;overflow:auto"><div style="height:2000px">Content</div></div><script>document.body.dataset.scriptRan="yes"</script>');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  // Preserve the product command's exact launch flags, safe environment and cwd for the fixture owner.
  const envKeys=['PATH','HOME','TMPDIR','AGENT_BROWSER_NO_WEBMCP','AGENT_BROWSER_PLUGINS','AGENT_BROWSER_NO_VERSION_CHECK','AGENT_BROWSER_IDLE_TIMEOUT_MS'];
  await writeFile(join(root,'agent-browser'),'#!'+process.execPath+'\nconst {spawnSync}=require("node:child_process"),fs=require("node:fs"),a=process.argv.slice(2);fs.writeFileSync('+JSON.stringify(join(root,'session.json'))+',JSON.stringify({prefix:a.slice(0,a.indexOf("--json")+1),config:a[a.indexOf("--config")+1],env:Object.fromEntries('+JSON.stringify(envKeys)+'.map(k=>[k,process.env[k]]))}));const r=spawnSync('+JSON.stringify(realBrowser)+',[...a,"--ignore-https-errors",...'+JSON.stringify(extra)+'],{stdio:"inherit"});process.exit(r.status??1);\n',{mode:0o700});process.env.PATH=root+':'+previousPath;
  const origin='https://127.0.0.1:'+server.address().port,config={environment:'fixture-form',origin,elements:[
   {id:'field',selector:'#field',role:'textbox',label:'Private input',operations:['type'],gates:[]},
   {id:'choice',selector:'#choice',role:'combobox',label:'Choice',operations:['select'],gates:[]},
   {id:'target',selector:'#candidate',role:'button',label:'Native target',operations:['click'],gates:[]},
   {id:'scroll',selector:'#scroll',role:'region',label:'Content',operations:['scroll'],gates:[]},
   {id:'human-label',selector:'#human-label',role:'checkbox',label:'Human label',operations:['click'],gates:[]},
   {id:'owner-radio',selector:'#owner-radio',role:'radio',label:'Owner choice',operations:['click'],gates:[],ownerOnly:true},
   {id:'human',selector:'#human',role:'checkbox',label:'Human check',operations:['click'],gates:[],ownerOnly:true},
   {id:'terms',selector:'#terms',role:'checkbox',label:'Terms',operations:['click'],gates:[{kind:'terms-acceptance'}]},
   {id:'submit',selector:'#submit',role:'button',label:'Submit',operations:['submit'],gates:[{kind:'personal-data-submission'},{kind:'account-creation'},gate]},
   {id:'payment-container',selector:'#declared-payment-form',role:'form',label:'Payment form',operations:['submit'],gates:[{kind:'payment',intent}]},
   {id:'payment',selector:'#pay',role:'button',label:'Payment',operations:['click'],gates:[{kind:'payment',intent}]},
  ],facts:[{id:'confirmed',selector:'#human',state:'checked'},{id:'received',selector:'#receipt',state:'present'}]};
  await t.test('private form metadata is never retained',async()=>{const probe=await openBrowserEnvironment({...config,environment:'ambiguous-fields'},origin+'/ambiguous',signal);try{const page=await probe.read({address:origin+'/',sessionId:'fixture',signal});assert.equal(page.privateSession,true);assert.equal(page.title,'');assert.deepEqual(page.blocks,[]);assert.deepEqual(page.fields,[]);}finally{await probe.close();}});
  browser=await openBrowserEnvironment(config,origin+'/',signal);
  const session=JSON.parse(await readFile(join(root,'session.json'),'utf8'));
  const command=async(...args)=>{const {stdout}=await exec(realBrowser,[...session.prefix,'--ignore-https-errors',...extra,...args],{env:session.env,cwd:dirname(session.config),timeout:10000});const result=JSON.parse(stdout);assert.equal(result.success,true);return result.data;};
  const owner=async expression=>(await command('eval','-b',Buffer.from(expression).toString('base64'))).result;
  assert.equal(await owner('document.body.dataset.scriptRan===undefined && !!document.getElementById("field")'),true);
  const action=async(element,input,observation)=>{const o=observation??await browser.observe(signal),node=o.structure.find(n=>n.id===element);return {binding:o.binding,element,input,gates:node?.gates??[gate]};};
  const setTarget=html=>owner('document.getElementById("case").innerHTML='+JSON.stringify(html));
  await t.test('only the declared allowlisted activator is clickable',async()=>{
   for(const [name,html,allowed] of targets){await setTarget(html.replace(/<(button|input)(\s)/g,'<$1 form="form"$2'));await owner('document.getElementById("human").checked=false');const a=await action('target',{kind:'click'});
    if(allowed){try{await browser.act(a,{signal});}catch(error){throw Error(name,{cause:error});}}else await assert.rejects(browser.act(a,{signal}),e=>e.code==='unsupported-target',name);
    assert.equal(await owner('document.getElementById("human").checked'),false,name);
   }
  });
  await t.test('labels cannot bypass protected controls or their payment policy',async()=>{
   for(const html of ['<label id="candidate" for="human">Continue</label>','<label id="candidate" for="pay">Continue</label>','<button id="candidate" form="payment-form" type="submit">Submit</button>','<input id="owner-radio" form="form" type="radio" name="owner-choice" checked><input id="candidate" form="form" type="radio" name="owner-choice">']){await setTarget(html);await assert.rejects(browser.act(await action('target',{kind:'click'}),{signal}));}assert.equal(await owner('document.getElementById("owner-radio").checked'),true);assert.equal(posts,0);
  });
  await t.test('a declared form payment policy blocks its separately declared submit button',async()=>{
   await setTarget('<form id="declared-payment-form" method="post" action="/no-navigation"><button id="candidate" type="submit">Submit</button></form>');await assert.rejects(browser.act(await action('target',{kind:'click'}),{signal}));
  });
  await t.test('declared checkbox and radio clicks work in a private GET form without submitting',async()=>{
   await owner('document.getElementById("form").method="get"');try{for(const type of ['checkbox','radio']){await setTarget('<input id="candidate" form="form" type="'+type+'" name="native-choice">');await browser.act(await action('target',{kind:'click'}),{signal});assert.equal(await owner('document.getElementById("candidate").checked'),true);}assert.equal(posts,0);}finally{await owner('document.getElementById("form").method="post"');}
  });
  await t.test('selection requires a unique enabled value and label and its exact observed state',async()=>{
   for(const html of ['<option value="x" disabled>Disabled</option><option value="x">Enabled</option>','<option value="x">Same</option><option value="y">Same</option>','<optgroup disabled><option value="x">Disabled group</option></optgroup>']){await owner('document.getElementById("choice").innerHTML='+JSON.stringify(html));await assert.rejects(browser.act(await action('choice',{kind:'select',option:'x'}),{signal}));}
   await owner('document.getElementById("choice").innerHTML="<option value=same>First</option><option value=same>Second</option><option value=unique>Unique</option>"');const before=await browser.observe(signal);await owner('document.getElementById("choice").selectedIndex=1');await assert.rejects(browser.act(await action('choice',{kind:'select',option:'unique'},before),{signal}));
   await owner('document.getElementById("choice").innerHTML="<option value=one>One</option><option value=two>Two</option>"');await browser.act(await action('choice',{kind:'select',option:'two'}),{signal});assert.equal(await owner('document.getElementById("choice").selectedIndex'),1);
  });
  await t.test('allowed submitters retain exact origin, target and private POST checks',async()=>{
   for(const attributes of ['formmethod="get"','formtarget="_blank"','formaction="http://127.0.0.1:'+server.address().port+'/no-navigation"']){await setTarget('<label id="candidate" for="control">Continue</label><button id="control" form="form" type="submit" '+attributes+'>Submit</button>');await assert.rejects(browser.act(await action('target',{kind:'click'}),{signal}));}
  });
  const beforeNavigation=await browser.observe(signal);await command('open',origin+'/other');await command('open',origin+'/');assert.equal((await command('get','url')).url,origin+'/');assert.ok((await browser.observe(signal)).binding.generation>beforeNavigation.binding.generation);await assert.rejects(browser.act({binding:beforeNavigation.binding,element:'scroll',input:{kind:'scroll',x:0,y:1},gates:[]},{signal}));
  await owner('document.getElementById("human").checked=false;document.getElementById("form").action="/received"');
  let bytes;const service=new EnvironmentActions(store,store,browser,{owner:'local-owner',environment:config.environment,clock:()=>now,callTimeoutMs:15000,resolveSecret:async()=>bytes=new TextEncoder().encode('synthetic-private-value')});
  const act=async(step,element,input)=>{const e=await service.propose(step,element,input);if(e.status==='waiting'){await assert.rejects(service.execute(step,e.hash),/approval/);await service.answer('approve-'+step,step,e.hash,'approve');}assert.equal((await service.execute(step,e.hash)).status,'delivered');return e;};
  await act('fill','field',{kind:'type',secret:{owner:'local-owner',slot:'fixture-value'}});assert.ok(bytes.every(b=>b===0));await act('select','choice',{kind:'select',option:'two'});await act('scroll','scroll',{kind:'scroll',x:0,y:300});assert.equal(await owner('document.getElementById("scroll").scrollTop'),300);
  await assert.rejects(service.propose('human','human',{kind:'click'}),/unavailable/);await assert.rejects(service.propose('human-label','human-label',{kind:'click'}),/unavailable/);
  const wait=await service.wait('confirm',{kind:'human-check',who:'Owner',what:'Confirm on own device',where:'Fixture page',fact:'confirmed',from:false,to:true,timeoutMs:10000,maxPolls:3,intervalMs:1000});await owner('document.getElementById("human").parentElement.append(" confirmed done success")');await service.poll('confirm');assert.equal((await service.state()).entries.find(e=>e.id===wait.id).status,'waiting');
  // The fixture owner changes the actual control out of band; member clicks cannot satisfy this wait.
  await owner('document.getElementById("human").checked=true');now+=1000;assert.equal((await service.poll('confirm')).status,'completed');await act('terms','terms',{kind:'click'});
  const payment=await service.propose('payment','payment',{kind:'click'});await service.answer('approve-payment','payment',payment.hash,'approve');await assert.rejects(service.execute('payment',payment.hash),/non-executable/);assert.equal(posts,0);await service.answer('cancel-payment','payment',payment.hash,'cancel');
  const submit=await act('submit','submit',{kind:'submit'});await command('wait','--url',origin+'/received');assert.equal(posts,1);assert.equal(new URLSearchParams(posted).get('private'),'synthetic-private-value');assert.equal(new URLSearchParams(posted).get('choice'),'two');assert.equal((await service.execute('submit',submit.hash)).status,'delivered');assert.equal(posts,1);
  assert.equal((await browser.observe(signal)).facts.received,true);const page=await browser.read({address:origin+'/',sessionId:'fixture',signal});assert.equal(page.title,'');assert.deepEqual(page.blocks,[]);assert.equal(page.address,origin);
  const journal=JSON.stringify(store.inspect());assert.ok(!journal.includes('synthetic-private-value'));assert.ok(!journal.includes('/received'));assert.ok(!journal.includes('iVBOR'));validateMissionJournalLineage(store.inspect());
 }finally{await browser?.close();process.env.PATH=previousPath;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(root,{recursive:true,force:true});}
});
