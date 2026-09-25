/**
 * The Wiki's vocabulary and its derivations: every English sentence its pages say, and every reading
 * of the wire types they say it about.
 *
 * ONE PLACE FOR THE WORDS, because the same vocabulary is used on four surfaces — the list rows, the
 * entry drawer, the Review cards and the home page's cards — and the design's own rule is that a word
 * means one thing everywhere (`docs/wiki-design.md` §12.1, effect 4). `Change`/`Changed` is the
 * anchor's word and never a change's; `Amend` covers an amend and a supersede; `Superseded` is a
 * normal ending for a decision, not a failure. OrbitKit draws the same sentences from
 * `WikiCopy` and the two are held together by a copy-parity test, so a literal written inside a
 * component here would be a sentence iOS cannot see.
 *
 * WHAT THE TYPES ARE. `@orbit/shared` is the authority for the entry, the changeset and the space —
 * those are the write door's own shapes. The four reads T8's pages added (`wiki_topic`,
 * the timeline, the usage window) are declared here, beside the page that reads every field of them,
 * which is how `ProjectOpenItemsView` and `CoordinatorStatus` are declared for their own pages.
 */
import {
  KIND_SPECS,
  WIKI_ENTRY_KINDS,
  WIKI_KINDS,
  WIKI_REJECT_REASON_LABELS,
  WIKI_REJECT_REASONS,
  type WikiChangeset,
  type WikiChangesetOp,
  type WikiEntry,
  type WikiEntryKind,
  type WikiEntryRevision,
  type WikiKind,
  type WikiRejectReason,
  type WikiSource,
  type WikiSpace,
  type WikiTrust,
} from '@orbit/shared';
import { encodeId } from './idCodec';

export type {
  WikiAnchor,
  WikiChangeset,
  WikiChangesetOp,
  WikiEntry,
  WikiEntryKind,
  WikiKind,
  WikiSpace,
  WikiSource,
  WikiTrust,
} from '@orbit/shared';

// ── The reads this task added ───────────────────────────────────────────────────────────────────

/** `GET /api/wiki/spaces/:id/topics/:slug` — one topic's page. */
export interface WikiTopicView {
  slug: string;
  /** The name the space declared, or the slug read as words. */
  title: string;
  description: string | null;
  /** Whether the name is the owner's or the slug's. See `WIKI_TOPIC_NAME_DERIVED`. */
  declared: boolean;
  entryCount: number;
  entries: WikiEntry[];
}

/** One change in a space's timeline. `op` and `decision` are the contract's own words. */
export interface WikiTimelineItem {
  opId: string;
  op: string;
  decision: string;
  origin: string;
  at: string;
  entryId: string | null;
  title: string | null;
  kind: string | null;
  status: string | null;
  trust: string | null;
  supersededById: string | null;
  supersededByTitle: string | null;
  reason: string | null;
}

export interface WikiTimeline {
  items: WikiTimelineItem[];
}

/** One entry's use in the window, as the space's usage read aggregates it. */
export interface WikiUsageEntry {
  entryId: string;
  title: string | null;
  total: number;
  pushed: number;
  searched: number;
  fetched: number;
}

/** `GET /api/wiki/spaces/:id?include=usage` — the rolling window the home page's usage block reads. */
export interface WikiUsage {
  days: number;
  /** Distinct sessions an entry was pushed to — a session shown five entries is still one session. */
  sessionsPushed: number;
  searches: number;
  gets: number;
  entries: WikiUsageEntry[];
}

/** A space with the usage window folded in, which is what the home page reads. */
export interface WikiSpaceWithUsage extends WikiSpace {
  usage?: WikiUsage;
}

/** A space as the list read answers it: the document, plus the count the sidebar shows. */
export interface WikiSpaceRow extends WikiSpace {
  pendingOps: number;
}

/** One row of `GET /api/wiki/entries/:id?include=exposure`: a session an entry was shown to. */
export interface WikiExposureRow {
  sessionId: string | null;
  entryId: string;
  revision: number;
  channel: string;
  at: string;
}

/** One entry with everything the drawer draws, as `?include=sources,history,exposure` answers it. */
export interface WikiEntryDetail extends WikiEntry {
  sources?: WikiSource[];
  history?: Array<
    Pick<
      WikiEntryRevision,
      | 'id'
      | 'entryId'
      | 'revision'
      | 'title'
      | 'summary'
      | 'fields'
      | 'topics'
      | 'aliases'
      | 'anchors'
      | 'contentSha256'
      | 'authorKind'
      | 'authorUserId'
      | 'authorSessionId'
      | 'authorToolCallId'
      | 'changesetOpId'
      | 'createdAt'
    >
  >;
  exposure?: WikiExposureRow[];
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

/** A space is addressed by its slug — `/wiki/orbit` reads as the codebase it is. */
export const WIKI_PATH = '/wiki';
export const wikiHomePath = (): string => WIKI_PATH;
export const wikiSpacePath = (spaceSlug: string): string => `${WIKI_PATH}/${spaceSlug}`;
export const wikiTopicPath = (spaceSlug: string, topicSlug: string): string =>
  `${WIKI_PATH}/${spaceSlug}/t/${topicSlug}`;
export const wikiEntryPath = (spaceSlug: string, entryId: string): string =>
  `${WIKI_PATH}/${spaceSlug}/e/${encodeId(entryId)}`;
export const WIKI_REVIEW_PATH = `${WIKI_PATH}/review`;

// ── The words ───────────────────────────────────────────────────────────────────────────────────

export const WIKI_TITLE = 'Wiki';
export const WIKI_SEARCH_PLACEHOLDER = 'Search the wiki';
export const WIKI_SEARCH_SHORTCUT = '⌘K';
export const WIKI_NEW_ENTRY = 'New entry';
export const WIKI_REVIEW_TITLE = 'Review';

/** The sidebar's amber count, and the tooltip that says what it counts. */
export const wikiProposalsToReview = (count: number): string => `${count} proposals to review`;
/** The same count under Review's own title. */
export const wikiProposalsFrom = (count: number, sessions: number): string =>
  `${count} proposal${count === 1 ? '' : 's'} from ${sessions} session${sessions === 1 ? '' : 's'}`;
export const wikiOldest = (when: string): string => `oldest ${when}`;
/** A pending op expires 14 days after it was written; Review says when. */
export const WIKI_PENDING_EXPIRES = (when: string): string => `expires ${when}`;

// The bands of the home page, in the order both clients draw them.
export const WIKI_PRINCIPLES = 'Principles';
export const WIKI_TOPICS = 'Topics';
export const WIKI_RECENT_DECISIONS = 'Recent decisions';
export const WIKI_RECENTLY_CHANGED = 'Recently changed';
export const WIKI_AGENTS_USED = 'Agents used the wiki';
export const WIKI_ALL_DECISIONS = 'All decisions ›';

export const WIKI_PRINCIPLES_HINT = 'written by you · pinned';
export const WIKI_TOPICS_HINT = 'topics';
export const WIKI_RECENT_DECISIONS_HINT = 'decision log · newest first';
export const WIKI_AGENTS_USED_HINT = 'this week';
export const WIKI_MOST_USED = 'Most used';

/** The status line under the title: what the space holds, and how fresh its anchors are. */
export const WIKI_ENTRY_NOUN = (count: number): string => (count === 1 ? 'entry' : 'entries');
export const WIKI_TO_REVIEW = 'to review';
export const wikiAnchorsVerified = (ref: string, ago: string): string =>
  ago ? `Anchors verified at ${ref} ${ago}` : `Anchors verified at ${ref}`;

/** The two states a page can be in before it has anything to draw. */
export const WIKI_NO_SPACES = 'No wiki space yet. A space is a codebase, and the first one is made when a session proposes into it.';
export const WIKI_NO_SUCH_SPACE = 'No wiki space by that name.';
export const WIKI_SPACE_PICKER_HINT = 'The codebase this wiki describes';

/** The two numbers of the usage block, and the bar rows under them. */
export const WIKI_SESSIONS_RECEIVED = 'sessions received wiki context';
export const WIKI_SEARCHES = 'searches';

/** The topic page. */
export const WIKI_ENTRIES_LABEL = 'Entries';
export const WIKI_GROUP_PRINCIPLES = 'Principles & conventions';
export const WIKI_GROUP_DECISIONS = 'Decisions';
export const WIKI_GROUP_PITFALLS = 'Pitfalls';
export const WIKI_GROUP_RECIPES = 'Recipes';
export const WIKI_GROUP_CONCEPTS = 'Concepts';
export const WIKI_GROUP_NOTES: Record<WikiKind, string> = {
  principle: 'What every task in this topic starts from',
  convention: 'What every task in this topic starts from',
  decision: 'Active decisions, newest first',
  pitfall: 'Traps a run has actually hit, with the way out',
  recipe: 'Steps that worked, with how to check them',
  concept: 'The words this topic uses, defined once',
};
export const wikiShowMore = (count: number): string => `Show ${count} more`;
export const WIKI_SHOW_LESS = 'Show less';
export const WIKI_TOPIC_TITLE_FALLBACK = 'Topic';
export const WIKI_TOPIC_MISSING = 'No entry in this space carries that topic.';
/** The amber line under a row whose anchor moved: why it is held back until somebody re-checks it. */
export const WIKI_WARN_ANCHOR_CHANGED =
  'the anchored code changed on main · held back from agents until someone re-checks it';
export const WIKI_COL_CONFIRMED_BY = 'Confirmed by';
export const WIKI_COL_ANCHOR = 'Anchor';
export const WIKI_COL_THIS_WEEK = 'This week';
export const wikiUsedThisWeek = (count: number): string => `Used ${count}× this week`;
export const wikiChangedSinceLastVisit = (count: number): string =>
  `${count} changed since last visit`;
export const WIKI_SUPERSEDED_BY = 'Superseded by';
export const WIKI_NO_LONGER_PUSHED = 'no longer sent to agents';

/**
 * The topic's name, when the space never declared one: phase 1 writes no `wiki_topic` row, so the
 * slug is the only name in play. The server sends `declared` so a page can say which it got — this is
 * the sentence the drawer's kind line leaves out, not something to apologise for on screen.
 */
export const WIKI_TOPIC_NAME_DERIVED = 'named after its slug';

/** The entry drawer's sections, in the order both clients draw them. */
export const WIKI_SECTION_DETAILS = 'Details';
export const WIKI_SECTION_SOURCES = 'Sources';
export const WIKI_SECTION_ANCHORS = 'Anchors';
export const WIKI_SECTION_USED = "Where it's used";
export const WIKI_SECTION_HISTORY = 'History';
export const WIKI_ANCHORS_NOTE =
  'Checked again after every commit to main. If the anchored code changes, agents stop getting this entry until someone re-checks it.';
export const wikiPushedTo = (sessions: number, fetched: number): string =>
  `Pushed to ${sessions} session${sessions === 1 ? '' : 's'} this week · fetched ${fetched}×`;
export const WIKI_NO_USE_YET = 'No session has been shown this entry yet.';

/** The drawer's actions. Retire is the one that takes an entry away from agents. */
export const WIKI_ACTION_EDIT = 'Edit';
export const WIKI_ACTION_SUPERSEDE = 'Supersede…';
export const WIKI_ACTION_RETIRE = 'Retire…';
export const WIKI_ACTION_COPY_LINK = 'Copy link';
export const WIKI_ACTION_OPEN = 'Open entry';
export const WIKI_LINK_COPIED = 'Copied';

/** The history feed's words, by who wrote the revision. */
/** The tick a source wears when the server found its quote in the record it cites. */
export const WIKI_QUOTE_VERIFIED = 'quote verified ✓';
/** And what it says when the quote was kept but could not be checked. */
export const WIKI_QUOTE_UNVERIFIED = 'quote not checked';

export const WIKI_HISTORY_PROPOSED_BY = 'Proposed by a session';
export const WIKI_HISTORY_CONFIRMED_BY = 'Confirmed by you';
export const WIKI_HISTORY_MAINTENANCE = 'Wiki maintenance';
export const WIKI_HISTORY_SYSTEM = 'Recorded by the server';
export const wikiRevision = (revision: number): string => `r${revision}`;
export const wikiCompareWith = (revision: number): string => `Compare with r${revision}`;

/** Review. */
export const WIKI_REVIEW_ACCEPT = 'Accept';
export const WIKI_REVIEW_EDIT = 'Edit';
export const WIKI_REVIEW_REJECT = 'Reject';
export const WIKI_REVIEW_KEEP = 'Keep';
export const WIKI_REVIEW_RETIRE = 'Retire';
export const WIKI_ACCEPT_NOTE = 'Accepting makes it Confirmed';
export const WIKI_WEB_DERIVED_NOTE = 'Web-derived is never auto-accepted';
export const WIKI_REJECT_REASON_FOOT = 'The reason goes back to the session that proposed it.';
export const WIKI_SIMILAR_NONE = 'None';
export const wikiComparedWith = (count: number): string => `compared with ${count} entries`;
export const WIKI_SIMILAR_ENTRIES = 'Similar entries';
export const WIKI_AFTER_RETIRE =
  'Agents stop getting this entry. It stays in History, struck through, and points to the entry that replaced it.';
export const WIKI_WEB_DERIVED = 'Web-derived';
/**
 * What the amber warning says. No page count: how many pages a session read is not on the wire — the
 * op carries the FACT that it is web-derived (`tainted`), not a tally — and a number invented here
 * would be the one thing on the card a reader could not check.
 */
export const WIKI_WEB_DERIVED_WARNING =
  'this session read web pages before proposing. Accepting shows it to agents.';
export const wikiWebDerivedWarning = (): string => WIKI_WEB_DERIVED_WARNING;
export const WIKI_SHOW_THE_PAGES = 'Show the pages';

/** What waits for the owner without asking. */
export const WIKI_AUTO_ACCEPT = 'Auto-accept';
export const WIKI_AUTO_ACCEPT_HINT =
  'These apply without asking you, and still show in Recently changed.';
export const WIKI_REINFORCE = 'Reinforce';
export const WIKI_REINFORCE_NOTE = 'Adds a source to an existing entry';
export const WIKI_CHALLENGE = 'Challenge';
export const WIKI_CHALLENGE_NOTE = 'Flags an entry for re-check; changes nothing';
export const WIKI_ALWAYS_ASKS = 'Always asks you';
export const WIKI_ALWAYS_ASKS_NOTE =
  'Add, Amend and Retire, and anything a session proposed after reading the web.';

/** The tabs' words. `Amend` covers an amend and a supersede; `Change` stays the anchor's word. */
export const WIKI_TAB_ALL = 'All';
export const WIKI_TAB_ADD = 'Add';
export const WIKI_TAB_AMEND = 'Amend';
export const WIKI_TAB_RETIRE = 'Retire';

/** Empty states, and the two reads a phase-1 wiki cannot fill yet. */
export const WIKI_NO_ENTRIES = 'Nothing has been recorded in this space yet.';
export const WIKI_NO_REVIEW = 'Nothing is waiting for you.';
export const WIKI_NO_CHANGES = 'Nothing has changed yet.';
export const WIKI_NO_DECISIONS = 'No decision has been recorded yet.';
export const WIKI_NO_TOPICS = 'No entry has been filed under a topic yet.';
export const WIKI_NO_AGENTS_YET = 'No session has used this wiki yet.';
export const WIKI_NO_ENTRY_SELECTED = 'That entry is no longer in this space.';
/** §12.1's generated Summary is phase 2: the page says so rather than drawing an empty box. */
export const WIKI_SUMMARY_PHASE_2 = 'A generated summary arrives with the maintenance run (phase 2).';

// ── Trust, kind, op and anchor marks: one vocabulary on every surface ───────────────────────────

export const WIKI_TRUST_LABELS: Record<WikiTrust, string> = {
  owner: 'Owner',
  confirmed: 'Confirmed',
  proposed: 'Proposed',
  external: 'Web-derived',
};

/** A trust's tone on the shared `.tdp-badge`, and the dot colour the lists draw beside it. */
export type WikiTone = 'owner' | 'blue' | 'muted' | 'green' | 'amber' | 'red';

export const WIKI_TRUST_TONE: Record<WikiTrust, WikiTone> = {
  owner: 'owner',
  confirmed: 'blue',
  proposed: 'muted',
  external: 'amber',
};

/** A kind's own word, where a page names it in prose. */
export function wikiKindWord(kind: string): string {
  return WIKI_KIND_LABELS[kind as WikiEntryKind] ?? kind;
}

export const WIKI_KIND_LABELS: Record<WikiEntryKind, string> = {
  principle: 'Principle',
  convention: 'Convention',
  decision: 'Decision',
  pitfall: 'Pitfall',
  recipe: 'Recipe',
  concept: 'Concept',
  assumption: 'Assumption',
};

/** The op words Review's chips and the timeline's verbs are built from. */
export const WIKI_OP_LABELS: Record<string, string> = {
  add: 'ADD',
  amend: 'AMEND',
  supersede: 'SUPERSEDE',
  retire: 'RETIRE',
  reinforce: 'REINFORCE',
  challenge: 'CHALLENGE',
};

/** A status word, where an entry's own status is the thing being said (a decision log's rows). */
export const WIKI_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  proposed: 'Proposed',
  superseded: 'Superseded',
  retired: 'Retired',
  rejected: 'Rejected',
};

/** The four rejection reasons, in the order Review's menu lists them. */
export const WIKI_REJECT_MENU: Array<{ reason: WikiRejectReason; label: string }> =
  WIKI_REJECT_REASONS.map((reason) => ({ reason, label: WIKI_REJECT_REASON_LABELS[reason] }));

// ── Derivations ─────────────────────────────────────────────────────────────────────────────────

/**
 * How much this entry has been used, as the entry's own `stats` aggregate it.
 *
 * `stats` is phase 1's column with no writer yet, so every entry is level on it today; the reading is
 * here rather than at the call site because it is the same sum the server ranks search results by
 * (`usageOf` in `wiki-retrieval.ts`), and two spellings of it would drift.
 */
export function wikiUsageOf(stats: unknown): number {
  const row = (stats ?? {}) as Record<string, unknown>;
  const count = (key: string): number => {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return count('searchHits') + count('gets');
}

/** An entry's topic slugs, deduplicated and in the order it lists them. */
export function wikiTopicsOf(entry: Pick<WikiEntry, 'topics'>): string[] {
  return [...new Set(entry.topics ?? [])];
}

export interface WikiTopicSummary {
  slug: string;
  count: number;
  /** The most recently changed entry carrying the topic, which is the line the grid shows. */
  latest: WikiEntry | null;
}

/**
 * The topics a space's entries actually use, and how many entries each holds.
 *
 * Derived from the entries, because phase 1 writes no `wiki_topic` row: an entry names its topics by
 * slug, so the slugs in use ARE the topics. Sorted by count and then by slug, so two runs over the
 * same entries answer in the same order.
 */
export function wikiTopicSummaries(entries: readonly WikiEntry[]): WikiTopicSummary[] {
  const bySlug = new Map<string, WikiEntry[]>();
  for (const entry of entries) {
    for (const slug of wikiTopicsOf(entry)) {
      const held = bySlug.get(slug) ?? [];
      held.push(entry);
      bySlug.set(slug, held);
    }
  }
  return [...bySlug]
    .map(([slug, held]) => ({
      slug,
      count: held.length,
      latest: [...held].sort(byChangedAtDesc)[0] ?? null,
    }))
    .sort((a, b) => b.count - a.count || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** The entries of one kind, newest change first. */
export function wikiEntriesOfKind(entries: readonly WikiEntry[], kind: WikiEntryKind): WikiEntry[] {
  return entries.filter((entry) => entry.kind === kind).sort(byChangedAtDesc);
}

/** Newest change first: what an entry says became true, which is what a reader wants ordered. */
export function byChangedAtDesc(a: WikiEntry, b: WikiEntry): number {
  const at = Date.parse(b.validFrom) - Date.parse(a.validFrom);
  return at !== 0 ? at : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The groups a topic page draws, in the design's order, with the kinds that are empty left out.
 *
 * Principles and conventions share one group (they are what a task starts from, and the design's own
 * index groups them); the rest are one kind each.
 */
export const WIKI_TOPIC_GROUPS: ReadonlyArray<{ kinds: WikiKind[]; title: string; note: string }> = [
  { kinds: ['principle', 'convention'], title: WIKI_GROUP_PRINCIPLES, note: WIKI_GROUP_NOTES.principle },
  { kinds: ['decision'], title: WIKI_GROUP_DECISIONS, note: WIKI_GROUP_NOTES.decision },
  { kinds: ['pitfall'], title: WIKI_GROUP_PITFALLS, note: WIKI_GROUP_NOTES.pitfall },
  { kinds: ['recipe'], title: WIKI_GROUP_RECIPES, note: WIKI_GROUP_NOTES.recipe },
  { kinds: ['concept'], title: WIKI_GROUP_CONCEPTS, note: WIKI_GROUP_NOTES.concept },
];

/** The entries of one group, newest first, each group's kinds merged. */
export function wikiGroupEntries(entries: readonly WikiEntry[], kinds: readonly WikiKind[]): WikiEntry[] {
  return entries.filter((entry) => kinds.includes(entry.kind as WikiKind)).sort(byChangedAtDesc);
}

/** What a decision's badge says: it is superseded, or it is in force. */
export function wikiDecisionWord(entry: WikiEntry): string {
  return WIKI_STATUS_LABELS[entry.status] ?? entry.status;
}

/**
 * The word a timeline row leads with, from what actually happened to the op.
 *
 * Read off the op and its decision rather than off the entry's trust, because the two say different
 * things: the trust is what an entry IS, and this is what somebody did to it — the design keeps
 * `Added` / `Confirmed` / `Amended` / `Retired` as one vocabulary across the timeline, the topic
 * grid and the Review cards, and `Change` stays the anchor's word alone.
 */
export function wikiChangeVerb(item: Pick<WikiTimelineItem, 'op' | 'decision' | 'origin'>): string {
  if (item.decision === 'accepted') return WIKI_HISTORY_CONFIRMED_BY;
  if (item.decision === 'edited') return 'Edited by you';
  switch (item.op) {
    case 'retire':
      return 'Retired';
    case 'supersede':
      return 'Superseded';
    case 'reinforce':
      return 'Reinforced';
    case 'challenge':
      return 'Challenged';
    case 'add':
      return item.origin === 'owner' ? 'Added by you' : 'Proposed';
    default:
      return item.origin === 'owner' ? 'Amended by you' : 'Amended';
  }
}

/** The note under a timeline row's title: why it was retired, or what the amend changed. */
export function wikiChangeNote(item: Pick<WikiTimelineItem, 'op' | 'reason' | 'supersededByTitle'>): string | null {
  if (item.op === 'retire') {
    return item.supersededByTitle ? `replaced by “${item.supersededByTitle}”` : item.reason;
  }
  if (item.op === 'supersede' && item.supersededByTitle) return `replaces “${item.supersededByTitle}”`;
  return null;
}

/** The anchor's three states as the lists say them, and the tone each carries. */
export type WikiAnchorMark = { word: string; tone: WikiTone };

/**
 * What the anchor column says for one entry.
 *
 * A verified anchor shows the ref it was checked at (`✓ 4db4f9f`), which is why this takes the entry
 * rather than a state alone. `unchecked` says nothing: an entry nothing has re-checked yet has not
 * "changed", and dressing that up as a warning would put every freshly written entry in amber.
 */
export function wikiAnchorMark(entry: Pick<WikiEntry, 'anchorState' | 'anchorCheckedRef'>): WikiAnchorMark | null {
  switch (entry.anchorState) {
    case 'verified':
      return { word: entry.anchorCheckedRef ? shortSha(entry.anchorCheckedRef) : 'Checked', tone: 'green' };
    case 'changed':
      return { word: 'Changed', tone: 'amber' };
    case 'missing':
      return { word: 'Missing', tone: 'red' };
    default:
      return null;
  }
}

export function shortSha(ref: string): string {
  return /^[0-9a-f]{40}$/u.test(ref) ? ref.slice(0, 7) : ref;
}

/** One anchor's own line: the path (with its symbol, when it has one), or the commit it names. */
export function wikiAnchorLabel(anchor: { type?: unknown; path?: unknown; symbol?: unknown; sha?: unknown; command?: unknown; ref?: unknown }): string {
  const path = typeof anchor.path === 'string' ? anchor.path : null;
  const symbol = typeof anchor.symbol === 'string' ? anchor.symbol : null;
  if (path) return symbol ? `${path} · ${symbol}` : path;
  if (typeof anchor.sha === 'string') return shortSha(anchor.sha);
  if (typeof anchor.command === 'string') return anchor.command;
  if (typeof anchor.ref === 'string') return anchor.ref;
  return '—';
}

/** One anchor's state, in the same three words the entry's own mark uses. */
export function wikiAnchorStateOf(anchor: { check?: { state?: unknown; ref?: unknown } }): WikiAnchorMark {
  const state = anchor.check?.state;
  const ref = typeof anchor.check?.ref === 'string' ? anchor.check.ref : null;
  if (state === 'verified') return { word: ref ? shortSha(ref) : 'Checked', tone: 'green' };
  if (state === 'changed') return { word: 'Changed', tone: 'amber' };
  if (state === 'missing') return { word: 'Missing', tone: 'red' };
  return { word: 'Unchecked', tone: 'muted' };
}

// ── The entry's own fields, as the drawer draws them ────────────────────────────────────────────

export interface WikiFieldRow {
  label: string;
  /** A sentence, a list, or one entry's key–value pairs. */
  value: string | string[];
}

/** `whyRejected` reads as "Rejected" on a decision's card — the word the design's mock uses. */
const FIELD_LABELS: Record<string, string> = {
  whyRejected: 'Rejected',
  // The design's decision cards say `Rejected`, not `Alternatives`: what the row is FOR is the road
  // not taken, and that is the word the mock and the ADR both use.
  alternatives: 'Rejected',
  decidedAt: 'Decided',
  notToConfuseWith: 'Not to be confused with',
  expectedExit: 'Expected exit code',
  errorSignature: 'Error signature',
};

function labelOf(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/gu, ' $1').toLowerCase();
}

/**
 * The rows the drawer's Details section draws for one entry: the kind's schema, in the schema's own
 * order, with the values it actually carries.
 *
 * WALKED FROM `KIND_SPECS` rather than hand-listed per kind: the shared registry is what the write
 * door validates against, so a kind that grows a field shows it here without a second list to keep in
 * step — which is the failure mode a hand-written table has, and the one the contract's `kinds` block
 * exists to prevent on the server side.
 */
export function wikiFieldRows(kind: WikiEntryKind, fields: unknown): WikiFieldRow[] {
  const spec = (KIND_SPECS as Record<string, { fields: Record<string, unknown> } | undefined>)[kind];
  const row = (fields ?? {}) as Record<string, unknown>;
  if (!spec) return Object.entries(row).flatMap(([key, value]) => rowFor(key, labelOf(key), value));
  return Object.keys(spec.fields).flatMap((key) => rowFor(key, labelOf(key), row[key]));
}

function rowFor(key: string, label: string, value: unknown): WikiFieldRow[] {
  // A decision's alternatives read as the design writes them — the option and why it lost, one line
  // each — rather than as a pair of key–value lines per alternative.
  if (key === 'alternatives' && Array.isArray(value)) {
    const lines = value.flatMap((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const option = typeof row.option === 'string' ? row.option : null;
      const why = typeof row.whyRejected === 'string' ? row.whyRejected : null;
      if (option && why) return [`${option} — ${why}`];
      return option ? [option] : why ? [why] : [];
    });
    return lines.length > 0 ? [{ label, value: lines }] : [];
  }
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.trim() ? [{ label, value }] : [];
  if (typeof value === 'number') return [{ label, value: String(value) }];
  if (Array.isArray(value)) {
    const lines = value.flatMap((item) => scalarLines(item));
    return lines.length > 0 ? [{ label, value: lines }] : [];
  }
  if (typeof value === 'object') {
    const lines = Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
      scalarLines(inner).map((line) => `${labelOf(key)}: ${line}`),
    );
    return lines.length > 0 ? [{ label, value: lines }] : [];
  }
  return [];
}

function scalarLines(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarLines);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
      scalarLines(inner).map((line) => `${labelOf(key)}: ${line}`),
    );
  }
  return [];
}

// ── "since last visit": the blue dots, and the line that explains them ──────────────────────────

/**
 * When the reader last had this page open, kept per space and topic in the browser.
 *
 * A LOCAL FACT, not a server one: what a reader has already seen is about them and their browser, and
 * the wiki itself has no idea who is looking at it. The design's own rule for the mark (`§12.1` mock
 * 01 §4) is a blue dot meaning "changed since you were last here", so where the reader has been has
 * to be written down somewhere — this is that, and nothing else reads it.
 */
export function wikiSeenKey(spaceSlug: string, scope: string): string {
  return `orbit:wiki:seen:${spaceSlug}:${scope}`;
}

export function readWikiSeen(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function writeWikiSeen(key: string, at: number = Date.now()): void {
  try {
    localStorage.setItem(key, String(at));
  } catch {
    // A browser with storage turned off loses the dots and nothing else; there is no fallback worth
    // building for a decoration.
  }
}

/** The entries that changed after `since`. Nothing seen before means everything is new. */
export function wikiChangedSince(entries: readonly WikiEntry[], since: number): WikiEntry[] {
  if (since <= 0) return [...entries];
  return entries.filter((entry) => Date.parse(entry.validFrom) > since);
}

// ── The red/green diff a pending amendment is shown as ──────────────────────────────────────────

export interface WikiDiffLine {
  sign: ' ' | '-' | '+';
  text: string;
}

export interface WikiDiffHunk {
  /** What changed, by the field's own label. */
  label: string;
  lines: WikiDiffLine[];
}

/**
 * What an amendment would change, as the red/green lines Review draws.
 *
 * EVERY LINE OF THE OLD VALUE IS REMOVED AND EVERY LINE OF THE NEW ONE ADDED, rather than a
 * line-matched diff: these are one-line summaries and short lists, the copy is what a reader is
 * checking rather than the punctuation, and a real diff algorithm over two paragraphs of prose
 * produces a wall of noise for a one-word change. `chat-diff` in `index.css` is the conversation's
 * own renderer, and this hands it the lines it already knows how to draw.
 *
 * A key the op does not name is not shown at all: an omitted key carries over from the base revision
 * (`mergeChanges` on the server), so drawing it would be a diff of "nothing changed here".
 */
export function wikiChangesDiff(
  before: Record<string, unknown>,
  changes: Record<string, unknown> | undefined,
): WikiDiffHunk[] {
  if (!changes) return [];
  return Object.entries(changes).flatMap(([key, value]) => {
    const after = scalarLines(value);
    const was = scalarLines(before[key]);
    if (after.length === 0 && was.length === 0) return [];
    return [
      {
        label: FIELD_LABELS[key] ?? labelOf(key),
        lines: [
          ...was.map((text): WikiDiffLine => ({ sign: '-', text })),
          ...after.map((text): WikiDiffLine => ({ sign: '+', text })),
        ],
      },
    ];
  });
}

/** The one line a list row shows under its title, whatever the kind. */
export function wikiRowSummary(entry: WikiEntry): string {
  return entry.summary?.trim() ? entry.summary : '';
}

/** Every phase-1 kind, in the order the new-entry picker and the group titles list them. */
export const WIKI_PHASE_1_KINDS: readonly WikiKind[] = WIKI_KINDS;

/** Whether a kind a stored entry carries is one this phase draws with its own view. */
export function wikiKindIsKnown(kind: string): kind is WikiKind {
  return (WIKI_ENTRY_KINDS as readonly string[]).includes(kind) && (WIKI_KINDS as readonly string[]).includes(kind);
}

/** The changes an op would make, as Review's cards and diff draw them. */
export function wikiOpPayload(op: WikiChangesetOp): Record<string, unknown> {
  return (op.payload ?? {}) as Record<string, unknown>;
}

/** A changeset's op count by the tab it falls under. See {@link WIKI_TAB_AMEND}. */
export function wikiTabOf(op: string): 'add' | 'amend' | 'retire' | 'other' {
  if (op === 'add') return 'add';
  if (op === 'amend' || op === 'supersede') return 'amend';
  if (op === 'retire') return 'retire';
  return 'other';
}

/** Whether the changeset a Review card draws still has an op waiting for the owner. */
export function wikiPendingOps(changeset: WikiChangeset): WikiChangesetOp[] {
  return changeset.ops.filter((op) => op.decision === 'pending');
}
