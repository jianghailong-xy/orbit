import { useCallback, useEffect, useRef, useState } from 'react';
import { CloseOutlined, DownOutlined, LoadingOutlined, SearchOutlined, UpOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EventSearchHit } from '@orbit/shared';
import { sessionEventSearchQuery } from '../lib/queries';
import { splitHighlight } from '../lib/searchHighlight';
import { findMatches, type FindSegment } from '../lib/findMatches';
import { relTime } from './Transcript';

/**
 * Find within the open session (⌘F / Ctrl+F).
 *
 * The search runs on the server, over the session's whole history. It has to: the transcript
 * loads tail-first, so the client holds only the newest page or two, and even inside that window
 * the bodies of folded tool cards and server-trimmed payload previews are not in the DOM. A find
 * that only walked the DOM would answer "no matches" for things the session plainly contains.
 *
 * So the server owns the answer (which events match, and how many), and the client owns the
 * showing of it: it loads back to a hit that isn't in the window yet, scrolls to it, and paints
 * every occurrence in view through the CSS Custom Highlight API — Ranges, never injected `<mark>`
 * elements, because the transcript is React-rendered and streams while you read it.
 */

const HL_ALL = 'orbit-find';
const HL_CURRENT = 'orbit-find-current';
/** Painting needs the Highlight API; the search itself doesn't, so everything else still works. */
const CAN_PAINT = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const FIND_HINT = IS_MAC ? '⌘F' : 'Ctrl F';

/** Opens the bar from a click elsewhere — the session menu's "Find in session", which is how it's
 *  reached without a keyboard. Same DOM-event idiom as the ⌘K palette's `openSessionSearch`. */
const OPEN_EVENT = 'orbit:open-session-find';
export const openSessionFind = (): void => {
  window.dispatchEvent(new Event(OPEN_EVENT));
};

/** Long enough that typing a word is one request, not five. */
const DEBOUNCE_MS = 200;
/** A ceiling on the pages one jump may pull in. The deepest session in this deployment holds
 *  ~2,100 renderable events (11 pages of 200); 30 is headroom, not a working limit. */
const MAX_LOAD_PAGES = 30;
/** Keep a jumped-to match this far from the scroll container's top. */
const SCROLL_MARGIN = 96;
/** How long a jumped-to card stays outlined — enough to catch the eye when the match itself is
 *  folded away inside it and nothing gets highlighted. */
const FLASH_MS = 1400;

/** Elements whose text is part of the surrounding sentence — a match may run straight through
 *  them. Anything else starts a new block (see FindSegment.block). */
const INLINE = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DEL', 'EM', 'I', 'INS', 'KBD', 'LABEL', 'MARK',
  'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR',
]);

/** Subtrees that hold no readable transcript text. */
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEXTAREA', 'INPUT', 'SELECT']);

/** What kind of thing matched, for the result row. Tool hits show the tool's own name instead. */
const TYPE_LABEL: Record<string, string> = {
  user: 'You',
  assistant: 'Reply',
  thinking: 'Thinking',
  error: 'Error',
};

const hitLabel = (hit: EventSearchHit): string =>
  hit.toolName ?? TYPE_LABEL[hit.type] ?? (hit.type === 'tool_result' ? 'Tool output' : hit.type);

interface Props {
  /** Resets the bar when the user switches sessions — the matches point at a DOM that's gone. */
  sessionId: string;
  /** The transcript's scroll container: both the search root and what we scroll to a match. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Pulls in the next older page; resolves true when events were actually prepended. */
  loadOlder: () => Promise<boolean>;
  /** Whether the server still holds events older than the ones loaded. */
  hasOlder: () => boolean;
  /** The earliest seq currently in the transcript, or null while nothing is loaded — how a jump
   *  knows whether its target is already in the window. */
  oldestSeq: () => number | null;
}

export function SessionFind({ sessionId, containerRef, loadOlder, hasOlder, oldestSeq }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [cursor, setCursor] = useState(-1); // index into hits; -1 = nothing selected yet
  const [jumping, setJumping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);
  const queryRef = useRef('');
  const hitsRef = useRef<EventSearchHit[]>([]);
  const cursorRef = useRef(-1);
  const jumpingRef = useRef(false);
  /** The seq of the hit we last jumped to — what a rescan re-derives the current highlight from,
   *  since a prepend or a streamed chunk replaces the Range objects wholesale. */
  const currentSeqRef = useRef<number | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The callbacks the parent hands down, held in refs so every callback below stays stable:
  // WorkspaceView re-renders on each streamed chunk, and the debounce effect must not be torn down
  // and restarted faster than its own timer can fire.
  const loadOlderRef = useRef(loadOlder);
  const hasOlderRef = useRef(hasOlder);
  const oldestSeqRef = useRef(oldestSeq);
  useEffect(() => {
    loadOlderRef.current = loadOlder;
    hasOlderRef.current = hasOlder;
    oldestSeqRef.current = oldestSeq;
  });

  const trimmed = debounced.trim();
  const search = useQuery({
    ...sessionEventSearchQuery(sessionId, trimmed),
    enabled: open && trimmed.length > 0,
    // Hold the previous hits while the next query is in flight, so the list doesn't blank out
    // between keystrokes.
    placeholderData: keepPreviousData,
  });
  // Newest first, as the server returns them: the matches nearest what the user is reading come
  // first, and ↓ walks back through history from there.
  const hits = trimmed ? (search.data?.hits ?? []) : [];
  const total = trimmed ? (search.data?.total ?? 0) : 0;
  hitsRef.current = hits;

  // ── painting ────────────────────────────────────────────────────────────────────────────────

  const paint = useCallback((ranges: Range[], current: Range | null) => {
    if (!CAN_PAINT) return;
    if (!ranges.length) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
      return;
    }
    CSS.highlights.set(HL_ALL, new Highlight(...ranges));
    if (!current) {
      CSS.highlights.delete(HL_CURRENT);
      return;
    }
    const one = new Highlight(current);
    one.priority = 1; // both highlights cover the current match; this one has to win
    CSS.highlights.set(HL_CURRENT, one);
  }, []);

  /** The element a hit's card starts at: the last `data-seq` stamp at or before it, so a match
   *  folded inside a card (a tool_result, a grouped run, a sub-workspace's events) resolves to the
   *  card that contains it. */
  const elementForSeq = useCallback(
    (seq: number): HTMLElement | null => {
      const root = containerRef.current;
      if (!root) return null;
      let best: HTMLElement | null = null;
      for (const el of root.querySelectorAll<HTMLElement>('[data-seq]')) {
        const s = Number(el.dataset.seq);
        if (Number.isFinite(s) && s <= seq) best = el;
        else if (s > seq) break; // document order is seq order
      }
      return best;
    },
    [containerRef],
  );

  /**
   * Re-run the in-DOM scan and repaint. The transcript changes constantly — a streamed chunk, a
   * prepended page, a tool card the user expanded — and the Ranges are only valid for the DOM
   * they were built from.
   */
  const rescan = useCallback((): void => {
    const root = containerRef.current;
    const q = queryRef.current;
    if (!root || !q) {
      paint([], null);
      return;
    }
    const nodes: Text[] = [];
    const segments: FindSegment[] = [];
    const blocks = new Map<Element, number>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
        const el = node as Element;
        // REJECT prunes the whole subtree; SKIP keeps walking into it but emits no element.
        return SKIP.has(el.tagName) ||
          el.hasAttribute('hidden') ||
          el.getAttribute('aria-hidden') === 'true'
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (!parent) continue;
      let block: Element = parent;
      while (block !== root && INLINE.has(block.tagName) && block.parentElement) {
        block = block.parentElement;
      }
      let id = blocks.get(block);
      if (id === undefined) {
        id = blocks.size;
        blocks.set(block, id);
      }
      nodes.push(n as Text);
      segments.push({ text: n.nodeValue as string, block: id });
    }
    const ranges = findMatches(segments, q).map((m) => {
      const r = document.createRange();
      r.setStart(nodes[m.startSeg], m.startOffset);
      r.setEnd(nodes[m.endSeg], m.endOffset);
      return r;
    });
    // The current match is re-derived from the seq we jumped to, not remembered as an object.
    const seq = currentSeqRef.current;
    const host = seq == null ? null : elementForSeq(seq);
    const current = host ? (ranges.find((r) => host.contains(r.startContainer)) ?? null) : null;
    paint(ranges, current);
  }, [containerRef, elementForSeq, paint]);

  // ── jumping to a hit ────────────────────────────────────────────────────────────────────────

  const scrollToHit = useCallback(
    (host: HTMLElement) => {
      const root = containerRef.current;
      if (!root) return;
      const c = root.getBoundingClientRect();
      // Prefer the match itself when it's rendered; fall back to the card that holds it (a
      // folded tool body has no visible match to aim at).
      const painted: Range[] = [];
      if (CAN_PAINT) CSS.highlights.get(HL_CURRENT)?.forEach((r) => painted.push(r as Range));
      const box = painted[0]?.getBoundingClientRect();
      const target = box && (box.height || box.width) ? box : host.getBoundingClientRect();
      root.scrollBy({ top: target.top - c.top - SCROLL_MARGIN, behavior: 'smooth' });
    },
    [containerRef],
  );

  const flash = useCallback((host: HTMLElement) => {
    clearTimeout(flashTimer.current);
    host.classList.add('find-flash');
    flashTimer.current = setTimeout(() => host.classList.remove('find-flash'), FLASH_MS);
  }, []);

  /**
   * Go to hit `i`: load back until its event is in the transcript window, then scroll to it.
   * Loading is deterministic — the server told us the seq, so this walks to a known destination
   * rather than pulling pages hoping something turns up.
   */
  const jumpTo = useCallback(
    async (i: number) => {
      const hit = hitsRef.current[i];
      if (!hit || jumpingRef.current) return;
      setCursor(i);
      cursorRef.current = i;
      currentSeqRef.current = hit.seq;
      jumpingRef.current = true;
      setJumping(true);
      try {
        for (let page = 0; page < MAX_LOAD_PAGES; page++) {
          const oldest = oldestSeqRef.current();
          if (oldest != null && oldest <= hit.seq) break;
          if (!hasOlderRef.current()) break;
          if (!(await loadOlderRef.current())) break;
          if (!openRef.current) return;
        }
        // Let React commit any prepend (a task, then a frame) before reading the DOM back.
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        if (!openRef.current) return;
        rescan();
        const host = elementForSeq(hit.seq);
        if (host) {
          scrollToHit(host);
          flash(host);
        }
      } finally {
        jumpingRef.current = false;
        setJumping(false);
      }
    },
    [elementForSeq, flash, rescan, scrollToHit],
  );

  const step = useCallback(
    (delta: number) => {
      const n = hitsRef.current.length;
      if (!n) return;
      // From nothing selected, ↓ starts at the newest match and ↑ at the oldest.
      const from = cursorRef.current;
      const next = from < 0 ? (delta > 0 ? 0 : n - 1) : (from + delta + n) % n;
      void jumpTo(next);
    },
    [jumpTo],
  );

  const close = useCallback(() => setOpen(false), []);

  // ── wiring ──────────────────────────────────────────────────────────────────────────────────

  // ⌘F / Ctrl+F while a transcript is open. Bound on the window (not the transcript) so it works
  // from the composer too, and preventDefault'd to take the key from the browser's own find —
  // which searches the sidebar and header as readily as the conversation, and can reach neither
  // the history that isn't loaded nor the bodies of folded cards.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc closes from wherever focus happens to be, not just from the input — the same trap the
      // ⌘K palette hit (3e8d888): a bar that stays put after Esc reads as stuck. Not
      // preventDefault'd, and only while open, so other Esc consumers keep working.
      if (e.key === 'Escape') {
        if (openRef.current) setOpen(false);
        return;
      }
      if (e.key !== 'f' && e.key !== 'F') return;
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.altKey || e.shiftKey) return;
      e.preventDefault();
      setOpen(true);
      // Already open: re-focus and select, so a second ⌘F retypes rather than appends.
      inputRef.current?.select();
    };
    const onOpen = (): void => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    queryRef.current = debounced.trim();
  }, [debounced]);

  // Switching sessions invalidates everything: the hits belong to the old session and the
  // Ranges to a DOM that's gone.
  useEffect(() => {
    setOpen(false);
  }, [sessionId]);

  // Closing drops the highlights; so does unmounting, since they live on the document, not here.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      return;
    }
    setQuery('');
    setDebounced('');
    setCursor(-1);
    cursorRef.current = -1;
    currentSeqRef.current = null;
    if (CAN_PAINT) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
    }
  }, [open]);

  useEffect(
    () => () => {
      clearTimeout(flashTimer.current);
      if (!CAN_PAINT) return;
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, query]);

  // A new query drops the selection (nothing is jumped to until asked) and repaints what's in
  // view, so the visible occurrences light up while the server answers.
  useEffect(() => {
    if (!open) return;
    setCursor(-1);
    cursorRef.current = -1;
    currentSeqRef.current = null;
    rescan();
  }, [debounced, open, rescan]);

  // Keep the painted matches honest while the transcript changes underneath them. Painting
  // mutates nothing, so this can't feed itself.
  useEffect(() => {
    if (!open) return;
    const root = containerRef.current;
    if (!root) return;
    let t: number | undefined;
    const obs = new MutationObserver(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (queryRef.current && !jumpingRef.current) rescan();
      }, 200);
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      window.clearTimeout(t);
    };
  }, [containerRef, open, rescan]);

  // Keep the selected row visible while stepping past the fold.
  useEffect(() => {
    listRef.current?.querySelector('.find-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const capped = total > hits.length;
  const status = search.isFetching
    ? 'Searching…'
    : !trimmed
      ? ''
      : total === 0
        ? 'No matches'
        : `${cursor >= 0 ? `${cursor + 1}/` : ''}${hits.length}${capped ? ` of ${total}` : ''}`;

  return (
    <div className="find-bar" role="search">
      <div className="find-head">
        <SearchOutlined className="find-icon" />
        <input
          ref={inputRef}
          className="find-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Let an IME keep Enter for picking a candidate — the whole feature is unusable in
            // Chinese otherwise.
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              step(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              step(-1);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
          placeholder="Find in session…"
          aria-label="Find in session"
          spellCheck={false}
          autoComplete="off"
        />
        <span
          className={`find-count${trimmed && !search.isFetching && total === 0 ? ' find-none' : ''}`}
          title={capped ? `${total} matches — the newest ${hits.length} are listed` : undefined}
        >
          {jumping ? <LoadingOutlined spin /> : status}
        </span>
        <button type="button" className="find-btn" onClick={() => step(-1)} title="Previous match (⇧↵)">
          <UpOutlined />
        </button>
        <button type="button" className="find-btn" onClick={() => step(1)} title="Next match (↵)">
          <DownOutlined />
        </button>
        <button type="button" className="find-btn" onClick={close} title="Close (Esc)">
          <CloseOutlined />
        </button>
      </div>

      {hits.length > 0 && (
        <div className="find-list" ref={listRef}>
          {hits.map((hit, i) => (
            <div
              key={hit.seq}
              className={`find-row${i === cursor ? ' active' : ''}`}
              onClick={() => void jumpTo(i)}
            >
              <div className="find-row-head">
                <span className="find-row-kind">{hitLabel(hit)}</span>
                <span className="find-row-time">{relTime(String(hit.ts))}</span>
              </div>
              <div className="find-row-snippet">
                {splitHighlight(hit.snippet, trimmed).map((seg, si) =>
                  seg.match ? <mark key={si}>{seg.text}</mark> : <span key={si}>{seg.text}</span>,
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
