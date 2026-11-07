import {
  WIKI_RECHECK,
  WIKI_RECHECK_RANKS,
  type WikiHistoryAnswerEntry,
  type WikiRecheckRank,
  type WikiRecheckVerdict,
} from '@orbit/shared';
import { anchorGitPath } from '../wiki/wiki-anchors';
import { cutRunes, lastJSONObject } from './wiki-verify';

/**
 * What the claim recheck asks of an entry, and how it reads the answer (contracts/wiki.contract.json
 * `maintenance.job.server.recheck`, docs/wiki-claim-recheck-design.md): the pure half of the maintain job's
 * `recheck` step. Which paths an entry is about, what it talks about in code (its terms), how far back its first
 * screen looks, what a screen's answer ranks it, the one question the System model is asked, how its answer is
 * read, how two answers make a verdict, and what the challenge a verdict files says.
 *
 * WHY A CLAIM AND NOT AN ANCHOR. An anchor check says an entry's files are still there (`anchorStates.verified`),
 * never that what the entry says still holds: the sum_cache_read pitfall read verified, then confirmed, for a month
 * after the column it describes was dropped. This file reads what the entry says against the code instead, and
 * everything that could act on it waits for two agreeing answers, then for the owner.
 */

/** The parts of an entry the recheck reads. */
export interface WikiRecheckEntry {
  id: string;
  kind: string;
  title: string;
  summary: string;
  fields: Record<string, unknown>;
  anchors: ReadonlyArray<{ type?: unknown; path?: unknown }>;
  recordedAt: Date;
}

/**
 * The paths an entry is about (`recheck.scope`): its path and symbol anchors' paths, and a pitfall's
 * `fields.trigger.paths`, cleaned as the anchors step cleans a path, in order and once each.
 */
export function wikiClaimPaths(entry: Pick<WikiRecheckEntry, 'kind' | 'anchors' | 'fields'>): string[] {
  const out: string[] = [];
  const add = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const path = anchorGitPath(raw);
    if (path !== null && !out.includes(path)) out.push(path);
  };
  for (const anchor of entry.anchors) {
    if (anchor.type === 'path' || anchor.type === 'symbol') add(anchor.path);
  }
  if (entry.kind === 'pitfall') {
    const trigger = entry.fields.trigger;
    const paths = trigger !== null && typeof trigger === 'object' ? (trigger as { paths?: unknown }).paths : null;
    if (Array.isArray(paths)) for (const path of paths) add(path);
  }
  return out;
}

// ── Terms ───────────────────────────────────────────────────────────────────────────────────────

/** Words that are code in every file and name nothing an entry is about: SQL and the commonest English. */
const STOP = new Set(`about above after again against also among another because before being below between could does
doing during either every from have having into just like more most much must never only other over same should since
some such than that their them then there these they this those through under until upon very what when where which
while will with within would your true false null none undefined string number object array value values error errors
file files path paths line lines code test tests main branch commit commits session sessions entry entries change
changes changed using used uses select insert update delete where table alter create index unique primary foreign
references constraint check default begin rollback returning join inner outer left right group order limit offset
distinct`.split(/\s+/u));
const IDENT = /[A-Za-z_][A-Za-z0-9_]*(?:[.:/-][A-Za-z0-9_]+)*/gu;
const FILE_NAME = /\.(?:ts|tsx|js|cjs|mjs|go|swift|kt|kts|json|md|sql|prisma|sh|py|yml|yaml|toml|css|html)$/u;

/** Every text of an entry's fields, in their order, but a pitfall's `trigger.paths`. */
function fieldTexts(value: unknown, key: string | null, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) fieldTexts(item, key, out);
  else if (value !== null && typeof value === 'object') {
    for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'trigger' && name === 'paths') continue;
      fieldTexts(inner, name, out);
    }
  }
}

/** An identifier with an underscore inside it or a lowercase letter followed by a capital: `sum_cache_read`, `applyOp`. */
function isCodeIdentifier(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(token) && token.length >= 4
    && (/[A-Za-z0-9]_[A-Za-z0-9]/u.test(token) || /[a-z][A-Z]/u.test(token));
}

/** `IN_FLIGHT`, `OWNER_INTERACTIVE_ROUTES`: capitals, digits and underscores, four characters or more. */
function isUpperName(token: string): boolean {
  return /^[A-Z][A-Z0-9_]{3,}$/u.test(token);
}

/**
 * What an entry talks about in code (`recheck.terms`), at most `rules.termsMax`: identifiers with an underscore or an
 * inner capital, UPPER_CASE names, dotted names, names with two hyphens or more, spans in backticks with a space in
 * them, and a pitfall's `trigger.errorSignature` — in that order of kind, each kind in the order it first occurs. File
 * names of its own paths, common words and SQL keywords are left out.
 */
export function wikiRecheckTerms(entry: Pick<WikiRecheckEntry, 'kind' | 'title' | 'summary' | 'fields'>, paths: readonly string[]): string[] {
  const texts = [entry.title, entry.summary];
  fieldTexts(entry.fields, null, texts);
  const basenames = new Set(paths.map((path) => path.slice(path.lastIndexOf('/') + 1)));
  const code: string[] = [];
  const upper: string[] = [];
  const dotted: string[] = [];
  const hyphenated: string[] = [];
  const spans: string[] = [];
  const stopped = (token: string): boolean => STOP.has(token.toLowerCase()) || basenames.has(token);
  for (const text of texts) {
    for (const span of text.matchAll(/`([^`\n]{2,40})`/gu)) {
      const inner = span[1]!.trim();
      if (/\s/u.test(inner)) spans.push(inner);
    }
    for (const match of text.matchAll(IDENT)) {
      const token = match[0].replace(/[.:/-]+$/u, '');
      if (token.includes('/') || token.includes(':') || FILE_NAME.test(token) || stopped(token)) continue;
      if (token.includes('.')) {
        const parts = token.split('.');
        // `session.sum_*` is a glob, not a name: every part ends in a letter or a digit.
        if (parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*[A-Za-z0-9]$/u.test(part))) dotted.push(token);
        const last = parts[parts.length - 1]!;
        if (!stopped(last) && isCodeIdentifier(last)) code.push(last);
        continue;
      }
      if (token.includes('-')) {
        if ((token.match(/-/gu) ?? []).length >= 2 && token.length >= 8) hyphenated.push(token);
        continue;
      }
      if (isCodeIdentifier(token)) code.push(token);
      else if (isUpperName(token)) upper.push(token);
    }
  }
  const signature = entry.kind === 'pitfall' && entry.fields.trigger !== null && typeof entry.fields.trigger === 'object'
    ? (entry.fields.trigger as { errorSignature?: unknown }).errorSignature
    : null;
  const errors = typeof signature === 'string' && signature.trim().length >= 4 && signature.trim().length <= 200 ? [signature.trim()] : [];
  const out: string[] = [];
  for (const term of [...code, ...upper, ...dotted, ...hyphenated, ...spans, ...errors]) {
    if (!out.includes(term)) out.push(term);
    if (out.length === WIKI_RECHECK.termsMax) break;
  }
  return out;
}

// ── How far back, and what the screen found ─────────────────────────────────────────────────────

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * When the evidence an entry rests on was made (`recheck.screen.what`): the time in the UUIDv7 of its current
 * revision's earliest source record, when that is earlier than its recording, or the time it was recorded. A first
 * screen looks back to it, so a fix that landed between the incident and the writing is in front of the model.
 */
export function wikiEarliestSourceTime(sources: ReadonlyArray<{ ref: string }>, recordedAt: Date): Date {
  let best = recordedAt.getTime();
  for (const { ref } of sources) {
    if (!UUID_V7.test(ref)) continue;
    const at = Number.parseInt(ref.replaceAll('-', '').slice(0, 12), 16);
    if (Number.isFinite(at) && at < best) best = at;
  }
  return new Date(best);
}

/**
 * What a screen's answer ranks an entry (`recheck.screen.ranks`), or null when it shows nothing: 1 a term is in
 * none of its paths any more or one of its paths itself moved, 2 a term's line count changed, 3 only its paths
 * changed (or it has no terms and they did). An entry written within `rules.freshHours` with any of these is 0.
 */
export function wikiScreenRank(answer: WikiHistoryAnswerEntry, fresh: boolean): WikiRecheckRank | null {
  if (answer.error !== undefined) return null;
  const census = answer.census ?? [];
  let rank: WikiRecheckRank | null = null;
  if ((answer.moved ?? []).length > 0 || census.some((term) => term.base > 0 && term.head === 0)) rank = WIKI_RECHECK_RANKS.vanished;
  else if (census.some((term) => term.base !== term.head)) rank = WIKI_RECHECK_RANKS.census;
  else if (answer.changed === true) rank = WIKI_RECHECK_RANKS.touched;
  if (rank !== null && fresh) return WIKI_RECHECK_RANKS.fresh;
  return rank;
}

// ── The question ────────────────────────────────────────────────────────────────────────────────

/** The whole system prompt one recheck carries. */
export const WIKI_RECHECK_SYSTEM_PROMPT = 'You check whether an entry of a repository\'s wiki is still true of the repository\'s code. '
  + 'Judge only from the material given: the entry, the commits that changed its files, how often its terms occur, the lines '
  + 'that hold them now and the diff. Answer with one JSON object and nothing else.';

/** What the prompt reads besides the entry: the screen's base, the head, and the runner's detail for this entry. */
export interface WikiRecheckMaterial {
  paths: readonly string[];
  /** Why the base is the base: the entry's evidence or its last check. */
  baseIs: 'sources' | 'check';
  head: { sha: string; date: string };
  answer: WikiHistoryAnswerEntry;
}

function shortDate(iso: string | undefined): string {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : 'unknown';
}

function quoteTerm(term: string): string {
  return `"${term.replaceAll('"', '\\"')}"`;
}

/** The one question of one entry (`recheck.question`). Same entry and material, same bytes: the queue's identity. */
export function wikiRecheckPrompt(entry: WikiRecheckEntry, material: WikiRecheckMaterial): string {
  const { answer, head } = material;
  const fields = cutRunes(JSON.stringify(entry.fields), 4000);
  const commits = answer.commits ?? [];
  const census = answer.census ?? [];
  const lines = answer.lines ?? [];
  const out: string[] = [];
  out.push(`ENTRY (a ${entry.kind}, recorded ${entry.recordedAt.toISOString().slice(0, 10)})`);
  out.push(`Title: ${entry.title}`);
  out.push(`Summary: ${entry.summary}`);
  out.push(`Fields: ${fields}`);
  out.push('');
  out.push('FILES IT IS ABOUT');
  for (const path of material.paths) out.push(`- ${path}`);
  out.push('');
  out.push('MAIN THEN AND NOW');
  out.push(`Base: ${(answer.base ?? '').slice(0, 12)} (${shortDate(answer.baseDate)}), main as it was ${material.baseIs === 'sources' ? 'before the records this entry was written from' : 'when this entry was last checked'}.`);
  out.push(`Head: ${head.sha.slice(0, 12)} (${shortDate(head.date)}), main now.`);
  out.push('');
  out.push(`COMMITS THAT CHANGED THESE FILES SINCE THE BASE (${commits.length} of ${answer.commitsTotal ?? commits.length}, newest first; * marks one that changed how often a term occurs)`);
  if (commits.length === 0) out.push('(none)');
  // Where the entry was recorded falls between two commits: the ones below that line are the history it was written
  // from, and a pitfall's own fix is usually among them.
  const recorded = entry.recordedAt.getTime();
  let marked = false;
  for (const commit of commits) {
    const at = Date.parse(commit.date);
    if (!marked && Number.isFinite(at) && at < recorded) {
      out.push(`--- the entry was recorded here, on ${entry.recordedAt.toISOString().slice(0, 10)}: the commits below came before it ---`);
      marked = true;
    }
    out.push(`${commit.matched ? '*' : ' '} ${commit.sha.slice(0, 12)} ${shortDate(commit.date)} ${commit.subject}`);
  }
  out.push('');
  out.push('HOW OFTEN ITS TERMS OCCUR IN THESE FILES (lines at the base -> lines now)');
  if (census.length === 0) out.push('(no terms)');
  for (const term of census) out.push(`- ${quoteTerm(term.term)}: ${term.base} -> ${term.head}`);
  if ((answer.moved ?? []).length > 0) out.push(`Added, deleted or renamed since the base: ${(answer.moved ?? []).join(', ')}`);
  out.push('');
  out.push(`LINES THAT HOLD A TERM NOW (${lines.length} of ${answer.linesTotal ?? lines.length})`);
  if (lines.length === 0) out.push('(none)');
  for (const line of lines) out.push(`${line.path}:${line.line}: ${line.text}`);
  out.push('');
  out.push(`THE DIFF OF THESE FILES FROM THE BASE TO NOW (hunks that mention a term first${answer.diffTruncated ? '; cut' : ''})`);
  out.push(answer.diff && answer.diff.length > 0 ? answer.diff : '(no difference)');
  out.push('');
  out.push('QUESTION');
  out.push('Is what the entry says true of the code at the head commit, so that an agent who reads it today and acts on it would be right?');
  out.push('- "holds": yes, it is still true.');
  out.push('- "fixed": no, because a change removed the problem the entry warns about: it can no longer happen as the entry describes, and an agent who believed the entry would be misled. Give the commit that did it.');
  out.push('- "obsolete": no, because what the entry talks about is gone or was replaced, or the decision or convention no longer describes the code, without that being a fix of the problem. Give the commit that shows it, if one does.');
  out.push('- "unsure": the material shows a change to what the entry describes, but not enough to tell.');
  out.push('How to read the material:');
  out.push('- If a term the entry names as present or broken occurs in none of its files now (see the counts), the entry describes code that is gone: answer fixed or obsolete, even when the entry itself records that change.');
  out.push('- Otherwise, a pitfall that records its own fix (its fix field) holds while the code does what that fix says: the commit that applied it, usually one recorded before the entry, is not a reason to answer fixed. Answer fixed only when a change after the entry was recorded altered the behaviour it describes as current.');
  out.push('- A decision or a convention is obsolete when a commit after it was recorded does what it says not to do, or replaces what it decided.');
  out.push('- If nothing in the material changes what the entry describes, it holds.');
  out.push('Answer with exactly one JSON object: {"verdict": "holds" | "fixed" | "obsolete" | "unsure", "commit": "<the 12-character sha of a commit listed above, or null>", "reason": "<one sentence naming what in the material decides it>"}');
  return out.join('\n');
}

// ── The answer ──────────────────────────────────────────────────────────────────────────────────

/** One answer as read: an unreadable one, or a fixed that names no listed commit, is unsure. */
export interface WikiRecheckAnswer {
  verdict: WikiRecheckVerdict;
  commit: { sha: string; date: string; subject: string } | null;
  reason: string;
}

const VERDICTS: ReadonlySet<string> = new Set(['holds', 'fixed', 'obsolete', 'unsure']);

/** Read one answer against the commits the prompt listed (`recheck.question`). */
export function wikiParseRecheckAnswer(text: string, commits: WikiHistoryAnswerEntry['commits'] = []): WikiRecheckAnswer {
  const body = lastJSONObject(text);
  let parsed: unknown = null;
  if (body !== null) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { verdict: 'unsure', commit: null, reason: 'The answer held no JSON object.' };
  }
  const record = parsed as Record<string, unknown>;
  const said = typeof record.verdict === 'string' ? record.verdict.trim().toLowerCase() : '';
  const reason = typeof record.reason === 'string' ? cutRunes(record.reason.trim(), 300) : '';
  if (!VERDICTS.has(said)) return { verdict: 'unsure', commit: null, reason: `The answer's verdict was not one of the four: ${cutRunes(said, 40) || 'none'}.` };
  const verdict = said as WikiRecheckVerdict;
  const named = typeof record.commit === 'string' ? record.commit.trim().toLowerCase() : '';
  const listed = /^[0-9a-f]{7,40}$/u.test(named) ? (commits ?? []).find((commit) => commit.sha.startsWith(named)) ?? null : null;
  const commit = listed ? { sha: listed.sha, date: listed.date, subject: listed.subject } : null;
  if (verdict === 'fixed' && commit === null) {
    return { verdict: 'unsure', commit: null, reason: 'The answer said fixed but named no commit the material listed.' };
  }
  return { verdict, commit: verdict === 'fixed' || verdict === 'obsolete' ? commit : null, reason };
}

/** Whether an answer asks for a second one (`recheck.twoAsks`). */
export function wikiRecheckWantsSecond(first: WikiRecheckAnswer): boolean {
  return first.verdict === 'fixed' || first.verdict === 'obsolete';
}

/** Two answers, or one, make a verdict (`recheck.twoAsks`): a fixed or obsolete stands only when the second agrees. */
export function wikiDecideRecheck(first: WikiRecheckAnswer, second: WikiRecheckAnswer | null): WikiRecheckAnswer & { answers: WikiRecheckVerdict[] } {
  if (!wikiRecheckWantsSecond(first)) return { ...first, answers: [first.verdict] };
  if (second !== null && wikiRecheckWantsSecond(second)) return { ...first, answers: [first.verdict, second.verdict] };
  return {
    verdict: 'unsure',
    commit: null,
    reason: second === null
      ? `The first answer said ${first.verdict}; the second ask got no answer.`
      : `The first answer said ${first.verdict}, the second ${second.verdict}.`,
    answers: second === null ? [first.verdict] : [first.verdict, second.verdict],
  };
}

/** Whether the commit a fixed or obsolete verdict named is older than the entry's recording. */
export function wikiWrongWhenRecorded(commit: WikiRecheckAnswer['commit'], recordedAt: Date): boolean {
  if (commit === null) return false;
  const at = Date.parse(commit.date);
  return Number.isFinite(at) && at < recordedAt.getTime();
}

/** The reason of the challenge a fixed or obsolete verdict files (`recheck.effect.fixedOrObsolete`), for Review. */
export function wikiRecheckChallengeReason(input: {
  verdict: 'fixed' | 'obsolete';
  head: string;
  commit: WikiRecheckAnswer['commit'];
  reason: string;
  wrongWhenRecorded: boolean;
  recordedAt: Date;
}): string {
  const by = input.commit
    ? `${input.verdict === 'fixed' ? 'fixed by' : 'obsolete since'} ${input.commit.sha.slice(0, 12)} (${shortDate(input.commit.date)}, "${cutRunes(input.commit.subject, 160)}")`
    : 'obsolete';
  const parts = [`Claim recheck on origin/main at ${input.head.slice(0, 12)}: ${by}.`];
  if (input.reason) parts.push(input.reason.endsWith('.') ? input.reason : `${input.reason}.`);
  if (input.wrongWhenRecorded) parts.push(`It was already so before this entry was recorded on ${input.recordedAt.toISOString().slice(0, 10)}.`);
  parts.push('Agents stop finding this entry in search until it is retired, re-confirmed or amended. Proposed answer: Retire.');
  return cutRunes(parts.join(' '), 4000);
}
