import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// The production apiserver, for the personal access token pg specs: `node build/main.js` as the
// container starts it — the whole AppModule, JwtAuthGuard and every pipe in front of a route — on a
// port of its own, and one HTTP request at a time against it. Shared by
// `personal-access-token.pg.spec.ts` (10) and `pat-owner-channel.pg.spec.ts`.

/** build/auth → build/main.js, the apiserver's production entry point. */
const MAIN = path.resolve(__dirname, '..', 'main.js');
const API_DIR = path.resolve(__dirname, '..', '..');

export interface Apiserver {
  port: number;
  child: ChildProcess;
  output(): string;
  stop(): Promise<void>;
}

export interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  text: string;
  headers: http.IncomingHttpHeaders;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * One request on a connection of its own. A 200 from a stream is answered as soon as its headers
 * arrive, and the stream is closed. `headers` go out beside the bearer's.
 */
export function call(
  server: Apiserver,
  method: string,
  route: string,
  bearer?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: route,
        method,
        agent: false,
        headers: {
          ...headers,
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        res.on('error', () => undefined);
        if (res.statusCode === 200 && String(res.headers['content-type']).startsWith('text/event-stream')) {
          resolve({ status: 200, json: null, text: '', headers: res.headers });
          req.destroy();
          return;
        }
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${route} timed out`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * `node build/main.js`, as the container starts it, on a port of its own; resolves once it answers.
 * `env` is laid over the environment the server would otherwise get.
 */
export async function startApiserver(databaseUrl: string, jwtSecret: string, env: NodeJS.ProcessEnv = {}): Promise<Apiserver> {
  const port = await freePort();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    PORT: String(port),
    NO_COLOR: '1',
    CORS_ORIGINS: 'http://127.0.0.1',
    ...env,
  };
  delete childEnv.NODE_TEST_CONTEXT;
  let log = '';
  const child = spawn(process.execPath, [MAIN], { cwd: API_DIR, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (chunk: Buffer) => {
    log = (log + chunk.toString('utf8')).slice(-400_000);
  };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const server: Apiserver = {
    port,
    child,
    output: () => log,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(20_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`the apiserver exited ${child.exitCode} before answering:\n${log.slice(-6_000)}`);
    const reply = await call(server, 'GET', '/api/auth/setup-status').catch(() => null);
    if (reply?.status === 200) return server;
    if (Date.now() > deadline) assert.fail(`the apiserver did not answer within 150s:\n${log.slice(-6_000)}`);
    await sleep(250);
  }
}
