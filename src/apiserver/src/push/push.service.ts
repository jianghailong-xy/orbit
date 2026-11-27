import { readByLiveBackgroundJob, runningSubagentCards } from '../sessions/abandoned-approvals';
import { isSessionGenerating } from '../common/session-generating';
import { ENGINE_TURN } from '../common/session-working';
import { RELEASE_FACTS_SELECT } from '../common/session-release';
import { visibleQuestions, questionHolds } from '../sessions/run-question';
import http2 from 'node:http2';
import { randomUUID } from 'node:crypto';
import { TURN_STATE_SELECT, turnStateFilter } from '../sessions/session-turn-state';
import { fitCollapseId } from './collapse-id';
import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { recordRunNotify } from '../sessions/run-notify';
import { runItemHold } from '../projects/run-item-hold';
import { COORDINATOR_PAUSE_SELECT, conversationIsPaused } from '../projects/coordinator-evidence-queue';
import { openFuseEpisodeId } from '../projects/project-fuse';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { Prisma, type DeviceToken } from '@prisma/client';
import { accountSubjectNames } from '../providers/account-health-subject';
import { accountNeedsActionBody } from '../providers/account-health-copy';
import type { AccountNeedsAction } from '../providers/account-health.service';
import { AgentProvider, ENGINE_CLI_NAMES, RUN_NOTICE_MESSAGE_MAX, TRANSLATION_TIMEOUT_MS, uuidToBase62, type LoginEngine } from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { readOwnerItemSessionIds, readOwnerRequestSessionIds } from '../projects/owner-decision-signal';
import {
  SESSION_ENDING_SELECT,
  conversationIsOver,
  coordinatorUnreachable,
  openItemsNoLongerOwed,
  readCoordinatorReach,
  type SessionEnding,
} from '../projects/project-open-item';
import { agentAlert } from './agent-alert';
import { badgeDiff, BadgeState } from './badge-diff';
import { ownerItemAlert } from './owner-item-alert';
import { ownerRequestAlert, ownerRequestPushCategory, type FiledOwnerRequestKind } from '../owner-requests/owner-request';
import { ownerStarted, settleAlert } from './settle-alert';
import { crossingRequestAlert } from './crossing-request-alert';
import { CARD_SESSION_SELECT, crossingCardSessionId } from '../projects/project-handoff.service';
import { FcmTransport } from './fcm-transport';
import { WebPushTransport, webPushMessage, type WebPushKeys } from './web-push-transport';
import { FeishuTransport, orbitUrl, type FeishuTarget } from './feishu-transport';
import { fcmData } from './fcm-payload';
import { claudeRegionPushBody, regionMachineName } from '../runners/runner-region';
import { HELD_TURN_STATUS, translationLanguages } from '../sessions/turn-translation';
import { waitForCardTranslation } from '../sessions/card-translation-wait';
import { cardHasText } from '../sessions/reply-translation';
import { isScheduleItemKind } from '../schedules/schedule-attention';
import type { NotifyPriority } from './dto';

const APNS_HOST_PROD = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';
type ApnsEnvironment = 'production' | 'sandbox';
type ApnsCredentials = { keyId: string; p8: string; cached?: { token: string; iat: number } };
const SYNC_DEBOUNCE_MS = 300; // coalesce a burst of resolutions into one silent badge sync
/** How soon a reconcile looks again at a Feishu card another call was drawing (FeishuTransport.closeSettled). */
const FEISHU_BUSY_RETRY_MS = 5_000;
/**
 * Shortest gap between two agent-sent notifications about the same session. Every other push here
 * is edge-triggered by something that happens at most a few times per run; this one fires whenever
 * a model decides to, and a model in a loop decides to a lot. One a minute is far above the rate a
 * milestone actually occurs at and far below the rate that turns a phone into an alarm.
 */
const AGENT_NOTIFY_MIN_INTERVAL_MS = 60_000;

/** Whole seconds until a session that last rang at `rang` may ring again; null when it may now. */
function agentNotifyWait(rang: Date | null, now: Date): number | null {
  if (rang === null) return null;
  const left = AGENT_NOTIFY_MIN_INTERVAL_MS - (now.getTime() - rang.getTime());
  return left > 0 ? Math.ceil(left / 1000) : null;
}

/** The held-message push's body (frame 4B of docs/ux/translation-failure-policy.html). */
export const HELD_MESSAGE_PUSH_BODY = "Your message wasn't sent: it couldn't be translated.";

/** Engine names as the user sees them elsewhere in Orbit (matches the web's RunnerSignIn). */
const ENGINE_LABELS: Record<LoginEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi Code',
  antigravity: 'Antigravity',
  cursor: ENGINE_CLI_NAMES[AgentProvider.CURSOR],
};

/**
 * Why a wakeup the session asked for is not running (docs/long-running-loop-contract.md §4): its runner is
 * offline, its session FAILED, or the turn it was filed onto is waiting in the queue.
 */
export type WakeupMissedReason = 'RUNNER_OFFLINE' | 'SESSION_FAILED' | 'TURN_QUEUED';

const WAKEUP_MISSED_REASONS: Record<WakeupMissedReason, string> = {
  RUNNER_OFFLINE: 'the runner is offline',
  SESSION_FAILED: 'the session failed',
  TURN_QUEUED: 'its turn is queued and has not started',
};

/** What became of an agent's own `notify` call — the answer handed straight back to the agent. */
export interface AgentNotifyResult {
  delivered: boolean;
  recipient?: 'coordinator' | 'owner';
  recipientSessionId?: string;
  placement?: string;
  fallback?: string;
  /** Devices the configured transports accepted it for. Present only when delivered. */
  devices?: number;
  /** The owner's Feishu app took it as a card (docs/feishu-bot-design.md §6.1). Present only when it did. */
  feishu?: boolean;
  /** The message was longer than a notification carries and was cut. */
  truncated?: boolean;
  /** Why nothing was sent. Present only when not delivered, and written to be read by an agent. */
  reason?: string;
}

/**
 * What became of a POST /notify call, as its caller is answered. `reason` is present only when nothing was delivered:
 * PUSH_NOT_CONFIGURED — this server has no APNs or FCM credentials, so it pushes to nobody (not an error); NO_DEVICES —
 * the token's owner has no Orbit app signed in that this server can reach; NOT_ACCEPTED — APNs and FCM took it for none.
 */
export type OwnerNotificationResult =
  | { delivered: true; devices: number }
  | { delivered: false; reason: 'PUSH_NOT_CONFIGURED' | 'NO_DEVICES' | 'NOT_ACCEPTED' };

/**
 * What the Feishu card of an alert that is neither an approval, a settlement, an agent's message nor an owner item says
 * its kind is (docs/feishu-bot-design.md §6.1, last row), by the push's `kind`.
 */
const FEISHU_EVENT_KINDS: Readonly<Record<string, string>> = {
  'engine-signed-out': 'Engine signed out',
  'account-needs-action': 'Account needs action',
  'claude-region-blocked': 'Claude is not available on this runner',
  'runner-updating': 'Runner updating',
  'confirmation-raised': 'Coordinator raised this for your decision',
  'confirmation-problems': 'Problems found after you confirmed',
  'owner-request': 'Request for you',
  'crossing-request': 'Cross-project request',
  'watch-matched': 'Watch matched',
  'loop-missed': 'Wakeup loop missed',
  'wakeup-dropped': 'Scheduled wakeup dropped',
  'wiki-review-mode-manual': 'Wiki switched to Manual',
  'wiki-review-mode-tiered': 'Wiki switched to Tiered',
  'wiki-maintenance-failing': 'Wiki maintenance needs attention',
  'project-orphan': 'Nobody has this',
  'held-message': 'Message not sent',
  schedule: 'Scheduled task',
  condition: 'Condition',
};

/**
 * The sessions that can hold a card raised outside a dispatched turn, which that work leaves parked
 * (docs/session-three-state-design.md §11.3 item 2): the engine's own turn, or a runner-hosted process still up. The
 * process is read off `runningBgShells`, the set `abandoned-approvals.ts` collects a job's card on, not
 * `runningBgJobs`: a card is answerable exactly while the reap would leave it, and the badge rings for no other.
 */
const OUTSIDE_TURN_CARD_SESSIONS: Prisma.SessionWhereInput = {
  OR: [{ AND: [turnStateFilter([null]), ENGINE_TURN.where] }, { runningBgShells: { isEmpty: false } }],
};

/**
 * The cards of such a session somebody still has to answer, on the readers `SessionsService.stillBeingAsked` names: a
 * card that names a background job while that job is in the session's set (`readByLiveBackgroundJob`), and one that
 * names none while the engine's own turn is generating. A job's card whose job has ended is the reap's, never counted.
 * SubAgent cards are the subagent half's and are not selected here.
 */
function outsideTurnCards<T extends { backgroundJobId?: string | null; toolUseId?: string | null }>(
  session: Parameters<typeof isSessionGenerating>[0] & {
    runningBgShells?: readonly string[] | null;
    approvals?: readonly T[] | null;
  },
): T[] {
  const generating = isSessionGenerating(session);
  return (session.approvals ?? []).filter((card) =>
    card.backgroundJobId == null
      ? generating
      : readByLiveBackgroundJob({ backgroundJobId: card.backgroundJobId }, session.runningBgShells ?? []));
}

/**
 * Shared reminder eligibility and reconciliation, with independent transports: APNs, FCM, and the account's own Feishu
 * app (FeishuTransport, docs/feishu-bot-design.md §6.1). Every alert below decides once whether and when to ring, with
 * the same claims for all three; a channel that fails never costs another one its delivery.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  private readonly teamId?: string;
  private readonly bundleId: string;
  private readonly apnsCredentials: Partial<Record<ApnsEnvironment, ApnsCredentials>> = {};
  private readonly blockedApnsEnvironments = new Set<ApnsEnvironment>();
  private readonly fcm: FcmTransport;
  private readonly web: WebPushTransport;
  // Per-owner "needs you" state last pushed to that user's devices, so a reconcile pushes only on a
  // real change and can tell iOS which sessions' banners to clear. In-memory/per-replica; pushes are
  // idempotent so a rare cross-replica double-send is harmless. See docs/cross-platform-badge-sync.md.
  private readonly badgeState = new Map<string, BadgeState>();
  private readonly syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Feishu cards started in the background and not settled yet (`background`). */
  private readonly feishuInFlight = new Set<Promise<unknown>>();
  /** How long an alert quoting an agent's words waits for its card's translation (decision 3A of 'Translate every
   *  owner card'): the translation timeout. A field so specs can shorten it. */
  translationWaitMs = TRANSLATION_TIMEOUT_MS;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Optional() private readonly feishu?: FeishuTransport,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {
    this.teamId = config.get<string>('APNS_TEAM_ID');
    this.bundleId = config.get<string>('APNS_BUNDLE_ID') ?? 'io.orbitd.app';
    for (const environment of ['production', 'sandbox'] as const) {
      const prefix = `APNS_${environment.toUpperCase()}`;
      const specificKey = config.get<string>(`${prefix}_KEY`);
      const specificKeyId = config.get<string>(`${prefix}_KEY_ID`);
      // A partial override must not pair one key's contents with another key's identifier.
      const overridden = Boolean(specificKey || specificKeyId);
      const b64 = overridden ? specificKey : config.get<string>('APNS_KEY');
      const keyId = overridden ? specificKeyId : config.get<string>('APNS_KEY_ID');
      if (this.teamId && b64 && keyId) {
        this.apnsCredentials[environment] = { keyId, p8: Buffer.from(b64, 'base64').toString('utf8') };
      }
    }
    this.fcm = new FcmTransport(config);
    this.web = new WebPushTransport(config);
    if (!this.apnsEnabled) this.log.warn('APNs not configured — iOS pushes disabled');
    if (!this.fcm.enabled) this.log.warn('FCM not configured — Android pushes disabled');
    if (!this.web.enabled) this.log.warn('Web Push not configured — browser pushes disabled');
  }

  private get apnsEnabled(): boolean {
    return Object.keys(this.apnsCredentials).length > 0;
  }

  /** Some device transport (APNs, FCM or Web Push) is configured. */
  private get devicePushEnabled(): boolean {
    return this.apnsEnabled || this.fcm.enabled || this.web.enabled;
  }

  /**
   * Start a Feishu card without waiting for it. FeishuTransport never throws, and with a Feishu outage one card can take
   * its three attempts and their waits (§6.3): a caller that awaits an alert — the watch delivery drain, a request — must
   * not be held by that, nor see APNs/FCM wait on it. Only notifyAgentMessage, which reports whether Feishu took it, awaits.
   */
  private background(work: Promise<unknown> | null | false): void {
    if (!work) return;
    const tracked = work.catch(() => undefined).finally(() => this.feishuInFlight.delete(tracked));
    this.feishuInFlight.add(tracked);
  }

  /** Resolves once every Feishu card started so far has been sent, updated or given up on (specs; a drain at shutdown). */
  async feishuIdle(): Promise<void> {
    while (this.feishuInFlight.size > 0) await Promise.allSettled([...this.feishuInFlight]);
  }

  /** APNs, FCM or Feishu can carry an alert (§6.1). Whether this account has a device or a bound app is `channels`'. */
  private get enabled(): boolean {
    return this.devicePushEnabled || Boolean(this.feishu);
  }

  /** The account's registered devices, and its Feishu app when alerts reach its owner there. */
  private async channels(ownerId: string): Promise<{ tokens: DeviceToken[]; feishu: FeishuTarget | null }> {
    const [tokens, feishu] = await Promise.all([this.targets(ownerId), this.feishu ? this.feishu.target(ownerId) : null]);
    return { tokens, feishu };
  }

  /** The card of an alert in §6.1's last row: its kind in words, the push's title, and its body (FULL only). */
  private feishuOther(
    feishu: FeishuTarget | null,
    input: { kind: string; title: string; body: string; collapseId?: string; sessionId?: string | null; projectId?: string | null; taskId?: string | null },
  ): Promise<boolean> {
    if (!feishu || !this.feishu) return Promise.resolve(false);
    return this.feishu.post(feishu, {
      collapseKey: input.collapseId ? fitCollapseId(input.collapseId) : `${input.kind}-${randomUUID()}`,
      kind: 'other',
      sessionId: input.sessionId ?? null,
      openUrl: orbitUrl(input),
      render: async () => ({ kind: 'other', eventKind: FEISHU_EVENT_KINDS[input.kind] ?? 'Orbit alert', title: input.title, body: input.body }),
    });
  }

  /** `feishuOther` with the title, body and kind an APNs payload built above already carries. */
  private feishuOfPush(feishu: FeishuTarget | null, body: string): Promise<boolean> {
    if (!feishu) return Promise.resolve(false);
    const payload = JSON.parse(body) as { aps: { alert: { title: string; body: string } }; kind: string };
    return this.feishuOther(feishu, { kind: payload.kind, title: payload.aps.alert.title, body: payload.aps.alert.body });
  }

  /**
   * A card's translation into the owner's language, for an alert that quotes it (decision 3A of 'Translate every
   * owner card'): with the owner's translation on, waited for up to `translationWaitMs` — the card's translation job
   * on this process wakes the wait when it has tried (card-translation-wait.ts) — and null when it failed or was not
   * ready in time, so the alert goes out in the original. With translation off, null at once: nothing waits.
   * `read` answers the card's stored `translation`, or null when there is nothing to wait for (gone, no text).
   */
  private async cardTranslation<T>(
    ownerId: string,
    card: string,
    read: () => Promise<{ translation: unknown } | null>,
  ): Promise<T | null> {
    const langs = await translationLanguages(this.prisma, ownerId).catch(() => null);
    if (!langs) return null;
    const ready = (row: { translation: unknown } | null): boolean =>
      (row?.translation as { lang?: unknown } | null | undefined)?.lang === langs.owner;
    // Waiting starts before the read, so a translation stored in between still wakes it.
    const wait = waitForCardTranslation(card, langs.owner, this.translationWaitMs);
    try {
      let row = await read();
      if (row && !ready(row)) {
        await wait.settled;
        row = await read();
      }
      const translation = row?.translation as { lang?: unknown; failed?: unknown } | null | undefined;
      return row && ready(row) && translation?.failed !== true ? (translation as T) : null;
    } finally {
      wait.cancel();
    }
  }

  private async targets(ownerId: string): Promise<DeviceToken[]> {
    if (!this.devicePushEnabled) return [];
    return this.withLiveSession(await this.prisma.deviceToken.findMany({ where: { userId: ownerId, OR: [
      ...(this.apnsEnabled ? [{ platform: 'ios', bundleId: this.bundleId,
        environment: { in: ['production', 'sandbox'] } }] : []),
      ...(this.fcm.enabled ? [{ platform: 'android', bundleId: this.fcm.packageName,
        environment: 'production' }] : []),
      ...(this.web.enabled ? [{ platform: 'web', bundleId: 'web', environment: 'production' }] : []),
    ] } }));
  }

  /**
   * The registrations whose login session has not ended (docs/push-login-session-design.md): one of
   * its refresh tokens is unrevoked and unexpired. A sign-out, reuse detection or 30 days without a
   * refresh ends it, whether or not the device got its unregister through. A row that names no
   * session predates them and stays.
   */
  private async withLiveSession(rows: DeviceToken[]): Promise<DeviceToken[]> {
    const named = [...new Set(rows.flatMap((row) => (row.loginSessionId ? [row.loginSessionId] : [])))];
    if (named.length === 0) return rows;
    const live = new Set((await this.prisma.refreshToken.findMany({
      where: { loginSessionId: { in: named }, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { loginSessionId: true },
    })).map((token) => token.loginSessionId));
    return rows.filter((row) => !row.loginSessionId || live.has(row.loginSessionId));
  }

  /**
   * Tell the session's owner a tool approval is pending. Fire-and-forget: callers `void` this so a
   * slow/failed APNs round-trip never blocks the runner request that created the approval.
   */
  async notifyApprovalRequest(sessionId: string, approvalId: string, toolName: string, coordinatorFallback = false): Promise<void> {
    if (!this.enabled) return;
    try {
      const gates = { completedAt: null, archivedAt: null, deletedAt: null, cancelRequestedAt: null };
      const select = { title: true, ownerId: true, notificationsMuted: true, notifyNeedsYou: true, runSource: true };
      const session = await this.prisma.session.findFirst({
        where: {
          id: sessionId,
          // A running turn asks, and so does a SubAgent still running after its parent's turn ended
          // (docs/subagent-design.md §5.3); the "needs you" set below decides whether this card is one.
          OR: [turnStateFilter(['IN_FLIGHT']), { runningSubagents: { isEmpty: false } }],
          ...gates,
        },
        select,
      }) ?? await this.prisma.session.findFirst({
        // And so does work outside a dispatched turn, on a session still at AWAITING_INPUT: a background job, or a turn
        // the engine started itself (docs/session-three-state-design.md §11.3 item 2). Asked second, and only when the
        // first finds nothing, so the ordinary RUNNING approval still costs one read.
        where: { id: sessionId, ...OUTSIDE_TURN_CARD_SESSIONS, ...gates },
        select,
      });
      if (!session) return;
      // A scheduled task's run rings through its Waiting on you item instead (schedules/schedule-attention.ts).
      if (session.runSource === 'SCHEDULE') return;
      // The session's own switches (Settings → Notifications): muted silences it, and 'off' turns this alert off. There
      // is no account preference for it, so inherit keeps it on. Decided before the stretch is claimed, so a silenced
      // approval leaves `alerted_approval_at` where it was, and the next stretch still rings once the switch is back.
      if (session.notificationsMuted || session.notifyNeedsYou === 'off') return;

      // App-icon badge = the owner's sessions that need a reply (the authoritative count, shared
      // with the in-app "needs you" list and the silent sync below). Record it so a follow-up
      // reconcile won't re-push this same value. See docs/cross-platform-badge-sync.md.
      const ids = await this.needsYouSessions(session.ownerId);
      // Completion can race this fire-and-forget path after the approval is created. Requiring the
      // target to remain in the authoritative set prevents a stale alert from being delivered.
      if (!ids.includes(sessionId)) return;
      const { tokens, feishu } = await this.channels(session.ownerId);
      if (tokens.length === 0 && !feishu) return;
      this.badgeState.set(session.ownerId, { badge: ids.length, sessions: new Set(ids) });
      // A turn asking permission for several tools at once creates an approval apiece, and each one
      // lands here. The badge counts sessions, so it hasn't moved, and the app coalesces them into a
      // single "N pending" row — only the alerts didn't coalesce, so a parallel tool call rang the
      // phone once per tool. Alert on the session's 0 → pending edge, which is the transition the
      // clients notify on too (SessionDelta.diff). Decided on the session row, not in this process's
      // memory: the approvals of one turn can reach different apiservers, and each used to ring once.
      if (!coordinatorFallback && !(await this.claimApprovalAlert(sessionId, approvalId))) {
        // Feishu shows the stretch on one card, each approval with its own buttons (§6.2): one that did not open the
        // stretch is added to the card the opening one sent, rather than sending a second.
        if (feishu && this.feishu) this.background(this.feishu.joinApprovalStretch(feishu, sessionId, approvalId));
        return;
      }
      const badge = ids.length;

      const body = JSON.stringify({
        aps: {
          alert: { title: session.title || 'Orbit', body: `${coordinatorFallback ? 'Not reviewed by the coordinator · ' : ''}Needs your reply · ${toolName}` },
          sound: 'default',
          badge,
          category: 'ORBIT_APPROVAL', // matches OrbitKit Notifications.approvalCategory
          'thread-id': sessionId,
        },
        sessionID: sessionId, // OrbitKit Notifications.keySession — routes the tap to this session
        kind: 'approval',
      });

      const transport = this.feishu;
      this.background(feishu && transport
        ? (async () => {
          // A FULL card quotes the agent's words: it waits for the approval's translation as the owner cards do (3A),
          // and draws approval.translation when there is one. The phone's banner names only the tool, and never waits.
          if (feishu.detail === 'FULL') await this.approvalTranslation(session.ownerId, approvalId);
          return transport.post(feishu, transport.approvalCard(feishu, sessionId, approvalId, coordinatorFallback));
        })()
        : null);

      await this.deliver(tokens, body, 'alert', '10');
    } catch (err) {
      this.log.warn(`push notify failed: ${(err as Error).message}`);
    }
  }

  /** Waits (cardTranslation) for an approval card's translation, when it has words to translate. */
  private async approvalTranslation(ownerId: string, approvalId: string): Promise<void> {
    await this.cardTranslation(ownerId, `approval:${approvalId}`, async () => {
      const approval = await this.prisma.approval.findFirst({
        where: { id: approvalId, status: 'PENDING' },
        select: { input: true, toolName: true, translation: true },
      });
      return approval && cardHasText(approval.input, approval.toolName) ? { translation: approval.translation } : null;
    });
  }

  /**
   * Whether this approval is the session's 0 → pending edge and nobody has rung for it yet; true
   * claims the alert. Decided on the session row, so one turn's approvals ring once between every
   * apiserver that took them:
   *
   *   - The approval opens a stretch of pending approvals when no other approval of the session was
   *     pending as it was asked: none asked before it (by created_at, then id) is still pending, or
   *     was answered after it was asked.
   *   - `alerted_approval_at` is the created_at of the approval the last alert was for, and only
   *     moves forward. A stretch's first approval is asked after every earlier stretch's, so it is
   *     past that mark unless its own stretch has rung already. That is what stops a second alert
   *     when two approvals of one stretch both look like its first: the one asked first had not
   *     committed yet when the other was decided.
   *
   * The row lock comes first and the decision after it, in a statement of its own, so each decision
   * reads every approval committed before it held the lock: of two approvals asked together,
   * whichever is decided second sees the other.
   */
  private async claimApprovalAlert(sessionId: string, approvalId: string): Promise<boolean> {
    return withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "session" WHERE "id" = ${sessionId}::uuid FOR NO KEY UPDATE`;
      const candidates = await tx.approval.findMany({ where: { sessionId, toolName: 'AskUserQuestion', status: 'PENDING' }, select: { id: true, toolName: true } });
      const holds = await questionHolds(tx, candidates.map(a => a.id));
      const held = [...holds].filter(([, h]) => h?.place === 'HELD').map(([id]) => id);
      const claimed = await tx.$executeRaw`
        UPDATE "session" AS s SET "alerted_approval_at" = x."created_at"
          FROM "approval" AS x
         WHERE s."id" = ${sessionId}::uuid AND x."id" = ${approvalId}::uuid AND x."session_id" = s."id"
           AND (s."alerted_approval_at" IS NULL OR s."alerted_approval_at" < x."created_at")
           AND NOT EXISTS (
             SELECT 1 FROM "approval" AS a
              WHERE a."session_id" = s."id" AND a."id" <> x."id"
                AND (a."created_at", a."id") < (x."created_at", x."id")
                AND NOT (a."id" = ANY(${held}::uuid[]))
                AND a."decided_credential_kind" IS DISTINCT FROM 'COORDINATOR'
                AND (a."status" = 'PENDING' OR a."decided_at" > x."created_at"))`;
      return claimed === 1;
    }, loggedRetry(this.log, 'push.claimApprovalAlert'));
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
      const { tokens, feishu } = await this.channels(runner.ownerId);
      if (tokens.length === 0 && !feishu) return;
      const alert = {
        title: runner.displayName || runner.name || 'Orbit',
        body: `${ENGINE_LABELS[engine]} signed out — sessions on this runner won't start until you sign in again.`,
      };
      const body = JSON.stringify({
        aps: {
          alert,
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

      this.background(this.feishuOther(feishu, { kind: 'engine-signed-out', ...alert }));

      await this.deliver(tokens, body, 'alert', '10');
    } catch (err) {
      this.log.warn(`engine sign-out notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * An account refused runs and needs the owner (docs/routing-account-health-design.md §8). Sent once per state change
   * by AccountHealthService.recordFailure, which decides when; this only says it. Title: the runner's name (or a key's
   * provider label). Same shape as notifyEngineSignedOut: no badge, no session id, thread `runner-<id>`; a key has no
   * runner, so its thread is `account-<subjectKey>`. The payload carries what a client needs to open the account row and
   * to call `POST /account-health/:id/check` from it: `accountHealthID`, `subjectKey`, `failureKind`, `blockedUntil`.
   */
  async notifyAccountNeedsAction(ownerId: string, alert: AccountNeedsAction): Promise<void> {
    if (!this.enabled) return;
    try {
      const subject = await accountSubjectNames(this.prisma, ownerId, alert.subjectKey);
      const { tokens, feishu } = await this.channels(ownerId);
      if (tokens.length === 0 && !feishu) return;
      const text = {
        title: subject.title,
        body: accountNeedsActionBody({ product: subject.product, kind: alert.kind, said: alert.said, trips: alert.trips }),
      };
      const body = JSON.stringify({
        aps: { alert: text, sound: 'default', 'thread-id': subject.runnerId ? `runner-${subject.runnerId}` : `account-${alert.subjectKey}` },
        kind: 'account-needs-action',
        ...(subject.runnerId ? { runnerID: subject.runnerId } : {}),
        accountHealthID: alert.rowId,
        subjectKey: alert.subjectKey,
        failureKind: alert.kind,
        ...(alert.blockedUntil ? { blockedUntil: alert.blockedUntil.toISOString() } : {}),
      });
      this.background(this.feishuOther(feishu, { kind: 'account-needs-action', ...text }));
      await this.deliver(tokens, body, 'alert', '10');
    } catch (err) {
      this.log.warn(`account needs action notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * A terminal asks to be approved (docs/terminal-session-design.md, "The terminal credential"): the owner's devices
   * ring with the machine and the code the terminal shows, and the tap opens the approve card. Devices only — the
   * approval is an owner-channel act made signed in to the app, so a Feishu card could not answer it. No badge, and
   * collapsed per request. Fire-and-forget: the request is the fact, `GET /terminals/requests` its read.
   */
  async notifyTerminalLogin(requestId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const request = await this.prisma.terminalLogin.findUnique({
        where: { id: requestId },
        select: { ownerId: true, runnerId: true, machineName: true, userCode: true, status: true },
      });
      if (!request || request.status !== 'PENDING') return;
      const tokens = await this.targets(request.ownerId);
      if (tokens.length === 0) return;
      const alert = { title: 'Approve a terminal?', body: `Terminal on ${request.machineName} · code ${request.userCode}` };
      const body = JSON.stringify({
        aps: { alert, sound: 'default', 'thread-id': `terminal-login-${requestId}` },
        kind: 'terminal-login',
        runnerID: request.runnerId,
        terminalLoginID: requestId,
      });
      await this.deliver(tokens, body, 'alert', '10', `terminal-login-${requestId}`);
    } catch (err) {
      this.log.warn(`terminal login notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Tell a runner's owner that Claude Code can no longer use Anthropic there: a confirmed flip put the machine's Claude
   * connection to Anthropic in `region`, where Anthropic does not offer Claude (docs/claude-region-check-contract.md
   * §10, board 04 "push (flip)"). Edge-triggered by the check route on the blocked check that takes blockedChecks to 2,
   * so one flip is one alert, never one per check. From then on its Anthropic-bound Claude sessions wait in the queue
   * and its running ones stop, and this is the only thing that says so before somebody finds one waiting.
   *
   * About the machine, as notifyEngineSignedOut is: no badge and no sessionID, and a tap opens the runner.
   * Fire-and-forget: the check route `void`s it.
   */
  async notifyClaudeRegionBlocked(runnerId: string, region: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const runner = await this.prisma.runner.findUnique({
        where: { id: runnerId },
        select: { name: true, displayName: true, ownerId: true },
      });
      if (!runner) return;
      const { tokens, feishu } = await this.channels(runner.ownerId);
      if (tokens.length === 0 && !feishu) return;
      const alert = {
        title: runner.displayName || runner.name || 'Orbit',
        body: claudeRegionPushBody(regionMachineName(runner), region),
      };
      const body = JSON.stringify({
        aps: {
          alert,
          sound: 'default',
          'thread-id': `runner-${runnerId}`,
        },
        runnerID: runnerId,
        engine: AgentProvider.CLAUDE,
        kind: 'claude-region-blocked',
      });

      this.background(this.feishuOther(feishu, { kind: 'claude-region-blocked', ...alert }));

      await this.deliver(tokens, body, 'alert', '10');
    } catch (err) {
      this.log.warn(`Claude region notify failed: ${(err as Error).message}`);
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
   * The alert says what the session's recap says whenever one has been written — read at this
   * moment, off the row, so it reflects whichever pass had landed by the time the settlement
   * fired; that decision is `settleAlert`'s, not this method's.
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
          ...RELEASE_FACTS_SELECT,
          retryAt: true,
          completedAt: true,
          deletedAt: true,
          error: true,
          // The rolling recap, when one has been written: `settleAlert` prefers it over the
          // rules line, and falls back to that line when it is null.
          recapText: true,
          notificationsMuted: true,
          notifyTurnFinished: true,
          owner: { select: { preferences: true } },
          runSource: true,
          parentSessionId: true,
          coordinatorForProject: { select: { id: true } },
          task: { select: { project: { select: { coordinatorEnabled: true } } } },
        },
      });
      if (!session) return;
      // A scheduled task's run is not a conversation anybody waits on: what it found or how it failed is told by
      // §7.3's rules (notifySchedule), and a run with nothing new rings nobody.
      if (session.runSource === 'SCHEDULE') return;
      const alert = settleAlert(session);
      if (!alert) return;
      // Muted silences the session; its own 'on' or 'off' wins over the account's switch; inherit (null) reads that.
      if (session.notificationsMuted || session.notifyTurnFinished === 'off') return;
      // Only a session its owner started rings by default: one an agent or a coordinator started is read by
      // whoever started it, and a project's end is told by its own push (notifyProjectDone). The session's
      // own 'on' is the owner asking for this one anyway.
      if (session.notifyTurnFinished !== 'on' && !ownerStarted(session)) return;
      const prefs = (session.owner?.preferences ?? {}) as { notifySessionFinished?: boolean };
      if (session.notifyTurnFinished !== 'on' && prefs.notifySessionFinished === false) return;
      const { tokens, feishu } = await this.channels(session.ownerId);
      if (tokens.length === 0 && !feishu) return;

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
      this.background(feishu ? this.feishuSettled(feishu, sessionId, session.title, alert) : null);
      await this.deliver(tokens, body, 'alert', '10', `settled-${sessionId}`);
    } catch (err) {
      this.log.warn(`settle notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * The owner's message — or a new session's opening message — has been held 60 s after its translation failed, and
   * the owner is not viewing the session (RealtimeService.heldMessageUnseen): one push titled with the session, which
   * opens it. Nothing when the turn is no longer held and FAILED by now (retried, sent as written, withdrawn or
   * translated), or the session is muted. Collapsed on the turn, so a second ring of one turn replaces the first.
   * Fire-and-forget, like the others.
   */
  async notifyHeldMessage(sessionId: string, turnId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const turn = await this.prisma.conversationTurn.findFirst({
        where: { id: turnId, sessionId, status: HELD_TURN_STATUS, translationState: 'FAILED' },
        select: { id: true },
      });
      if (!turn) return;
      const session = await this.prisma.session.findFirst({
        where: { id: sessionId, deletedAt: null },
        select: { title: true, ownerId: true, notificationsMuted: true },
      });
      if (!session || session.notificationsMuted) return;
      const { tokens, feishu } = await this.channels(session.ownerId);
      if (tokens.length === 0 && !feishu) return;
      const title = session.title || 'Orbit';
      const body = JSON.stringify({
        aps: { alert: { title, body: HELD_MESSAGE_PUSH_BODY }, sound: 'default', 'thread-id': sessionId },
        sessionID: sessionId, // OrbitKit Notifications.keySession — routes the tap to this session
        kind: 'held-message',
      });
      const collapseId = `held-${turnId}`;
      this.background(this.feishuOther(feishu, { kind: 'held-message', title, body: HELD_MESSAGE_PUSH_BODY, collapseId, sessionId }));
      await this.deliver(tokens, body, 'alert', '10', collapseId);
    } catch (err) {
      this.log.warn(`held message notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * A settlement's card (§6.1, §6.2): one per settlement, which the two triggers of one settlement (a runner finalize the
   * reaper also force-finalizes, or a give-up after it) update rather than stack. A settlement is the session's latest
   * turn, so a session settled again after another turn gets a card of its own.
   */
  private async feishuSettled(
    feishu: FeishuTarget,
    sessionId: string,
    title: string | null,
    alert: { kind: 'finished' | 'failed'; body: string },
  ): Promise<boolean> {
    if (!this.feishu) return false;
    let seq = 0;
    try {
      seq = (await this.prisma.conversationTurn.findFirst({ where: { sessionId }, orderBy: { seq: 'desc' }, select: { seq: true } }))?.seq ?? 0;
    } catch (err) {
      this.log.warn(`feishu settle card failed: ${(err as Error).message}`);
      return false;
    }
    return this.feishu.post(feishu, {
      collapseKey: `settled-${sessionId}-${seq}`,
      kind: alert.kind,
      sessionId,
      openUrl: orbitUrl({ sessionId }),
      render: async () => ({ kind: alert.kind, sessionTitle: title ?? '', body: alert.body }),
    });
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
   * Four things can refuse it, and each is reported rather than swallowed: the session is muted,
   * the account turned agent notifications off, no device is registered, or this session already
   * rang within `AGENT_NOTIFY_MIN_INTERVAL_MS`. The rate limit exists because the interrupt budget
   * is per-person while the number of agents running is not — the same reason `settleAlert` is as
   * narrow as it is — and a dropped message is not lost, only unannounced: it stays in the
   * session's transcript, where the user reads it when they arrive. The limit is kept on the
   * session row (on the account's, headless), so it holds whichever door the call came through and
   * whichever apiserver took it (claimAgentNotify).
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
  }, alreadyClaimed = false): Promise<AgentNotifyResult> {
    const alert = agentAlert(input.message);
    if (!alert) return { delivered: false, reason: 'message is empty' };
    try {
      let title = input.fallbackTitle;
      // When this session (headless, this account) last rang the owner's devices.
      let rang: Date | null = null;
      if (input.sessionId) {
        // Scoped to the owner the runner token authenticated: a session id from another account
        // reads as absent rather than as a session whose title we would then leak.
        const session = await this.prisma.session.findFirst({
          where: { id: input.sessionId, ownerId: input.ownerId },
          select: { title: true, agentNotifiedAt: true, notificationsMuted: true, task: { select: { id: true, title: true, project: true } } },
        });
        if (!session) return { delivered: false, reason: 'session not found' };
        const project = session.task?.project;
        if (!alreadyClaimed && project?.coordinatorEnabled && project.coordinatorSessionId !== input.sessionId) {
          const now = new Date();
          const wait = agentNotifyWait(session.agentNotifiedAt ?? null, now);
          if (wait !== null) return { delivered: false, reason: `rate limited — try again in ${wait}s` };
          const taken = await this.claimAgentNotify(input, now);
          if (taken !== null) return { delivered: false, reason: `rate limited — try again in ${agentNotifyWait(taken, now) ?? 1}s` };
          const coordinator = project.coordinatorSessionId ? await this.prisma.session.findFirst({
            where: { id: project.coordinatorSessionId, ownerId: input.ownerId }, select: COORDINATOR_PAUSE_SELECT,
          }) : null;
          const dueAt = new Date(now.getTime() + project.exceptionEscalationSeconds * 1000);
          const fused = await openFuseEpisodeId(this.prisma, project.id);
          const hold = runItemHold({
            kind: 'NOTIFY', project: { automatic: true, coordinatorEnabled: true },
            coordinatorSessionId: project.coordinatorSessionId, coordinatorSession: coordinator,
            answered: false, delivery: fused ? 'REFUSED' : 'PENDING', deliveryRefusal: fused ? 'COORDINATOR_PAUSED' : null,
            deliveredTurn: null, stoppedWithoutAnswer: false, dueAt,
          }, now);
          let fallback = hold?.place === 'FALLBACK' ? hold.reason : 'UNREACHABLE';
          if (hold?.place === 'HELD') {
            try {
              const requestId = randomUUID();
              const clientTurnId = `run-notify:v1:${requestId}`;
              const { SessionsService } = await import('../sessions/sessions.service.js');
              const sent = await this.moduleRef!.get(SessionsService, { strict: false }).createTurn(
                input.ownerId, hold.coordinatorSessionId, { clientTurnId, content: '', intent: 'NEXT_TURN' },
                { coalesce: async (tx) => {
                  // createTurn holds the recipient lock: a pause that won the race must not be disarmed.
                  const current = await tx.session.findFirst({
                    where: { id: hold.coordinatorSessionId, ownerId: input.ownerId }, select: COORDINATOR_PAUSE_SELECT,
                  });
                  if (!current || conversationIsOver(current) || conversationIsPaused(current)
                    || await openFuseEpisodeId(tx, project.id)) {
                    throw new ConflictException('The coordinator is unavailable');
                  }
                  return null;
                }, onTurnWritten: async (tx, turn) => {
                  await recordRunNotify(tx, {
                    id: requestId, kind: 'RUN_NOTIFY', ownerId: input.ownerId, fromSessionId: input.sessionId!,
                    toSessionId: hold.coordinatorSessionId, turnId: turn.id, clientTurnId,
                    requestPreview: input.message.trim().slice(0, RUN_NOTICE_MESSAGE_MAX), replyBy: dueAt,
                  });
                } },
              );
              return { delivered: true, recipient: 'coordinator', recipientSessionId: uuidToBase62(hold.coordinatorSessionId), placement: sent.placement };
            } catch (error) {
              this.log.warn(`coordinator notify failed: ${(error as Error).message}`);
              fallback = 'UNREACHABLE';
            }
          }
          const result = await this.notifyAgentMessage({ ...input, message: `Not reviewed by the coordinator · ${input.message.trim()}` }, true);
          return { ...result, recipient: 'owner', fallback };
        }
        // Before the claim, so a muted session spends none of its once-a-minute turn.
        if (session.notificationsMuted) return { delivered: false, reason: 'notifications are muted for this session' };
        title = session.title || input.fallbackTitle;
        rang = session.agentNotifiedAt ?? null;
      }
      if (!this.enabled) return { delivered: false, reason: 'push is not configured on this server' };
      const user = await this.prisma.user.findUnique({
        where: { id: input.ownerId },
        select: { preferences: true, agentNotifiedAt: true },
      });
      const prefs = (user?.preferences ?? {}) as { notifyAgentMessage?: boolean };
      if (prefs.notifyAgentMessage === false) {
        return { delivered: false, reason: 'this account has turned agent notifications off' };
      }
      if (!input.sessionId) rang = user?.agentNotifiedAt ?? null;

      const now = new Date();
      const wait = agentNotifyWait(rang, now);
      if (!alreadyClaimed && wait !== null) return { delivered: false, reason: `rate limited — try again in ${wait}s` };

      const { tokens, feishu } = await this.channels(input.ownerId);
      if (tokens.length === 0 && !feishu) {
        // Nothing to reach this account through. Without device push on this server that is the
        // server's answer, not the account's: registering a device would change nothing.
        return this.devicePushEnabled
          ? { delivered: false, reason: 'no devices are registered for this account' }
          : { delivered: false, reason: 'push is not configured on this server' };
      }

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
      // A call another apiserver recorded since the read above wins, and this one is refused.
      const taken = alreadyClaimed ? null : await this.claimAgentNotify(input, now);
      if (taken !== null) {
        return { delivered: false, reason: `rate limited — try again in ${agentNotifyWait(taken, now) ?? 1}s` };
      }
      const [devices, carded] = await Promise.all([
        this.deliver(tokens, body, 'alert', '10'),
        feishu && this.feishu
          ? this.feishu.post(feishu, {
            collapseKey: `agent-message-${randomUUID()}`,
            kind: 'agent-message',
            sessionId: input.sessionId ?? null,
            openUrl: orbitUrl({ sessionId: input.sessionId }),
            // The whole message: a card has room for more than a banner (FULL only, §6.4).
            render: async () => ({ kind: 'agent-message', sessionTitle: title, message: input.message.trim(), ...(input.sessionId ? {} : { sessionless: true }) }),
          })
          : false,
      ]);
      if (devices === 0 && !carded) return { delivered: false, reason: 'no device accepted the notification' };
      return { delivered: true, devices, ...(carded ? { feishu: true } : {}), ...(alert.truncated ? { truncated: true } : {}) };
    } catch (err) {
      const message = (err as Error).message;
      this.log.warn(`agent notify failed: ${message}`);
      return { delivered: false, reason: `push failed: ${message}` };
    }
  }

  /**
   * POST /notify (push/notify.controller.ts): a notification someone holding the owner's `notify` token sent, pushed to
   * that owner's own iOS and Android apps and no one else's. Only APNs and FCM: the account's Feishu app is not a device.
   * No badge, no session: the tap opens Orbit. The caller's rate limit is the controller's. A transport failure is a
   * device that did not accept it, so this answers rather than throws.
   */
  async notifyOwner(ownerId: string, input: { title: string; message: string; priority: NotifyPriority; url?: string }): Promise<OwnerNotificationResult> {
    if (!this.devicePushEnabled) return { delivered: false, reason: 'PUSH_NOT_CONFIGURED' };
    const tokens = await this.targets(ownerId);
    if (tokens.length === 0) return { delivered: false, reason: 'NO_DEVICES' };
    const body = JSON.stringify({
      aps: {
        alert: { title: input.title, body: input.message },
        ...(input.priority === 'low' ? {} : { sound: 'default' }),
        ...(input.priority === 'high' ? { 'interruption-level': 'time-sensitive' } : {}),
        'thread-id': 'orbit-notify',
      },
      kind: 'notify',
      ...(input.url ? { url: input.url } : {}),
    });
    const devices = await this.deliver(tokens, body, 'alert', input.priority === 'low' ? '5' : '10');
    return devices > 0 ? { delivered: true, devices } : { delivered: false, reason: 'NOT_ACCEPTED' };
  }

  /**
   * Take this session's (headless, this account's) once-a-minute turn to ring the owner: one
   * compare-and-set that records `now` only while the last ring is at least the interval old.
   * Null when it is taken; otherwise the ring that holds it, recorded by another call since the
   * caller read the row — on another apiserver, or through the other door (POST /runner/notify,
   * POST /runner/sessions/:id/notify), all of which reach this one row.
   */
  private async claimAgentNotify(input: { ownerId: string; sessionId?: string }, now: Date): Promise<Date | null> {
    const due = new Date(now.getTime() - AGENT_NOTIFY_MIN_INTERVAL_MS);
    const free = { OR: [{ agentNotifiedAt: null }, { agentNotifiedAt: { lte: due } }] };
    const claimed = input.sessionId
      ? await this.prisma.session.updateMany({
          where: { id: input.sessionId, ownerId: input.ownerId, ...free },
          data: { agentNotifiedAt: now },
        })
      : await this.prisma.user.updateMany({ where: { id: input.ownerId, ...free }, data: { agentNotifiedAt: now } });
    if (claimed.count === 1) return null;
    const holder = input.sessionId
      ? await this.prisma.session.findFirst({ where: { id: input.sessionId }, select: { agentNotifiedAt: true } })
      : await this.prisma.user.findUnique({ where: { id: input.ownerId }, select: { agentNotifiedAt: true } });
    return holder?.agentNotifiedAt ?? now;
  }

  /** The projection's successful OPEN → DONE edge, after its compare-and-set commits. */
  async notifyProjectDone(input: {
    ownerId: string; projectId: string; title: string;
    criteriaCount: number;
  }): Promise<void> {
    if (!this.enabled) return;
    const { tokens } = await this.channels(input.ownerId);
    const body = JSON.stringify({
      aps: {
        alert: {
          title: `${input.title} is done`,
          body: `Orbit recorded it: all ${input.criteriaCount} criteria met and on main.`,
        },
        sound: 'default',
        'thread-id': input.projectId,
      },
      kind: 'project-done',
      projectID: input.projectId,
    });
    await this.deliver(tokens, body, 'alert', '10');
  }

  /**
   * Whether the owner item's project has no coordinator to turn to as the push is sent — the same
   * reading the project page draws the card from (`readCoordinatorReach`), so the banner and the
   * card it opens name the same cause. Without the sessions service (a test module that never
   * wired one) it answers false, and the banner says what it always said.
   */
  private async coordinatorUnreachableFor(
    ownerId: string,
    project: { coordinatorSessionId: string | null; coordinatorSession: SessionEnding | null } | null,
  ): Promise<boolean> {
    if (!project) return false;
    if (!this.moduleRef) return false;
    // Loaded where it is used, as the run-notify turn above does: the sessions module imports this one.
    const { SessionsService } = await import('../sessions/sessions.service.js');
    const sessions = this.moduleRef.get(SessionsService, { strict: false });
    return coordinatorUnreachable(await readCoordinatorReach(sessions, ownerId, project));
  }

  /**
   * Tell the account owner that one of the four things only they can answer is waiting
   * (`docs/project-integration-line-contract.md` §7.6 V12).
   *
   * WHY THESE FOUR AND NOTHING ELSE. A project files an item for every exception it hits, and most
   * of them are the coordinator's to work through — a merge conflict, a failed check, a task that
   * died. Pushing those would be ringing a person about work already being done, which is how a
   * notification channel becomes one people turn off. So the owner's phone carries only what stops
   * without them: the merge they confirm, the question their coordinator asked, the exception that
   * became theirs, and the pause they are the only one who can lift (owner decision 10).
   * `ownerItemAlert` is where that rule lives, and an item still with the coordinator answers null.
   *
   * CALLED AFTER THE COMMIT, AND ONLY ON THE EDGE. Every caller has already written the row — the
   * item being opened, or its assignee becoming OWNER — so this re-reads it rather than being told
   * what it says, and an item that was resolved in between simply is not pushed. Fire-and-forget
   * like the others: callers `void` it, and a push that fails never costs the fact that caused it.
   *
   * The badge is left alone on purpose. It counts conversations needing a reply, and these ARE
   * counted there — the coordinator's conversation carries them (`owner-decision-signal.ts`), which
   * is the same number the silent sync reconciles. Setting it here from an item's own read would be
   * a second opinion about a count that has one source.
   */
  async notifyOwnerItem(itemId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const item = await this.prisma.projectOpenItem.findUnique({
        where: { id: itemId },
        select: {
          kind: true,
          state: true,
          assignee: true,
          assigneeReason: true,
          title: true,
          payload: true,
          waitingSince: true,
          escalatedAt: true,
          ownerId: true,
          projectId: true,
          promotionId: true,
          project: {
            select: {
              title: true,
              coordinatorSessionId: true,
              coordinatorSession: { select: { ...SESSION_ENDING_SELECT, retryAt: true } },
            },
          },
        },
      });
      // A resolved item is not waiting on anybody: the owner answered it in another window, or the
      // fact it was about moved on while this call was on its way here. Nor is an open one whose
      // candidate or task has moved on, which nothing closed yet (`openItemOwed`).
      if (!item || item.state !== 'OPEN') return;
      if ((await openItemsNoLongerOwed(this.prisma, [itemId])).size > 0) return;
      const input = {
        ...item,
        projectTitle: item.project?.title ?? null,
        promotion: await this.promotionFor(item.promotionId),
        coordinatorUnreachable: await this.coordinatorUnreachableFor(item.ownerId, item.project),
      };
      let alert = ownerItemAlert(input);
      if (!alert) return;
      const { tokens, feishu } = await this.channels(item.ownerId);
      if (tokens.length === 0 && !feishu) return;
      if (item.kind === 'COORDINATOR_QUESTION') {
        // The body quotes the coordinator's question: in the owner's language when its translation is ready in time.
        const translation = await this.cardTranslation<{ question?: string }>(item.ownerId, `open-item:${itemId}`, async () => {
          const row = await this.prisma.projectOpenItem.findUnique({ where: { id: itemId }, select: { translation: true } });
          return row ? { translation: row.translation } : null;
        });
        if (translation?.question) {
          alert = ownerItemAlert({ ...input, payload: { ...(item.payload as object), question: translation.question } }) ?? alert;
        }
      }

      const body = JSON.stringify({
        aps: {
          alert: { title: alert.title, body: alert.body },
          sound: 'default',
          // Its own category: the clients open the card this item is, which is not what the
          // approval and session categories do with their taps.
          category: 'ORBIT_OWNER_ITEM',
          // One thread per project, so a project that asks twice reads as one conversation.
          'thread-id': item.projectId,
        },
        kind: alert.kind,
        // Where the card is drawn: the project's own coordinator conversation. Omitted when the
        // project has none — the clients ignore a payload naming no session, and an item whose
        // project is not coordinated has no conversation to open (the project page still has it).
        //
        // The BINDING, not the switch, for the reason `readOwnerItemSignals` gives at length: a
        // switched-off coordinator still draws this project's owner items in the conversation bound
        // to it, and this notification is sent exactly when nobody else will take the item, so the
        // tap has to land on the card — the switch decides whether the coordinator may act, never
        // where the card is.
        ...(item.project?.coordinatorSessionId ? { sessionID: item.project.coordinatorSessionId } : {}),
        projectID: item.projectId,
        openItemID: itemId,
      });

      // Collapse on the item: an item can be pushed twice — handed to the owner and then escalated
      // again, or re-announced by a replica that raced — and APNs replaces the delivered banner
      // instead of stacking a second one about the same waiting thing.
      this.background(feishu && this.feishu
          ? this.feishu.post(feishu, {
            // The same grain as the banner: an item announced again updates its card (§6.2).
            collapseKey: `owner-item-${itemId}`,
            kind: 'owner-item',
            sessionId: item.project?.coordinatorSessionId ?? null,
            openItemId: itemId,
            openUrl: orbitUrl({ sessionId: item.project?.coordinatorSessionId, projectId: item.projectId }),
            render: async () => ({ kind: 'owner-item', projectTitle: item.project?.title ?? null, alert }),
          })
          : null);
      await this.deliver(tokens, body, 'alert', '10', `owner-item-${itemId}`);
    } catch (err) {
      this.log.warn(`owner item notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * A session filed an owner request (`OwnerRequestsService.file`). Sent once, after the row commits,
   * and only while it is still PENDING. The banner is the kind ("Decision needed") over the request's
   * own title, cut to a lock-screen line; collapsed on the request, so a replay never stacks a second
   * one. The tap opens the session that asked; the category's actions open the card itself. Best-effort: a failure is logged, never thrown.
   */
  async notifyOwnerRequest(requestId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const request = await this.prisma.ownerRequest.findUnique({
        where: { id: requestId },
        select: { kind: true, state: true, title: true, ownerId: true, askedBySessionId: true, projectId: true },
      });
      if (!request || request.state !== 'PENDING') return;
      const { tokens, feishu } = await this.channels(request.ownerId);
      if (tokens.length === 0 && !feishu) return;
      // The title is the agent's: in the owner's language when its translation is ready in time. A schedule's item is
      // never translated (OwnerRequestsService.queueTranslation), so nothing waits for one.
      const translation = isScheduleItemKind(request.kind) ? null : await this.cardTranslation<{ title?: string }>(
        request.ownerId,
        `owner-request:${requestId}`,
        async () => {
          const row = await this.prisma.ownerRequest.findUnique({ where: { id: requestId }, select: { translation: true } });
          return row ? { translation: row.translation } : null;
        },
      );
      const alert = ownerRequestAlert(request.kind as FiledOwnerRequestKind, translation?.title || request.title);
      const body = JSON.stringify({
        aps: {
          alert,
          sound: 'default',
          // Per kind: the clients' actions open the card on its input, or put it off ("Later").
          category: ownerRequestPushCategory(request.kind as FiledOwnerRequestKind),
          'thread-id': `owner-request-${request.askedBySessionId}`,
        },
        kind: 'owner-request',
        sessionID: request.askedBySessionId,
        ...(request.projectId ? { projectID: request.projectId } : {}),
        ownerRequestID: requestId,
        ownerRequestKind: request.kind,
      });
      this.background(this.feishuOther(feishu, {
        kind: 'owner-request', ...alert, collapseId: `owner-request-${requestId}`,
        sessionId: request.askedBySessionId, projectId: request.projectId,
      }));
      await this.deliver(tokens, body, 'alert', '10', `owner-request-${requestId}`);
    } catch (err) {
      this.log.warn(`owner request notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * A scheduled task's alert (docs/scheduled-tasks-design.md §7.3, schedules/schedule-attention.ts): a new finding,
   * a failure, a hold, a run's card, a run's widen, a run ending its schedule, a missed one-off. Decided and written by
   * the schedule's code; this only rings. The tap opens the run's session (`sessionID`) or the schedule
   * (`scheduleID`); `ownerRequestID` names the Waiting on you item when there is one. Collapsed on the alert's own id,
   * so a replay never stacks. Best-effort: a failure is logged, never thrown.
   */
  async notifySchedule(alert: {
    kind: string;
    ownerId: string;
    scheduleId: string;
    opens: { sessionId: string } | { scheduleId: string };
    ownerRequestId: string | null;
    title: string;
    body: string;
    collapseId: string;
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      const { tokens, feishu } = await this.channels(alert.ownerId);
      if (tokens.length === 0 && !feishu) return;
      const sessionId = 'sessionId' in alert.opens ? alert.opens.sessionId : null;
      const body = JSON.stringify({
        aps: {
          alert: { title: alert.title, body: alert.body },
          sound: 'default',
          'thread-id': `schedule-${alert.scheduleId}`,
        },
        kind: 'schedule',
        scheduleKind: alert.kind,
        scheduleID: alert.scheduleId,
        ...(sessionId ? { sessionID: sessionId } : {}),
        ...(alert.ownerRequestId ? { ownerRequestID: alert.ownerRequestId } : {}),
      });
      this.background(this.feishuOther(feishu, {
        kind: 'schedule', title: alert.title, body: alert.body, collapseId: alert.collapseId, sessionId,
      }));
      await this.deliver(tokens, body, 'alert', '10', alert.collapseId);
    } catch (err) {
      this.log.warn(`schedule notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * A cross-project request an agent just filed, waiting on the account owner (`ProjectHandoffService
   * .declare`, once, after the commit). The tap opens the conversation that draws its decision card
   * (`crossingCardSessionId`) — the target's coordinator, or the source's for a task asked to be
   * taken out of every project — else the project page that lists it. Every word is Orbit's: the
   * projects' titles and the request's own title, never the agent's reason.
   */
  async notifyCrossingRequest(handoffId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const row = await this.prisma.projectHandoffApproval.findUnique({
        where: { id: handoffId },
        select: {
          ...CARD_SESSION_SELECT,
          ownerId: true,
          state: true,
          kind: true,
          title: true,
          fromProjectId: true,
          fromProject: { select: { title: true, coordinatorSessionId: true, coordinatorSession: { select: { deletedAt: true } } } },
          toProject: { select: { title: true, coordinatorSessionId: true, coordinatorSession: { select: { deletedAt: true } } } },
        },
      });
      if (!row || row.state !== 'PENDING') return;
      const { tokens, feishu } = await this.channels(row.ownerId);
      if (tokens.length === 0 && !feishu) return;
      // The request's title is the agent's: in the owner's language when its translation is ready in time.
      const translation = await this.cardTranslation<{ title?: string }>(row.ownerId, `crossing:${handoffId}`, async () => {
        const stored = await this.prisma.projectHandoffApproval.findUnique({ where: { id: handoffId }, select: { translation: true } });
        return stored ? { translation: stored.translation } : null;
      });
      const alert = crossingRequestAlert({ ...row, title: translation?.title || row.title });
      const sessionId = crossingCardSessionId(row);
      const projectId = row.toProjectId ?? row.fromProjectId;
      const body = JSON.stringify({
        aps: { alert, sound: 'default', 'thread-id': `crossing-request-${sessionId ?? projectId}` },
        kind: 'crossing-request',
        ...(sessionId ? { sessionID: sessionId } : {}),
        projectID: projectId,
        handoffID: handoffId,
      });
      this.background(this.feishuOther(feishu, {
        kind: 'crossing-request', ...alert, collapseId: `crossing-request-${handoffId}`, sessionId, projectId,
      }));
      await this.deliver(tokens, body, 'alert', '10', `crossing-request-${handoffId}`);
    } catch (err) {
      this.log.warn(`crossing request notify failed: ${(err as Error).message}`);
    }
  }

  /** The candidate a merge approval is about: which branches, and how many tasks it carries.
   *  Read only for that one kind — every other item names no promotion. */
  private async promotionFor(
    promotionId: string | null,
  ): Promise<{ sourceRef: string; upstreamRef: string; taskCount: number } | null> {
    if (!promotionId) return null;
    const row = await this.prisma.projectPromotion.findUnique({
      where: { id: promotionId },
      select: { sourceRef: true, upstreamRef: true, includedTaskIds: true },
    });
    if (!row) return null;
    return {
      sourceRef: row.sourceRef,
      upstreamRef: row.upstreamRef,
      taskCount: row.includedTaskIds.length,
    };
  }

  /**
   * A task's reviewer found problems after its owner had confirmed it
   * (docs/owner-confirmation-review-contract.md §9 L5). The caller sends it once, after the PROBLEMS
   * record commits and only while the task is DONE; a request carries at most one such record, and
   * the banner collapses on it all the same. Every word is Orbit's — the task's title and how many
   * problems — and none is the reviewer's. No badge: a settled task is not waiting on anybody.
   * The tap opens the run's session, where the receipt the problems hang under is drawn.
   */
  /** §13 A6: only the first REVIEW ending a coordinator hold calls this, after commit. */
  async notifyConfirmationRaised(recordId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const record = await this.prisma.taskOwnerConfirmationReviewRecord.findUnique({
        where: { id: recordId },
        select: { kind: true, ownerId: true, taskId: true, body: true,
          task: { select: { title: true } },
          review: { select: { request: { select: { sessionId: true } } } } },
      });
      if (!record || record.kind !== 'REVIEW') return;
      const count = ((record.body ?? {}) as { needsYou?: unknown[] }).needsYou?.length ?? 0;
      const { tokens, feishu } = await this.channels(record.ownerId);
      if (tokens.length === 0 && !feishu) return;
      const alert = { title: record.task.title, body: count
        ? `Coordinator raised this for your decision · ${count} to decide`
        : 'Coordinator raised this for your confirmation' };
      const collapseId = `confirmation-raised-${recordId}`;
      const body = JSON.stringify({
        aps: { alert, sound: 'default', 'thread-id': `task-${record.taskId}` },
        kind: 'confirmation-raised', sessionID: record.review.request.sessionId,
        taskID: record.taskId, recordID: recordId,
      });
      this.background(this.feishuOther(feishu, { kind: 'confirmation-raised', ...alert,
        collapseId, sessionId: record.review.request.sessionId }));
      await this.deliver(tokens, body, 'alert', '10', collapseId);
    } catch (err) {
      this.log.warn(`confirmation raised notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * The orphan sweep found a pending item of a project with no coordinator to tell: nobody can move it,
   * or the one who can was never told (docs/evidence-always-has-an-addressee-design.md §4). Called once
   * per orphan, after the sweep's ledger row committed (`ProjectOrphanSweepService`), so a push that
   * fails is not tried again: the item stays on `GET /projects/:id/pending-addressees`.
   */
  async notifyProjectOrphan(input: {
    ownerId: string; projectId: string; noticeId: string; title: string; body: string;
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      const { tokens, feishu } = await this.channels(input.ownerId);
      if (tokens.length === 0 && !feishu) return;
      const alert = { title: input.title, body: input.body };
      const collapseId = `project-orphan-${input.noticeId}`;
      const body = JSON.stringify({
        aps: { alert, sound: 'default', 'thread-id': input.projectId },
        kind: 'project-orphan', projectID: input.projectId,
      });
      this.background(this.feishuOther(feishu, { kind: 'project-orphan', ...alert, collapseId, projectId: input.projectId }));
      await this.deliver(tokens, body, 'alert', '10', collapseId);
    } catch (err) {
      this.log.warn(`project orphan notify failed: ${(err as Error).message}`);
    }
  }

  async notifyConfirmationProblems(recordId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const record = await this.prisma.taskOwnerConfirmationReviewRecord.findUnique({
        where: { id: recordId },
        select: {
          kind: true,
          ownerId: true,
          taskId: true,
          body: true,
          task: { select: { title: true } },
          review: { select: { request: { select: { sessionId: true } } } },
        },
      });
      if (!record || record.kind !== 'PROBLEMS') return;
      const count = ((record.body ?? {}) as { problems?: unknown[] }).problems?.length ?? 0;
      const { tokens, feishu } = await this.channels(record.ownerId);
      if (tokens.length === 0 && !feishu) return;
      const alert = {
        title: record.task.title,
        body: count === 1 ? '1 problem found after you confirmed' : `${count} problems found after you confirmed`,
      };
      const body = JSON.stringify({
        aps: {
          alert,
          sound: 'default',
          'thread-id': `task-${record.taskId}`,
        },
        kind: 'confirmation-problems',
        sessionID: record.review.request.sessionId,
        taskID: record.taskId,
        recordID: recordId,
      });
      this.background(this.feishuOther(feishu, {
          kind: 'confirmation-problems', ...alert, collapseId: `confirmation-problems-${recordId}`,
          sessionId: record.review.request.sessionId,
        }));
      await this.deliver(tokens, body, 'alert', '10', `confirmation-problems-${recordId}`);
    } catch (err) {
      this.log.warn(`confirmation problems notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * A condition that cannot be read (docs/condition-triggers-design.md §5.3, conditions/condition-attention.ts): sent
   * once, when it enters UNKNOWN, and never for RUNNER_ASLEEP. The tap opens the conversation it came from;
   * `ownerRequestID` names its Waiting on you item. Best-effort: a failure is logged, never thrown.
   */
  async notifyCondition(alert: {
    ownerId: string;
    conditionId: string;
    /** The conversation the condition was created from, which the tap opens; null for none. */
    sessionId: string | null;
    ownerRequestId: string | null;
    title: string;
    body: string;
    collapseId: string;
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      const { tokens, feishu } = await this.channels(alert.ownerId);
      if (tokens.length === 0 && !feishu) return;
      const body = JSON.stringify({
        aps: {
          alert: { title: alert.title, body: alert.body },
          sound: 'default',
          'thread-id': `condition-${alert.conditionId}`,
        },
        kind: 'condition',
        conditionID: alert.conditionId,
        ...(alert.sessionId ? { sessionID: alert.sessionId } : {}),
        ...(alert.ownerRequestId ? { ownerRequestID: alert.ownerRequestId } : {}),
      });
      this.background(this.feishuOther(feishu, {
        kind: 'condition', title: alert.title, body: alert.body, collapseId: alert.collapseId, sessionId: alert.sessionId,
      }));
      await this.deliver(tokens, body, 'alert', '10', alert.collapseId);
    } catch (err) {
      this.log.warn(`condition notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * The alert a NOTIFY_USER watch's Match causes (docs/watch-contract.md §6). The delivery worker
   * calls it only after it has acknowledged the delivery, so it runs at most once per generation;
   * collapsed on the watch and generation all the same, so nothing could ever stack a second banner
   * for one. Best-effort like the other pushes: a failure is logged, never thrown.
   *
   * No badge: that count means "sessions needing your reply", and a watch that fired is not one.
   */
  async notifyWatchMatched(input: {
    ownerId: string;
    watchId: string;
    generation: number;
    /** The Match's reason, in the contract's vocabulary. */
    reason: string;
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      const { tokens, feishu } = await this.channels(input.ownerId);
      if (tokens.length === 0 && !feishu) return;
      const body = JSON.stringify({
        aps: {
          alert: { title: 'Watch matched', body: input.reason },
          sound: 'default',
          'thread-id': `watch-${input.watchId}`,
        },
        watchID: input.watchId,
        generation: input.generation,
        kind: 'watch-matched',
      });
      this.background(this.feishuOther(feishu, {
          kind: 'watch-matched', title: 'Watch matched', body: input.reason, collapseId: `watch-${input.watchId}-${input.generation}`,
        }));
      await this.deliver(tokens, body, 'alert', '10', `watch-${input.watchId}-${input.generation}`);
    } catch (err) {
      this.log.warn(`watch notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Tell the owner a wakeup their session asked for is not running (docs/long-running-loop-contract.md §4):
   * a loop none of whose ticks has reached the engine for max(2 × every, 15 minutes) — the dead-man signal —
   * or a one-shot wakeup dropped because its session had FAILED.
   *
   * Once per failure, and that is the caller's to guarantee: for a loop, the scheduled-wakeup worker's
   * compare-and-set on `session_wakeup_loop.alerted_at`, which only a later run of the loop lets fire again;
   * for a one-shot wakeup, the compare-and-set that dropped it. Collapsed on that failure all the same. The
   * tap opens the session. No badge: nothing here is waiting for a reply. Best-effort like the others: a
   * failure is logged, never thrown.
   */
  async notifyLoopMissed(input: {
    ownerId: string;
    sessionId: string;
    /** The session's title, which the alert is titled with as the session's other alerts are. */
    title: string | null;
    /** A loop: how many of its due times have not run since its last run, and when this failure was
     *  alerted. Or a one-shot wakeup, dropped. */
    missed: { loopId: string; ticks: number; alertedAt: Date } | { wakeupId: string };
    reason: WakeupMissedReason;
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      // Feishu only, never a device: nobody has to act on it now, and the session or the space shows it
      // when its owner next looks (a phone banner here was a lock-screen line about Orbit's own housekeeping).
      const { feishu } = await this.channels(input.ownerId);
      if (!feishu) return;
      const { missed } = input;
      const because = WAKEUP_MISSED_REASONS[input.reason];
      const alert = {
        title: input.title || 'Orbit',
        body: 'loopId' in missed
          ? `Wakeup loop missed ${missed.ticks === 1 ? '1 tick' : `${missed.ticks} ticks`}: ${because}.`
          : `Scheduled wakeup dropped: ${because}.`,
      };
      const collapseId = 'loopId' in missed ? `loop-${missed.loopId}-${missed.alertedAt.getTime()}` : `wakeup-${missed.wakeupId}`;
      this.background(this.feishuOther(feishu, {
          kind: 'loopId' in missed ? 'loop-missed' : 'wakeup-dropped', ...alert, collapseId, sessionId: input.sessionId,
        }));
    } catch (err) {
      this.log.warn(`wakeup missed notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Tell the owner a wiki space's spot checks sent it back to Manual (wiki contract
   * `reviewModes.spotChecks.trip`): too many of what its review mode applied at once were rejected.
   *
   * Once per trip, and that is the caller's to guarantee, not this method's: the switch to Manual is a
   * compare-and-set on the space, and only the transaction that won it calls here, after it commits.
   * No badge — nothing here is waiting for a reply. Best-effort like the others: a failure is logged,
   * never thrown, and the space is Manual whether or not the phone rang.
   */
  async notifyWikiReviewModeTripped(input: {
    ownerId: string;
    spaceId: string;
    title: string;
    rejected: number;
    window: number;
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      // Feishu only, never a device: nobody has to act on it now, and the session or the space shows it
      // when its owner next looks (a phone banner here was a lock-screen line about Orbit's own housekeeping).
      const { feishu } = await this.channels(input.ownerId);
      if (!feishu) return;
      const body = JSON.stringify({
        aps: {
          alert: {
            title: 'Wiki switched to Manual',
            body: `${input.title}: ${input.rejected} of the last ${input.window} spot checks were rejected, so `
              + 'nothing applies without your review until you switch the mode back.',
          },
          sound: 'default',
          'thread-id': `wiki-${input.spaceId}`,
        },
        wikiSpaceID: input.spaceId,
        kind: 'wiki-review-mode-manual',
      });
      this.background(this.feishuOfPush(feishu, body));
    } catch (err) {
      this.log.warn(`wiki review-mode notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Tell the owner an Automatic wiki space's verification sent it back to Tiered (wiki contract
   * `reviewModes.verification.fallback`): too many of the latest proposals its verifier checked had
   * no support in their own sources.
   *
   * Once per trip on the same terms as the spot checks' notice above: the switch is a compare-and-set
   * on the space, and only the transaction that won it calls here, after it commits. No badge, and
   * best-effort — the space is Tiered whether or not the phone rang.
   */
  async notifyWikiVerificationTripped(input: {
    ownerId: string;
    spaceId: string;
    title: string;
    unsupported: number;
    window: number;
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      // Feishu only, never a device: nobody has to act on it now, and the session or the space shows it
      // when its owner next looks (a phone banner here was a lock-screen line about Orbit's own housekeeping).
      const { feishu } = await this.channels(input.ownerId);
      if (!feishu) return;
      const body = JSON.stringify({
        aps: {
          alert: {
            title: 'Wiki switched to Tiered',
            body: `${input.title}: ${input.unsupported} of the last ${input.window} verified proposals had no support in `
              + 'their sources, so the space went back to Tiered until you switch it to Automatic again.',
          },
          sound: 'default',
          'thread-id': `wiki-${input.spaceId}`,
        },
        wikiSpaceID: input.spaceId,
        kind: 'wiki-review-mode-tiered',
      });
      this.background(this.feishuOfPush(feishu, body));
    } catch (err) {
      this.log.warn(`wiki verification notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * Tell the owner a wiki space's maintenance run has failed `failures` times in a row (wiki contract
   * `maintenance.health.notify`): nothing new reaches the wiki until a run succeeds.
   *
   * Once per streak, and that is the caller's to guarantee: only the failure report whose increment
   * made the cursor's count exactly the threshold calls here. No badge — nothing is waiting for a
   * reply. Best-effort like the others: the failure is recorded whether or not the phone rang.
   */
  /**
   * The owner's one alert that runs keep reading Claude sessions and find no memory write in them (contract
   * `maintenance.health.notifyNoNotes`). The failing alert's kind and thread: it opens the same space.
   */
  async notifyWikiMemoryWritesQuiet(input: { ownerId: string; spaceId: string; title: string; runs: number }): Promise<void> {
    if (!this.enabled) return;
    try {
      // Feishu only, never a device: nobody has to act on it now, and the session or the space shows it
      // when its owner next looks (a phone banner here was a lock-screen line about Orbit's own housekeeping).
      const { feishu } = await this.channels(input.ownerId);
      if (!feishu) return;
      const body = JSON.stringify({
        aps: {
          alert: {
            title: `Wiki maintenance saw no memory writes in ${input.runs} runs`,
            body: `${input.title}: Claude sessions were read, but none wrote to its memory files. Claude may have changed how it saves them.`,
          },
          sound: 'default',
          'thread-id': `wiki-${input.spaceId}`,
        },
        wikiSpaceID: input.spaceId,
        kind: 'wiki-maintenance-failing',
      });
      this.background(this.feishuOfPush(feishu, body));
    } catch (err) {
      this.log.warn(`wiki memory writes notify failed: ${(err as Error).message}`);
    }
  }

  /**
   * The owner's one alert that maintenance runs keep finding a repository somebody has to set right — another
   * repository's folder, or a credential the remote refused (wiki contract `maintenance.health.notifyRepository`): the
   * failing alert's kind and thread, so it opens the same space, in the reason's own words.
   */
  async notifyWikiRepositoryAttention(input: { ownerId: string; spaceId: string; title: string; runs: number; detail: string }): Promise<void> {
    if (!this.enabled) return;
    try {
      // Feishu only, never a device: nobody has to act on it now, and the session or the space shows it
      // when its owner next looks (a phone banner here was a lock-screen line about Orbit's own housekeeping).
      const { feishu } = await this.channels(input.ownerId);
      if (!feishu) return;
      const detail = input.detail.split('\n', 1)[0]!.trim();
      const body = JSON.stringify({
        aps: {
          alert: {
            title: `Wiki code checks paused for ${input.runs} runs`,
            body: `${input.title}: ${detail.length > 160 ? `${detail.slice(0, 159)}…` : detail}. Fix it in the wiki's Settings.`,
          },
          sound: 'default',
          'thread-id': `wiki-${input.spaceId}`,
        },
        wikiSpaceID: input.spaceId,
        kind: 'wiki-maintenance-failing',
      });
      this.background(this.feishuOfPush(feishu, body));
    } catch (err) {
      this.log.warn(`wiki repository notify failed: ${(err as Error).message}`);
    }
  }

  async notifyWikiMaintenanceFailing(input: {
    ownerId: string;
    spaceId: string;
    title: string;
    failures: number;
    lastError: string | null;
  }): Promise<void> {
    if (!this.enabled) return;
    try {
      // Feishu only, never a device: nobody has to act on it now, and the session or the space shows it
      // when its owner next looks (a phone banner here was a lock-screen line about Orbit's own housekeeping).
      const { feishu } = await this.channels(input.ownerId);
      if (!feishu) return;
      const said = (input.lastError ?? '').split('\n', 1)[0]!.trim();
      const body = JSON.stringify({
        aps: {
          alert: {
            title: `Wiki maintenance failed ${input.failures} times`,
            body: `${input.title}: nothing new reaches the wiki until a run succeeds.`
              + (said ? ` Last error: ${said.length > 160 ? `${said.slice(0, 159)}…` : said}` : ''),
          },
          sound: 'default',
          'thread-id': `wiki-${input.spaceId}`,
        },
        wikiSpaceID: input.spaceId,
        kind: 'wiki-maintenance-failing',
      });
      this.background(this.feishuOfPush(feishu, body));
    } catch (err) {
      this.log.warn(`wiki maintenance notify failed: ${(err as Error).message}`);
    }
  }

  /** Session IDs that currently "need your reply" for this owner — the badge is this set's size.
   *  Mirrors the client's SessionGrouping.needsYou: an Open, non-ending RUNNING session with at
   *  least one PENDING approval, plus the coordinator conversations carrying one of the four owner
   *  items (§7.6 V13). Counting sessions (not approval rows) keeps the badge equal to what the app
   *  shows, and excludes approvals on completed, trashed, or ending sessions.
   *
   *  THE FOUR ARE IN THE SAME COUNT, and that is not a second opinion about them: the session list,
   *  the menu bar and the needs-you banner all read them off the same rows, and a phone whose badge
   *  says 0 above a banner saying "Approve merge to main" is one fact told two ways. Only the four
   *  — an exception the coordinator is still working through is not the owner's and is not counted
   *  (owner decision 10) — which is what `ownerItemKind` decides, in one place.
   *
   *  The owner-item half does not carry the RUNNING gate: a coordinator conversation sits at
   *  AWAITING_INPUT precisely while it is waiting for the answer, which is the state this exists to
   *  make visible. It does carry the same gate a card does — a project with no coordinator bound,
   *  or one whose conversation was filed away, is counted by neither (`readOwnerItemSessionIds`).
   *
   *  The open owner requests (`request_owner_action`) and the waiting task moves are counted the
   *  same way and for the same reason: a card only the owner can answer, on the conversation that
   *  asked (and, for a move, the target project's coordinator) — `readOwnerRequestSessionIds`. */
  async needsYouSessions(ownerId: string): Promise<string[]> {
    const [rows, blockedOnOwner, withSubagents, outsideTurn, askedOfOwner] = await Promise.all([
      this.prisma.session.findMany({
        where: {
          ownerId,
          ...turnStateFilter(['IN_FLIGHT']),
          // A LANDING row never has a turn in flight; named anyway, so no scan can ever count one.
          sessionKind: 'CONVERSATION',
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
          cancelRequestedAt: null,
          approvals: { some: { status: 'PENDING' } },
        },
        select: { id: true, taskId: true, approvals: { where: { status: 'PENDING' }, select: { id: true, toolName: true } } },
      }),
      readOwnerItemSessionIds(this.prisma, ownerId),
      // The conversations, at any status, whose running SubAgent asked a card (docs/subagent-design.md §5.3).
      this.prisma.session.findMany({
        where: {
          ownerId,
          sessionKind: 'CONVERSATION',
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
          cancelRequestedAt: null,
          runningSubagents: { isEmpty: false },
          approvals: { some: { status: 'PENDING', subagentRunId: { not: null } } },
        },
        select: {
          id: true,
          approvals: { where: { status: 'PENDING', subagentRunId: { not: null } }, select: { id: true, toolName: true, subagentRunId: true } },
        },
      }),
      // The conversations whose card was raised outside a dispatched turn, which leaves the status at AWAITING_INPUT
      // (docs/session-three-state-design.md §11.3 item 2): which of their cards count is `outsideTurnCards` below.
      this.prisma.session.findMany({
        where: {
          ownerId,
          sessionKind: 'CONVERSATION',
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
          cancelRequestedAt: null,
          ...OUTSIDE_TURN_CARD_SESSIONS,
          approvals: { some: { status: 'PENDING', subagentRunId: null } },
        },
        select: {
          id: true,
          taskId: true,
          // isSessionGenerating's (common/session-generating.ts).
          ...TURN_STATE_SELECT,
          engineTurnActive: true,
          runningBgShells: true,
          approvals: {
            where: { status: 'PENDING', subagentRunId: null },
            select: { id: true, toolName: true, backgroundJobId: true, toolUseId: true },
          },
        },
      }),
      // The conversations an open owner request or a waiting task move is counted on (MOVE_REQUEST).
      readOwnerRequestSessionIds(this.prisma, ownerId),
    ]);
    const visible = new Set((await visibleQuestions(this.prisma, rows.filter(r => r.taskId).flatMap(r => r.approvals))).map(a => a.id));
    // A running SubAgent's card is a question whatever its parent is doing (docs/subagent-design.md §5.3): a
    // background SubAgent waiting on a person while its parent sits idle needs them as much as a blocked turn.
    const subagentCards = await visibleQuestions(this.prisma, await runningSubagentCards(this.prisma, withSubagents.flatMap(
      (r) => (r.approvals ?? []).map((card: { id: string; toolName: string; subagentRunId?: string | null }) => ({ ...card, sessionId: r.id })),
    )));
    // A turn's card whose call has returned is over (the reap's finished-call rule, `reapApprovalsOfEndedTurns`).
    const turnCalls = (outsideTurn ?? []).flatMap((r) => outsideTurnCards(r)
      .filter((card) => card.backgroundJobId == null && card.toolUseId)
      .map((card) => ({ sessionId: r.id, toolUseId: card.toolUseId as string })));
    const returned = turnCalls.length === 0 ? new Set<string>() : new Set((await this.prisma.toolCall.findMany({
      where: { OR: turnCalls.map((c) => ({ sessionId: c.sessionId, toolUseId: c.toolUseId })), finishedAt: { not: null } },
      select: { sessionId: true, toolUseId: true },
    })).map((call) => `${call.sessionId}:${call.toolUseId}`));
    const outsideTurnIds: string[] = [];
    for (const r of outsideTurn ?? []) {
      const cards = outsideTurnCards(r).filter((card) => !card.toolUseId || !returned.has(`${r.id}:${card.toolUseId}`));
      if (cards.length > 0 && (!r.taskId || (await visibleQuestions(this.prisma, cards)).length > 0)) outsideTurnIds.push(r.id);
    }
    return [...new Set([
      ...rows.filter(r => !r.taskId || r.approvals.some(a => visible.has(a.id))).map(r => r.id),
      ...subagentCards.map(card => card.sessionId),
      ...outsideTurnIds,
      ...blockedOnOwner,
      ...askedOfOwner,
    ])];
  }

  /** Debounced: something that could lower `ownerId`'s "needs you" count happened (an approval
   *  resolved, a session left RUNNING, a session ended — possibly on another device). Coalesce a
   *  burst into one silent sync. Called from RealtimeService.publish() on the event's origin replica. */
  scheduleBadgeSync(ownerId: string): void {
    // The same reconcile closes the owner's Feishu cards that no longer hold (§6.2), so it runs with Feishu alone too.
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
   *  silent badge update to their devices and name the sessions whose banners should be cleared.
   *  Then, from the same "needs you", close the owner's Feishu cards whose matter was settled
   *  elsewhere (docs/feishu-bot-design.md §6.2) — whether or not the badge moved: an approval
   *  answered beside another still pending leaves the count where it was. */
  private async reconcileBadge(ownerId: string): Promise<void> {
    try {
      const delta = badgeDiff(this.badgeState.get(ownerId), await this.needsYouSessions(ownerId));
      if (delta.badge === 0) this.badgeState.delete(ownerId);
      else this.badgeState.set(ownerId, { badge: delta.badge, sessions: delta.sessions });
      if (this.feishu) this.background(this.closeFeishuCards(ownerId, delta.sessions));
      if (delta.changed) await this.syncBadge(ownerId, delta.badge, delta.clearSessions);
    } catch (err) {
      this.log.warn(`badge sync failed: ${(err as Error).message}`);
    }
  }

  /** The Feishu half of the reconcile. A card another call held is looked at again once that call can have let go. */
  private async closeFeishuCards(ownerId: string, needsYou: ReadonlySet<string>): Promise<void> {
    const target = this.feishu ? await this.feishu.target(ownerId) : null;
    if (!target || !this.feishu) return;
    const { busy } = await this.feishu.closeSettled(target, needsYou);
    if (busy) setTimeout(() => this.scheduleBadgeSync(ownerId), FEISHU_BUSY_RETRY_MS).unref?.();
  }

  /** Silent (content-available) push: updates the icon badge with no banner/sound, and carries
   *  `clearSessions` so a backgrounded app can remove the now-stale delivered approval banners. */
  private async syncBadge(ownerId: string, badge: number, clearSessions: string[]): Promise<void> {
    const tokens = await this.targets(ownerId);
    if (tokens.length === 0) return;
    const body = JSON.stringify({
      aps: { 'content-available': 1, badge },
      ...(clearSessions.length ? { clearSessions } : {}),
    });
    await this.deliver(tokens, body, 'background', '5');
  }

  /**
   * Route only eligible registrations; stale failures cannot prune a newer token/account binding.
   * Each send (and FCM retry) first checks the row is unchanged and its login session still live.
   */
  private async deliver(
    tokens: DeviceToken[],
    body: string,
    pushType: 'alert' | 'background',
    priority: '10' | '5',
    rawCollapseId?: string,
  ): Promise<number> {
    const collapseId = rawCollapseId === undefined ? undefined : fitCollapseId(rawCollapseId);
    const data = fcmData(body, pushType, randomUUID(), new Date().toISOString(), collapseId);
    const results = await Promise.all(tokens.map(async (t) => {
      const where = { id: t.id, token: t.token, userId: t.userId, updatedAt: t.updatedAt,
        platform: t.platform, bundleId: t.bundleId, environment: t.environment };
      const isCurrent = async () => Boolean(await this.prisma.deviceToken.findFirst({ where, select: { id: true } }))
        && (await this.withLiveSession([t])).length === 1;
      try {
        if (t.platform === 'android' && this.fcm.enabled && t.bundleId === this.fcm.packageName
          && t.environment === 'production') {
          const res = await this.fcm.send(t.token, { ...data, registrationKey: t.id }, isCurrent);
          if (res.invalidToken) await this.prisma.deviceToken.deleteMany({ where });
          else if (!res.accepted) this.log.warn(`FCM ${res.reason}`);
          return res.accepted;
        }
        if (t.platform === 'web' && this.web.enabled && t.bundleId === 'web' && t.environment === 'production') {
          const message = webPushMessage(body, pushType, collapseId);
          if (!message) return false;
          const res = await this.web.send(t.token, t.webKeys as unknown as WebPushKeys, message, isCurrent);
          if (res.invalidToken) await this.prisma.deviceToken.deleteMany({ where });
          else if (!res.accepted) this.log.warn(`Web Push ${res.reason}`);
          return res.accepted;
        }
        if (t.platform !== 'ios' || !this.apnsEnabled || t.bundleId !== this.bundleId
          || !['sandbox', 'production'].includes(t.environment)) return false;
        const environment = t.environment === 'sandbox' ? 'sandbox' : 'production';
        const host = environment === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PROD;
        if (this.blockedApnsEnvironments.has(environment)) return false;
        if (!this.apnsCredentials[environment]) {
          this.blockedApnsEnvironments.add(environment);
          this.log.warn(`APNs ${environment} (${host}) skipped: no complete credentials configured; configure APNS_${environment.toUpperCase()}_KEY and APNS_${environment.toUpperCase()}_KEY_ID`);
          return false;
        }
        const auth = this.authToken(environment);
        if (!auth || !await isCurrent() || this.blockedApnsEnvironments.has(environment)) return false;
        const res = await this.send(host, t.token, body, auth, pushType, priority, collapseId);
        if (res.status === 403 && res.reason === 'BadEnvironmentKeyInToken') {
          // This rejects the signing key for the host, not the device token. Keep the registration.
          if (!this.blockedApnsEnvironments.has(environment)) {
            this.blockedApnsEnvironments.add(environment);
            this.log.warn(`APNs 403 BadEnvironmentKeyInToken for ${environment} (${host}); further sends skipped until API restart. Configure a key authorized for this environment with APNS_${environment.toUpperCase()}_KEY and APNS_${environment.toUpperCase()}_KEY_ID`);
          }
        } else if (res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'Unregistered') {
          await this.prisma.deviceToken.deleteMany({ where });
        } else if (res.status >= 400) {
          this.log.warn(`APNs ${res.status} ${res.reason ?? ''} for ${environment} (${host})`);
        }
        return res.status >= 200 && res.status < 300;
      } catch {
        this.log.warn(`Push transport failed for ${t.platform}`);
        return false;
      }
    }));
    return results.filter(Boolean).length;
  }

  /** Cached provider JWT (ES256, kid=keyId, iss=teamId). Refreshed well before APNs's 1h limit. */
  private authToken(environment: ApnsEnvironment): string | null {
    const credentials = this.apnsCredentials[environment];
    if (!credentials) return null;
    const now = Math.floor(Date.now() / 1000);
    if (credentials.cached && now - credentials.cached.iat < 3000) return credentials.cached.token;
    const token = jwt.sign({ iss: this.teamId, iat: now }, credentials.p8, {
      algorithm: 'ES256',
      keyid: credentials.keyId,
    });
    credentials.cached = { token, iat: now };
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
        // APNs caps this at 64 bytes; deliver() has already fitted it (fitCollapseId).
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
