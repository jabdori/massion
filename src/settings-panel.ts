/** Settings (docs/architecture/settings.md, self-made-skills.md, prototype B12, B13, B13-devices, B14, B19-juno, B23): a section sidebar and cards of rows; settings apply at once. No imports, so the shell can place the sidebar. */
export const settingsIcon=(path:string)=>`<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const sections:[string,string,string][]=[
 ['general','General','<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>'],
 ['memory','Memory','<path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/>'],
 ['members','Members','<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.5a3 3 0 0 1 0 5.5M17.5 19a5.5 5.5 0 0 0-2-4.2"/>'],
 ['devices','Devices','<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M9 20h6M12 16v4"/>'],
 ['connections','Connections','<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'],
 ['apps','Apps','<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'],
 ['improvements','Improvements','<path d="M3.5 17 9.5 11l4 4 7-7.5"/><path d="M15 7.5h5.5V13"/>'],
 ['permissions','Permissions','<path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.5-7 9-4.1-1.5-7-4.8-7-9V6z"/>'],
 ['advanced','Advanced','<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="8" cy="18" r="1.8"/>']];
export const settingsSide=`<nav id="side-settings" aria-label="Settings" hidden><p class="side-title">Settings</p>${sections.map(([id,label,path],i)=>`<button id="settings-nav-${id}" type="button" class="side-item" aria-current="${i?'false':'page'}">${settingsIcon(path)}<span>${label}</span></button>`).join('')}</nav>`;
/** One section with a dynamic body; Connections and Advanced wrap markup that was already in Settings. */
export const settingsSection=(id:string,inner=`<div id="settings-${id}-body"></div>`)=>`<section id="settings-${id}" class="set-section" aria-labelledby="settings-${id}-title"${id==='general'?'':' hidden'}><h2 id="settings-${id}-title">${sections.find(s=>s[0]===id)![1]}</h2>${inner}</section>`;
export const settingsStyle=String.raw`.settings-stack{max-width:640px;margin:0 auto 32px;padding-top:24px}.set-section>h2{margin:0 0 20px;font-size:22px;line-height:30px;font-weight:650}.set-section h3{display:flex;align-items:center;justify-content:space-between;margin:22px 0 8px;font-size:13px;font-weight:650}
.set-card{border:1px solid var(--line-strong);border-radius:12px;background:var(--bg-1);overflow:hidden}.set-row{display:flex;align-items:center;gap:12px;min-height:56px;padding:10px 16px;border-bottom:1px solid var(--line)}.set-row:last-child{border-bottom:0}.set-text{flex:1;min-width:0;display:grid;gap:2px}.set-text strong{font-size:13px;font-weight:650;overflow-wrap:anywhere}.set-text span{color:var(--fg-3);font-size:12px;overflow-wrap:anywhere}.set-empty{padding:16px;color:var(--fg-3);font-size:13px}
.app button.set-row{width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;color:var(--fg);text-align:left;font-weight:500}.app button.set-row:hover{background:var(--bg-2)}.set-side{color:var(--fg-3);font-size:12px;white-space:nowrap}.set-row .avatar{width:32px;height:32px;border-radius:8px;font-size:13px}
.app .set-row>button:not(.switch),.app .set-section h3 button,.app .set-form button{min-height:28px;padding:3px 12px;font-size:12px}.set-evidence{padding:0 16px 12px;color:var(--fg-2);font-size:12px;display:grid;gap:4px}.set-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.set-chip{padding:2px 8px;border-radius:6px;background:var(--bg-3);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.set-chip span{margin-left:6px;color:var(--fg-3);font-family:var(--font-sans,inherit)}
.set-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}.set-form input{flex:1 1 220px;width:auto;min-width:0;margin:0}.set-form select{flex:0 0 auto;width:auto;margin:0}.set-setup{margin-top:28px}.set-setup>summary{cursor:pointer;color:var(--fg-3);font-size:13px}.set-setup>.panel{margin-top:12px}#settings-advanced>*+*{margin-top:18px}
.set-back{margin:0 0 16px;padding:0;border:0;background:none;color:var(--fg-3);font-size:13px;font-weight:500;min-height:0}.app .set-back:hover{background:none;color:var(--fg)}.set-head{display:flex;align-items:center;gap:12px;margin-bottom:8px}.set-head .avatar{width:44px;height:44px;border-radius:12px;font-size:18px}.set-head h2{flex:1;margin:0;font-size:22px;font-weight:650}
.set-steps{display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1}.set-steps .set-chip{font-family:inherit}.set-steps i{color:var(--fg-4);font-style:normal;font-size:12px}.set-more{justify-self:start;margin-top:4px;padding:0;border:0;background:none;color:var(--fg-3);font-size:12px;min-height:0}.app .set-more:hover{background:none;color:var(--fg)}.set-evidence dl{display:grid;grid-template-columns:96px 1fr;row-gap:4px;margin:0}.set-evidence dt{color:var(--fg-3)}.set-evidence dd{margin:0;color:var(--fg)}.set-item{border-bottom:1px solid var(--line)}.set-item:last-child{border-bottom:0}.set-item>.set-row{border-bottom:0}.set-line{display:flex;gap:10px;align-items:center;margin-top:10px;padding:0 2px;color:var(--fg-3);font-size:12px}.set-line button{padding:0;border:0;background:none;color:var(--fg);font-size:12px;min-height:0}`;
export const settingsClient=String.raw`
const settingsNames=['general','memory','members','devices','connections','apps','improvements','permissions','advanced'],settingsAllow=['spend','send','delete','delegate'];
const settingsStale={},settingsGen={};
let settingsShown='general',settingsCatalog=null,settingsMission=null,settingsRules=null,settingsHealth='',settingsAdding=false,settingsBusy=false,settingsEvidence=new Set(),settingsSkills=null,settingsMember='',settingsDetails=new Set();
const settingsRepName=()=>shellPages.chat[1];
const settingsFamily=f=>({anthropic:'Anthropic',openai:'OpenAI',google:'Google',zhipu:'Z.ai'})[f]||f||'Unknown';
function settingsText(title,sub){const box=element('span',undefined,'set-text');box.append(element('strong',title));if(sub)box.append(element('span',sub));return box;}
function settingsRow(title,sub,...controls){const row=element('div',undefined,'set-row');row.append(settingsText(title,sub),...controls.filter(Boolean));return row;}
function settingsCard(label,rows,action){const head=element('h3',label);if(action)head.append(action);const card=element('div',undefined,'set-card');card.append(...(rows.length?rows:[element('div','None','set-empty')]));return [head,card];}
/** Opens one section and reads what it shows; nothing is written by opening. */
function settingsOpen(name,app=''){settingsShown=name;settingsAdding=false;settingsMember='';settingsApp=app;for(const s of settingsNames){$('settings-'+s).hidden=s!==name;$('settings-nav-'+s).setAttribute('aria-current',s===name?'page':'false');}void settingsLoad(name);}
async function settingsRead(path,scope){try{const {response,body}=await request(path,{scope});return response.ok?body:null;}catch{return null;}}
/** Each section's read has its own generation: a slower earlier read for the same section never overwrites a newer one. */
async function settingsLoad(name){
 const gen=settingsGen[name]=(settingsGen[name]||0)+1,read=async path=>{const body=await settingsRead(path,'settings:'+name+':'+path);if(gen!==settingsGen[name])throw settingsStale;return body;};
 try{
 if(name==='general')await schedulesLoad();
 if(name==='memory'||name==='members'||name==='connections')settingsCatalog=await read('/connections');
 if(name==='memory'){const id=settingsCatalog&&settingsCatalog.representative&&settingsCatalog.representative.intakeMissionId;settingsMission=id?await read('/missions/'+encodeURIComponent(id)):null;}
 if(name==='devices')settingsHealth=(await read('/health'))?.status==='ready'?'Ready':'Offline';
 if(name==='permissions')settingsRules=await read('/assistant/permissions');
 if(name==='apps')settingsApps=await read('/assistant/apps');
 if(name==='members'||name==='improvements')settingsSkills=await read('/assistant/skills');
 }catch(error){if(error===settingsStale)return;throw error;}
 if(settingsShown===name)renderSettings();
}
/** One owner command, sent once; a lost answer is not resent, the next read shows the state. */
async function settingsPost(path,body){if(settingsBusy)return;settingsBusy=true;try{await request(path,{method:'POST',headers:{'Content-Type':'application/json',...(chatView&&chatView.feedId?{'X-Massion-Feed':chatView.feedId}:{})},body:JSON.stringify({commandId:crypto.randomUUID(),...body})});}catch{}finally{settingsBusy=false;await settingsLoad(settingsShown);}}
function settingsGroupName(id){const g=(settingsCatalog&&settingsCatalog.modelGroups||[]).find(g=>g.id===id);return g?g.name:id==='default'?'Default':id;}
function renderSettings(){
 const body=$('settings-'+settingsShown+'-body'),view=settingsShown==='connections'?$('settings-groups'):body;if(!view)return;
 if(settingsShown==='general'){const s=scheduleList[0];view.replaceChildren(...settingsCard('',[settingsRow('Name',settingsRepName()),settingsRow('Morning briefing',s?scheduleCycle(s)+(s.active?'':' · Paused'):'Off',chatButton('Open',()=>shellShow('schedules')))]).slice(1));}
 if(settingsShown==='memory')view.replaceChildren(...settingsMemoryView());
 const member=settingsShown==='members'&&settingsMember?chatMembers().find(x=>x.id===settingsMember):null;$('settings-members-title').hidden=!!member;if(member){view.replaceChildren(...settingsMemberView(member));return;}settingsMember='';
 if(settingsShown==='improvements')view.replaceChildren(...settingsImprovementsView());
 if(settingsShown==='members'){
  const rep=element('button',undefined,'set-row'),avatar=element('span',settingsRepName().slice(0,1),'avatar');rep.type='button';rep.id='settings-member-representative';avatar.setAttribute('aria-hidden','true');rep.append(avatar,settingsText(settingsRepName()+' ★'),element('span','Default ›','set-side'));rep.addEventListener('click',()=>chatOpenThread(''));
  const rows=chatMembers().map(m=>{const row=element('button',undefined,'set-row'),a=element('span',[...m.name][0],'avatar');row.type='button';row.id='settings-member-'+m.id;a.setAttribute('aria-hidden','true');a.style.background=shellColor(m);row.append(a,settingsText(m.name),element('span',settingsGroupName(m.modelGroup||'default')+' ›','set-side'));row.addEventListener('click',()=>{settingsMember=m.id;renderSettings();});return row;});
  view.replaceChildren(...settingsCard('',[rep,...rows]).slice(1));}
 if(settingsShown==='devices')view.replaceChildren(...settingsCard('',[settingsRow('This Mac',settingsHealth)]).slice(1));
 if(settingsShown==='apps')view.replaceChildren(...settingsAppsView());
 if(settingsShown==='connections')view.replaceChildren(...settingsConnectionsView());
 if(settingsShown==='permissions')view.replaceChildren(...settingsPermissionsView());
}
/** B12: what the owner said, what was learned with its evidence, and adopted or reverted changes. Settings adopts nothing. */
function settingsMemoryView(){
 const mission=settingsMission&&settingsMission.value,memories=mission&&Array.isArray(mission.memories)?mission.memories:[],growth=mission&&Array.isArray(mission.growth)?mission.growth:[],key=m=>m.id+'@'+m.version,find=k=>memories.find(m=>key(m)===k);
 const latest=memories.filter(m=>m.authority==='explicit'&&!memories.some(x=>x.authority==='explicit'&&x.id===m.id&&x.version>m.version));
 const said=latest.map(m=>{const toggle=element('button',undefined,'switch');toggle.type='button';toggle.id='memory-switch-'+m.id;toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(m.effective));toggle.setAttribute('aria-label','Use '+m.content);toggle.disabled=!m.effective||settingsBusy;
  toggle.addEventListener('click',()=>{if(m.effective)void settingsPost('/missions/'+encodeURIComponent(mission.id)+'/memory-retirement',{expectedRevision:settingsMission.revision,memoryId:m.id,version:m.version,reason:'Stopped in Settings'});});
  return settingsRow(m.content,'version '+m.version+' · '+(m.effective?'In use':'Not in use'),toggle);});
 const learned=growth.filter(g=>g.status!=='reverted'&&find(g.candidate)?.authority==='learned').flatMap(g=>{const m=find(g.candidate),open=settingsEvidence.has(g.id),more=chatButton(open?'Hide':'Evidence',()=>{if(open)settingsEvidence.delete(g.id);else settingsEvidence.add(g.id);renderSettings();});more.setAttribute('aria-expanded',String(open));
  const evidence=element('div',undefined,'set-evidence');evidence.id='memory-evidence-'+g.id;evidence.hidden=!open;if(g.scores){let cases=0;try{const held=JSON.parse(g.scores.heldOut);cases=Array.isArray(held&&held.orders)?held.orders.length:0;}catch{}evidence.append(element('span','Correct '+g.scores.baseline+' → '+g.scores.candidate+(cases?' of '+cases+' orders':' · '+String(g.scores.heldOut).slice(0,120))));}evidence.append(element('span','Caution: '+g.counterevidence));
  const wrap=element('div');wrap.append(settingsRow(m.content,'version '+m.version+' · '+(g.status==='adopted'&&m.effective?'In use':'Pending'),more),evidence);return [wrap];});
 const changes=growth.filter(g=>g.status==='adopted'||g.status==='reverted').reverse().map(g=>{const m=find(g.candidate);
  return settingsRow(m?m.content:g.candidate,g.status==='adopted'?'Changed':'Reverted',g.status==='adopted'&&m&&m.effective?chatButton('Revert',()=>settingsPost('/missions/'+encodeURIComponent(mission.id)+'/growth',{expectedRevision:settingsMission.revision,growthId:g.id,baseline:g.baseline,candidate:g.candidate,action:'revert'})):null);});
 return [...settingsCard('You said',said),...settingsCard('Learned',learned),...settingsCard('Change history',changes)];
}
/** B14: model groups with who uses them, then subscription logins and API keys. The Default group's host sentence is not drawn. */
function settingsConnectionsView(){
 const c=settingsCatalog||{},members=chatMembers();
 const groups=(c.modelGroups||[]).map(g=>{const block=element('div',undefined,'set-row'),text=element('span',undefined,'set-text'),users=[...(g.id==='default'?[settingsRepName()]:[]),...members.filter(m=>(m.modelGroup||'default')===g.id).map(m=>m.name)];
  const head=element('strong',g.name);if(users.length)head.append(element('span',' '+users.join(', ')));text.append(head);if(g.id!=='default'&&g.description)text.append(element('span',g.description));
  const chips=element('span',undefined,'set-chips');for(const m of g.models){const chip=element('span',m.model,'set-chip');chip.append(element('span',settingsFamily(m.family)+(m.status==='available'?'':' · Unavailable')));chips.append(chip);}text.append(chips);
  block.append(text,element('span',(n=>n+(n===1?' provider':' providers'))(new Set(g.models.map(m=>settingsFamily(m.family))).size),'set-side'));return block;});
 const cli=(c.connections||[]).filter(x=>/-cli$/.test(x.providerType)),keys=(c.connections||[]).filter(x=>!/-cli$/.test(x.providerType));
 return [...settingsCard('Model groups',groups),...settingsCard('Subscription logins',cli.map(x=>settingsRow(x.label,'Not checked'))),...settingsCard('API keys',keys.map(x=>settingsRow(x.label,x.connectionStatus==='fixture'?'Fixture':x.credentialConfigured?'Connected':'None')))];
}
/** B14 Permissions: the fixed kinds are always asked; the owner's rules allow a first-kind action without asking. Checking rules are never offered. */
function settingsPermissionsView(){
 const r=settingsRules||{ask:[],allow:[]},label=k=>(r.ask.find(a=>a.kind===k)||{}).label||k;
 const add=chatButton('Add rule',()=>{settingsAdding=true;renderSettings();$('permission-what')?.focus?.();});add.disabled=settingsAdding||settingsBusy;
 const rows=[];
 if(settingsAdding){const form=element('form',undefined,'set-form'),what=element('input'),kind=element('select'),cancel=chatButton('Cancel',()=>{settingsAdding=false;renderSettings();}),save=element('button','Add');form.id='permission-form';what.id='permission-what';what.maxLength=120;what.required=true;what.setAttribute('aria-label','What');kind.id='permission-kind';kind.setAttribute('aria-label','Kind');save.type='submit';
  for(const k of settingsAllow){const option=element('option',label(k));option.value=k;kind.append(option);}
  form.addEventListener('submit',event=>{event.preventDefault();const text=what.value.trim();if(!text)return;settingsAdding=false;void settingsPost('/assistant/permissions',{action:'allow',what:text,kind:kind.value});});form.append(what,kind,cancel,save);rows.push(form);}
 rows.push(...r.allow.map(a=>settingsRow(a.what,a.label+' · '+chatDay(a.at),chatButton('Remove',()=>settingsPost('/assistant/permissions',{action:'remove',ruleId:a.id})))));
  return [...settingsCard('Always ask',r.ask.map(a=>settingsRow(a.label))),...settingsCard('Allow without asking',rows,add)];
}
const settingsWhen=at=>Number.isSafeInteger(at)?chatDay(at):'';
const settingsSkillPost=body=>settingsPost('/assistant/skills',body);
/** B19-juno: a member's skills, procedures, model group and recent improvements with Revert; unused skills are archived, never deleted. */
function settingsMemberView(m){
 const k=settingsSkills||{skills:[],improvements:[]},mine=(k.skills||[]).filter(s=>s.memberId===m.id),inUse=mine.filter(s=>s.state==='active'),side=s=>s.author==='owner'?'You':'v'+s.version+' · '+settingsWhen(s.at);
 const back=chatButton('‹ Members',()=>{settingsMember='';renderSettings();},'set-back'),head=element('div',undefined,'set-head'),avatar=element('span',[...m.name][0],'avatar');avatar.setAttribute('aria-hidden','true');avatar.style.background=shellColor(m);
 head.append(avatar,element('h2',m.name),chatButton('Message',()=>chatOpenThread(m.id,m.name)));
 const skills=inUse.filter(s=>s.kind==='skill').map(s=>settingsRow(s.name,'',element('span',side(s),'set-side')));
 const procedures=inUse.filter(s=>s.kind==='procedure').map(s=>{const row=element('div',undefined,'set-row'),steps=element('span',undefined,'set-steps');s.steps.forEach((step,i)=>{if(i)steps.append(element('i','›'));steps.append(element('span',step,'set-chip'));});row.append(steps,element('span',s.name,'set-side'));return row;});
 const g=((settingsCatalog&&settingsCatalog.modelGroups)||[]).find(x=>x.id===(m.modelGroup||'default'));
 const group=settingsRow(settingsGroupName(m.modelGroup||'default'),g&&g.id!=='default'?g.description:'',g?element('span',g.models.length+(g.models.length===1?' model':' models'),'set-side'):null);
 const recent=(k.improvements||[]).filter(c=>c.memberId===m.id&&c.type==='adopted').slice(0,5).map(c=>{
  const wrap=element('div',undefined,'set-item'),row=element('div',undefined,'set-row'),text=element('span',undefined,'set-text'),title=element('strong',c.name+' '),open=settingsDetails.has(c.id),more=element('button','Details','set-more');
  title.append(element('span',(c.from?'v'+c.from+' → ':'')+'v'+c.to));text.append(title,element('span',[settingsWhen(c.at),c.source].filter(Boolean).join(' · ')));more.type='button';more.setAttribute('aria-expanded',String(open));more.addEventListener('click',()=>{if(open)settingsDetails.delete(c.id);else settingsDetails.add(c.id);renderSettings();});text.append(more);
  row.append(text);if(c.reverted)row.append(element('span',c.reverted.to?'Reverted to v'+c.reverted.to:'Reverted','set-side'));else if(c.revertible)row.append(chatButton('Revert',()=>settingsSkillPost({action:'revert',skillId:c.skillId})));wrap.append(row);
  if(open){const box=element('div',undefined,'set-evidence'),dl=element('dl');for(const [t,d] of [['Source',c.source],['Result',c.result],['Checked by',c.checkedBy]])if(d)dl.append(element('dt',t),element('dd',d));box.append(dl);wrap.append(box);}return wrap;});
 // ponytail: Undo restores the latest archive only; one line per skill if owners archive several at once.
 const archived=mine.filter(s=>s.state==='archived'),parts=[back,head,...settingsCard('Skills',skills),...settingsCard('Procedures',procedures),...settingsCard('Model group',[group]),...settingsCard('Recent improvements',recent)];
 if(archived.length){const last=(k.improvements||[]).find(c=>c.type==='archived'&&archived.some(s=>s.id===c.skillId)),lineEl=element('p',undefined,'set-line');lineEl.append(element('span','Archived '+archived.length+' unused '+(archived.length===1?'skill':'skills')),chatButton('Undo',()=>settingsSkillPost({action:'restore',skillId:last?last.skillId:archived[0].id}),''));parts.push(lineEl);}
 return parts;
}
/** B14 Improvements: one card, what waits for the owner (the card itself is in the member conversation), what could not be checked, then each past improvement with its revert. */
function settingsImprovementsView(){
 const k=settingsSkills||{candidates:[],improvements:[]},kind=c=>c.kind==='procedure'?'Procedure':'Skill';
 const waiting=(k.candidates||[]).filter(c=>c.state==='deciding'||c.state==='later').map(c=>settingsRow(c.name,[kind(c),c.result,settingsWhen(c.at),c.state==='later'?'Later':'Decision pending'].filter(Boolean).join(' · ')));
 const unchecked=(k.candidates||[]).filter(c=>c.state==='unchecked').map(c=>settingsRow(c.name,(c.reason||'No way to check')+' · '+settingsWhen(c.at),chatButton('Drop',()=>settingsSkillPost({action:'drop',candidateId:c.id}))));
 const past=(k.improvements||[]).filter(c=>c.type==='adopted').map(c=>settingsRow(c.name,['Applied '+settingsWhen(c.at),c.reverted&&'Reverted '+(settingsWhen(c.reverted.at)===settingsWhen(c.at)?'the same day':settingsWhen(c.reverted.at)),(c.from?'v'+c.from+' → ':'')+'v'+c.to].filter(Boolean).join(' · ')));
 return [settingsCard('',[...waiting,...unchecked,...past])[1]];
}
for(const name of settingsNames)$('settings-nav-'+name).addEventListener('click',()=>settingsOpen(name));
`;
