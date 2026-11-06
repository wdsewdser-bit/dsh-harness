// Fixture for runner-orphans: binds 40290 and stays alive. Nothing stops it on its own.
import net from 'node:net';

const port = Number(process.argv[2] ?? 40290);
const server = net.createServer(socket => socket.destroy());
server.listen(port, '127.0.0.1', () => console.log('listener ready on ' + port));
