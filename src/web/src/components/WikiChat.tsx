import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CommentOutlined } from '@ant-design/icons';
import { WIKI_DOC_SECTION_EVENT } from './WikiDirectory';
import { WikiChatFab } from './WikiChatFab';
import { WikiChatPanel } from './WikiChatPanel';
import { routeId } from '../lib/idCodec';
import { wikiChatDraftsQuery, wikiChatsQuery, wikiDocQuery, wikiDocsQuery, wikiEntryQuery, wikiPlanQuery } from '../lib/queries';
import {
  WIKI_CHAT_ASK,
  WIKI_CHAT_FOCUS_NEEDS_YOU,
  WIKI_CHAT_NEW_PARAM,
  WIKI_CHAT_NO_ATTACHMENTS,
  WIKI_CHAT_PARAM,
  readWikiChatClosed,
  readWikiChatOpen,
  readWikiChatWidth,
  wikiChatAttach,
  wikiChatCapped,
  wikiChatDocks,
  wikiChatFab,
  wikiChatFabShown,
  wikiChatFoldsDirectory,
  wikiChatLayout,
  wikiChatPageSection,
  wikiChatPanelWidth,
  wikiChatReading,
  wikiChatSearch,
  wikiChatSnap,
  wikiChatToOpen,
  writeWikiChatClosed,
  writeWikiChatOpen,
  writeWikiChatWidth,
  type WikiChatPage,
  type WikiChatQuote,
  type WikiChatReading,
  type WikiChatSentence,
} from '../lib/wikiChat';
import { wikiChatWhere } from '@orbit/shared';
import type { WikiSpaceRow } from '../lib/wiki';
import { wikiDocSectionOfAnchor, type WikiDocView } from '../lib/wikiDocs';

/**
 * What a page of the Wiki asks of the chat: to put a selection in the composer, and which sentences the
 * composer's quote names, so the page can light them; which sections an open card of the chat in the panel would
 * rewrite, so the page can mark them before the press (board 42 ②); and to open a chat at one of its cards (Activity's
 * banner). Null outside a chat's host (a share link, Settings).
 */
interface WikiChatApi {
  ask: (quote: WikiChatQuote) => void;
  quoted: ReadonlySet<string>;
  /** `<doc>#<key>` of every section an open card of the shown chat would rewrite. */
  wouldRewrite: ReadonlySet<string>;
  open: (chat: string, card?: string | null) => void;
}

/** A section as `wouldRewrite` names it. */
export const wikiChatSectionId = (doc: string, key: string): string => `${doc}#${key}`;

const WikiChatCtx = createContext<WikiChatApi | null>(null);

export const useWikiChat = (): WikiChatApi | null => useContext(WikiChatCtx);

/** The window's width, as the panel's place is read from it (design §4.1). */
function useWindowWidth(): number {
  const read = () => (typeof window === 'undefined' ? 1440 : window.innerWidth);
  const [width, setWidth] = useState(read);
  useEffect(() => {
    const onResize = () => setWidth(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

/** The space between the Wiki's head and the panel's top, while the head is on screen. */
const UNDER_HEAD = 10;

/**
 * The chat's place on every page of a space but its Settings (design §3, §4): the round button, the panel it
 * opens, and the composer's attachments, which the pages feed.
 *
 * THE ADDRESS SAYS WHICH CHAT IS OPEN (`?chat=<session>`, or `?chat=new`): a reload brings the panel back. A
 * page turned by one of the wiki's own links drops the query, so the tab keeps the chat it shows per space and
 * puts the address back (`readWikiChatOpen`): turning pages does not close the panel; hiding it does.
 *
 * OPEN BY DEFAULT WHERE IT DOCKS (board 45 ①②, owner 11-11, contract `chat.panel.openByDefault`): with no chat named
 * by the address or the tab, a page whose layout docks the panel shows it on the chat the round button would open,
 * unless the owner hid it with ✕ in this space (`readWikiChatClosed`, kept on the device until the button opens it
 * again). That opening is derived, never written: narrowed past docking it folds away, widened it comes back. Until
 * the chats are read the page is laid out at the panel's width already, so it does not jump when the panel comes.
 *
 * WHERE IT STANDS (§4.1, `wikiChatLayout`): wide windows dock it and push everything under the Wiki's head over,
 * leaving the head's buttons where they are (board 42 ①); narrower ones fold the directory into Contents; under
 * 1200 it lies over the page's right with no scrim, under 640 it is a sheet. The entry drawer opens to its left,
 * the button floats above the drawer, and the page's foot keeps 88 clear for the button.
 */
export function WikiChatHost({ space, route, children }: { space: WikiSpaceRow; route: string; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const list = useQuery(wikiChatsQuery(space.id));
  const fabShown = wikiChatFabShown(route, true) && list.data !== null;

  const asked = new URLSearchParams(location.search).get(WIKI_CHAT_PARAM);
  const kept = readWikiChatOpen(space.slug);
  const layout = wikiChatLayout(useWindowWidth());
  // Read from storage on every render, as `kept` is: ✕ and the button write it beside a navigation, and a state of its
  // own would render once more with the old address first, which the effect below would then put back.
  const closed = readWikiChatClosed(space.slug);
  const setClosed = useCallback((next: boolean) => writeWikiChatClosed(space.slug, next), [space.slug]);
  // Shown by default (board 45): only where it docks, on a page that has the panel, and not once hidden with ✕.
  const byDefault = asked === null && kept === null && wikiChatFabShown(route, true) && wikiChatDocks(layout) && !closed;
  const defaultChat = byDefault && list.data ? wikiChatToOpen(list.data.chats) : null;
  const chat = asked ?? kept ?? defaultChat;
  const open = chat !== null;
  // The chats are still being read: lay the page out at the panel's width already.
  const reserving = byDefault && list.isPending;

  const go = useCallback(
    (next: string | null) => {
      writeWikiChatOpen(space.slug, next);
      navigate(
        { pathname: location.pathname, search: wikiChatSearch(location.search, next), hash: location.hash },
        { replace: true, state: location.state },
      );
    },
    [navigate, location.pathname, location.search, location.hash, location.state, space.slug],
  );
  // The address and the tab keep the same chat: an address that names one is remembered, and a page that lost
  // it to a link gets it back.
  useLayoutEffect(() => {
    if (asked) {
      if (asked !== kept) writeWikiChatOpen(space.slug, asked);
    } else if (kept) {
      navigate(
        { pathname: location.pathname, search: wikiChatSearch(location.search, kept), hash: location.hash },
        { replace: true, state: location.state },
      );
    }
  }, [asked, kept, space.slug, navigate, location.pathname, location.search, location.hash, location.state]);

  const [dragged, setDragged] = useState<number | null>(() => readWikiChatWidth());
  const width = wikiChatPanelWidth(layout, dragged);

  // The panel's top: under the Wiki's head while the head is on screen, then the top of the page's scroll.
  const hostRef = useRef<HTMLDivElement>(null);
  const top = usePanelTop(hostRef, open, location.pathname);

  const [attachments, dispatch] = useReducer(wikiChatAttach, WIKI_CHAT_NO_ATTACHMENTS);
  const page = useWikiChatPage(space, route);
  useEffect(() => dispatch({ type: 'follow', page }), [page]);

  const chats = list.data?.chats;
  // The card the panel brings into view when it opens a chat (the button: the first that needs the owner; Activity: one
  // card), kept with that chat: closing or turning to another needs no write of its own, which would render once more
  // with the address before the navigation and put the old chat back.
  const [focused, setFocused] = useState<{ chat: string; card: string } | null>(null);
  const focus = focused && focused.chat === chat
    ? focused.card
    : defaultChat !== null && chat === defaultChat && list.data?.fab && wikiChatFab(list.data.fab).state === 'needs_you'
      ? WIKI_CHAT_FOCUS_NEEDS_YOU
      : null;
  // The shown chat's cards: the sections its open ones would rewrite are marked on the page beside it (board 42 ②).
  const shownChat = chat && chat !== WIKI_CHAT_NEW_PARAM ? (routeId(chat) ?? chat) : null;
  const cards = useQuery(wikiChatDraftsQuery(shownChat));
  const wouldRewrite = useMemo(
    () =>
      new Set(
        (cards.data ?? [])
          .filter((card) => card.state === 'draft')
          .flatMap((card) => card.rewrites.map((section) => wikiChatSectionId(section.doc, section.key))),
      ),
    [cards.data],
  );
  const api = useMemo<WikiChatApi>(
    () => ({
      ask: (quote) => {
        dispatch({ type: 'quote', quote });
        if (!open) go(wikiChatToOpen(chats));
      },
      quoted: new Set(attachments.quote?.sentenceIds ?? []),
      wouldRewrite,
      open: (next, card = null) => {
        setFocused(card ? { chat: next, card } : null);
        go(next);
      },
    }),
    [attachments.quote, open, go, chats, wouldRewrite],
  );

  const fab = wikiChatFab(list.data?.fab);
  const docks = (open || reserving) && wikiChatDocks(layout);
  const className = [
    'wk-chat-host',
    fabShown ? 'has-fab' : '',
    open ? `is-open is-${layout}` : '',
    docks ? 'is-docked' : '',
    (open || reserving) && wikiChatFoldsDirectory(layout) ? 'is-fold' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const style = (open || reserving) && width ? ({ '--wk-chat-w': `${width}px` } as CSSProperties) : undefined;

  return (
    <WikiChatCtx.Provider value={api}>
      <div ref={hostRef} className={className} style={style}>
        {children}
      </div>
      {fabShown && !open && (
        <WikiChatFab
          state={fab.state}
          label={fab.label}
          count={fab.count}
          onOpen={() => {
            // Straight to the card that needs the owner, when one does (design §3).
            const next = wikiChatToOpen(chats);
            setFocused(fab.state === 'needs_you' ? { chat: next, card: WIKI_CHAT_FOCUS_NEEDS_YOU } : null);
            // The button undoes ✕: pages open with the panel shown again (board 45, Q1 A).
            setClosed(false);
            go(next);
          }}
        />
      )}
      {open && (
        <WikiChatPanel
          space={space}
          chat={chat}
          list={list.data}
          layout={layout}
          width={width}
          top={top}
          attachments={attachments}
          dispatch={dispatch}
          cards={shownChat ? (cards.data ?? null) : null}
          focus={focus}
          onChat={go}
          onClose={() => {
            // ✕ is the owner saying no: kept on the device until the button opens the panel again (board 45, Q1 A).
            setClosed(true);
            go(null);
          }}
          onResize={(next, done) => {
            setDragged(next);
            if (done) writeWikiChatWidth(wikiChatPanelWidth('wide', next) ?? next);
          }}
        />
      )}
    </WikiChatCtx.Provider>
  );
}

/** Where the panel's top is: below the Wiki's head while it shows, else the top of the page's own scroll. */
function usePanelTop(hostRef: RefObject<HTMLDivElement | null>, open: boolean, pathname: string): number {
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const host = hostRef.current;
      if (!host) return;
      const scroller = host.closest('.app-view');
      const floor = scroller ? scroller.getBoundingClientRect().top : 0;
      const head = host.querySelector('.wk-title-row');
      const below = head && head.getClientRects().length > 0 ? head.getBoundingClientRect().bottom + UNDER_HEAD : 0;
      setTop(Math.max(0, Math.round(Math.max(floor, below))));
    };
    measure();
    window.addEventListener('scroll', measure, { capture: true, passive: true });
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, { capture: true });
      window.removeEventListener('resize', measure);
    };
  }, [hostRef, open, pathname]);
  return top;
}

/** No section announced yet, and no anchor. */
const NO_READING: WikiChatReading = { read: null, anchor: null };

/**
 * The page the composer attaches (design §4.2): a document and the section nearest the top of the reading (the
 * one the directory lights, `WIKI_DOC_SECTION_EVENT`) — or the section its address's anchor names, until the reader
 * scrolls (`wikiChatReading`, C15) —, an entry's drawer its entry, a plan page its document.
 * Other pages attach none: the contract names no other kind (`chat.notes.wikiContext`).
 */
function useWikiChatPage(space: WikiSpaceRow, route: string): WikiChatPage | null {
  const params = useParams();
  const { hash } = useLocation();
  const docSlug = route === 'doc' ? (params.doc ?? null) : null;
  const planSlug = route === 'planDoc' || route === 'planSection' ? (params.doc ?? null) : null;
  // A plan page at one of its document's sections (`…/plan/d/<doc>/<n>`) attaches that section too (C12).
  const planIndex = route === 'planSection' && /^\d+$/u.test(params.section ?? '') ? Number(params.section) : null;
  const entryId = route === 'entry' ? (routeId(params.entry) ?? params.entry ?? null) : null;
  const doc = useQuery(wikiDocQuery(docSlug ? space.id : null, docSlug));
  const docs = useQuery(wikiDocsQuery(planSlug ? space.id : null));
  const plan = useQuery({ ...wikiPlanQuery(space.id), enabled: planIndex !== null });
  const entry = useQuery(wikiEntryQuery(entryId));
  const [reading, read] = useReducer(wikiChatReading, NO_READING);
  // Taken before the page's jump to it can announce where it landed: the layout effect runs ahead of the page's own.
  const anchored = docSlug ? wikiDocSectionOfAnchor(hash) : null;
  useLayoutEffect(() => read({ type: 'anchor', slug: docSlug, key: anchored }), [docSlug, anchored]);
  useEffect(() => {
    const onSection = (event: Event) => {
      const detail = (event as CustomEvent<{ slug: string; key: string }>).detail;
      if (detail?.slug && detail.key) read({ type: 'read', slug: detail.slug, key: detail.key });
    };
    window.addEventListener(WIKI_DOC_SECTION_EVENT, onSection);
    return () => window.removeEventListener(WIKI_DOC_SECTION_EVENT, onSection);
  }, []);

  const view = doc.data ?? null;
  const entryTitle = entry.data?.title ?? null;
  const planNumber = useMemo(() => {
    if (!planSlug) return null;
    for (const category of docs.data?.categories ?? []) {
      const found = category.docs.find((row) => row.slug === planSlug);
      if (found) return found.number;
    }
    return null;
  }, [docs.data, planSlug]);
  // The section by its number in the plan in force: the plan read the note is written from.
  const planSection = planIndex !== null
    ? (plan.data?.confirmed?.docs.find((one) => one.slug === planSlug)?.sections[planIndex - 1]?.key ?? null)
    : null;

  return useMemo<WikiChatPage | null>(() => {
    if (docSlug && view) {
      const key = wikiChatPageSection(reading, docSlug, view.sections.map((s) => s.key));
      const current = view.sections.find((s) => s.key === key);
      if (!current) return null;
      return { kind: 'doc', docSlug, sectionKey: current.key, label: wikiChatWhere(view.number, current.number) };
    }
    if (entryId && entryTitle) return { kind: 'entry', entryId, label: entryTitle };
    if (planSlug && planSection && planIndex !== null) {
      return { kind: 'plan', docSlug: planSlug, sectionKey: planSection, label: wikiChatWhere(planNumber ?? planSlug, planIndex) };
    }
    if (planSlug) return { kind: 'plan', docSlug: planSlug, label: planNumber ?? planSlug };
    return null;
  }, [docSlug, view, reading, entryId, entryTitle, planSlug, planNumber, planSection, planIndex]);
}

// ── Asking about a selection (design §2 step 2, board 42 ① ②) ─────────────────────────────────────

/**
 * Whether a range covers at least one character of an element's contents, not only a boundary beside it: it
 * starts before the element ends (END_TO_START compares this range's start with the other's end) and ends after
 * the element starts (START_TO_END: this range's end with the other's start).
 */
function covers(range: Range, element: Element): boolean {
  if (!range.intersectsNode(element)) return false;
  const inner = element.ownerDocument.createRange();
  inner.selectNodeContents(element);
  return range.compareBoundaryPoints(Range.END_TO_START, inner) < 0 && range.compareBoundaryPoints(Range.START_TO_END, inner) > 0;
}

/**
 * What a selection on a document page touches: the sentences (`[data-wk-sid]`) it covers any of, and the sections
 * whose heading it covers. `wikiChatSnap` makes whole sentences of it.
 */
export function wikiChatTouched(range: Range, root: Element): { sentences: string[]; headings: string[] } {
  const sentences = [...root.querySelectorAll<HTMLElement>('[data-wk-sid]')]
    .filter((element) => covers(range, element))
    .map((element) => element.dataset.wkSid!);
  const headings = [...root.querySelectorAll<HTMLElement>('section[data-section] > h2')]
    .filter((element) => covers(range, element))
    .map((element) => (element.parentElement as HTMLElement).dataset.section!);
  return { sentences, headings };
}

/** A document's sentences in reading order, as the snap reads them; only ones the server gave an id. */
export function wikiChatSentences(doc: Pick<WikiDocView, 'sections'>): WikiChatSentence[] {
  return doc.sections.flatMap((section) =>
    section.blocks.flatMap((block) =>
      block.sentences.flatMap((sentence) =>
        sentence.id ? [{ id: sentence.id, section: section.key, text: sentence.text, notes: sentence.notes }] : [],
      ),
    ),
  );
}

/**
 * The document page's Ask (board 42 ① ②): a selection in the text snaps to whole sentences, which light, and a
 * button floats above it; pressing it puts them in the composer as a quote — no dialog — and opens the panel if
 * it is hidden. The selection is read when it settles (the mouse or a key let go), so a drag repaints once.
 */
export function useWikiChatAsk(doc: WikiDocView, articleRef: RefObject<HTMLElement | null>) {
  const chat = useWikiChat();
  const order = useMemo(() => wikiChatSentences(doc), [doc]);
  const [snap, setSnap] = useState<{ quote: WikiChatQuote; at: { top: number; left: number } } | null>(null);

  useEffect(() => {
    if (!chat || order.length === 0) return;
    const read = () => {
      const article = articleRef.current;
      const selection = window.getSelection();
      if (!article || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setSnap(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!article.contains(range.commonAncestorContainer)) {
        setSnap(null);
        return;
      }
      const quote = wikiChatSnap(doc.slug, order, wikiChatTouched(range, article));
      if (!quote) {
        setSnap(null);
        return;
      }
      // Above the first line of what is lit, never on it (board 42 ①, C8 review): the snap can begin a line above
      // the selection itself, so the place is the first snapped sentence's first line, centred over it, in the
      // article's own coordinates, and kept inside the article. A browser without layout has no box.
      const first = article.querySelector(`[data-wk-sid="${quote.sentenceIds[0]!.replace(/["\\]/gu, '\\$&')}"]`);
      const line = firstLine(first) ?? firstLine(range);
      const frame = article.getBoundingClientRect();
      const centre = line ? line.left + line.width / 2 - frame.left : 0;
      const left = frame.width > 2 * ASK_MARGIN ? Math.min(Math.max(centre, ASK_MARGIN), frame.width - ASK_MARGIN) : centre;
      setSnap({ quote, at: { top: (line?.top ?? frame.top) - frame.top, left } });
    };
    const settle = () => window.setTimeout(read, 0);
    const onChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setSnap(null);
    };
    document.addEventListener('mouseup', settle);
    document.addEventListener('keyup', settle);
    document.addEventListener('touchend', settle);
    document.addEventListener('selectionchange', onChange);
    return () => {
      document.removeEventListener('mouseup', settle);
      document.removeEventListener('keyup', settle);
      document.removeEventListener('touchend', settle);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [chat, order, doc.slug, articleRef]);

  const lit = useMemo(() => {
    const ids = new Set(chat?.quoted ?? []);
    for (const id of snap?.quote.sentenceIds ?? []) ids.add(id);
    return ids;
  }, [chat?.quoted, snap]);

  const ask = snap && chat ? (
    <button
      type="button"
      className="wk-chat-ask"
      style={{ top: snap.at.top, left: snap.at.left }}
      // Keep the selection while the button is pressed: a mousedown elsewhere would collapse it first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        chat.ask(snap.quote);
        window.getSelection()?.removeAllRanges();
        setSnap(null);
      }}
    >
      <CommentOutlined className="ic" />
      <span>{WIKI_CHAT_ASK}</span>
      {snap.quote.selected > snap.quote.sentenceIds.length && <small>{wikiChatCapped(snap.quote.selected)}</small>}
    </button>
  ) : null;

  return { lit, ask };
}

/** How far the Ask's middle keeps from the article's sides, so the button never hangs over them. */
const ASK_MARGIN = 48;

/** The first line a range or an element is laid out on: its first box with a size. */
function firstLine(target: Element | Range | null): DOMRect | null {
  if (!target || typeof target.getClientRects !== 'function') return null;
  return [...target.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0) ?? null;
}

/** The sentences lit on a document page: the selection snapped, and the composer's quote. */
export const WikiChatLitCtx = createContext<ReadonlySet<string>>(new Set());
