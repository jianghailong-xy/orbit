/**
 * A viewer's stream of a session (docs/session-viewer-stream-design.md §3–§4): the SSE routes a public
 * link's page and a guest's page follow a conversation on.
 *
 * Read with fetch rather than EventSource, because what the page does about a stream it could not
 * open depends on why: a 404 from a server older than these routes and a 429 over the anonymous caps
 * both send it back to polling, and an EventSource reports every refusal as the same bare `error`.
 */

/** One frame as the viewer stream sends it: a durable event, a delta, a `head`, `resync`, `gone` or `ping`. */
export interface ViewerFrame {
  seq?: number;
  type: string;
  payload?: any;
  turnId?: string | null;
  ts?: string;
  truncated?: boolean;
}

/** How a stream ended: whether it had opened (a 200 with a body), and the status it was refused with. */
export interface ViewerStreamEnd {
  opened: boolean;
  status?: number;
}

/**
 * Open the stream at `url`. Each frame goes to `frame`, in order; `end` is told once when the stream
 * is refused, fails to connect, breaks or is ended by the server. Returns the close, after which
 * neither is called again.
 */
export function openViewerStream(
  url: string,
  on: { frame: (frame: ViewerFrame) => void; end: (how: ViewerStreamEnd) => void },
): () => void {
  const ctl = new AbortController();
  let opened = false;
  const end = (how: ViewerStreamEnd) => {
    if (!ctl.signal.aborted) on.end(how);
  };
  void (async () => {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'text/event-stream' } });
    if (!res.ok || !res.body) return end({ opened: false, status: res.status });
    opened = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done || ctl.signal.aborted) break;
      buf += decoder.decode(value, { stream: true });
      // An SSE message ends at a blank line; its data is its `data:` lines, joined.
      for (let at = buf.search(/\r?\n\r?\n/); at >= 0; at = buf.search(/\r?\n\r?\n/)) {
        const block = buf.slice(0, at);
        buf = buf.slice(at).replace(/^\r?\n\r?\n/, '');
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        let frame: ViewerFrame;
        try {
          frame = JSON.parse(data) as ViewerFrame;
        } catch {
          continue;
        }
        if (ctl.signal.aborted) return;
        on.frame(frame);
      }
    }
    end({ opened: true });
  })().catch(() => end({ opened }));
  return () => ctl.abort();
}

/** The wait before reconnect `attempt` (0 first): 1 s doubling to 30 s, less up to a fifth at random,
 *  so the viewers of one session that dropped together do not all come back in the same instant. */
export function reconnectDelay(attempt: number): number {
  const base = Math.min(1_000 * 2 ** attempt, 30_000);
  return Math.round(base * (1 - 0.2 * Math.random()));
}
