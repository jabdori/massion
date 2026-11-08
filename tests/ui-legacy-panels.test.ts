import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('legacy panels contain no unkeyed visible copy or invalid copy placeholders',()=>{
 const result=spawnSync(process.execPath,[new URL('../scripts/ui-contracts/copy-lint.mjs',import.meta.url).pathname],{encoding:'utf8'});
 assert.ok(result.stdout,result.stderr);
 const report=JSON.parse(result.stdout),modern=new Set(['apps-panel.ts','members-panel.ts','results-panel.ts','schedules-panel.ts','settings-panel.ts','assistant-conversation-panel.ts','surface-shell.ts','workbench.ts']);
 const findings=report.findings.filter((item:{file:string})=>!modern.has(item.file.split('/').at(-1)!));
 assert.deepEqual(findings,[]);
});
