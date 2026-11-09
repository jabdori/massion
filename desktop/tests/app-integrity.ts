import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readdir,lstat,readFile,readlink} from 'node:fs/promises';
import {join} from 'node:path';

export async function appIntegrity(directory:string){
 const hash=createHash('sha256');
 async function walk(path:string){
  const file=join(directory,path),info=await lstat(file);
  const kind=info.isSymbolicLink()?'link':info.isDirectory()?'directory':info.isFile()?'file':'unsupported';
  assert.notEqual(kind,'unsupported','Unexpected special file in app bundle');
  const content=kind==='link'?await readlink(file):kind==='file'?createHash('sha256').update(await readFile(file)).digest('hex'):'';
  hash.update(JSON.stringify([path,kind,info.mode,content])+'\n');
  if(kind==='directory')for(const name of (await readdir(file)).sort())await walk(join(path,name));
 }
 await walk('');return hash.digest('hex');
}
