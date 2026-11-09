import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const resources=resolve(import.meta.dirname,'../release',process.arch==='x64'?'mac':'mac-'+process.arch,'Massion.app/Contents/Resources');
const result=spawnSync(process.execPath,['--test',resolve(import.meta.dirname,'package.test.ts')],{stdio:'inherit',env:{...process.env,MASSION_PACKAGED_RESOURCES:resources}});
if(result.error)throw result.error;
process.exit(result.status??1);
