import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type RefObject,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { WikiChatFab } from './WikiChatFab';
import { WikiChatPanel, type ChatOrigin } from './WikiChatPanel';
import { useHelpDrawer } from '../lib/helpDrawer';
import { routeId } from '../lib/idCodec';
import { setSidebarFolded } from '../lib/sidebarFold';
import {
  WIKI_CHAT_FOCUS_NEEDS_YOU,
  WIKI_CHAT_NEW_PARAM,
  WIKI_CHAT_PARAM,
  readChatHostShown,
  readWikiChatClosed,
  readWikiChatOpen,
  readWikiChatWidth,
  wikiChatDocks,
  wikiChatFoldsDirectory,
  wikiChatFoldsSidebar,
  wikiChatLayout,
  wikiChatPanelWidth,
  wikiChatSearch,
  writeChatHostShown,
  writeWikiChatClosed,
  writeWikiChatOpen,
  writeWikiChatWidth,
  type ChatHostList,
  type ChatPanelRange,
  type ChatHostStore,
  type WikiChatAttachAction,
  type WikiChatAttachments,
  type WikiChatDraftView,
  type WikiChatFabState,
} from '../lib/wikiChat';

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

export interface ChatHostOptions {
  /**
   * What the host remembers is kept under: the Wiki's space slug, Drive's account id. Null while it is not known yet: the
   * panel is then not opened by default, as if hidden.
   */
  scope: string | null;
  store: ChatHostStore;
  /** The chats read: data undefined while read, null from a server that has none. */
  list: { data: ChatHostList | null | undefined; isPending: boolean };
  /** The page wears the chat at all (the Wiki: every page but Settings). */
  shown: boolean;
  /** The round button's look, from the chats read. Absent on a page that draws its own button (`opens: 'on-press'`). */
  fab?: { state: WikiChatFabState; label: string; count: number };
  /**
   * How the panel opens. `by-default` (the Wiki, Drive): the round button, and shown by default where it docks unless
   * hidden with ✕. `on-press` (Scheduled, design D3 A): no round button; the page's own button opens and closes it
   * (`toggle`), it never opens by itself, and whether it was left open is kept on the device (`store.shown`).
   */
  opens?: 'by-default' | 'on-press';
  /** Where a wide panel's drag is held; absent, 320 to half the window. */
  range?: ChatPanelRange | null;
  /** The chat the button opens, and the panel by default. */
  toOpen: (chats: ChatHostList['chats'] | undefined) => string;
  /** A width the panel keeps until it is dragged; null for a third of the window. */
  fixedWidth?: number | null;
  /** A class of the host's frame, so a page can lay its own content out beside the panel. */
  frameClass?: string;
}

/**
 * The chat's place on a page (design §3, §4; board drive-chat 01 ② ⑤): the round button, the panel it opens, and where
 * that stands. The Wiki and Drive host it alike; what differs is the origin the panel is given and these options.
 *
 * THE ADDRESS SAYS WHICH CHAT IS OPEN (`?chat=<session>`, or `?chat=new`): a reload brings the panel back. A page turned
 * by one of the page's own links drops the query, so the tab keeps the chat it shows per scope and puts the address back
 * (`readWikiChatOpen`): turning pages does not close the panel; hiding it does.
 *
 * OPEN BY DEFAULT WHERE IT DOCKS (board 45 ①②, owner 11-11, contract `chat.panel.openByDefault`; Drive owner Q1 A): with
 * no chat named by the address or the tab, a page whose layout docks the panel shows it on the chat the round button
 * would open, unless the owner hid it with ✕ (`readWikiChatClosed`, kept on the device until the button opens it again).
 * That opening is derived, never written: narrowed past docking it folds away, widened it comes back. Until the chats
 * are read the page is laid out at the panel's width already, so it does not jump when the panel comes.
 *
 * WHERE IT STANDS (§4.1, `wikiChatLayout`): wide windows dock it as a column beside the page, leaving the page's head
 * buttons where they are; under 1440 the app sidebar shows as its icon rail; under 1200 it lies over the page's right
 * with no scrim and is not opened by default; under 640 it is a sheet.
 */
export function useChatHost(options: ChatHostOptions) {
  const { scope, store, list, shown, toOpen, fixedWidth = null, frameClass, range = null } = options;
  const fab = options.fab ?? { state: 'idle' as WikiChatFabState, label: '', count: 0 };
  const onPress = options.opens === 'on-press';
  const location = useLocation();
  const navigate = useNavigate();
  const fabShown = !onPress && shown && list.data !== null;

  const asked = new URLSearchParams(location.search).get(WIKI_CHAT_PARAM);
  const kept = scope ? readWikiChatOpen(scope, store.open) : null;
  const windowWidth = useWindowWidth();
  const layout = wikiChatLayout(windowWidth);
  // Read from storage on every render, as `kept` is: ✕ and the button write it beside a navigation, and a state of its
  // own would render once more with the old address first, which the effect below would then put back.
  const closed = scope ? readWikiChatClosed(scope, store.closed) : true;
  const setClosed = useCallback((next: boolean) => scope && writeWikiChatClosed(scope, next, store.closed), [scope, store.closed]);
  // The help drawer docks in the panel's slot (board help-center 01 ①): one at a time. While help is open the panel is
  // not shown by default, opening help closes a panel that is open, and opening the panel closes help.
  const help = useHelpDrawer();
  const { closeHelp } = help;
  // Shown by default: only where it docks, on a page that has the panel, and not once hidden with ✕. A panel that opens
  // on a press is shown only when it was left open on this device, at any width.
  const leftOpen = onPress && scope !== null && !!store.shown && readChatHostShown(scope, store.shown);
  const byDefault = asked === null && kept === null && shown && !help.open
    && (onPress ? leftOpen : wikiChatDocks(layout) && !closed);
  const chats = list.data?.chats;
  const defaultChat = byDefault && list.data ? toOpen(chats) : null;
  const chat = asked ?? kept ?? defaultChat;
  const open = chat !== null;
  // The chats are still being read: lay the page out at the panel's width already.
  const reserving = byDefault && list.isPending;

  const go = useCallback(
    (next: string | null, edit?: (search: string) => string) => {
      if (scope) writeWikiChatOpen(scope, next, store.open);
      navigate(
        { pathname: location.pathname, search: wikiChatSearch(edit ? edit(location.search) : location.search, next), hash: location.hash },
        { replace: true, state: location.state },
      );
    },
    [navigate, location.pathname, location.search, location.hash, location.state, scope, store.open],
  );
  // The address and the tab keep the same chat: an address that names one is remembered, and a page that lost
  // it to a link gets it back.
  useLayoutEffect(() => {
    if (!scope) return;
    if (asked) {
      if (asked !== kept) writeWikiChatOpen(scope, asked, store.open);
    } else if (kept) {
      navigate(
        { pathname: location.pathname, search: wikiChatSearch(location.search, kept), hash: location.hash },
        { replace: true, state: location.state },
      );
    }
  }, [asked, kept, scope, store.open, navigate, location.pathname, location.search, location.hash, location.state]);

  // Help opened (by its button, ? or a link) while a chat is open: the chat gives up the slot.
  const helpWasOpen = useRef(help.open);
  useLayoutEffect(() => {
    const opened = help.open && !helpWasOpen.current;
    helpWasOpen.current = help.open;
    if (opened && (asked || kept)) go(null);
  }, [help.open, asked, kept, go]);

  // A panel that opens on a press names its chat in the address once it is shown, so a reload keeps that chat.
  useLayoutEffect(() => {
    if (onPress && defaultChat !== null && asked === null) go(defaultChat);
  }, [onPress, defaultChat, asked, go]);

  const [dragged, setDragged] = useState<number | null>(() => readWikiChatWidth(store.width));
  const width = wikiChatPanelWidth(layout, dragged, windowWidth, fixedWidth, range);

  // The panel's top: under the Wiki's head while the head is on screen, then the top of the page's scroll. A desktop
  // draws the head in the directory's column; folding the column away brings the head row back, so it measures again.
  const hostRef = useRef<HTMLDivElement>(null);
  const folds = (open || reserving) && wikiChatFoldsDirectory(layout);
  const top = usePanelTop(hostRef, open, location.pathname, folds);

  // The card the panel brings into view when it opens a chat (the button: the first that needs the owner; Activity: one
  // card), kept with that chat: closing or turning to another needs no write of its own, which would render once more
  // with the address before the navigation and put the old chat back.
  const [focused, setFocused] = useState<{ chat: string; card: string } | null>(null);
  const focus = focused && focused.chat === chat
    ? focused.card
    : defaultChat !== null && chat === defaultChat && fab.state === 'needs_you'
      ? WIKI_CHAT_FOCUS_NEEDS_YOU
      : null;
  const shownChat = chat && chat !== WIKI_CHAT_NEW_PARAM ? (routeId(chat) ?? chat) : null;

  const docks = (open || reserving) && wikiChatDocks(layout);
  // A column narrower than 1440 takes the app sidebar's width rather than the directory's (board wiki-rail 03 C2).
  const foldsSidebar = (open || reserving) && wikiChatFoldsSidebar(layout);
  useEffect(() => {
    setSidebarFolded(foldsSidebar);
    return () => setSidebarFolded(false);
  }, [foldsSidebar]);

  /** Open a chat, at one of its cards when named: closes help, as every opening of the panel does. */
  const openChat = useCallback(
    (next: string, card: string | null = null) => {
      setFocused(card ? { chat: next, card } : null);
      closeHelp();
      go(next);
    },
    [closeHelp, go],
  );

  /** Whether the panel is left open on this device (a panel that opens on a press). */
  const setShown = useCallback(
    (next: boolean) => scope && store.shown && writeChatHostShown(scope, next, store.shown),
    [scope, store.shown],
  );
  /** Close the panel: ✕, or a second press of the page's button. The chat goes on. */
  const close = useCallback((edit?: (search: string) => string) => {
    // ✕ is the owner saying no: kept on the device until the button opens the panel again (board 45, Q1 A).
    if (onPress) setShown(false);
    else setClosed(true);
    go(null, edit);
  }, [onPress, setShown, setClosed, go]);
  /** The page's own button (`opens: 'on-press'`): closes an open panel, else opens the chat `toOpen` names. */
  const toggle = useCallback(() => {
    if (open) {
      close();
      return;
    }
    setShown(true);
    openChat(toOpen(chats));
  }, [open, close, setShown, openChat, toOpen, chats]);

  const render = (
    children: ReactNode,
    panel: {
      origin: ChatOrigin;
      attachments: WikiChatAttachments;
      dispatch: Dispatch<WikiChatAttachAction>;
      cards?: readonly WikiChatDraftView[] | null;
    },
  ) => {
    const className = [
      'wk-chat-host',
      fabShown ? 'has-fab' : '',
      open ? `is-open is-${layout}` : '',
      docks ? 'is-docked' : '',
      folds ? 'is-fold' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const style = (open || reserving) && width ? ({ '--wk-chat-w': `${width}px` } as CSSProperties) : undefined;
    return (
      <>
        {/* Where it docks the panel is a column of the page beside it, not a layer over it (board wiki-rail 03 Ⓑ). */}
        <div className={['wk-chat-frame', docks ? 'is-columned' : '', frameClass ?? ''].filter(Boolean).join(' ')}>
          <div ref={hostRef} className={className} style={style}>
            {children}
          </div>
          {docks && !open && <div className="wk-chat-slot" style={{ width: width ?? undefined }} aria-hidden="true" />}
          {open && (
            <WikiChatPanel
              origin={panel.origin}
              chat={chat}
              list={list.data}
              layout={layout}
              width={width}
              range={range}
              top={top}
              attachments={panel.attachments}
              dispatch={panel.dispatch}
              cards={shownChat ? (panel.cards ?? null) : null}
              focus={focus}
              onChat={go}
              onClose={() => close()}
              onResize={(next, done) => {
                setDragged(next);
                if (done) writeWikiChatWidth(wikiChatPanelWidth('wide', next, windowWidth, null, range) ?? next, store.width);
              }}
            />
          )}
        </div>
        {fabShown && !open && (
          <WikiChatFab
            state={fab.state}
            label={fab.label}
            count={fab.count}
            onOpen={() => {
              // The button undoes ✕: pages open with the panel shown again (board 45, Q1 A). Straight to the card that
              // needs the owner, when one does (design §3).
              const next = toOpen(chats);
              setClosed(false);
              openChat(next, fab.state === 'needs_you' ? WIKI_CHAT_FOCUS_NEEDS_YOU : null);
            }}
          />
        )}
      </>
    );
  };

  return { chat, open, shownChat, chats, go, openChat, closeHelp, toggle, close, render };
}

/** Where the panel's top is: below the Wiki's head while it shows, else the top of the page's own scroll. */
function usePanelTop(hostRef: RefObject<HTMLDivElement | null>, open: boolean, pathname: string, folds: boolean): number {
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
  }, [hostRef, open, pathname, folds]);
  return top;
}
