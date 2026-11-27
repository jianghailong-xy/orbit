import { ConfigService } from '@nestjs/config';
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { WEB_PUSH_VERSION, uuidToBase62, type WebPushMessage } from '@orbit/shared';

/** One send's budget, as FCM's: the runner's notify/MCP call waits at most 20 s in all. */
const SEND_TIMEOUT_MS = 10_000;
/** How long a push service keeps an alert for a browser that is closed (docs/web-push-design.md). */
const TTL_SECONDS = 24 * 60 * 60;
/** The largest push message the services promise to carry (RFC 8030 §7.2): 4096 bytes of record, header included. */
const RECORD_SIZE = 4096;

export interface WebPushKeys {
  p256dh: string;
  auth: string;
}

export interface WebPushResult {
  accepted: boolean;
  /** The push service says the subscription is gone (404/410): the registration can be deleted. */
  invalidToken: boolean;
  reason?: string;
}

/**
 * The browsers' own push services, the only hosts a registration may name: the endpoint is a URL the server POSTs to,
 * so an arbitrary one would let a client point the server at any host. Chrome, Edge (FCM or WNS), Firefox, Safari.
 */
const PUSH_SERVICE_HOSTS = [/^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/, /^web\.push\.apple\.com$/];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.port === '' && !url.username && !url.password
    && PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname));
}

const b64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/**
 * The APNs body PushService built, as the message a browser's sw.js shows (`alert`) or reconciles with (`sync`). Null:
 * nothing to send this browser (a badge-only sync, which a browser has no badge for).
 */
export function webPushMessage(body: string, type: 'alert' | 'background', collapseId?: string): WebPushMessage | null {
  const { aps, ...routing } = JSON.parse(body) as { aps: { alert?: string | { title?: string; body?: string } } } & Record<string, unknown>;
  if (type === 'background') {
    const clear = routing.clearSessions;
    return Array.isArray(clear) && clear.length > 0
      ? { v: WEB_PUSH_VERSION, type: 'sync', clearSessions: clear.map(String) }
      : null;
  }
  const alert = typeof aps.alert === 'string' ? { title: 'Orbit', body: aps.alert } : aps.alert ?? {};
  const id = (key: string): string | null => (typeof routing[key] === 'string' ? (routing[key] as string) : null);
  const url = id('sessionID') ? `/sessions/${uuidToBase62(id('sessionID')!)}`
    : id('projectID') ? `/projects/${uuidToBase62(id('projectID')!)}`
    : id('taskID') ? `/tasks/${uuidToBase62(id('taskID')!)}`
    : id('url') && /^https?:\/\//.test(id('url')!) ? id('url')!
    : '/';
  // The same tag Android uses as its notification key, so the same events replace each other in the tray.
  const tag = collapseId ?? (routing.kind === 'approval' && id('sessionID') ? `approval-${id('sessionID')}` : `${String(routing.kind ?? 'alert')}-${Date.now()}`);
  return { v: WEB_PUSH_VERSION, type: 'alert', title: alert.title ?? 'Orbit', body: alert.body ?? '', tag, url };
}

/**
 * RFC 8291 message encryption (aes128gcm, one record) to a subscription's keys. `local` (the server's one-off key pair)
 * and `salt` are fixed only by the spec's test vector; every send draws fresh ones.
 */
export function encryptWebPush(
  plaintext: Buffer,
  keys: WebPushKeys,
  local: { privateKey: Buffer } = { privateKey: randomBytes(32) },
  salt: Buffer = randomBytes(16),
): Buffer {
  const uaPublic = b64u(keys.p256dh);
  const authSecret = b64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('INVALID_KEYS');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(local.privateKey);
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
  // HKDF (RFC 5869) with one block of output, which is all every value below needs.
  const hkdf = (salt_: Buffer, ikm: Buffer, info: Buffer, length: number) =>
    hmac(hmac(salt_, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/** Web Push (RFC 8030) with VAPID (RFC 8292), to the browsers that registered as platform 'web'. */
export class WebPushTransport {
  readonly publicKey: string | null;
  private readonly signingKey?: KeyObject;
  private readonly subject: string;

  constructor(config: ConfigService, private readonly request: typeof fetch = fetch) {
    const publicKey = config.get<string>('WEB_PUSH_PUBLIC_KEY')?.trim();
    const privateKey = config.get<string>('WEB_PUSH_PRIVATE_KEY')?.trim();
    this.subject = config.get<string>('WEB_PUSH_SUBJECT')?.trim() || 'https://orbitd.io';
    const raw = publicKey ? b64u(publicKey) : null;
    if (raw && privateKey && raw.length === 65 && raw[0] === 4) {
      this.signingKey = createPrivateKey({ format: 'jwk', key: {
        kty: 'EC', crv: 'P-256', d: privateKey,
        x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url'),
      } });
      this.publicKey = publicKey!;
    } else {
      this.publicKey = null;
    }
  }

  get enabled(): boolean {
    return this.publicKey !== null;
  }

  /** The VAPID JWT for one push service's origin, good for 12 hours (the services refuse more than 24). */
  private vapid(endpoint: string): string {
    const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
      aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: this.subject,
    })}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key: this.signingKey!, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${this.publicKey}`;
  }

  /** Re-checks the binding just before sending, as FCM does. Never throws. */
  async send(endpoint: string, keys: WebPushKeys, message: WebPushMessage, isCurrent: () => Promise<boolean>): Promise<WebPushResult> {
    if (!this.enabled) return { accepted: false, invalidToken: false, reason: 'NOT_CONFIGURED' };
    if (!isPushServiceEndpoint(endpoint)) return { accepted: false, invalidToken: true, reason: 'ENDPOINT_NOT_ALLOWED' };
    let payload: Buffer;
    try {
      payload = encryptWebPush(Buffer.from(JSON.stringify(message)), keys);
    } catch {
      return { accepted: false, invalidToken: true, reason: 'INVALID_KEYS' };
    }
    if (payload.length > RECORD_SIZE) return { accepted: false, invalidToken: false, reason: 'PAYLOAD_TOO_LARGE' };
    if (!await isCurrent()) return { accepted: false, invalidToken: false, reason: 'STALE_BINDING' };
    try {
      const res = await this.request(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: {
          authorization: this.vapid(endpoint),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(TTL_SECONDS),
          urgency: message.type === 'alert' ? 'high' : 'low',
        },
        body: payload,
      });
      if (res.status === 404 || res.status === 410) return { accepted: false, invalidToken: true, reason: `HTTP_${res.status}` };
      return res.ok ? { accepted: true, invalidToken: false } : { accepted: false, invalidToken: false, reason: `HTTP_${res.status}` };
    } catch {
      return { accepted: false, invalidToken: false, reason: 'NETWORK' };
    }
  }
}
