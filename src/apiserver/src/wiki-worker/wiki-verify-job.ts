import { NotFoundException } from '@nestjs/common';
import { WIKI_REVIEW_RULES, type WikiVerificationItem } from '@orbit/shared';
import { WikiRefusalError, type WikiPrincipal, type WikiService } from '../wiki/wiki.service';
import { WikiJobContentError, type WikiJobContext, type WikiJobRunner } from './wiki-job-executor';
import {
  WIKI_VERIFY_SYSTEM_PROMPT,
  parseWikiVerdict,
  wikiVerifyCandidates,
  wikiVerifyPrompt,
  wikiVerifyRetrySuffix,
} from './wiki-verify';

/**
 * The `verify` job (contracts/wiki.contract.json `jobs.kindRuns.verify`, design §2.2 and §8): what a session
 * proposed into an Automatic space waiting for its verdict is verified by the server's worker instead of by
 * `orbit wiki verify` in the session — the same question, the same evidence, the same write path, and the
 * System model in place of the session's provider.
 *
 * WHAT IT DOES, IN THE ORDER OF THE RUNNER'S OWN VERIFIER. It reads its session's waiting ops from the
 * verification list (the same `WikiService.listVerifications` the runner door answers with, so the evidence is
 * the server's own: each record's text read now, redacted, cut — `wiki-verify-evidence.ts`), builds the one-op
 * prompt, asks the System model through the request queue — one request per op, identified by the op's id, so
 * a replayed job reuses the answers it already has — and reports each verdict the moment it is read
 * (`WikiService.recordVerifications`, the one writer of a verdict, which also applies it and leaves the trail).
 *
 * A VERDICT THAT CANNOT BE READ IS REPORTED AS NOTHING. The answer is parsed as strictly as the runner parses
 * it, and what the parse refuses is not a failure of the run: the op is counted as one left without a verdict,
 * the report names why, and the job goes on — it succeeds, because the ops that did get verdicts are the work's
 * result. That is the 09-30 lesson the runner's command already carries (one op in eighty-nine without a verdict
 * failed every run): those ops keep waiting, and the next job (or P8's maintenance pass) asks again.
 *
 * WHO IT IS. The job is not a session, and it writes as none: the principal it records verdicts with names the
 * *proposing* session — the ops a verdict is allowed to reach are exactly that session's, by the same rule the
 * runner door applies — and its writes say `system`, because the server made them on its own account. The
 * second pass over what a first pass left without a verdict, and the adoption of ended sessions' ops
 * (`verification.adoption`), are {@link verifyWikiOps}'s options: P8's maintenance run calls this with them.
 */

/** What the verify job is, in the numbers one call and one page take. */
export const WIKI_VERIFY_JOB = {
  /** The step every request of this job is filed under; the pair (step, unit) is a request's identity. */
  step: 'verify',
  /** One verdict is a small JSON object — a sentence of reason, and a number for a duplicate. */
  maxTokens: 1024,
  /** A page of the verification list, as big as the server grants (`rules.verificationListMax`). */
  pageSize: WIKI_REVIEW_RULES.verificationListMax,
} as const;

/** A verify job's input, as its `input` column holds it. */
export interface WikiVerifyJobInput {
  /** The session whose waiting ops it verifies — the identity a verdict has to be reported under. */
  sessionId: string;
}

/** The job's input, checked: a job that names no session could never find an op to verify. */
export function wikiVerifyJobInput(input: Record<string, unknown>): WikiVerifyJobInput {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (sessionId === '') {
    throw new WikiJobContentError("a verify job's input names the session whose ops it verifies (sessionId), and this one names none");
  }
  return { sessionId };
}

/** Whose ops one pass verifies, and how strictly. */
export interface WikiVerifyTarget {
  /**
   * The proposing session whose ops wait for their verdict. Null for the server's own maintenance run
   * (P8): its ops were proposed under the wiki job, and {@link jobId} is what names them.
   */
  sessionId: string | null;
  /** The wiki job a server-run maintenance pass verifies under; null for a session's. */
  jobId?: string | null;
  /**
   * The adoption door (contract `reviewModes.verification.adoption`, P8): the ops of the space's *ended*
   * sessions, whose proposing session nobody is left to run a verifier in.
   */
  adopt?: boolean;
  /** Verify at most this many ops; 0 or undefined is every one of them. */
  max?: number;
  /**
   * Why the model's answer about an op was not a verdict in an earlier pass, by op id: the pass asks about
   * those ops again with the prompt saying so and the numbers duplicateOf may be (contract
   * `maintenance.job.run.steps`, verify).
   */
  refused?: ReadonlyMap<string, string> | null;
}

/** What one pass did, as the job's report holds it (the runner's own summary, `--json`'s shape). */
export interface WikiVerifyReport {
  spaceId: string;
  /** The space's mode as the list answered it; a pass stops when it is no longer `automatic`. */
  mode: string;
  model: string;
  looked: number;
  verified: number;
  supported: number;
  partial: number;
  unsupported: number;
  duplicate: number;
  /** Ops left without a verdict: they keep waiting, and the next pass asks again. */
  failed: number;
  failures: Array<{ opId: string; why: string; refused: string }>;
  /** Why the pass stopped before the list ran out, or null when it read the whole list. */
  stopped: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * The principal a verification is recorded as: the proposing session's, or — for the server's own
 * maintenance run — the wiki job's, with the write marked the server's either way.
 */
export function wikiVerifyPrincipal(ownerId: string, sessionId: string | null, jobId: string | null = null): WikiPrincipal {
  return { origin: 'agent', ownerId, userId: null, sessionId, toolCallId: null, authorKind: 'system', jobId };
}

/**
 * Verify the ops {@link WikiVerifyTarget} names, page by page, reporting each verdict as soon as it is read.
 * The model calls and the retry suffix are the runner's, verbatim; `context.ask` is the queue, so each op's
 * request is a breakpoint of the job.
 */
export async function verifyWikiOps(
  context: WikiJobContext,
  wiki: WikiService,
  model: string,
  target: WikiVerifyTarget,
): Promise<WikiVerifyReport> {
  const report: WikiVerifyReport = {
    spaceId: context.job.spaceId,
    mode: '',
    model,
    looked: 0,
    verified: 0,
    supported: 0,
    partial: 0,
    unsupported: 0,
    duplicate: 0,
    failed: 0,
    failures: [],
    stopped: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const principal = wikiVerifyPrincipal(context.job.ownerId, target.sessionId, target.jobId ?? null);
  const max = target.max ?? 0;
  let after: string | null = null;
  for (;;) {
    const page = await readPage(wiki, principal, context.job.spaceId, after, target.adopt === true);
    report.mode = page.mode;
    if (page.mode !== 'automatic') {
      if (page.items.length > 0) {
        report.stopped = `the space is ${page.mode} now, not automatic: its ops keep waiting for their `
          + 'verification until the owner makes it automatic again';
      }
      return report;
    }
    for (const item of page.items) {
      if (max > 0 && report.looked >= max) return report;
      report.looked += 1;
      const stop = await verifyOneOp(context, wiki, principal, model, item, target.refused?.get(item.opId) ?? '', report);
      if (stop) return report;
    }
    if (page.next === null) return report;
    after = page.next;
  }
}

/**
 * Ask about one op and report what the model said. `refused` is why its last answer was not a verdict, when an
 * earlier pass asked: the prompt says so, and names the numbers a duplicate may give. Answers whether the pass
 * must stop — the server says the space left Automatic, and nothing after that would be recorded.
 */
async function verifyOneOp(
  context: WikiJobContext,
  wiki: WikiService,
  principal: WikiPrincipal,
  model: string,
  item: WikiVerificationItem,
  refused: string,
  report: WikiVerifyReport,
): Promise<boolean> {
  const candidates = wikiVerifyCandidates(item);
  let prompt = wikiVerifyPrompt(item, candidates);
  if (refused !== '') prompt += wikiVerifyRetrySuffix(refused, candidates);
  const fail = (why: string, answerRefused = ''): void => {
    report.failed += 1;
    report.failures.push({ opId: item.opId, why, refused: answerRefused });
    context.log(`op ${item.opId} (${item.entry.title}): no verdict — ${why}`);
  };
  let answer: string;
  try {
    const settled = await context.ask(WIKI_VERIFY_JOB.step, item.opId, {
      system: WIKI_VERIFY_SYSTEM_PROMPT,
      prompt,
      maxTokens: WIKI_VERIFY_JOB.maxTokens,
    });
    report.usage.inputTokens += settled.inputTokens ?? 0;
    report.usage.outputTokens += settled.outputTokens ?? 0;
    answer = settled.answer ?? '';
  } catch (error) {
    if (!(error instanceof WikiJobContentError)) throw error;
    // One op's call that ended for a reason of its own is that op's failure, not the pass's: the runner's
    // verifier goes on to the next op the same way, and what could not be answered keeps waiting.
    fail(error.message);
    return false;
  }
  const parsed = parseWikiVerdict(answer, candidates);
  if ('refusal' in parsed) {
    fail(`the model's answer is not a verdict (${parsed.refusal}), so nothing was reported`, parsed.refusal);
    return false;
  }
  const verdict = {
    opId: item.opId,
    verdict: parsed.verdict.verdict,
    reason: parsed.verdict.reason,
    model,
    ...(parsed.verdict.duplicateOf === null ? {} : { duplicateOf: parsed.verdict.duplicateOf }),
  };
  const done = await writeVerdict(wiki, principal, context.job.spaceId, verdict);
  const outcome = done.outcomes[0];
  if (!outcome) {
    fail('the server recorded nothing for it');
    return false;
  }
  if (outcome.status === 'refused') {
    const message = 'message' in outcome && typeof outcome.message === 'string' ? outcome.message : '';
    if (done.mode !== 'automatic') {
      report.mode = done.mode;
      report.stopped = `the space is ${done.mode} now, not automatic: the rest keep waiting for their `
        + 'verification until the owner makes it automatic again';
      context.log(`op ${item.opId}: ${verdict.verdict} verdict not recorded — ${message}`);
      return true;
    }
    fail(`the server refused the verdict: ${message}`);
    return false;
  }
  report.verified += 1;
  countVerdict(report, parsed.verdict.verdict);
  context.log(`op ${item.opId} (${item.entry.title}): ${verdict.verdict} — ${describeWikiVerdictOutcome(outcome, parsed.verdict)}`);
  if (done.mode !== 'automatic') {
    // This verdict was the one that sent the space back to Tiered: nothing after it is recorded.
    report.mode = done.mode;
    report.stopped = `this pass's verdicts sent the space back to ${done.mode} (too many of the latest were `
      + 'unsupported): the owner has been told, and the rest keep waiting';
    return true;
  }
  return false;
}

/** One page of the verification list, the space being read with the proposer's identity the verdict needs. */
async function readPage(
  wiki: WikiService,
  principal: WikiPrincipal,
  spaceId: string,
  after: string | null,
  adopt: boolean,
): Promise<{ mode: string; items: WikiVerificationItem[]; next: string | null }> {
  try {
    const page = await wiki.listVerifications(principal, spaceId, { after, limit: WIKI_VERIFY_JOB.pageSize, adopt });
    return { mode: page.mode, items: page.items, next: page.next };
  } catch (error) {
    throw asContent(error, 'the verification list could not be read');
  }
}

/** Record one verdict through the server's own writer, and answer what it did. */
async function writeVerdict(
  wiki: WikiService,
  principal: WikiPrincipal,
  spaceId: string,
  verdict: Record<string, unknown>,
): Promise<Awaited<ReturnType<WikiService['recordVerifications']>>> {
  try {
    return await wiki.recordVerifications(principal, spaceId, [verdict]);
  } catch (error) {
    throw asContent(error, 'the verdict could not be recorded');
  }
}

/** A refusal of the server's (no such space, no such op) is the work's: the job ends rather than retrying. */
function asContent(error: unknown, what: string): Error {
  if (error instanceof WikiRefusalError || error instanceof NotFoundException) {
    return new WikiJobContentError(`${what}: ${error.message}`);
  }
  return error as Error;
}

/** One verdict, counted into the report's own tallies. */
function countVerdict(report: WikiVerifyReport, verdict: string): void {
  switch (verdict) {
    case 'supported':
      report.supported += 1;
      return;
    case 'partial':
      report.partial += 1;
      return;
    case 'unsupported':
      report.unsupported += 1;
      return;
    default:
      report.duplicate += 1;
  }
}

/**
 * What the server did with one verdict, as the runner's own progress line reads it (Go
 * `describeWikiVerdictOutcome`). An adopted add whose very content a later op made live is that entry's
 * duplicate whatever the verdict said, and the line names the entry the server found.
 */
export function describeWikiVerdictOutcome(
  outcome: WikiVerificationOutcomeLike,
  verdict: { verdict: string; reason: string; duplicateOf: string | null },
): string {
  switch (outcome.status) {
    case 'applied': {
      let line = outcome.trust === 'auto' ? 'applied as Auto, and pushed' : 'applied as Unreviewed: shown, never pushed';
      if (outcome.spotCheck === true) line += '; drawn as a spot check for the owner';
      return line;
    }
    case 'rejected':
      return `rejected: ${verdict.reason}`;
    case 'reinforced': {
      let of = verdict.duplicateOf;
      if (of === null) of = `the live entry ${outcome.entryId ?? ''}, which holds its very content`;
      if (outcome.reinforced === false) return `a duplicate of ${of}; the space reviews every reinforce, so its sources were not added`;
      return `a duplicate of ${of}: its sources were added there`;
    }
    case 'conflict':
      return "nothing applied: its entry moved, or passed into the owner's hands, since it was proposed";
    default:
      return outcome.status;
  }
}

/** What one outcome of `recordVerifications` carries that a progress line reads. */
interface WikiVerificationOutcomeLike {
  status: string;
  entryId?: string | null;
  trust?: string;
  spotCheck?: boolean;
  reinforced?: boolean;
}

/** Run one `verify` job: the session its input names, one pass, the report the row ends with. */
export async function runWikiVerifyJob(context: WikiJobContext, wiki: WikiService, model: string): Promise<Record<string, unknown>> {
  const input = wikiVerifyJobInput(context.job.input);
  const report = await verifyWikiOps(context, wiki, model, { sessionId: input.sessionId });
  return { kind: 'verify', ...report };
}

/** The kind's runner, with the services the pipelines use and the System model's name. */
export function wikiVerifyJobRunner(wiki: WikiService, model: string | null): WikiJobRunner {
  return (context: WikiJobContext) => runWikiVerifyJob(context, wiki, model ?? '');
}
