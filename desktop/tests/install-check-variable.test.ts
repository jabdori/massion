import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';

// The check-only variable must have exactly ONE reader in the product sources.
// This test builds the name from parts so that it never matches itself; the
// workflow and the check driver SET the variable and are not product sources.
const name=['MASSION','INSTALL','CHECK'].join('_');
const root=join(import.meta.dirname,'..','..');
const productRoots=[
 {dir:'src',extensions:['.ts','.tsx','.js','.mjs']},
 {dir:'desktop',extensions:['.ts','.tsx','.js','.mjs','.cjs']},
 {dir:'desktop/tauri/src',extensions:['.rs']},
 {dir:'desktop/tauri/carrier/src',extensions:['.rs']},
];
const excluded=['tests','dist','release','node_modules','.runtime','.runtime-cache','smoke-artifacts','fixtures','target','gen'];

async function walk(dir: string,extensions: string[]):Promise<string[]>{
 const entries=await readdir(dir,{withFileTypes:true}).catch(()=>[]);
 const files:string[]=[];
 for(const entry of entries){
  if(entry.isDirectory()&&excluded.includes(entry.name))continue;
  const path=join(dir,entry.name);
  if(entry.isDirectory())files.push(...await walk(path,extensions));
  else if(extensions.some(extension=>entry.name.endsWith(extension)))files.push(path);
 }
 return files;
}

test('the check-only variable is read in exactly one place',async()=>{
 const occurrences:{file:string;count:number}[]=[];
 for(const {dir,extensions} of productRoots){
  for(const file of await walk(join(root,dir),extensions)){
   const text=await readFile(file,'utf8');
   const count=text.split(name).length-1;
   if(count)occurrences.push({file:relative(root,file),count});
  }
 }
 assert.deepEqual(occurrences,[{file:'desktop/tauri/src/lib.rs',count:1}],'the product sources may name the variable only in the one Rust reader');
 const source=await readFile(join(root,'desktop/tauri/src/lib.rs'),'utf8');
 assert.match(source,new RegExp('std::env::var\\(\"'+name+'\"\\)'),'the single occurrence is the environment read itself');
});
