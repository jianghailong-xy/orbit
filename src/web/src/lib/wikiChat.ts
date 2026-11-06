/**
 * The wiki chat on the web (docs/wiki-chat-design.md §2–§4 and §5.1, contract `chat`, board 42 ⓪ ①): the round
 * button at the window's bottom right, the panel it opens beside the page, the panel's short composer with the
 * page and the selected sentences as attachments, and the first choice of where a space's chats run.
 *
 * ONE PLACE FOR THE WORDS: every sentence the button and the panel say is defined here, the contract's ones
 * taken from the shared `WIKI_CHAT_COPY` (src/shared/src/wikiChat.ts, held to the contract by
 * wikiChatContract.spec.ts), so OrbitKit's `WikiCopy` has one web source to mirror.
 *
 * NOTHING HERE IS STORED BY THE CLIENT that the server already says: the button's look is read from the three
 * counts the chats read serves (`wikiChatFabState`), and the workspace a space's chats run in is remembered by
 * the server when the first chat names it (`space.settings.chat.workspaceId`). What the client keeps is what is
 * the reader's own: which chat the panel shows (`?chat=`), the panel's width, and the composer's attachments.
 */
import {
  WIKI_CHAT_COPY,
  WIKI_CHAT_RULES,
  wikiChatFabState,
  type WikiChatContext,
  type WikiChatFabCounts,
  type WikiChatFabState,
} from '@orbit/shared';
import { api, ApiError } from '../api';
import { compatibleUuid } from './uuid';

export type { WikiChatContext, WikiChatFabCounts, WikiChatFabState } from '@orbit/shared';

// ── The words ───────────────────────────────────────────────────────────────────────────────────

const { fab, panel, notes } = WIKI_CHAT_COPY;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

/** The button's hover at rest (design §3), and the panel's title before the chat has one. */
export const WIKI_CHAT_LABEL = fab.idle;
export const WIKI_CHAT_NEW = panel.newChat;
export const WIKI_CHAT_RUNS_IN = panel.runsIn;
export const WIKI_CHAT_ASK = panel.ask;
export const WIKI_CHAT_EMPTY_HINT = panel.emptyHint;
export const WIKI_CHAT_EMPTY_NOTE = panel.emptyNote;
export const WIKI_CHAT_PLACEHOLDER = panel.placeholder;
export const WIKI_CHAT_NO_WORKTREE = panel.noWorktree;
export const WIKI_CHAT_CHOOSE_WORKSPACE = panel.chooseWorkspace;
/** `HPC is offline. The chat waits for it to come back.` — the machine stays the space's (design §5.1). */
export const wikiChatOffline = (machine: string): string => fill(panel.offline, { machine });

// The panel's own controls, which neither the design nor the contract words: names for a reader of the screen.
export const WIKI_CHAT_HISTORY = 'Chats in this space';
export const WIKI_CHAT_NO_HISTORY = 'No chats in this space yet';
export const WIKI_CHAT_OPEN_SESSION = 'Open as a full session';
export const WIKI_CHAT_CLOSE = 'Hide chat';
export const WIKI_CHAT_SEND = 'Send';
export const WIKI_CHAT_STOP = 'Stop';
export const WIKI_CHAT_RESIZE = 'Resize chat';
export const WIKI_CHAT_WORKSPACE = 'Workspace';
export const WIKI_CHAT_MODEL = 'Model';
export const WIKI_CHAT_MODE = 'Mode';
export const WIKI_CHAT_SEND_FAILED = 'The message couldn’t be sent. Check the connection, then try again.';
/** The phone's Ask sheet (docs/wiki-comment-to-session-design.md §5): over the paragraph's sentences, each picked by a tap. */
export const WIKI_CHAT_PICK_SENTENCES = 'Tap the sentences you mean';
export const wikiChatRemove = (what: string): string => `Remove ${what}`;
/** Said on the quote chip and the Ask button when a selection ran past the cap (design §4.2: at most 20). */
export const wikiChatCapped = (selected: number): string =>
  `The first ${WIKI_CHAT_RULES.selectionSentencesMax} of ${selected} sentences`;

/** The quote chip's counts, in the attachment line's own words: `1 sentence · 2 sources` (board 42 ①). */
export function wikiChatQuoteCounts(sentences: number, sources: number): string {
  const n = (count: number, one: string, many: string) => (count === 1 ? one : fill(many, { n: count }));
  const parts = [n(sentences, notes.sentenceOne, notes.sentenceMany)];
  if (sources > 0) parts.push(n(sources, notes.sourceOne, notes.sourceMany));
  return parts.join(' · ');
}

/** The line under the panel's title once the chat runs: `orbit-develop · HPC · Claude Opus 5.5 · Default`. */
export function wikiChatRunLine(parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((part): part is string => !!part && part.trim().length > 0).join(' · ');
}

// ── The button ──────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a Wiki route wears the button (design §3): every page but the space's Settings. A share link is a page
 * of its own (`SharedWikiPage`) and never draws one; a route with no space resolved has no chats to open.
 */
export function wikiChatFabShown(route: string, hasSpace: boolean): boolean {
  return hasSpace && route !== 'settings';
}

/** The button's look and hover from the chats read (`fab`); none read yet, or a server without chats, is idle. */
export function wikiChatFab(counts: WikiChatFabCounts | null | undefined): { state: WikiChatFabState; label: string; count: number } {
  const read = counts ?? { needsYou: 0, working: false, updated: 0 };
  const { state, label } = wikiChatFabState(read);
  return { state, label, count: state === 'needs_you' ? read.needsYou : 0 };
}

// ── The chats read ──────────────────────────────────────────────────────────────────────────────

/** A workspace the space's chats may run in (contract `chat.list`): `runner` is the machine's name, or null. */
export interface WikiChatWorkspace {
  id: string;
  name: string;
  runner: string | null;
  online: boolean;
}

export interface WikiChatRow {
  sessionId: string;
  title: string;
  status: string;
  open: boolean;
  createdAt: string;
  updatedAt: string;
  drafts: number;
  needsYou: number;
}

/** `GET /api/wiki/spaces/:id/chats`. */
export interface WikiChatList {
  spaceId: string;
  workspace: (WikiChatWorkspace & { eligible: boolean }) | null;
  choices: WikiChatWorkspace[];
  fab: WikiChatFabCounts;
  chats: WikiChatRow[];
}

/** The chats read, or null from a server that has no chats yet (404): the button then stays at rest. */
export async function getWikiChats(spaceId: string): Promise<WikiChatList | null> {
  try {
    return await api<WikiChatList>(`/wiki/spaces/${encodeURIComponent(spaceId)}/chats`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** The address value of a chat not started yet: `?chat=new`. */
export const WIKI_CHAT_NEW_PARAM = 'new';

/**
 * Which chat the button opens (contract `chat.list.chats`): the newest holding something that needs the owner,
 * else the newest still open, else a new one.
 */
export function wikiChatToOpen(chats: readonly WikiChatRow[] | null | undefined): string {
  const rows = chats ?? [];
  return rows.find((chat) => chat.needsYou > 0)?.sessionId ?? rows.find((chat) => chat.open)?.sessionId ?? WIKI_CHAT_NEW_PARAM;
}

/**
 * Where the panel says the chat will run (contract `chat.workspace`, design §5.1):
 * - none: no workspace of the space runs its sessions in worktrees, so there is nothing to choose and no composer;
 * - choose: nothing remembered, or the remembered one no longer qualifies — no default is worked out in code;
 * - chosen: the owner's pick in this panel, else the remembered one, with whether its machine is offline.
 */
export type WikiChatRunsIn =
  | { kind: 'none' }
  | { kind: 'choose'; choices: WikiChatWorkspace[]; again: boolean }
  | { kind: 'chosen'; workspace: WikiChatWorkspace; remembered: boolean; choices: WikiChatWorkspace[] };

export function wikiChatRunsIn(list: Pick<WikiChatList, 'workspace' | 'choices'>, picked: string | null): WikiChatRunsIn {
  const choices = list.choices;
  const pick = picked ? choices.find((choice) => choice.id === picked) : undefined;
  if (pick) return { kind: 'chosen', workspace: pick, remembered: pick.id === list.workspace?.id, choices };
  if (list.workspace?.eligible) {
    const { eligible: _eligible, ...workspace } = list.workspace;
    return { kind: 'chosen', workspace, remembered: true, choices };
  }
  if (choices.length === 0) return { kind: 'none' };
  return { kind: 'choose', choices, again: list.workspace !== null };
}

/** A workspace as the Runs in picker names it: `orbit-develop · HPC`. */
export const wikiChatWorkspaceName = (workspace: Pick<WikiChatWorkspace, 'name' | 'runner'>): string =>
  wikiChatRunLine([workspace.name, workspace.runner]);

// ── The panel's place: the address, the width ───────────────────────────────────────────────────

/** The address key of the panel (design §4.1): `?chat=<session>` keeps it open across pages and reloads. */
export const WIKI_CHAT_PARAM = 'chat';

/** `search` with the panel's chat set to `chat`, or taken out when null; every other key is kept. */
export function wikiChatSearch(search: string, chat: string | null): string {
  const params = new URLSearchParams(search);
  if (chat) params.set(WIKI_CHAT_PARAM, chat);
  else params.delete(WIKI_CHAT_PARAM);
  const next = params.toString();
  return next ? `?${next}` : '';
}

const OPEN_KEY = 'orbit.wikiChat.open';

/**
 * The chat this tab's panel shows for a space, kept so that turning to another page of the wiki — whose links do
 * not carry `?chat=` — keeps the panel open: the address is put back with it (`WikiChatHost`). Hiding the panel
 * forgets it. Per space, because a chat belongs to one (design §4.1).
 */
export function readWikiChatOpen(spaceSlug: string): string | null {
  try {
    const all = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, unknown>;
    const chat = all[spaceSlug];
    return typeof chat === 'string' && chat ? chat : null;
  } catch {
    return null;
  }
}

export function writeWikiChatOpen(spaceSlug: string, chat: string | null): void {
  try {
    const all = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, unknown>;
    if (chat) all[spaceSlug] = chat;
    else delete all[spaceSlug];
    sessionStorage.setItem(OPEN_KEY, JSON.stringify(all));
  } catch {
    // Storage refused (private mode, quota): the address alone keeps the panel, as a reload does.
  }
}

/**
 * The panel by the window's width (design §4.1, contract `chat.panel.widths`):
 * - wide (≥ 1440): docked on the right, pushing the page over; dragged between 320 and 560; the directory stays;
 * - docked (1200–1439): docked on the right; the directory folds into the Contents drawer;
 * - over (640–1199): slides in over the right of the page, with no scrim; Contents drawer;
 * - sheet (< 640): a sheet from the bottom, at half or full height; Contents drawer.
 */
export type WikiChatLayout = 'wide' | 'docked' | 'over' | 'sheet';

export const WIKI_CHAT_WIDTH = {
  wide: 1440,
  docked: 1200,
  over: 640,
  panel: { initial: 400, min: 320, max: 560 },
} as const;

export function wikiChatLayout(windowWidth: number): WikiChatLayout {
  if (windowWidth >= WIKI_CHAT_WIDTH.wide) return 'wide';
  if (windowWidth >= WIKI_CHAT_WIDTH.docked) return 'docked';
  if (windowWidth >= WIKI_CHAT_WIDTH.over) return 'over';
  return 'sheet';
}

/** The panel's width: the dragged one where it can be dragged, else the default; a sheet is as wide as the window. */
export function wikiChatPanelWidth(layout: WikiChatLayout, dragged: number | null): number | null {
  const { initial, min, max } = WIKI_CHAT_WIDTH.panel;
  if (layout === 'sheet') return null;
  if (layout !== 'wide' || dragged === null || !Number.isFinite(dragged)) return initial;
  return Math.min(max, Math.max(min, Math.round(dragged)));
}

/** Whether the open panel pushes the page over (it docks) rather than lying over it. */
export const wikiChatDocks = (layout: WikiChatLayout): boolean => layout === 'wide' || layout === 'docked';

/** Whether the open panel folds the directory column into the Contents drawer: everywhere narrower than wide. */
export const wikiChatFoldsDirectory = (layout: WikiChatLayout): boolean => layout !== 'wide';

const WIDTH_KEY = 'orbit.wikiChat.width';

export function readWikiChatWidth(): number | null {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeWikiChatWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Not kept: the next panel opens at the default.
  }
}

// ── The selection: sentences, snapped ───────────────────────────────────────────────────────────

/** A sentence of the document as the snap reads it, in reading order. */
export interface WikiChatSentence {
  id: string;
  /** Its section's key. */
  section: string;
  text: string;
  /** The document's footnote numbers it carries. */
  notes: readonly number[];
}

/** The sentences a selection names, as the quote chip shows them and the message sends them. */
export interface WikiChatQuote {
  docSlug: string;
  /** The section the first sentence is in (contract `chat.notes.wikiContext`: where the selection starts). */
  sectionKey: string;
  sentenceIds: string[];
  /** The first sentence's words, which the chip begins with. */
  first: string;
  /** Distinct footnotes across the sentences. */
  sources: number;
  /** How many sentences the selection reached before the cap; more than `sentenceIds` when it was capped. */
  selected: number;
}

/**
 * Snap a selection to whole sentences (docs/wiki-comment-to-session-design.md §2, step 1): a sentence the
 * selection touches at all counts whole, and so does every sentence between the first and the last it touches,
 * across paragraphs and sections; a section's heading counts as its every sentence. At most
 * `selectionSentencesMax` are taken — the first ones, in reading order — and `selected` says how many there were.
 *
 * Only sentences have ids (`wiki_doc_sentence`), and a message's selection names nothing else (contract
 * `chat.notes.wikiContext`), so a code block or a diagram adds no sentence: what is lit is what is sent.
 */
export function wikiChatSnap(
  docSlug: string,
  order: readonly WikiChatSentence[],
  touched: { sentences: Iterable<string>; headings: Iterable<string> },
): WikiChatQuote | null {
  const sentences = new Set(touched.sentences);
  const headings = new Set(touched.headings);
  let lo = -1;
  let hi = -1;
  order.forEach((sentence, i) => {
    if (!sentences.has(sentence.id) && !headings.has(sentence.section)) return;
    if (lo < 0) lo = i;
    hi = i;
  });
  if (lo < 0) return null;
  const run = order.slice(lo, hi + 1);
  const taken = run.slice(0, WIKI_CHAT_RULES.selectionSentencesMax);
  const sources = new Set(taken.flatMap((sentence) => sentence.notes));
  return {
    docSlug,
    sectionKey: taken[0]!.section,
    sentenceIds: taken.map((sentence) => sentence.id),
    first: taken[0]!.text,
    sources: sources.size,
    selected: run.length,
  };
}

// ── The attachments, and what a message sends ──────────────────────────────────────────────────

/** The page the reader is on, as the composer's page chip names it (design §4.2). */
export type WikiChatPage =
  | { kind: 'doc'; docSlug: string; sectionKey: string; label: string }
  | { kind: 'entry'; entryId: string; label: string }
  | { kind: 'plan'; docSlug: string; label: string };

/**
 * The composer's attachments (design §4.2): the page, which follows the reader until the message is sent, and
 * the quote an Ask put there. Either can be crossed out; what is not shown is not sent.
 */
export interface WikiChatAttachments {
  /** The page the reader is on now. */
  page: WikiChatPage | null;
  /** The owner crossed the page out of this message. */
  pageCrossed: boolean;
  quote: WikiChatQuote | null;
}

export type WikiChatAttachAction =
  | { type: 'follow'; page: WikiChatPage | null }
  | { type: 'crossPage' }
  | { type: 'quote'; quote: WikiChatQuote }
  | { type: 'crossQuote' }
  | { type: 'sent' };

export const WIKI_CHAT_NO_ATTACHMENTS: WikiChatAttachments = { page: null, pageCrossed: false, quote: null };

/**
 * One change to the attachments: the reader moved (the page follows, a crossed-out page stays out until the
 * message goes), an Ask (its quote replaces any before it: a message carries one selection), a cross, or the
 * message sent — after which the next one starts with the page attached again and no quote.
 */
export function wikiChatAttach(state: WikiChatAttachments, action: WikiChatAttachAction): WikiChatAttachments {
  switch (action.type) {
    case 'follow':
      return samePage(state.page, action.page) ? state : { ...state, page: action.page };
    case 'crossPage':
      return { ...state, pageCrossed: true };
    case 'quote':
      return { ...state, quote: action.quote };
    case 'crossQuote':
      return { ...state, quote: null };
    case 'sent':
      return { page: state.page, pageCrossed: false, quote: null };
  }
}

function samePage(a: WikiChatPage | null, b: WikiChatPage | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What the composer shows, which is exactly what the message sends. */
export function wikiChatShown(state: WikiChatAttachments): { page: WikiChatPage | null; quote: WikiChatQuote | null } {
  return { page: state.pageCrossed ? null : state.page, quote: state.quote };
}

/**
 * The message's `wikiContext` (contract `chat.notes.wikiContext`), frozen from what the composer shows when it is
 * sent: `{ page?, selection? }`, or undefined when it shows neither. The server reads the sentences and their
 * footnotes again at delivery, from the ids; no text of the page is sent.
 */
export function wikiChatContext(state: WikiChatAttachments): WikiChatContext | undefined {
  const { page, quote } = wikiChatShown(state);
  const context: WikiChatContext = {};
  if (page?.kind === 'doc') context.page = { kind: 'doc', docSlug: page.docSlug, sectionKey: page.sectionKey };
  if (page?.kind === 'entry') context.page = { kind: 'entry', entryId: page.entryId };
  if (page?.kind === 'plan') context.page = { kind: 'plan', docSlug: page.docSlug };
  if (quote && quote.sentenceIds.length > 0) {
    context.selection = { docSlug: quote.docSlug, sectionKey: quote.sectionKey, sentenceIds: [...quote.sentenceIds] };
  }
  return context.page || context.selection ? context : undefined;
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────────────

/** What a new chat is made with (contract `chat.create`): the owner's first words, word for word. */
export interface WikiChatCreate {
  workspaceId?: string;
  content: string;
  wikiContext?: WikiChatContext;
  model?: string;
  permissionMode?: string;
}

/** `POST /api/wiki/spaces/:id/chats`: the chat's session and its row, the first turn filed under a UUID of ours. */
export const createWikiChat = (spaceId: string, body: WikiChatCreate, clientTurnId: string = compatibleUuid()) =>
  api<{ sessionId: string; chat: WikiChatRow }>(`/wiki/spaces/${encodeURIComponent(spaceId)}/chats`, {
    method: 'POST',
    body: { ...body, clientTurnId },
  });

/**
 * The chat's next message, through the session's own message door with an explicit routing intent (contract
 * `chat.turns`): its content is the owner's words alone, the attachments ride beside it as `wikiContext`.
 */
export const sendWikiChatTurn = (
  sessionId: string,
  content: string,
  wikiContext: WikiChatContext | undefined,
  clientTurnId: string = compatibleUuid(),
) =>
  api<{ turnId: string; seq: number; kind: string; placement: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/turns/current-work-routing`,
    {
      method: 'POST',
      body: { clientTurnId, content, intent: 'NEXT_TURN', ...(wikiContext ? { wikiContext } : {}) },
    },
  );
