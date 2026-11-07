// The wiki chat (contracts/wiki.contract.json `chat`, `docs.follow` and `docs.versions`; docs/wiki-contract.md
// §28–§30; docs/wiki-chat-design.md §3–§8): a session docked beside a wiki page, whose agent only drafts and
// whose owner presses Apply; the follow job that rewrites the sections a press or a change to main touched; and
// the versions a rewritten section keeps. Everything here is a constant, a closed set, an English sentence or a
// pure derivation: the server computes the counts and states it serves with these functions, the clients read
// the same words, and wikiChatContract.spec.ts holds all of it to the contract JSON and to the vectors of
// src/shared/src/wiki-chat.fixture.json, which OrbitKit reads too.

import type { WikiRefusal, WikiSimilar } from './wiki';
import type { WikiJobKind } from './wikiJobs';
import type { WikiRepoLook } from './wikiRepoOps';
import type { WikiSystemModelReadState } from './wikiSystemModel';

/** The chat's numbers (contract `chat.rules`). */
export const WIKI_CHAT_RULES = {
  /** The most sentences one selection attaches (design §4.2): a longer one is a section, not a quote. */
  selectionSentencesMax: 20,
  /** The most sections one card rewrites (design §8.2, the card's Rewrites). */
  rewritesMax: 5,
  /** The most chats one read of a space lists, newest first; the counts it carries are over all of them. */
  chatsListed: 50,
} as const;

/** What a card drafts (contract `chat.drafts.kinds`): entry ops, a rewrite of sections from main, a plan change. */
export const WIKI_CHAT_DRAFT_KINDS = ['entry', 'rewrite', 'plan'] as const;
export type WikiChatDraftKind = (typeof WIKI_CHAT_DRAFT_KINDS)[number];

/** Where a card stands (contract `chat.drafts.states`, design §7.3), derived on read by wikiChatDraftState. */
export const WIKI_CHAT_DRAFT_STATES = ['draft', 'replaced', 'changed', 'applied', 'discarded', 'not_applied', 'undone'] as const;
export type WikiChatDraftState = (typeof WIKI_CHAT_DRAFT_STATES)[number];

/** How a card's rewrite stands (contract `chat.drafts.results`, design §8.3); `gone` is design §10's lost section. */
export const WIKI_CHAT_REWRITE_RESULTS = ['rewriting', 'waiting', 'updated', 'same', 'failed', 'gone'] as const;
export type WikiChatRewriteResult = (typeof WIKI_CHAT_REWRITE_RESULTS)[number];

/** What one press does (contract `chat.presses`): the owner's door alone, never a session's. */
export const WIKI_CHAT_PRESSES = ['apply', 'edit', 'discard', 'undo', 'retry', 'seen'] as const;
export type WikiChatPress = (typeof WIKI_CHAT_PRESSES)[number];

/** What a card offers (contract `chat.drafts.actions`), each drawn with WIKI_CHAT_COPY.actions. */
export const WIKI_CHAT_ACTIONS = [
  'apply', 'edit', 'discard', 'rewrite', 'apply_rebuild', 'open_in_plan', 'redo', 'undo', 'open_entry',
  'try_again', 'see_changes', 'settings',
] as const;
export type WikiChatAction = (typeof WIKI_CHAT_ACTIONS)[number];

/** The round button's four looks (contract `chat.fab.states`, design §3). */
export const WIKI_CHAT_FAB_STATES = ['idle', 'working', 'needs_you', 'updated'] as const;
export type WikiChatFabState = (typeof WIKI_CHAT_FAB_STATES)[number];

/** The blocks a chat's delivery appends to the owner's words (contract `chat.notes`), each a tagged block. */
export const WIKI_CHAT_NOTE_TAGS = {
  chat: 'orbit_wiki_chat',
  page: 'orbit_wiki_page',
  selection: 'orbit_wiki_selection',
  drafts: 'orbit_wiki_drafts',
} as const;

/** The follow job's numbers and sets (contract `docs.follow`, design §8.1 and §8.5). */
export const WIKI_DOCS_FOLLOW = {
  /** Its wiki_job kind, which joins jobs.kinds with the migration that adds it to wiki_job_kind_chk. */
  kind: 'docs_follow',
  /** The facts that make or feed one: a chat's press, a session's merge to main, a landing into main. */
  triggers: ['press', 'merge', 'landing'],
  /** A press, and a merge of a chat session, are the owner's work: 1. Any other merge or landing: 0. */
  priorities: { press: 1, chatMerge: 1, merge: 0, landing: 0 },
  /** How many sections a space's follow jobs write in one UTC day for merges and landings; a press's are not counted. */
  sectionsPerDay: 40,
  /** The jobs that write documents, which a follow job waits for (design §8.5). */
  writers: ['maintain', 'docs_build', 'plan_draft', 'plan_revise', 'docs_follow'],
  /** The jobs that write none, beside which a follow job runs. */
  alongside: ['articles', 'verify', 'import', 'smoke'],
} as const;

/** Why a follow job that is not running waits (contract `docs.follow.waiting`), in the order they are looked for. */
export const WIKI_DOCS_FOLLOW_WAITING = [
  'maintenance_running',
  'build_running',
  'plan_running',
  'rewrite_running',
  'worker_not_running',
  'model_unconfigured',
  'model_auth_failed',
  'model_down',
  'no_workspace',
  'runner_missing',
  'runner_offline',
  'runner_upgrade',
] as const;
export type WikiDocsFollowWaiting = (typeof WIKI_DOCS_FOLLOW_WAITING)[number];

/** The waiting reasons the owner fixes in Wiki settings, beside which a card offers Settings. */
export const WIKI_DOCS_FOLLOW_SETTINGS_REASONS: readonly WikiDocsFollowWaiting[] = ['no_workspace', 'runner_missing'];

/** How many versions a section keeps (contract `docs.versions.rules`, design §8.4). */
export const WIKI_DOC_VERSIONS = {
  perSection: 5,
  /** The most rows the Activity read of a space's document changes lists, newest first. */
  changesListed: 50,
} as const;

/** Why a section was written again (contract `docs.versions.reasons`). */
export const WIKI_DOC_VERSION_REASONS = ['maintenance', 'build', 'merge', 'landing', 'chat', 'restore'] as const;
export type WikiDocVersionReasonKind = (typeof WIKI_DOC_VERSION_REASONS)[number];

/**
 * The block a chat's first message carries for its agent (contract `chat.notes.chat.text`, design §4.2's last
 * point), word for word. It says what the agent may do and that nothing it drafts is written until the owner
 * presses; it names no document tool, because there is none (docs.tool).
 */
export const WIKI_CHAT_PROMPT = [
  '<orbit_wiki_chat>',
  "You are chatting beside a page of this repository's Orbit wiki. The page the owner is reading, and any sentences they select, arrive as Orbit attachments.",
  "The wiki's documents are written by the server from the code and from records. Never edit a document's text, and never cite a document or a sentence of one as a source.",
  'Before you change anything, decide where the request belongs: knowledge goes into an entry (wiki_propose); a section behind main is rewritten from main, and a change to how a document is organized or written goes into the plan (both wiki_draft); a change to the system itself is a change to the code, or to the design document it cites.',
  'Everything you propose or draft in this chat is a draft: nothing changes until the owner applies it. Say what each draft would change, never call one applied, and pass replaces with a draft\'s id when you revise it.',
  '</orbit_wiki_chat>',
].join('\n');

/**
 * Every sentence the chat's clients and its server write, the follow job's waiting reasons and the Docs rows of
 * Activity included (contract `chat.copy`, which `docs.follow` and `docs.versions` name for their words). The web
 * defines its labels in src/web/src/lib/wikiChat.ts from these, OrbitKit's WikiCopy mirrors them, and a sentence
 * changes here and in the contract together. `{name}` is filled in by the functions below.
 */
export const WIKI_CHAT_COPY = {
  fab: {
    idle: 'Chat',
    working: 'Working…',
    needsYouOne: '1 needs you',
    needsYouMany: '{n} need you',
    updated: 'Wiki updated',
  },
  panel: {
    newChat: 'New chat',
    runsIn: 'Runs in',
    fromWiki: 'From Wiki',
    ask: 'Ask',
    emptyHint: 'Ask about this page, or say what should change.',
    emptyNote: 'Nothing in the wiki changes until you apply it.',
    placeholder: 'Ask about this page, or say what should change',
    placeholderDraft: 'Reply, or say what to change in the draft',
    noWorktree: 'Turn on worktrees for a workspace in this repository to chat here',
    chooseWorkspace: "Choose where this space's chats run",
    offline: '{machine} is offline. The chat waits for it to come back.',
    mergeNote: 'Once this reaches main, Orbit rewrites what it touches.',
  },
  card: {
    draft: 'Draft · {label}',
    addKind: 'Add {kind}',
    amend: 'Amend entry',
    supersede: 'Supersede entry',
    retire: 'Retire entry',
    reinforce: 'Reinforce entry',
    challenge: 'Challenge entry',
    changes: '{n} changes',
    rewrite: 'Rewrite from main',
    plan: 'Plan change',
    rewrites: 'Rewrites',
    sources: 'Sources',
    yourMessage: 'Your message in this chat',
    footnote: 'Your message · this chat',
    wouldRewrite: 'Draft would rewrite this section',
    sectionUpdated: 'Updated',
    replaced: 'Replaced',
    replacedNote: 'A newer draft took over.',
    changed: 'Changed since this draft',
    web: 'Based on web content',
    webNote: 'Read before you apply.',
    applied: 'Applied · Confirmed by you',
    appliedInReview: 'Applied · In Review',
    appliedInReviewNote: 'Re-confirm, amend or retire the entry in Review.',
    discarded: 'Discarded',
    notApplied: 'Not applied',
    undone: 'Undone',
    redoMessage: 'This draft no longer applies: what it changes has changed since. Draft it again from what is there now.',
  },
  actions: {
    apply: 'Apply',
    edit: 'Edit',
    discard: 'Discard',
    rewrite: 'Rewrite',
    apply_rebuild: 'Apply & rebuild',
    open_in_plan: 'Open in Plan',
    redo: 'Redo',
    undo: 'Undo',
    open_entry: 'Open entry',
    try_again: 'Try again',
    see_changes: 'See changes',
    settings: 'Settings',
  },
  result: {
    rewriting: 'Rewriting {where}…',
    rewritingFrom: 'Rewriting {where} from main@{sha}…',
    waiting: 'Rewrite waiting · {reason}',
    failed: 'Rewrite failed',
    updatedLead: 'Wiki updated',
    sentenceOne: '{where} — 1 sentence',
    sentenceMany: '{where} — {n} sentences',
    same: '{where} — reads the same',
    gone: '{where} — no longer in the plan',
  },
  waiting: {
    maintenance_running: 'Maintenance is running',
    build_running: 'The documents are being built',
    plan_running: 'The plan is being drafted',
    rewrite_running: 'Another rewrite is running',
    worker_not_running: 'wiki worker not running',
    model_unconfigured: 'System model not configured',
    model_auth_failed: 'System model refused the key',
    model_down: 'System model unreachable',
    no_workspace: 'Maintenance has no workspace',
    runner_missing: 'The maintenance workspace has no runner',
    runner_offline: 'Waiting for the runner to come online',
    runner_upgrade: 'Upgrade the runner to read the repository',
  },
  notes: {
    chat: 'Wiki chat',
    pageDoc: 'Wiki page · {where}',
    pageEntry: 'Wiki entry · {title}',
    pagePlan: 'Wiki plan · {doc}',
    selection: 'Wiki selection · {where} · {sentences} · {sources}',
    sentenceOne: '1 sentence',
    sentenceMany: '{n} sentences',
    sourceOne: '1 source',
    sourceMany: '{n} sources',
    drafts: 'Wiki drafts · {counts}',
    applied: '{n} applied',
    edited: '{n} edited',
    discarded: '{n} discarded',
    undone: '{n} undone',
    outdated: 'Outdated',
  },
  waitingBanner: {
    one: '1 rewrite needs you',
    many: '{n} rewrites need you',
  },
  changes: {
    rewritten: '{where} rewritten · {reason} · {changed}',
    restored: '{where} restored · {changed}',
    changedOne: '1 sentence changed',
    changedMany: '{n} sentences changed',
    same: 'reads the same',
    leftOne: '1 section left for the next maintenance run',
    leftMany: '{n} sections left for the next maintenance run',
  },
  reasons: {
    maintenance: 'after maintenance',
    build: 'after the build of plan version {version}',
    merge: 'after {title} merged',
    landing: 'after {title} landed',
    chat: 'after chat {title}',
    restore: 'restored by you',
  },
} as const;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

// ── Cards ────────────────────────────────────────────────────────────────────────────────────────

/** What a card's state is read from (contract `chat.drafts.derivation`): the draft's own facts and its chat's. */
export interface WikiChatDraftFacts {
  /** The owner's press, if any: apply and edit both apply it, discard drops it. */
  decision: 'applied' | 'edited' | 'discarded' | null;
  /** An applied card the owner has undone since. */
  undone: boolean;
  /** A newer draft of the same chat named this one in replaces. */
  replaced: boolean;
  /** The chat session is open: one of OPEN_SESSION_STATUSES and not in Trash. */
  chatOpen: boolean;
  /** An entry the draft changes moved off its baseRevision (or left active), or a section it rewrites was written since it was drafted. */
  baseMoved: boolean;
}

/** Design §7.3, read top to bottom: the first that holds is the card's state, so no two can disagree. */
export function wikiChatDraftState(facts: WikiChatDraftFacts): WikiChatDraftState {
  if (facts.decision === 'applied' || facts.decision === 'edited') return facts.undone ? 'undone' : 'applied';
  if (facts.decision === 'discarded') return 'discarded';
  if (facts.replaced) return 'replaced';
  if (!facts.chatOpen) return 'not_applied';
  if (facts.baseMoved) return 'changed';
  return 'draft';
}

/** One op of an entry card, as much of it as its label needs. */
export interface WikiChatDraftOp {
  op: 'add' | 'reinforce' | 'amend' | 'supersede' | 'retire' | 'challenge';
  /** The new entry's kind, for an add. */
  kind?: string;
}

/** The card's name after `Draft · ` (design §6, board 42 ②④). */
export function wikiChatDraftLabel(kind: WikiChatDraftKind, ops: readonly WikiChatDraftOp[] = []): string {
  if (kind === 'rewrite') return WIKI_CHAT_COPY.card.rewrite;
  if (kind === 'plan') return WIKI_CHAT_COPY.card.plan;
  if (ops.length !== 1) return fill(WIKI_CHAT_COPY.card.changes, { n: ops.length });
  const [only] = ops;
  if (only!.op === 'add') return fill(WIKI_CHAT_COPY.card.addKind, { kind: only!.kind ?? 'entry' });
  return WIKI_CHAT_COPY.card[only!.op];
}

/** One op of a card as its title reads it: what it does, and — once pressed — its decision in the changeset the press recorded. */
export interface WikiChatPressedOp {
  op: string;
  decision?: string | null;
}

/**
 * Whether an applied card still waits in Review (contract `chat.drafts.states.applied`): it holds a challenge whose
 * decision is pending. Its press raised the flag on the entry, and the owner answers that flag in Review — re-confirms,
 * amends or retires the entry — so the card is not confirmed and says `Applied · In Review` instead.
 */
export function wikiChatAppliedInReview(state: WikiChatDraftState, ops: readonly WikiChatPressedOp[]): boolean {
  return state === 'applied' && ops.some((op) => op.op === 'challenge' && op.decision === 'pending');
}

/**
 * The card's status line (design §7.3's first column): `Draft · <label>` while it is open, its state after — an applied
 * card still waiting in Review (`wikiChatAppliedInReview`) says so rather than that it is confirmed.
 */
export function wikiChatCardTitle(state: WikiChatDraftState, label: string, inReview = false): string {
  const { card } = WIKI_CHAT_COPY;
  switch (state) {
    case 'draft':
      return fill(card.draft, { label });
    case 'replaced':
      return card.replaced;
    case 'changed':
      return card.changed;
    case 'applied':
      return inReview ? card.appliedInReview : card.applied;
    case 'discarded':
      return card.discarded;
    case 'not_applied':
      return card.notApplied;
    case 'undone':
      return card.undone;
  }
}

/** One section a card rewrites, and how its rewrite came out once it settled. */
export interface WikiChatSectionResult {
  /** "3.1 §3" (wikiChatWhere). */
  where: string;
  /** Null until the rewrite settled; then updated, same, failed or gone. */
  result: Exclude<WikiChatRewriteResult, 'rewriting' | 'waiting'> | null;
  /** Sentences changed (wikiDocSentenceDiff), for an updated section. */
  changed?: number;
}

/** A card's rewrite as the card read serves it (contract `chat.drafts.read`, rewrite). */
export interface WikiChatCardRewrite {
  result: WikiChatRewriteResult;
  reason: WikiDocsFollowWaiting | null;
  /** origin/main's commit the job writes from, once its snapshot named one. */
  sha: string | null;
  sections: WikiChatSectionResult[];
  /** The owner opened the settled result (the seen press). */
  seen: boolean;
}

/** As much of a card as what it offers and whether it waits on the owner are read from. */
export interface WikiChatCard {
  kind: WikiChatDraftKind;
  state: WikiChatDraftState;
  /** Every op is one the Undo can take back (contract `chat.presses.undo`). Served by the card read. */
  undoable: boolean;
  rewrite: WikiChatCardRewrite | null;
}

/** The buttons a card shows, in the order it shows them (contract `chat.drafts.actions`). */
export function wikiChatCardActions(card: WikiChatCard): WikiChatAction[] {
  switch (card.state) {
    case 'draft':
      if (card.kind === 'rewrite') return ['rewrite', 'discard'];
      if (card.kind === 'plan') return ['apply_rebuild', 'open_in_plan', 'discard'];
      return ['apply', 'edit', 'discard'];
    case 'changed':
      return ['redo', 'discard'];
    case 'applied': {
      const actions: WikiChatAction[] = [];
      if (card.undoable) actions.push('undo');
      if (card.kind === 'entry') actions.push('open_entry');
      const rewrite = card.rewrite;
      if (rewrite?.result === 'waiting' && rewrite.reason && WIKI_DOCS_FOLLOW_SETTINGS_REASONS.includes(rewrite.reason)) actions.push('settings');
      if (rewrite?.result === 'failed') actions.push('try_again');
      if (rewrite?.result === 'updated' || rewrite?.result === 'same') actions.push('see_changes');
      return actions;
    }
    default:
      return [];
  }
}

/**
 * Whether an applied card's rewrite waits on the owner, which is what the Wiki's waiting count (W) adds for it
 * (contract `chat.waiting`): a rewrite held up waits until it is not; one that read the same or failed waits
 * until the owner has seen it, tried it again, or undone the card.
 */
export function wikiChatRewriteWaits(card: WikiChatCard): boolean {
  if (card.state !== 'applied' || !card.rewrite) return false;
  const { result, seen } = card.rewrite;
  if (result === 'waiting') return true;
  return (result === 'same' || result === 'failed') && !seen;
}

/** Whether a card is something the round button counts as needing the owner: an open draft, or a rewrite that waits. */
export function wikiChatCardNeedsYou(card: WikiChatCard): boolean {
  return card.state === 'draft' || card.state === 'changed' || wikiChatRewriteWaits(card);
}

/** A space's cards that add to W, one each (contract `space.list.chatWaiting`). */
export function wikiChatWaiting(cards: readonly WikiChatCard[]): number {
  return cards.filter(wikiChatRewriteWaits).length;
}

/**
 * Whether Undo can take a card back (contract `chat.presses.undo`): an applied entry card every op of which is an add or
 * an amend — the two a revert takes back; a supersede and a retire end a lineage, and a reinforce or a challenge is
 * answered as any other, the challenge in Review — and an applied rewrite card. A plan card's is C12's.
 */
export function wikiChatDraftUndoable(kind: WikiChatDraftKind, state: WikiChatDraftState, ops: readonly WikiChatDraftOp[]): boolean {
  if (state !== 'applied') return false;
  if (kind === 'rewrite') return true;
  if (kind !== 'entry') return false;
  return ops.length > 0 && ops.every((op) => op.op === 'add' || op.op === 'amend');
}

// ── A card as the user door and the drafting tools serve it ─────────────────────────────────────

/** One op of an entry card (contract `chat.drafts.read`, ops): as checked, with its entry as it stands now. */
export interface WikiChatDraftOpView {
  seq: number;
  op: WikiChatDraftOp['op'];
  /** The entry the op is about; for an applied add or supersede, the entry it wrote. */
  entryId: string | null;
  baseRevision: number | null;
  /** The op as checked and redacted: what Apply records. */
  payload: Record<string, unknown>;
  similar: WikiSimilar[];
  tainted: boolean;
  /** That entry as it stands now (entryView), or null when there is none. */
  entry: Record<string, unknown> | null;
  /** Once pressed, the op's decision in the changeset the press recorded: accepted, edited, or pending for a challenge Review answers. */
  decision: string | null;
}

/** A section a card names (contract `chat.drafts.read`, rewrites and sections): its document's number, its own and its title. */
export interface WikiChatDraftSectionView {
  doc: string;
  key: string;
  /** "3.1 §3" (wikiChatWhere), or `slug §key` for a section the confirmed plan no longer numbers. */
  where: string;
  title: string | null;
}

/** An applied card's rewrite (contract `chat.drafts.read`, rewrite). */
export interface WikiChatDraftRewriteView {
  jobId: string;
  result: WikiChatRewriteResult;
  reason: WikiDocsFollowWaiting | null;
  sha: string | null;
  sections: Array<{ doc: string; key: string; where: string; result: WikiChatSectionResult['result']; changed: number | null; versionId: string | null }>;
  seen: boolean;
  settledAt: string | null;
}

/** `GET /api/wiki/chat-drafts/:id`, and each card of `GET /api/wiki/chats/:id/drafts` (contract `chat.drafts.read`). */
export interface WikiChatDraftView {
  id: string;
  sessionId: string;
  kind: WikiChatDraftKind;
  state: WikiChatDraftState;
  label: string;
  rationale: string;
  ops: WikiChatDraftOpView[];
  sections: WikiChatDraftSectionView[];
  rewrites: WikiChatDraftSectionView[];
  /** The entries the card's adds and supersedes resemble, each once, best first: shown before the press (design §10). */
  similar: WikiSimilar[];
  tainted: boolean;
  replaces: string | null;
  replacedBy: string | null;
  decision: 'applied' | 'edited' | 'discarded' | null;
  decidedAt: string | null;
  undoneAt: string | null;
  undoable: boolean;
  changesetId: string | null;
  rewrite: WikiChatDraftRewriteView | null;
  createdAt: string;
}

/** One op of a drafting call's answer in a chat (contract `agentSurface.chat.propose`): drafted, or why not. */
export type WikiChatDraftOpOutcome =
  | { seq: number; status: 'draft'; entryId: string | null; similar?: WikiSimilar[] }
  | {
      seq: number;
      status: 'conflict';
      entryId: string;
      baseRevision: number;
      currentRevision: number;
      current: Record<string, unknown>;
      diff: string;
    }
  | { seq: number; status: 'refused'; reasons: WikiRefusal[] };

/** What wiki_propose answers in a chat (contract `agentSurface.chat.propose`); a request none of whose ops passed answers as ever. */
export interface WikiChatProposeAnswer {
  status: 'draft';
  /** Null for a dry run, which makes nothing. */
  draftId: string | null;
  replayed: boolean;
  dryRun?: true;
  ops: WikiChatDraftOpOutcome[];
  similar: WikiSimilar[];
  rewrites: WikiChatDraftSectionView[];
}

/** What wiki_draft answers (contract `agentSurface.chat.draft.returns`). */
export interface WikiChatDraftToolAnswer {
  status: 'draft';
  draftId: string;
  kind: WikiChatDraftKind;
  replayed: boolean;
  rewrites: WikiChatDraftSectionView[];
}

// ── The round button ─────────────────────────────────────────────────────────────────────────────

/** One chat of a space, as the button counts it. */
export interface WikiChatFabChat {
  /** One of OPEN_SESSION_STATUSES, not in Trash. */
  open: boolean;
  /** A turn is queued or running (PENDING or RUNNING). */
  turnActive: boolean;
  /** Approvals and questions the session waits on the owner for, as the session list counts them. */
  approvals: number;
  cards: readonly WikiChatCard[];
}

/** The three counts the chats read serves for a space (contract `chat.fab.counts`). */
export interface WikiChatFabCounts {
  needsYou: number;
  working: boolean;
  updated: number;
}

export function wikiChatFabCounts(chats: readonly WikiChatFabChat[]): WikiChatFabCounts {
  let needsYou = 0;
  let working = false;
  let updated = 0;
  for (const chat of chats) {
    if (chat.open) {
      needsYou += chat.approvals;
      if (chat.turnActive) working = true;
    }
    for (const card of chat.cards) {
      if (wikiChatCardNeedsYou(card)) needsYou += 1;
      if (card.state !== 'applied' || !card.rewrite) continue;
      if (card.rewrite.result === 'rewriting') working = true;
      if (card.rewrite.result === 'updated' && !card.rewrite.seen) updated += 1;
    }
  }
  return { needsYou, working, updated };
}

/** The button's look and its hover text (design §3): needs you, then working, then updated, then idle. */
export function wikiChatFabState(counts: WikiChatFabCounts): { state: WikiChatFabState; label: string } {
  const { fab } = WIKI_CHAT_COPY;
  if (counts.needsYou > 0) {
    return { state: 'needs_you', label: counts.needsYou === 1 ? fab.needsYouOne : fill(fab.needsYouMany, { n: counts.needsYou }) };
  }
  if (counts.working) return { state: 'working', label: fab.working };
  if (counts.updated > 0) return { state: 'updated', label: fab.updated };
  return { state: 'idle', label: fab.idle };
}

/** The Activity banner for W's chat part, one line however many (contract `chat.waiting.banner`). */
export function wikiChatWaitingBanner(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? WIKI_CHAT_COPY.waitingBanner.one : fill(WIKI_CHAT_COPY.waitingBanner.many, { n });
}

// ── Where, and the result line ───────────────────────────────────────────────────────────────────

/** "3.1 §3": the document's number and the section's, as the docs read numbers them. */
export function wikiChatWhere(doc: string, section: number | string): string {
  return `${doc} §${section}`;
}

/** "A", "A and B", "A, B and C". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The line under an applied card (design §8.3, board 42 ③④). */
export function wikiChatResultLine(rewrite: WikiChatCardRewrite): string {
  const { result: copy } = WIKI_CHAT_COPY;
  const where = listed(rewrite.sections.map((s) => s.where));
  switch (rewrite.result) {
    case 'rewriting':
      return rewrite.sha ? fill(copy.rewritingFrom, { where, sha: rewrite.sha.slice(0, 7) }) : fill(copy.rewriting, { where });
    case 'waiting':
      return fill(copy.waiting, { reason: rewrite.reason ? WIKI_CHAT_COPY.waiting[rewrite.reason] : '' });
    case 'failed':
      return copy.failed;
    default: {
      const parts = rewrite.sections.map((s) => {
        if (s.result === 'updated') {
          const n = s.changed ?? 0;
          return n === 1 ? fill(copy.sentenceOne, { where: s.where }) : fill(copy.sentenceMany, { where: s.where, n });
        }
        if (s.result === 'gone') return fill(copy.gone, { where: s.where });
        return fill(copy.same, { where: s.where });
      });
      const lead = rewrite.sections.some((s) => s.result === 'updated') ? [copy.updatedLead] : [];
      return [...lead, ...parts].join(' · ');
    }
  }
}

// ── The follow job ───────────────────────────────────────────────────────────────────────────────

/** What a follow job's waiting reason is read from (contract `docs.follow.waiting`). */
export interface WikiDocsFollowFacts {
  state: 'queued' | 'running' | 'waiting';
  waitingFor: 'repo' | 'model' | null;
  /** The kind of a job of the same space that writes documents and runs now, if any. */
  writerRunning: WikiJobKind | 'docs_follow' | null;
  model: WikiSystemModelReadState;
  repo: WikiRepoLook;
}

const MODEL_REASON: Partial<Record<WikiSystemModelReadState, WikiDocsFollowWaiting>> = {
  worker_not_running: 'worker_not_running',
  unconfigured: 'model_unconfigured',
  auth_failed: 'model_auth_failed',
  down: 'model_down',
};

const REPO_REASON: Partial<Record<WikiRepoLook, WikiDocsFollowWaiting>> = {
  no_workspace: 'no_workspace',
  runner_missing: 'runner_missing',
  runner_offline: 'runner_offline',
  runner_upgrade: 'runner_upgrade',
};

const WRITER_REASON: Record<string, WikiDocsFollowWaiting> = {
  maintain: 'maintenance_running',
  docs_build: 'build_running',
  plan_draft: 'plan_running',
  plan_revise: 'plan_running',
  docs_follow: 'rewrite_running',
};

/**
 * Why a follow job waits, or null while it is merely in line or running: a queued one first for a job of its
 * space that writes documents, then for the System model, then for the runner its repository is read through;
 * a parked one for what it is parked on.
 */
export function wikiDocsFollowWaiting(facts: WikiDocsFollowFacts): WikiDocsFollowWaiting | null {
  if (facts.state === 'running') return null;
  if (facts.state === 'waiting') {
    if (facts.waitingFor === 'model') return MODEL_REASON[facts.model] ?? 'model_down';
    return REPO_REASON[facts.repo] ?? 'runner_offline';
  }
  if (facts.writerRunning && WRITER_REASON[facts.writerRunning]) return WRITER_REASON[facts.writerRunning]!;
  return MODEL_REASON[facts.model] ?? REPO_REASON[facts.repo] ?? null;
}

/**
 * A fact a follow job carries (contract `docs.follow.triggers`): a chat's press, with the card's sections and the
 * entries it wrote; or a change that reached main — a session's merge, or a landing line's — with the range of
 * commits it put there. A job carries every fact that joined it while it was queued (`docs.follow.queue`).
 */
export type WikiDocsFollowFact =
  | {
    kind: 'press';
    /** The card pressed (`wiki_chat_draft`) and the chat it was drafted in (its session). */
    draftId: string;
    chatId: string;
    /** The chat's title, as the version a written section keeps names it: `after chat <title>`. */
    title: string;
    /** The card's Rewrites, written whatever their fingerprint. */
    sections: WikiChatSectionRef[];
    /** The entries the card wrote, handed to each of its sections with their live sources. */
    entryIds: string[];
    at: string;
  }
  | {
    kind: 'merge' | 'landing';
    /** The session_merge_receipt that recorded it. */
    receiptId: string;
    /** The session's title for a merge, the task's or project's for a landing: `after <title> merged` / `landed`. */
    title: string;
    /** main before it and the commit it put there: the files the range changed are what it touched. */
    from: string;
    sha: string;
    /** The merge was a chat's (`priorities.chatMerge`). */
    chat: boolean;
    at: string;
  };

/** A follow job's input: the facts it carries, in the order they came. */
export interface WikiDocsFollowInput {
  facts: WikiDocsFollowFact[];
}

/** What became of a section a follow job took up (contract `docs.follow.outcomes`). */
export const WIKI_DOCS_FOLLOW_OUTCOMES = ['written', 'unchanged', 'gone', 'failed'] as const;
export type WikiDocsFollowOutcome = (typeof WIKI_DOCS_FOLLOW_OUTCOMES)[number];

/** One section of a follow job's report (contract `docs.follow.report`). */
export interface WikiDocsFollowReportSection {
  doc: string;
  key: string;
  outcome: WikiDocsFollowOutcome;
  /** Sentences the write changed against the version it replaced (`wikiDocSentenceDiff`); null when none was kept. */
  changed: number | null;
  /** The version the write kept of what it replaced (`docs.versions`), or null. */
  versionId: string | null;
  /** A press asked for it: written whatever its fingerprint. */
  forced: boolean;
  /** The cards whose press asked for it. */
  draftIds: string[];
  /** Why a failed section was left unwritten. */
  why?: string;
}

/** A follow job's report (contract `docs.follow.report`), on the job's row once it ends. */
export interface WikiDocsFollowReport {
  kind: 'docs_follow';
  /** The origin/main commit it wrote from; '' when it read none. */
  sha: string;
  sections: WikiDocsFollowReportSection[];
  /** The sections merges and landings asked for that the day's budget left for the next maintenance run. */
  left: number;
  usage: { inputTokens: number; outputTokens: number; calls: number };
}

/**
 * How one of a card's sections came out once its follow job ended (contract `chat.drafts.results`): written with a
 * sentence changed — or written for the first time, with nothing before it to compare — is updated, written with none
 * changed is same; a section left as it was reads the same too; gone and failed are themselves.
 */
export function wikiDocsFollowSectionResult(section: Pick<WikiDocsFollowReportSection, 'outcome' | 'changed'>): 'updated' | 'same' | 'failed' | 'gone' {
  if (section.outcome === 'failed' || section.outcome === 'gone') return section.outcome;
  if (section.outcome === 'written' && section.changed !== 0) return 'updated';
  return 'same';
}

/** A card's result over its sections (contract `chat.drafts.results`): the first of failed, same, updated and gone one of them is. */
export function wikiDocsFollowCardResult(results: ReadonlyArray<'updated' | 'same' | 'failed' | 'gone'>): 'updated' | 'same' | 'failed' | 'gone' {
  for (const result of ['failed', 'same', 'updated', 'gone'] as const) if (results.includes(result)) return result;
  return 'gone';
}

/**
 * Whether two jobs of one space may run at once (contract `jobs.onePerSpace`, design §8.5): only a follow job
 * beside one that writes no document. Every other pair waits, as every pair did before the follow job.
 */
export function wikiJobsMayOverlap(a: string, b: string): boolean {
  const alongside: readonly string[] = WIKI_DOCS_FOLLOW.alongside;
  return (a === WIKI_DOCS_FOLLOW.kind && alongside.includes(b)) || (b === WIKI_DOCS_FOLLOW.kind && alongside.includes(a));
}

/** A section of the confirmed plan, named as the docs read names it. */
export interface WikiChatSectionRef {
  doc: string;
  key: string;
}

/** What a card's Rewrites are worked out from when it is drafted (contract `chat.drafts.rewrites`). */
export interface WikiChatRewritesInput {
  /** The written sections of the confirmed plan, in the plan's order. Nothing else is rewritten. */
  plan: readonly WikiChatSectionRef[];
  /** The sections the chat's owner turns attached (page and selection), newest first. */
  attached: readonly WikiChatSectionRef[];
  /** The sections holding a sentence with a footnote that came through an entry the draft changes (via_entry_id). */
  cited: readonly WikiChatSectionRef[];
  /** The sections a new entry of the draft fits (docs.affected.fit), each with its score. */
  fit: ReadonlyArray<WikiChatSectionRef & { score: number }>;
}

/** Attached first, then cited in the plan's order, then fit by score and the plan's order; at most rules.rewritesMax. */
export function wikiChatRewrites(input: WikiChatRewritesInput): WikiChatSectionRef[] {
  const id = (s: WikiChatSectionRef) => `${s.doc}\u0000${s.key}`;
  const order = new Map(input.plan.map((s, i) => [id(s), i]));
  const out: WikiChatSectionRef[] = [];
  const taken = new Set<string>();
  const take = (s: WikiChatSectionRef) => {
    if (out.length >= WIKI_CHAT_RULES.rewritesMax || taken.has(id(s)) || !order.has(id(s))) return;
    taken.add(id(s));
    out.push({ doc: s.doc, key: s.key });
  };
  input.attached.forEach(take);
  [...input.cited].sort((a, b) => order.get(id(a))! - order.get(id(b))!).forEach(take);
  [...input.fit]
    .filter((s) => s.score > 0 && order.has(id(s)))
    .sort((a, b) => b.score - a.score || order.get(id(a))! - order.get(id(b))!)
    .forEach(take);
  return out;
}

// ── Versions: the sentence-level comparison ──────────────────────────────────────────────────────

export interface WikiDocSentenceRow {
  op: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * A section's sentences before and after one write, sentence by sentence (contract `docs.versions.compare`):
 * the longest common subsequence of the two, compared by text with surrounding whitespace trimmed and inner runs
 * of it read as one space; where two orders are equally long, the removal goes first. `changed` counts each run
 * of removed and added sentences as the larger of the two, so one sentence rewritten is one change.
 */
export function wikiDocSentenceDiff(before: readonly string[], after: readonly string[]): { rows: WikiDocSentenceRow[]; changed: number } {
  const norm = (text: string) => text.trim().replace(/\s+/gu, ' ');
  const a = before.map(norm);
  const b = after.map(norm);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const rows: WikiDocSentenceRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ op: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      rows.push({ op: 'removed', text: a[i]! });
      i += 1;
    } else {
      rows.push({ op: 'added', text: b[j]! });
      j += 1;
    }
  }
  let changed = 0;
  let removed = 0;
  let added = 0;
  for (const row of [...rows, { op: 'same' as const, text: '' }]) {
    if (row.op === 'removed') removed += 1;
    else if (row.op === 'added') added += 1;
    else {
      changed += Math.max(removed, added);
      removed = 0;
      added = 0;
    }
  }
  return { rows, changed };
}

/** Why a section was written again (contract `docs.versions.reasons`), as a version keeps it. */
export interface WikiDocVersionReason {
  kind: WikiDocVersionReasonKind;
  /** The session's, task's, project's or chat's title, for merge, landing and chat. */
  title?: string;
  /** The commit a merge or landing put on main, for merge and landing. */
  sha?: string;
  /** The plan version a build wrote, for build. */
  planVersion?: number;
}

/** "after maintenance", "after <title> merged" … : the reason as a phrase (lower case, as a row reads it). */
export function wikiDocVersionReason(reason: WikiDocVersionReason): string {
  return fill(WIKI_CHAT_COPY.reasons[reason.kind], { title: reason.title ?? '', version: reason.planVersion ?? '' });
}

/** See changes' heading: the reason with a capital, and the commit when there is one. */
export function wikiDocVersionHeading(reason: WikiDocVersionReason): string {
  const phrase = wikiDocVersionReason(reason);
  const head = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return reason.sha ? `${head} · ${reason.sha.slice(0, 7)}` : head;
}

/** "1 sentence changed", "3 sentences changed", "reads the same". */
export function wikiDocChanged(changed: number): string {
  const { changes } = WIKI_CHAT_COPY;
  if (changed === 0) return changes.same;
  return changed === 1 ? changes.changedOne : fill(changes.changedMany, { n: changed });
}

/** One Docs row of Activity's Recently changed (contract `docs.versions.reads.changes`). */
export type WikiDocChange =
  | { kind: 'section'; where: string; reason: WikiDocVersionReason; changed: number }
  | { kind: 'left'; left: number };

export function wikiDocChangeLine(change: WikiDocChange): string {
  const { changes } = WIKI_CHAT_COPY;
  if (change.kind === 'left') return change.left === 1 ? changes.leftOne : fill(changes.leftMany, { n: change.left });
  if (change.reason.kind === 'restore') return fill(changes.restored, { where: change.where, changed: wikiDocChanged(change.changed) });
  return fill(changes.rewritten, { where: change.where, reason: wikiDocVersionReason(change.reason), changed: wikiDocChanged(change.changed) });
}

// ── Notes ────────────────────────────────────────────────────────────────────────────────────────

/** A chat note's attributes, as its block's opening tag carries them (contract `chat.notes`). */
export type WikiChatNote =
  | { kind: 'chat' }
  | { kind: 'page'; of: 'doc'; doc: string; section: number | string }
  | { kind: 'page'; of: 'entry'; title: string }
  | { kind: 'page'; of: 'plan'; doc: string }
  | { kind: 'selection'; doc: string; section: number | string; toSection?: number | string; sentences: number; sources: number }
  | { kind: 'drafts'; applied: number; edited: number; discarded: number; undone: number };

/** What the "Orbit attached:" line names a chat note (board 42 ②: "Wiki selection · 3.1 §3 · 1 sentence · 2 sources"). */
export function wikiChatNoteLabel(note: WikiChatNote): string {
  const { notes } = WIKI_CHAT_COPY;
  const count = (n: number, one: string, many: string) => (n === 1 ? one : fill(many, { n }));
  switch (note.kind) {
    case 'chat':
      return notes.chat;
    case 'page':
      if (note.of === 'doc') return fill(notes.pageDoc, { where: wikiChatWhere(note.doc, note.section) });
      if (note.of === 'entry') return fill(notes.pageEntry, { title: note.title });
      return fill(notes.pagePlan, { doc: note.doc });
    case 'selection': {
      const where = note.toSection !== undefined && String(note.toSection) !== String(note.section)
        ? `${wikiChatWhere(note.doc, note.section)}–§${note.toSection}`
        : wikiChatWhere(note.doc, note.section);
      return fill(notes.selection, {
        where,
        sentences: count(note.sentences, notes.sentenceOne, notes.sentenceMany),
        sources: count(note.sources, notes.sourceOne, notes.sourceMany),
      });
    }
    case 'drafts': {
      const counts = (['applied', 'edited', 'discarded', 'undone'] as const)
        .filter((key) => note[key] > 0)
        .map((key) => fill(notes[key], { n: note[key] }));
      return fill(notes.drafts, { counts: counts.join(', ') });
    }
  }
}

/** `"` `&` `<` `>` as an opening tag's attribute value carries them (wikiChatNoteAttribute / parseWikiChatNoteTag). */
const ATTRIBUTE_ESCAPES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };

/** One attribute of a chat note's opening tag, its value escaped so a title holding a quote stays one value. */
export function wikiChatNoteAttribute(name: string, value: string | number): string {
  return `${name}="${String(value).replace(/[&"<>]/gu, (ch) => ATTRIBUTE_ESCAPES[ch]!)}"`;
}

/**
 * A chat note read back from its block's opening tag (`<orbit_wiki_selection doc="3.1" section="3" …>`), as a client
 * names it on the "Orbit attached:" line; null for any other block, or one whose tag lacks what its label needs, which
 * a client then names as any block it does not know.
 */
export function parseWikiChatNoteTag(block: string): WikiChatNote | null {
  const head = /^<(orbit_wiki_\w+)((?:\s+[\w-]+="[^"]*")*)\s*>/u.exec(block.trimStart());
  if (!head) return null;
  const attributes = new Map<string, string>();
  for (const [, name, value] of head[2]!.matchAll(/([\w-]+)="([^"]*)"/gu)) {
    attributes.set(name!, value!.replace(/&(amp|quot|lt|gt);/gu, (_, e: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>' })[e]!));
  }
  const text = (name: string) => attributes.get(name);
  // A page or a selection no longer in the plan has no number to give: its slug and key name it instead.
  const doc = text('doc') ?? text('slug');
  const section = text('section') ?? text('key');
  const count = (name: string) => {
    const value = text(name);
    return value !== undefined && /^\d+$/u.test(value) ? Number(value) : null;
  };
  switch (head[1]) {
    case WIKI_CHAT_NOTE_TAGS.chat:
      return { kind: 'chat' };
    case WIKI_CHAT_NOTE_TAGS.page: {
      const of = text('of');
      if (of === 'doc' && doc && section) return { kind: 'page', of, doc, section };
      if (of === 'entry' && (text('title') ?? text('entry')) !== undefined) return { kind: 'page', of, title: (text('title') ?? text('entry'))! };
      if (of === 'plan' && doc) return { kind: 'page', of, doc };
      return null;
    }
    case WIKI_CHAT_NOTE_TAGS.selection: {
      const sentences = count('sentences');
      const sources = count('sources');
      if (!doc || !section || sentences === null || sources === null) return null;
      return {
        kind: 'selection',
        doc,
        section,
        ...(text('to') ? { toSection: text('to')! } : {}),
        sentences,
        sources,
      };
    }
    case WIKI_CHAT_NOTE_TAGS.drafts: {
      const [applied, edited, discarded, undone] = (['applied', 'edited', 'discarded', 'undone'] as const).map((key) => count(key) ?? 0);
      return { kind: 'drafts', applied: applied!, edited: edited!, discarded: discarded!, undone: undone! };
    }
    default:
      return null;
  }
}

// ── The chats of a space, as the user door serves them ───────────────────────────────────────────

/** A workspace a space's chats may run in (contract `chat.list.choices`), or the remembered one (`chat.list.workspace`). */
export interface WikiChatWorkspace {
  id: string;
  name: string;
  /** Its machine, as Wiki settings' Workspaces card names it; null when it has none. */
  runner: string | null;
  /** By the runners list's own rule: not signed off, and heard from within the offline window. */
  online: boolean;
}

/** One chat of a space (contract `chat.list.chats`). */
export interface WikiChatRow {
  sessionId: string;
  title: string;
  status: string;
  /** One of OPEN_SESSION_STATUSES and not in Trash. */
  open: boolean;
  createdAt: string;
  updatedAt: string;
  /** How many cards it holds. */
  drafts: number;
  /** How many of the button's `needsYou` are this chat's. */
  needsYou: number;
}

/** `GET /api/wiki/spaces/:id/chats` (contract `chat.list`). */
export interface WikiChatList {
  spaceId: string;
  /** The remembered workspace as it stands now, or null when none is remembered. */
  workspace: (WikiChatWorkspace & { eligible: boolean }) | null;
  choices: WikiChatWorkspace[];
  fab: WikiChatFabCounts;
  chats: WikiChatRow[];
}

/** `POST /api/wiki/spaces/:id/chats` (contract `chat.create.body`). */
export interface WikiChatCreateBody {
  workspaceId?: string;
  content: string;
  clientTurnId: string;
  wikiContext?: WikiChatContext;
  engine?: string;
  model?: string;
  permissionMode?: string;
}

/** What creating a chat answers (contract `chat.create.answer`). */
export interface WikiChatCreateAnswer {
  sessionId: string;
  chat: WikiChatRow;
}

// ── The page and the selection a message carries ─────────────────────────────────────────────────

/** What a chat message may attach (contract `chat.notes.wikiContext`): the page, a selection, either or both. */
export interface WikiChatContext {
  page?: { kind: 'doc'; docSlug: string; sectionKey: string } | { kind: 'entry'; entryId: string } | { kind: 'plan'; docSlug: string };
  selection?: { docSlug: string; sectionKey: string; sentenceIds: string[] };
}

const PAGE_KEYS: Record<string, readonly string[]> = {
  doc: ['kind', 'docSlug', 'sectionKey'],
  entry: ['kind', 'entryId'],
  plan: ['kind', 'docSlug'],
};

/**
 * The paths of what is wrong with a message's wikiContext, as validateWikiSources names them: an unknown key, a
 * page of no known kind, a missing or empty string, and a selection of no sentence, of a sentence twice, or of
 * more than rules.selectionSentencesMax. Empty when it holds.
 */
export function wikiChatContextErrors(value: unknown): string[] {
  const errors: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if (!isObject(value)) return ['wikiContext'];
  for (const key of Object.keys(value)) if (key !== 'page' && key !== 'selection') errors.push(`wikiContext.${key}`);
  if (value.page !== undefined) {
    const page = value.page;
    if (!isObject(page) || typeof page.kind !== 'string' || !PAGE_KEYS[page.kind]) {
      errors.push('wikiContext.page.kind');
    } else {
      const keys = PAGE_KEYS[page.kind]!;
      for (const key of Object.keys(page)) if (!keys.includes(key)) errors.push(`wikiContext.page.${key}`);
      for (const key of keys.filter((k) => k !== 'kind')) if (!text(page[key])) errors.push(`wikiContext.page.${key}`);
    }
  }
  if (value.selection !== undefined) {
    const selection = value.selection;
    if (!isObject(selection)) {
      errors.push('wikiContext.selection');
    } else {
      for (const key of Object.keys(selection)) {
        if (!['docSlug', 'sectionKey', 'sentenceIds'].includes(key)) errors.push(`wikiContext.selection.${key}`);
      }
      for (const key of ['docSlug', 'sectionKey']) if (!text(selection[key])) errors.push(`wikiContext.selection.${key}`);
      const ids = selection.sentenceIds;
      if (
        !Array.isArray(ids) || ids.length === 0 || ids.length > WIKI_CHAT_RULES.selectionSentencesMax
        || !ids.every(text) || new Set(ids).size !== ids.length
      ) {
        errors.push('wikiContext.selection.sentenceIds');
      }
    }
  }
  return errors;
}
