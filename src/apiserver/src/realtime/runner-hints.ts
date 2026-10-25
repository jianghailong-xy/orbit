import { randomUUID } from 'node:crypto';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { connect, headers as natsHeaders, nkeyAuthenticator, type NatsConnection, type Subscription } from '@nats-io/transport-node';
import { RunEventType, type NormalizedRunEvent } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { readRunnerLink } from '../runner-api/runner-link-token';
import { normalizeToolOutputEvent } from '../runner-api/tool-output';

/**
 * Hints for the runner link (docs/runner-link-design.md §5.5, §6.3). Each of the three wake signals is also
 * published on NATS, on `rnr.<runnerId>` for the one runner it concerns, where the link gateway holding that runner's
 * connection relays it as a Hint frame:
 *
 *   - a message waiting in a session's inbox (RealtimeService.notifyInbox), for the runner the session is assigned to;
 *   - a session queued for a runner (QueueService.notifySessionQueued), for that runner;
 *   - something a heartbeat delivers (RealtimeService.notifyRunnerWake), for that runner.
 *
 * It is a path beside the in-process EventEmitter and the Postgres NOTIFY that the HTTP long polls park on, never in
 * place of them: those stay as they are until the cut-over (D15), and nothing here changes what an HTTP runner is
 * handed or when.
 *
 * At most once, and best effort. Every caller publishes after the commit it announces, the rule the signals already
 * keep, and a lost hint costs the runner at most a heartbeat interval: the heartbeat carries the same news. So
 * nothing here waits on NATS or throws. While NATS is unreachable a hint is dropped and counted, and the count is
 * logged once a minute, never once per hint. The client would buffer what is published while it reconnects, without
 * bound, so a hint is only published while the connection is up.
 *
 * The live stream (§5.9) rides the same connection, for a runner that works over the link:
 *
 *   - watchers: this instance counts the open streams of each session (`watch`, from RealtimeService.streamForRun).
 *     Each change of a count is published as a WatchersHint for the session's runner, naming this instance in the
 *     Orbit-Instance header, and a count that is not zero is published again every WATCHERS_REFRESH_MS, so the gateway
 *     can sum the instances' counts and let the count of an instance that is gone lapse. The heartbeat route's answer
 *     to a link call carries this instance's counts too (`watchersOf`). With nobody watching, the gateway publishes
 *     nothing and the runner stops sending its live stream.
 *   - live events: while a session is watched here, this instance subscribes to `ses.<sessionId>.live`, where the
 *     gateway publishes the runner's live batches, and hands their events to the session's streams (`liveEvents`).
 *   - turn prefixes: a stream that opens asks the session's runner what its current turn has streamed so far
 *     (`turnPrefix`), a NATS request on the runner's subject that the gateway relays to the runner and answers with what
 *     the runner says. That replaces the single-replica buffer (RealtimeService.turnPrefix) for a runner on the link.
 *
 * On only while the runner link is configured (the three RUNNER_LINK_* settings, runner-link-token.ts) and
 * RUNNER_LINK_NATS_URL names a server. A deployment without the link opens no connection, looks nothing up and changes
 * no stream. The apiserver connects as its own NATS user, with the nkey seed in RUNNER_LINK_NATS_SEED, which is read
 * from the environment and never logged (src/link-gateway/nats.conf names the users and what each may do).
 */

/** What a hint says: one member of the link protocol's `Hint` (contracts/runner-link/v1/runner_link.proto). */
export type RunnerHint =
  | { inbox: { sessionId: string } }
  | { claim: Record<string, never> }
  | { commands: Record<string, never> }
  | { watchers: { sessionId: string; watchers: number } };

/** The subject a runner's hints are published on. Runner ids are the UUIDs the link token names. */
export function runnerHintSubject(runnerId: string): string {
  return `rnr.${runnerId}`;
}

/** The subject the gateway publishes a session's live stream on. Session ids are UUIDs, in lower case. */
export function liveSubject(sessionId: string): string {
  return `ses.${sessionId.toLowerCase()}.live`;
}

/** The header naming the apiserver instance a WatchersHint counts for. */
export const INSTANCE_HEADER = 'Orbit-Instance';

/**
 * The message published for a hint: a link `Frame` with only `hint` set, in protobuf's canonical JSON (fields in
 * lowerCamelCase, an empty message as `{}`), which the gateway decodes and relays. The gateway's tests decode what
 * this writes (src/link-gateway/testdata/b1-hints.json, from scripts/runner-link/gen-hint-fixtures.mjs), so a field
 * renamed in the proto turns them red instead of dropping hints.
 */
export function runnerHintMessage(hint: RunnerHint): string {
  return JSON.stringify({ hint });
}

/** A turn prefix request: a link `Frame` with only `turn_prefix_request` set, in protobuf's canonical JSON. */
export function turnPrefixRequestMessage(requestId: string, sessionId: string): string {
  return JSON.stringify({ turnPrefixRequest: { requestId, sessionId } });
}

/** What a session's current turn has streamed so far, as its runner says (proto `TurnPrefixResponse`). */
export interface LinkTurnPrefix {
  turnId: string;
  text: string;
  thinking: string;
  /** The live_seq of the last live event folded into text and thinking. */
  throughLiveSeq: number;
}

/**
 * Reads the gateway's answer to a turn prefix request (a Frame with only `turn_prefix_response` set). null when it is
 * not one, or answers another request; an answer with no turn streaming has every field empty.
 */
export function decodeTurnPrefixResponse(data: Uint8Array | string, requestId: string): LinkTurnPrefix | null {
  const frame = parseFrame(data);
  const r = frame?.turnPrefixResponse;
  if (!r || typeof r !== 'object' || r.requestId !== requestId) return null;
  const through = Number(r.throughLiveSeq ?? 0);
  return {
    turnId: typeof r.turnId === 'string' ? r.turnId : '',
    text: typeof r.text === 'string' ? r.text : '',
    thinking: typeof r.thinking === 'string' ? r.thinking : '',
    throughLiveSeq: Number.isSafeInteger(through) && through >= 0 ? through : 0,
  };
}

/** One live stream event from the link, with its place in the session's live stream. */
export interface LinkLiveEvent {
  liveSeq: number;
  event: NormalizedRunEvent;
}

/** The event types a runner's live stream may carry: its own animation, never a control-plane signal. */
const LINK_LIVE_TYPES: ReadonlySet<string> = new Set([
  RunEventType.TEXT_DELTA,
  RunEventType.THINKING_DELTA,
  RunEventType.TOOL_OUTPUT,
  RunEventType.BACKGROUND_OUTPUT,
  RunEventType.TASK_PROGRESS,
]);

/**
 * Reads a live batch the gateway published on `ses.<sessionId>.live` (a Frame with only `live_batch` set, in
 * protobuf's canonical JSON: 64-bit numbers as strings, payload_json as base64). Each event becomes the live-only
 * event a client streams (seq 0), its payload the JSON the runner sent; a tool output snapshot is bounded and ordered
 * by its live_seq exactly as over HTTPS (normalizeToolOutputEvent). An event that does not read, or is not of a live
 * type, is left out; a batch of another session is left out whole.
 */
export function decodeLiveBatch(data: Uint8Array | string, sessionId: string): LinkLiveEvent[] {
  const batch = parseFrame(data)?.liveBatch;
  if (!batch || typeof batch !== 'object' || String(batch.sessionId ?? '').toLowerCase() !== sessionId.toLowerCase()) return [];
  const out: LinkLiveEvent[] = [];
  for (const e of Array.isArray(batch.events) ? batch.events : []) {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string' || !LINK_LIVE_TYPES.has(e.type)) continue;
    const liveSeq = Number(e.liveSeq ?? 0);
    const ts = Number(e.tsUnixMs ?? 0);
    let payload: unknown;
    try {
      const text = Buffer.from(typeof e.payloadJson === 'string' ? e.payloadJson : '', 'base64').toString('utf8');
      payload = text === '' ? {} : JSON.parse(text);
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(liveSeq) || liveSeq < 0 || payload === null || typeof payload !== 'object') continue;
    const event = normalizeToolOutputEvent({
      // tool_output's snapshot order is its live_seq; normalizeToolOutputEvent moves it into payload and sets seq 0.
      seq: e.type === RunEventType.TOOL_OUTPUT ? liveSeq : 0,
      type: e.type as RunEventType,
      payload: payload as Record<string, unknown>,
      ...(typeof e.turnId === 'string' && e.turnId !== '' ? { turnId: e.turnId } : {}),
      ts: new Date(Number.isFinite(ts) && ts > 0 ? ts : Date.now()).toISOString(),
    });
    out.push({ liveSeq, event });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseFrame(data: Uint8Array | string): any {
  try {
    return JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  } catch {
    return null;
  }
}

/** NATS as the hints use it. */
export interface HintBus {
  /** Whether a publish now reaches the server. */
  readonly up: boolean;
  publish(subject: string, message: string, headers?: Record<string, string>): void;
  /** Subscribes to subject, now or once connected, and again after every new connection; the result unsubscribes. */
  subscribe(subject: string, onMessage: (data: Uint8Array) => void): () => void;
  /** One request: the answer, or null when none came within timeoutMs, nobody was there to answer, or it failed. */
  request(subject: string, message: string, timeoutMs: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

/** How long a session's runner is remembered. A moved session is forgotten at once on the replica that moved it
 *  (forgetSession); elsewhere its inbox hints go to the runner it left for at most this long, one heartbeat. */
const SESSION_RUNNER_TTL_MS = 30_000;
const SESSION_RUNNER_MAX = 10_000;
/** How often dropped hints are reported. */
const DROP_REPORT_MS = 60_000;
/** How often this instance's non-zero watcher counts are published again; the gateway lets one lapse after 60 s. */
export const WATCHERS_REFRESH_MS = 20_000;
/** How long a stream that opens waits for the runner's turn prefix before it goes on without one. */
export const TURN_PREFIX_TIMEOUT_MS = 1_500;

export class RunnerHints implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('RunnerHints');
  private bus: HintBus | null = null;
  private dropReport?: ReturnType<typeof setInterval>;
  private watchersRefresh?: ReturnType<typeof setInterval>;
  /** sessionId → the runner it is assigned to (null: none), and when that was read. */
  private readonly sessionRunners = new Map<string, { runnerId: string | null; at: number }>();
  /** sessionId → this instance's open streams of it. */
  private readonly watching = new Map<string, number>();
  /** sessionId → the live subscription this instance holds for its streams, and their listeners. */
  private readonly live = new Map<string, { stop: () => void; listeners: Set<(event: LinkLiveEvent) => void> }>();
  private dropped = 0;
  private droppedSinceReport = 0;
  private published = 0;
  /** Names this apiserver instance to the gateway, which sums the watchers it counts with every other instance's. */
  readonly instanceId = randomUUID();

  /** `url` null leaves hints off. `openBus` is NATS outside the specs. */
  constructor(
    private readonly prisma: Pick<PrismaService, 'session'>,
    private readonly url: string | null,
    private readonly openBus: (url: string, log: Logger) => HintBus = (url, log) => new NatsHintBus(url, log, null),
    private readonly now: () => number = Date.now,
  ) {}

  /** On when the runner link is configured and RUNNER_LINK_NATS_URL is set. A link without the URL says so once. */
  static fromConfig(prisma: PrismaService, config: Pick<ConfigService, 'get'>): RunnerHints {
    const url = config.get<string>('RUNNER_LINK_NATS_URL')?.trim() || null;
    const seed = config.get<string>('RUNNER_LINK_NATS_SEED')?.trim() || null;
    const link = readRunnerLink({
      signingKey: config.get<string>('RUNNER_LINK_SIGNING_KEY'),
      linkUrl: config.get<string>('RUNNER_LINK_URL'),
      gatewayToken: config.get<string>('RUNNER_LINK_GATEWAY_TOKEN'),
    });
    if (link.config && !url) {
      new Logger('RunnerHints').warn('RUNNER_LINK_NATS_URL is not set: no runner link hints are published, and runners on the link learn of work at their heartbeat');
    }
    return new RunnerHints(prisma, link.config ? url : null, (u, log) => new NatsHintBus(u, log, seed));
  }

  get enabled(): boolean {
    return this.url !== null;
  }

  onModuleInit(): void {
    if (!this.url) return;
    this.bus = this.openBus(this.url, this.log);
    this.dropReport = setInterval(() => this.reportDrops(), DROP_REPORT_MS);
    this.dropReport.unref?.();
    this.watchersRefresh = setInterval(() => this.refreshWatchers(), WATCHERS_REFRESH_MS);
    this.watchersRefresh.unref?.();
    this.log.log(`runner link hints: publishing to ${redactUrl(this.url)}`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dropReport) clearInterval(this.dropReport);
    if (this.watchersRefresh) clearInterval(this.watchersRefresh);
    this.reportDrops();
    await this.bus?.close();
    this.bus = null;
  }

  /** A message is waiting in this session's inbox: hint the runner the session is assigned to. */
  inbox(sessionId: string): void {
    if (!this.ready()) return;
    void this.runnerOf(sessionId).then(
      (runnerId) => {
        if (runnerId) this.publish(runnerId, { inbox: { sessionId } });
      },
      // Counted with the rest rather than logged one by one: a database that cannot answer would fail every one.
      () => this.drop(),
    );
  }

  /** A session is queued for this runner. */
  claim(runnerId: string): void {
    if (this.ready()) this.publish(runnerId, { claim: {} });
  }

  /** Something this runner's heartbeat delivers is waiting. */
  commands(runnerId: string): void {
    if (this.ready()) this.publish(runnerId, { commands: {} });
  }

  /** Forget the runner a session was assigned to: it has just moved to another one. */
  forgetSession(sessionId: string): void {
    this.sessionRunners.delete(sessionId);
  }

  /**
   * A client opened a stream of this session: it is counted, and the session's runner told the new count. The result
   * lets it go again, once; off, both do nothing.
   */
  watch(sessionId: string): () => void {
    if (!this.enabled) return () => undefined;
    const count = (this.watching.get(sessionId) ?? 0) + 1;
    this.watching.set(sessionId, count);
    this.announceWatchers(sessionId, count);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.watching.get(sessionId) ?? 1) - 1;
      if (left > 0) this.watching.set(sessionId, left);
      else this.watching.delete(sessionId);
      this.announceWatchers(sessionId, Math.max(left, 0));
    };
  }

  /** This instance's counts of the sessions given that it has a stream of, as the heartbeat route answers them. */
  watchersOf(sessionIds: Iterable<string>): { instance: string; sessions: Array<{ sessionId: string; watchers: number }> } {
    const sessions: Array<{ sessionId: string; watchers: number }> = [];
    for (const sessionId of new Set(sessionIds)) {
      const watchers = this.watching.get(sessionId) ?? 0;
      if (watchers > 0) sessions.push({ sessionId, watchers });
    }
    return { instance: this.instanceId, sessions };
  }

  /**
   * The session's live events from the link, while this instance has a stream of it open: one NATS subscription per
   * session, shared by its streams. The result stops this listener; the last one to stop unsubscribes.
   */
  liveEvents(sessionId: string, listener: (event: LinkLiveEvent) => void): () => void {
    const bus = this.bus;
    if (!bus) return () => undefined;
    let entry = this.live.get(sessionId);
    if (!entry) {
      const listeners = new Set<(event: LinkLiveEvent) => void>();
      const stop = bus.subscribe(liveSubject(sessionId), (data) => {
        for (const event of decodeLiveBatch(data, sessionId)) {
          for (const l of listeners) l(event);
        }
      });
      entry = { stop, listeners };
      this.live.set(sessionId, entry);
    }
    const held = entry;
    held.listeners.add(listener);
    return () => {
      held.listeners.delete(listener);
      if (held.listeners.size === 0 && this.live.get(sessionId) === held) {
        held.stop();
        this.live.delete(sessionId);
      }
    };
  }

  /**
   * What the session's current turn has streamed so far, asked of its runner over the link; null when it cannot be
   * asked or does not answer within TURN_PREFIX_TIMEOUT_MS, and then the stream goes on without it, as today on a
   * replica that did not see the turn stream.
   */
  async turnPrefix(sessionId: string): Promise<LinkTurnPrefix | null> {
    const bus = this.bus;
    if (!bus?.up) return null;
    let runnerId: string | null;
    try {
      runnerId = await this.runnerOf(sessionId);
    } catch {
      return null;
    }
    if (!runnerId) return null;
    const requestId = randomUUID();
    const answer = await bus.request(
      runnerHintSubject(runnerId),
      turnPrefixRequestMessage(requestId, sessionId),
      TURN_PREFIX_TIMEOUT_MS,
    );
    return answer ? decodeTurnPrefixResponse(answer, requestId) : null;
  }

  /** What was published and dropped since start, for the specs. */
  stats(): { published: number; dropped: number } {
    return { published: this.published, dropped: this.dropped };
  }

  /** Log the hints dropped since the last report, if any: one line per interval, whatever the count. */
  reportDrops(): void {
    if (this.droppedSinceReport === 0) return;
    const count = this.droppedSinceReport;
    this.droppedSinceReport = 0;
    this.log.warn(`dropped ${count} runner link hint${count === 1 ? '' : 's'} since the last report; their runners learn of that work at their next heartbeat`);
  }

  /** Publish every count that is not zero again, so the gateway keeps it (WATCHERS_REFRESH_MS). */
  refreshWatchers(): void {
    for (const [sessionId, count] of this.watching) this.announceWatchers(sessionId, count);
  }

  private announceWatchers(sessionId: string, watchers: number): void {
    if (!this.ready()) return;
    void this.runnerOf(sessionId).then(
      (runnerId) => {
        if (runnerId) this.publish(runnerId, { watchers: { sessionId, watchers } }, { [INSTANCE_HEADER]: this.instanceId });
      },
      () => this.drop(),
    );
  }

  /** On, and connected; a hint asked for while disconnected is counted as dropped. */
  private ready(): boolean {
    if (!this.bus) return false;
    if (this.bus.up) return true;
    this.drop();
    return false;
  }

  private publish(runnerId: string, hint: RunnerHint, headers?: Record<string, string>): void {
    const bus = this.bus;
    if (!bus?.up) {
      this.drop();
      return;
    }
    try {
      bus.publish(runnerHintSubject(runnerId), runnerHintMessage(hint), headers);
      this.published += 1;
    } catch {
      this.drop();
    }
  }

  private drop(): void {
    this.dropped += 1;
    this.droppedSinceReport += 1;
  }

  /** The runner a session is assigned to, remembered for SESSION_RUNNER_TTL_MS. */
  private async runnerOf(sessionId: string): Promise<string | null> {
    const at = this.now();
    const hit = this.sessionRunners.get(sessionId);
    if (hit && at - hit.at < SESSION_RUNNER_TTL_MS) {
      this.sessionRunners.delete(sessionId); // re-insert to mark most-recently-used
      this.sessionRunners.set(sessionId, hit);
      return hit.runnerId;
    }
    const row = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { assignedRunnerId: true } });
    const runnerId = row?.assignedRunnerId ?? null;
    this.sessionRunners.delete(sessionId);
    this.sessionRunners.set(sessionId, { runnerId, at });
    if (this.sessionRunners.size > SESSION_RUNNER_MAX) {
      const oldest = this.sessionRunners.keys().next().value; // insertion order
      if (oldest !== undefined) this.sessionRunners.delete(oldest);
    }
    return runnerId;
  }
}

/** A NATS URL with any credentials in it masked, for the log. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

/** How long to wait before dialing again after a connection could not be made. */
const REDIAL_MS = 5_000;

/**
 * The NATS connection, kept up for as long as the process runs. Once connected, the client reconnects by itself and
 * `up` follows its status; a first connection that fails is dialed again every REDIAL_MS, logged once until it
 * succeeds. Subscriptions are kept here and made again on every new connection. With a seed, it authenticates as that
 * nkey user; the seed is never logged.
 */
class NatsHintBus implements HintBus {
  up = false;
  private nc?: NatsConnection;
  private redial?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failing = false;
  private readonly subs = new Map<number, { subject: string; onMessage: (data: Uint8Array) => void; sub?: Subscription }>();
  private nextSub = 0;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly seed: string | null,
  ) {
    if (!seed) {
      this.log.warn('RUNNER_LINK_NATS_SEED is not set: connecting to NATS without credentials, which a server with authorization refuses');
    }
    void this.dial();
  }

  publish(subject: string, message: string, headers?: Record<string, string>): void {
    if (!this.nc) throw new Error('not connected');
    if (!headers) {
      this.nc.publish(subject, message);
      return;
    }
    const h = natsHeaders();
    for (const [name, value] of Object.entries(headers)) h.set(name, value);
    this.nc.publish(subject, message, { headers: h });
  }

  subscribe(subject: string, onMessage: (data: Uint8Array) => void): () => void {
    const id = this.nextSub++;
    const entry: { subject: string; onMessage: (data: Uint8Array) => void; sub?: Subscription } = { subject, onMessage };
    this.subs.set(id, entry);
    if (this.nc) this.attach(this.nc, entry);
    return () => {
      this.subs.delete(id);
      entry.sub?.unsubscribe();
      entry.sub = undefined;
    };
  }

  async request(subject: string, message: string, timeoutMs: number): Promise<Uint8Array | null> {
    if (!this.nc || !this.up) return null;
    try {
      const reply = await this.nc.request(subject, message, { timeout: timeoutMs });
      return reply.data;
    } catch {
      // No responder (no gateway holds the runner), no answer in time, or a connection that went away.
      return null;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.up = false;
    if (this.redial) clearTimeout(this.redial);
    const nc = this.nc;
    this.nc = undefined;
    await nc?.close().catch(() => undefined);
  }

  private attach(nc: NatsConnection, entry: { subject: string; onMessage: (data: Uint8Array) => void; sub?: Subscription }): void {
    try {
      entry.sub = nc.subscribe(entry.subject, {
        callback: (error, msg) => {
          if (!error) entry.onMessage(msg.data);
        },
      });
    } catch (error) {
      this.log.warn(`subscribing to ${entry.subject} failed: ${(error as Error)?.message ?? error}`);
    }
  }

  private async dial(): Promise<void> {
    if (this.stopped) return;
    let nc: NatsConnection;
    try {
      nc = await connect({
        servers: this.url,
        name: 'orbit-apiserver',
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2_000,
        pingInterval: 20_000,
        maxPingOut: 3,
        ...(this.seed ? { authenticator: nkeyAuthenticator(new TextEncoder().encode(this.seed)) } : {}),
      });
    } catch (error) {
      if (!this.failing) {
        this.failing = true;
        this.log.warn(`NATS at ${redactUrl(this.url)} is unreachable (${(error as Error)?.message ?? error}); runner link hints are dropped until it answers`);
      }
      this.scheduleRedial();
      return;
    }
    if (this.stopped) {
      await nc.close().catch(() => undefined);
      return;
    }
    this.nc = nc;
    this.up = true;
    this.failing = false;
    for (const entry of this.subs.values()) this.attach(nc, entry);
    this.log.log(`connected to NATS at ${nc.getServer()}`);
    void this.follow(nc);
    void nc.closed().then((error) => {
      if (this.nc !== nc) return;
      this.nc = undefined;
      this.up = false;
      for (const entry of this.subs.values()) entry.sub = undefined;
      if (this.stopped) return;
      this.log.warn(`the NATS connection closed${error ? ` (${error.message})` : ''}; dialing again`);
      this.scheduleRedial();
    });
  }

  /** Track the connection's state: down from a disconnect until the client has reconnected. */
  private async follow(nc: NatsConnection): Promise<void> {
    for await (const status of nc.status()) {
      if (this.nc !== nc) return;
      if (status.type === 'disconnect') {
        this.up = false;
        this.log.warn(`disconnected from NATS at ${status.server}; reconnecting, and runner link hints are dropped meanwhile`);
      } else if (status.type === 'reconnect') {
        this.up = true;
        this.log.log(`reconnected to NATS at ${status.server}`);
      }
    }
  }

  private scheduleRedial(): void {
    if (this.stopped) return;
    this.redial = setTimeout(() => void this.dial(), REDIAL_MS);
    this.redial.unref?.();
  }
}
