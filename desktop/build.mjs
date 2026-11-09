import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {join} from 'node:path';
import {workbenchPage} from '../src/workbench.ts';
import {channels} from './security.ts';

const directory=import.meta.dirname,out=join(directory,'dist');
await mkdir(join(out,'core'),{recursive:true});
for(const name of ['main','security','transport','notifications','daemon','auth']){
 const source=await readFile(join(directory,name+'.ts'),'utf8');
 await writeFile(join(out,name+'.js'),stripTypeScriptTypes(source).replaceAll('../src/','./core/').replaceAll(".ts'",".js'"));
}
for(const name of ['client-protocol','protocol','daemon-auth']){
 const source=await readFile(join(directory,'../src',name+'.ts'),'utf8');
 await writeFile(join(out,'core',name+'.js'),stripTypeScriptTypes(source).replaceAll(".ts'",".js'"));
}
for(const name of ['launcher.cjs','daemon-runner.mjs'])await copyFile(join(directory,name),join(out,name));
await writeFile(join(out,'preload.cjs'),(await readFile(join(directory,'preload.cjs'),'utf8')).replace('__DESKTOP_CHANNELS__',JSON.stringify(channels)));
const bridge=await readFile(join(directory,'host-client.js'),'utf8');
await writeFile(join(out,'index.html'),workbenchPage.replace(/<\/body>\s*<\/html>\s*$/,()=>`<script>\n${bridge}\n</script>\n</body>\n</html>`));
