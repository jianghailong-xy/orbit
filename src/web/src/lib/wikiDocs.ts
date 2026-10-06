/**
 * The Wiki's documents on the web (criterion 10 revised 2026-09-28, mocks 23–28): the directory by the
 * confirmed plan's categories and documents, one document with its sentences' marks and footnotes, and
 * Browse by category and the A–Z index by document — the words those pages say and every reading of the
 * docs reads (contract `docs.reads`) they say it about.
 *
 * ONE PLACE FOR THE WORDS, as in `lib/wikiArticles.ts`: OrbitKit's `WikiDocCopy` says the same sentences
 * and `WikiDocsCopyParityTests` looks each one up here, so a literal written inside a component would be
 * a sentence iOS cannot see. The cases both ends are held to are `src/shared/src/wiki-docs.fixture.json`.
 *
 * WHAT IS READ, NOT INVENTED. A footnote's place, quote and verdict are the server's (it re-read the
 * record, or the runner read the lines at a sha); the entries under a document are the ones its quotes
 * came through (`entries`, owner's call 2026-09-29: only those, not every entry its sections' conditions
 * match). Where a read carries nothing to say — a record's kind the server gave no label for — the page
 * says less rather than guessing.
 */
import {
  WIKI_DOC_RULES,
  type WikiDocFootnoteKind,
  type WikiDocFootnoteView,
  type WikiDocSectionView,
  type WikiDocSentenceView,
  type WikiDocView,
  type WikiDocViaEntry,
  type WikiDocsDirectory,
  type WikiDocsIndexItem,
  type WikiDocVerdict,
  type WikiDocWithdrawReason,
  type WikiPlanSectionKind,
} from '@orbit/shared';
import { encodeId } from './idCodec';
import { sessionRecordHref } from './transcriptDeepLink';
import {
  WIKI_HISTORY_MAINTENANCE,
  WIKI_PATH,
  WIKI_TOPIC_GROUPS,
  shortSha,
  type WikiEntry,
} from './wiki';
import { wikiArticleCount, wikiCount, wikiIndexInitial, wikiPinyinCollator, WIKI_INDEX_LETTERS } from './wikiArticles';
import { wikiMonthDay } from './wikiReviewMode';

export type {
  WikiDocFootnoteView,
  WikiDocSectionView,
  WikiDocSentenceView,
  WikiDocView,
  WikiDocViaEntry,
  WikiDocsDirectory,
  WikiDocsIndex,
  WikiDocsIndexItem,
} from '@orbit/shared';

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

/** A document's page: `/wiki/orbit/d/session-runtime` (mock 23), by the plan document's slug. */
export const wikiDocPath = (spaceSlug: string, slug: string): string => `${WIKI_PATH}/${spaceSlug}/d/${slug}`;
/** A section's place on its document's page, which the directory's section rows link to. */
export const wikiDocSectionAnchor = (key: string): string => `sec-${key}`;
export const wikiDocSectionPath = (spaceSlug: string, slug: string, key: string): string =>
  `${wikiDocPath(spaceSlug, slug)}#${wikiDocSectionAnchor(key)}`;

// ── The words ───────────────────────────────────────────────────────────────────────────────────

/** The directory's fourth row (mock 25 ①): the plan, with the amber count of what waits on the owner. */
export const WIKI_DIRECTORY_PLAN = 'Plan';

/** A section's kind as the pages name it (mock 27's right-hand column, mock 21's Sections table). */
export const WIKI_SECTION_KIND_LABELS: Record<WikiPlanSectionKind, string> = {
  overview: 'Overview',
  concepts: 'Concepts',
  flow: 'Flow',
  interface: 'Interface',
  data: 'Data & config',
  ops: 'Operations',
  pitfalls: 'Pitfalls',
  decisions: 'Decisions',
  conventions: 'Conventions',
  other: 'Other',
};

export const wikiSectionKindLabel = (kind: string): string => WIKI_SECTION_KIND_LABELS[kind as WikiPlanSectionKind] ?? kind;

/** The reader and scope block (mock 23 ④): the plan document's own fields, named as the plan page names them. */
export const WIKI_DOC_QUESTION = 'Question';
export const WIKI_DOC_WRITTEN_FOR = 'Written for';
export const WIKI_DOC_COVERS = 'Covers';
export const WIKI_DOC_NOT_COVERED = 'Not covered';
/** The phone's folded row (mock 24 ①): the three names, then how many lines each holds. */
export const WIKI_DOC_SCOPE_FOLDED = `${WIKI_DOC_WRITTEN_FOR} · ${WIKI_DOC_COVERS} · ${WIKI_DOC_NOT_COVERED}`;

/** The sentence marks (mock 23 ⑤), and the section that has a withdrawn sentence. */
export const WIKI_MARK_NO_SOURCE = 'No source';
export const WIKI_MARK_NOT_VERIFIED = 'Not verified';
export const WIKI_MARK_WITHDRAWN = 'Withdrawn';
export const WIKI_REWRITE_PENDING = 'Rewrite pending';

/** The banner over a document past the threshold (mock 23 ③). */
export const WIKI_DOC_NEEDS_REVIEW = 'Needs review';
export const WIKI_NEXT_MARKED = 'Next marked ›';

/** A document the plan has and no run has written yet (mock 23's strip, «Not written yet»). */
export const WIKI_DOC_NOT_WRITTEN = 'Not written yet.';
/** Its section, when the document is written and that section is not (an accepted proposal's). */
export const WIKI_DOC_SECTION_NOT_WRITTEN = 'Not written yet — Wiki maintenance writes it on its next run.';

/** The footnote card (mock 23 ⑥) and the footnotes under the text (mock 23 ⑦). */
export const WIKI_DOC_FOOTNOTES = 'Footnotes';
export const WIKI_VIA_ENTRY = 'Via entry';
export const WIKI_NO_QUOTE_GIVEN = '— no quote given';
/** The entries under the document (mock 23 ⑧): the ones its quotes came through. */
export const WIKI_DOC_ENTRIES = 'Entries';

/** The lines a code or design-doc footnote shows of its excerpt before `… N more lines`: desktop, phone. */
export const WIKI_EXCERPT_LINES = 8;
export const WIKI_EXCERPT_LINES_PHONE = 6;
/** The footnotes the list under the text shows before `Show N more`. */
export const WIKI_FOOTNOTES_SHOWN = 15;
/** The entries a kind group under the document shows before `Show N more`: desktop, phone. */
export const WIKI_DOC_GROUP_SHOWN = 4;
export const WIKI_DOC_GROUP_SHOWN_PHONE = 3;
/** The sections Browse shows of the document it has open on a phone, before `N more sections`. */
export const WIKI_BROWSE_SECTIONS_SHOWN_PHONE = 6;

const plural = (count: number, one: string, many: string): string => `${wikiCount(count)} ${count === 1 ? one : many}`;

/**
 * A space's documents, as the native space picker says them under its repository (design §12.3.4, mock
 * 31 ④): how many its confirmed plan has, or none yet. The web's select names the spaces alone; the words
 * are kept here with the documents' others so OrbitKit's `WikiCopy` says the same.
 */
export const wikiDocumentCount = (count: number): string => plural(count, 'document', 'documents');
export const WIKI_NO_DOCUMENTS_YET = 'No documents yet';

export const wikiMoreLines = (count: number): string => `… ${plural(count, 'more line', 'more lines')}`;
export const wikiMoreSections = (count: number): string => plural(count, 'more section', 'more sections');
export const wikiDocEntriesHint = (count: number): string => `the ${wikiCount(count)} this document’s quotes came through, by kind`;

// ── Dates ───────────────────────────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `Sep 15, 07:37`: when a record a footnote quotes was made, in this reader's time zone. */
export function wikiMonthDayTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  return `${wikiMonthDay(iso)}, ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}

/** `§7`, `§3 and §7`, `§3, §5 and §7`: sections named together in a sentence. */
export function wikiSectionList(numbers: readonly number[]): string {
  const marks = [...new Set(numbers)].sort((a, b) => a - b).map((n) => `§${n}`);
  if (marks.length <= 1) return marks[0] ?? '';
  return `${marks.slice(0, -1).join(', ')} and ${marks[marks.length - 1]}`;
}

// ── One document's head ─────────────────────────────────────────────────────────────────────────

/** Which kinds of original a document's quotes come from, as its tags and its footnotes' heading count them. */
const QUOTE_GROUPS: ReadonlyArray<{ kinds: readonly WikiDocFootnoteKind[]; one: string; many: string }> = [
  { kinds: ['turn', 'event', 'tool_call'], one: 'session quote', many: 'session quotes' },
  { kinds: ['design_doc', 'code', 'contract'], one: 'code & doc quote', many: 'code & doc quotes' },
  { kinds: ['task', 'task_comment'], one: 'task quote', many: 'task quotes' },
  { kinds: ['approval', 'owner_decision', 'merge_receipt'], one: 'record quote', many: 'record quotes' },
  { kinds: ['note'], one: 'note', many: 'notes' },
];

/** How many of a document's footnotes quote each kind of original: `14 session quotes`, `1 note`. */
export function wikiQuoteCounts(footnotes: ReadonlyArray<Pick<WikiDocFootnoteView, 'kind'>>): string[] {
  return QUOTE_GROUPS.flatMap((group) => {
    const count = footnotes.filter((note) => group.kinds.includes(note.kind)).length;
    return count > 0 ? [plural(count, group.one, group.many)] : [];
  });
}

/**
 * The tags after the category (mock 23 ②): its sections, its footnotes, and what the footnotes quote —
 * `9 sections · 45 footnotes · 14 session quotes · 30 code & doc quotes · 1 note`.
 */
export function wikiDocTags(doc: Pick<WikiDocView, 'sections' | 'footnotes'>): string[] {
  const tags = [plural(doc.sections.length, 'section', 'sections')];
  if (doc.footnotes.length > 0) tags.push(plural(doc.footnotes.length, 'footnote', 'footnotes'), ...wikiQuoteCounts(doc.footnotes));
  return tags;
}

/**
 * The line under the tags (mock 23 ②): when it was written and at which commit, by whom and from which
 * plan version, and how many sentences — `Updated Sep 28 at 99cd3c4 · written by Wiki maintenance from
 * plan v1 · 95 sentences`. None for a document the plan has and no run has written: its page says
 * `Not written yet.` in that place instead (`wikiDocNotWrittenNote`).
 */
export function wikiDocUpdatedParts(
  doc: Pick<WikiDocView, 'written' | 'updatedAt' | 'repoSha' | 'writtenFromPlanVersion' | 'planVersion' | 'counts'>,
): string[] {
  if (!doc.written) return [];
  const day = doc.updatedAt ? (wikiMonthDay(doc.updatedAt) ?? '') : '';
  const at = doc.repoSha ? ` at ${shortSha(doc.repoSha)}` : '';
  return [
    `Updated ${day}${at}`,
    `written by ${WIKI_HISTORY_MAINTENANCE} from plan v${doc.writtenFromPlanVersion ?? doc.planVersion}`,
    plural(doc.counts.sentences, 'sentence', 'sentences'),
  ];
}

/**
 * The amber end of that line on a document under the threshold (mock 23 strip, «Fine»): what is marked
 * in it all the same — `1 without a source`. A document past the threshold says it in its banner instead.
 */
export function wikiDocUpdatedWarn(doc: Pick<WikiDocView, 'written' | 'status' | 'counts'>): string | null {
  if (!doc.written || doc.status === 'needs_review') return null;
  const parts: string[] = [];
  if (doc.counts.unsourced > 0) parts.push(`${wikiCount(doc.counts.unsourced)} without a source`);
  if (doc.counts.unverified > 0) parts.push(`${wikiCount(doc.counts.unverified)} not verified`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The threshold as the banner says it: `5%`. */
export const wikiNeedsReviewThreshold = (): string => `${Math.round(WIKI_DOC_RULES.needsReviewAbove * 100)}%`;

/**
 * The banner's sentence after `Needs review ·` (mock 23 ③): how many sentences are marked, their share,
 * and what that means. The share is the server's (`unsourcedShare`: withdrawn sentences count in the
 * whole but not in the marked).
 */
export function wikiDocNeedsReviewText(doc: Pick<WikiDocView, 'counts' | 'unsourcedShare'>): string {
  const marked = doc.counts.unsourced + doc.counts.unverified;
  const share = (Math.round(doc.unsourcedShare * 1000) / 10).toFixed(1);
  return (
    `${wikiCount(marked)} of ${plural(doc.counts.sentences, 'sentence', 'sentences')} (${share}%) state something no footnote `
    + `backs, or cite one that couldn’t be verified. Over ${wikiNeedsReviewThreshold()}, the whole document is marked; `
    + 'they’re marked below, and written again when their section is.'
  );
}

export type WikiSentenceMark = 'unsourced' | 'unverified' | 'withdrawn';

export const WIKI_MARK_LABELS: Record<WikiSentenceMark, string> = {
  unsourced: WIKI_MARK_NO_SOURCE,
  unverified: WIKI_MARK_NOT_VERIFIED,
  withdrawn: WIKI_MARK_WITHDRAWN,
};

/** The mark a sentence wears, or null for a sourced sentence or a transition. */
export function wikiSentenceMark(sentence: Pick<WikiDocSentenceView, 'status'>): WikiSentenceMark | null {
  return sentence.status === 'unsourced' || sentence.status === 'unverified' || sentence.status === 'withdrawn'
    ? sentence.status
    : null;
}

/** The banner's legend: each mark the document has, with how many sentences wear it. */
export function wikiDocLegend(doc: Pick<WikiDocView, 'counts'>): Array<{ mark: WikiSentenceMark; label: string; count: number }> {
  return (['unsourced', 'unverified', 'withdrawn'] as const)
    .map((mark) => ({ mark, label: WIKI_MARK_LABELS[mark], count: doc.counts[mark] }))
    .filter((item) => item.count > 0);
}

/** The sections a withdrawal left waiting for the next run, in the legend's words: `§7 rewritten at the next run`. */
export function wikiDocRewriteNote(sections: ReadonlyArray<Pick<WikiDocSectionView, 'number' | 'stale'>>): string | null {
  const stale = sections.filter((section) => section.stale).map((section) => section.number);
  return stale.length > 0 ? `${wikiSectionList(stale)} rewritten at the next run` : null;
}

/** The sentence under a document no run has written yet (mock 23 strip, «Not written yet»). */
export function wikiDocNotWrittenNote(docs: { written: number; total: number } | null): string {
  const count = docs ? ` — ${wikiCount(docs.written)} of ${plural(docs.total, 'document is', 'documents are')} written` : '';
  return `Wiki maintenance writes it on its next run${count}. What it will cover is below.`;
}

/** The phone's folded reader-and-scope row: how many lines each of its three fields holds, `2 · 5 · 3`. */
export function wikiDocScopeCounts(doc: Pick<WikiDocView, 'audience' | 'scopeIn' | 'scopeOut'>): string {
  return [doc.audience.length, doc.scopeIn.length, doc.scopeOut.length].map(wikiCount).join(' · ');
}

/** Where a «Not covered» line leaves its matter: `→ 3.2`, the document's number, else its title. */
export function wikiScopeTarget(target: { slug: string; number: string | null; title: string | null }): string {
  return `→ ${target.number ?? target.title ?? target.slug}`;
}

// ── A marked sentence, explained (mock 23 strip, the three hover notes) ──────────────────────────

/** What a footnote points at, as the explanations name it. */
function originWord(note: Pick<WikiDocFootnoteView, 'kind'>): string {
  switch (note.kind) {
    case 'code':
      return 'code';
    case 'design_doc':
      return 'a design doc';
    case 'contract':
      return 'a contract';
    default:
      return 'a record';
  }
}

/** The record a footnote quotes, as a sentence names it: `event #2703`, `turn #4`, `tool call Bash`. */
export function wikiRecordName(note: Pick<WikiDocFootnoteView, 'kind' | 'seq' | 'label'>): string {
  switch (note.kind) {
    case 'turn':
      return note.seq !== null ? `turn #${note.seq}` : 'turn';
    case 'event':
      return note.seq !== null ? `event #${note.seq}` : 'event';
    case 'tool_call':
      return note.label ? `tool call ${note.label}` : 'tool call';
    case 'task':
      return 'task';
    case 'task_comment':
      return 'comment';
    case 'approval':
      return note.label ? `approval of ${note.label}` : 'approval';
    case 'owner_decision':
      return 'decision';
    case 'merge_receipt':
      return 'merge receipt';
    case 'note':
      return 'note';
    default:
      return 'lines';
  }
}

const WITHDRAW_CLAUSES: Record<WikiDocWithdrawReason, string> = {
  rejected: 'which you rejected',
  retired: 'which was retired',
  superseded: 'which was superseded',
  anchor_changed: 'whose anchor changed',
  anchor_missing: 'whose anchor went missing',
};

export interface WikiMarkNote {
  /** Bold, first: `No source.` */
  title: string;
  text: string;
  /** The footnote a not-verified sentence failed on: `See footnote [10]`. */
  see: number | null;
  /** The entry a withdrawn sentence came through: the phone's `Open the entry ›`. */
  entryId: string | null;
}

export const wikiSeeFootnote = (n: number): string => `See footnote [${n}]`;
export const WIKI_OPEN_THE_ENTRY = 'Open the entry ›';

/**
 * Why a marked sentence wears its mark, in the words the hover note says (web) and the tap bubble says
 * (web phone and iOS) — one sentence for each of the three marks, naming the section that is written
 * again, and for a not-verified sentence the footnote it failed on.
 */
export function wikiMarkNote(
  sentence: WikiDocSentenceView,
  section: Pick<WikiDocSectionView, 'number'>,
  doc: Pick<WikiDocView, 'footnotes' | 'entries'>,
): WikiMarkNote | null {
  const mark = wikiSentenceMark(sentence);
  if (mark === 'unsourced') {
    return {
      title: `${WIKI_MARK_NO_SOURCE}.`,
      text: `This sentence states something no footnote backs. It’s written again, with a source or without the claim, when §${section.number} is.`,
      see: null,
      entryId: null,
    };
  }
  if (mark === 'unverified') {
    const notes = new Map(doc.footnotes.map((note) => [note.n, note]));
    const failed = sentence.notes.map((n) => notes.get(n)).find((note) => note && note.verdict !== 'verified') ?? null;
    let text = 'Its footnote couldn’t be checked, so neither could the sentence.';
    if (failed?.verdict === 'no_quote') text = `Its footnote cites ${originWord(failed)} without quoting it, so the sentence couldn’t be checked.`;
    else if (failed?.verdict === 'not_found') text = `Its footnote’s quote isn’t in the ${wikiRecordName(failed)} it cites, so the sentence couldn’t be checked.`;
    else if (failed?.verdict === 'unresolved') text = 'Its footnote cites a record this wiki can’t read, so the sentence couldn’t be checked.';
    return { title: `${WIKI_MARK_NOT_VERIFIED}.`, text, see: failed?.n ?? null, entryId: null };
  }
  if (mark === 'withdrawn' && sentence.withdrawn) {
    const entry = doc.entries.find((row) => row.id === sentence.withdrawn!.entryId);
    const name = entry ? `「${entry.title}」` : 'an entry';
    const day = wikiMonthDay(sentence.withdrawn.at);
    return {
      title: `${WIKI_MARK_WITHDRAWN}.`,
      text:
        `It came through ${name}, ${WITHDRAW_CLAUSES[sentence.withdrawn.reason] ?? 'which left the wiki'}${day ? ` on ${day}` : ''}. `
        + `§${section.number} is written again at the next maintenance run.`,
      see: null,
      entryId: sentence.withdrawn.entryId,
    };
  }
  return null;
}

// ── A footnote ──────────────────────────────────────────────────────────────────────────────────

export const WIKI_FOOTNOTE_KIND_LABELS: Record<WikiDocFootnoteKind, string> = {
  design_doc: 'Design doc',
  code: 'Code',
  contract: 'Contract',
  turn: 'Session',
  event: 'Session',
  tool_call: 'Session',
  task: 'Task',
  task_comment: 'Task comment',
  approval: 'Approval',
  owner_decision: 'Owner decision',
  merge_receipt: 'Merge receipt',
  note: 'Note',
};

/** A repository original: its lines are read on the runner at a sha, not by the server. */
export const wikiFootnoteIsRepo = (note: Pick<WikiDocFootnoteView, 'kind'>): boolean =>
  note.kind === 'design_doc' || note.kind === 'code' || note.kind === 'contract';

const EVENT_LABELS: Record<string, string> = {
  assistant: 'Agent reply',
  user: 'User message',
  tool_use: 'Tool call',
  tool_result: 'Command output',
  error: 'Error',
  thinking: 'Thinking',
  result: 'Run result',
  status: 'Status',
};

/**
 * Whose words a record footnote quotes, after its kind (mock 23 ⑥ `Session · User message`): a turn is
 * the owner's message, an event the engine's (an agent's reply, a command's output), a comment its
 * author's. Null where the read gives nothing to say it with.
 */
export function wikiFootnoteSubLabel(note: Pick<WikiDocFootnoteView, 'kind' | 'label'>): string | null {
  switch (note.kind) {
    case 'turn':
      return note.label === 'steer' ? 'Steer' : 'User message';
    case 'event':
      return note.label ? (EVENT_LABELS[note.label] ?? null) : null;
    case 'tool_call':
      return 'Command output';
    case 'task_comment':
      return note.label === 'AGENT' ? 'Agent’s comment' : note.label === 'USER' ? 'Your comment' : null;
    default:
      return null;
  }
}

/** The card's verdict, right of its head (mock 23 ⑥): `quote verified ✓` or what went wrong. */
export const WIKI_VERDICT_CARD: Record<WikiDocVerdict, string> = {
  verified: 'quote verified ✓',
  not_found: '✗ quote not found',
  no_quote: '✗ no quote given',
  unresolved: '✗ source not found',
};

/** The same verdict in the list under the text (mock 23 ⑦), where a tick says the quote is verified. */
export const WIKI_VERDICT_LIST: Record<WikiDocVerdict, string> = {
  verified: '✓',
  not_found: '✗ quote not found',
  no_quote: '✗ no quote',
  unresolved: '✗ not found',
};

/** `L330–341`, or `L12` for one line. */
export function wikiLineRange(start: number | null, end: number | null): string | null {
  if (start === null) return null;
  return end !== null && end !== start ? `L${start}–${end}` : `L${start}`;
}

/** A repository original's first part: `docs/architecture.md § Execution model`, `src/x.ts · Symbol`. */
function repoWhere(note: WikiDocFootnoteView): string {
  const path = note.path ?? note.location;
  if (note.kind === 'design_doc' && note.section) return `${path} § ${note.section}`;
  if (note.kind === 'code' && note.symbol) return `${path} · ${note.symbol}`;
  return path;
}

/**
 * Where a footnote's original is, in the list under the text (mock 23 ⑦): a design doc's path and
 * heading, code's path and symbol, a session record's session and place in it — `执行任务：… · turn #1 ·
 * Sep 15, 02:33` — a comment's task.
 */
export function wikiFootnoteWhere(note: WikiDocFootnoteView): string {
  if (wikiFootnoteIsRepo(note)) return repoWhere(note);
  return recordParts(note, false).join(' · ');
}

/** A record's place: what it belongs to, its own name, and when it was made. */
function recordParts(note: WikiDocFootnoteView, withProject: boolean): string[] {
  const when = wikiMonthDayTime(note.at);
  const parts: string[] = [];
  switch (note.kind) {
    case 'turn':
    case 'event':
    case 'tool_call':
    case 'approval':
      if (note.sessionTitle) parts.push(note.sessionTitle);
      if (withProject && note.projectTitle) parts.push(note.projectTitle);
      break;
    case 'task':
    case 'task_comment':
      if (note.taskTitle) parts.push(note.taskTitle);
      if (withProject && note.projectTitle) parts.push(note.projectTitle);
      break;
    case 'merge_receipt':
      if (note.taskTitle ?? note.sessionTitle) parts.push((note.taskTitle ?? note.sessionTitle)!);
      break;
    case 'owner_decision':
      if (note.projectTitle) parts.push(note.projectTitle);
      break;
    case 'note':
      return [note.notePath ?? note.location];
    default:
      break;
  }
  parts.push(wikiRecordName(note));
  if (when) parts.push(when);
  return parts;
}

/**
 * The card's place line, before its link (mock 23 ⑥): a session record with its project — `执行任务：… ·
 * 项目推进可靠性：… · turn #4 · Sep 15, 07:37` — and a repository original with its lines, `src/…ts ·
 * RealtimeService.waitForInbox · L330–341`.
 */
export function wikiFootnotePlace(note: WikiDocFootnoteView): string {
  if (wikiFootnoteIsRepo(note)) {
    const lines = wikiLineRange(note.lineStart, note.lineEnd);
    return lines ? `${repoWhere(note)} · ${lines}` : repoWhere(note);
  }
  return recordParts(note, true).join(' · ');
}

/** Where a footnote's link goes, and what it says. */
export interface WikiFootnoteOpen {
  label: string;
  href: string;
  /** Out of Orbit, in a new tab: the repository's host. */
  external: boolean;
}

/** `https://github.com/<owner>/<repo>` for a space whose repository is on GitHub (`repoUrlNorm`), else null. */
export function wikiGithubRepo(repoUrlNorm: string | null | undefined): string | null {
  const match = /^github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u.exec(repoUrlNorm ?? '');
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/**
 * The footnote's way to its original (mock 23 ⑥; on a phone the sheet's one button, owner's call
 * 2026-09-29): a session record opens its session at that very record (`sessionRecordHref`, the deep
 * link criterion 10 rests on); a comment its task; repository lines the file on GitHub at the commit the
 * run read it at, those lines highlighted. Null where Orbit has nothing to open — a note.
 */
export function wikiFootnoteOpen(note: WikiDocFootnoteView, github: string | null): WikiFootnoteOpen | null {
  if (wikiFootnoteIsRepo(note)) {
    if (!github || !note.path || !note.sha) return null;
    const lines = note.lineStart !== null ? `#L${note.lineStart}${note.lineEnd !== null && note.lineEnd !== note.lineStart ? `-L${note.lineEnd}` : ''}` : '';
    const path = note.path.split('/').map(encodeURIComponent).join('/');
    return { label: `Open on GitHub at ${shortSha(note.sha)} ↗`, href: `${github}/blob/${note.sha}/${path}${lines}`, external: true };
  }
  const session = note.sessionId && note.recordId ? sessionRecordHref(note.sessionId, note.recordId) : null;
  switch (note.kind) {
    case 'turn':
      return session ? { label: 'Open at this turn', href: session, external: false } : null;
    case 'event':
      return session ? { label: 'Open at this event', href: session, external: false } : null;
    case 'tool_call':
      return session ? { label: 'Open at this tool call', href: session, external: false } : null;
    case 'task':
      return note.taskId ? { label: 'Open the task', href: `/tasks/${encodeId(note.taskId)}`, external: false } : null;
    case 'task_comment':
      return note.taskId ? { label: 'Open the comment', href: `/tasks/${encodeId(note.taskId)}`, external: false } : null;
    case 'approval':
    case 'merge_receipt':
      return note.sessionId ? { label: 'Open the session', href: `/sessions/${encodeId(note.sessionId)}`, external: false } : null;
    case 'owner_decision':
      return note.projectId ? { label: 'Open the project', href: `/projects/${encodeId(note.projectId)}`, external: false } : null;
    default:
      return null;
  }
}

/** The link as the card's place line ends with it: `Open at this turn ›`, `Open on GitHub at 99cd3c4 ↗`. */
export const wikiFootnoteOpenInline = (open: WikiFootnoteOpen): string => (open.external ? open.label : `${open.label} ›`);

/**
 * The red line of a footnote that did not check (mock 23 strip): what went wrong, in the words the card
 * says it — the quote is not in the record, the sentence gave no quote to check, or the record is none
 * this wiki can read.
 */
export function wikiFootnoteProblem(note: WikiDocFootnoteView): string | null {
  switch (note.verdict) {
    case 'not_found':
      return `These words aren’t in the ${wikiRecordName(note)} it cites. Open it to see what it does say.`;
    case 'no_quote':
      return `The sentence cites this ${wikiFootnoteIsRepo(note) ? (note.kind === 'design_doc' ? 'design doc' : note.kind) : 'record'} without quoting it, so it couldn’t be checked.`;
    case 'unresolved':
      return 'The record it cites isn’t one this wiki can read, so it couldn’t be checked.';
    default:
      return null;
  }
}

/** A quote as the pages print it, in curly quotes. */
export const wikiQuoted = (quote: string): string => `“${quote}”`;

/** One line of a repository footnote's excerpt, and whether the quote is on it (drawn lit, mock 23 strip). */
export interface WikiExcerptLine {
  n: number;
  text: string;
  quoted: boolean;
}

/** A line's words without a comment's opening marks, whitespace folded: what a quote is looked for in. */
function lineCore(text: string): string {
  return text
    .replace(/^\s*(?:\/\*\*?|\*\/|\*|\/\/+|#+|--)\s?/u, '')
    .replace(/\s*\*\/\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The excerpt's lines, numbered from the first line the runner read, the quoted ones lit — a line is
 * quoted when it holds the whole quote, or when the quote holds all of it (at least 8 characters of it,
 * so a lone brace is not) — and how many lines are left after the first `shown`.
 */
export function wikiExcerptLines(
  note: Pick<WikiDocFootnoteView, 'excerpt' | 'lineStart' | 'quote'>,
  shown: number,
): { lines: WikiExcerptLine[]; more: number } {
  if (!note.excerpt) return { lines: [], more: 0 };
  const all = note.excerpt.replace(/\n$/u, '').split('\n');
  const start = note.lineStart ?? 1;
  const quote = note.quote ? note.quote.replace(/\s+/gu, ' ').trim() : '';
  const lines = all.map((text, i) => {
    const core = lineCore(text);
    const quoted = quote !== '' && core !== '' && (core.includes(quote) || (core.length >= 8 && quote.includes(core)));
    return { n: start + i, text, quoted };
  });
  return { lines: lines.slice(0, shown), more: Math.max(0, lines.length - shown) };
}

/** The footnotes' heading line (mock 23 ⑦): `45 · 14 session quotes · 30 code & doc quotes · 1 note`. */
export function wikiFootnotesSummary(footnotes: ReadonlyArray<Pick<WikiDocFootnoteView, 'kind'>>): string {
  return [wikiCount(footnotes.length), ...wikiQuoteCounts(footnotes)].join(' · ');
}

// ── The entries under the document (mock 23 ⑧) ──────────────────────────────────────────────────

/** An entry's line after `via` in the footnote list, and its own row's note: what happened to it. */
export function wikiViaEntryStatus(entry: Pick<WikiDocViaEntry, 'status'>): string | null {
  switch (entry.status) {
    case 'rejected':
      return 'Rejected by you';
    case 'retired':
      return 'Retired';
    case 'superseded':
      return 'Superseded';
    default:
      return null;
  }
}

/**
 * A via entry that left the wiki, under its title in the entries (mock 23 ⑧): what happened to it, and
 * what that did to the document — `Rejected by you · its sentence in §7 is withdrawn`.
 */
export function wikiViaEntryNote(entry: Pick<WikiDocViaEntry, 'id' | 'status'>, doc: Pick<WikiDocView, 'sections'>): string | null {
  const status = wikiViaEntryStatus(entry);
  const withdrawn: number[] = [];
  let count = 0;
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      for (const sentence of block.sentences) {
        if (sentence.withdrawn?.entryId === entry.id) {
          count += 1;
          withdrawn.push(section.number);
        }
      }
    }
  }
  const parts = status ? [status] : [];
  if (count === 1) parts.push(`its sentence in ${wikiSectionList(withdrawn)} is withdrawn`);
  else if (count > 1) parts.push(`its sentences in ${wikiSectionList(withdrawn)} are withdrawn`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface WikiDocEntryGroup {
  title: string;
  note: string;
  entries: WikiDocViaEntry[];
}

/**
 * The entries by kind, in the topic page's groups (`WIKI_TOPIC_GROUPS`), each in the order its quotes
 * first appear — the entry a reader just followed footnote [28] to is where [28] would put it.
 */
export function wikiDocEntryGroups(entries: readonly WikiDocViaEntry[]): WikiDocEntryGroup[] {
  const first = (entry: WikiDocViaEntry): number => (entry.notes.length > 0 ? Math.min(...entry.notes) : Number.MAX_SAFE_INTEGER);
  return WIKI_TOPIC_GROUPS.map((group) => ({
    title: group.title,
    note: group.note,
    entries: entries
      .filter((entry) => (group.kinds as readonly string[]).includes(entry.kind))
      .sort((a, b) => first(a) - first(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  })).filter((group) => group.entries.length > 0);
}

/** An entry's summary, when the space's entry list has it: the via entries carry title and marks, not words. */
export function wikiEntrySummaries(entries: readonly WikiEntry[] | undefined): Map<string, string> {
  return new Map((entries ?? []).map((entry) => [entry.id, entry.summary]));
}

/** The sections of a document's page, top to bottom — the web phone's order, and the one iOS draws. */
export const WIKI_DOC_SECTIONS = ['crumb', 'title', 'tags', 'updated', 'review', 'scope', 'body', 'footnotes', 'entries'] as const;

/** The footnote card's parts, top to bottom — the popover's, the phone sheet's and iOS's. */
export const WIKI_FOOTNOTE_CARD_PARTS = ['head', 'quote', 'problem', 'place', 'via', 'open'] as const;

// ── The directory, by the confirmed plan (mock 25 ①) ────────────────────────────────────────────

export interface WikiDocDirectoryDoc {
  slug: string;
  number: string;
  title: string;
  written: boolean;
  /** An amber dot: the whole document is marked. */
  needsReview: boolean;
  sections: Array<{ key: string; number: number; title: string; written: boolean; stale: boolean }>;
}

export interface WikiDocDirectoryGroup {
  key: string;
  number: number;
  title: string;
  docs: WikiDocDirectoryDoc[];
}

/** The directory's groups: the plan's categories in its order, each with its documents; a category with none left out. */
export function wikiDocDirectoryGroups(directory: WikiDocsDirectory): WikiDocDirectoryGroup[] {
  return directory.categories
    .filter((category) => category.docs.length > 0)
    .map((category) => ({
      key: category.key,
      number: category.number,
      title: category.title || category.key,
      docs: category.docs.map((doc) => ({
        slug: doc.slug,
        number: doc.number,
        title: doc.title || doc.slug,
        written: doc.written,
        needsReview: doc.status === 'needs_review',
        sections: doc.sections.map((section) => ({
          key: section.key,
          number: section.number,
          title: section.title,
          written: section.written,
          stale: section.stale,
        })),
      })),
    }));
}

/** Whether a space's documents are what its Wiki reads by (a plan is confirmed), or it still reads by topic. */
export const wikiReadsByDocs = (directory: WikiDocsDirectory | null | undefined): boolean => !!directory?.plan;

// ── Browse by category, by document (mocks 27 ②, 28 ①) ──────────────────────────────────────────

const sectionCount = (directory: WikiDocsDirectory): number =>
  directory.categories.reduce((sum, category) => sum + category.docs.reduce((n, doc) => n + doc.sections.length, 0), 0);

/** Browse's line under its title: `49 documents · 10 categories · 371 sections`, then `plan v1`. */
export function wikiDocsBrowseSummary(directory: WikiDocsDirectory): string[] {
  const categories = directory.categories.filter((category) => category.docs.length > 0).length;
  const docs = directory.categories.reduce((sum, category) => sum + category.docs.length, 0);
  const parts = [`${plural(docs, 'document', 'documents')} · ${plural(categories, 'category', 'categories')} · ${plural(sectionCount(directory), 'section', 'sections')}`];
  if (directory.plan) parts.push(`plan v${directory.plan.version}`);
  return parts;
}

/** A category's line beside its title: `3 documents · 20 sections`. */
export function wikiDocsCategoryLine(category: WikiDocsDirectory['categories'][number]): string {
  const sections = category.docs.reduce((n, doc) => n + doc.sections.length, 0);
  return `${plural(category.docs.length, 'document', 'documents')} · ${plural(sections, 'section', 'sections')}`;
}

/** A document's state beside its sections' count in Browse: amber `Needs review`, grey `Not written yet`. */
export const WIKI_DOC_NEEDS_REVIEW_SHORT = WIKI_DOC_NEEDS_REVIEW;
export const WIKI_DOC_NOT_WRITTEN_SHORT = WIKI_DOC_NOT_WRITTEN.replace(/\.$/u, '');

export function wikiDocsDocLine(doc: Pick<WikiDocsDirectory['categories'][number]['docs'][number], 'sections' | 'written' | 'status'>): {
  sections: string;
  state: { text: string; tone: 'warn' | 'muted' } | null;
} {
  return {
    sections: plural(doc.sections.length, 'section', 'sections'),
    state: !doc.written
      ? { text: WIKI_DOC_NOT_WRITTEN_SHORT, tone: 'muted' }
      : doc.status === 'needs_review'
        ? { text: WIKI_DOC_NEEDS_REVIEW_SHORT, tone: 'warn' }
        : null,
  };
}

// ── The A–Z index, by document (mocks 27 ③④, 28 ②) ──────────────────────────────────────────────

/** The index's line under its title: `49 documents and 301 sections by title · Chinese titles by pinyin`. */
export function wikiDocsIndexSummary(items: readonly Pick<WikiDocsIndexItem, 'kind'>[]): string {
  const docs = items.filter((item) => item.kind === 'doc').length;
  const sections = items.length - docs;
  return `${plural(docs, 'document', 'documents')} and ${plural(sections, 'section', 'sections')} by title · Chinese titles by pinyin`;
}

/** An index row's right-hand line: `1.3 · 产品概览 · document`, or `§2 in 7.1 Runner 架构与注册`. */
export function wikiDocsIndexMeta(item: WikiDocsIndexItem): string {
  if (item.kind === 'doc') return `${item.docNumber} · ${item.category.title} · document`;
  return `§${item.sectionNumber} in ${item.docNumber} ${item.docTitle}`;
}

export interface WikiDocsIndexGroup {
  letter: string;
  items: WikiDocsIndexItem[];
}

/** Every title under its letter (`wikiIndexInitial`), the letters in the bar's order, each group by pinyin. */
export function wikiDocsIndexGroups(items: readonly WikiDocsIndexItem[]): WikiDocsIndexGroup[] {
  const compare = wikiPinyinCollator().compare;
  const sorted = [...items].sort(
    (a, b) =>
      compare(a.title, b.title)
      || (a.kind === b.kind ? 0 : a.kind === 'doc' ? -1 : 1)
      || compare(a.docNumber, b.docNumber)
      || (a.sectionNumber ?? 0) - (b.sectionNumber ?? 0),
  );
  const byLetter = new Map<string, WikiDocsIndexItem[]>();
  for (const item of sorted) {
    const letter = wikiIndexInitial(item.title);
    byLetter.set(letter, [...(byLetter.get(letter) ?? []), item]);
  }
  return WIKI_INDEX_LETTERS.filter((letter) => byLetter.has(letter)).map((letter) => ({ letter, items: byLetter.get(letter)! }));
}

/** Where an index row goes: the document, or the section on its document's page. */
export const wikiDocsIndexPath = (spaceSlug: string, item: WikiDocsIndexItem): string =>
  item.kind === 'section' && item.sectionKey
    ? wikiDocSectionPath(spaceSlug, item.docSlug, item.sectionKey)
    : wikiDocPath(spaceSlug, item.docSlug);

// ── The home, by the confirmed plan (design §12.3.1, mocks 30 ③, 31 ① ③ ⑥) ──────────────────────────

/** The line under the home's head once a plan is confirmed (`docs.total`, `docs.written`): `35 documents · 5 written`. */
export const wikiDocsWritten = (total: number, written: number): string =>
  `${plural(total, 'document', 'documents')} · ${wikiCount(written)} written`;
/** The same line while there is nothing to read: no plan confirmed and no topic article. */
export const WIKI_NO_DOCUMENTS = 'No documents yet';
/** A new space's one card (mock 31 ⑥): why it has nothing, over Set up maintenance (`WIKI_PLAN_SET_UP`). */
export const WIKI_NO_DOCUMENTS_NOTE =
  'This wiki has no documents yet. Maintenance drafts a plan and writes them; it isn’t set up for this space.';
/** A category's documents not written yet, folded into one row under its written ones: `+3 not written yet`. */
export const wikiNotWrittenYet = (count: number): string => `+${wikiCount(count)} not written yet`;
/** A category none of whose documents is written yet, as its one row: `3 documents · Not written yet`. */
export const wikiDocsNotWrittenYet = (count: number): string =>
  `${plural(count, 'document', 'documents')} · ${WIKI_DOC_NOT_WRITTEN_SHORT}`;

/**
 * The line under the home's head: the confirmed plan's documents and how many are written; before a plan, the
 * topic articles the home lists in its place (`wikiArticleCount`); with neither, `No documents yet`.
 */
export function wikiHomeLine(directory: WikiDocsDirectory | null | undefined, articles: number): string {
  if (directory && wikiReadsByDocs(directory)) return wikiDocsWritten(directory.docs.total, directory.docs.written);
  return articles > 0 ? wikiArticleCount(articles) : WIKI_NO_DOCUMENTS;
}

/** A written document on the home: its number, title and lead, and whether it is new to the reader. */
export interface WikiHomeDoc {
  slug: string;
  number: string;
  title: string;
  /** Its two lines (`WIKI_DOC_LEAD_RULES`); null when the read carries none. */
  lead: string | null;
  /** A blue dot: written after the reader last looked at the home. */
  fresh: boolean;
}

/** One category of the home: its written documents, then the ones not written yet, which fold into one row. */
export interface WikiHomeCategory {
  key: string;
  number: number;
  title: string;
  written: WikiHomeDoc[];
  notWritten: Array<{ slug: string; number: string; title: string }>;
}

/**
 * The home's documents (design §12.3.1): the confirmed plan's categories in its order — a category with no
 * document left out, as the directory leaves it — each with its documents in the plan's order, the written
 * ones first. `seen` is when the reader last looked at the home (`wikiSeenKey(space, 'home')`): a document
 * written after it is new, and every written one is to a reader who has not looked before.
 */
export function wikiHomeCategories(directory: WikiDocsDirectory, seen: number): WikiHomeCategory[] {
  return directory.categories
    .filter((category) => category.docs.length > 0)
    .map((category) => ({
      key: category.key,
      number: category.number,
      title: category.title || category.key,
      written: category.docs
        .filter((doc) => doc.written)
        .map((doc) => ({
          slug: doc.slug,
          number: doc.number,
          title: doc.title || doc.slug,
          lead: doc.lead ?? null,
          fresh: seen <= 0 || (doc.updatedAt !== null && Date.parse(doc.updatedAt) > seen),
        })),
      notWritten: category.docs
        .filter((doc) => !doc.written)
        .map((doc) => ({ slug: doc.slug, number: doc.number, title: doc.title || doc.slug })),
    }));
}

/** A category's folded row: `+3 not written yet` under written ones, `3 documents · Not written yet` alone; none when all are written. */
export function wikiNotWrittenRow(category: Pick<WikiHomeCategory, 'written' | 'notWritten'>): string | null {
  if (category.notWritten.length === 0) return null;
  return category.written.length > 0 ? wikiNotWrittenYet(category.notWritten.length) : wikiDocsNotWrittenYet(category.notWritten.length);
}
