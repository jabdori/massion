import {startFixtureHost,loadFixture} from '../../scripts/ui-contracts/fixture-host.ts';
import {inheritedDaemonSecret} from '../../src/daemon-auth.ts';

const daemonSecret=inheritedDaemonSecret();
if(!daemonSecret)throw new Error('Fixture daemon requires supervisor authentication');
const fixture=await loadFixture('B7-unknown');
const conversation=fixture.routes['/assistant/conversation'].body;conversation.apps=[...(conversation.apps??[]),{id:'frame-probe',name:'Probe',page:true,item:false,roomTab:null}];
fixture.appViews=[{request:{app:'frame-probe',handler:'page'},body:{title:'Probe',groups:[],frame:{html:`<!doctype html><style>body{background:rgb(12,34,56);color:rgb(210,220,230)}</style><p id=probe>Isolated app</p><script>
window.probe={ran:true,parentBlocked:false,networkBlocked:false};
try{parent.document.body.dataset.appEscaped='true';}catch{window.probe.parentBlocked=true;}
Promise.all(['https://example.org/','http://127.0.0.1:1/','massion://app/protocol/connect'].map(url=>fetch(url).then(()=>false,()=>true))).then(blocked=>{
 window.probe.networkBlocked=blocked.every(Boolean);parent.postMessage({type:'ready'},'*');parent.postMessage({type:'resize',height:617},'*');
});
</script>`}}}];
const server=await startFixtureHost(fixture,{daemonSecret,port:Number(process.env.MASSION_PORT)});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void server.close().then(()=>process.exit(0)));
