import http2 from 'node:http2';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { RunStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { badgeDiff, BadgeState } from './badge-diff';

const APNS_HOST_PROD = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';
const SYNC_DEBOUNCE_MS = 300; // coalesce a burst of resolutions into one silent badge sync

/**
 * Sends "needs your reply" pushes to a user's registered iOS devices via APNs, using token-based
 * auth: a short-lived ES256 JWT signed with the team's .p8 key (cached ~50 min; APNs allows reuse
 * up to 1h). Best-effort — a push failure never affects the approval flow. Disabled (no-op) unless
 * APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID are configured, so the server runs fine before the
 * credential is set and pushes light up the moment it is.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  private readonly keyId?: string;
  private readonly teamId?: string;
  private readonly bundleId: string;
  private readonly p8?: string;
  private cached?: { token: string; iat: number };
  // Per-owner "needs you" state last pushed to that user's devices, so a reconcile pushes only on a
  // real change and can tell iOS which sessions' banners to clear. In-memory/per-replica; pushes are
  // idempotent so a rare cross-replica double-send is harmless. See docs/cross-platform-badge-sync.md.
  private readonly badgeState = new Map<string, BadgeState>();
  private readonly syncTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.keyId = config.get<string>('APNS_KEY_ID');
    this.teamId = config.get<string>('APNS_TEAM_ID');
    this.bundleId = config.get<string>('APNS_BUNDLE_ID') ?? 'io.orbitd.app';
    const b64 = config.get<string>('APNS_KEY'); // base64 of the AuthKey_XXXX.p8
    this.p8 = b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined;
    if (!this.enabled) {
      this.log.warn('APNs not configured (APNS_KEY/APNS_KEY_ID/APNS_TEAM_ID) — pushes disabled');
    }
  }

  private get enabled(): boolean {
    return Boolean(this.keyId && this.teamId && this.p8);
  }

  /**
   * Tell the session's owner a tool approval is pending. Fire-and-forget: callers `void` this so a
   * slow/failed APNs round-trip never blocks the runner request that created the approval.
   */
  async notifyApprovalRequest(sessionId: string, toolName: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { title: true, ownerId: true },
      });
      if (!session) return;
      const tokens = await this.prisma.deviceToken.findMany({ where: { userId: session.ownerId } });
      if (tokens.length === 0) return;

      // App-icon badge = the owner's sessions that need a reply (the authoritative count, shared
      // with the in-app "needs you" list and the silent sync below). Record it so a follow-up
      // reconcile won't re-push this same value. See docs/cross-platform-badge-sync.md.
      const ids = await this.needsYouSessions(session.ownerId);
      this.badgeState.set(session.ownerId, { badge: ids.length, sessions: new Set(ids) });
      const badge = ids.length;

      const auth = this.authToken();
      if (!auth) return;
      const body = JSON.stringify({
        aps: {
          alert: { title: session.title || 'Orbit', body: `Needs your reply · ${toolName}` },
          sound: 'default',
          badge,
          category: 'ORBIT_APPROVAL', // matches OrbitKit Notifications.approvalCategory
          'thread-id': sessionId,
        },
        sessionID: sessionId, // OrbitKit Notifications.keySession — routes the tap to this session
        kind: 'approval',
      });

      await this.deliver(tokens, body, 'alert', '10', auth);
    } catch (err) {
      this.log.warn(`push notify failed: ${(err as Error).message}`);
    }
  }

  /** Session IDs that currently "need your reply" for this owner — the badge is this set's size.
   *  Mirrors the client's SessionGrouping.needsYou exactly: a non-system, RUNNING session with at
   *  least one PENDING approval. Counting sessions (not approval rows) and gating on RUNNING keeps
   *  the badge equal to what the app shows, and excludes orphaned approvals on dead sessions. */
  async needsYouSessions(ownerId: string): Promise<string[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        ownerId,
        status: RunStatus.RUNNING,
        source: { not: 'system' },
        approvals: { some: { status: 'PENDING' } },
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Debounced: something that could lower `ownerId`'s "needs you" count happened (an approval
   *  resolved, a session left RUNNING, a session ended — possibly on another device). Coalesce a
   *  burst into one silent sync. Called from RealtimeService.publish() on the event's origin replica. */
  scheduleBadgeSync(ownerId: string): void {
    if (!this.enabled) return;
    clearTimeout(this.syncTimers.get(ownerId));
    this.syncTimers.set(
      ownerId,
      setTimeout(() => {
        this.syncTimers.delete(ownerId);
        void this.reconcileBadge(ownerId);
      }, SYNC_DEBOUNCE_MS),
    );
  }

  /** Recompute the owner's badge; if it moved or a session dropped out of "needs you", push a
   *  silent badge update to their devices and name the sessions whose banners should be cleared. */
  private async reconcileBadge(ownerId: string): Promise<void> {
    try {
      const delta = badgeDiff(this.badgeState.get(ownerId), await this.needsYouSessions(ownerId));
      if (delta.badge === 0) this.badgeState.delete(ownerId);
      else this.badgeState.set(ownerId, { badge: delta.badge, sessions: delta.sessions });
      if (delta.changed) await this.syncBadge(ownerId, delta.badge, delta.clearSessions);
    } catch (err) {
      this.log.warn(`badge sync failed: ${(err as Error).message}`);
    }
  }

  /** Silent (content-available) push: updates the icon badge with no banner/sound, and carries
   *  `clearSessions` so a backgrounded app can remove the now-stale delivered approval banners. */
  private async syncBadge(ownerId: string, badge: number, clearSessions: string[]): Promise<void> {
    const tokens = await this.prisma.deviceToken.findMany({ where: { userId: ownerId } });
    if (tokens.length === 0) return;
    const auth = this.authToken();
    if (!auth) return;
    const body = JSON.stringify({
      aps: { 'content-available': 1, badge },
      ...(clearSessions.length ? { clearSessions } : {}),
    });
    await this.deliver(tokens, body, 'background', '5', auth);
  }

  /** Fan a prepared payload out to a set of device tokens, pruning any APNs reports as dead. */
  private async deliver(
    tokens: { token: string; environment: string }[],
    body: string,
    pushType: 'alert' | 'background',
    priority: '10' | '5',
    auth: string,
  ): Promise<void> {
    await Promise.all(
      tokens.map(async (t) => {
        const host = t.environment === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PROD;
        const res = await this.send(host, t.token, body, auth, pushType, priority);
        if (res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'Unregistered') {
          // APNs says this token is dead — drop it so we stop pushing to it.
          await this.prisma.deviceToken.deleteMany({ where: { token: t.token } }).catch(() => {});
        } else if (res.status >= 400) {
          this.log.warn(`APNs ${res.status} ${res.reason ?? ''} for ${t.token.slice(0, 8)}…`);
        }
      }),
    );
  }

  /** Cached provider JWT (ES256, kid=keyId, iss=teamId). Refreshed well before APNs's 1h limit. */
  private authToken(): string | null {
    if (!this.enabled) return null;
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && now - this.cached.iat < 3000) return this.cached.token;
    const token = jwt.sign({ iss: this.teamId, iat: now }, this.p8 as string, {
      algorithm: 'ES256',
      keyid: this.keyId,
    });
    this.cached = { token, iat: now };
    return token;
  }

  /** One APNs POST over a fresh HTTP/2 connection (approval events are infrequent — no pool). */
  private send(
    host: string,
    deviceToken: string,
    body: string,
    auth: string,
    pushType: 'alert' | 'background' = 'alert',
    priority: '10' | '5' = '10',
  ): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve) => {
      const client = http2.connect(`https://${host}`);
      const done = (r: { status: number; reason?: string }) => {
        try {
          client.close();
        } catch {
          /* already closed */
        }
        resolve(r);
      };
      client.on('error', () => done({ status: 0 }));
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${auth}`,
        'apns-topic': this.bundleId,
        'apns-push-type': pushType,
        'apns-priority': priority,
        'content-type': 'application/json',
      });
      let status = 0;
      let data = '';
      req.on('response', (h) => {
        status = Number(h[':status']) || 0;
      });
      req.on('data', (d) => {
        data += d;
      });
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = data ? (JSON.parse(data).reason as string) : undefined;
        } catch {
          /* no JSON body */
        }
        done({ status, reason });
      });
      req.on('error', () => done({ status: 0 }));
      req.setTimeout(10_000, () => {
        try {
          req.close();
        } catch {
          /* ignore */
        }
        done({ status: 0 });
      });
      req.end(body);
    });
  }
}
