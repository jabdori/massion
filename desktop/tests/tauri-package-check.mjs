// CI only (T2 item 4): inspect the real unpacked archive - exactly the expected
// executables and resources, nothing from the build machine, the reviewed
// capabilities/permissions hashes, and the codesign/spctl/quarantine outputs
// recorded as FACTS for an unsigned development build. No way around Gatekeeper
// is put anywhere in the product; facts live in the evidence directory only.
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {existsSync} from 'node:fs';
import {mkdir,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {once} from 'node:events';
import {homedir} from 'node:os';
import {control} from '../daemon.ts';
import {packageEntries} from '../tauri/stage-package.mjs';

const root=resolve(import.meta.dirname,'..','..');
const archive=process.env.MASSION_TAURI_ARCHIVE,out=process.env.MASSION_TAURI_OUT;
if(!archive||!out)throw new Error('Set MASSION_TAURI_ARCHIVE and MASSION_TAURI_OUT');
await mkdir(out,{recursive:true});
const run=(file,args,options={})=>{const result=spawnSync(file,args,{encoding:'utf8',...options});return {command:[file,...args].join(' '),exitCode:result.status,stdout:result.stdout,stderr:result.stderr};};
const privatePath=path=>path.startsWith('/private')?path:'/private'+path;
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
const appPath=join(out,'unpack',app);

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

// 2. The bundled runtimes are the pinned ones (desktop/runtime.json) and the
// sidecars are executable; the manifest beside them names the same versions.
const pins=JSON.parse(await readFile(join(root,'desktop','runtime.json'),'utf8'))['darwin-arm64'];
const manifest=JSON.parse(await readFile(join(appPath,'Contents','MacOS','manifest.json'),'utf8'));
for(const tool of ['node','surreal']){
 const file=join(appPath,'Contents','MacOS',tool);
 if(!((await stat(file)).mode&0o111))throw new Error(tool+' is not executable');
 const digest=await sha256(file);
 if(digest!==pins[tool].sha256)throw new Error(tool+' SHA-256 mismatch: expected '+pins[tool].sha256+', found '+digest);
 if(manifest[tool].sha256!==pins[tool].sha256||manifest[tool].version!==pins[tool].version)throw new Error('The runtime manifest does not match the pinned table for '+tool);
}

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
facts.spctl=run('spctl',['--assess','--type','execute','-vv',privatePath(appPath)]);
facts.quarantineAfterUnpack=run('xattr',['-p','com.apple.quarantine',privatePath(appPath)]);
if(facts.quarantineAfterUnpack.exitCode!==0)facts.quarantineSetOnApp=run('xattr',['-w','com.apple.quarantine','0081;5f0deadbeef;GitHub;github.com',privatePath(appPath)]);

// The first open with the attribute still on it: exit status and any message,
// as far as a CI runner can show it. Whatever started is stopped again.
const openChild=spawn('open',[privatePath(appPath)],{stdio:['ignore','pipe','pipe']});
let openOutput='';
openChild.stdout.on('data',chunk=>openOutput+=chunk);
openChild.stderr.on('data',chunk=>openOutput+=chunk);
const openExit=await Promise.race([once(openChild,'exit').then(([code])=>code),new Promise(resolve=>setTimeout(()=>resolve('timeout'),30000))]);
facts.openWithQuarantine={exit:openExit,output:openOutput.trim()};
await new Promise(resolve=>setTimeout(resolve,4000));
run('pkill',['-x','Massion']);
await new Promise(resolve=>setTimeout(resolve,2000));
await control(join(homedir(),'Library','Application','Support','app.massion.desktop','daemon.sock'),'drain').catch(()=>{});
await writeFile(join(out,'package-facts.json'),JSON.stringify(facts,null,2)+'\n');
console.log('Package check passed; facts recorded in '+join(out,'package-facts.json'));
