import {once} from 'node:events';
import {connect,createServer} from 'node:net';
import {pathToFileURL} from 'node:url';

const [runner,socket,fixture]=process.argv.slice(2);
const coreSocket='core.sock';

// Keep the OS-assigned port open while the supervisor starts its fixture core.
const listener=createServer(client=>{
 const core=connect(coreSocket);
 client.on('error',()=>core.destroy());
 core.on('error',()=>client.destroy());
 client.on('close',()=>core.destroy());
 core.on('close',()=>client.destroy());
 client.pipe(core).pipe(client);
});
listener.listen(0,'127.0.0.1');
await once(listener,'listening');
process.env.MASSION_FEED_SOCKET=coreSocket;
process.argv.splice(1,process.argv.length,runner,socket,fixture,`http://127.0.0.1:${listener.address().port}`);
await import(pathToFileURL(runner).href);
