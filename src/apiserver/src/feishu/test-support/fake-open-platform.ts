import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { FeishuPlatform } from '@orbit/shared';
import { FRAME_CONTROL, FRAME_DATA, decodeFrame, encodeFrame, headerOf, type Frame } from './fake-frames';

/**
 * `ws`, the WebSocket library the Feishu SDK itself connects with (a dependency of @larksuiteoapi/node-sdk), seen through
 * the little of it the fake uses. Required rather than imported because the apiserver carries no typings for it.
 */
interface WsSocket {
  readyState: number;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: () => void): void;
  send(data: Buffer): void;
  terminate(): void;
}
interface WsServer {
  handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer, done: (ws: WsSocket) => void): void;
  close(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WebSocketServer } = require('ws') as { WebSocketServer: new (options: { noServer: true }) => WsServer };

/**
 * Feishu's open platform for specs, on a port of the spec's own process (docs/feishu-bot-design.md §11): what the
 * apiserver is pointed at with ORBIT_TEST_FEISHU_OPEN_PLATFORM_URL (feishu/feishu-open-platform.ts). Feishu's side
 * is served under /feishu and Lark's under /lark, so a spec can tell which platform a request went to; a path under
 * neither is answered 404.
 *
 * It knows the self-built apps a spec registers (`addApp`) and answers what Orbit asks of them: the token trade,
 * `POST /open-apis/auth/v3/tenant_access_token/internal`; the bot's own name, `GET /open-apis/bot/v3/info`; a person's name,
 * `GET /open-apis/contact/v3/users/:user_id` (`userNames`); a group, `GET /open-apis/im/v1/chats/:chat_id` (`chats`); sending,
 * replying to and updating messages under `/open-apis/im/v1/messages`; and the long connection as the SDK speaks it
 * (task F0-2's comment has the protocol): `POST /callback/ws/endpoint` answers a `ws://` address on this same server,
 * whose WebSocket carries `pbbp2.Frame`s (fake-frames.ts). Each open WebSocket is a `FakeConnection`; `push` sends it
 * an event as Feishu would and resolves with the client's acknowledgement. Every request is kept in `requests` as it
 * arrived, and every tenant_access_token handed out in `tenantAccessTokens`, so a spec can hold Orbit to never storing,
 * logging or answering one.
 *
 * `mode` breaks the platform for every route at once: `unreachable` drops each connection without an answer, and
 * `not-json` answers 200 with an HTML page, as a proxy in the way might.
 */

/** A self-built app the platform knows: its credentials on one platform, and its bot's name. */
export interface FakeFeishuApp {
  platform: FeishuPlatform;
  appId: string;
  appSecret: string;
  botName?: string;
}

/** What a client answered one pushed event with: Feishu's ack frame, its payload parsed. */
export interface FakeAck {
  /** 200 handled, 500 the handler threw. */
  code: number;
  /** The handler's return value, decoded from the ack's base64 `data`: a card callback's synchronous answer. */
  data: unknown;
}

/** One open long connection: whose it is, and whether it is still open. */
export interface FakeConnection {
  id: number;
  platform: FeishuPlatform;
  appId: string;
  open: boolean;
  /** Pings the client sent on it. */
  pings: number;
}

/** A request as it arrived: its platform, its path below the platform's prefix, and its body parsed as JSON when it is. */
export interface FakeRequest {
  platform: FeishuPlatform | null;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  /** When it arrived (Date.now()). */
  at: number;
}

/** What a route answers: an HTTP status, a JSON body, and any headers beside the content type. */
export interface FakeAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type FakeRoute = (request: FakeRequest & { platform: FeishuPlatform }) => FakeAnswer | Promise<FakeAnswer>;

export type FakeMode = 'ok' | 'unreachable' | 'not-json';

/** Feishu's refusals of a token trade, as the open platform words them. */
export const FAKE_INVALID_PARAM = { code: 10003, msg: 'invalid param' } as const;
export const FAKE_SECRET_INVALID = { code: 10014, msg: 'app secret invalid' } as const;
/** The long connection's endpoint refusing credentials. */
export const FAKE_WS_AUTH_FAILED = { code: 514, msg: 'auth failed' } as const;
/** The contact API refusing a person outside the app's range, or without the permission granted. */
export const FAKE_NO_USER_AUTHORITY = { code: 41050, msg: 'no user authority error' } as const;
/** The chat API refusing a chat the bot is not in, or that does not exist. */
export const FAKE_CHAT_NOT_FOUND = { code: 232011, msg: 'the bot is not in the chat' } as const;
/** A request whose tenant_access_token the platform did not hand out. */
export const FAKE_TOKEN_INVALID = { code: 99991663, msg: 'Invalid access token for authorization. Please make a request with token attached.' } as const;

export class FakeOpenPlatform {
  readonly server: http.Server;
  /** Every request, in the order it arrived. */
  readonly requests: FakeRequest[] = [];
  /** Every tenant_access_token handed out. */
  readonly tenantAccessTokens: string[] = [];
  /** How the platform answers every route; `ok` is as Feishu would. */
  mode: FakeMode = 'ok';
  /** The HTTP status a refused token trade comes with. Feishu answers 400; a 200 with a code is held to the same. */
  refusalStatus = 400;
  /** Every long connection ever opened, in order. */
  readonly connections: FakeConnection[] = [];
  /** Messages sent, replied and updated through `/open-apis/im/v1/messages`, as they arrived. */
  readonly messages: FakeRequest[] = [];
  /** People's names by open_id, as the contact API answers them; an open_id not here is answered Feishu's refusal. */
  readonly userNames = new Map<string, string>();
  /** Groups by chat_id, as the chat API answers them; a chat_id not here is answered Feishu's refusal. */
  readonly chats = new Map<string, { name: string; external: boolean }>();
  private readonly apps = new Map<string, FakeFeishuApp>();
  private readonly routes = new Map<string, FakeRoute>();
  private readonly sockets = new Map<number, WsSocket>();
  private readonly pending = new Map<string, (ack: FakeAck) => void>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private seq = 0;

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as Socket, head));
    this.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', (request) => this.tradeToken(request));
    this.route('POST', '/callback/ws/endpoint', (request) => this.endpoint(request));
    this.route('GET', '/open-apis/bot/v3/info', (request) =>
      this.withToken(request, (app) => ({ status: 200, body: { code: 0, msg: 'ok', bot: { app_name: app.botName ?? 'Fake bot', open_id: `ou_bot_${app.appId}` } } })));
    const message = (request: FakeRequest & { platform: FeishuPlatform }) =>
      this.withToken(request, () => {
        this.messages.push(request);
        return { status: 200, body: { code: 0, msg: 'success', data: { message_id: `om_fake_${randomBytes(8).toString('hex')}` } } };
      });
    this.route('GET', '/open-apis/contact/v3/users/:user_id', (request) =>
      this.withToken(request, () => {
        const openId = decodeURIComponent(request.path.split('/').pop() ?? '');
        const name = request.query.get('user_id_type') === 'open_id' ? this.userNames.get(openId) : undefined;
        return name === undefined
          ? { status: 400, body: FAKE_NO_USER_AUTHORITY }
          : { status: 200, body: { code: 0, msg: 'success', data: { user: { open_id: openId, name } } } };
      }));
    this.route('GET', '/open-apis/im/v1/chats/:chat_id', (request) =>
      this.withToken(request, () => {
        const chat = this.chats.get(decodeURIComponent(request.path.split('/').pop() ?? ''));
        return chat === undefined
          ? { status: 400, body: FAKE_CHAT_NOT_FOUND }
          : { status: 200, body: { code: 0, msg: 'success', data: { name: chat.name, external: chat.external, chat_mode: 'group' } } };
      }));
    this.route('POST', '/open-apis/im/v1/messages', message);
    this.route('POST', '/open-apis/im/v1/messages/:message_id/reply', message);
    this.route('PATCH', '/open-apis/im/v1/messages/:message_id', message);
  }

  /** Make an app known to the platform, or change its secret. */
  addApp(app: FakeFeishuApp): void {
    this.apps.set(`${app.platform}:${app.appId}`, { ...app });
  }

  /** Forget an app, as when its developer deletes it from the console. Its connections stay until `drop`. */
  removeApp(platform: FeishuPlatform, appId: string): void {
    this.apps.delete(`${platform}:${appId}`);
  }

  /**
   * Answer `method path` (the path below the platform's prefix) with `handler`, on both platforms. A `:name` segment
   * matches any one segment. A route set again replaces the one before.
   */
  route(method: string, path: string, handler: FakeRoute): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
  }

  /** The long connections open now, of one app or of all. */
  openConnections(appId?: string): FakeConnection[] {
    return this.connections.filter((c) => c.open && (appId === undefined || c.appId === appId));
  }

  /** Close an app's connections from the platform's side, as a network drop or a Feishu restart does. */
  drop(appId: string): void {
    for (const c of this.openConnections(appId)) this.sockets.get(c.id)?.terminate();
  }

  /**
   * Push one event (Feishu's JSON envelope, as the open platform sends it) down a connection as a data frame, and resolve
   * with the client's acknowledgement. Rejects when no ack comes within `timeoutMs`.
   */
  push(connection: FakeConnection, envelope: unknown, timeoutMs = 10_000): Promise<FakeAck> {
    const socket = this.sockets.get(connection.id);
    if (!socket || !connection.open) return Promise.reject(new Error(`connection ${connection.id} is not open`));
    const messageId = `fake-msg-${++this.seq}-${randomBytes(4).toString('hex')}`;
    const acked = new Promise<FakeAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`no ack for ${messageId} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(messageId, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
    socket.send(encodeFrame({
      SeqID: this.seq,
      LogID: this.seq,
      service: 1,
      method: FRAME_DATA,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: messageId },
        { key: 'sum', value: '1' },
        { key: 'seq', value: '0' },
        { key: 'trace_id', value: `trace-${messageId}` },
      ],
      payload: new TextEncoder().encode(JSON.stringify(envelope)),
    }));
    return acked;
  }

  /** The requests made to one path, on one platform or either. */
  requestsTo(path: string, platform?: FeishuPlatform): FakeRequest[] {
    return this.requests.filter((r) => r.path === path && (platform === undefined || r.platform === platform));
  }

  /** Listen on a free port of 127.0.0.1; resolves with the address to point the apiserver at. */
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    return this.url;
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    for (const socket of this.sockets.values()) socket.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    const text = Buffer.concat(parts).toString('utf8');
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      // Kept as the text it was.
    }
    const url = new URL(req.url ?? '/', 'http://fake-open-platform.invalid');
    const [, prefix = '', ...rest] = url.pathname.split('/');
    const platform: FeishuPlatform | null = prefix === 'feishu' ? 'FEISHU' : prefix === 'lark' ? 'LARK' : null;
    const request: FakeRequest = {
      platform,
      method: req.method ?? 'GET',
      path: `/${rest.join('/')}`,
      query: url.searchParams,
      headers: req.headers,
      body,
      at: Date.now(),
    };
    this.requests.push(request);
    if (this.mode === 'unreachable') {
      req.socket.destroy();
      return;
    }
    if (this.mode === 'not-json') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Bad gateway</body></html>');
      return;
    }
    const route = this.match(request.method, request.path);
    const answer: FakeAnswer =
      platform === null
        ? { status: 404, body: { code: 404, msg: `no platform at /${prefix}` } }
        : route
          ? await route({ ...request, platform })
          : { status: 404, body: { code: 404, msg: `no route for ${request.method} ${request.path}` } };
    res.writeHead(answer.status, { ...answer.headers, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(answer.body));
  }

  private match(method: string, path: string): FakeRoute | undefined {
    const exact = this.routes.get(`${method} ${path}`);
    if (exact) return exact;
    const segments = path.split('/');
    for (const [key, route] of this.routes) {
      const [m, p] = key.split(' ');
      const pattern = p.split('/');
      if (m === method && pattern.length === segments.length && pattern.every((s, i) => s.startsWith(':') || s === segments[i])) return route;
    }
    return undefined;
  }

  /** A REST call made as an app: answered by `then` when its bearer is a token this platform handed out. */
  private withToken(request: FakeRequest & { platform: FeishuPlatform }, then: (app: FakeFeishuApp) => FakeAnswer): FakeAnswer {
    const bearer = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const appId = this.tokenApps.get(bearer);
    const app = appId === undefined ? undefined : this.apps.get(`${request.platform}:${appId}`);
    if (!app) return { status: 400, body: FAKE_TOKEN_INVALID };
    return then(app);
  }

  private readonly tokenApps = new Map<string, string>();

  /** The long connection's endpoint discovery: the app's own credentials buy a `ws://` address on this server. */
  private endpoint(request: FakeRequest & { platform: FeishuPlatform }): FakeAnswer {
    const { AppID: appId, AppSecret: appSecret } = (request.body ?? {}) as { AppID?: unknown; AppSecret?: unknown };
    const app = typeof appId === 'string' ? this.apps.get(`${request.platform}:${appId}`) : undefined;
    if (!app || app.appSecret !== appSecret) return { status: 200, body: { ...FAKE_WS_AUTH_FAILED, data: {} } };
    const { port } = this.server.address() as AddressInfo;
    const query = new URLSearchParams({ app: app.appId, platform: app.platform, device_id: `fake-device-${++this.seq}`, service_id: '1' });
    return {
      status: 200,
      body: {
        code: 0,
        msg: 'ok',
        data: {
          URL: `ws://127.0.0.1:${port}/ws?${query.toString()}`,
          ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 },
        },
      },
    };
  }

  private upgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://fake-open-platform.invalid');
    const appId = url.searchParams.get('app') ?? '';
    const platform = url.searchParams.get('platform') as FeishuPlatform | null;
    if (url.pathname !== '/ws' || !platform || !this.apps.has(`${platform}:${appId}`) || this.mode !== 'ok') {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const connection: FakeConnection = { id: this.connections.length + 1, platform, appId, open: true, pings: 0 };
      this.connections.push(connection);
      this.sockets.set(connection.id, ws);
      ws.on('close', () => {
        connection.open = false;
        this.sockets.delete(connection.id);
      });
      ws.on('message', (data) => this.onFrame(connection, ws, decodeFrame(data)));
    });
  }

  private onFrame(connection: FakeConnection, ws: WsSocket, frame: Frame): void {
    if (frame.method === FRAME_CONTROL && headerOf(frame, 'type') === 'ping') {
      connection.pings += 1;
      ws.send(encodeFrame({
        ...frame,
        headers: [{ key: 'type', value: 'pong' }],
        payload: new TextEncoder().encode(JSON.stringify({ PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 })),
      }));
      return;
    }
    if (frame.method !== FRAME_DATA) return;
    const messageId = headerOf(frame, 'message_id') ?? '';
    const settle = this.pending.get(messageId);
    if (!settle) return;
    this.pending.delete(messageId);
    const answer = JSON.parse(new TextDecoder().decode(frame.payload ?? new Uint8Array())) as { code: number; data?: string };
    settle({ code: answer.code, data: answer.data ? JSON.parse(Buffer.from(answer.data, 'base64').toString('utf8')) : undefined });
  }

  /** The token trade of a self-built app: its own credentials, on its own platform, or Feishu's refusal. */
  private tradeToken(request: FakeRequest & { platform: FeishuPlatform }): FakeAnswer {
    const { app_id: appId, app_secret: appSecret } = (request.body ?? {}) as { app_id?: unknown; app_secret?: unknown };
    if (typeof appId !== 'string' || appId === '' || typeof appSecret !== 'string' || appSecret === '') {
      return { status: this.refusalStatus, body: FAKE_INVALID_PARAM };
    }
    const app = this.apps.get(`${request.platform}:${appId}`);
    if (!app) return { status: this.refusalStatus, body: FAKE_INVALID_PARAM };
    if (app.appSecret !== appSecret) return { status: this.refusalStatus, body: FAKE_SECRET_INVALID };
    const token = `t-fake-${randomBytes(16).toString('hex')}`;
    this.tenantAccessTokens.push(token);
    this.tokenApps.set(token, app.appId);
    return { status: 200, body: { code: 0, msg: 'ok', tenant_access_token: token, expire: 7200 } };
  }
}
