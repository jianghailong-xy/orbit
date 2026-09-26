import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';

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

  constructor(private readonly limit: { max: number; windowMs: number } = SHARED_RATE_LIMIT) {}

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
      throw new HttpException(
        'too many requests for this shared link, slow down',
        HttpStatus.TOO_MANY_REQUESTS,
      );
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
 * Who is asking, as far as this process can tell without taking the asker's word for it. Both
 * nginx configs in front of the apiserver (gateway/nginx.conf, src/web/nginx.conf) overwrite
 * X-Real-IP with the address that connected to them, and docker-compose.yml only `expose`s the
 * apiserver's port on the internal network, so the header is the proxy's statement.
 * X-Forwarded-For is not read: its leftmost entries are whatever the client sent. Behind a CDN the
 * proxy's peer is the CDN's edge, which makes the budget per edge address rather than per person —
 * one reason it is generous.
 */
function visitorAddress(req: Request): string {
  const real = req.headers['x-real-ip'];
  return (typeof real === 'string' && real) || req.socket.remoteAddress || '';
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
