// A minimal supervisor for the detached-start test: listens on the socket it
// is given, answers the one-shot status command, and removes the socket on
// SIGTERM. It never touches the core or any credential.
import {createServer} from 'node:net';
import {unlink} from 'node:fs/promises';

const socket = process.argv[2];
if (!socket) process.exit(2);
const server = createServer(client => {
  let message = '';
  client.on('error', () => {});
  client.on('data', chunk => { message += chunk; });
  client.on('end', () => {
    client.end(message === 'status\n' ? JSON.stringify({status:'running', pid:process.pid, origin:'http://127.0.0.1:8765'}) : '{}');
  });
});
server.listen(socket, () => process.stdout.write('listening'));
process.on('SIGTERM', () => { server.close(); unlink(socket).catch(() => {}); setTimeout(() => process.exit(0), 50); });
setInterval(() => {}, 1000);
