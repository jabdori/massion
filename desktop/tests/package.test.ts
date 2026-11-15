import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {readFile,mkdtemp,cp,rm,mkdir,stat,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,relative,matchesGlob} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {daemonFiles} from '../daemon.ts';

test('packaged daemon resources are usable by external Node at their resolved paths',async t=>{
 const root=process.env.MASSION_PACKAGED_RESOURCES??await mkdtemp(join(tmpdir(),'e4-package-'));
 if(!process.env.MASSION_PACKAGED_RESOURCES)t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=resolve(import.meta.dirname,'..'),manifest=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
 if(!process.env.MASSION_PACKAGED_RESOURCES)for(const resource of manifest.build.extraResources){
  const source=resolve(directory,resource.from);
  try{await access(source);}catch{continue;} // runtime staging exists only after fetch-runtime.mjs
  const destination=join(root,resource.to);await mkdir(dirname(destination),{recursive:true});
  await cp(source,destination,{recursive:true,filter:async path=>(await stat(path)).isDirectory()||!resource.filter||resource.filter.some((pattern:string)=>matchesGlob(relative(source,path),pattern))});
 }
 const paths=daemonFiles(true,root,join(root,'app.asar/dist'));
 if(process.env.MASSION_PACKAGED_RESOURCES)await t.test('bundled desktop and core versions match the source candidate',async()=>{
  const require=createRequire(import.meta.url),{extractFile}=require('@electron/asar');
  const source=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
  const bundled=JSON.parse(extractFile(join(root,'app.asar'),'package.json').toString());
  const core=JSON.parse(await readFile(join(root,'core/package.json'),'utf8'));
  assert.equal(bundled.version,source.version);assert.equal(core.version,source.version);
  for(const key of ['CFBundleShortVersionString','CFBundleVersion']){
   const result=await promisify(execFile)('/usr/libexec/PlistBuddy',['-c','Print '+key,join(root,'../Info.plist')]);
   assert.equal(result.stdout.trim(),source.version.split('-')[0],key+' must use the numeric macOS version');
  }
 });
 if(process.env.MASSION_PACKAGED_RESOURCES||existsSync(join(root,'runtime')))await t.test('bundled runtime executables match the pinned table and manifest',async()=>{
  const pinned=JSON.parse(await readFile(join(directory,'runtime.json'),'utf8'))[`${process.platform}-${process.arch}`];
  const runtime=JSON.parse(await readFile(join(root,'runtime','manifest.json'),'utf8'));
  for(const tool of ['node','surreal']){
   const file=join(root,'runtime',tool);
   assert.ok((await stat(file)).mode&0o111,`runtime/${tool} must be executable`);
   const hash=createHash('sha256');for await (const chunk of createReadStream(file))hash.update(chunk);
   assert.equal(hash.digest('hex'),runtime[tool].sha256,`runtime/${tool} SHA-256 must equal the manifest`);
   assert.equal(runtime[tool].version,pinned[tool].version,`runtime/${tool} version must equal the pinned table`);
  }
 });
 await t.test('standalone daemon runner is outside ASAR and readable by Node',async()=>{
  await access(paths.runner);assert.ok(!relative(root,paths.runner).split('/').includes('app.asar'));
  await promisify(execFile)(process.execPath,['--check',paths.runner]);
 });
 await t.test('core imports and the app handler runner survives the package filter',async()=>{
  const core=await import(pathToFileURL(paths.entry).href);assert.equal(typeof core.createWorkbench,'function');
  const runner=new URL('./app-runner.mjs',pathToFileURL(paths.entry));await access(runner);
  await promisify(execFile)(process.execPath,['--check',fileURLToPath(runner)]);
 });
});
