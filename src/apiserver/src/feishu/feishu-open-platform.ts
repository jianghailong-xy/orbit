import * as lark from '@larksuiteoapi/node-sdk';
import { FEISHU_OPEN_PLATFORM_ORIGINS, type FeishuPlatform } from '@orbit/shared';

/**
 * Feishu's open platform as this server reaches it (docs/feishu-bot-design.md §4.1, §11), through the
 * official Node SDK.
 *
 * The address is the platform's own (`FEISHU_OPEN_PLATFORM_ORIGINS`), and `openPlatformOrigin` is the one
 * place it is read. A spec points it at the fake open platform (feishu/test-support/fake-open-platform.ts)
 * with ORBIT_TEST_FEISHU_OPEN_PLATFORM_URL, which nothing reads under NODE_ENV=production — what the
 * apiserver image sets — so a deployment can only ever reach Feishu's own address.
 */
export const FEISHU_TEST_OPEN_PLATFORM_ENV = 'ORBIT_TEST_FEISHU_OPEN_PLATFORM_URL';

/** The open platform a platform's apps are called on. A test points both platforms at its fake, one path apart. */
export function openPlatformOrigin(platform: FeishuPlatform): string {
  const fake = process.env.NODE_ENV === 'production' ? undefined : process.env[FEISHU_TEST_OPEN_PLATFORM_ENV]?.trim();
  if (fake) return `${fake.replace(/\/+$/, '')}/${platform.toLowerCase()}`;
  return FEISHU_OPEN_PLATFORM_ORIGINS[platform];
}

/** How long one request to Feishu may take: a save waits on it, and a Feishu that does not answer is a failure. */
export const FEISHU_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The SDK logs a failed request together with the body it sent, which for the token request is the App
 * Secret. Nothing this server builds logs through it: the caller is answered what went wrong instead.
 */
export const SILENT: lark.Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

/** The SDK's own HTTP instance with a timeout on every request: by itself it waits as long as Feishu does. */
function timed<D>(opts: lark.HttpRequestOptions<D>): Promise<never> {
  return lark.defaultHttpInstance.request({ ...opts, timeout: opts.timeout ?? FEISHU_REQUEST_TIMEOUT_MS } as never) as Promise<never>;
}
const TIMED_HTTP: lark.HttpInstance = {
  request: (opts) => timed(opts),
  get: (url, opts) => timed({ ...opts, url, method: 'GET' }),
  delete: (url, opts) => timed({ ...opts, url, method: 'DELETE' }),
  head: (url, opts) => timed({ ...opts, url, method: 'HEAD' }),
  options: (url, opts) => timed({ ...opts, url, method: 'OPTIONS' }),
  post: (url, data, opts) => timed({ ...opts, url, data, method: 'POST' }),
  put: (url, data, opts) => timed({ ...opts, url, data, method: 'PUT' }),
  patch: (url, data, opts) => timed({ ...opts, url, data, method: 'PATCH' }),
};

export interface FeishuAppCredentials {
  platform: FeishuPlatform;
  appId: string;
  appSecret: string;
}

/**
 * An SDK client acting as one app: its platform's address, no logging, and a timeout on every request. Left to
 * itself, the SDK fetches a tenant_access_token for every request it sends and caches it per app;
 * `disableTokenCache` sends a request with no token at all, as the token trade itself is sent.
 */
export function feishuClient(
  { platform, appId, appSecret }: FeishuAppCredentials,
  { disableTokenCache = false }: { disableTokenCache?: boolean } = {},
): lark.Client {
  return new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: openPlatformOrigin(platform),
    logger: SILENT,
    httpInstance: TIMED_HTTP,
    disableTokenCache,
  });
}

/** Feishu's message is kept to this many characters, wherever it is repeated. */
const MAX_FEISHU_MSG = 500;

/**
 * What became of trading an app's credentials for a tenant_access_token. Feishu refused them, with its code
 * and message; or no usable answer came back — Feishu could not be reached, did not answer in time, or
 * answered something that is not its JSON — with why, in words that carry no credential.
 */
export type CredentialCheck =
  | { ok: true }
  | { ok: false; code: 'FEISHU_CREDENTIALS_REJECTED'; feishuCode: number; feishuMsg: string }
  | { ok: false; code: 'FEISHU_UNREACHABLE'; reason: string };

/** Why no answer came: the transport's error code (ECONNREFUSED, ETIMEDOUT, …) or the HTTP status. Never the request. */
function unreachable(reason: string): CredentialCheck {
  return { ok: false, code: 'FEISHU_UNREACHABLE', reason: reason.slice(0, 200) };
}

function verdictOf(answer: unknown, status?: number): CredentialCheck {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return unreachable(status === undefined ? 'Feishu answered with something that is not JSON' : `Feishu answered HTTP ${status} with something that is not JSON`);
  }
  const { code, msg } = answer as { code?: unknown; msg?: unknown };
  if (typeof code !== 'number') return unreachable(`Feishu answered${status === undefined ? '' : ` HTTP ${status}`} without a code`);
  const feishuMsg = typeof msg === 'string' ? msg.slice(0, MAX_FEISHU_MSG) : '';
  if (code !== 0) return { ok: false, code: 'FEISHU_CREDENTIALS_REJECTED', feishuCode: code, feishuMsg };
  // The SDK's typings put the token under `data`; Feishu answers it at the top. Either is a token.
  const { tenant_access_token: top, data } = answer as { tenant_access_token?: unknown; data?: { tenant_access_token?: unknown } };
  const token = typeof top === 'string' ? top : typeof data?.tenant_access_token === 'string' ? data.tenant_access_token : '';
  return token !== '' ? { ok: true } : unreachable('Feishu answered code 0 without a tenant_access_token');
}

/**
 * Trade the credentials for a tenant_access_token once, as a save does before it stores anything (§4.1). The
 * token itself is dropped here: it is never kept, logged or answered.
 */
export async function checkCredentials(app: FeishuAppCredentials): Promise<CredentialCheck> {
  let answer: unknown;
  try {
    // One request: the trade itself, with no token fetched for it first and none cached after.
    answer = await feishuClient(app, { disableTokenCache: true }).auth.tenantAccessToken.internal({
      data: { app_id: app.appId, app_secret: app.appSecret },
    });
  } catch (error) {
    // A status other than 2xx arrives as an error carrying Feishu's body, which says why as a 200's would.
    const response = (error as { response?: { status?: unknown; data?: unknown } } | null)?.response;
    if (response) return verdictOf(response.data, typeof response.status === 'number' ? response.status : undefined);
    const code = (error as { code?: unknown } | null)?.code;
    return unreachable(typeof code === 'string' && code !== '' ? code : 'no answer');
  }
  return verdictOf(answer);
}
