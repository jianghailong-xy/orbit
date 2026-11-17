import { type IncomingHttpHeaders, request as httpRequest } from 'node:http';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** One SSE stream held open by a spec: its status and headers, every `data:` frame it has sent so far (parsed, and
 *  as the text it came in), and a way to wait for the frame a case is after. */
export interface HeldStream {
  status: number;
  headers: IncomingHttpHeaders;
  /** Everything the answer carried so far, as text — a refusal's body once `ended` has resolved. */
  body: () => string;
  /** Resolves when the server ends the answer. */
  ended: Promise<void>;
  frames: Json[];
  texts: string[];
  /** Resolves once a frame matching `match` has arrived; rejects after `ms` naming what it saw. */
  until: (match: (frame: Json) => boolean, what: string, ms?: number) => Promise<Json>;
  close: () => void;
}

/**
 * Open `url` as an EventSource would (GET, Accept: text/event-stream) on a connection of its own, and resolve once
 * its headers are in. Frames are parsed as they arrive; a refusal's body is kept as text.
 */
export function openStream(url: string, headers: Record<string, string> = {}): Promise<HeldStream> {
  return new Promise((resolve, reject) => {
    const frames: Json[] = [];
    const texts: string[] = [];
    let raw = '';
    let pending = '';
    const waiters: Array<() => void> = [];
    const req = httpRequest(url, { method: 'GET', agent: false, headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        pending += chunk;
        let cut: number;
        while ((cut = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          texts.push(data);
          try {
            frames.push(JSON.parse(data) as Json);
          } catch {
            frames.push({ unparsed: data });
          }
          for (const wake of waiters.splice(0)) wake();
        }
      });
      res.on('error', () => undefined);
      const ended = new Promise<void>((done) => {
        res.on('end', () => done());
        res.on('close', () => done());
      });
      resolve({
        ended,
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: () => raw,
        frames,
        texts,
        until: (match, what, ms = 15_000) =>
          new Promise<Json>((done, fail) => {
            const timer = setTimeout(
              () => fail(new Error(`no ${what} within ${ms} ms; frames: ${texts.map((t) => t.slice(0, 160)).join(' | ')}`)),
              ms,
            );
            const look = () => {
              const found = frames.find(match);
              if (found) {
                clearTimeout(timer);
                done(found);
              } else waiters.push(look);
            };
            look();
          }),
        close: () => req.destroy(),
      });
    });
    req.on('error', (err) => {
      if (!(err as NodeJS.ErrnoException).code?.startsWith('ECONNRESET')) reject(err);
    });
    req.end();
  });
}
