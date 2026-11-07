import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FeishuPlatform } from '@orbit/shared';

/**
 * Feishu's open platform for specs, on a port of the spec's own process (docs/feishu-bot-design.md §11): what the
 * apiserver is pointed at with ORBIT_TEST_FEISHU_OPEN_PLATFORM_URL (feishu/feishu-open-platform.ts). Feishu's side
 * is served under /feishu and Lark's under /lark, so a spec can tell which platform a request went to; a path under
 * neither is answered 404.
 *
 * It knows the self-built apps a spec registers (`addApp`) and answers what Orbit asks of them. Today that is the
 * token trade, `POST /open-apis/auth/v3/tenant_access_token/internal`; the long connection, sending messages and
 * updating cards are added the same way, as routes (`route`) and, for the long connection's WebSocket, an `upgrade`
 * listener on `server`. Every request is kept in `requests` as it arrived, and every tenant_access_token handed out
 * in `tenantAccessTokens`, so a spec can hold Orbit to never storing, logging or answering one.
 *
 * `mode` breaks the platform for every route at once: `unreachable` drops each connection without an answer, and
 * `not-json` answers 200 with an HTML page, as a proxy in the way might.
 */

/** A self-built app the platform knows: its credentials on one platform. */
export interface FakeFeishuApp {
  platform: FeishuPlatform;
  appId: string;
  appSecret: string;
}

/** A request as it arrived: its platform, its path below the platform's prefix, and its body parsed as JSON when it is. */
export interface FakeRequest {
  platform: FeishuPlatform | null;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/** What a route answers: an HTTP status and a JSON body. */
export interface FakeAnswer {
  status: number;
  body: unknown;
}

export type FakeRoute = (request: FakeRequest & { platform: FeishuPlatform }) => FakeAnswer | Promise<FakeAnswer>;

export type FakeMode = 'ok' | 'unreachable' | 'not-json';

/** Feishu's refusals of a token trade, as the open platform words them. */
export const FAKE_INVALID_PARAM = { code: 10003, msg: 'invalid param' } as const;
export const FAKE_SECRET_INVALID = { code: 10014, msg: 'app secret invalid' } as const;

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
  private readonly apps = new Map<string, FakeFeishuApp>();
  private readonly routes = new Map<string, FakeRoute>();

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.route('POST', '/open-apis/auth/v3/tenant_access_token/internal', (request) => this.tradeToken(request));
  }

  /** Make an app known to the platform, or change its secret. */
  addApp(app: FakeFeishuApp): void {
    this.apps.set(`${app.platform}:${app.appId}`, { ...app });
  }

  /** Answer `method path` (the path below the platform's prefix) with `handler`, on both platforms. */
  route(method: string, path: string, handler: FakeRoute): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
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
    const route = this.routes.get(`${request.method} ${request.path}`);
    const answer: FakeAnswer =
      platform === null
        ? { status: 404, body: { code: 404, msg: `no platform at /${prefix}` } }
        : route
          ? await route({ ...request, platform })
          : { status: 404, body: { code: 404, msg: `no route for ${request.method} ${request.path}` } };
    res.writeHead(answer.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(answer.body));
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
    return { status: 200, body: { code: 0, msg: 'ok', tenant_access_token: token, expire: 7200 } };
  }
}
