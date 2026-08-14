import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Spin } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SessionSearchHit } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { sessionSearchQuery } from '../lib/queries';
import { splitHighlight } from '../lib/searchHighlight';
import { sessionLifecycleStateOf } from '../lib/sessionState';
import { StatusIcon, statusLabel } from './WorkspaceView';

// Matches the server's CONTENT_MIN_CHARS. Below it the search only matches names (session title,
// branch, workspace, task) — the palette says so rather than letting the narrower result set read as
// "nothing else exists".
const CONTENT_MIN_CHARS = 3;

// The palette waits this long after the last keystroke before searching. Long enough that typing a
// word is one request rather than five, short enough to feel immediate.
const DEBOUNCE_MS = 200;

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const SEARCH_HINT = IS_MAC ? '⌘K' : 'Ctrl K';

/**
 * Opens the palette from a click elsewhere in the app — the session column's magnifier, which is
 * how it's reached on a touch device with no keyboard. A DOM event rather than a context: the
 * palette lives in the shell and the button lives inside a routed view, so a context would have to
 * wrap the whole tree to carry one boolean.
 */
const OPEN_EVENT = 'orbit:open-session-search';
export const openSessionSearch = (): void => {
  window.dispatchEvent(new Event(OPEN_EVENT));
};

/** Where a hit lives, when that isn't the normal Open list — so a result the user can't find in
 *  the sidebar explains itself instead of looking like a ghost. */
export const scopeBadge = (hit: SessionSearchHit): string | null => {
  const lifecycle = sessionLifecycleStateOf(hit);
  return lifecycle === 'TRASH' ? 'Trash' : lifecycle === 'COMPLETED' ? 'Completed' : null;
};

/** What the hit matched on, when it isn't the title (which the row already shows). */
const MATCH_LABEL: Partial<Record<SessionSearchHit['matchField'], string>> = {
  id: 'ID',
  prompt: 'first message',
  reply: 'last reply',
  message: 'message',
  branch: 'branch',
  agent: 'workspace',
  task: 'task',
};


/**
 * The ⌘K session palette. Mounted once by the app shell, so it works from every route.
 *
 * It searches across everything the sidebar can't reach in one place: every workspace, every runner,
 * and the Completed / Trash scopes as well as Open. With an empty query it lists
 * recents, which makes the same keystroke a fast session switcher.
 */
export function SessionSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // ⌘K / Ctrl+K from anywhere. Deliberately NOT skipped while an input or the composer has focus:
  // it carries a modifier, so it can't collide with typing, and "search from wherever I am" is the
  // whole point. `/` is not bound — it would collide with the composer's slash-command menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc is handled here rather than left to the Modal: AntD binds its own Esc to a keydown on
      // `.ant-modal-wrap`, so it only fires while focus sits inside the dialog. Focus lands there
      // via afterOpenChange, but anything that moves it out — tabbing to another window and back,
      // a click that ends up on the body — silently kills the key while the footer still promises
      // "esc close". Not preventDefault'd, and a no-op state set while closed, so every other Esc
      // consumer (the composer's slash menu, an open AntD dropdown) is unaffected.
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.altKey || e.shiftKey) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    const onOpen = (): void => setOpen(true);
    // Capture phase, which on `window` is the very first stop of the whole dispatch. Keyboard
    // extensions (Vimium and friends) bind Esc at document capture to blur the focused field and
    // swallow the key, so a bubble-phase listener never sees the first press: it only unfocuses
    // the search box, and closing takes a second Esc. Capturing here means the palette gets the
    // key first. Still nothing is preventDefault'd or stopped, so those extensions — and every
    // other Esc/⌘K consumer — keep receiving it.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // Opening starts from a clean slate: the previous query's results are never what you want next.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setDebounced('');
    setActive(0);
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const search = useQuery({
    ...sessionSearchQuery(debounced.trim()),
    enabled: open,
    // Hold the previous results while the next query is in flight, so the list doesn't blank out
    // between keystrokes.
    placeholderData: keepPreviousData,
  });

  const hits = useMemo(() => search.data?.hits ?? [], [search.data]);

  // Any new result set re-homes the selection to the top; keeping the old index would leave the
  // highlight on an unrelated row.
  useEffect(() => setActive(0), [search.data]);

  const openHit = useCallback(
    (hit: SessionSearchHit) => {
      setOpen(false);
      navigate(`/sessions/${encodeId(hit.id)}`);
    },
    [navigate],
  );

  // The search field is the palette's only control, so focus leaving it means the palette is dead
  // weight — close it. That is also what makes one Esc enough: a keyboard extension (Vimium and
  // friends) treats the first Esc as "leave insert mode", blurs the field and swallows the key
  // with stopImmediatePropagation, which beats even the window-capture listener above and left the
  // palette sitting there until a second press. A click on the palette's own chrome carries a
  // relatedTarget — AntD's modal wrap is tabindex="-1" and takes the focus — so it doesn't count,
  // and neither does the field going quiet because the whole window moved to another app.
  const onInputBlur = (e: React.FocusEvent<HTMLInputElement>): void => {
    if (e.relatedTarget || !document.hasFocus()) return;
    setOpen(false);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[active];
      if (hit) openHit(hit);
    }
  };

  // Keep the highlighted row visible while arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('.ssearch-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const trimmed = debounced.trim();
  const tooShortForContent = trimmed.length > 0 && search.data?.contentSearched === false;
  // Clamped: the server is the authority on the floor, so if it ever reports contentSearched:false
  // for a query that already looks long enough, the hint still reads sensibly instead of "type -1".
  const missingChars = Math.max(1, CONTENT_MIN_CHARS - [...trimmed].length);
  // The palette shows one page and has no way to ask for a second, so a capped result set has to
  // say so — otherwise "20 hits" for a common word reads as the whole answer.
  const total = search.data?.total ?? hits.length;
  const capped = total > hits.length;

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      closable={false}
      destroyOnClose
      width={640}
      // Sits high on the screen like every other command palette, instead of centred.
      style={{ top: 88 }}
      styles={{ body: { padding: 0 } }}
      afterOpenChange={(o) => o && inputRef.current?.focus()}
      className="ssearch-modal"
    >
      <div className="ssearch-head">
        <SearchOutlined className="ssearch-head-icon" />
        <input
          ref={inputRef}
          className="ssearch-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onInputKey}
          onBlur={onInputBlur}
          placeholder="Search sessions…"
          spellCheck={false}
          autoComplete="off"
        />
        {search.isFetching && <Spin size="small" />}
      </div>

      <div className="ssearch-list" ref={listRef}>
        {hits.length === 0 && !search.isFetching && (
          <div className="ssearch-empty">
            {trimmed ? `No sessions match “${trimmed}”.` : 'No sessions yet.'}
          </div>
        )}
        {hits.map((hit, i) => {
          const badge = scopeBadge(hit);
          const matchLabel = MATCH_LABEL[hit.matchField];
          return (
            <div
              key={hit.id}
              className={`ssearch-row${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => openHit(hit)}
            >
              <StatusIcon session={hit} />
              <div className="ssearch-body">
                <div className="ssearch-title-line">
                  <span className="ssearch-title">{hit.title}</span>
                  {badge && <span className="ssearch-badge">{badge}</span>}
                </div>
                <div className="ssearch-meta">
                  {hit.agent?.name && <span className="ssearch-workspace">{hit.agent.name}</span>}
                  <span>{statusLabel(hit)}</span>
                  {matchLabel && <span className="ssearch-in">in {matchLabel}</span>}
                </div>
                {hit.snippet && hit.matchField !== 'title' && (
                  <div className="ssearch-snippet">
                    {/* Highlighted with the query the server echoed back, not the one in the box:
                        both it and the snippet have had their markdown marks stripped, so pasting
                        "the **merge** button" still lights up the phrase inside the result. */}
                    {splitHighlight(hit.snippet, search.data?.q ?? trimmed).map((seg, si) =>
                      seg.match ? <mark key={si}>{seg.text}</mark> : <span key={si}>{seg.text}</span>,
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="ssearch-foot">
        {tooShortForContent ? (
          <span className="ssearch-hint-warn">
            Matching names only — type {missingChars} more character{missingChars === 1 ? '' : 's'} to
            search message text.
          </span>
        ) : (
          <span>
            {!trimmed
              ? 'Recent sessions'
              : capped
                ? `Top ${hits.length} of ${total} matching sessions`
                : 'Searching IDs, titles, messages, workspaces and tasks'}
          </span>
        )}
        <span className="ssearch-keys">
          <kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close
        </span>
      </div>
    </Modal>
  );
}
