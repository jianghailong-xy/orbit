import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import { Subject } from 'rxjs';

import { AuthModule } from '../auth/auth.module';
import { DisabledAccounts } from '../auth/disabled-accounts';
import { PAT_PREFIX } from '../auth/pat.service';
import { TERMINAL_PREFIX } from '../auth/terminal-credentials';
import { untilStopping } from '../common/graceful-stop';
import { PrismaService } from '../prisma/prisma.service';
import { RunnerHints, runnerHintSubject, type StreamBus } from '../realtime/runner-hints';
import {
  STREAM_CLOSE,
  decodeStreamFrame,
  decodeStreamOpenAnswer,
  encodeStreamClose,
  encodeStreamCredit,
  encodeStreamData,
  encodeStreamPaste,
  streamOpenMessage,
} from './browser-stream-frames';
import { BROWSER_STREAMS_PER_RUNNER, BrowserStreamSlots, type BrowserStreamSlot } from './browser-stream-slots';
import { MANAGED_RUNNER_BROWSER_GATE, type ManagedRunnerBrowserGate } from './managed-runner-browser-gate';

/**
 * The managed runner browser's viewer (docs/runner-browser-design.md §4, §6; P4 = the runner's owner only): a WebSocket
 * on `GET /api/runners/:id/browser/vnc` that carries the raw RFB of the runner's x11vnc, both ways, for noVNC.
 *
 *   - Behind the browser switch. Off, nothing listens for an upgrade at all, and the route answers 404 as any path
 *     the apiserver does not have.
 *   - The owner's web login only, as `?access_token=` (a browser's WebSocket cannot set a header, as an EventSource
 *     cannot): a personal access token, a terminal credential, an administrator's view of another account, or a
 *     disabled account is 401.
 *   - Only the caller's own managed runner: any other runner, another account's or a self-managed one, is 404, which
 *     says nothing of whether it exists. A session's guests are not its runner's owner, and are refused the same way.
 *   - At most BROWSER_STREAMS_PER_RUNNER streams per runner across every apiserver process (browser-stream-slots.ts):
 *     a third is 429, before the runner is asked anything.
 *   - The stream is opened over NATS (browser-stream-frames.ts): a StreamOpen request on rnr.<runnerId>, which the link
 *     gateway holding the runner's connection relays. The runner starts the browser if it is not running. Refused,
 *     it is answered before the upgrade: 503 when the runner or its browser is not there, 429 when the runner already
 *     has its two streams, 504 when it did not answer in time, 403 when it will not open one.
 *   - Opened, the WebSocket is accepted and its binary messages are piped to vnc.<streamId>.down as StreamData, and
 *     the runner's StreamData on vnc.<streamId>.up to the WebSocket. Each direction keeps the stream's window: this
 *     side sends at most STREAM_WINDOW past what the runner credited back, pausing the WebSocket meanwhile, and credits
 *     the runner's bytes back once the WebSocket has taken them.
 *   - Paste (§5; the owner's choice, 2026-11-19): besides RFB's binary messages, a viewer sends text messages of JSON.
 *     `{"type":"control","on":bool}` says whether it is in control (it starts not), and `{"type":"paste","id":n,
 *     "text":…}` is a paste. A paste is sent to the runner as a StreamPaste only while the viewer is in control, at
 *     most MAX_PASTE_BYTES of UTF-8 and one at a time; the runner inserts it with Chrome DevTools. Each is answered
 *     with a text message `{"type":"pasted","id":n,"error"?:…}`. The text is often a password: it is never logged.
 *   - Closing either side closes the other: a viewer that leaves sends StreamClose NORMAL; the runner's StreamClose
 *     closes the WebSocket (1000 for NORMAL, 1011 with the reason otherwise). A stopping apiserver ends its streams
 *     with 1012, so the viewer can open the stream again on another one.
 */

const ROUTE = /^\/api\/runners\/([^/]+)\/browser\/vnc\/?$/;
/** Each direction's window, in bytes (src/link-gateway/streams.go, streamWindow). */
const STREAM_WINDOW = 256 << 10;
/** The largest StreamData sent: the gateway writes at most this much to the runner at a time. */
const MAX_STREAM_DATA = 32 << 10;
/** How long the runner has to open the stream: the gateway waits 10 s for it, and the runner may first start Chrome. */
const OPEN_TIMEOUT_MS = 15_000;
/** How often an idle WebSocket is pinged, so that no proxy between it and the viewer takes it for dead. */
const PING_MS = 30_000;
/** The largest message a viewer may send: RFB's own messages are a few bytes, a pasted clipboard more. */
const MAX_VIEWER_MESSAGE = 1 << 20;
/** The largest paste, in bytes of UTF-8 (src/link-gateway/streams.go, maxPasteBytes; runner-go's browserPasteMaxBytes). */
export const MAX_PASTE_BYTES = 64 << 10;
/** How long the runner has to answer a paste: it reads Chrome's targets and inserts the text in at most 10 s. */
const PASTE_TIMEOUT_MS = 15_000;

/** What a viewer is told of a paste it made (English, shown in its bar). */
export const PASTE_REFUSALS = {
  notInControl: 'Take control to paste',
  tooLarge: `The text is too long to paste (more than ${MAX_PASTE_BYTES >> 10} KB)`,
  busy: 'Wait for the last paste to finish',
  noAnswer: 'The runner did not answer the paste',
  lost: 'The paste could not reach the runner',
} as const;

// The `ws` package, as far as this file uses it (it ships no types of its own).
interface WsSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'pong', listener: () => void): this;
  send(data: Uint8Array | string, options: { binary: boolean }, cb?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  pause(): void;
  resume(): void;
  terminate(): void;
}
interface WsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, done: (ws: WsSocket) => void): void;
  close(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebSocketServer } = require('ws') as {
  WebSocketServer: new (options: { noServer: true; maxPayload: number; perMessageDeflate: boolean; clientTracking: boolean }) => WsServer;
};
const WS_OPEN = 1;

/** A refusal answered on the upgrade request, before any WebSocket. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The HTTP answer to an open the runner's side refused, by its StreamCloseCode. */
function refusalOf(code: number, message: string): Refusal {
  const why = message ? `: ${message}` : '';
  switch (code) {
    case STREAM_CLOSE.TOO_MANY_STREAMS:
      return new Refusal(429, `This runner already has ${BROWSER_STREAMS_PER_RUNNER} open browser streams${why}`);
    case STREAM_CLOSE.TIMEOUT:
      return new Refusal(504, `The runner did not open the browser stream in time${why}`);
    case STREAM_CLOSE.REFUSED:
      return new Refusal(403, `The runner refused the browser stream${why}`);
    case STREAM_CLOSE.UNAVAILABLE:
      return new Refusal(503, `The runner's browser is not available${why}`);
    default:
      return new Refusal(503, `The runner is not connected${why}`);
  }
}

/** Answers an upgrade request with an HTTP error and closes its socket. */
function answer(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = JSON.stringify({ statusCode: status, message });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'X-Content-Type-Options: nosniff\r\n' +
      'Cache-Control: no-store\r\n' +
      'Connection: close\r\n\r\n' +
      body,
  );
}

function asBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** One open stream: a viewer's WebSocket and the runner's side, over NATS. */
class ViewerStream {
  private ws: WsSocket | null = null;
  /** The runner's frames that came before the WebSocket was accepted. */
  private early: Uint8Array[] = [];
  /** How many more bytes this side may send the runner. */
  private downRoom = STREAM_WINDOW;
  /** The viewer's bytes waiting for the runner's credit. */
  private waiting: Buffer[] = [];
  private paused = false;
  private ended = false;
  private ping?: ReturnType<typeof setInterval>;
  private alive = true;
  private bytesUp = 0;
  private bytesDown = 0;
  /** Whether the viewer says it is in control: only then does a paste go to the runner. */
  private control = false;
  /** The paste waiting for the runner's answer: the viewer's id for it, this side's id, and its timeout. */
  private pasting: { viewerId: number; pasteId: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private pasteSeq = 0;
  private readonly began = Date.now();
  private readonly stopUp: () => void;

  constructor(
    readonly id: string,
    readonly runnerId: string,
    readonly userId: string,
    private readonly bus: StreamBus,
    private readonly slot: { current: BrowserStreamSlot | null },
    private readonly log: Logger,
    private readonly onEnd: (stream: ViewerStream) => void,
  ) {
    this.stopUp = bus.subscribe(`vnc.${id}.up`, (data) => this.fromRunner(data));
  }

  /** The WebSocket is accepted: what the runner already sent goes to it, and the pipe runs. */
  attach(ws: WsSocket): void {
    if (this.ended) {
      ws.close(1011, 'The browser stream closed');
      return;
    }
    this.ws = ws;
    ws.on('message', (data, isBinary) => (isBinary ? this.fromViewer(asBuffer(data)) : this.fromViewerText(asBuffer(data))));
    ws.on('close', () => this.end('viewer', STREAM_CLOSE.NORMAL, 'The viewer closed the stream'));
    ws.on('error', () => this.end('viewer', STREAM_CLOSE.NORMAL, 'The viewer\'s connection failed'));
    ws.on('pong', () => {
      this.alive = true;
    });
    this.ping = setInterval(() => {
      if (!this.alive) {
        ws.terminate();
        return;
      }
      this.alive = false;
      ws.ping();
    }, PING_MS);
    this.ping.unref?.();
    const early = this.early;
    this.early = [];
    for (const data of early) this.fromRunner(data);
    this.log.log(`browser stream ${this.id} opened: runner ${this.runnerId}, user ${this.userId}`);
  }

  /** Ends the stream, once: `by` says which side ended it, and the other is told. */
  end(by: 'viewer' | 'runner' | 'server', code: number, message: string, wsCode?: number): void {
    if (this.ended) return;
    this.ended = true;
    if (this.ping) clearInterval(this.ping);
    if (this.pasting) clearTimeout(this.pasting.timer);
    this.pasting = null;
    this.stopUp();
    this.slot.current?.release();
    this.slot.current = null;
    if (by !== 'runner') {
      try {
        this.bus.publish(`vnc.${this.id}.down`, encodeStreamClose(this.id, code, message));
      } catch {
        // NATS is down: the gateway ends the stream with the runner's connection, or the runner's own close.
      }
    }
    const ws = this.ws;
    if (ws && ws.readyState === WS_OPEN) {
      const close = wsCode ?? (code === STREAM_CLOSE.NORMAL ? 1000 : 1011);
      ws.close(close, Buffer.from(message).subarray(0, 120).toString('utf8'));
    }
    this.waiting = [];
    this.onEnd(this);
    if (this.ws) {
      this.log.log(
        `browser stream ${this.id} closed by the ${by} after ${Math.round((Date.now() - this.began) / 1000)} s ` +
          `(${this.bytesUp} bytes to the viewer, ${this.bytesDown} to the runner): ${message}`,
      );
    }
  }

  private fromRunner(data: Uint8Array): void {
    if (this.ended) return;
    if (!this.ws) {
      this.early.push(data);
      return;
    }
    const frame = decodeStreamFrame(data);
    if (!frame || frame.streamId !== this.id) return;
    switch (frame.kind) {
      case 'data': {
        const n = frame.data.length;
        this.bytesUp += n;
        this.ws.send(frame.data, { binary: true }, (error) => {
          // Credited once the WebSocket took the bytes, so a viewer that reads slowly slows the runner down.
          if (!error && !this.ended) this.publish(encodeStreamCredit(this.id, n));
        });
        break;
      }
      case 'credit':
        this.downRoom = Math.min(STREAM_WINDOW, this.downRoom + frame.bytes);
        this.flush();
        break;
      case 'close':
        this.end('runner', frame.code, frame.message || 'The runner closed the stream');
        break;
      case 'pasted':
        if (this.pasting && this.pasting.pasteId === frame.pasteId) {
          const { viewerId, timer } = this.pasting;
          clearTimeout(timer);
          this.pasting = null;
          this.answerPaste(viewerId, frame.error || undefined);
        }
        break;
    }
  }

  /** A text message from the viewer: whether it is in control, or a paste. Anything else is ignored. */
  private fromViewerText(data: Buffer): void {
    if (this.ended) return;
    let message: { type?: unknown; on?: unknown; id?: unknown; text?: unknown };
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (message?.type === 'control' && typeof message.on === 'boolean') {
      this.control = message.on;
      return;
    }
    if (message?.type !== 'paste' || typeof message.id !== 'number' || typeof message.text !== 'string') return;
    const viewerId = message.id;
    if (!this.control) return this.answerPaste(viewerId, PASTE_REFUSALS.notInControl);
    if (Buffer.byteLength(message.text, 'utf8') > MAX_PASTE_BYTES) return this.answerPaste(viewerId, PASTE_REFUSALS.tooLarge);
    if (this.pasting) return this.answerPaste(viewerId, PASTE_REFUSALS.busy);
    const pasteId = ++this.pasteSeq;
    try {
      this.bus.publish(`vnc.${this.id}.down`, encodeStreamPaste(this.id, pasteId, message.text));
    } catch {
      return this.answerPaste(viewerId, PASTE_REFUSALS.lost);
    }
    const timer = setTimeout(() => {
      if (this.pasting?.pasteId !== pasteId) return;
      this.pasting = null;
      this.answerPaste(viewerId, PASTE_REFUSALS.noAnswer);
    }, PASTE_TIMEOUT_MS);
    timer.unref?.();
    this.pasting = { viewerId, pasteId, timer };
  }

  private answerPaste(id: number, error?: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    ws.send(JSON.stringify(error ? { type: 'pasted', id, error } : { type: 'pasted', id }), { binary: false });
  }

  private fromViewer(data: Buffer): void {
    if (this.ended) return;
    for (let at = 0; at < data.length; at += MAX_STREAM_DATA) this.waiting.push(data.subarray(at, at + MAX_STREAM_DATA));
    this.flush();
  }

  /** Sends what the window allows, and pauses the WebSocket while the rest waits for the runner's credit. */
  private flush(): void {
    while (this.waiting.length > 0 && !this.ended) {
      const next = this.waiting[0];
      if (next.length > this.downRoom) break;
      this.waiting.shift();
      this.downRoom -= next.length;
      this.bytesDown += next.length;
      this.publish(encodeStreamData(this.id, next));
    }
    const full = this.waiting.length > 0;
    if (full !== this.paused && this.ws) {
      this.paused = full;
      if (full) this.ws.pause();
      else this.ws.resume();
    }
  }

  private publish(frame: Uint8Array): void {
    try {
      this.bus.publish(`vnc.${this.id}.down`, frame);
    } catch {
      this.end('server', STREAM_CLOSE.CONNECTION_LOST, 'The apiserver lost its NATS connection');
    }
  }
}

@Injectable()
export class BrowserViewerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('BrowserViewer');
  private readonly streams = new Set<ViewerStream>();
  private slots: BrowserStreamSlots | null = null;
  private wss: WsServer | null = null;
  private server: Server | null = null;
  private stopping = false;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly hints: RunnerHints,
    private readonly config: ConfigService,
    @Inject(MANAGED_RUNNER_BROWSER_GATE) private readonly gate: ManagedRunnerBrowserGate,
    @Optional() private readonly disabled?: DisabledAccounts,
  ) {}

  onApplicationBootstrap(): void {
    // Off means absent (§2): no upgrade listener, so an upgrade request is an ordinary request, and 404s.
    if (!this.gate.enabled) return;
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server) return;
    this.server = server;
    this.slots = new BrowserStreamSlots(this.config.get<string>('DATABASE_URL'));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_VIEWER_MESSAGE, perMessageDeflate: false, clientTracking: false });
    server.on('upgrade', this.onUpgrade);
    // A stopping apiserver ends its streams with the rest (common/graceful-stop.ts), so the viewer reconnects elsewhere.
    new Subject<void>().pipe(untilStopping()).subscribe({ complete: () => this.endAll('The apiserver is stopping', 1012) });
  }

  async onModuleDestroy(): Promise<void> {
    this.endAll('The apiserver is stopping', 1012);
    this.server?.off('upgrade', this.onUpgrade);
    this.wss?.close();
    await this.slots?.close();
  }

  /** How many streams this process has open, for the specs. */
  openCount(): number {
    return this.streams.size;
  }

  private endAll(message: string, wsCode: number): void {
    this.stopping = true;
    for (const stream of [...this.streams]) stream.end('server', STREAM_CLOSE.NORMAL, message, wsCode);
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url ?? '/', 'http://apiserver');
    const route = ROUTE.exec(url.pathname);
    if (!route) {
      answer(socket, 404, `Cannot upgrade ${url.pathname}`);
      return;
    }
    this.open(req, socket, head, route[1], url).catch((error: unknown) => {
      if (error instanceof Refusal) {
        answer(socket, error.status, error.message);
        return;
      }
      this.log.error(`a browser stream could not be opened: ${(error as Error)?.message ?? error}`);
      answer(socket, 500, 'The browser stream could not be opened');
    });
  };

  private async open(req: IncomingMessage, socket: Duplex, head: Buffer, rawRunnerId: string, url: URL): Promise<void> {
    if (this.stopping) throw new Refusal(503, 'The apiserver is stopping');
    if ((req.method ?? 'GET') !== 'GET') throw new Refusal(405, 'A browser stream is opened with GET');
    const userId = await this.authenticate(url.searchParams.get('access_token'));
    let runnerId: string;
    try {
      runnerId = toUuid(decodeURIComponent(rawRunnerId));
    } catch {
      throw new Refusal(404, 'No managed runner of yours has this id');
    }
    // P4 = A: only the runner's owner, and only for the managed runner (managed_runner's owner is the runner's).
    const managed = await this.prisma.managedRunner.findFirst({ where: { runnerId, ownerId: userId }, select: { id: true } });
    if (!managed) throw new Refusal(404, 'No managed runner of yours has this id');
    const bus = this.hints.streamBus();
    if (!bus) throw new Refusal(503, 'The runner link is not connected');

    const slot: { current: BrowserStreamSlot | null } = { current: null };
    const id = randomUUID();
    let stream: ViewerStream | null = null;
    slot.current = await this.slots!.acquire(runnerId, () =>
      stream?.end('server', STREAM_CLOSE.CONNECTION_LOST, 'The apiserver lost its count of open streams'),
    );
    if (!slot.current) {
      throw new Refusal(429, `This runner already has ${BROWSER_STREAMS_PER_RUNNER} open browser streams`);
    }
    // Subscribed before the open is asked for: the runner's first bytes (RFB's version) follow StreamOpened at once.
    stream = new ViewerStream(id, runnerId, userId, bus, slot, this.log, (s) => this.streams.delete(s));
    this.streams.add(stream);
    const viewerGone = () => stream?.end('viewer', STREAM_CLOSE.NORMAL, 'The viewer left before the stream opened');
    socket.once('close', viewerGone);
    let reply: Uint8Array | null;
    try {
      reply = await bus.request(runnerHintSubject(runnerId), streamOpenMessage(id), OPEN_TIMEOUT_MS);
    } catch {
      reply = null;
    }
    socket.off('close', viewerGone);
    const opened = reply ? decodeStreamOpenAnswer(reply, id) : null;
    if (!opened || !opened.opened) {
      // Refused or never answered: the runner holds nothing, and nothing need be said to it unless it did not answer.
      stream.end(opened ? 'runner' : 'server', STREAM_CLOSE.NORMAL, 'The stream did not open');
      if (!reply) throw new Refusal(503, 'The runner is not connected');
      if (!opened) throw new Refusal(502, 'The runner link answered something else');
      throw refusalOf(opened.code, opened.message);
    }
    if (!socket.writable || this.stopping) {
      stream.end('viewer', STREAM_CLOSE.NORMAL, 'The viewer left before the stream opened');
      socket.destroy();
      return;
    }
    const opening = stream;
    this.wss!.handleUpgrade(req, socket, head, (ws) => opening.attach(ws));
  }

  /** The caller's account, from a web login's access token; a 401 for anything else. */
  private async authenticate(token: string | null): Promise<string> {
    if (!token || token.startsWith(PAT_PREFIX) || token.startsWith(TERMINAL_PREFIX)) {
      throw new Refusal(401, 'A browser stream needs your web login');
    }
    let payload: { sub?: unknown };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new Refusal(401, 'A browser stream needs your web login');
    }
    if (typeof payload.sub !== 'string') throw new Refusal(401, 'A browser stream needs your web login');
    if (this.disabled?.has(payload.sub)) throw new Refusal(401, 'account disabled');
    return payload.sub;
  }
}

/** The viewer's WebSocket route; it listens only while the browser switch is on. */
@Module({
  imports: [AuthModule],
  providers: [BrowserViewerService],
})
export class BrowserViewerModule {}
