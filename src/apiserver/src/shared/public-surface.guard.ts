import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BlockList, isIP } from 'node:net';

/**
 * How much one visitor may ask of one share link: `max` requests in any `windowMs`. Opening a
 * shared transcript costs one request plus one per inline image, and every older page or expanded
 * card one more — a person reading never comes near it; a script walking the link does.
 */
export const SHARED_RATE_LIMIT = { max: 120, windowMs: 60_000 };

/**
 * An in-process sliding window per key, as runners.service.ts throttles device lookups — with the
 * one thing that door does not need: its keys are user ids, these are made up by whoever is asking
 * (an address and a token), so windows that have ended are dropped, at most once a window, rather
 * than kept for the life of the process.
 */
export class SharedRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private sweptAt = 0;

  constructor(
    private readonly limit: { max: number; windowMs: number } = SHARED_RATE_LIMIT,
    /** What a refused request is told; the share links' wording unless the door is another. */
    private readonly refusal = 'too many requests for this shared link, slow down',
  ) {}

  /** Spend one request of `key`'s window, or refuse with 429 when it is spent. */
  take(key: string, now = Date.now()): void {
    const { max, windowMs } = this.limit;
    if (now - this.sweptAt >= windowMs) {
      this.sweptAt = now;
      for (const [k, times] of this.hits) {
        if (now - times[times.length - 1] >= windowMs) this.hits.delete(k);
      }
    }
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      throw new HttpException(this.refusal, HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.hits.set(key, recent);
  }

  /** How many keys are tracked — what the sweep keeps bounded. */
  get size(): number {
    return this.hits.size;
  }
}

/**
 * The proxies in front of the gateway that this deployment vouches for, from `TRUSTED_PROXIES`:
 * addresses and CIDR ranges, separated by commas or spaces — Cloudflare's published ranges for a
 * deployment behind Cloudflare (docs/configuration.md). Empty when it is unset. An entry that is
 * neither is refused, so a typo stops the apiserver at boot instead of quietly trusting less, or
 * more, than the operator wrote.
 */
export function trustedProxies(setting: string): BlockList {
  const trusted = new BlockList();
  for (const entry of setting.split(/[\s,]+/).filter(Boolean)) {
    const [address, bits, ...rest] = entry.split('/');
    const family = isIP(address);
    const widest = family === 4 ? 32 : 128;
    if (family === 0 || rest.length > 0 || (bits !== undefined && !(/^\d+$/.test(bits) && Number(bits) <= widest))) {
      throw new Error(`TRUSTED_PROXIES: "${entry}" is not an IP address or a CIDR range`);
    }
    trusted.addSubnet(address, bits === undefined ? widest : Number(bits), family === 4 ? 'ipv4' : 'ipv6');
  }
  return trusted;
}

const TRUSTED_PROXIES = trustedProxies(process.env.TRUSTED_PROXIES ?? '');

/** Whether an address is inside one of `ranges`; never for what is not an address. */
function within(ranges: BlockList, address: string): boolean {
  const family = isIP(address);
  return family !== 0 && ranges.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * One spelling per address, so two requests from one place compare equal and a page can print it
 * as people write it: an IPv4 address mapped into IPv6 (`::ffff:203.0.113.24`, how a dual-stack
 * socket names an IPv4 peer) is that IPv4 address, and any other IPv6 address its shortest
 * lowercase form. Anything else is left as it is.
 */
export function canonicalAddress(address: string): string {
  if (isIP(address) !== 6) return address;
  let shortest: string;
  try {
    shortest = new URL(`http://[${address}]`).hostname.slice(1, -1);
  } catch {
    return address; // a zone index (fe80::1%eth0), which a URL cannot hold
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(shortest);
  if (!mapped) return shortest;
  const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** Loopback, private networks and link-local, in both families. */
const INTERNAL_RANGES = new BlockList();
for (const [network, prefix] of [
  ['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16],
  ['::1', 128], ['fc00::', 7], ['fe80::', 10],
] as const) {
  INTERNAL_RANGES.addSubnet(network, prefix, isIP(network) === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Whether a canonical address is one a request has only from inside a network: what a proxy in
 * front of the gateway connects from when TRUSTED_PROXIES does not name it. Two requests from one
 * such address say nothing about where either of them came from.
 */
export function isInternalAddress(address: string): boolean {
  return within(INTERNAL_RANGES, address);
}

/**
 * The client behind the trusted proxies, given the address the nearest proxy saw (`seen`) and the
 * X-Forwarded-For chain it passed on. Every proxy appends the address that connected to it, so the
 * chain is read from its right end, one hop at a time, only while the address in hand is a proxy
 * the deployment vouches for: whatever it appended is then the next address. The first address that
 * is not a trusted proxy is the client's. Entries further left are whatever the client sent, and
 * are never reached.
 */
export function clientAddress(seen: string, forwardedFor: string | string[] | undefined, trusted: BlockList): string {
  let address = canonicalAddress(seen);
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '')
    .split(',')
    .map((hop) => canonicalAddress(hop.trim()))
    .filter(Boolean);
  // nginx passes on what it saw twice, as X-Real-IP and as the chain's last entry.
  if (chain[chain.length - 1] === address) chain.pop();
  while (chain.length > 0 && within(trusted, address)) {
    const next = chain.pop()!;
    if (!isIP(next)) break;
    address = next;
  }
  return address;
}

/**
 * Who is asking, as far as this process can tell without taking the asker's word for it. Both
 * nginx configs in front of the apiserver (gateway/nginx.conf, src/web/nginx.conf) overwrite
 * X-Real-IP with the address that connected to them, and docker-compose.yml only `expose`s the
 * apiserver's port on the internal network, so the header is the proxy's statement. Behind a CDN
 * that address is the CDN's edge; X-Forwarded-For then names the person, but only through the hops
 * `TRUSTED_PROXIES` vouches for: its leftmost entries are whatever the client sent. With nothing
 * trusted it counts for nothing, and a CDN's edge is who asks — which makes a budget per edge
 * address rather than per person, one reason the share links' is generous.
 */
export function visitorAddress(req: Request): string {
  const real = req.headers['x-real-ip'];
  const seen = (typeof real === 'string' && real) || req.socket.remoteAddress || '';
  return clientAddress(seen, req.headers['x-forwarded-for'], TRUSTED_PROXIES);
}

/**
 * Every response under /shared: stored by no browser or shared cache, indexed by no crawler, and
 * inside the visitor's budget for this link. A guard because guards run before pipes and handlers,
 * so the headers are on the 400s, 404s and 429s as well as the 200s and the file bodies.
 */
@Injectable()
export class PublicSurfaceGuard implements CanActivate {
  constructor(private readonly limiter: SharedRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    this.limiter.take(`${visitorAddress(req)} ${req.params.token}`);
    return true;
  }
}
