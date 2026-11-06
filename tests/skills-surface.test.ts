import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

// docs/architecture/self-made-skills.md, Surface: the member page (B19-juno) and Settings > Improvements (B14).
const T0=Date.UTC(2026,10,5,9,0);
const juno={id:'member-juno',name:'주노',look:{shape:'round',color:'agent-3'},modelGroup:'default'};
const skills=[
 {id:'skill-read',memberId:'member-juno',kind:'skill',name:'Read code',version:1,author:'owner',at:T0,state:'active',steps:['Open the diff']},
 {id:'skill-pr',memberId:'member-juno',kind:'skill',name:'PR description',version:1,author:'member',at:T0,state:'active',steps:['List changed files','Name the test for each file']},
 {id:'proc-review',memberId:'member-juno',kind:'procedure',name:'PR review',version:2,author:'member',at:T0,state:'active',steps:['Run tests first','Read','Check','Record']},
 {id:'skill-old',memberId:'member-juno',kind:'skill',name:'Old notes',version:1,author:'member',at:T0,state:'archived',steps:['Write notes']},
 {id:'skill-other',memberId:'member-other',kind:'skill',name:'Elsewhere',version:1,author:'member',at:T0,state:'active',steps:['x']}];
const improvements=[
 {id:'ch-5',at:T0+4,type:'archived',skillId:'skill-old',memberId:'member-juno',name:'Old notes',kind:'skill',from:1,to:1,source:null,result:null,checkedBy:null,revertible:false,reverted:null},
 {id:'ch-4',at:T0+3,type:'reverted',skillId:'skill-pr',memberId:'member-juno',name:'PR description',kind:'skill',from:2,to:1,source:null,result:null,checkedBy:null,revertible:false,reverted:null},
 {id:'ch-3',at:T0+2,type:'adopted',skillId:'proc-review',memberId:'member-juno',name:'PR review',kind:'procedure',from:1,to:2,source:'PR #84 review',result:'2 → 4 of 4',checkedBy:'Host check',revertible:true,reverted:null},
 {id:'ch-2',at:T0+1,type:'adopted',skillId:'skill-pr',memberId:'member-juno',name:'PR description',kind:'skill',from:1,to:2,source:'PR #84 review',result:'3 → 3 of 3',checkedBy:'Different family',revertible:false,reverted:{to:1,at:T0+3}}];
const candidates=[
 {id:'cand-wait',at:T0,memberId:'member-juno',name:'Read code',kind:'skill',state:'deciding',reason:null,result:'1 → 3 of 3'},
 {id:'cand-same',at:T0,memberId:'member-juno',name:'PR number in summary',kind:'skill',state:'unchecked',reason:'No way to check',result:'2 → 2 of 3'},
 {id:'cand-bad',at:T0,memberId:'member-juno',name:'Fetch rules',kind:'skill',state:'rejected',reason:'Remote loading',result:null}];
function fixture(){
 const posted:{path:string;body:any}[]=[];
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){posted.push({path,body:JSON.parse(options.body)});return reply({status:'committed',revision:2});}
  if(path==='/assistant/skills')return reply({feedId:'feed:a',revision:4,skills,improvements,candidates});
  if(path==='/connections')return reply({host:null,providerTypes:[],connections:[],runtime:{connections:[],defaultRoutes:[]},configHash:'h',grants:[],representative:{intakeMissionId:'intake'},modelGroups:[{id:'default',name:'Default',description:'',editable:false,models:[]}],fixtureModeEnabled:false,liveExecutionEnabled:false});
  if(path==='/assistant/schedules')return reply({feedId:'feed:a',revision:1,schedules:[]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:1,members:[juno],decisions:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});
  return reply({error:'Not configured'},503);
 });
 return {app,posted};
}
const byId=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id);
const button=(node:Node,label:string)=>{const found:Node[]=[];const visit=(n:Node)=>{if(n.tagName==='BUTTON'&&n.textContent===label)found.push(n);n.children.forEach(visit);};visit(node);return found;};
const open=async(app:ReturnType<typeof harness>,section:string)=>{await app.node('me-settings').fire('click');await settle();await app.node('settings-nav-'+section).fire('click');await settle();};

test('a member row opens the member page: skills, procedures as steps, model group, recent improvements with details and revert, and the archived line',async()=>{
 const {app,posted}=fixture();await settle();await open(app,'members');
 await byId(app,'settings-member-member-juno')!.fire('click');await settle();
 const page=app.node('settings-members-body');
 assert.match(page.textContent,/Members.*주노.*Message/);
 assert.match(page.textContent,/Skills.*Read code.*You.*PR description.*v1 · /);assert.doesNotMatch(page.textContent,/Elsewhere/,'only this member');
 assert.match(page.textContent,/Procedures.*Run tests first.*Read.*Check.*Record/);
 assert.match(page.textContent,/Model group.*Default/);
 assert.match(page.textContent,/Recent improvements.*PR review.*v1 → v2.*PR #84 review.*PR description.*v1 → v2.*Reverted to v1/);
 assert.doesNotMatch(page.textContent,/Explanation|assistant|Lead|Team/i);
 const details=button(page,'Details');assert.equal(details.length,2);assert.equal(details[1]!.attributes.get('aria-expanded'),'false');await details[1]!.fire('click');
 const again=app.node('settings-members-body');assert.match(again.textContent,/Source.*PR #84 review.*Result.*3 → 3 of 3.*Checked by.*Different family/);
 await button(again,'Revert')[0]!.fire('click');await settle();assert.deepEqual(posted.at(-1),{path:'/assistant/skills',body:{commandId:posted.at(-1)!.body.commandId,action:'revert',skillId:'proc-review'}});
 const now=app.node('settings-members-body');assert.match(now.textContent,/Archived 1 unused skill.*Undo/);
 await button(now,'Undo')[0]!.fire('click');await settle();assert.deepEqual(posted.at(-1)!.body.action,'restore');assert.equal(posted.at(-1)!.body.skillId,'skill-old');
 await button(app.node('settings-members-body'),'Message')[0]!.fire('click');await settle();
 assert.equal(app.node('page-chat').hidden,false);assert.ok(app.calls.some(c=>c.path==='/assistant/conversation?member=member-juno'));
});

test('Settings > Improvements is one card: what waits for the owner, what could not be checked with Drop, then each past improvement with its revert',async()=>{
 const {app,posted}=fixture();await settle();await open(app,'improvements');
 assert.equal(app.node('settings-nav-improvements').attributes.get('aria-current'),'page');
 const body=app.node('settings-improvements-body');
 assert.match(body.textContent,/Read code.*Skill · 1 → 3 of 3 · .+ · Decision pending.*PR number in summary.*No way to check · .+Drop.*PR review.*Applied .+ · v1 → v2.*PR description.*Applied .+ · Reverted the same day · v1 → v2/);
 assert.doesNotMatch(body.textContent,/Waiting for you|Not checked|History|주노|Old notes|Fetch rules/,'no invented section titles; archives and scan rejections stay out');
 await button(body,'Drop')[0]!.fire('click');await settle();assert.deepEqual([posted.at(-1)!.path,posted.at(-1)!.body.action,posted.at(-1)!.body.candidateId],['/assistant/skills','drop','cand-same']);
});
