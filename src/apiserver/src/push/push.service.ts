import http2 from 'node:http2';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { RunStatus } from '@prisma/client';
import type { LoginEngine } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { agentAlert } from './agent-alert';
import { badgeDiff, BadgeState } from './badge-diff';
import { judgmentAlert, type JudgmentAlertInput } from './judgment-alert';
import { settleAlert } from './settle-alert';

const APNS_HOST_PROD = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';
const SYNC_DEBOUNCE_MS = 300; // coalesce a burst of resolutions into one silent badge sync
/**
 * Shortest gap between two agent-sent notifications about the same session. Every other push here
 * is edge-triggered by something that happens at most a few times per run; this one fires whenever
 * a model decides to, and a model in a loop decides to a lot. One a minute is far above the rate a
 * milestone actually occurs at and far below the rate that turns a phone into an alarm.
 */
const AGENT_NOTIFY_MIN_INTERVAL_MS = 60_000;
/** Engine names as the user sees them elsewhere in Orbit (matches the web's RunnerSignIn). */
const ENGINE_LABELS: Record<LoginEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
};

/** What became of an agent's own `notify` call — the answer handed straight back to the agent. */
export interface AgentNotifyResult {
  delivered: boolean;
  /** Devices APNs accepted it for. Present only when delivered. */
  devices?: number;
  /** The message was longer than a notification carries and was cut. */
  truncated?: boolean;
  /** Why nothing was sent. Present only when not delivered, and written to be read by an agent. */
  reason?: string;
}

export type JudgmentPushResult =
  | {
      outcome: 'DELIVERED';
      devices: number;
      payload: Record<string, unknown>;
    }
  | {
      outcome: 'BLOCKED' | 'RETRY';
      code: string;
      requiredAction: string;
      error: string;
      payload: Record<string, unknown>;
    };

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
  // When each session (or, headless, each owner) last rang its owner's devices via `notify`.
  // Per-replica like badgeState, and swept on use so a long-lived process doesn't accumulate an
  // entry per session ever run: an entry older than the interval can no longer refuse anything.
  private readonly lastAgentNotify = new Map<string, number>();

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
      const session = await this.prisma.session.findFirst({
        where: {
          id: sessionId,
          status: RunStatus.RUNNING,
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
          cancelRequestedAt: null,
        },
        select: { title: true, ownerId: true },
      });
      if (!session) return;

      // App-icon badge = the owner's sessions that need a reply (the authoritative count, shared
      // with the in-app "needs you" list and the silent sync below). Record it so a follow-up
      // reconcile won't re-push this same value. See docs/cross-platform-badge-sync.md.
      const ids = await this.needsYouSessions(session.ownerId);
      // Completion can race this fire-and-forget path after the approval is created. Requiring the
      // target to remain in the authoritative set prevents a stale alert from being delivered.
      if (!ids.includes(sessionId)) return;
      const tokens = await this.prisma.deviceToken.findMany({ where: { userId: session.ownerId } });
      if (tokens.length === 0) return;
      const alreadyFlagged = this.badgeState.get(session.ownerId)?.sessions.has(sessionId) ?? false;
      this.badgeState.set(session.ownerId, { badge: ids.length, sessions: new Set(ids) });
      // A turn asking permission for several tools at once creates an approval apiece, and each one
      // lands here. The badge counts sessions, so it hasn't moved, and the app coalesces them into a
      // single "N pending" row — only the alerts didn't coalesce, so a parallel tool call rang the
      // phone once per tool. Alert on the session's 0 → pending edge, which is the transition the
      // clients notify on too (SessionDelta.diff). Per-replica and lost on restart: the worst case
      // is the extra banner we have today.
      if (alreadyFlagged) return;
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

  /**
   * Tell a runner's owner that one of its engines just lost its sign-in. Edge-triggered by the
   * heartbeat (the engine reported `yes` and now reports `no`), so one sign-out is one alert
   * rather than one per beat for as long as it lasts.
   *
   * Worth its own push because nothing else tells them: the engine's stored credential can be
   * cleared while no session is running (a failed OAuth refresh does exactly this), and the
   * runner keeps heartbeating perfectly well without it. Today the first sign is a session
   * refusing to start, which can be hours later.
   *
   * No badge: that count means "sessions needing your reply" and this isn't one. Fire-and-forget,
   * like notifyApprovalRequest — a slow APNs round-trip must never hold up a heartbeat.
   */
  async notifyEngineSignedOut(runnerId: string, engine: LoginEngine): Promise<void> {
    if (!this.enabled) return;
    try {
      const runner = await this.prisma.runner.findUnique({
        where: { id: runnerId },
        select: { name: true, displayName: true, ownerId: true },
      });
      if (!runner) return;
      const tokens = await this.prisma.deviceToken.findMany({ where: { userId: runner.ownerId } });
      if (tokens.length === 0) return;
      const auth = this.authToken();
      if (!auth) return;
      const body = JSON.stringify({
        aps: {
          alert: {
            title: runner.displayName || runner.name || 'Orbit',
            body: `${ENGINE_LABELS[engine]} signed out — sessions on this runner won't start until you sign in again.`,
          },
          sound: 'default',
          'thread-id': `runner-${runnerId}`,
        },
        // No sessionID: the clients route a tap by that key and correctly ignore payloads
        // without one (see OrbitKit Notifications), which is what we want — this alert is
        // about the machine, not any one session.
        runnerID: runnerId,
        engine,
        kind: 'engine-signed-out',
      });

      await this.deliver(tokens, body, 'alert', '10', auth);
    } catch (err) {
      this.log.warn(`engine sign-out notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Tell a session's owner that it just settled — the run finished, or failed for good.
   *
   * The approval push covers the one case where an agent is blocked on you; this covers the
   * other reason you'd want your phone to ring, which until now only the macOS shell had (it
   * derives the same event locally from its Open-list polling — see OrbitKit `SessionDelta`).
   * On iOS nothing arrived at all: a task that ran for forty minutes finished in silence, and
   * a run that died to a provider error was invisible until you next opened the app.
   *
   * Deliberately narrow, because the interrupt budget is per-person while the number of agents
   * running is not: `settleAlert` announces only what happened on its own and is really over.
   * Called on the STATUS event the runner/reaper mark `final` — the one signal that fires
   * exactly once per finalization — and again when auto-retry gives up, which settles a
   * failure without moving the row's status.
   *
   * Fire-and-forget, like the others: callers `void` this.
   */
  async notifySessionSettled(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          title: true,
          ownerId: true,
          status: true,
          retryAt: true,
          completedAt: true,
          deletedAt: true,
          error: true,
          owner: { select: { preferences: true } },
        },
      });
      if (!session) return;
      const alert = settleAlert(session);
      if (!alert) return;
      const prefs = (session.owner?.preferences ?? {}) as { notifySessionFinished?: boolean };
      if (prefs.notifySessionFinished === false) return;
      const tokens = await this.prisma.deviceToken.findMany({ where: { userId: session.ownerId } });
      if (tokens.length === 0) return;
      const auth = this.authToken();
      if (!auth) return;

      const body = JSON.stringify({
        aps: {
          alert: { title: session.title || 'Orbit', body: alert.body },
          sound: 'default',
          // Registered by the clients with a Reply action (OrbitKit Notifications), so a
          // finished run can be answered from the banner. No badge: that count means
          // "sessions needing your reply", and a settled session is not one.
          category: 'ORBIT_SESSION',
          'thread-id': sessionId,
        },
        sessionID: sessionId, // OrbitKit Notifications.keySession — routes the tap to this session
        kind: alert.kind,
      });

      // Collapse on the session: the two triggers can both fire for one settlement (a runner
      // finalize the reaper also force-finalizes), and APNs replaces a same-id banner instead
      // of stacking a second one. Cheaper and more robust than remembering what we've sent.
      await this.deliver(tokens, body, 'alert', '10', auth, `settled-${sessionId}`);
    } catch (err) {
      this.log.warn(`settle notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Deliver a line an agent wrote itself, to the devices of the account it is running for.
   *
   * The other three pushes announce things Orbit noticed. This one announces something only the
   * agent knows — it hit a decision it can't make, it finished the part you were waiting on, it
   * found the thing you asked it to look for — which until now had nowhere to go but a transcript
   * nobody is reading. That is also why it is not fire-and-forget like the others: the agent gets
   * the outcome back, so it can say "I've pinged you" only when somebody was actually pinged, and
   * knows to keep working rather than wait when nobody was.
   *
   * Three things can refuse it, and each is reported rather than swallowed:
   * the account turned agent notifications off, no device is registered, or this session already
   * rang within `AGENT_NOTIFY_MIN_INTERVAL_MS`. The rate limit exists because the interrupt budget
   * is per-person while the number of agents running is not — the same reason `settleAlert` is as
   * narrow as it is — and a dropped message is not lost, only unannounced: it stays in the
   * session's transcript, where the user reads it when they arrive.
   *
   * No badge: that count means "sessions needing your reply", and an agent talking is not one.
   */
  async notifyAgentMessage(input: {
    ownerId: string;
    /** The session the agent is running in; absent for a headless `orbit notify`. */
    sessionId?: string;
    /** Alert title when there is no session to take it from (the runner's name). */
    fallbackTitle: string;
    message: string;
  }): Promise<AgentNotifyResult> {
    const alert = agentAlert(input.message);
    if (!alert) return { delivered: false, reason: 'message is empty' };
    if (!this.enabled) return { delivered: false, reason: 'push is not configured on this server' };
    try {
      let title = input.fallbackTitle;
      if (input.sessionId) {
        // Scoped to the owner the runner token authenticated: a session id from another account
        // reads as absent rather than as a session whose title we would then leak.
        const session = await this.prisma.session.findFirst({
          where: { id: input.sessionId, ownerId: input.ownerId },
          select: { title: true },
        });
        if (!session) return { delivered: false, reason: 'session not found' };
        title = session.title || input.fallbackTitle;
      }
      const user = await this.prisma.user.findUnique({
        where: { id: input.ownerId },
        select: { preferences: true },
      });
      const prefs = (user?.preferences ?? {}) as { notifyAgentMessage?: boolean };
      if (prefs.notifyAgentMessage === false) {
        return { delivered: false, reason: 'this account has turned agent notifications off' };
      }

      const key = input.sessionId ?? `owner:${input.ownerId}`;
      const now = Date.now();
      for (const [k, at] of this.lastAgentNotify) {
        if (now - at >= AGENT_NOTIFY_MIN_INTERVAL_MS) this.lastAgentNotify.delete(k);
      }
      const last = this.lastAgentNotify.get(key);
      if (last !== undefined) {
        const wait = Math.ceil((AGENT_NOTIFY_MIN_INTERVAL_MS - (now - last)) / 1000);
        return { delivered: false, reason: `rate limited — try again in ${wait}s` };
      }

      const tokens = await this.prisma.deviceToken.findMany({ where: { userId: input.ownerId } });
      if (tokens.length === 0) {
        return { delivered: false, reason: 'no devices are registered for this account' };
      }
      const auth = this.authToken();
      if (!auth) return { delivered: false, reason: 'push is not configured on this server' };

      const body = JSON.stringify({
        aps: {
          alert: { title, body: alert.body },
          sound: 'default',
          // The category the clients register with a Reply action, so an agent's question can be
          // answered from the banner without opening the app — which is the whole point of asking.
          // Only with a session: without one there is nothing to reply into.
          ...(input.sessionId
            ? { category: 'ORBIT_SESSION', 'thread-id': input.sessionId }
            : { 'thread-id': `owner-${input.ownerId}` }),
        },
        // OrbitKit Notifications.keySession — routes the tap to this session. Omitted headless,
        // where the clients correctly ignore a payload that names no session.
        ...(input.sessionId ? { sessionID: input.sessionId } : {}),
        kind: 'agent-message',
      });

      // Recorded before the round-trip: an APNs call that is slow or fails still consumed this
      // session's turn to interrupt, and retrying it in a tight loop is exactly what the limit is for.
      this.lastAgentNotify.set(key, now);
      const devices = await this.deliver(tokens, body, 'alert', '10', auth);
      if (devices === 0) return { delivered: false, reason: 'no device accepted the notification' };
      return { delivered: true, devices, ...(alert.truncated ? { truncated: true } : {}) };
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`agent notify failed: ${message}`);
      return { delivered: false, reason: `push failed: ${message}` };
    }
  }

  /**
   * Attempt the retryable device projection of an already-delivered in-app judgment item.
   *
   * Unlike the fire-and-forget session pushes, every refusal is returned in a closed shape for the
   * persistent delivery ledger. No preference switch can erase the underlying responsibility: a
   * person may have no device or APNs may be unavailable, but their in-app item remains delivered
   * and this projection remains retryable.
   */
  async deliverJudgmentRequest(input: JudgmentAlertInput): Promise<JudgmentPushResult> {
    const alert = judgmentAlert(input);
    if (!this.enabled) {
      return {
        outcome: 'BLOCKED',
        code: 'PUSH_NOT_CONFIGURED',
        requiredAction: 'CONFIGURE_APNS',
        error: 'APNs is not configured on this server.',
        payload: alert.payload,
      };
    }
    try {
      const tokens = await this.prisma.deviceToken.findMany({
        where: { userId: input.recipientId },
      });
      if (tokens.length === 0) {
        return {
          outcome: 'BLOCKED',
          code: 'NO_DEVICES',
          requiredAction: 'REGISTER_DEVICE',
          error: 'No device is registered for this account.',
          payload: alert.payload,
        };
      }
      const auth = this.authToken();
      if (!auth) {
        return {
          outcome: 'BLOCKED',
          code: 'PUSH_NOT_CONFIGURED',
          requiredAction: 'CONFIGURE_APNS',
          error: 'APNs is not configured on this server.',
          payload: alert.payload,
        };
      }
      const devices = await this.deliver(
        tokens,
        alert.encoded,
        'alert',
        '10',
        auth,
        alert.collapseId,
      );
      if (devices === 0) {
        return {
          outcome: 'RETRY',
          code: 'PUSH_NOT_ACCEPTED',
          requiredAction: 'RETRY_PUSH',
          error: 'No registered device accepted the notification.',
          payload: alert.payload,
        };
      }
      return { outcome: 'DELIVERED', devices, payload: alert.payload };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`judgment push failed: ${message}`);
      return {
        outcome: 'RETRY',
        code: 'PUSH_FAILED',
        requiredAction: 'RETRY_PUSH',
        error: message,
        payload: alert.payload,
      };
    }
  }

  /** Session IDs that currently "need your reply" for this owner — the badge is this set's size.
   *  Mirrors the client's SessionGrouping.needsYou exactly: an Open, non-ending RUNNING session
   *  with at least one PENDING approval. Counting sessions (not approval rows) keeps the badge equal
   *  to what the app shows, and excludes approvals on completed, trashed, or ending sessions. */
  async needsYouSessions(ownerId: string): Promise<string[]> {
    const rows = await this.prisma.session.findMany({
      where: {
        ownerId,
        status: RunStatus.RUNNING,
        completedAt: null,
        archivedAt: null,
        deletedAt: null,
        cancelRequestedAt: null,
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

  /** Fan a prepared payload out to a set of device tokens, pruning any APNs reports as dead.
   *  `collapseId`, when given, makes a repeat of the same alert replace the delivered one.
   *  Returns how many devices APNs accepted it for — ignored by the fire-and-forget callers,
   *  and what `notifyAgentMessage` reports back to the agent that asked for the push. */
  private async deliver(
    tokens: { token: string; environment: string }[],
    body: string,
    pushType: 'alert' | 'background',
    priority: '10' | '5',
    auth: string,
    collapseId?: string,
  ): Promise<number> {
    const results = await Promise.all(
      tokens.map(async (t) => {
        const host = t.environment === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PROD;
        const res = await this.send(host, t.token, body, auth, pushType, priority, collapseId);
        if (res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'Unregistered') {
          // APNs says this token is dead — drop it so we stop pushing to it.
          await this.prisma.deviceToken.deleteMany({ where: { token: t.token } }).catch(() => {});
        } else if (res.status >= 400) {
          this.log.warn(`APNs ${res.status} ${res.reason ?? ''} for ${t.token.slice(0, 8)}…`);
        }
        return res.status >= 200 && res.status < 300;
      }),
    );
    return results.filter(Boolean).length;
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
    collapseId?: string,
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
        // APNs caps this at 64 bytes; every id built here is well inside it.
        ...(collapseId ? { 'apns-collapse-id': collapseId } : {}),
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
