import type { HintBus } from '../realtime/runner-hints';

/**
 * NATS in memory, as RunnerHints' connection (HintBus) and the relays' peers (runners/relay-peers.ts) use it: one server
 * and a connection per apiserver process, literal subjects, a request answered by the first reply or by nobody (no
 * responders) at once. Every message is delivered on a later turn, as over a socket, and `delayMs` holds back what one
 * connection is sent: a process too busy to answer in time.
 */
export class MemoryNats {
  /** Every message published or sent as a request, in order, with the connection it came from. */
  readonly sent: Array<{ from: string; subject: string; message: string }> = [];
  private readonly subs = new Map<string, Set<{ conn: MemoryNatsConnection; onMessage: Listener }>>();

  connect(name: string): MemoryNatsConnection {
    return new MemoryNatsConnection(this, name);
  }

  /** Who listens on `subject` now. */
  listeners(subject: string): number {
    return this.subs.get(subject)?.size ?? 0;
  }

  /** @internal */
  add(subject: string, entry: { conn: MemoryNatsConnection; onMessage: Listener }): () => void {
    const set = this.subs.get(subject) ?? new Set();
    set.add(entry);
    this.subs.set(subject, set);
    return () => {
      set.delete(entry);
      if (set.size === 0) this.subs.delete(subject);
    };
  }

  /** @internal Delivers to every listener on `subject`; how many there were. */
  deliver(from: MemoryNatsConnection, subject: string, message: string, reply?: (message: string) => void): number {
    this.sent.push({ from: from.name, subject, message });
    const listeners = [...(this.subs.get(subject) ?? [])];
    const data = new Uint8Array(Buffer.from(message, 'utf8'));
    for (const { conn, onMessage } of listeners) {
      setTimeout(() => {
        if (conn.up) onMessage(data, reply);
      }, conn.delayMs);
    }
    return listeners.length;
  }
}

type Listener = (data: Uint8Array, reply?: (message: string) => void) => void;

export class MemoryNatsConnection implements HintBus {
  up = true;
  /** How long what this connection is sent waits before it is read. */
  delayMs = 0;
  private readonly stops = new Set<() => void>();

  constructor(
    private readonly server: MemoryNats,
    readonly name: string,
  ) {}

  publish(subject: string, message: string): void {
    if (!this.up) throw new Error('not connected');
    this.server.deliver(this, subject, message);
  }

  subscribe(subject: string, onMessage: Listener): () => void {
    const stop = this.server.add(subject, { conn: this, onMessage });
    this.stops.add(stop);
    return () => {
      stop();
      this.stops.delete(stop);
    };
  }

  request(subject: string, message: string, timeoutMs: number): Promise<Uint8Array | null> {
    if (!this.up) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish(null), timeoutMs);
      const finish = (data: Uint8Array | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(data);
      };
      const reply = (answer: string) => {
        // The answer crosses the server too, and reaches a connection that is still there.
        setTimeout(() => {
          if (this.up) finish(new Uint8Array(Buffer.from(answer, 'utf8')));
        }, this.delayMs);
      };
      // Nobody listening: NATS says so at once (no responders).
      if (this.server.deliver(this, subject, message, reply) === 0) finish(null);
    });
  }

  async close(): Promise<void> {
    this.up = false;
    for (const stop of this.stops) stop();
    this.stops.clear();
  }
}
