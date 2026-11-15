// Build-time only: stage the pinned official Node and SurrealDB executables for packaging.
// The app never runs this script and, in this slice, never starts what it stages.
import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {chmod,mkdir,open,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {once} from 'node:events';
import {request} from 'node:https';

const directory=import.meta.dirname,cache=join(directory,'.runtime-cache'),stage=join(directory,'.runtime','current');
const table=JSON.parse(await readFile(join(directory,'runtime.json'),'utf8')),key=`${process.platform}-${process.arch}`,pins=table[key];
if(!pins)throw new Error(`No pinned runtime for ${key}: add it to desktop/runtime.json`);

function download(url,destination,redirects=0){
 return new Promise((resolve,reject)=>{
  if(redirects>5)return reject(new Error(`Too many redirects downloading ${url}`));
  const client=request(url,response=>{
   if(response.statusCode>=300&&response.statusCode<400){
    const location=response.headers.location;response.resume();
    if(!location)return reject(new Error(`Redirect without location downloading ${url}`));
    if(!location.startsWith('https://'))return reject(new Error(`Refused non-HTTPS redirect to ${location}`));
    return resolve(download(new URL(location,url).href,destination,redirects+1));
   }
   if(response.statusCode!==200){response.resume();return reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));}
   resolve(pipeline(response,createWriteStream(destination)));
  });
  client.setTimeout(60000,()=>client.destroy(new Error(`Timeout downloading ${url}`)));
  client.on('error',reject);client.end();
 });
}
async function sha256(file){
 const hash=createHash('sha256');
 for await (const chunk of createReadStream(file,{highWaterMark:1<<20}))hash.update(chunk);
 return hash.digest('hex');
}
const clean=value=>value.replace(/\0[\s\S]*$/,'').trim();
function header(block){
 let sum=0;for(let index=0;index<512;index++)sum+=index>=148&&index<156?32:block[index];
 const text=(start,end)=>block.subarray(start,end).toString('utf8');
 if(sum!==(parseInt(clean(text(148,160)),8)||-1))throw new Error('Corrupt tar header checksum');
 const size=parseInt(clean(text(124,136)),8);
 if(!Number.isInteger(size)||size<0)throw new Error('Corrupt tar header size');
 return {name:clean(text(0,100)),size,type:String.fromCharCode(block[156]),prefix:clean(text(345,500))};
}
function paxOverrides(buffer){
 const overrides={};
 for(let text=buffer.toString('utf8');text.length;){
  const length=parseInt(text,10);
  if(!Number.isInteger(length)||length<=0||length>text.length)throw new Error('Corrupt pax header');
  const record=text.slice(text.indexOf(' ')+1,length-1),equals=record.indexOf('=');
  overrides[record.slice(0,equals)]=record.slice(equals+1);
  text=text.slice(length);
 }
 return overrides;
}
async function extractMember(tar,memberName,outputFile){
 const handle=await open(tar,'r'),block=Buffer.alloc(512);let position=0,overrides={};
 try{
  for(;;){
   const {bytesRead}=await handle.read({buffer:block,position});
   if(bytesRead<512||block.every(byte=>byte===0))throw new Error(`${memberName} not found in ${tar}`);
   const entry=header(block);position+=512;
   let name=entry.prefix?entry.prefix+'/'+entry.name:entry.name,size=entry.size;
   if(entry.type==='x'||entry.type==='X'||entry.type==='g'){
    const meta=Buffer.alloc(size);await handle.read({buffer:meta,position});
    if(entry.type!=='g')overrides=paxOverrides(meta);
   }else if(entry.type==='L'){
    const meta=Buffer.alloc(size);await handle.read({buffer:meta,position});
    overrides={path:meta.toString('utf8').replace(/\0[\s\S]*$/,'')};
   }else if(entry.type==='0'||entry.type==='\0'||entry.type==='7'){
    if(overrides.path)name=overrides.path;
    if(overrides.size!==undefined)size=parseInt(overrides.size,10);
    if(name===memberName){
     const output=createWriteStream(outputFile),chunk=Buffer.alloc(1<<20);
     for(let copied=0;copied<size;){
      const {bytesRead:read}=await handle.read({buffer:chunk,length:Math.min(chunk.length,size-copied),position:position+copied});
      if(!read)throw new Error(`Unexpected end of ${tar} while reading ${memberName}`);
      if(!output.write(chunk.subarray(0,read)))await once(output,'drain');
      copied+=read;
     }
     await new Promise((resolve,reject)=>output.end(error=>error?reject(error):resolve()));
     return;
    }
    overrides={};
   }
   position=(position+size+511)&~511;
  }
 }finally{await handle.close();}
}
await rm(stage,{recursive:true,force:true});
await mkdir(stage,{recursive:true});await mkdir(cache,{recursive:true});
const manifest={};
for(const tool of ['node','surreal']){
 const pin=pins[tool],archive=join(cache,pin.sha256),part=archive+'.part';
 let cached=false;
 try{cached=await sha256(archive)===pin.sha256;}catch{}
 if(!cached){
  await download(pin.url,part);
  if(await sha256(part)!==pin.sha256)throw new Error(`SHA-256 mismatch for ${pin.url}: expected ${pin.sha256}`);
  await rename(part,archive);
 }
 const tar=join(cache,`.${tool}.tar`);
 await pipeline(createReadStream(archive),createGunzip(),createWriteStream(tar));
 try{await extractMember(tar,pin.path,join(stage,tool));}
 finally{await rm(tar,{force:true});}
 await chmod(join(stage,tool),0o755);
 manifest[tool]={version:pin.version,sha256:await sha256(join(stage,tool))};
}
await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Staged ${key} runtime: node ${manifest.node.version}, surreal ${manifest.surreal.version}`);
