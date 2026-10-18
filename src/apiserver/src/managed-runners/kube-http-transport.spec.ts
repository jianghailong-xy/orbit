import assert from 'node:assert/strict';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';

import { KubeAmbiguousError, KubeUnreachableError } from './kube-client';
import { httpsTransport, type KubeTls, type KubeTransportRequest } from './kube-http-client';

// The real HTTPS transport against servers on 127.0.0.1, for the one thing the scripted transport of
// kube-http-client.spec.ts cannot show: whether a failed request ever reached the API server. Before
// the TLS session is up nothing was sent — KubeUnreachableError, which spends no provisioning attempt;
// after it, a request may have been applied — KubeAmbiguousError, read back before it is retried.
// The TLS servers use a pre-shared key, so no certificate is needed; nothing leaves the loopback
// interface and no cluster is involved.

const KEY = Buffer.from('6f72626974206b756265207472616e73706f727420746573742070736b210a0a', 'hex');
const PSK = {
  pskCallback: () => ({ psk: KEY, identity: 'orbit-transport-test' }),
  ciphers: 'PSK-AES128-GCM-SHA256',
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  checkServerIdentity: () => undefined,
} as unknown as KubeTls;

function request(port: number, timeoutMs = 2_000): KubeTransportRequest {
  return { method: 'GET', url: new URL(`https://127.0.0.1:${port}/api/v1/namespaces/orbit-managed-test/pods/mr-x`), headers: {}, timeoutMs, tls: PSK };
}

async function listening<T extends TcpServer>(server: T): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('secureConnection', (socket: TLSSocket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function pskServer(onRequest: (socket: TLSSocket) => void) {
  return createTlsServer(
    { pskCallback: (_socket, identity) => (identity === 'orbit-transport-test' ? KEY : null), ciphers: 'PSK-AES128-GCM-SHA256', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' },
    (socket) => socket.once('data', () => onRequest(socket)),
  );
}

test('nothing listening: the API server was never reached', async () => {
  const gone = await listening(createTcpServer());
  const { port } = gone;
  await gone.close();
  const error = await httpsTransport.request(request(port)).catch((e: unknown) => e);
  assert.ok(error instanceof KubeUnreachableError, String(error));
  assert.match((error as Error).message, /ECONNREFUSED/);
});

test('a connection reset before the TLS session is up, as a VM\'s port forward does while its guest boots: never reached', async () => {
  const server = await listening(createTcpServer((socket) => socket.destroy()));
  try {
    const error = await httpsTransport.request(request(server.port)).catch((e: unknown) => e);
    assert.ok(error instanceof KubeUnreachableError, String(error));
  } finally {
    await server.close();
  }
});

test('a connection that never gets its TLS session within the deadline: never reached', async () => {
  const server = await listening(createTcpServer(() => undefined));
  try {
    const error = await httpsTransport.request(request(server.port, 300)).catch((e: unknown) => e);
    assert.ok(error instanceof KubeUnreachableError, String(error));
    assert.match((error as Error).message, /timed out/);
  } finally {
    await server.close();
  }
});

test('once the TLS session is up, a request that gets no answer may have been applied: ambiguous, not unreachable', async () => {
  const silent = await listening(pskServer(() => undefined));
  const hangsUp = await listening(pskServer((socket) => socket.destroy()));
  try {
    const timedOut = await httpsTransport.request(request(silent.port, 300)).catch((e: unknown) => e);
    assert.ok(timedOut instanceof KubeAmbiguousError && !(timedOut instanceof KubeUnreachableError), String(timedOut));
    assert.match((timedOut as Error).message, /timed out/);
    const cut = await httpsTransport.request(request(hangsUp.port)).catch((e: unknown) => e);
    assert.ok(cut instanceof KubeAmbiguousError && !(cut instanceof KubeUnreachableError), String(cut));
  } finally {
    await silent.close();
    await hangsUp.close();
  }
});

test('an answer comes back as it was sent', async () => {
  const server = await listening(pskServer((socket) => socket.end('HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: 17\r\nconnection: close\r\n\r\n{"kind":"Status"}')));
  try {
    assert.deepEqual(await httpsTransport.request(request(server.port)), { status: 404, body: '{"kind":"Status"}' });
  } finally {
    await server.close();
  }
});
