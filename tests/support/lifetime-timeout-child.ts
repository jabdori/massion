import {spawn} from 'node:child_process';
import {verifyDisposableDatabase} from './owned-process.ts';
await verifyDisposableDatabase();
// Intentionally no cleanup handler: only the owning wrapper's deadline may clean the group.
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
console.log('Owned timeout child: '+JSON.stringify({pid:process.pid,descendant:descendant.pid}));
setInterval(()=>{},1000);
