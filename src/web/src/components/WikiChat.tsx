import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CommentOutlined } from '@ant-design/icons';
import { useChatHost } from './ChatHost';
import { WIKI_DOC_SECTION_EVENT } from './WikiDirectory';
import type { ChatOrigin } from './WikiChatPanel';
import { routeId } from '../lib/idCodec';
import { wikiChatDraftsQuery, wikiChatsQuery, wikiDocQuery, wikiDocsQuery, wikiEntryQuery, wikiPlanQuery } from '../lib/queries';
import {
  WIKI_CHAT_ASK,
  WIKI_CHAT_CHOOSE_WORKSPACE,
  WIKI_CHAT_EMPTY_HINT,
  WIKI_CHAT_EMPTY_NOTE,
  WIKI_CHAT_HISTORY,
  WIKI_CHAT_NO_ATTACHMENTS,
  WIKI_CHAT_NO_HISTORY,
  WIKI_CHAT_NO_WORKTREE,
  WIKI_CHAT_PLACEHOLDER,
  WIKI_CHAT_PLACEHOLDER_DRAFT,
  WIKI_CHAT_STORE,
  createWikiChat,
  wikiChatAttach,
  wikiChatCapped,
  wikiChatContext,
  wikiChatFab,
  wikiChatFabShown,
  wikiChatPageSection,
  wikiChatReading,
  wikiChatSnap,
  wikiChatToOpen,
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

/**
 * The chat's place on every page of a space but its Settings (design §3, §4): the round button, the panel it opens, and
 * the composer's attachments, which the pages feed. Where it stands and when it opens is the shared host's
 * (`useChatHost`); what is the Wiki's is here: its chats, kept per space, the page and the selection the composer
 * attaches, and the cards whose sections the page marks.
 */
export function WikiChatHost({ space, route, children }: { space: WikiSpaceRow; route: string; children: ReactNode }) {
  const list = useQuery(wikiChatsQuery(space.id));
  const host = useChatHost({
    scope: space.slug,
    store: WIKI_CHAT_STORE,
    list,
    shown: wikiChatFabShown(route, true),
    fab: wikiChatFab(list.data?.fab),
    toOpen: wikiChatToOpen,
  });
  const { open, go, openChat, closeHelp, chats, shownChat } = host;

  const [attachments, dispatch] = useReducer(wikiChatAttach, WIKI_CHAT_NO_ATTACHMENTS);
  const page = useWikiChatPage(space, route);
  useEffect(() => dispatch({ type: 'follow', page }), [page]);

  // The shown chat's cards: the sections its open ones would rewrite are marked on the page beside it (board 42 ②).
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
        closeHelp();
        if (!open) go(wikiChatToOpen(chats));
      },
      quoted: new Set(attachments.quote?.sentenceIds ?? []),
      wouldRewrite,
      open: openChat,
    }),
    [attachments.quote, open, go, chats, wouldRewrite, closeHelp, openChat],
  );
  const origin = useMemo<ChatOrigin>(
    () => ({
      copy: {
        history: WIKI_CHAT_HISTORY,
        noHistory: WIKI_CHAT_NO_HISTORY,
        emptyHint: WIKI_CHAT_EMPTY_HINT,
        emptyNote: WIKI_CHAT_EMPTY_NOTE,
        placeholder: WIKI_CHAT_PLACEHOLDER,
        placeholderDraft: WIKI_CHAT_PLACEHOLDER_DRAFT,
        noWorkspace: WIKI_CHAT_NO_WORKTREE,
        chooseWorkspace: WIKI_CHAT_CHOOSE_WORKSPACE,
      },
      listKey: wikiChatsQuery(space.id).queryKey,
      create: (body, sent) => createWikiChat(space.id, { ...body, wikiContext: wikiChatContext(sent) }),
      turnContext: (sent) => {
        const wikiContext = wikiChatContext(sent);
        return wikiContext ? { wikiContext } : undefined;
      },
      space,
    }),
    [space],
  );

  return (
    <WikiChatCtx.Provider value={api}>
      {host.render(children, { origin, attachments, dispatch, cards: cards.data ?? null })}
    </WikiChatCtx.Provider>
  );
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
