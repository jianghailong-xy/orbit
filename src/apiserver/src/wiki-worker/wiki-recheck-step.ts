import { Prisma } from '@prisma/client';
import {
  WIKI_CLAIM_HIDDEN_STATES,
  WIKI_RECHECK,
  uuidToBase62,
  type WikiClaimCheck,
  type WikiHistoryAnswer,
  type WikiHistoryAnswerEntry,
  type WikiHistoryRequestEntry,
  type WikiMaintainRecheckReport,
} from '@orbit/shared';
import { anchorDiffNames } from '../wiki/wiki-anchors';
import type { WikiService } from '../wiki/wiki.service';
import { isWikiJobCancellation } from './wiki-job-executor';
import { wikiMaintainParallel } from './wiki-maintain';
import type { WikiRepoOpWait } from './wiki-repo-ops';
import {
  WIKI_RECHECK_SYSTEM_PROMPT,
  wikiClaimPaths,
  wikiDecideRecheck,
  wikiEarliestSourceTime,
  wikiParseRecheckAnswer,
  wikiRecheckChallengeReason,
  wikiRecheckPrompt,
  wikiRecheckTerms,
  wikiRecheckWantsSecond,
  wikiScreenRank,
  wikiWrongWhenRecorded,
  type WikiRecheckAnswer,
  type WikiRecheckEntry,
} from './wiki-recheck';

/**
 * The maintain job's `recheck` step (contract `maintenance.job.server.recheck`, docs/wiki-claim-recheck-design.md):
 * the screen, which costs no model call, and the asks, at most `rules.asksMax` a run.
 *
 * THE SCREEN. The space's last screen stopped at `wiki_space.claim_recheck_ref`; the run diffs main from there to
 * its own commit (the `diff` operation) and screens every entry in scope that names a path in that diff, from that
 * commit. An entry never screened is screened from its earliest source instead, the newest `rules.screenMax` a run.
 * The `history` operation counts the lines of the entry's paths that hold each of its terms at both ends, and names
 * the paths themselves that moved; `wikiScreenRank` turns that into a rank, and `recordClaimScreen` puts the ranked
 * entries in the due queue and moves the space's screen to this commit — only once the screen is written, so a run
 * that stops before it screens the same range again.
 *
 * THE ASKS. The queue's top — the lowest rank, then the entries agents read most, then the longest due, none asked
 * within `rules.askIntervalDays` — gets the `history` operation's detail from its last check (or its earliest
 * source) to this commit, and one question each through the request queue, a second for a fixed or obsolete answer.
 * `recordClaimChecks` writes the verdicts and files the challenges.
 *
 * IT NEVER FAILS THE RUN. A runner that does not know the operation, an operation that fails, a model that cannot
 * answer: the step stops where it is, says why in `skipped`, and leaves the queue to the next run. Only a stopping
 * worker's cancellation goes through.
 */

export interface WikiRecheckStepDeps {
  prisma: Pick<Prisma.TransactionClient, '$queryRaw'>;
  wiki: Pick<WikiService, 'recordClaimChecks' | 'recordClaimScreen'>;
  ownerId: string;
  spaceId: string;
  jobId: string;
  /** The run's snapshot commit, and every commit it reaches. */
  head: string;
  reaches: ReadonlySet<string>;
  operation(kind: 'diff' | 'history', input: Record<string, unknown>, what: string): Promise<WikiRepoOpWait>;
  /**
   * The names a diff from `from` to `head` gives, every directory above each included (`anchorDiffNames(...).any`),
   * when the run already has that diff — the anchors step's, from the commit most anchors were checked at, which is
   * the previous run's as a rule — or null, and the step asks for its own.
   */
  knownDiff?(from: string): ReadonlySet<string> | null;
  /** One question under `unit`, step `recheck`: the model's text. */
  ask(unit: string, system: string, prompt: string, maxTokens: number): Promise<string>;
  log(line: string): void;
  signal: AbortSignal;
  now?: () => Date;
  /** What an earlier attempt of this run carried (contract `jobs.carry`), and how this one carries its own. */
  earlier?: WikiRecheckCarry | null;
  keep?(carry: WikiRecheckCarry): Promise<void>;
}

/**
 * The step's part of the run's carry: its report once the screen is written, and again once the asks are. A replay
 * on the same commit takes it from there — a finished step is not run again, a screened one goes on to its asks — so
 * the report stays the whole run's. The asks write their verdicts together, so a stop before that write is replayed
 * whole from the queue's answers; only a stop between that write and the carry would leave the replay's counts short.
 */
export interface WikiRecheckCarry {
  report: WikiMaintainRecheckReport;
  phase: 'screened' | 'asked';
}

interface ScopeRow {
  id: string;
  kind: string;
  recordedAt: Date;
  revision: number;
  anchors: unknown;
  triggerPaths: unknown;
  claimState: string;
  claimScreenedAt: Date | null;
  claimCheckedRef: string | null;
}

interface TextRow {
  id: string;
  kind: string;
  title: string;
  summary: string;
  fields: unknown;
  anchors: unknown;
  recordedAt: Date;
  revision: number;
  claimState: string;
  claimCheckedRef: string | null;
  sources: Array<{ ref: string }> | null;
}

/** Why the step stopped, as a line: the first line of what was thrown, at most 300 characters. */
function why(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]!.slice(0, 300);
}

function emptyReport(head: string): WikiMaintainRecheckReport {
  return { head, from: null, screened: 0, ranked: { '0': 0, '1': 0, '2': 0, '3': 0 }, asked: 0, calls: 0, holds: 0, fixed: 0, obsolete: 0, unsure: 0, due: 0, skipped: null };
}

/** The `history` operation's answer, by entry id; an answer that does not have its shape is none. */
function historyOf(settled: WikiRepoOpWait): WikiHistoryAnswer | null {
  const answer = settled.result?.history as WikiHistoryAnswer | undefined;
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.entries)) return null;
  return answer;
}

export async function runWikiRecheck(deps: WikiRecheckStepDeps): Promise<WikiMaintainRecheckReport> {
  const earlier = deps.earlier && deps.earlier.report.head === deps.head ? deps.earlier : null;
  if (earlier?.phase === 'asked') return earlier.report;
  const report: WikiMaintainRecheckReport = earlier ? { ...earlier.report, ranked: { ...earlier.report.ranked } } : emptyReport(deps.head);
  try {
    if (earlier === null) {
      await screen(deps, report);
      if (report.skipped === null) await deps.keep?.({ report: { ...report, ranked: { ...report.ranked } }, phase: 'screened' });
    }
    if (report.skipped === null) await askTheQueue(deps, report);
  } catch (error) {
    if (isWikiJobCancellation(error, deps.signal)) throw error;
    report.skipped = why(error);
  }
  try {
    report.due = await dueCount(deps);
  } catch (error) {
    if (isWikiJobCancellation(error, deps.signal)) throw error;
  }
  await deps.keep?.({ report: { ...report, ranked: { ...report.ranked } }, phase: 'asked' });
  deps.log(`claim recheck at ${deps.head.slice(0, 12)}: screened ${report.screened} entr(ies) (ranks 0/1/2/3: `
    + `${report.ranked['0']}/${report.ranked['1']}/${report.ranked['2']}/${report.ranked['3']}), asked ${report.asked} in `
    + `${report.calls} call(s): ${report.holds} hold, ${report.fixed} fixed, ${report.obsolete} obsolete, ${report.unsure} unsure; `
    + `${report.due} still due${report.skipped ? `; stopped: ${report.skipped}` : ''}`);
  return report;
}

// ── The screen ──────────────────────────────────────────────────────────────────────────────────

async function screen(deps: WikiRecheckStepDeps, report: WikiMaintainRecheckReport): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const [space] = await deps.prisma.$queryRaw<Array<{ ref: string | null }>>`
    SELECT "claim_recheck_ref" AS ref FROM "wiki_space" WHERE "id" = ${deps.spaceId}::uuid AND "owner_id" = ${deps.ownerId}::uuid`;
  const from = space?.ref ?? null;
  report.from = from;
  const scope = await deps.prisma.$queryRaw<ScopeRow[]>`
    SELECT e."id"::text AS id, e."kind", e."recorded_at" AS "recordedAt", e."current_revision" AS revision, e."anchors",
           e."fields"->'trigger'->'paths' AS "triggerPaths", e."claim_state" AS "claimState",
           e."claim_screened_at" AS "claimScreenedAt", e."claim_checked_ref" AS "claimCheckedRef"
      FROM "wiki_entry" e
     WHERE e."space_id" = ${deps.spaceId}::uuid AND e."owner_id" = ${deps.ownerId}::uuid AND e."status" = 'active'
       AND e."kind" = ANY(${[...WIKI_RECHECK.kinds]}::text[])
       AND NOT (e."claim_state" = ANY(${[...WIKI_CLAIM_HIDDEN_STATES]}::text[]))`;
  const pathsOf = new Map<string, string[]>();
  for (const row of scope) {
    const paths = wikiClaimPaths({
      kind: row.kind,
      anchors: Array.isArray(row.anchors) ? (row.anchors as Array<{ type?: unknown; path?: unknown }>) : [],
      fields: { trigger: { paths: row.triggerPaths } },
    });
    if (paths.length > 0) pathsOf.set(row.id, paths);
  }
  const inScope = scope.filter((row) => pathsOf.has(row.id));

  // The touched entries: what the run's commits changed since the space's last screen.
  let touched: ScopeRow[] = [];
  if (from !== null && from !== deps.head) {
    if (!deps.reaches.has(from)) {
      deps.log(`claim recheck: the last screen's commit ${from.slice(0, 12)} is not on main any more; nothing is screened as touched`);
    } else {
      // Every name the diff gives with every directory above it: a path the entry names is touched when it is in it.
      let names = deps.knownDiff?.(from) ?? null;
      if (names === null) {
        const settled = await deps.operation('diff', { from, to: deps.head }, `the claim screen's diff ${from.slice(0, 12)}..${deps.head.slice(0, 12)}`);
        if (settled.state !== 'succeeded') {
          report.skipped = `the diff ${settled.state}: ${settled.error ?? ''}`.trim();
          return;
        }
        const files = ((settled.result?.diff as { files?: Array<{ status?: string; path?: string; from?: string | null }> } | undefined)?.files) ?? [];
        names = anchorDiffNames(files.map((file) => ({ status: String(file.status ?? ''), path: String(file.path ?? ''), from: file.from ?? null }))).any;
      }
      const changed = names;
      touched = inScope.filter((row) => pathsOf.get(row.id)!.some((path) => changed.has(path)));
    }
  }
  const touchedIds = new Set(touched.map((row) => row.id));
  const fresh = inScope
    .filter((row) => row.claimScreenedAt === null && !touchedIds.has(row.id))
    .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime() || (a.id < b.id ? -1 : 1))
    .slice(0, WIKI_RECHECK.screenMax);
  const toScreen = [...touched, ...fresh];
  if (toScreen.length === 0) {
    await deps.wiki.recordClaimScreen({ ownerId: deps.ownerId }, deps.spaceId, { ref: deps.head, screened: [], ranked: [] });
    return;
  }
  const texts = await textsOf(deps, toScreen.map((row) => row.id));
  const requests: WikiHistoryRequestEntry[] = [];
  for (const row of toScreen) {
    const text = texts.get(row.id);
    if (!text) continue;
    const paths = pathsOf.get(row.id)!;
    const terms = wikiRecheckTerms({ kind: text.kind, title: text.title, summary: text.summary, fields: asFields(text.fields) }, paths);
    // A first screen looks back to the entry's evidence; one the run's diff touched looks at the run's range.
    const first = row.claimScreenedAt === null;
    requests.push(first
      ? { id: row.id, since: wikiEarliestSourceTime(text.sources ?? [], text.recordedAt).toISOString(), paths, terms, detail: false }
      : { id: row.id, from: from!, paths, terms, detail: false });
  }
  const screened: string[] = [];
  const ranked: Array<{ entryId: string; rank: number }> = [];
  const freshSince = now.getTime() - WIKI_RECHECK.freshHours * 3600 * 1000;
  for (let at = 0; at < requests.length; at += WIKI_RECHECK.screenOpMax) {
    const chunk = requests.slice(at, at + WIKI_RECHECK.screenOpMax);
    const settled = await deps.operation('history', { to: deps.head, entries: chunk }, `the claim screen of ${chunk.length} entr(ies)`);
    const answer = settled.state === 'succeeded' ? historyOf(settled) : null;
    if (answer === null) {
      report.skipped = `the history operation ${settled.state}: ${settled.error ?? 'its answer had no entries'}`.trim();
      return;
    }
    for (const entry of answer.entries) {
      if (entry.error !== undefined) continue;
      const row = texts.get(entry.id);
      if (!row) continue;
      screened.push(entry.id);
      const rank = wikiScreenRank(entry, row.recordedAt.getTime() >= freshSince);
      if (rank === null) continue;
      ranked.push({ entryId: entry.id, rank });
      report.ranked[String(rank) as '0' | '1' | '2' | '3'] += 1;
    }
  }
  report.screened = screened.length;
  await deps.wiki.recordClaimScreen({ ownerId: deps.ownerId }, deps.spaceId, { ref: deps.head, screened, ranked });
}

function asFields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The entries' text, and their current revision's source refs, for the terms and the look-back. */
async function textsOf(deps: WikiRecheckStepDeps, ids: readonly string[]): Promise<Map<string, TextRow>> {
  const out = new Map<string, TextRow>();
  for (let at = 0; at < ids.length; at += 500) {
    const chunk = ids.slice(at, at + 500);
    const rows = await deps.prisma.$queryRaw<TextRow[]>`
      SELECT e."id"::text AS id, e."kind", e."title", e."summary", e."fields", e."anchors", e."recorded_at" AS "recordedAt",
             e."current_revision" AS revision, e."claim_state" AS "claimState", e."claim_checked_ref" AS "claimCheckedRef",
             (SELECT json_agg(json_build_object('ref', s."ref"))
                FROM "wiki_entry_revision" r JOIN "wiki_source" s ON s."revision_id" = r."id" AND s."owner_id" = r."owner_id"
               WHERE r."entry_id" = e."id" AND r."owner_id" = e."owner_id" AND r."revision" = e."current_revision") AS sources
        FROM "wiki_entry" e
       WHERE e."id" = ANY(${[...chunk]}::uuid[]) AND e."owner_id" = ${deps.ownerId}::uuid`;
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

// ── The asks ────────────────────────────────────────────────────────────────────────────────────

async function askTheQueue(deps: WikiRecheckStepDeps, report: WikiMaintainRecheckReport): Promise<void> {
  const top = await deps.prisma.$queryRaw<Array<{ id: string }>>`
    SELECT e."id"::text AS id
      FROM "wiki_entry" e
     WHERE e."space_id" = ${deps.spaceId}::uuid AND e."owner_id" = ${deps.ownerId}::uuid AND e."status" = 'active'
       AND e."claim_due_at" IS NOT NULL
       AND e."kind" = ANY(${[...WIKI_RECHECK.kinds]}::text[])
       AND NOT (e."claim_state" = ANY(${[...WIKI_CLAIM_HIDDEN_STATES]}::text[]))
       AND (e."claim_checked_at" IS NULL OR e."claim_checked_at" < now() - make_interval(days => ${WIKI_RECHECK.askIntervalDays}::int))
     ORDER BY e."claim_due_rank",
              COALESCE((e."stats"->>'searchHits')::int, 0) + COALESCE((e."stats"->>'gets')::int, 0) DESC,
              e."claim_due_at", e."id"
     LIMIT ${WIKI_RECHECK.asksMax}::int`;
  if (top.length === 0) return;
  const texts = await textsOf(deps, top.map((row) => row.id));
  const entries: WikiRecheckEntry[] = [];
  const requests: WikiHistoryRequestEntry[] = [];
  const pathsOf = new Map<string, string[]>();
  const baseIs = new Map<string, 'sources' | 'check'>();
  for (const { id } of top) {
    const row = texts.get(id);
    if (!row) continue;
    const entry: WikiRecheckEntry = {
      id: row.id, kind: row.kind, title: row.title, summary: row.summary, fields: asFields(row.fields),
      anchors: Array.isArray(row.anchors) ? (row.anchors as Array<{ type?: unknown; path?: unknown }>) : [], recordedAt: row.recordedAt,
    };
    const paths = wikiClaimPaths(entry);
    if (paths.length === 0) continue;
    const terms = wikiRecheckTerms(entry, paths);
    // Asked before: the material runs from that ask's commit. Never asked, or asked on a commit main no longer
    // reaches: from the entry's evidence.
    const checked = row.claimState !== 'unchecked' && row.claimCheckedRef !== null && deps.reaches.has(row.claimCheckedRef);
    requests.push(checked
      ? { id, from: row.claimCheckedRef!, paths, terms, detail: true }
      : { id, since: wikiEarliestSourceTime(row.sources ?? [], row.recordedAt).toISOString(), paths, terms, detail: true });
    baseIs.set(id, checked ? 'check' : 'sources');
    pathsOf.set(id, paths);
    entries.push(entry);
  }
  if (requests.length === 0) return;
  const settled = await deps.operation('history', { to: deps.head, entries: requests }, `the claim detail of ${requests.length} entr(ies)`);
  const answer = settled.state === 'succeeded' ? historyOf(settled) : null;
  if (answer === null) {
    report.skipped = `the history operation ${settled.state}: ${settled.error ?? 'its answer had no entries'}`.trim();
    return;
  }
  const byId = new Map<string, WikiHistoryAnswerEntry>(answer.entries.map((entry) => [entry.id, entry]));
  const verdicts: Array<{ entryId: string; revision: number; check: WikiClaimCheck; challengeReason: string | null } | null> = new Array(entries.length).fill(null);
  const halt: { reason: string | null } = { reason: null };
  const failure = await wikiMaintainParallel(entries.length, 4, async (i) => {
    const entry = entries[i]!;
    const detail = byId.get(entry.id);
    if (!detail || detail.error !== undefined || halt.reason !== null) return;
    const prompt = wikiRecheckPrompt(entry, { paths: pathsOf.get(entry.id)!, baseIs: baseIs.get(entry.id)!, head: { sha: answer.sha, date: answer.date }, answer: detail });
    let first: WikiRecheckAnswer;
    let second: WikiRecheckAnswer | null = null;
    try {
      first = wikiParseRecheckAnswer(await deps.ask(entry.id, WIKI_RECHECK_SYSTEM_PROMPT, prompt, WIKI_RECHECK.maxTokens), detail.commits);
      report.calls += 1;
      if (wikiRecheckWantsSecond(first)) {
        second = wikiParseRecheckAnswer(await deps.ask(`${entry.id}#second`, WIKI_RECHECK_SYSTEM_PROMPT, prompt, WIKI_RECHECK.maxTokens), detail.commits);
        report.calls += 1;
      }
    } catch (error) {
      if (isWikiJobCancellation(error, deps.signal)) throw error;
      // A model that cannot answer leaves the entry due, and the rest for the next run.
      halt.reason ??= `the model: ${why(error)}`;
      return;
    }
    const decided = wikiDecideRecheck(first, second);
    const row = texts.get(entry.id)!;
    const wrongWhenRecorded = (decided.verdict === 'fixed' || decided.verdict === 'obsolete') && wikiWrongWhenRecorded(decided.commit, entry.recordedAt);
    const check: WikiClaimCheck = {
      verdict: decided.verdict,
      ref: deps.head,
      base: detail.base ?? '',
      commit: decided.commit,
      reason: decided.reason,
      wrongWhenRecorded,
      answers: decided.answers,
    };
    const challengeReason = decided.verdict === 'fixed' || decided.verdict === 'obsolete'
      ? wikiRecheckChallengeReason({ verdict: decided.verdict, head: deps.head, commit: decided.commit, reason: decided.reason, wrongWhenRecorded, recordedAt: entry.recordedAt })
      : null;
    verdicts[i] = { entryId: entry.id, revision: row.revision, check, challengeReason };
  });
  if (failure !== null) throw failure;
  const written = verdicts.filter((verdict): verdict is NonNullable<typeof verdict> => verdict !== null);
  report.asked = written.length;
  if (written.length > 0) {
    const recorded = await deps.wiki.recordClaimChecks({ ownerId: deps.ownerId, jobId: deps.jobId }, deps.spaceId, { ref: deps.head, entries: written });
    for (const outcome of recorded.outcomes) {
      if (outcome.status !== 'recorded' || outcome.claimState === null || outcome.claimState === 'unchecked') continue;
      report[outcome.claimState] += 1;
    }
    const challenged = recorded.outcomes.filter((outcome) => outcome.challengeOpId !== null).map((outcome) => uuidToBase62(outcome.entryId));
    if (challenged.length > 0) deps.log(`claim recheck filed a challenge on ${challenged.join(', ')}`);
  }
  if (halt.reason !== null) report.skipped = halt.reason;
}

async function dueCount(deps: WikiRecheckStepDeps): Promise<number> {
  const [row] = await deps.prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "wiki_entry"
     WHERE "space_id" = ${deps.spaceId}::uuid AND "owner_id" = ${deps.ownerId}::uuid AND "status" = 'active' AND "claim_due_at" IS NOT NULL`;
  return row?.n ?? 0;
}
