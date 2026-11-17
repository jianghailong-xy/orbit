import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * How many viewer streams may be open at once (docs/session-viewer-stream-design.md §6, D5): per visitor on one link
 * (the address and the token PublicSurfaceGuard budgets), per link, and per apiserver across every viewer stream —
 * the guests' as well as the public links'. The total is `VIEWER_STREAMS_MAX` when it is set (docs/configuration.md).
 */
export const VIEWER_STREAM_CAPS = { perVisitor: 4, perLink: 200, total: 2000 };

/** `VIEWER_STREAMS_MAX` as a whole number of streams of at least 1, or the default; anything else stops the
 *  apiserver at boot, as TRUSTED_PROXIES does, instead of quietly running without the cap the operator wrote. */
export function viewerStreamsMax(setting: string | undefined): number {
  if (setting === undefined || setting.trim() === '') return VIEWER_STREAM_CAPS.total;
  const n = Number(setting.trim());
  if (!Number.isInteger(n) || n < 1) throw new Error(`VIEWER_STREAMS_MAX: "${setting}" is not a whole number of streams`);
  return n;
}

/** The one sentence a stream over a cap is refused with; the page then follows by polling (§7). */
const REFUSAL = 'too many live viewers for this shared session right now, follow it by refreshing instead';

/**
 * The open viewer streams this process counts. A stream's guard takes a slot (`open`) before anything is subscribed —
 * its 200 is on the wire before its handler runs — and gives it back when the answer closes, for whatever reason
 * (the viewer left, the apiserver stopped, the stream failed). One per process, as SharedRateLimiter is.
 */
export class ViewerStreamCaps {
  private total = 0;
  private readonly visitors = new Map<string, number>();
  private readonly links = new Map<string, number>();

  constructor(private readonly caps: { perVisitor: number; perLink: number; total: number } = {
    ...VIEWER_STREAM_CAPS,
    total: viewerStreamsMax(process.env.VIEWER_STREAMS_MAX),
  }) {}

  /**
   * Take a slot for one stream — `visitor` and `link` only for a public link's — or refuse with 429, taking nothing.
   * Returns the release, which counts only once however often it is called.
   */
  open(keys: { visitor?: string; link?: string } = {}): () => void {
    const { visitor, link } = keys;
    if (
      this.total >= this.caps.total
      || (visitor !== undefined && (this.visitors.get(visitor) ?? 0) >= this.caps.perVisitor)
      || (link !== undefined && (this.links.get(link) ?? 0) >= this.caps.perLink)
    ) {
      throw new HttpException(REFUSAL, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.total += 1;
    if (visitor !== undefined) bump(this.visitors, visitor, 1);
    if (link !== undefined) bump(this.links, link, 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      if (visitor !== undefined) bump(this.visitors, visitor, -1);
      if (link !== undefined) bump(this.links, link, -1);
    };
  }

  /** How many streams hold a slot now. */
  get held(): number {
    return this.total;
  }
}

/** Add `by` to `key`'s count, dropping the key at zero so the maps hold only open streams. */
function bump(counts: Map<string, number>, key: string, by: number): void {
  const n = (counts.get(key) ?? 0) + by;
  if (n > 0) counts.set(key, n);
  else counts.delete(key);
}

/** Take a slot for the stream `res` answers, released when `res` closes — at once if the viewer already left while
 *  the guards before this one were reading. */
export function holdViewerStreamSlot(
  caps: ViewerStreamCaps,
  res: { once: (event: 'close', listener: () => void) => unknown; closed?: boolean },
  keys?: { visitor?: string; link?: string },
): void {
  const release = caps.open(keys);
  res.once('close', release);
  if (res.closed) release();
}
