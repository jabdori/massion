/** The host's bundled app catalog (docs/architecture/apps.md) and the fixture network it is shown with. No outside catalog or network is reached. */
import type {AppPackage} from './apps.ts';

const source=String.raw`const REPO='jabdori/massion';
// ponytail: one repository; a repository setting comes with the first owner who has two.
const get=async path=>{const r=await massion.fetch('https://api.github.com/repos/'+REPO+path,{secret:'github-token'});if(r.status!==200)throw new Error('GitHub '+r.status);return JSON.parse(r.body);};
const when=s=>s?s.slice(0,16).replace('T',' '):'';
const state=p=>p.merged_at?'Merged':p.state==='open'?'Open':'Closed';
const row=p=>({id:String(p.number),title:p.title,meta:'#'+p.number+' · '+when(p.merged_at||p.created_at),state:state(p)});
massion.handle('page',async()=>{const pulls=await get('/pulls?state=all&per_page=30');return {title:'GitHub',meta:REPO,groups:[{title:'Open',rows:pulls.filter(p=>p.state==='open').map(row)},{title:'Merged',rows:pulls.filter(p=>p.merged_at).map(row)}]};});
massion.handle('item',async({ref})=>{const p=await get('/pulls/'+ref),files=await get('/pulls/'+ref+'/files');
 return {title:p.title+' #'+p.number,meta:state(p)+' · '+p.user.login+' · '+p.head.ref+' → '+p.base.ref,fields:[['Changes','+'+p.additions+' −'+p.deletions]],groups:[{title:'Files '+files.length,rows:files.map(f=>({id:f.filename,title:f.filename,meta:'+'+f.additions+' −'+f.deletions}))}]};});`;
export const GITHUB_APP:AppPackage={manifest:{format:'massion.app.v1',id:'github',name:'GitHub',version:'1.4.0',description:'Pull requests',
 permissions:{read:['Repositories','Pull requests','Check results'],write:[],network:['api.github.com'],files:[],secrets:[{slot:'github-token',label:'GitHub token'}],events:['PR opened','PR merged']},
 contributes:{page:{title:'GitHub'},roomTab:{prefix:'PR #'},templates:['Code review'],skills:['PR summary'],procedures:['PR review'],tools:['gh']},handlers:['page','item']},source};
export const CATALOG:readonly AppPackage[]=[GITHUB_APP];

// Fixture responses (values from the 2026-11-05 run, as in the prototype). Tests and the screenshot host pass this as the mock network.
const pull=(number:number,title:string,head:string,merged:string|null,created:string,additions:number,deletions:number)=>({number,title,state:merged?'closed':'open',merged_at:merged,created_at:created,user:{login:'jabdori'},head:{ref:head},base:{ref:'main'},additions,deletions});
const PULLS=[pull(84,'feat(assistant): answer the owner and start Representative Work','feat/assistant-conversation-turns',null,'2026-11-05T10:28:00Z',769,39),
 pull(83,'feat(assistant): store the continuing assistant conversation as journal segments','feat/assistant-conversation-storage','2026-11-05T10:29:00Z','2026-11-04T18:00:00Z',412,20),
 pull(82,'docs(product): experience plan v3 with conversation and on-demand panes','docs/experience-plan-v3','2026-11-05T09:57:00Z','2026-11-04T17:00:00Z',300,120)];
const FILES=[['src/assistant-service.ts',206,0],['tests/assistant-conversation.test.ts',370,0],['src/assistant-conversation-panel.ts',83,0],['docs/architecture/assistant-conversation.md',31,3],['src/connection-workbench.ts',30,12],['src/configured-runtime.ts',15,9],['src/product.ts',13,7],['src/server.ts',9,3],['src/workbench.ts',7,2],['src/selectable-runtime.ts',3,3],['docs/architecture/default-route-and-persistent-connections.md',2,0]].map(([filename,additions,deletions])=>({filename,additions,deletions}));
export function githubFixture(url:string):{status:number;body:string} {
 const path=new URL(url).pathname+new URL(url).search,base='/repos/jabdori/massion/pulls';
 if(path===base+'?state=all&per_page=30')return {status:200,body:JSON.stringify(PULLS)};
 const m=/^\/repos\/jabdori\/massion\/pulls\/(\d+)(\/files)?$/.exec(path),p=m&&PULLS.find(x=>x.number===Number(m[1]));
 if(p)return {status:200,body:JSON.stringify(m![2]?FILES:p)};
 return {status:404,body:'{}'};
}
