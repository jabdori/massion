import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Script} from 'node:vm';
import {workbenchPage} from '../../src/workbench.ts';

test('desktop build preserves iframe client strings and appends a separate focus bridge',async()=>{
 await promisify(execFile)(process.execPath,['build.mjs'],{cwd:new URL('..',import.meta.url)});
 const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
 const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]!);
 assert.equal(scripts.length,2);
 for(const script of scripts)assert.doesNotThrow(()=>new Script(script),'Bundled renderer scripts must parse');
 const original=[...workbenchPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]!);
 assert.equal(scripts[0],original[0],'Workbench script remains intact, including iframe HTML');
 assert.equal(scripts[1],'\n'+await readFile(new URL('../host-client.js',import.meta.url),'utf8')+'\n');
});
