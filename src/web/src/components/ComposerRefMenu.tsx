import type { ReactNode } from 'react';

/**
 * The composer's `@` and `#` popup (board docs/mocks/session-at-references/board-at-menu.html).
 *
 * One list of rows, each a status mark, a title in the body font, a second line saying where it
 * lives, and on the right the time — with a state word only when it is worth one. Not the `/`
 * command menu it used to borrow: a reference is a thing with a state, not a command name.
 */
export type RefMenuTone = 'run' | 'fail' | 'wait' | 'idle';

export interface RefMenuRow {
  key: string;
  /** A session is a round mark, a project or task a square one, so the two never read alike. */
  shape: 'round' | 'square';
  tone: RefMenuTone;
  title: string;
  sub: string;
  state?: string | null;
  time?: string | null;
}

/** Up to here a query with nothing found still says so; past it the person is writing prose. */
const QUIET_AFTER_WORDS = 3;

/** Whether a query with no match should still show the popup's "nothing matches" line. */
export function showsEmpty(query: string): boolean {
  return query.trim().split(/\s+/).filter(Boolean).length < QUIET_AFTER_WORDS;
}

/** "now", "12m", "3h", "Yesterday", "5d", or the date — short enough for the row's right edge. */
export function rowTime(iso: string | Date | null | undefined, now: number): string | null {
  if (!iso) return null;
  const at = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `text` with the first case-insensitive occurrence of `query` marked. */
function marked(text: string, query: string): ReactNode {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

export function ComposerRefMenu({
  heading,
  query,
  rows,
  activeIndex,
  loading,
  left,
  hint,
  onPick,
  onHover,
}: {
  heading: string;
  query: string;
  rows: readonly RefMenuRow[];
  activeIndex: number;
  /** The first answer has not come back yet: placeholder rows, so the popup does not jump. */
  loading: boolean;
  /** Where the typed sigil sits, in px from the composer's left edge. */
  left: number;
  /** The footer's right-hand line. */
  hint: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const q = query.trim();
  return (
    <div className="composer-ref-menu" role="listbox" aria-label={heading} style={{ left }}>
      <div className="composer-ref-head">
        <span>{heading}</span>
        {q && <span className="composer-ref-query">matching “{q}”</span>}
      </div>
      {loading && rows.length === 0 ? (
        <div aria-hidden="true">
          <div className="composer-ref-skel" />
          <div className="composer-ref-skel" />
          <div className="composer-ref-skel" />
        </div>
      ) : rows.length === 0 ? (
        <div className="composer-ref-empty">Nothing matches. Keep typing, or press Esc to write it as text.</div>
      ) : (
        <div className="composer-ref-rows">
          {rows.map((row, i) => (
            <div
              key={row.key}
              role="option"
              aria-selected={i === activeIndex}
              className={`composer-ref-row${i === activeIndex ? ' is-active' : ''}`}
              // mousedown (not click) + preventDefault keeps focus in the textarea.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(i);
              }}
              onMouseEnter={() => onHover(i)}
            >
              <span className={`composer-ref-mark composer-ref-mark--${row.shape} is-${row.tone}`} aria-hidden="true" />
              <span className="composer-ref-main">
                <span className="composer-ref-title">{marked(row.title, q)}</span>
                <span className="composer-ref-sub">{row.sub}</span>
              </span>
              <span className="composer-ref-side">
                {row.state && <span className={`composer-ref-state is-${row.tone}`}>{row.state}</span>}
                {row.time && <span className="composer-ref-time">{row.time}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="composer-ref-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> choose
        </span>
        <span>
          <kbd>↵</kbd> insert
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
        <span className="composer-ref-hint">{hint}</span>
      </div>
    </div>
  );
}
