/**
 * The apiserver processes of one deployment, as the two relays that hand a runner something from one process's memory
 * reach each other: Antigravity's pasted code (login-code-relay.ts) and a Cursor key to check
 * (providers/cursor-key-check-relay.ts). A person's request puts the code or the key in the memory of the process it
 * reached (behind nginx, the main one); over the runner link the gateway hands each heartbeat and call of the runner to
 * any process, round robin. So the process a heartbeat reaches asks the one that holds it, over NATS
 * (docs/runner-link-design.md §6.3):
 *
 *   api.held        a process says what it holds for a runner, and for how long: its instance, the kind, the runner
 *                   and the item — the sign-in attempt a code was pasted for, a check's id. Never the code or the key.
 *                   Said when it starts holding, again every reannounceMs while it holds anything (so a process that
 *                   starts or reconnects meanwhile hears it), and taken back when it stops.
 *   api.<instance>  a request to that one process: hand over what you hold for this runner and item (once, in the
 *                   reply), take this answer to the check you hold, drop the code you hold.
 *
 * Core NATS, as the hints are (realtime/runner-hints.ts), and on the same connection: nothing is stored, a message
 * nobody is subscribed for goes nowhere, and the code or the key travels only in the one reply that hands it over. The
 * subjects name instances, never what they carry, and nothing here logs a request or an answer.
 *
 * A heartbeat waits askTimeoutMs at most for an answer and then goes on without it. The holder has forgotten what it
 * handed over by then, so an answer that comes later is not dropped: the process that asked holds it from then on, for
 * what is left of its time, says so, and has the runner beat again (`late`, `nudge`).
 *
 * A process asks only once another has said it holds something for that runner, so a deployment of one apiserver
 * never asks, a heartbeat with nothing to collect elsewhere never waits on NATS, and nothing is said while nothing is
 * held. Without NATS (connect is never called, runner-hints.ts) each relay is its process's alone, as it always was.
 * src/link-gateway/nats.conf lets the apiserver's user publish and subscribe on api.> and answer what it is asked; the
 * gateway's user can do neither, nor read an apiserver's replies.
 */

/** What a process can hold for a runner. */
export type HeldKind = 'login-code' | 'cursor-key-check';

/** One request to another process: `type` says which of its handlers answers it, `runnerId` whose it is. */
export type PeerRequest = { type: string; runnerId: string } & Record<string, unknown>;

/** What one other process said it holds of a kind for a runner. */
export interface Holder {
  instance: string;
  /** The sign-in attempts, or the check ids. */
  items: string[];
}

/** NATS as the relays use it: RunnerHints' connection (HintBus). */
export interface PeerBus {
  /** Whether a publish now reaches the server. */
  readonly up: boolean;
  publish(subject: string, message: string): void;
  /** `reply`, when the message is a request, answers it once. The result unsubscribes. */
  subscribe(subject: string, onMessage: (data: Uint8Array, reply?: (message: string) => void) => void): () => void;
  /** The answer, or null when none came within timeoutMs, nobody was there to answer, or it failed. */
  request(subject: string, message: string, timeoutMs: number): Promise<Uint8Array | null>;
}

/** Where a process says what it holds. */
export const HELD_SUBJECT = 'api.held';

/** Where one process is asked. Instance ids are RunnerHints' UUIDs. */
export function peerSubject(instance: string): string {
  return `api.${instance}`;
}

/** How long a heartbeat waits for another process's answer before it goes on without it. */
export const PEER_ASK_TIMEOUT_MS = 1_000;
/** How long an answer is still taken after that, and held here (`late`). */
export const PEER_REPLY_TIMEOUT_MS = 15_000;
/** How often what this process holds is said again, while it holds anything. */
export const REANNOUNCE_MS = 5_000;
/** The longest anything is said to be held: an Antigravity code's sign-in, eleven minutes, with room. */
const HELD_TTL_MAX_MS = 15 * 60_000;
/** How many runners' announcements a process keeps; past it, the oldest goes. */
const HELD_RUNNERS_MAX = 10_000;
/** How many items one process may say it holds for one runner: four Cursor checks at most (CURSOR_KEY_CHECKS_PER_RUNNER). */
const ITEMS_MAX = 16;
const KINDS: ReadonlySet<string> = new Set<HeldKind>(['login-code', 'cursor-key-check']);
const RUNNER_ID = /^[0-9a-fA-F-]{32,36}$/;

export class RelayPeers {
  /** How long a heartbeat waits for an answer (PEER_ASK_TIMEOUT_MS), how long a late one is still taken
   *  (PEER_REPLY_TIMEOUT_MS) and how often what is held is said again (REANNOUNCE_MS); the specs shorten them. */
  askTimeoutMs = PEER_ASK_TIMEOUT_MS;
  replyTimeoutMs = PEER_REPLY_TIMEOUT_MS;
  reannounceMs = REANNOUNCE_MS;
  private bus: PeerBus | null = null;
  private instance: string | null = null;
  private nudgeRunner: ((runnerId: string) => void) | null = null;
  private stops: Array<() => void> = [];
  /** `kind runnerId` → the instances that said they hold something of it → item → until when (this process's clock). */
  private readonly elsewhere = new Map<string, Map<string, Map<string, number>>>();
  /** What this process said it holds: `kind runnerId item` → what, and until when. */
  private readonly own = new Map<string, { kind: HeldKind; runnerId: string; item: string; until: number }>();
  private reannounce?: ReturnType<typeof setInterval>;
  private readonly handlers = new Map<string, (request: PeerRequest) => Record<string, unknown>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Reach the other processes over `bus` as `instance`: hear what they hold, and answer what they ask. `nudge` has a
   * runner beat now, for what this process came to hold late (RunnerHints.commands).
   */
  connect(bus: PeerBus, instance: string, nudge?: (runnerId: string) => void): void {
    this.disconnect();
    this.bus = bus;
    this.instance = instance;
    this.nudgeRunner = nudge ?? null;
    this.stops = [
      bus.subscribe(HELD_SUBJECT, (data) => this.heard(data)),
      bus.subscribe(peerSubject(instance), (data, reply) => this.answer(data, reply)),
    ];
  }

  disconnect(): void {
    for (const stop of this.stops) stop();
    this.stops = [];
    this.bus = null;
    this.instance = null;
    this.nudgeRunner = null;
    this.elsewhere.clear();
    this.own.clear();
    this.quiet();
  }

  /** Answer the requests of `type` other processes send this one with what `handler` returns. */
  serve(type: string, handler: (request: PeerRequest) => Record<string, unknown>): void {
    this.handlers.set(type, handler);
  }

  /** This process holds `item` of `kind` for `runnerId`, for the next `ttlMs`: said now, and again every reannounceMs
   *  until release or its time is up. Nothing while unconnected. */
  hold(kind: HeldKind, runnerId: string, item: string, ttlMs: number): void {
    if (!this.bus || !(ttlMs > 0)) return;
    const until = this.now() + Math.min(ttlMs, HELD_TTL_MAX_MS);
    this.own.set(`${kind} ${runnerId} ${item}`, { kind, runnerId, item, until });
    this.say(kind, runnerId, item, until - this.now());
    if (!this.reannounce) {
      this.reannounce = setInterval(() => this.sayAgain(), this.reannounceMs);
      // Never what keeps the process alive.
      this.reannounce.unref?.();
    }
  }

  /** This process no longer holds `item`: taken back, so the others stop asking for it. */
  release(kind: HeldKind, runnerId: string, item: string): void {
    if (!this.own.delete(`${kind} ${runnerId} ${item}`)) return;
    this.say(kind, runnerId, item, 0);
    if (this.own.size === 0) this.quiet();
  }

  /** The other processes that said they hold something of `kind` for `runnerId`, and what, whose word has not lapsed. */
  holders(kind: HeldKind, runnerId: string): Holder[] {
    const k = `${kind} ${runnerId}`;
    const by = this.elsewhere.get(k);
    if (!by) return [];
    const now = this.now();
    const out: Holder[] = [];
    for (const [instance, items] of by) {
      for (const [item, until] of items) if (until <= now) items.delete(item);
      if (items.size === 0) by.delete(instance);
      else out.push({ instance, items: [...items.keys()] });
    }
    if (by.size === 0) this.elsewhere.delete(k);
    return out;
  }

  /**
   * Ask one process: its answer, or null when NATS is down, the process is gone, or it did not answer within
   * askTimeoutMs. An answer that comes after that, within replyTimeoutMs, goes to `late`.
   */
  async ask(
    instance: string,
    request: PeerRequest,
    late?: (answer: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown> | null> {
    const bus = this.bus;
    if (!bus?.up) return null;
    let reply: Promise<Record<string, unknown> | null>;
    try {
      reply = bus.request(peerSubject(instance), JSON.stringify(request), this.replyTimeoutMs).then(
        (data) => (data ? readObject(data) : null),
        () => null,
      );
    } catch {
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<'waited'>((resolve) => {
      timer = setTimeout(() => resolve('waited'), this.askTimeoutMs);
      timer.unref?.();
    });
    const first = await Promise.race([reply, waited]);
    clearTimeout(timer);
    if (first !== 'waited') return first;
    if (late) {
      void reply.then((answer) => {
        if (answer) late(answer);
      });
    }
    return null;
  }

  /** Tell one process, waiting for nothing. */
  tell(instance: string, request: PeerRequest): void {
    const bus = this.bus;
    if (!bus?.up) return;
    try {
      bus.publish(peerSubject(instance), JSON.stringify(request));
    } catch {
      // As a hint is: the connection went between the check and the publish.
    }
  }

  /** Have this runner beat now (`nudge`). */
  nudge(runnerId: string): void {
    this.nudgeRunner?.(runnerId);
  }

  private say(kind: HeldKind, runnerId: string, item: string, ttlMs: number): void {
    const bus = this.bus;
    if (!bus?.up || !this.instance) return;
    try {
      bus.publish(HELD_SUBJECT, JSON.stringify({ instance: this.instance, kind, runnerId, item, ttlMs: Math.max(0, Math.ceil(ttlMs)) }));
    } catch {
      // Said again at the next reannounceMs.
    }
  }

  private sayAgain(): void {
    const now = this.now();
    for (const [k, held] of this.own) {
      if (held.until <= now) this.own.delete(k);
      else this.say(held.kind, held.runnerId, held.item, held.until - now);
    }
    if (this.own.size === 0) this.quiet();
  }

  private quiet(): void {
    if (this.reannounce) clearInterval(this.reannounce);
    this.reannounce = undefined;
  }

  private heard(data: Uint8Array): void {
    const said = readObject(data);
    if (!said || typeof said.instance !== 'string' || said.instance === this.instance) return;
    if (typeof said.kind !== 'string' || !KINDS.has(said.kind)) return;
    if (typeof said.runnerId !== 'string' || !RUNNER_ID.test(said.runnerId)) return;
    if (typeof said.item !== 'string' || said.item === '' || said.item.length > 64) return;
    const ttl = Number(said.ttlMs);
    if (!Number.isFinite(ttl) || ttl < 0) return;
    const k = `${said.kind} ${said.runnerId}`;
    const by = this.elsewhere.get(k) ?? new Map<string, Map<string, number>>();
    const items = by.get(said.instance) ?? new Map<string, number>();
    if (ttl === 0) items.delete(said.item);
    else if (items.has(said.item) || items.size < ITEMS_MAX) items.set(said.item, this.now() + Math.min(ttl, HELD_TTL_MAX_MS));
    if (items.size > 0) by.set(said.instance, items);
    else by.delete(said.instance);
    this.elsewhere.delete(k); // re-inserted below: the most recently heard last
    if (by.size === 0) return;
    this.elsewhere.set(k, by);
    if (this.elsewhere.size > HELD_RUNNERS_MAX) {
      const oldest = this.elsewhere.keys().next().value; // insertion order
      if (oldest !== undefined) this.elsewhere.delete(oldest);
    }
  }

  private answer(data: Uint8Array, reply?: (message: string) => void): void {
    const request = readObject(data);
    const handler = request && typeof request.type === 'string' ? this.handlers.get(request.type) : undefined;
    let answer: Record<string, unknown> = {};
    if (handler && typeof request?.runnerId === 'string') {
      try {
        answer = handler(request as PeerRequest);
      } catch {
        // Answered with nothing, as a request no handler knows: the asker goes on without it.
      }
    }
    if (!reply) return;
    try {
      reply(JSON.stringify(answer));
    } catch {
      // The connection went; the asker's wait runs out.
    }
  }
}

function readObject(data: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** This process's peers: RunnerHints connects them when NATS is configured (RunnerHints.fromConfig). */
export const relayPeers = new RelayPeers();
