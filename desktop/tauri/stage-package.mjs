// Build-time only (CI): stage everything the packaged app runs into
// desktop/tauri/package/ and the two sidecar executables into
// desktop/tauri/binaries/ for "tauri build". The staged tree mirrors the
// repository layout so the supervisor's relative imports (../src, ./dist,
// ../package.json) resolve unchanged inside Resources/.
import {execFileSync} from 'node:child_process';
import {chmod,copyFile,mkdir,opendir,readFile,rm,stat} from 'node:fs/promises';
import {dirname,join,relative,matchesGlob} from 'node:path';
import {fileURLToPath} from 'node:url';

const tauriDirectory=import.meta.dirname,desktopDirectory=dirname(tauriDirectory),root=dirname(desktopDirectory);
const sidecarFiles=['daemon-runner.mjs','daemon-keeper.mjs','process-probe.ts','start-decision.ts','client-relay.ts','security.ts','transport.ts','auth.ts','lifecycle.ts','notifications.ts','install-check.ts'];

async function srcFiles(){
 const files=[];
 async function walk(directory){
  for await(const entry of await opendir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name);
   if(entry.isDirectory())await walk(path);
   else if(matchesGlob(relative(join(root,'src'),path),'**/*.ts')||relative(join(root,'src'),path)==='app-runner.mjs')files.push(relative(join(root,'src'),path));
  }
 }
 await walk(join(root,'src'));
 return files;
}

/** The complete package input list (repository-relative), shared with the
 * package check so the bundle is verified against exactly what was staged. */
export async function packageEntries(){
 const entries=[
  ...sidecarFiles.map(name=>({src:join('desktop',name),dest:join('desktop',name)})),
  {src:join('desktop','dist','index.html'),dest:join('desktop','dist','index.html')},
  {src:'package.json',dest:'package.json'},
  {src:join('docs','product','screens','copy.ko.json'),dest:join('docs','product','screens','copy.ko.json')},
 ];
 for(const file of await srcFiles())entries.push({src:join('src',file),dest:join('src',file)});
 return entries;
}

async function main(){
 const exists=async path=>{try{await stat(path);return true;}catch{return false;}};
 if(!await exists(join(desktopDirectory,'dist','index.html')))throw new Error('Build desktop/dist/index.html first (npm run build --prefix desktop)');
 const runtime=join(desktopDirectory,'.runtime','current');
 for(const name of ['node','surreal','manifest.json'])if(!await exists(join(runtime,name)))throw new Error('Stage the runtime first (npm run fetch-runtime --prefix desktop); missing '+name);

 const triple=execFileSync('rustc',['-vV'],{encoding:'utf8'}).match(/^host:\s*(\S+)/m)?.[1];
 if(!triple)throw new Error('Could not read the host target triple from rustc');

 const packageDirectory=join(tauriDirectory,'package'),binaries=join(tauriDirectory,'binaries');
 await rm(packageDirectory,{recursive:true,force:true});
 await rm(binaries,{recursive:true,force:true});
 const entries=await packageEntries();
 for(const entry of entries){
  const destination=join(packageDirectory,entry.dest);
  await mkdir(dirname(destination),{recursive:true});
  await copyFile(join(root,entry.src),destination);
 }
 await mkdir(binaries,{recursive:true});
 for(const tool of ['node','surreal']){
  await copyFile(join(runtime,tool),join(binaries,tool+'-'+triple));
  await chmod(join(binaries,tool+'-'+triple),0o755);
 }
 console.log('Staged '+entries.length+' package files and the node/surreal sidecars for '+triple);
}
if(process.argv[1]===fileURLToPath(import.meta.url))await main();
