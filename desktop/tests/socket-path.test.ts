import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {chmod,mkdir,mkdtemp,lstat,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tempRoot} from '../../tests/support/temp-root.ts';
import {socketPath,ensureSocketDirectory,checkSocketDirectory} from '../socket-path.ts';

const pathCases=JSON.parse(readFileSync(new URL('./fixtures/socket-path-cases.json',import.meta.url),'utf8')) as {
 name:string;home:string;dataDirectory:string;darwin:unknown;linux:unknown
}[];

for(const row of pathCases)test('socket path: '+row.name,()=>{
 assert.ok(process.platform==='darwin'||process.platform==='linux');
 assert.deepEqual(socketPath(row.dataDirectory,row.home),row[process.platform]);
});

for(const [name,setup,reason] of [
 ['0755',async (path:string)=>{await mkdir(path);await chmod(path,0o755);},'socket-directory-mode'],
 ['symlink',async (path:string,home:string)=>{await symlink(home,path);},'socket-directory-not-directory'],
 ['file',async (path:string)=>{await writeFile(path,'keep');},'socket-directory-not-directory'],
] as const)test('socket directory refuses '+name,async t=>{
 const home=await mkdtemp(join(tempRoot(),'socket-home-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const parent=join(home,'.massion'),path=join(parent,'run');
 await mkdir(parent,{mode:0o700});await setup(path,home);
 const before=await lstat(path);
 assert.deepEqual(ensureSocketDirectory(home),{kind:'refused',reason});
 const after=await lstat(path);
 assert.equal(after.ino,before.ino);
 assert.equal(after.mode,before.mode);
});

test('socket directory creates 0700 and accepts existing 0700',async t=>{
 const home=await mkdtemp(join(tempRoot(),'socket-home-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const parent=join(home,'.massion'),path=join(parent,'run');
 assert.deepEqual(ensureSocketDirectory(home),{kind:'ready'});
 assert.equal((await lstat(parent)).mode&0o7777,0o700);
 const created=await lstat(path);
 assert.equal(created.mode&0o7777,0o700);
 assert.deepEqual(ensureSocketDirectory(home),{kind:'ready'});
 assert.equal((await lstat(path)).ino,created.ino);
});

test('socket directory refuses a different owner in the ownership comparison',()=>{
 assert.deepEqual(checkSocketDirectory({isDirectory:()=>true,uid:502,mode:0o700},501),{kind:'refused',reason:'socket-directory-owner'});
});

test('socket directory refuses a symlink or group-writable .massion parent',async t=>{
 const home=await mkdtemp(join(tempRoot(),'socket-home-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const parent=join(home,'.massion');
 await symlink(home,parent);
 assert.deepEqual(ensureSocketDirectory(home),{kind:'refused',reason:'socket-directory-parent-unsafe'});
 await rm(parent);
 await mkdir(parent);await chmod(parent,0o775);
 assert.deepEqual(ensureSocketDirectory(home),{kind:'refused',reason:'socket-directory-parent-unsafe'});
});

test('socket directory refuses a home reached through a symlink',async t=>{
 const home=await mkdtemp(join(tempRoot(),'socket-home-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const linked=join(home,'linked');
 await symlink(home,linked);
 assert.deepEqual(ensureSocketDirectory(linked),{kind:'refused',reason:'socket-directory-parent-unsafe'});
});

test('socket directory refuses a missing home without creating it',async t=>{
 const home=await mkdtemp(join(tempRoot(),'socket-home-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 assert.deepEqual(ensureSocketDirectory(join(home,'missing')),{kind:'refused',reason:'socket-directory-unavailable'});
});
