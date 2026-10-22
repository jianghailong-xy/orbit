// The D4 stack's door for its managed runners: listens on one address only, the gateway of the runners' Docker
// network, and passes each connection to the apiserver on 127.0.0.1. It plays the part of root Compose's gateway
// port, which runners reach at that same gateway address. Test harness only.
//   node forward.mjs LISTEN_HOST LISTEN_PORT TO_HOST TO_PORT
import net from 'node:net';
const [host, port, toHost, toPort] = process.argv.slice(2);
if (!host || !port || !toHost || !toPort) throw new Error('usage: forward.mjs LISTEN_HOST LISTEN_PORT TO_HOST TO_PORT');
const server = net.createServer((client) => {
  const upstream = net.connect(Number(toPort), toHost);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});
server.listen(Number(port), host, () => console.log(`forwarding ${host}:${port} -> ${toHost}:${toPort}`));
