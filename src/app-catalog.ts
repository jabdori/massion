/** The host's bundled app catalog (docs/architecture/apps.md) and the fixture network it is shown with. No outside catalog or network is reached. */
import type {AppPackage} from './apps.ts';
import {copy} from './ui-copy.ts';

const source=String.raw`const REPO='jabdori/massion';
// ponytail: one repository; a repository setting comes with the first owner who has two.
const get=async path=>{const r=await massion.fetch('https://api.github.com/repos/'+REPO+path,{secret:'github-token'});if(r.status!==200)throw new Error('GitHub '+r.status);return JSON.parse(r.body);};
const fileText=encoded=>{const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',value=encoded.replace(/\s/g,'');let bits=0,acc=0,encodedBytes='';if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('Invalid file encoding');for(const c of value.replace(/=+$/,'')){acc=(acc<<6)|alphabet.indexOf(c);bits+=6;if(bits>=8){bits-=8;encodedBytes+='%'+((acc>>bits)&255).toString(16).padStart(2,'0');}}return decodeURIComponent(encodedBytes);};
const when=s=>s?s.slice(0,16).replace('T',' '):'';
const state=p=>p.merged_at?'Merged':p.state==='open'?'Open':'Closed';
const subject=message=>{const line=message.split(/[\r\n]/,1)[0].replace(/[\u0000-\u001f\u007f]/g,' ');return line.length<=512?line:line.slice(0,511).replace(/[\uD800-\uDBFF]$/u,'')+'…';};
const identity=p=>({repository:REPO,number:p.number,headSha:p.head.sha,url:p.html_url});
const row=p=>({id:String(p.number),title:p.title,meta:'#'+p.number+' · '+when(p.merged_at||p.created_at),state:state(p),github:identity(p)});
massion.handle('page',async()=>{const pulls=await get('/pulls?state=all&per_page=30');return {title:'GitHub',meta:REPO,groups:[{title:'Open',rows:pulls.filter(p=>p.state==='open').map(row)},{title:'Merged',rows:pulls.filter(p=>p.merged_at).map(row)}]};});
massion.handle('item',async({ref})=>{const p=await get('/pulls/'+ref),files=await get('/pulls/'+ref+'/files'),commits=await get('/pulls/'+ref+'/commits');
 const candidates=await Promise.all(files.slice(0,11).filter(f=>f.status!=='removed').map(async f=>{try{const d=await get('/contents/'+f.filename.split('/').map(encodeURIComponent).join('/')+'?ref='+p.head.sha);if(d.type!=='file'||d.path!==f.filename||d.encoding!=='base64'||d.size>10000)return null;const content=fileText(d.content);return content.includes('\0')?null:{path:f.filename,content};}catch{return null;}}));
 const sourceFiles=[];for(const f of candidates)if(f&&encodeURIComponent(JSON.stringify([...sourceFiles,f])).replace(/%[A-F0-9]{2}/g,'x').length<=12000)sourceFiles.push(f);
 return {...(sourceFiles.length?{sourceFiles}:{}),title:p.title+' #'+p.number,github:identity(p),meta:state(p)+' · '+p.user.login+' · '+p.head.ref+' → '+p.base.ref,fields:[['Changes','+'+p.additions+' −'+p.deletions]],groups:[{title:'Files '+files.length,rows:files.map(f=>({id:f.filename,title:f.filename,meta:'+'+f.additions+' −'+f.deletions}))},{title:'Commits '+commits.length,rows:commits.map(c=>({id:c.sha,title:subject(c.commit.message),meta:c.sha.slice(0,7)+' · '+when(c.commit.committer.date)}))}]};});`;
export const GITHUB_APP:AppPackage={manifest:{format:'massion.app.v1',id:'github',name:'GitHub',version:'1.4.2',description:'Pull requests',
 permissions:{read:['Repositories','Pull requests','Check results'],write:[],network:['api.github.com'],files:[],secrets:[{slot:'github-token',label:'GitHub token'}],events:['PR opened','PR merged']},
 contributes:{page:{title:'GitHub'},roomTab:{prefix:'PR #'},templates:['Code review'],skills:['PR summary'],procedures:['PR review'],tools:['gh']},handlers:['page','item']},source};
export const CATALOG:readonly AppPackage[]=[GITHUB_APP];

// Display metadata only; install authority remains with CATALOG's executable packages.
export const RECOMMENDED_APPS=[
 {id:'slack',name:'Slack',description:copy('ui.apps.recommendation.slack')},
 {id:'linear',name:'Linear',description:copy('ui.apps.recommendation.linear')},
 {id:'google-calendar',name:copy('ui.apps.google-calendar'),description:copy('ui.apps.recommendation.google-calendar')},
 {id:'notion',name:'Notion',description:copy('ui.apps.recommendation.notion')},
 {id:'figma',name:'Figma',description:copy('ui.apps.recommendation.figma')},
 {id:'sentry',name:'Sentry',description:copy('ui.apps.recommendation.sentry')}
] as const;

// Fixture responses (values from the 2026-11-05 run, as in the prototype). Tests and the screenshot host pass this as the mock network.
const pull=(number:number,title:string,head:string,merged:string|null,created:string,additions:number,deletions:number)=>({number,title,html_url:'https://github.com/jabdori/massion/pull/'+number,state:merged?'closed':'open',merged_at:merged,created_at:created,user:{login:'jabdori'},head:{ref:head,sha:({84:'cf2a4b325b3954e04ba4a4e3ddfa58ded8b6de66',83:'f8c9b57487193bae6d7c6b7baf60e363cab21273',82:'1b3b13edadf9e8516133ed66229d701aa4115cba'} as Record<number,string>)[number]},base:{ref:'main'},additions,deletions});
const PULLS=[pull(84,'feat(assistant): answer the owner and start Representative Work','feat/assistant-conversation-turns',null,'2026-11-05T10:28:00Z',769,39),
 pull(83,'feat(assistant): store the continuing assistant conversation as journal segments','feat/assistant-conversation-storage','2026-11-05T10:29:00Z','2026-11-04T18:00:00Z',412,20),
 pull(82,'docs(product): experience plan v3 with conversation and on-demand panes','docs/experience-plan-v3','2026-11-05T09:57:00Z','2026-11-04T17:00:00Z',300,120)];
const FILES=[['src/assistant-service.ts',206,0],['tests/assistant-conversation.test.ts',370,0],['src/assistant-conversation-panel.ts',83,0],['docs/architecture/assistant-conversation.md',31,3],['src/connection-workbench.ts',30,12],['src/configured-runtime.ts',15,9],['src/product.ts',13,7],['src/server.ts',9,3],['src/workbench.ts',7,2],['src/selectable-runtime.ts',3,3],['docs/architecture/default-route-and-persistent-connections.md',2,0]].map(([filename,additions,deletions])=>({filename,additions,deletions}));
export function githubFixture(url:string):{status:number;body:string} {
 const parsed=new URL(url);if(parsed.pathname.startsWith('/repos/jabdori/massion/contents/')){const path=decodeURIComponent(parsed.pathname.slice('/repos/jabdori/massion/contents/'.length));if(FILES.some(f=>f.filename===path)&&PULLS.some(p=>p.head.sha===parsed.searchParams.get('ref'))){const content='// Controlled fixture source: '+path+'\n';return {status:200,body:JSON.stringify({type:'file',path,encoding:'base64',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64')})};}}
 const path=new URL(url).pathname+new URL(url).search,base='/repos/jabdori/massion/pulls';
 if(path===base+'?state=all&per_page=30')return {status:200,body:JSON.stringify(PULLS)};
 const m=/^\/repos\/jabdori\/massion\/pulls\/(\d+)(\/files|\/commits)?$/.exec(path),p=m&&PULLS.find(x=>x.number===Number(m[1]));
 if(p)return {status:200,body:JSON.stringify(m![2]==='/files'?FILES:m![2]==='/commits'?[{sha:p.head.sha,commit:{message:p.title,committer:{date:p.created_at}}},{sha:'0c9431de4f726755ef95df11447190c693c2b056',commit:{message:"Merge remote-tracking branch 'origin/feat/assistant-conversation-storage' into feat/assistant-conversation-turns",committer:{date:p.created_at}}}]:p)};
 return {status:404,body:'{}'};
}
