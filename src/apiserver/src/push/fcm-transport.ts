import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import type { AndroidPushData } from '@orbit/shared';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmResult {
  accepted: boolean;
  invalidToken: boolean;
  reason?: string;
}

/** HTTP v1 only. Fixed Google endpoints; neither a registration nor credential can redirect auth. */
export class FcmTransport {
  readonly packageName: string;
  private readonly projectId?: string;
  private readonly email?: string;
  private readonly privateKey?: string;
  private cached?: { token: string; expiresAt: number };
  private refreshing?: Promise<string>;

  constructor(
    config: ConfigService,
    private readonly request: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.projectId = config.get<string>('FCM_PROJECT_ID');
    this.email = config.get<string>('FCM_CLIENT_EMAIL');
    const key = config.get<string>('FCM_PRIVATE_KEY');
    this.privateKey = key ? Buffer.from(key, 'base64').toString('utf8') : undefined;
    this.packageName = config.get<string>('FCM_ANDROID_PACKAGE') || 'io.orbitd.android';
  }

  get enabled(): boolean {
    return Boolean(this.projectId && this.email && this.privateKey);
  }

  /** Recheck the binding before each attempt, including after waiting for OAuth or Retry-After. */
  async send(token: string, data: AndroidPushData, isCurrent: () => Promise<boolean>): Promise<FcmResult> {
    const failure = (reason: string): FcmResult => ({ accepted: false, invalidToken: false, reason });
    if (!this.enabled) return failure('NOT_CONFIGURED');
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 4096) return failure('PAYLOAD_TOO_LARGE');
    const body = JSON.stringify({ message: {
      token, data,
      android: {
        priority: data.type === 'alert' ? 'HIGH' : 'NORMAL',
        ttl: '300s',
        restricted_package_name: this.packageName,
        // No FCM collapse_key: its four-key limit can discard unrelated sessions/clear deltas.
        // Android replaces displayed notifications using data.notificationKey instead.
      },
    } });
    let refreshed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      let auth: string;
      try {
        auth = await this.accessToken();
        if (!await isCurrent()) return failure('REGISTRATION_CHANGED');
        response = await this.request(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId!)}/messages:send`,
          { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
            body, signal: AbortSignal.timeout(10_000), redirect: 'error' },
        );
      } catch {
        // Never log a provider response or exception that could contain a token/private key.
        if (attempt === 2) return failure('TRANSPORT_ERROR');
        await this.sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
        continue;
      }
      const result = await response.json().catch(() => ({})) as {
        name?: string;
        error?: { status?: string; details?: Array<{ '@type'?: string; errorCode?: string }> };
      };
      if (response.ok && result.name) return { accepted: true, invalidToken: false };
      const code = result.error?.details?.find(
        (d) => d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
      )?.errorCode;
      // INVALID_ARGUMENT can mean a malformed payload; 404 can mean a bad project. Neither is
      // evidence that a registration died. Only FCM's typed UNREGISTERED removes a token.
      if (response.status === 404 && code === 'UNREGISTERED') {
        return { accepted: false, invalidToken: true, reason: 'UNREGISTERED' };
      }
      if (response.status === 401 && !refreshed && attempt < 2) {
        if (this.cached?.token === auth) this.cached = undefined;
        refreshed = true;
        continue;
      }
      const reason = `HTTP_${response.status}`;
      if (attempt === 2 || ![429, 500, 503].includes(response.status)) return failure(reason);
      const retryAfter = response.headers.get('retry-after');
      const retryMs = retryAfter === null ? 0 : /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
      const delay = Math.max(Number.isFinite(retryMs) ? retryMs : 0,
        (response.status === 429 ? 60_000 : 1000) * 2 ** attempt);
      // Bound best-effort work. If Google asks for longer, stop; never retry earlier than asked.
      if (delay > 60_000) return failure(reason);
      await this.sleep(delay + Math.floor(Math.random() * 250));
    }
    return failure('RETRIES_EXHAUSTED');
  }

  private async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - Date.now() > 60_000) return this.cached.token;
    if (!this.refreshing) {
      this.refreshing = this.mintToken().finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  private async mintToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign({ iss: this.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
      this.privateKey!, { algorithm: 'RS256' });
    const response = await this.request(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    const result = await response.json() as { access_token?: string; expires_in?: number };
    if (!response.ok || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in! <= 60) {
      throw new Error('FCM OAuth failed');
    }
    this.cached = { token: result.access_token, expiresAt: Date.now() + result.expires_in! * 1000 };
    return result.access_token;
  }
}
