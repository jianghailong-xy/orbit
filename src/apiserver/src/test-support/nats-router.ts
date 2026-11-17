import net from 'node:net';

/**
 * A NATS server for pg specs, as far as its clients can tell: it speaks the client protocol (INFO, CONNECT, PING/PONG,
 * SUB, UNSUB, PUB, HPUB, MSG, HMSG) and routes every message to each subscription whose subject matches, `*` and `>`
 * included, payloads byte for byte. A request (a PUB with a reply subject) that no subscription takes is answered
 * "no responders" (status 503), as nats-server answers a client that asked for that in CONNECT. No authorization, no
 * queue groups beyond plain delivery, no JetStream. The real nats-server's grants are held by
 * scripts/runner-link/nats-auth-check.sh.
 */
export class NatsRouter {
  /** Every message published, in order: its subject and payload. */
  readonly published: Array<{ subject: string; data: Buffer }> = [];
  connections = 0;
  private readonly peers = new Set<RouterClient>();
  private readonly server = net.createServer((socket) => this.serve(socket));

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const peer of this.peers) peer.socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private serve(socket: net.Socket): void {
    this.connections += 1;
    const peer = new RouterClient(socket);
    this.peers.add(peer);
    socket.on('close', () => this.peers.delete(peer));
    socket.on('error', () => undefined);
    socket.write(`INFO ${JSON.stringify({
      server_id: 'NATS-ROUTER', server_name: 'nats-router', version: '2.15.1', proto: 1, go: 'go1.27.3',
      host: '127.0.0.1', port: (this.server.address() as net.AddressInfo).port, headers: true, max_payload: 1_048_576,
    })}\r\n`);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf('\r\n');
        if (end < 0) return;
        const line = pending.subarray(0, end).toString('utf8');
        const space = line.indexOf(' ');
        const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
        const args = space < 0 ? [] : line.slice(space + 1).trim().split(/\s+/);
        if (verb === 'PUB' || verb === 'HPUB') {
          const total = Number(args[args.length - 1]);
          const headerBytes = verb === 'HPUB' ? Number(args[args.length - 2]) : 0;
          if (pending.length < end + 2 + total + 2) return; // the payload is still arriving
          const body = Buffer.from(pending.subarray(end + 2, end + 2 + total));
          const fixed = verb === 'HPUB' ? 3 : 2;
          const reply = args.length > fixed ? args[1] : undefined;
          pending = pending.subarray(end + 2 + total + 2);
          this.route(peer, args[0], reply, body.subarray(0, headerBytes), body.subarray(headerBytes));
          continue;
        }
        pending = pending.subarray(end + 2);
        if (verb === 'CONNECT') {
          try {
            const options = JSON.parse(line.slice(space + 1)) as { headers?: boolean; no_responders?: boolean };
            peer.noResponders = options.headers === true && options.no_responders === true;
          } catch {
            // A CONNECT this router cannot read: no "no responders" answers for it.
          }
        } else if (verb === 'PING') {
          socket.write('PONG\r\n');
        } else if (verb === 'SUB') {
          // SUB <subject> [queue] <sid>
          peer.subs.set(args[args.length - 1], { subject: args[0], left: Infinity, count: 0 });
        } else if (verb === 'UNSUB') {
          const sub = peer.subs.get(args[0]);
          if (sub && args[1] !== undefined) sub.left = Number(args[1]) - sub.count;
          if (!sub || args[1] === undefined || sub.left <= 0) peer.subs.delete(args[0]);
        }
      }
    });
  }

  private route(from: RouterClient, subject: string, reply: string | undefined, headers: Buffer, payload: Buffer): void {
    this.published.push({ subject, data: Buffer.from(payload) });
    let delivered = 0;
    for (const peer of this.peers) {
      for (const [sid, sub] of peer.subs) {
        if (!matches(sub.subject, subject)) continue;
        peer.send(subject, sid, reply, headers, payload);
        delivered += 1;
        sub.count += 1;
        if (--sub.left <= 0) peer.subs.delete(sid);
      }
    }
    if (delivered === 0 && reply && from.noResponders) {
      this.route(from, reply, undefined, Buffer.from('NATS/1.0 503\r\n\r\n'), Buffer.alloc(0));
    }
  }
}

/** One subscription: its subject, how many more messages it takes (UNSUB with a count), and how many it took. */
interface RouterSub {
  subject: string;
  left: number;
  count: number;
}

class RouterClient {
  noResponders = false;
  readonly subs = new Map<string, RouterSub>();

  constructor(readonly socket: net.Socket) {}

  send(subject: string, sid: string, reply: string | undefined, headers: Buffer, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const replyPart = reply ? ` ${reply}` : '';
    const head = headers.length > 0
      ? `HMSG ${subject} ${sid}${replyPart} ${headers.length} ${headers.length + payload.length}\r\n`
      : `MSG ${subject} ${sid}${replyPart} ${payload.length}\r\n`;
    this.socket.write(Buffer.concat([Buffer.from(head), headers, payload, Buffer.from('\r\n')]));
  }
}

/** Whether a subscription's subject (with `*` and `>`) matches a message's subject. */
export function matches(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '>') return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}
