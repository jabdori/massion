/** Explicit local relocation read binding; never imports a journal or initializes artifacts. */
import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isUtf8} from 'node:buffer';
import {dirname,resolve} from 'node:path';
import {canonical} from './domain.ts';
import {BACKUP_LIMITS,parsePortableBackup,openRestoredArtifacts} from './portable-backup.ts';
import type {ArtifactReader} from './record-artifact.ts';
export interface RestoredArtifactSelection {bundlePath:string;artifactRoot:string}
export function validateRestoredSelection(s:RestoredArtifactSelection):void {
 for(const path of [s.bundlePath,s.artifactRoot])if(typeof path!=='string'||path.length>4096||!path||/[\u0000-\u001f\u007f\\]/.test(path)||resolve(path)!==path)throw Error('Restored read binding requires absolute canonical local paths');
}
export async function loadRestoredArtifactReader(selection:RestoredArtifactSelection,current:ArtifactReader):Promise<ArtifactReader>{
 const s=structuredClone(selection);validateRestoredSelection(s);if(await realpath(dirname(s.bundlePath))!==dirname(s.bundlePath))throw Error('Restored bundle parent must not contain symlinks');const file=await open(s.bundlePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let serialized:string;
 try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>BACKUP_LIMITS.bundleBytes)throw Error('Restored bundle must be a bounded regular singly-linked file');const bytes=Buffer.alloc(stat.size+1);let n=0;while(n<bytes.length){const r=await file.read(bytes,n,bytes.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}const after=await file.stat();if(n!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||!isUtf8(bytes.subarray(0,n)))throw Error('Restored bundle changed or contains invalid UTF-8');serialized=bytes.subarray(0,n).toString('utf8');}finally{await file.close();}
 const backup=parsePortableBackup(serialized),relocated=openRestoredArtifacts(serialized,s.artifactRoot),descriptors=new Set(backup.artifacts.map(a=>canonical(a)));
 // Validate every referenced physical file before opening normal service. No fallback on listed evidence failure.
 await relocated.verifyReadRoot();
 for(const artifact of backup.artifacts)await relocated.read(artifact);
 return {read:artifact=>descriptors.has(canonical(artifact))?relocated.read(artifact):current.read(artifact)};
}
