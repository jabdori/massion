// CI only (T2 item 8): measure the Tauri archive and unpacked app beside the
// Electron app in the same job, with the share of Node, SurrealDB, the Rust
// host and the resources. Kilobytes on disk (du), the same measure for both.
import {spawnSync} from 'node:child_process';
import {mkdir,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const out=process.env.MASSION_SIZES_OUT;
const tauriApp=process.env.MASSION_TAURI_APP,tauriArchive=process.env.MASSION_TAURI_ARCHIVE,electronApp=process.env.MASSION_ELECTRON_APP;
if(!out||!tauriApp||!tauriArchive||!electronApp)throw new Error('Set MASSION_SIZES_OUT, MASSION_TAURI_APP, MASSION_TAURI_ARCHIVE and MASSION_ELECTRON_APP');
await mkdir(out,{recursive:true});
const du=async path=>Number(spawnSync('du',['-sk',path],{encoding:'utf8'}).stdout.split('\t')[0]);
const size=async path=>(await stat(path)).size;
const kilobytes=bytes=>Math.round(bytes/1024);

const rows=[];
const measure=async(label,path,kind)=>rows.push({label,kind,kb:await (kind==='file'?size(path).then(kilobytes):du(path))});
await measure('Tauri archive (zip)',tauriArchive,'file');
await measure('Tauri app (unpacked)',tauriApp,'dir');
await measure('Tauri Node',join(tauriApp,'Contents','MacOS','node'),'file');
await measure('Tauri SurrealDB',join(tauriApp,'Contents','MacOS','surreal'),'file');
await measure('Tauri Rust host (Massion executable)',join(tauriApp,'Contents','MacOS','Massion'),'file');
await measure('Tauri resources',join(tauriApp,'Contents','Resources'),'dir');
await measure('Electron app (unpacked)',electronApp,'dir');
await measure('Electron Node',join(electronApp,'Contents','Resources','runtime','node'),'file');
await measure('Electron SurrealDB',join(electronApp,'Contents','Resources','runtime','surreal'),'file');
const electronResources=await du(join(electronApp,'Contents','Resources'));
const electronRuntime=await size(join(electronApp,'Contents','Resources','runtime','node')).then(kilobytes)+await size(join(electronApp,'Contents','Resources','runtime','surreal')).then(kilobytes);
rows.push({label:'Electron resources (without runtime)',kind:'dir',kb:Math.max(0,electronResources-electronRuntime)});
rows.push({label:'Electron host (MacOS + Frameworks)',kind:'dir',kb:await du(join(electronApp,'Contents','MacOS'))+await du(join(electronApp,'Contents','Frameworks'))});

const table=['| what | kilobytes on disk |','| --- | --- |',...rows.map(row=>'| '+row.label+' | '+row.kb+' |')].join('\n');
await writeFile(join(out,'sizes.md'),table+'\n');
await writeFile(join(out,'sizes.json'),JSON.stringify(rows,null,2)+'\n');
console.log(table);
