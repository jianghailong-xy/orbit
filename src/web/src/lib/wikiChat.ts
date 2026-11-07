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
  wikiChatAppliedInReview,
  wikiChatCardActions,
  wikiChatCardTitle,
  wikiChatFabState,
  wikiChatPlanFace,
  wikiChatPlanMovedNote,
  wikiChatResultLine,
  wikiChatRewriteLinks,
  wikiChatRewriteWaits,
  wikiDocChanged,
  wikiDocVersionHeading,
  type WikiChatAction,
  type WikiChatCard,
  type WikiChatContext,
  type WikiChatDraftOpView,
  type WikiChatDraftView,
  type WikiChatFabCounts,
  type WikiChatFabState,
  type WikiChatPress,
  type WikiChatRewriteLink,
  type WikiDocSectionVersionView,
} from '@orbit/shared';
import { api, ApiError } from '../api';
import { routeId } from './idCodec';
import { compatibleUuid } from './uuid';

export type {
  WikiChatAction,
  WikiChatContext,
  WikiChatDraftOpView,
  WikiChatDraftSectionView,
  WikiChatDraftView,
  WikiChatFabCounts,
  WikiChatFabState,
  WikiChatPress,
} from '@orbit/shared';

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
/** The composer's words while a card of the chat waits for its press (board 42 ②). */
export const WIKI_CHAT_PLACEHOLDER_DRAFT = panel.placeholderDraft;
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

/** The composer's line once its chat takes no more messages (C8 review): why, and the way on. */
export const WIKI_CHAT_ENDED = 'This chat has ended, so it takes no more messages. Start a new chat to keep going.';
export const WIKI_CHAT_TRASHED = 'This chat is in Trash, so it takes no more messages. Start a new chat to keep going.';

/**
 * Why a message did not go, said truthfully (C8 review): the server's refusal in its own words — a workspace that has
 * turned its worktrees off (409), attachments it would not take (400 at wikiContext), anything else it refused — and a
 * failure of the server itself as one; only a request that never reached the server asks to check the connection.
 */
export function wikiChatSendError(error: unknown): string {
  if (!(error instanceof ApiError)) return WIKI_CHAT_SEND_FAILED;
  if (error.status >= 500) return `The server couldn’t take the message (${error.status}). Try again in a moment.`;
  const said = error.message.trim().replace(/[.:;]+$/u, '');
  const errors = Array.isArray(error.body?.errors) ? (error.body!.errors as Array<{ path?: unknown }>) : [];
  if (errors.some((one) => typeof one?.path === 'string' && one.path.startsWith('wikiContext'))) {
    return `The attachments weren’t taken: ${said}. Remove them and send again.`;
  }
  return said ? `Not sent: ${said}.` : `Not sent (${error.status}).`;
}
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

/** The card the panel brings into view when the round button opens it: the first that needs the owner (design §3). */
export const WIKI_CHAT_FOCUS_NEEDS_YOU = '\u0000needs-you';

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
  | { kind: 'plan'; docSlug: string; sectionKey?: string; label: string };

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
  if (page?.kind === 'plan') context.page = { kind: 'plan', docSlug: page.docSlug, ...(page.sectionKey ? { sectionKey: page.sectionKey } : {}) };
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

// ── The cards (design §7–§8, contract `chat.drafts`, board 42 ② ③ ④) ───────────────────────────

/** `GET /api/wiki/chat-drafts/:id`: one card, its state derived by the server (contract `chat.drafts.read`). */
export const getWikiChatDraft = (id: string): Promise<WikiChatDraftView> =>
  api<WikiChatDraftView>(`/wiki/chat-drafts/${encodeURIComponent(id)}`);

/** `GET /api/wiki/chats/:id/drafts`: every card of one chat, oldest first. */
export async function getWikiChatDrafts(chatId: string): Promise<WikiChatDraftView[]> {
  const read = await api<{ sessionId: string; drafts: WikiChatDraftView[] }>(`/wiki/chats/${encodeURIComponent(chatId)}/drafts`);
  return read.drafts;
}

/** What a press answers (contract `chat.presses`): the card as it stands after it, and whether it was the first. */
export interface WikiChatPressAnswer {
  replayed: boolean;
  draft: WikiChatDraftView;
}

/** One press of the owner's (contract `chat.presses`), on the owner's door: Apply, Edit, Discard, Undo, Try again, Seen. */
export function pressWikiChatDraft(id: string, press: WikiChatPress, body?: Record<string, unknown>): Promise<WikiChatPressAnswer> {
  return api<WikiChatPressAnswer>(`/wiki/chat-drafts/${encodeURIComponent(id)}/${press}`, { method: 'POST', body: body ?? {} });
}

/** The press each of a card's buttons makes; the others open something instead (an entry, a section, Settings, Plan). */
export const WIKI_CHAT_ACTION_PRESS: Partial<Record<WikiChatAction, WikiChatPress>> = {
  apply: 'apply',
  rewrite: 'apply',
  apply_rebuild: 'apply',
  discard: 'discard',
  undo: 'undo',
  try_again: 'retry',
};

/** The buttons the line under an applied card carries (board 42 ④'s lower row); the card carries the rest. */
const REWRITE_ACTIONS: readonly WikiChatAction[] = ['settings', 'try_again', 'see_changes'];

/** The tools a chat drafts with (contract `agentSurface.chat`): each answers with the card it made. */
const DRAFTING_TOOLS = ['wiki_propose', 'wiki_draft', 'wiki_note'] as const;

/**
 * Whether a tool call is one of a chat's drafting calls, by the name any engine reports an Orbit MCP tool under
 * (`mcp__orbit__wiki_draft`), or the CLI door the same tools have (`orbit wiki draft …` in a shell).
 */
export function wikiChatDraftingCall(name: string, input?: unknown): boolean {
  const mcp = /^mcp__[^_].*?__(wiki_\w+)$/u.exec(name);
  if (mcp) return (DRAFTING_TOOLS as readonly string[]).includes(mcp[1]!);
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined;
  return typeof command === 'string' && /(^|[\s;&|(])orbit\s+wiki\s+(propose|draft|note)\b/u.test(command);
}

/** The id of the card a drafting call's answer names, read from the answer's own fields wherever an engine put them. */
function draftIdIn(value: unknown, depth: number): string | null {
  if (value === null || value === undefined || depth > 5) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('{')) return null;
    try {
      return draftIdIn(JSON.parse(text), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = draftIdIn(item, depth + 1);
      if (id) return id;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.status === 'draft' && typeof record.draftId === 'string' && record.draftId) return record.draftId;
  for (const key of ['structuredContent', 'challenged', 'result', 'output', 'content', 'text']) {
    const id = draftIdIn(record[key], depth + 1);
    if (id) return id;
  }
  return null;
}

/**
 * The card a drafting call made (contract `chat.drafts.toolResult`): its answer's `draftId` — the structured answer an
 * engine passes through, or the JSON text Claude Code records it as — else the id the runner's own sentence names
 * ("Drafted card <id>", the one Orbit itself writes for an engine that hands the agent text alone). A dry run, a
 * refused request and any other answer name none, and the call is drawn as any tool call.
 */
export function wikiChatDraftIdOf(result: unknown): string | null {
  const structured = draftIdIn(result, 0);
  // Either spelling of the id names the card; the client keys it by its public one, as every id it holds.
  if (structured) return routeId(structured);
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  const said = /\b(?:Drafted card|already made card|the flag is card)\s+([0-9A-Za-z]{10,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/u.exec(text);
  return said ? routeId(said[1]!) : null;
}

/** A card as the shared derivations read it (`wikiChatCardActions`, `wikiChatRewriteWaits`). */
export function wikiChatCardOf(view: Pick<WikiChatDraftView, 'kind' | 'state' | 'undoable' | 'rewrite'>): WikiChatCard {
  const rewrite = view.rewrite;
  return {
    kind: view.kind,
    state: view.state,
    undoable: view.undoable,
    rewrite: rewrite
      ? {
          result: rewrite.result,
          reason: rewrite.reason,
          sha: rewrite.sha,
          seen: rewrite.seen,
          sections: rewrite.sections.map((s) => ({ where: s.where, result: s.result, ...(s.changed !== null ? { changed: s.changed } : {}) })),
        }
      : null,
  };
}

export type WikiChatTone = 'brand' | 'ok' | 'grey' | 'amber' | 'error';

/** How a card looks (design §7.3, board 42 ② ③ ④): its status line, its tone, its note and its buttons. */
export interface WikiChatCardLook {
  /** `Draft · Add decision`, `Applied · Confirmed by you`, `Applied · In Review` … */
  title: string;
  tone: WikiChatTone;
  /** A settled card is drawn flat (board 42 ③ ④'s quiet cards). */
  quiet: boolean;
  /**
   * The line under the title a state carries: `A newer draft took over.`, the In Review note, or — an applied plan card
   * the plan moved on from — why it can no longer be undone (`wikiChatPlanMovedNote`, C17).
   */
  note: string | null;
  /** Applied with a challenge still waiting in Review (`wikiChatAppliedInReview`): its note opens that item. */
  inReview: boolean;
  /** The card's own buttons, in the contract's order. */
  actions: WikiChatAction[];
  /** The buttons of the line under an applied card: Settings, Try again, See changes. */
  rewriteActions: WikiChatAction[];
}

const STATE_TONE: Record<WikiChatDraftView['state'], WikiChatTone> = {
  draft: 'brand',
  replaced: 'grey',
  changed: 'amber',
  applied: 'ok',
  discarded: 'grey',
  not_applied: 'grey',
  undone: 'grey',
};

export function wikiChatCardLook(view: Pick<WikiChatDraftView, 'kind' | 'state' | 'undoable' | 'rewrite' | 'label' | 'ops'>): WikiChatCardLook {
  const inReview = wikiChatAppliedInReview(view.state, view.ops);
  const all = wikiChatCardActions(wikiChatCardOf(view));
  return {
    title: wikiChatCardTitle(view.state, view.label, inReview),
    tone: inReview ? 'amber' : STATE_TONE[view.state],
    quiet: view.state !== 'draft' && view.state !== 'changed',
    note: inReview
      ? WIKI_CHAT_COPY.card.appliedInReviewNote
      : view.state === 'replaced'
        ? WIKI_CHAT_COPY.card.replacedNote
        : wikiChatPlanMovedNote(view),
    inReview,
    actions: all.filter((action) => !REWRITE_ACTIONS.includes(action)),
    rewriteActions: all.filter((action) => REWRITE_ACTIONS.includes(action)),
  };
}

/** The challenge of an applied card that waits in Review: the op its In Review note opens. */
export function wikiChatInReviewOp(view: Pick<WikiChatDraftView, 'state' | 'ops'>): WikiChatDraftOpView | null {
  if (!wikiChatAppliedInReview(view.state, view.ops)) return null;
  return view.ops.find((op) => op.op === 'challenge' && op.decision === 'pending') ?? null;
}

/** The line under an applied card (design §8.3), its tone, and whether it counts in the Wiki's waiting count. */
export interface WikiChatResultLook {
  line: string;
  tone: 'run' | 'ok' | 'amber' | 'error' | 'grey';
  /** It waits on the owner (`wikiChatRewriteWaits`): held up, or read the same or failed and not seen. */
  waits: boolean;
}

const RESULT_TONE: Record<NonNullable<WikiChatDraftView['rewrite']>['result'], WikiChatResultLook['tone']> = {
  rewriting: 'run',
  waiting: 'amber',
  updated: 'ok',
  same: 'amber',
  failed: 'error',
  gone: 'grey',
};

export function wikiChatResultLook(view: Pick<WikiChatDraftView, 'kind' | 'state' | 'undoable' | 'rewrite'>): WikiChatResultLook | null {
  if (view.state !== 'applied' || !view.rewrite) return null;
  const card = wikiChatCardOf(view);
  return {
    line: wikiChatResultLine(card.rewrite!),
    tone: RESULT_TONE[view.rewrite.result],
    waits: wikiChatRewriteWaits(card),
  };
}

/** The press a settled rewrite the owner has opened makes, once (contract `chat.presses.seen`). */
export function wikiChatNeedsSeen(view: Pick<WikiChatDraftView, 'state' | 'rewrite'>): boolean {
  const rewrite = view.rewrite;
  if (view.state !== 'applied' || !rewrite || rewrite.seen) return false;
  return rewrite.result === 'updated' || rewrite.result === 'same' || rewrite.result === 'failed';
}

/** A card's sentences on its face (board 42 ②): what its op says, and the agent's why. */
export interface WikiChatCardFace {
  /** The entry's title, or the sections a rewrite card names. */
  heading: string | null;
  rows: Array<{ label: string; value: string }>;
  /** An amend's lines, red and green (board 42 ④ ①). */
  diff: Array<{ sign: '-' | '+'; text: string }>;
  sources: string[];
}

/** The field a kind's card shows first (board 42 ②: a decision's Decision). */
const FACE_FIELD: Record<string, string> = {
  principle: 'statement',
  convention: 'rule',
  decision: 'decision',
  pitfall: 'symptom',
  recipe: 'steps',
  concept: 'definition',
};

const textOf = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    return items.length > 0 ? items.join(' · ') : null;
  }
  return null;
};

const labelOfField = (key: string): string => key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/gu, ' $1').toLowerCase();

/** A source as the card's Sources row names it: the chat's own words first-hand, else its kind and where it points. */
function sourceLine(source: Record<string, unknown>, chatId: string): string {
  const kind = typeof source.kind === 'string' ? source.kind : 'source';
  if (kind === 'turn' && (source.session === 'self' || source.session === chatId || source.session === undefined)) return WIKI_CHAT_COPY.card.yourMessage;
  const locator = (source.locator ?? {}) as Record<string, unknown>;
  const path = typeof locator.path === 'string' ? locator.path : null;
  const lines = typeof locator.lines === 'string' ? ` L${locator.lines}` : typeof locator.line === 'number' ? ` L${locator.line}` : '';
  const ref = typeof source.ref === 'string' ? source.ref : null;
  const shortRef = ref && /^[0-9a-f]{40}$/u.test(ref) ? ref.slice(0, 7) : ref;
  if (path) return `${path}${lines}${shortRef ? ` · ${shortRef}` : ''}`;
  return shortRef ? `${kind} ${shortRef}` : kind;
}

export function wikiChatCardFace(
  view: Pick<WikiChatDraftView, 'kind' | 'ops' | 'rationale' | 'rewrites' | 'sessionId'> & { change?: WikiChatDraftView['change'] },
): WikiChatCardFace {
  const rows: WikiChatCardFace['rows'] = [];
  const diff: WikiChatCardFace['diff'] = [];
  const sources = new Set<string>();
  let heading: string | null = null;
  if (view.kind === 'plan' && view.change) {
    // A plan card says what its change does to the document (`wikiChatPlanFace`, board 42 ④ ③), then the agent's why.
    const plan = wikiChatPlanFace(view.change);
    if (view.rationale.trim()) plan.rows.push({ label: 'Why', value: view.rationale.trim() });
    return { heading: plan.heading, rows: plan.rows, diff, sources: [] };
  }
  const titleOf = (op: WikiChatDraftOpView): string | null => {
    const draft = (op.payload.entry ?? {}) as Record<string, unknown>;
    const changes = (op.payload.changes ?? {}) as Record<string, unknown>;
    return textOf(draft.title) ?? textOf(changes.title) ?? textOf(op.entry?.title) ?? null;
  };
  if (view.kind === 'rewrite') {
    heading = view.rewrites.map((section) => (section.title ? `${section.where} ${section.title}` : section.where)).join(' · ') || null;
  } else if (view.ops.length === 1) {
    const op = view.ops[0]!;
    heading = titleOf(op);
    const draft = (op.payload.entry ?? {}) as Record<string, unknown>;
    const fields = (draft.fields ?? {}) as Record<string, unknown>;
    const kind = typeof draft.kind === 'string' ? draft.kind : null;
    const face = kind ? FACE_FIELD[kind] : undefined;
    const first = face ? textOf(fields[face]) : null;
    if (op.op === 'add' || op.op === 'supersede') {
      if (face && first) rows.push({ label: labelOfField(face), value: first });
      else if (textOf(draft.summary)) rows.push({ label: 'Summary', value: textOf(draft.summary)! });
    }
    if (op.op === 'amend') {
      const changes = (op.payload.changes ?? {}) as Record<string, unknown>;
      const before = (op.entry ?? {}) as Record<string, unknown>;
      for (const key of ['title', 'summary'] as const) {
        const after = textOf(changes[key]);
        if (!after) continue;
        const was = textOf(before[key]);
        if (was && was !== after) diff.push({ sign: '-', text: was });
        diff.push({ sign: '+', text: after });
      }
    }
  } else {
    for (const op of view.ops) rows.push({ label: labelOfField(op.op), value: titleOf(op) ?? '—' });
  }
  if (view.rationale.trim()) rows.push({ label: 'Why', value: view.rationale.trim() });
  for (const op of view.ops) {
    const raw = Array.isArray(op.payload.sources) ? (op.payload.sources as Array<Record<string, unknown>>) : [];
    for (const source of raw) if (source && typeof source === 'object') sources.add(sourceLine(source, view.sessionId));
  }
  return { heading, rows, diff, sources: [...sources] };
}

/**
 * The links of a card's Rewrites row (board 42 ② ③): a section each — or, for a plan card whose rebuild spans more than
 * one document, a document each, opening its first section (board 42 ③: `3.1 · 3.5`; `wikiChatRewriteLinks`, C17).
 */
export function wikiChatRewritesRow(view: Pick<WikiChatDraftView, 'kind' | 'rewrites'>): Array<WikiChatRewriteLink & { title: string | null }> {
  return wikiChatRewriteLinks(view.kind, view.rewrites).map((link) => {
    // A section's link says its title on hover; a document's names no one section.
    const section = view.rewrites.find((one) => one.doc === link.doc && one.key === link.key && one.where === link.label);
    return { ...link, title: section?.title ?? null };
  });
}

/** The labels of the card's rows (board 42 ②): Sources, Rewrites, Similar. */
export const WIKI_CHAT_SOURCES = WIKI_CHAT_COPY.card.sources;
export const WIKI_CHAT_REWRITES = WIKI_CHAT_COPY.card.rewrites;
export const WIKI_CHAT_SIMILAR = 'Similar';
/** The tag on any card drafted after the chat read the web (design §7.3): a tag, not a state. */
export const WIKI_CHAT_WEB = WIKI_CHAT_COPY.card.web;
export const WIKI_CHAT_WEB_NOTE = WIKI_CHAT_COPY.card.webNote;
/** The left's mark on a section an open card would rewrite (board 42 ②). */
export const WIKI_CHAT_WOULD_REWRITE = WIKI_CHAT_COPY.card.wouldRewrite;
/** The mark beside a section written since the reader last looked (board 42 ③). */
export const WIKI_CHAT_SECTION_UPDATED = WIKI_CHAT_COPY.card.sectionUpdated;
/** What Redo sends as the owner's next message (contract `chat.drafts.states.changed`). */
export const WIKI_CHAT_REDO_MESSAGE = WIKI_CHAT_COPY.card.redoMessage;
export const wikiChatActionLabel = (action: WikiChatAction): string => WIKI_CHAT_COPY.actions[action];
/** Said when a press is refused, with the server's reason after it. */
export const WIKI_CHAT_PRESS_FAILED = 'The card couldn’t be pressed';

/**
 * What a refused press lists under its reason (contract `chat.presses.apply`, C12): each error the plan's gate found in a
 * plan card's change — or a schema refusal's fields — as the server wrote it, where it is first; nothing for any other
 * answer. A gate the press fails writes nothing, and the card says why, every error of it.
 */
export function wikiChatPressDetails(error: unknown): string[] {
  if (!(error instanceof ApiError) || (error.code !== 'WIKI_PLAN_GATE' && error.code !== 'WIKI_SCHEMA')) return [];
  const errors = error.body?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((one) => {
    const item = (one ?? {}) as { path?: unknown; message?: unknown };
    const message = typeof item.message === 'string' ? item.message.trim() : '';
    if (!message) return [];
    return [typeof item.path === 'string' && item.path ? `${item.path}: ${message}` : message];
  });
}

/** A press refused or lost, said truthfully: the server's reason, a failure of the server, or no connection. */
export function wikiChatPressError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status >= 500) return `The server couldn’t take the press (${error.status}). Try again in a moment.`;
    return `${WIKI_CHAT_PRESS_FAILED}: ${error.message.trim()}`;
  }
  return 'The press didn’t reach the server. Check the connection, then try again.';
}
/** The card's read failing: the call stands, its card cannot be read now. */
export const WIKI_CHAT_CARD_UNREAD = 'This card couldn’t be read. It is still there: open the chat again to retry.';
/** Edit's dialog (design §7.2: as Review's Edit, the owner's own version of the ops). */
export const WIKI_CHAT_EDIT_TITLE = 'Edit, then apply';
export const WIKI_CHAT_EDIT_NOTE = 'What you change here is applied as your own version of the draft.';
/** Its fields, as the drawer's and Review's Edit name theirs, and its way out. */
export const WIKI_CHAT_EDIT_TITLE_FIELD = 'Title';
export const WIKI_CHAT_EDIT_LINE = 'One line';
export const WIKI_CHAT_CANCEL = 'Cancel';

// ── See changes (design §8.4, board 42 ③, comment design §12.2) ─────────────────────────────────

/** `GET /api/wiki/spaces/:id/docs/:slug/sections/:key/versions`: a section's kept versions, newest first. */
export const getWikiDocVersions = (spaceId: string, slug: string, key: string) =>
  api<{ spaceId: string; slug: string; key: string; versions: WikiDocSectionVersionView[] }>(
    `/wiki/spaces/${encodeURIComponent(spaceId)}/docs/${encodeURIComponent(slug)}/sections/${encodeURIComponent(key)}/versions`,
  );

/** See changes' title for one section: `See changes · 3.1 §3`. */
export const wikiSeeChangesTitle = (where: string): string => `${WIKI_CHAT_COPY.actions.see_changes} · ${where}`;
/** Its line for one write: why, and how many sentences it changed (`After chat … · 1 sentence changed`). */
export const wikiSeeChangesCause = (version: Pick<WikiDocSectionVersionView, 'reason' | 'changed'>): string =>
  `${wikiDocVersionHeading(version.reason)} · ${wikiDocChanged(version.changed)}`;
/** The fold for the versions before the newest one (comment design §12.2: at most four more). */
export const wikiEarlierChanges = (n: number): string => `Earlier changes (${n})`;
export const WIKI_SEE_CHANGES_SAME = 'Every sentence reads as it did.';
export const WIKI_SEE_CHANGES_NONE = 'No earlier version of this section is kept.';
export const WIKI_SEE_CHANGES_FAILED = 'The versions couldn’t be loaded. Check the connection, then try again.';
/** Activity's Docs rows: who wrote them. */
export const WIKI_ACTIVITY_DOCS = 'Docs';

/** The Review page's anchor for one op of a changeset, which an In Review card opens (`/wiki/<space>/review#…`). */
export const wikiReviewItemAnchor = (changesetId: string, seq: number): string => `rv-${changesetId}-${seq}`;
