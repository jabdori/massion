// CI only (T2 item 4): inspect the real unpacked archive - exactly the expected
// executables and resources, nothing from the build machine, the reviewed
// capabilities/permissions hashes, and the codesign/spctl/quarantine outputs
// recorded as FACTS for an unsigned development build. No way around Gatekeeper
// is put anywhere in the product; facts live in the evidence directory only.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {existsSync} from 'node:fs';
import {mkdir,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {homedir} from 'node:os';
import {control} from '../daemon.ts';
import {packageEntries} from '../tauri/stage-package.mjs';

const root=resolve(import.meta.dirname,'..','..');
const archive=process.env.MASSION_TAURI_ARCHIVE,out=process.env.MASSION_TAURI_OUT;
if(!archive||!out)throw new Error('Set MASSION_TAURI_ARCHIVE and MASSION_TAURI_OUT');
await mkdir(out,{recursive:true});
// Every fact-collecting subprocess is bounded: a command that hits the limit is
// recorded as the fact "did not return within 30 s" with whatever it printed,
// and the job goes on. Which command blocks IS the fact the lead needs (what a
// person meets who downloads this unsigned build and double-clicks it).
const FACT_TIMEOUT_MS=30000;
const run=(file,args,options={})=>{
 const result=spawnSync(file,args,{encoding:'utf8',timeout:FACT_TIMEOUT_MS,...options});
 const timedOut=result.error?.code==='ETIMEDOUT';
 return {command:[file,...args].join(' '),timedOut,exitCode:result.status,stdout:result.stdout??'',stderr:result.stderr??'',...(timedOut?{note:'did not return within 30 s'}:{})};
};
// Only /tmp, /var and /etc are symlinked into /private on macOS; /Users is a
// real directory and /private/Users does not exist.
const privatePath=path=>path.replace(/^\/(tmp|var|etc)(\/|$)/,'/private/$1$2');
const sha256=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const facts={};

// The quarantine attribute is set on the ARCHIVE before unpacking, as the
// owner's downloaded archive would carry it.
facts.quarantineOnArchive=run('xattr',['-w','com.apple.quarantine','0081;5f0deadbeef;GitHub;github.com',privatePath(resolve(archive))]);
await rm(join(out,'unpack'),{recursive:true,force:true});
await mkdir(join(out,'unpack'),{recursive:true});
facts.unpack=run('ditto',['-x','-k',resolve(archive),join(out,'unpack')]);
const app=(await readdir(join(out,'unpack'),{withFileTypes:true})).find(entry=>entry.isDirectory()&&entry.name.endsWith('.app'))?.name;
if(!app)throw new Error('No .app inside the archive');
// Absolute from here on: the facts collectors prefix the path with /private,
// which a workspace-relative path turns into a nonexistent /privatedesktop/...
const appPath=resolve(join(out,'unpack',app));

// 1. Exactly the expected tree: the executable, the two sidecars and the
// runtime manifest beside it, and the staged resource mirror - nothing else.
const actual=[];
async function walk(directory){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isDirectory())await walk(path);else actual.push(relative(appPath,path));
 }
}
await walk(appPath);
const entries=await packageEntries();
const expected=[
 'Contents/Info.plist',
 ...(existsSync(join(appPath,'Contents','PkgInfo'))?['Contents/PkgInfo']:[]),
 'Contents/MacOS/Massion','Contents/MacOS/node','Contents/MacOS/surreal','Contents/MacOS/manifest.json',
 ...(existsSync(join(appPath,'Contents','_CodeSignature','CodeResources'))?['Contents/_CodeSignature/CodeResources']:[]),
 ...entries.map(entry=>'Contents/Resources/'+entry.dest),
];
const missing=expected.filter(path=>!actual.includes(path)),extra=actual.filter(path=>!expected.includes(path));
if(missing.length||extra.length)throw new Error('Unexpected bundle contents. Missing: '+missing.join(', ')+' Extra: '+extra.join(', '));

// Independent of packageEntries (the same list staged the bundle, so a wrongly
// added or dropped entry there would pass above): a hand-written list of the
// top-level things the bundle must and must not contain.
{
 const allowedTop=['MacOS','Resources','Info.plist','PkgInfo','_CodeSignature'];
 for(const entry of await readdir(join(appPath,'Contents'),{withFileTypes:true}))
  assert.ok(allowedTop.includes(entry.name),'Unexpected top-level bundle entry: '+entry.name);
 const macOs=(await readdir(join(appPath,'Contents','MacOS'))).sort();
 assert.deepEqual(macOs,['Massion','manifest.json','node','surreal'],'MacOS holds exactly the host, the runtime manifest and the two runtimes');
 const allowedResources=['desktop','src','docs','package.json'];
 for(const entry of await readdir(join(appPath,'Contents','Resources'),{withFileTypes:true}))
  assert.ok(allowedResources.includes(entry.name),'Unexpected resources root entry: '+entry.name);
 for(const forbidden of ['node_modules','tests','fixtures','.env'])
  assert.ok(!existsSync(join(appPath,'Contents','Resources',forbidden)),'no '+forbidden+' in the bundle resources');
}

// 2. The bundled runtimes are the ones this build staged: each bundled binary
// equals the sha256 fetch-runtime recorded in manifest.json for the EXTRACTED
// binary, and the manifest's versions equal the pinned table (the same shape as
// desktop/tests/package.test.ts). The pinned ARCHIVE hashes are verified by
// fetch-runtime itself right after download and stay untouched there.
const pins=JSON.parse(await readFile(join(root,'desktop','runtime.json'),'utf8'))['darwin-arm64'];
const manifest=JSON.parse(await readFile(join(appPath,'Contents','MacOS','manifest.json'),'utf8'));
for(const tool of ['node','surreal']){
 const file=join(appPath,'Contents','MacOS',tool);
 if(!((await stat(file)).mode&0o111))throw new Error(tool+' is not executable');
 const digest=await sha256(file);
 if(digest!==manifest[tool].sha256)throw new Error(tool+' SHA-256 mismatch against the build manifest: expected '+manifest[tool].sha256+', found '+digest);
 if(manifest[tool].version!==pins[tool].version)throw new Error('The runtime manifest version does not equal the pinned table for '+tool);
}
// The tie of the chain: the manifest consulted above is the one fetch-runtime
// wrote in THIS build and travels inside the bundle, byte-identical to the one
// staged at desktop/.runtime/current - not a file this check writes itself.
const bundledManifest=await readFile(join(appPath,'Contents','MacOS','manifest.json'),'utf8');
if(bundledManifest!==await readFile(join(root,'desktop','.runtime','current','manifest.json'),'utf8'))throw new Error('The bundled manifest is not the one fetch-runtime wrote in this build');

// 3. Nothing from the build machine and no test-only wiring inside any file.
// Build-machine traces, not product strings: src/app-catalog.ts legitimately
// contains GITHUB_APP, so only the runner-specific names are refused.
const forbidden=[process.env.GITHUB_WORKSPACE,'/Users/runner','GITHUB_WORKSPACE','GITHUB_ACTIONS','GITHUB_SHA','GITHUB_REF','GITHUB_REPOSITORY','GITHUB_RUNNER','MASSION_FEED_STATE','webdriver','wdio'].filter(Boolean);
for(const path of actual){
 if(path.split('/').some(segment=>segment==='tests'||segment==='fixtures'||segment==='node_modules'||segment.startsWith('.env')))throw new Error('Unexpected path segment in the bundle: '+path);
 const file=join(appPath,path);
 if((await stat(file)).size>8*1024*1024)continue;
 const text=(await readFile(file)).toString('latin1');
 for(const needle of forbidden)if(text.includes(needle))throw new Error('Build-machine trace '+JSON.stringify(needle)+' occurs in '+path);
}

// 4. The capabilities and permissions files are the reviewed ones.
const reviewed={
 'desktop/tauri/capabilities/main.json':'f9da9b8ee0ca73009d5846d787f0e0a07724a9e6f80fea9ed6ea6bf665c619cc',
 'desktop/tauri/permissions/autogenerated/desktop_events_close.toml':'2ae658a39e0e1dc3a52c039485b251d82682d5c9f999fbe0a440cf87f8afa2da',
 'desktop/tauri/permissions/autogenerated/desktop_events_subscribe.toml':'c5c0cf933f50400fa1fc556b692b4a234234cda9dd0adbfc065d30a7fe6d115c',
 'desktop/tauri/permissions/autogenerated/desktop_ready.toml':'f97cbdc85d02f7c0c7d5f1fe52b8ffb399f5856c29d593c3c2450bed638948a5',
 'desktop/tauri/permissions/autogenerated/desktop_restart.toml':'13a656d3bed62a2927a7a03618314c816299c619bd847805df82541134c272a3',
 'desktop/tauri/permissions/autogenerated/desktop_save_notifications.toml':'87f0b86943b82cef65191aefb5ab4823aa8b0e8cb3bbb9635c19395d9e63ee5d',
 'desktop/tauri/permissions/autogenerated/desktop_settings.toml':'92ee2ceccfa2af6cd5def4067a7e86a5ed7af61ad387f485eaa8359dc8b8dc2d',
};
for(const [file,expectedDigest] of Object.entries(reviewed)){
 const digest=await sha256(join(root,file));
 if(digest!==expectedDigest)throw new Error(file+' changed without review: '+digest);
}

// 5. Record what macOS says about the unsigned development build, as facts.
facts.codesignVerify=run('codesign',['--verify','--deep','--strict',privatePath(appPath)]);
facts.codesignDisplay=run('codesign',['--display','-r=',privatePath(appPath)]);
for(const tool of ['node','surreal','Massion'])facts['codesignDv_'+tool]=run('codesign',['-dv',join(appPath,'Contents','MacOS',tool)]);
facts.spctl=run('spctl',['--assess','--type','execute','-vv',privatePath(appPath)]);
facts.quarantineAfterUnpack=run('xattr',['-p','com.apple.quarantine',privatePath(appPath)]);
if(facts.quarantineAfterUnpack.exitCode!==0)facts.quarantineSetOnApp=run('xattr',['-w','com.apple.quarantine','0081;5f0deadbeef;GitHub;github.com',privatePath(appPath)]);

// The first open with the attribute still on it: exit status and any message,
// as far as a CI runner can show it, bounded like every other fact command.
facts.openWithQuarantine=run('open',[privatePath(appPath)]);
await new Promise(resolve=>setTimeout(resolve,4000));
// Leave nothing behind that the install check could meet: kill the app the
// open launched by its exact process name (SIGTERM), then drain the supervisor
// it may have started under the runner's real home through its control socket
// (bounded by daemon.ts' 60 s control timeout). The install check itself uses
// isolated /tmp homes with their own supervisors either way.
facts.cleanupKill=run('pkill',['-x','Massion']);
await new Promise(resolve=>setTimeout(resolve,2000));
await control(join(homedir(),'Library','Application','Support','app.massion.desktop','daemon.sock'),'drain').catch(()=>{});
await writeFile(join(out,'package-facts.json'),JSON.stringify(facts,null,2)+'\n');
console.log('codesign verify:',JSON.stringify({exitCode:facts.codesignVerify.exitCode,stderr:facts.codesignVerify.stderr.trim()}));
console.log('spctl:',JSON.stringify({exitCode:facts.spctl.exitCode,stdout:facts.spctl.stdout.trim(),stderr:facts.spctl.stderr.trim()}));
console.log('codesign -dv node:',JSON.stringify({exitCode:facts.codesignDv_node.exitCode,stderr:facts.codesignDv_node.stderr.split('\n').slice(0,3).join(' | ')}));
console.log('codesign -dv surreal:',JSON.stringify({exitCode:facts.codesignDv_surreal.exitCode,stderr:facts.codesignDv_surreal.stderr.split('\n').slice(0,3).join(' | ')}));
console.log('codesign -dv Massion:',JSON.stringify({exitCode:facts.codesignDv_Massion.exitCode,stderr:facts.codesignDv_Massion.stderr.split('\n').slice(0,3).join(' | ')}));
console.log('quarantine after unpack:',JSON.stringify({exitCode:facts.quarantineAfterUnpack.exitCode,stderr:(facts.quarantineAfterUnpack.stderr||'').trim()}));
console.log('open with quarantine:',JSON.stringify(facts.openWithQuarantine));
console.log('Package check passed; facts recorded in '+join(out,'package-facts.json'));
