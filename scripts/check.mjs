import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const directory of ['src','tests','scripts']) for(const name of await readdir(new URL(`../${directory}/`,import.meta.url))) {
 if(!/\.(ts|mjs)$/.test(name))continue;
 const path=new URL(`../${directory}/${name}`,import.meta.url);
 const result=spawnSync(process.execPath,['--check',path.pathname],{encoding:'utf8'});
 if(result.status!==0){process.stderr.write(result.stderr);process.exit(1);}
}
console.log('Runtime syntax checks passed. This is not TypeScript static type checking.');
