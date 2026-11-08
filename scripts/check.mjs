import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {lintCopy} from './ui-contracts/copy-lint.mjs';
async function check(directory){
 for(const entry of await readdir(directory,{withFileTypes:true})) {
  const path=new URL(entry.name,directory);
  if(entry.isDirectory()){await check(new URL(`${entry.name}/`,directory));continue;}
  if(!/\.(ts|mjs)$/.test(entry.name))continue;
  const result=spawnSync(process.execPath,['--check',path.pathname],{encoding:'utf8'});
  if(result.status!==0){process.stderr.write(result.stderr);process.exit(1);}
 }
}
for(const directory of ['src','tests','scripts'])await check(new URL(`../${directory}/`,import.meta.url));
console.log('Runtime syntax checks passed. This is not TypeScript static type checking.');
const copy=await lintCopy();
for(const item of copy.findings)console.log(`${item.file}:${item.line}:${item.column}: ${item.reason}: ${JSON.stringify(item.text)}`);
console.log(`Copy lint: ${copy.findings.length} findings in ${copy.files.length} files (report-only).`);
for(const limit of copy.limits)console.log(`Copy lint limit: ${limit}`);
