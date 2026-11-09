import {startFixtureHost} from '../../scripts/ui-contracts/fixture-host.ts';
import {inheritedDaemonSecret} from '../../src/daemon-auth.ts';

const daemonSecret=inheritedDaemonSecret();
if(!daemonSecret)throw new Error('Fixture daemon requires supervisor authentication');
const server=await startFixtureHost('B7-unknown',{daemonSecret,port:Number(process.env.MASSION_PORT)});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void server.close().then(()=>process.exit(0)));
