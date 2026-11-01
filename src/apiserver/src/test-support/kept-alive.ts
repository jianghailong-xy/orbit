import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import path from 'node:path';

/**
 * For the specs of how long an apiserver holds an idle connection (common/idle-connections.ts): how long each caller
 * keeps one, and a connection that is kept alive and never replaced.
 */

// `build/test-support` → the package, and the repo above it.
const REPO = path.resolve(__dirname, '../../../..');

/**
 * How long each caller of an apiserver keeps an idle connection to it, in milliseconds.
 *
 * The web gateway's nginx: the upstream `keepalive_timeout` default, 60 s. Since nginx 1.29.7 it keeps connections to
 * upstreams alive with no `keepalive` directive, and gateway/nginx.conf proxies to one apiserver without an `upstream`
 * block, so nothing sets another value. The link gateway: its backends' IdleConnTimeout, read from its source.
 */
export function callersIdleTimeoutsMs(): Record<string, number> {
  const source = readFileSync(path.join(REPO, 'src/link-gateway/backend.go'), 'utf8');
  const set = [...source.matchAll(/IdleConnTimeout:\s*(\d+)\s*\*\s*time\.Second\b/g)];
  assert.equal(set.length, 1, "backend.go sets its backends' IdleConnTimeout once, as N * time.Second: read it as it is written now");
  return { "the web gateway's nginx": 60_000, 'the link gateway': Number(set[0][1]) * 1_000 };
}

/** An answer read off a kept-alive connection. Header names are in lower case. */
export interface KeptAliveAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * One HTTP/1.1 connection, kept alive, that sends its requests one at a time and never opens another. An http.Agent
 * would quietly open a new connection in place of one the server closed, which is the very thing these specs look
 * for. Once this one is gone, waiting for an answer rejects and says how: closed by the server, or reset, and how long
 * after its last answer.
 */
export class KeptAliveConnection {
  private received = Buffer.alloc(0);
  private lastAnswerAt = Date.now();
  private goneHow: string | null = null;
  private wake: () => void = () => undefined;

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.received = Buffer.concat([this.received, chunk]);
      this.wake();
    });
    socket.on('error', (error: NodeJS.ErrnoException) => this.ended(`reset (${error.code ?? error.message})`));
    socket.on('end', () => this.ended('closed by the server'));
    socket.on('close', () => this.ended('closed'));
  }

  static open(port: number, host = '127.0.0.1'): Promise<KeptAliveConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, host);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new KeptAliveConnection(socket));
      });
    });
  }

  /** How the connection ended, or null while it is open. */
  get gone(): string | null {
    return this.goneHow;
  }

  /** Sends one whole request on this connection and reads its answer. */
  async request(method: string, route: string, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<KeptAliveAnswer> {
    const head = [`${method} ${route} HTTP/1.1`, 'Host: 127.0.0.1', ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)];
    this.send(`${head.join('\r\n')}\r\n\r\n`);
    return this.answer(timeoutMs);
  }

  /** Sends bytes as they are: part of a request, say. */
  send(bytes: string): void {
    if (this.goneHow) throw new Error(`the connection was gone before the request was sent: ${this.goneHow}`);
    this.socket.write(bytes);
  }

  /** The next answer on this connection. */
  async answer(timeoutMs = 30_000): Promise<KeptAliveAnswer> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const answer = this.take();
      if (answer) return answer;
      if (this.goneHow) throw new Error(`the connection was gone before the answer came: ${this.goneHow}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no answer within ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  close(): void {
    this.socket.destroy();
  }

  private ended(how: string): void {
    this.goneHow ??= `${how}, ${Date.now() - this.lastAnswerAt} ms after its last answer`;
    this.wake();
  }

  /** The first whole answer received, taken off what has arrived; null while part of it is still to come. */
  private take(): KeptAliveAnswer | null {
    const headEnd = this.received.indexOf('\r\n\r\n');
    if (headEnd < 0) return null;
    const [statusLine, ...lines] = this.received.subarray(0, headEnd).toString('latin1').split('\r\n');
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colon = line.indexOf(':');
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    assert.notEqual(headers['transfer-encoding'], 'chunked', `a chunked answer, which this does not read: ${statusLine}`);
    let end = this.received.length;
    if (headers['content-length'] !== undefined) {
      end = headEnd + 4 + Number(headers['content-length']);
      if (this.received.length < end) return null;
    } else if (!this.goneHow) {
      // No Content-Length: the body ends with the connection, as a 408's does.
      return null;
    }
    const body = this.received.subarray(headEnd + 4, end).toString('utf8');
    this.received = this.received.subarray(end);
    this.lastAnswerAt = Date.now();
    return { status: Number(statusLine.split(' ')[1]), headers, body };
  }
}
