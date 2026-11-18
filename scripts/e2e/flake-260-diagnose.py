from pathlib import Path
import sys

def replace(file, old, new):
    path = Path(file)
    source = path.read_text()
    assert source.count(old) == 1, (file, old)
    path.write_text(source.replace(old, new))

case = sys.argv[1]
if case in ('desktop-early', 'desktop-ready'):
    replace('scripts/e2e/electron-launcher.cjs',
        "process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='quit')app.quit();});\nimport('../../desktop/dist/main.js').then(({startDesktop})=>startDesktop()).catch(error=>{console.error(error);app.exit(1);});",
        "process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='quit')app.quit();if(data.trim()==='start')import('../../desktop/dist/main.js').then(({startDesktop})=>startDesktop()).catch(error=>{console.error(error);app.exit(1);});});")
    cdp_gate = """  const targets=async()=>{assert.equal(child.exitCode,null,'Electron exited: '+logs);assert.equal(child.signalCode,null,'Electron signalled: '+logs);try{const response=await fetch('http://127.0.0.1:'+port+'/json/list');return response.ok?await response.json():null;}catch{return null;}};
  let before;
  await until(async()=>{before=await targets();return before!==null;});
  assert.deepEqual(before.filter(({type})=>type==='page'||type==='webview'),[],'CDP endpoint is up while the Electron page is held');
  console.log('FLAKE-260 CDP returned HTTP 200 and no page targets before starting the app');
"""
    if case=='desktop-ready':
        cdp_gate += """  child.stdin.write('start\\n');
  await until(async()=>{const pages=await targets();return pages?.some(({type,url})=>type==='page'&&url==='massion://app/');});
  console.log('FLAKE-260 workbench page observed before first CLI command');
"""
    replace('scripts/e2e/desktop.mjs',
        "  await until(async()=>{assert.equal(child.exitCode,null,'Electron exited: '+logs);assert.equal(child.signalCode,null,'Electron signalled: '+logs);try{return (await fetch('http://127.0.0.1:'+port+'/json/list')).ok;}catch{return false;}});",
        cdp_gate.rstrip())
else:
    replace('src/headless-browser.ts',
        " const run=async(args:string[],cancel:AbortSignal|undefined=signal)=>{try{const {stdout}=await exec('agent-browser',",
        " const run=async(args:string[],cancel:AbortSignal|undefined=signal)=>{const started=performance.now(),command=args.find(s=>['open','get','set','close','eval'].includes(s));const action=command==='open'?(args.length===1?'open-blank':'open-origin'):command==='get'?args.at(-1):command;try{const {stdout}=await exec('agent-browser',")
    replace('src/headless-browser.ts',
        "if(!result.success)throw Error();return result.data;}catch{throw Error('Local browser command unavailable');}",
        "if(!result.success)throw Error(result.error);return result.data;}catch(error){const e=error as Error&{code?:number|string,killed?:boolean,signal?:string,stdout?:string};let detail;try{detail=JSON.parse(e.stdout??'').error;}catch{}console.error('FLAKE-260 cli failure',session,action,{ms:Math.round(performance.now()-started),abort:cancel?.aborted,code:e.code,killed:e.killed,signal:e.signal,detail});throw Error('Local browser command unavailable');}finally{if(!['get','eval'].includes(command??'')||performance.now()-started>1500)console.error('FLAKE-260 cli timing',session,action,Math.round(performance.now()-started));}")
    replace('src/headless-browser.ts',
        " catch{await close();throw Error('Local browser startup unavailable');}",
        " catch(error){console.error('FLAKE-260 start failure',session,error instanceof Error?error.message:String(error));await close();throw Error('Local browser startup unavailable');}")
    replace('scripts/e2e/browser-frame.test.mjs',
        "   await browser('open',base);",
        "   console.error('FLAKE-260 frame open',i);await browser('open',base);")
