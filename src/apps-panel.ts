import {copy} from './ui-copy.ts';
/** Apps on the surface (docs/architecture/apps.md, prototype B22, B22-room, B23, B23-github, B24): rail icons, the app page, the Work room app tab and Settings > Apps. Apps send views as data; every string is drawn through textContent. */
export const appsStyle=String.raw`.app-mark{background:var(--bg-3);color:var(--fg)}.rail .app-mark{width:22px;height:22px;border-radius:6px;font-size:12px}.set-row .app-mark,.set-head .app-mark{background:var(--bg-3);color:var(--fg)}
.rail .app-branch{display:block;width:18px;height:18px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%221.75%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%227%22%20cy%3D%225.5%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%227%22%20cy%3D%2218.5%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2217%22%20cy%3D%228.5%22%20r%3D%222%22%2F%3E%3Cpath%20d%3D%22M7%207.5v9M17%2010.5c0%203.5-4%203-8.5%206.5%22%2F%3E%3C%2Fsvg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22white%22%20stroke-width%3D%221.75%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%227%22%20cy%3D%225.5%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%227%22%20cy%3D%2218.5%22%20r%3D%222%22%2F%3E%3Ccircle%20cx%3D%2217%22%20cy%3D%228.5%22%20r%3D%222%22%2F%3E%3Cpath%20d%3D%22M7%207.5v9M17%2010.5c0%203.5-4%203-8.5%206.5%22%2F%3E%3C%2Fsvg%3E") center/contain no-repeat}
.app-side-head{display:grid;gap:2px;padding:4px 8px 10px}.app-side-head strong{font-size:15px}.app-side-head span{color:var(--fg-3);font:12px var(--font-mono)}.app-group{margin:10px 8px 4px;color:var(--fg-3);font-size:12px}
.app .app-row{display:grid;gap:2px;width:100%;padding:8px;border:0;border-radius:7px;background:transparent;color:var(--fg);text-align:left;font-weight:500}.app .app-row:hover,.app .app-row[aria-current=true]{background:var(--bg-3)}.app-row span{color:var(--fg-3);font-size:12px}
#side-app{display:flex;flex-direction:column;min-height:calc(100% - 36px)}#side-app .app-foot{margin-top:auto;padding-top:8px;border-top:1px solid var(--line)}.app .app-foot button{width:100%;justify-content:flex-start;border:0;background:transparent;color:var(--fg-2);font-weight:500;text-align:left}
.app-view{max-width:820px;margin:0 auto;padding:12px 10px 32px}.app-view h2{margin:0 0 6px;font-size:20px;font-weight:650}.app-view .app-meta{margin:0 0 14px;color:var(--fg-3);font-size:13px}.app-view dl{display:grid;grid-template-columns:96px 1fr;gap:4px;margin:0 0 14px;font-size:13px}.app-view dt{color:var(--fg-3)}.app-view dd{margin:0}
.app-view h3{margin:16px 0 6px;color:var(--fg-3);font-size:12px;font-weight:600}.app-list{list-style:none;margin:0;padding:0}.app-list li{display:flex;gap:12px;justify-content:space-between;padding:7px 4px;border-bottom:1px solid var(--line);font:13px var(--font-mono)}.app-list li span:last-child{color:var(--fg-3);white-space:nowrap}
.app-view.pane-app{flex:1;min-height:0;overflow:auto;max-width:none;margin:0;padding:16px 20px}.set-pair strong{flex:0 0 120px}.set-pair span{flex:1;min-width:0;color:var(--fg);font-size:13px;overflow-wrap:anywhere}.set-pair .set-side{flex:none}.set-version{font:13px var(--font-mono);flex:0 0 64px}.set-head-text{flex:1;display:grid;gap:2px}.set-head-text h2{margin:0}.set-head-text span{color:var(--fg-3);font-size:12px}`;
export const appsPage=String.raw`<div id="page-app" class="page-body" hidden><div id="app-view" class="app-view" aria-live="polite"></div></div>`;
export const appsSide=String.raw`<nav id="side-app" aria-label="${copy('ui.apps')}" hidden></nav>`;
export const appsPane=String.raw`<div id="pane-app" class="pane-app app-view" role="tabpanel" aria-label="${copy('ui.apps')}" hidden></div>`;
export const appsClient=String.raw`
// Each async read has its own generation: a response is drawn only if no newer request of its kind started since (A, B, A again drops the first A).
let appsList=[],appShown='',appItem='',appPage=null,appSeq=0,appItemSeq=0,appTabSeq=0,settingsApps=null,settingsApp='';
const appsMark=name=>{const mark=element('span',[...name][0],'avatar app-mark');mark.setAttribute('aria-hidden','true');return mark;};
/** Enabled apps from the conversation read (rail and room tabs); malformed entries are skipped. */
function appsRail(view){
 appsList=(Array.isArray(view&&view.apps)?view.apps:[]).filter(a=>a&&chatText(a.id)&&chatText(a.name)&&typeof a.page==='boolean'&&typeof a.item==='boolean'&&(a.roomTab===null||chatText(a.roomTab)));
 const box=$('rail-apps'),shown=appsList.filter(a=>a.page),key=JSON.stringify(shown.map(a=>[a.id,a.name]));
 if(box.appsKey!==key){box.appsKey=key;box.replaceChildren(...shown.map(a=>{const b=element('button',undefined,'icon');b.type='button';b.id='rail-app-'+a.id;b.setAttribute('aria-label',a.name);const mark=a.name==='GitHub'?element('span',undefined,'app-branch'):appsMark(a.name);mark.setAttribute('aria-hidden','true');b.append(mark);b.addEventListener('click',()=>void appOpen(a.id));return b;}));}
 box.hidden=!shown.length;appsCurrent();
}
function appsCurrent(){for(const b of $('rail-apps').children)b.setAttribute('aria-current',!$('page-app').hidden&&b.id==='rail-app-'+appShown?'page':'false');}
async function appsRead(app,handler,ref,feed){try{const {response,body}=await request('/assistant/apps/view',{method:'POST',headers:{'Content-Type':'application/json',...(feed?{'X-Massion-Feed':feed}:{})},body:JSON.stringify(ref===undefined?{app,handler}:{app,handler,ref})});return response.ok?body:null;}catch{return null;}}
/** The host's components draw an app view: a title, a meta line, label/value fields and row groups. */
function appsViewNodes(v){
 if(!v||!chatText(v.title)||!Array.isArray(v.groups))return [element('p',copy('ui.panel.unavailable'),'app-meta')];
 const out=[element('h2',v.title)];if(chatText(v.meta))out.push(element('p',v.meta,'app-meta'));
 if(Array.isArray(v.fields)&&v.fields.length){const dl=element('dl');for(const f of v.fields)if(Array.isArray(f)&&f.length===2)dl.append(element('dt',f[0]),element('dd',f[1]));out.push(dl);}
 for(const g of v.groups){if(!g||!Array.isArray(g.rows))continue;out.push(element('h3',g.title));const list=element('ul',undefined,'app-list');for(const r of g.rows){const li=element('li');li.append(element('span',r.title),element('span',[r.meta,r.state].filter(Boolean).join(' · ')));list.append(li);}out.push(list);}
 return out;
}
/** B22: the app's list in the sidebar with App settings at its foot, the selected item in the page. An app without an item handler, or a page without rows, shows the page view itself. */
async function appOpen(id){
 const a=appsList.find(x=>x.id===id);if(!a)return;const seq=++appSeq;appShown=id;appItem='';appPage=null;shellShow('app');$('page-heading').textContent=a.name;$('app-view').replaceChildren();renderAppSide();appsCurrent();
 // A late response for an earlier open (another app, or this one reopened) is dropped before it touches the shared page.
 const page=await appsRead(id,'page',undefined,chatView&&chatView.feedId);if(seq!==appSeq)return;appPage=page;renderAppSide();
 // Like B22, the first row opens with the page.
 const first=a.item&&page&&Array.isArray(page.groups)?page.groups.flatMap(g=>g&&Array.isArray(g.rows)?g.rows:[])[0]:null;if(first){if(!appItem)await appSelect(first.id);}else $('app-view').replaceChildren(...appsViewNodes(page));
}
function renderAppSide(){
 const a=appsList.find(x=>x.id===appShown),side=$('side-app'),head=element('div',undefined,'app-side-head');if(!a){side.replaceChildren();return;}
 head.append(element('strong',appPage&&chatText(appPage.title)?appPage.title:a.name));if(appPage&&chatText(appPage.meta))head.append(element('span',appPage.meta));const parts=[head];
 if(appPage&&Array.isArray(appPage.groups))for(const g of appPage.groups){if(!g||!Array.isArray(g.rows))continue;parts.push(element('p',g.title,'app-group'));
  for(const r of g.rows){const b=element('button',undefined,'app-row');b.type='button';b.id='app-row-'+r.id;b.setAttribute('aria-current',String(appItem===r.id));b.append(element('strong',r.title),element('span',[r.meta,r.state].filter(Boolean).join(' · ')));if(a.item)b.addEventListener('click',()=>void appSelect(r.id));else b.disabled=true;parts.push(b);}}
 else if(!appPage)parts.push(element('p',copy('ui.panel.unavailable'),'app-group'));
 const foot=element('div',undefined,'app-foot');foot.append(chatButton(copy('sidebar.link.12'),()=>{shellShow('settings');settingsOpen('apps',appShown);},''));parts.push(foot);side.replaceChildren(...parts);
}
async function appSelect(ref){const id=appShown,seq=appSeq,gen=++appItemSeq;appItem=ref;renderAppSide();const v=await appsRead(id,'item',ref,appPage&&appPage.feedId);if(seq===appSeq&&gen===appItemSeq)$('app-view').replaceChildren(...appsViewNodes(v));}
/** B22-room: a Work whose title names the prefix and a number gets that app's tab, drawn by its item view. */
function appsRoomTabs(title){
 for(const a of appsList){if(!a.roomTab)continue;const at=String(title).indexOf(a.roomTab);if(at<0)continue;const ref=/^\d{1,9}/.exec(String(title).slice(at+a.roomTab.length));if(!ref)continue;
  const key='app:'+a.id+':'+ref[0];if(!paneTabs.some(t=>t.key===key))paneTabs.push({key,title:a.roomTab+ref[0],appTab:{id:a.id,ref:ref[0]}});}
}
async function appsTabLoad(tab){const gen=++appTabSeq;$('pane-app').replaceChildren();const v=await appsRead(tab.appTab.id,'item',tab.appTab.ref,chatView&&chatView.feedId);if(gen===appTabSeq&&paneActive===tab.key)$('pane-app').replaceChildren(...appsViewNodes(v));}
/** One owner command from the conversation; the next read shows the state. */
async function appsPost(body){try{await request('/assistant/apps',{method:'POST',headers:{'Content-Type':'application/json',...(chatView&&chatView.feedId?{'X-Massion-Feed':chatView.feedId}:{})},body:JSON.stringify({commandId:crypto.randomUUID(),...body})});}catch{}finally{await readChat();}}
const appsJoin=v=>Array.isArray(v)&&v.length?v.join(' · '):copy('settings.text.03');
function settingsPair(label,value,side){const row=element('div',undefined,'set-row set-pair');row.append(element('strong',label),element('span',value));if(side)row.append(side);return row;}
/** B23: installed catalog apps, then self-made apps with their maker and source Work, then what the host catalog recommends; Install asks in the Representative conversation. */
function settingsAppsView(){
 const k=settingsApps||{apps:[],catalog:[]},a=settingsApp&&k.apps.find(x=>x.id===settingsApp);$('settings-apps-title').hidden=!!a;if(a)return settingsAppView(a);settingsApp='';
 const member=id=>(chatMembers().find(m=>m.id===id)||{}).name;
 const appRow=(x,meta)=>{const row=element('button',undefined,'set-row');row.type='button';row.id='settings-app-'+x.id;row.append(appsMark(x.name),settingsText(x.name,meta.filter(Boolean).join(' · ')),element('span',(x.enabled?copy('ui.panel.on'):copy('ui.panel.off'))+' ›','set-side'));row.addEventListener('click',()=>{settingsApp=x.id;renderSettings();});return row;};
 const rows=k.apps.filter(x=>x.origin!=='self-made').map(x=>appRow(x,[x.version])),made=k.apps.filter(x=>x.origin==='self-made').map(x=>appRow(x,[x.version,copy('ui.panel.made-by',{member:member(x.memberId)||x.memberId}),x.source&&x.source.title]));
 const recommended=k.catalog.filter(c=>!c.installed).map(c=>{const row=element('div',undefined,'set-row');row.append(appsMark(c.name),settingsText(c.name,c.description),chatButton(copy('settings.link.04'),async()=>{await settingsPost('/assistant/apps',{action:'install',catalogId:c.id});chatOpenThread('');await readChat();}));return row;});
 return [...settingsCard(copy('ui.panel.installed-count',{count:rows.length}),rows),...(made.length?settingsCard(copy('ui.panel.self-made-count',{count:made.length}),made):[]),...(recommended.length?settingsCard(copy('settings.heading.13'),recommended):[])];
}
/** B23-github: permissions, what the app adds, versions with roll back, open and turn off. */
function settingsAppView(a){
 const post=body=>settingsPost('/assistant/apps',{appId:a.id,...body}),p=a.permissions||{},c=a.contributes||{};
 const back=chatButton('‹ '+copy('ui.apps'),()=>{settingsApp='';renderSettings();},'set-back'),head=element('div',undefined,'set-head'),text=element('div',undefined,'set-head-text');
 text.append(element('h2',a.name),element('span',[a.version,copy('ui.panel.installed-date',{date:chatDay(a.installedAt)}),a.check].filter(Boolean).join(' · ')));head.append(appsMark(a.name),text);
 if(c.page&&a.enabled)head.append(chatButton(copy('settings.link.05'),()=>appOpen(a.id)));head.append(chatButton(a.enabled?copy('settings.button.04'):copy('page.switch.02'),()=>post({action:a.enabled?'disable':'enable'})));
 const screens=[...(c.page?[copy('ui.panel.app-page',{title:c.page.title})]:[]),...(c.roomTab?[copy('ui.panel.app-tab',{title:String(c.roomTab.prefix).replace(/\s*#$/,'')})]:[])];
 const permissions=[[copy('ui.panel.tools'),appsJoin([...(p.read||[]),...(p.write||[])])],[copy('settings.text.02'),appsJoin(p.network)],[copy('sidebar.button.14'),appsJoin(p.files)],[copy('settings.text.05'),appsJoin((p.secrets||[]).map(s=>s.label))],[copy('settings.text.04'),appsJoin(p.events)]].map(([l,v])=>settingsPair(l,v));
 const adds=[[copy('ui.panel.member-templates'),appsJoin(c.templates)],[copy('settings.heading.07'),appsJoin(c.skills)],[copy('settings.heading.09'),appsJoin(c.procedures)],[copy('ui.panel.tools'),appsJoin(c.tools)],[copy('ui.panel.screens'),appsJoin(screens)]].map(([l,v])=>settingsPair(l,v));
 const versions=(a.versions||[]).slice().sort((x,y)=>y.index-x.index).map(v=>{const row=element('div',undefined,'set-row');row.append(element('span',v.version,'set-version'),element('span',v.current?copy('ui.panel.current-version',{date:chatDay(v.at)}):chatDay(v.at),'set-text'));if(!v.current)row.append(chatButton(copy('settings.button.13'),()=>post({action:'rollback',version:v.index})));return row;});
 return [back,head,...settingsCard(copy('sidebar.heading.01'),permissions),...settingsCard(copy('settings.heading.12'),adds),...settingsCard(copy('settings.heading.04'),versions)];
}
`;
