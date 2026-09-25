import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal, Spin } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SessionSearchHit, WikiSearchRow } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { sessionSearchQuery, wikiSearchQuery } from '../lib/queries';
import { splitHighlight } from '../lib/searchHighlight';
import { sessionLifecycleStateOf } from '../lib/sessionState';
import { wikiAnchorMark, wikiKindWord, WIKI_TRUST_LABELS, WIKI_TITLE } from '../lib/wiki';
import { WikiAnchorMark, WikiKindMark, WikiTrustBadge } from './WikiMarks';
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


/** The placeholder: what this palette searches. Both, since the wiki group comes first. */
export const SEARCH_PLACEHOLDER = 'Search sessions and the wiki…';
/** The foot, when nothing is typed. */
export const SEARCH_FOOT_IDLE = 'Recent sessions';
/** The foot, when something is. Says which side is being searched first. */
export const SEARCH_FOOT_SEARCHING = 'Searching the wiki, then session titles, messages, workspaces and tasks';
/** The two group headings: the wiki's, with the count of hits under it, and the sessions'. */
export const SEARCH_WIKI_GROUP = WIKI_TITLE;
export const SEARCH_GROUP_SESSIONS = 'Sessions';
/** What a wiki row says when the entry is filed under no topic. */
export const WIKI_ROW_NO_TOPIC = 'No topic';

/**
 * Where a wiki row's click goes: the entry's own page, which takes its space as well as its id.
 *
 * The space's slug is what `?include=space` is for. A hit answered without one — a control plane
 * that is one release behind — falls back to the Wiki itself rather than to a page built from an
 * id that names no page (`/wiki/<id>` is not a route this deployment serves).
 */
export function wikiRowHref(hit: WikiSearchRow): string {
  return hit.spaceSlug
    ? `/wiki/${encodeURIComponent(hit.spaceSlug)}/e/${encodeURIComponent(hit.id)}`
    : '/wiki';
}

/** One wiki hit: the kind's mark, the title, its trust — then kind, topic and the anchor check. */
function WikiRow({
  hit,
  active,
  onHover,
  onOpen,
}: {
  hit: WikiSearchRow;
  active: boolean;
  onHover: () => void;
  onOpen: () => void;
}) {
  const anchor = wikiAnchorMark({ anchorState: hit.anchorState, anchorCheckedRef: hit.anchorCheckedRef ?? null });
  return (
    <div
      className={`ssearch-row${active ? ' active' : ''}`}
      onMouseEnter={onHover}
      onClick={onOpen}
    >
      <WikiKindMark kind={hit.kind} />
      <div className="ssearch-body">
        <div className="ssearch-title-line">
          <span className="ssearch-title">{hit.title}</span>
          <WikiTrustBadge trust={hit.trust} />
        </div>
        <div className="ssearch-meta">
          <span className="ssearch-workspace">{wikiKindWord(hit.kind)}</span>
          <span>{hit.topics?.[0] ?? WIKI_ROW_NO_TOPIC}</span>
          {anchor && <WikiAnchorMark mark={anchor} />}
        </div>
      </div>
    </div>
  );
}

/**
 * The ⌘K search palette. Mounted once by the app shell, so it works from every route.
 *
 * It searches across everything the sidebar can't reach in one place: every workspace, every runner,
 * and the Completed / Trash scopes as well as Open. With an empty query it lists
 * recents, which makes the same keystroke a fast session switcher.
 *
 * THE WIKI IS A GROUP ABOVE THE SESSIONS, AND ITS OWN READS. Entries come from `/wiki/search`
 * (`wikiSearchQuery`) and their hits are drawn by the code below rather than pushed through
 * `SessionSearchHit`: a wiki entry is not a session — the session shape has no room for a kind, a
 * trust or a topic — and every session hit's click goes to `/sessions/<id>`, which is not where an
 * entry lives. A client that decoded one as the other would fail on the whole answer, which is why
 * the two are two endpoints and two row builders (design §6, `GET /wiki/search`).
 *
 * One cursor covers both groups: the rows are concatenated for the keyboard (↑↓ and ⏎), so Enter
 * opens whatever the highlight is on — an entry's page, or a conversation.
 */
export interface SearchRow {
  key: string;
  hit: SessionSearchHit | WikiSearchRow;
  kind: 'session' | 'wiki';
}
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

  // The wiki answers the same keystrokes: one debounce, two requests, two draws. Without a query
  // there is nothing to look up, and the palette stays the session switcher it has always been.
  const wiki = useQuery({
    ...wikiSearchQuery(debounced.trim()),
    enabled: open && debounced.trim() !== '',
  });

  const hits = useMemo(() => search.data?.hits ?? [], [search.data]);
  const wikiHits = useMemo(() => wiki.data?.hits ?? [], [wiki.data]);
  // One cursor over both groups: the wiki is drawn first, so it is walked first.
  const rows = useMemo<SearchRow[]>(
    () => [
      ...wikiHits.map((hit) => ({ key: `wiki:${hit.id}`, hit, kind: 'wiki' as const })),
      ...hits.map((hit) => ({ key: `session:${hit.id}`, hit, kind: 'session' as const })),
    ],
    [wikiHits, hits],
  );

  // Any new result set re-homes the selection to the top; keeping the old index would leave the
  // highlight on an unrelated row.
  useEffect(() => setActive(0), [search.data, wiki.data]);

  const openRow = useCallback(
    (row: SearchRow | undefined) => {
      if (!row) return;
      setOpen(false);
      if (row.kind === 'wiki') navigate(wikiRowHref(row.hit as WikiSearchRow));
      else navigate(`/sessions/${encodeId((row.hit as SessionSearchHit).id)}`);
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
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openRow(rows[active]);
    }
  };

  // Keep the highlighted row visible while arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('.ssearch-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const trimmed = debounced.trim();
  const tooShortForContent = trimmed.length > 0 && search.data?.contentSearched === false;
  // Two things produce contentSearched:false and they need different sentences: a query still
  // being typed, and a long query the server had to broaden into words that are individually
  // below the floor (a Chinese query segments into 2-character words). Only the first is fixed by
  // typing more.
  const isShort = [...trimmed].length < CONTENT_MIN_CHARS;
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
          placeholder={SEARCH_PLACEHOLDER}
          spellCheck={false}
          autoComplete="off"
        />
        {(search.isFetching || wiki.isFetching) && <Spin size="small" />}
      </div>

      <div className="ssearch-list" ref={listRef}>
        {/* The wiki first, and only when something was typed: the group's heading is what says the
            palette searched it at all, and an empty query is the session switcher it always was. */}
        {trimmed !== '' && wikiHits.length > 0 && (
          <>
            <div className="wk-pal-group">
              {SEARCH_WIKI_GROUP} <span className="n">{wikiHits.length}</span>
            </div>
            {wikiHits.map((hit, i) => (
              <WikiRow
                key={hit.id}
                hit={hit}
                active={i === active}
                onHover={() => setActive(i)}
                onOpen={() => openRow(rows[i])}
              />
            ))}
          </>
        )}
        {trimmed !== '' && wikiHits.length > 0 && hits.length > 0 && (
          <div className="wk-pal-group">{SEARCH_GROUP_SESSIONS}</div>
        )}
        {hits.length === 0 && wikiHits.length === 0 && !search.isFetching && !wiki.isFetching && (
          <div className="ssearch-empty">
            {trimmed ? `No sessions match “${trimmed}”.` : 'No sessions yet.'}
          </div>
        )}
        {hits.map((hit, i) => {
          const badge = scopeBadge(hit);
          const matchLabel = MATCH_LABEL[hit.matchField];
          const at = wikiHits.length + i;
          return (
            <div
              key={hit.id}
              className={`ssearch-row${at === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(at)}
              onClick={() => openRow(rows[at])}
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
            {isShort ? (
              <>
                Matching names only — type {missingChars} more character
                {missingChars === 1 ? '' : 's'} to search message text.
              </>
            ) : (
              <>
                No exact match — matching names by word. Message text needs the exact phrase.
              </>
            )}
          </span>
        ) : (
          <span>
            {!trimmed
              ? SEARCH_FOOT_IDLE
              : capped
                ? `Top ${hits.length} of ${total} matching sessions`
                : SEARCH_FOOT_SEARCHING}
          </span>
        )}
        <span className="ssearch-keys">
          <kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close
        </span>
      </div>
    </Modal>
  );
}
