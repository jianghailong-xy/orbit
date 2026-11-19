import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import * as lark from '@larksuiteoapi/node-sdk';
import { FEISHU_OPEN_PLATFORM_ORIGINS, type FeishuPlatform } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../providers/provider-crypto';
import { FeishuAppService } from './feishu-app.service';
import { FEISHU_REPLICA_ID, FeishuInboxService } from './feishu-inbox.service';
import { SILENT, checkCredentials, feishuClient, openPlatformOrigin, type FeishuAppCredentials } from './feishu-open-platform';
import { backoffMs, feishuTiming, type FeishuTiming } from './feishu-timing';

/**
 * The token trade's codes that say the app itself is gone, after which a connection is not tried again until the app
 * is saved again (§4.4): 10003, an App ID the platform does not know (a deleted app), and 10013, an app whose state is
 * not normal (a disabled one). Both are read from Feishu's error-code tables, not from a real tenant — F0-2's task
 * comment says so — and a wrong secret (10014) is not among them: it backs off and is tried again.
 */
export const FEISHU_APP_GONE_CODES: ReadonlySet<number> = new Set([10003, 10013]);

/** The SDK's own check before it connects; an App ID outside it makes `start()` return without a word. */
const SDK_APP_ID = /^cli_[0-9a-fA-F]{16}$/;

export type FeishuLinkState = 'CONNECTING' | 'CONNECTED' | 'BACKOFF' | 'STOPPED';

/** An app this replica should be connected to, as feishu_app holds it. */
interface Target extends FeishuAppCredentials {
  ownerId: string;
  /** What, when it changes, makes the connection start over: a new secret, platform or account. */
  fingerprint: string;
}

/** Why an attempt failed, in words that carry no credential, and whether Feishu said the app is gone. */
interface Failure {
  error: string;
  gone: boolean;
}

/** One replica's long connection of one app: attempts, backoff, and the drop watch. */
class Link {
  state: FeishuLinkState = 'CONNECTING';
  failures = 0;
  private client?: lark.WSClient;
  private timer?: ReturnType<typeof setTimeout>;
  private watch?: ReturnType<typeof setInterval>;
  private generation = 0;
  private closed = false;

  constructor(
    readonly target: Target,
    private readonly owner: FeishuLinkService,
    private readonly timing: FeishuTiming,
  ) {}

  start(): void {
    this.attempt();
  }

  /** Close for good: no attempt or timer of this link runs again. */
  close(): void {
    this.closed = true;
    this.generation += 1;
    clearTimeout(this.timer);
    clearInterval(this.watch);
    this.dispose();
  }

  private dispose(): void {
    const client = this.client;
    this.client = undefined;
    try {
      client?.close({ force: true });
    } catch {
      // Already closed.
    }
  }

  private attempt(): void {
    if (this.closed) return;
    const generation = ++this.generation;
    this.state = 'CONNECTING';
    void this.owner.report(this);
    const { appId, appSecret, platform } = this.target;
    if (!SDK_APP_ID.test(appId)) {
      void this.failed(generation, { error: `The App ID ${appId} is not in Feishu's format (cli_ and 16 hex digits).`, gone: true });
      return;
    }
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled || generation !== this.generation) return;
      settled = true;
      clearTimeout(this.timer);
      fn();
    };
    const client = new lark.WSClient({
      appId,
      appSecret,
      domain: openPlatformOrigin(platform),
      logger: SILENT,
      // Orbit owns reconnecting (§4.4): a failure backs off from 1 minute, and a drop is noticed by `watch`.
      autoReconnect: false,
      onReady: () => settle(() => void this.connected(generation)),
      onError: (error) => settle(() => void this.classify(generation, error)),
    });
    this.client = client;
    // Every frame reaches Orbit as Feishu's own envelope: the SDK calls `invoke` with it, and what it returns is the
    // frame's acknowledgement — a card callback's synchronous answer included.
    const dispatcher = { invoke: (data: unknown) => this.owner.deliver(this.target.appId, data) };
    void client.start({ eventDispatcher: dispatcher as unknown as lark.EventDispatcher });
    this.timer = setTimeout(
      () => settle(() => void this.failed(generation, { error: `Feishu neither connected nor refused within ${Math.round(this.timing.attemptTimeoutMs / 1000)}s.`, gone: false })),
      this.timing.attemptTimeoutMs,
    );
  }

  private async connected(generation: number): Promise<void> {
    this.state = 'CONNECTED';
    this.failures = 0;
    await this.owner.report(this, { connected: true });
    await this.owner.readBotName(this.target);
    if (generation !== this.generation) return;
    clearInterval(this.watch);
    this.watch = setInterval(() => {
      if (generation !== this.generation || this.client?.getConnectionStatus().state === 'connected') return;
      // Dropped: the platform closed it, or the network did. That is not a failure yet; connect again at once.
      clearInterval(this.watch);
      this.owner.logger.log(`feishu app ${this.target.appId}: the long connection dropped; connecting again`);
      this.dispose();
      this.attempt();
    }, this.timing.watchMs);
  }

  /** The SDK gave up on this attempt: ask the token trade why, in Feishu's own code and words. */
  private async classify(generation: number, error: Error): Promise<void> {
    const check = await checkCredentials(this.target);
    if (generation !== this.generation) return;
    let failure: Failure;
    if (!check.ok && check.code === 'FEISHU_CREDENTIALS_REJECTED') {
      failure = {
        error: `Feishu error ${check.feishuCode}: ${check.feishuMsg || 'no reason given'}`,
        gone: FEISHU_APP_GONE_CODES.has(check.feishuCode),
      };
    } else if (!check.ok) {
      failure = { error: `Orbit could not reach ${new URL(FEISHU_OPEN_PLATFORM_ORIGINS[this.target.platform]).host}: ${check.reason}`, gone: false };
    } else {
      failure = { error: `Feishu refused the long connection: ${error.message}`, gone: false };
    }
    await this.failed(generation, failure);
  }

  private async failed(generation: number, failure: Failure): Promise<void> {
    if (generation !== this.generation || this.closed) return;
    this.dispose();
    this.failures += 1;
    // Never a credential: the secret is cut out of anything that could have echoed it.
    const error = failure.error.split(this.target.appSecret).join('[redacted]').slice(0, 500);
    if (failure.gone) {
      this.state = 'STOPPED';
      this.owner.logger.warn(`feishu app ${this.target.appId}: ${error}. Not reconnecting until the app is saved again.`);
      await this.owner.report(this, { error });
      return;
    }
    const wait = backoffMs(this.failures, this.timing);
    this.state = 'BACKOFF';
    this.owner.logger.warn(`feishu app ${this.target.appId}: ${error}. Attempt ${this.failures + 1} in ${Math.round(wait / 1000)}s.`);
    await this.owner.report(this, { error, nextAttemptAt: new Date(Date.now() + wait) });
    if (generation !== this.generation || this.closed) return;
    this.timer = setTimeout(() => this.attempt(), wait);
  }
}

/**
 * FeishuLink (docs/feishu-bot-design.md §4.4): every replica holds one long connection per app that should be
 * connected — enabled, its App Secret readable, and the administrators' switch on — and Feishu's cluster mode gives each
 * event to one of an app's connections. No leader: a replica that dies leaves the others connected.
 *
 * `reconcile` (every 15 s) compares the links with feishu_app: a new app is connected, an app switched off, removed,
 * replaced, or turned off by the administrators is disconnected, and an app whose secret changed starts over. A failure
 * backs off 1, 2, 4, … minutes, at most an hour, with Feishu's code and message in `feishu_app.last_error` and the
 * replica's `feishu_link` row; Feishu saying the app is gone stops it (STOPPED) until the app is saved again. A connection
 * writes `last_connected_at`, the bot's name, and clears `last_error`; an event writes `last_event_at` (the inbox).
 *
 * Each replica writes only its own feishu_link rows and renews their heartbeat; FeishuAppService counts the fresh
 * CONNECTED ones for the settings page (`connectedReplicas`).
 */
@Injectable()
export class FeishuLinkService implements OnApplicationBootstrap, OnModuleDestroy {
  readonly logger = new Logger('FeishuLink');
  private readonly timing: FeishuTiming = feishuTiming();
  private readonly links = new Map<string, Link>();
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconciling?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly apps: FeishuAppService,
    private readonly inbox: FeishuInboxService,
  ) {}

  onApplicationBootstrap(): void {
    this.tick();
    this.reconcileTimer = setInterval(() => this.tick(), this.timing.reconcileMs);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.timing.heartbeatMs);
    this.reconcileTimer.unref();
    this.heartbeatTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.reconcileTimer);
    clearInterval(this.heartbeatTimer);
    await this.reconciling;
    for (const link of this.links.values()) link.close();
    this.links.clear();
    await this.prisma.feishuLink.deleteMany({ where: { replicaId: FEISHU_REPLICA_ID } }).catch(() => undefined);
  }

  private tick(): void {
    if (this.reconciling || this.stopped) return;
    this.reconciling = this.reconcile()
      .catch((error) => this.logger.warn(`reconciling the Feishu connections failed; trying again: ${(error as Error).message}`))
      .finally(() => {
        this.reconciling = undefined;
      });
  }

  /** Connect what should be, disconnect what should not. */
  async reconcile(): Promise<void> {
    const allowed = await this.apps.allowed();
    const rows = allowed
      ? await this.prisma.feishuApp.findMany({
          where: { enabled: true },
          select: { appId: true, platform: true, appSecretEnc: true, ownerId: true },
        })
      : [];
    const wanted = new Map<string, Target>();
    for (const row of rows) {
      let appSecret: string;
      try {
        appSecret = decryptSecret(row.appSecretEnc);
      } catch {
        continue; // secretUnreadable: nothing to connect with until the owner enters it again (§4.1).
      }
      wanted.set(row.appId, {
        appId: row.appId,
        platform: row.platform as FeishuPlatform,
        appSecret,
        ownerId: row.ownerId,
        fingerprint: `${row.platform}|${row.appSecretEnc}|${row.ownerId}`,
      });
    }
    if (this.stopped) return;
    for (const [appId, link] of this.links) {
      const target = wanted.get(appId);
      if (target && target.fingerprint === link.target.fingerprint) continue;
      link.close();
      this.links.delete(appId);
      await this.prisma.feishuLink.deleteMany({ where: { appId, replicaId: FEISHU_REPLICA_ID } });
      this.logger.log(`feishu app ${appId}: disconnected (${target ? 'its credentials changed' : 'it is off, removed or not allowed'})`);
    }
    for (const [appId, target] of wanted) {
      if (this.links.has(appId)) continue;
      const link = new Link(target, this, this.timing);
      this.links.set(appId, link);
      this.logger.log(`feishu app ${appId}: connecting`);
      link.start();
    }
  }

  /** A frame's event, handed to the inbox; what it resolves with is the acknowledgement's answer. */
  deliver(appId: string, envelope: unknown): Promise<unknown> {
    return this.inbox.record(appId, envelope);
  }

  /**
   * Write a link's state: its feishu_link row, and on the app what the settings page shows — when it connected and no
   * error since, or the error. An app removed meanwhile fails the foreign key, and there is nothing left to tell.
   */
  async report(link: Link, change: { connected?: boolean; error?: string; nextAttemptAt?: Date } = {}): Promise<void> {
    const { appId } = link.target;
    if (this.links.get(appId) !== link) return;
    try {
      const now = new Date();
      await this.prisma.feishuLink.upsert({
        where: { appId_replicaId: { appId, replicaId: FEISHU_REPLICA_ID } },
        create: {
          appId,
          replicaId: FEISHU_REPLICA_ID,
          state: link.state,
          failures: link.failures,
          connectedAt: change.connected ? now : null,
          nextAttemptAt: change.nextAttemptAt ?? null,
          lastError: change.error ?? null,
          heartbeatAt: now,
        },
        update: {
          state: link.state,
          failures: link.failures,
          ...(change.connected ? { connectedAt: now, lastError: null } : {}),
          ...(link.state !== 'CONNECTED' ? { connectedAt: null } : {}),
          nextAttemptAt: change.nextAttemptAt ?? null,
          ...(change.error !== undefined ? { lastError: change.error } : {}),
          heartbeatAt: now,
        },
      });
      if (change.connected) {
        await this.prisma.$executeRaw`UPDATE "feishu_app" SET "last_connected_at" = now(), "last_error" = NULL WHERE "app_id" = ${appId}`;
      } else if (change.error !== undefined) {
        await this.prisma.$executeRaw`UPDATE "feishu_app" SET "last_error" = ${change.error} WHERE "app_id" = ${appId}`;
      }
    } catch (error) {
      this.logger.debug(`feishu app ${appId}: its state was not written: ${(error as Error).message}`);
    }
  }

  /** The bot's name, read once connected (`GET /open-apis/bot/v3/info`); a failure leaves the name it had. */
  async readBotName(target: Target): Promise<void> {
    try {
      const answer = (await feishuClient(target).request({ method: 'GET', url: 'open-apis/bot/v3/info' })) as {
        code?: number;
        bot?: { app_name?: unknown };
      };
      const name = typeof answer?.bot?.app_name === 'string' ? answer.bot.app_name.slice(0, 200) : null;
      if (answer?.code === 0 && name) {
        await this.prisma.$executeRaw`UPDATE "feishu_app" SET "bot_name" = ${name} WHERE "app_id" = ${target.appId}`;
      }
    } catch {
      this.logger.debug(`feishu app ${target.appId}: could not read the bot's name`);
    }
  }

  /** Renew this replica's rows, and drop rows a replica that died left behind an hour ago. */
  private async heartbeat(): Promise<void> {
    try {
      await this.prisma.feishuLink.updateMany({ where: { replicaId: FEISHU_REPLICA_ID }, data: { heartbeatAt: new Date() } });
      await this.prisma.feishuLink.deleteMany({ where: { heartbeatAt: { lt: new Date(Date.now() - 60 * 60_000) } } });
    } catch (error) {
      this.logger.debug(`the Feishu connections' heartbeat was not written: ${(error as Error).message}`);
    }
  }

  /** This replica's links, for a spec. */
  states(): Array<{ appId: string; state: FeishuLinkState; failures: number }> {
    return [...this.links.values()].map((l) => ({ appId: l.target.appId, state: l.state, failures: l.failures }));
  }
}
