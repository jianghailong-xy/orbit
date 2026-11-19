import { useEffect, useRef } from 'react';
import {
  MAX_PASTE_BYTES,
  RUNNER_BROWSER_COPY as COPY,
  loadVnc,
  runnerBrowserVncUrl,
  type ViewerAnswer,
  type ViewerMessage,
  type VncClient,
} from '../lib/runnerBrowser';

export type Link = 'connecting' | 'live' | 'disconnected';

/** How a paste went: sent and waiting, done, or refused with the reason (in English, for the bar). */
export type PasteState = { state: 'pasting' } | { state: 'done' } | { state: 'failed'; error: string };

/**
 * noVNC on the runner's viewer route (docs/runner-browser-design.md §4–5). The stream opens once per mount; viewOnly
 * and fit change it in place. The viewer opens the WebSocket itself and hands it to noVNC, so that the same stream
 * carries its text messages beside RFB: whether it is in control, and pastes.
 *
 *   - View only: noVNC's viewOnly drops every pointer and key event, and nothing is pasted or copied.
 *   - Paste, in control (owner's choice, 2026-11-19): ⌘V / Ctrl+V is kept from noVNC, so the keystroke never reaches
 *     the runner and nothing pastes twice. The keys noVNC already pressed (Ctrl, ⌘) are released, focus moves to a
 *     hidden field for the browser's own `paste` event, and its text goes to the server, which has the runner insert
 *     it into the remote Chrome's focused field with DevTools (UTF-8, unlike RFB's Latin-1 cut text).
 *   - Copy back, in control, best effort: text copied in the remote arrives as noVNC's `clipboard` event and is
 *     written to the local clipboard; a browser that refuses it without a gesture gets it at the next key or click.
 *     RFB cut text is Latin-1, so only Latin-1 text comes back whole.
 *   - Fit scales the 1280×800 screen into the space; 100% shows it 1:1 and scrolls.
 */
export function VncCanvas({
  runnerId,
  viewOnly,
  fit = true,
  onLink,
  onScale,
  onPaste,
}: {
  runnerId: string;
  viewOnly: boolean;
  fit?: boolean;
  onLink: (link: Link) => void;
  /** The scale the screen is drawn at, in percent (null before the first frame). */
  onScale?: (percent: number | null) => void;
  onPaste?: (paste: PasteState) => void;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const sink = useRef<HTMLTextAreaElement>(null);
  const client = useRef<VncClient | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const viewOnlyNow = useRef(viewOnly);
  viewOnlyNow.current = viewOnly;
  const fitNow = useRef(fit);
  fitNow.current = fit;
  const onLinkNow = useRef(onLink);
  onLinkNow.current = onLink;
  const onScaleNow = useRef(onScale);
  onScaleNow.current = onScale;
  const onPasteNow = useRef(onPaste);
  onPasteNow.current = onPaste;
  const pasteSeq = useRef(0);
  const pending = useRef<number | null>(null);
  /** Remote text the local clipboard refused without a gesture, written at the next one. */
  const copied = useRef<string | null>(null);

  const say = (message: ViewerMessage) => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const measure = () => {
    const canvas = screen.current?.querySelector('canvas');
    const width = canvas?.width ?? 0;
    onScaleNow.current?.(canvas && width > 0 && canvas.clientWidth > 0 ? Math.round((canvas.clientWidth / width) * 100) : null);
  };

  useEffect(() => {
    let gone = false;
    onLinkNow.current('connecting');
    void loadVnc()
      .then((RFB) => {
        if (gone || !screen.current) return;
        const ws = new WebSocket(runnerBrowserVncUrl(runnerId));
        ws.binaryType = 'arraybuffer';
        // Registered before noVNC's own handler: the server's text messages are this viewer's, never RFB.
        ws.addEventListener('message', (event: MessageEvent) => {
          if (typeof event.data !== 'string') return;
          event.stopImmediatePropagation();
          let answer: ViewerAnswer;
          try {
            answer = JSON.parse(event.data) as ViewerAnswer;
          } catch {
            return;
          }
          if (answer.type !== 'pasted' || answer.id !== pending.current) return;
          pending.current = null;
          onPasteNow.current?.(answer.error ? { state: 'failed', error: answer.error } : { state: 'done' });
        });
        socket.current = ws;
        const rfb = new RFB(screen.current, ws, { shared: true });
        rfb.viewOnly = viewOnlyNow.current;
        rfb.scaleViewport = fitNow.current;
        rfb.clipViewport = false;
        rfb.resizeSession = false;
        // The letterbox around the picture scaled to fit reads as the page's own surface, not noVNC's dark grey.
        rfb.background = 'var(--bg-sunken)';
        rfb.addEventListener('connect', () => {
          say({ type: 'control', on: !viewOnlyNow.current });
          onLinkNow.current('live');
          measure();
        });
        rfb.addEventListener('disconnect', () => {
          if (pending.current !== null) onPasteNow.current?.({ state: 'failed', error: COPY.pasteNoAnswer });
          pending.current = null;
          onLinkNow.current('disconnected');
        });
        rfb.addEventListener('clipboard', (event) => {
          if (viewOnlyNow.current) return;
          const text = event.detail?.text ?? '';
          if (!text) return;
          copied.current = text;
          void navigator.clipboard?.writeText(text).then(
            () => {
              if (copied.current === text) copied.current = null;
            },
            () => undefined,
          );
        });
        client.current = rfb;
      })
      .catch(() => {
        if (!gone) onLinkNow.current('disconnected');
      });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
    if (observer && screen.current) observer.observe(screen.current);
    return () => {
      gone = true;
      observer?.disconnect();
      // Input stops before the stream closes, so nothing typed while it closes reaches the runner.
      if (client.current) client.current.viewOnly = true;
      client.current?.disconnect();
      client.current = null;
      socket.current = null;
    };
    // measure and say read only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerId]);

  useEffect(() => {
    say({ type: 'control', on: !viewOnly });
    const rfb = client.current;
    if (!rfb) return;
    rfb.viewOnly = viewOnly;
    if (!viewOnly) rfb.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewOnly]);

  useEffect(() => {
    const rfb = client.current;
    if (!rfb) return;
    rfb.scaleViewport = fit;
    // noVNC lays the canvas out on the next frame.
    requestAnimationFrame(() => measure());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit]);

  useEffect(() => {
    const host = screen.current?.parentElement;
    if (!host) return;
    const isPasteKey = (e: KeyboardEvent) => (e.key === 'v' || e.key === 'V' || e.code === 'KeyV') && (e.metaKey || e.ctrlKey) && !e.altKey;
    const onKeyDown = (e: KeyboardEvent) => {
      // A copy the clipboard refused: written now, on this gesture.
      if (copied.current && !viewOnlyNow.current) {
        const text = copied.current;
        copied.current = null;
        void navigator.clipboard?.writeText(text).catch(() => undefined);
      }
      if (viewOnlyNow.current || !isPasteKey(e) || e.target === sink.current) return;
      // Not noVNC's: the keystroke would reach the runner as Ctrl+V. The browser's paste follows this keydown,
      // into the hidden field, as its default action; noVNC first lets go of the keys it holds (Ctrl, ⌘).
      e.stopPropagation();
      window.dispatchEvent(new Event('blur'));
      sink.current?.focus();
      setTimeout(() => {
        if (document.activeElement === sink.current) client.current?.focus();
      }, 50);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!viewOnlyNow.current && isPasteKey(e)) e.stopPropagation();
    };
    const onPointerDown = () => {
      if (!copied.current || viewOnlyNow.current) return;
      const text = copied.current;
      copied.current = null;
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    };
    const onPasteEvent = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      client.current?.focus();
      if (viewOnlyNow.current) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      if (new TextEncoder().encode(text).length > MAX_PASTE_BYTES) {
        onPasteNow.current?.({ state: 'failed', error: COPY.pasteTooLarge });
        return;
      }
      if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
        onPasteNow.current?.({ state: 'failed', error: COPY.pasteNoAnswer });
        return;
      }
      const id = ++pasteSeq.current;
      pending.current = id;
      onPasteNow.current?.({ state: 'pasting' });
      say({ type: 'paste', id, text });
    };
    host.addEventListener('keydown', onKeyDown, true);
    host.addEventListener('keyup', onKeyUp, true);
    host.addEventListener('pointerdown', onPointerDown, true);
    host.addEventListener('paste', onPasteEvent);
    return () => {
      host.removeEventListener('keydown', onKeyDown, true);
      host.removeEventListener('keyup', onKeyUp, true);
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('paste', onPasteEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`rb-screen-host${fit ? '' : ' is-actual'}`}>
      <div
        ref={screen}
        className={`rb-screen${viewOnly ? '' : ' is-controlling'}`}
        data-testid="runner-browser-screen"
      />
      {/* Where the browser's paste lands, for a moment, so that it fires in every browser. Never shown or read aloud. */}
      <textarea ref={sink} className="rb-paste-sink" aria-hidden tabIndex={-1} data-testid="runner-browser-paste-sink" />
    </div>
  );
}
