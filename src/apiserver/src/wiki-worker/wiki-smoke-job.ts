import type { WikiJobContext } from './wiki-job-executor';

/**
 * The smoke job (contract `jobs.kinds.smoke`, design §12 P1): one job that makes one model call and writes
 * the answer, the usage and the call's duration into its report. It runs no pipeline and reads nothing —
 * its whole purpose is to be the shortest route there is through the queue: a job claimed, a request
 * enqueued, the scheduler's claim, the call, the answer written back under the lease generation, the job
 * settled. If it succeeds, every piece of the queue worked; `wiki-jobs.pg.spec.ts` runs it end to end
 * against a fake System model.
 *
 * Its input is `{ system?, prompt?, maxTokens? }`; every part has a default, so an empty input is a job.
 */
export interface WikiSmokeJobInput {
  system: string;
  prompt: string;
  maxTokens: number;
}

export const WIKI_SMOKE_JOB = {
  /** The step and unit its one request is filed under; the pair is the request's identity for the job. */
  step: 'smoke',
  unit: 'call',
  system: "You are the Orbit wiki worker's smoke probe: one call, nothing to do with the wiki's content.",
  prompt: 'Answer with the single word: pong. Nothing else.',
  maxTokens: 16,
} as const;

/** The smoke job's input, as the job's `input` column holds it. */
export function wikiSmokeJobInput(input: Record<string, unknown>): WikiSmokeJobInput {
  const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() !== '' ? value : fallback);
  const maxTokens = typeof input.maxTokens === 'number' && Number.isInteger(input.maxTokens) && input.maxTokens >= 1
    ? input.maxTokens
    : WIKI_SMOKE_JOB.maxTokens;
  return {
    system: text(input.system, WIKI_SMOKE_JOB.system),
    prompt: text(input.prompt, WIKI_SMOKE_JOB.prompt),
    maxTokens,
  };
}

/**
 * Run the smoke job: one call, waited for, its answer and usage in the report. What the call row ends as is
 * the job's outcome — the context's `ask` throws for a failure the job must read (a content one) and for
 * the wait limit's (an infra one), and only a succeeded row comes back.
 */
export async function runWikiSmokeJob(context: WikiJobContext): Promise<Record<string, unknown>> {
  const input = wikiSmokeJobInput(context.job.input);
  const settled = await context.ask(WIKI_SMOKE_JOB.step, WIKI_SMOKE_JOB.unit, {
    system: input.system,
    prompt: input.prompt,
    maxTokens: input.maxTokens,
  });
  return {
    kind: 'smoke',
    answer: settled.answer ?? '',
    usage: { inputTokens: settled.inputTokens ?? 0, outputTokens: settled.outputTokens ?? 0 },
    httpStatus: settled.httpStatus,
  };
}
