import type { WikiJobCallView, WikiJobKind, WikiJobView, WikiSystemModelReadState } from '@orbit/shared';
import { wikiCount } from './wikiArticles';
import { wikiAgo } from './wikiHealth';

/**
 * The server's runs on Activity (design §2.2, mock 35 ④⑤; contract `jobs.read`, P9): the Runs card's rows — what
 * kind of run, where it stands, how far it got and where it waits — and a run's call log, one model call a row.
 *
 * ONE SENTENCE ON BOTH CLIENTS. OrbitKit's `WikiRunsLogic` builds the same rows from the same read, and both are
 * held to `src/shared/src/wiki-server-execution.fixture.json` (`lib/wikiRuns.test.ts` here,
 * `WikiServerExecutionCopyParityTests` there), which also looks every constant below up by its declaration.
 */

export const WIKI_RUNS = 'Runs';

/** What each kind of run is called (contract `jobs.kinds`). */
export const WIKI_RUN_KINDS: Record<WikiJobKind, string> = {
  verify: 'Verification',
  articles: 'Articles',
  import: 'Import',
  plan_draft: 'Plan draft',
  plan_revise: 'Plan revision',
  docs_build: 'Documents',
  maintain: 'Maintenance',
  smoke: 'Model check',
};

export const WIKI_RUN_QUEUED = 'Queued';
export const WIKI_RUN_RUNNING = 'Running';
export const WIKI_RUN_WAITING_RUNNER = 'Waiting for the runner';
export const WIKI_RUN_WAITING_MODEL = 'Waiting for the System model';
export const WIKI_RUN_DONE = 'Done';
export const WIKI_RUN_FAILED = 'Failed';
export const WIKI_RUN_CANCELLED = 'Cancelled';
export const WIKI_RUN_NEXT_IN_LINE = 'next in line';
export const WIKI_RUN_STARTING = 'starting';
export const WIKI_RUN_NO_RESULT = 'It ended without a result';
export const wikiRunsAhead = (count: number): string => (count === 1 ? '1 run ahead' : `${count} runs ahead`);
export const wikiWaited = (duration: string): string => `waited ${duration}`;
export const wikiRetryingIn = (duration: string): string => `retrying in ${duration}`;
export const wikiCallsEnded = (ended: number, total: number): string => `${ended} of ${total} calls ended`;
export const wikiNextCall = (ahead: number, duration: string): string =>
  ahead === 0 ? `next call first in line, waited ${duration}` : `next call ${ahead} ahead, waited ${duration}`;
export const wikiCalls = (count: number): string => (count === 1 ? '1 call' : `${wikiCount(count)} calls`);
export const wikiTokens = (count: number): string => `${wikiCount(count)} tokens`;
export const wikiTook = (duration: string): string => `took ${duration}`;
export const wikiStarted = (ago: string): string => `started ${ago}`;

/** The call log's columns, and the words of a call's state. */
export const WIKI_CALL = 'Call';
export const WIKI_CALL_STATE = 'State';
export const WIKI_CALL_WAITED = 'Waited';
export const WIKI_CALL_RAN = 'Ran';
export const WIKI_CALL_TOKENS = 'Tokens';
export const WIKI_CALL_QUEUED = 'Queued';
export const WIKI_CALL_RUNNING = 'Running';
export const WIKI_CALL_DONE = 'Done';
export const WIKI_CALL_FAILED = 'Failed';
export const WIKI_CALL_CANCELLED = 'Cancelled';
export const WIKI_NO_VALUE = '—';
export const wikiCallAhead = (ahead: number): string => (ahead === 0 ? 'Queued · next' : `Queued · ${ahead} ahead`);
export const wikiRetries = (count: number): string => (count === 1 ? '1 retry' : `${count} retries`);
export const wikiCallTokens = (input: number, output: number): string => `${wikiCount(input)} → ${wikiCount(output)}`;
export const wikiRan = (duration: string): string => `ran ${duration}`;
export const wikiRunFoot = (calls: number, input: number, output: number): string =>
  `${wikiCalls(calls)} · ${wikiCount(input)} tokens in, ${wikiCount(output)} out`;
export const WIKI_RUN_SO_FAR = 'so far';
export const wikiShowingLast = (shown: number): string => `showing the last ${shown}`;
export const WIKI_RUNS_NONE = 'Nothing has run on the server yet.';

/** How a model's state reads on the Runs card's head, the settings page and Set up (mock 35 ③). */
export const WIKI_MODEL_STATE_WORDS: Record<WikiSystemModelReadState, string> = {
  up: 'Up',
  down: 'Unreachable',
  auth_failed: 'Key refused',
  unconfigured: 'Not configured',
  worker_not_running: 'wiki worker not running',
};
/** up: green; warn: amber — it comes back by itself; error: red — somebody has to act. */
export type WikiModelTone = 'up' | 'warn' | 'error';
export const wikiModelTone = (state: WikiSystemModelReadState): WikiModelTone =>
  state === 'up' ? 'up' : state === 'down' ? 'warn' : 'error';
export const WIKI_SYSTEM_MODEL = 'System model';
/** `System model · qwen3.8-27b-fp8`, or the bare words while no model is named (unconfigured, or no worker yet). */
export const wikiSystemModelLabel = (model: string | null | undefined): string =>
  model ? `${WIKI_SYSTEM_MODEL} · ${model}` : WIKI_SYSTEM_MODEL;

// ── durations ───────────────────────────────────────────────────────────────────────────────────

/** `41s`, `1m 12s`, `6m`, `1h 3m`, `2d 4h`: how long something took or has waited, to the second up to an hour. */
export function wikiDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 === 0 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86_400) {
    const minutes = Math.floor((s % 3600) / 60);
    return minutes === 0 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 3600)}h ${minutes}m`;
  }
  const hours = Math.floor((s % 86_400) / 3600);
  return hours === 0 ? `${Math.floor(s / 86_400)}d` : `${Math.floor(s / 86_400)}d ${hours}h`;
}

/** Seconds from `from` to `to` (an ISO time, or `now`), or null when either is not a time. */
function between(from: string | null | undefined, to: string | number | null | undefined): number | null {
  if (!from || to === null || to === undefined) return null;
  const start = Date.parse(from);
  const end = typeof to === 'number' ? to : Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

// ── a run ───────────────────────────────────────────────────────────────────────────────────────

/** A run's row on the Runs card: its kind, its state word and the sentence after it, and when. */
export interface WikiRunRow {
  kind: string;
  /** ok: a green dot; warn: amber, it waits; error: red, it broke; spin: a spinner, it runs; none: grey. */
  mark: 'ok' | 'warn' | 'error' | 'spin' | 'none';
  /** plain: the state in the text colour; warn: amber; error: red; muted: grey. */
  tone: 'plain' | 'warn' | 'error' | 'muted';
  state: string;
  /** What follows the state: ` · ` between its parts; empty when there is nothing to add. */
  text: string;
  when: string;
}

/** The run's row (mock 35 ④): state first, then how far it got or why it waits, then when. */
export function wikiRunRow(job: WikiJobView, now: number): WikiRunRow {
  const kind = WIKI_RUN_KINDS[job.kind] ?? job.kind;
  const join = (parts: Array<string | null | false>) => parts.filter((part): part is string => !!part).join(' · ');
  switch (job.state) {
    case 'queued': {
      const retry = job.attempts > 0 && job.nextAttemptAt ? between(new Date(now).toISOString(), job.nextAttemptAt) : null;
      const place = retry !== null && retry > 0
        ? wikiRetryingIn(wikiDuration(retry))
        : job.ahead === null ? null : job.ahead === 0 ? WIKI_RUN_NEXT_IN_LINE : wikiRunsAhead(job.ahead);
      return {
        kind, mark: 'warn', tone: 'warn', state: WIKI_RUN_QUEUED,
        text: join([place, wikiWaited(wikiDuration(between(job.createdAt, now) ?? 0))]),
        when: wikiAgo(job.createdAt, now),
      };
    }
    case 'running': {
      const progress = job.progress && job.progress.done !== null && job.progress.total !== null
        ? `${job.progress.step ? `${job.progress.step} ` : ''}${job.progress.done} of ${job.progress.total}`
        : job.calls.total > 0
          ? wikiCallsEnded(job.calls.succeeded + job.calls.failed + job.calls.cancelled, job.calls.total)
          : WIKI_RUN_STARTING;
      const next = job.nextCall ? wikiNextCall(job.nextCall.ahead, wikiDuration(between(job.nextCall.enqueuedAt, now) ?? 0)) : null;
      return {
        kind, mark: 'spin', tone: 'plain', state: WIKI_RUN_RUNNING, text: join([progress, next]),
        when: wikiStarted(wikiAgo(job.startedAt ?? job.createdAt, now)),
      };
    }
    case 'waiting':
      return {
        kind, mark: 'warn', tone: 'warn',
        state: job.waitingFor === 'model' ? WIKI_RUN_WAITING_MODEL : WIKI_RUN_WAITING_RUNNER,
        text: wikiDuration(between(job.updatedAt, now) ?? 0),
        when: wikiStarted(wikiAgo(job.startedAt ?? job.createdAt, now)),
      };
    case 'succeeded': {
      const tokens = job.calls.inputTokens + job.calls.outputTokens;
      const took = between(job.startedAt ?? job.createdAt, job.endedAt);
      return {
        kind, mark: 'ok', tone: 'plain', state: WIKI_RUN_DONE,
        text: join([wikiCalls(job.calls.total), tokens > 0 && wikiTokens(tokens), took !== null && wikiTook(wikiDuration(took))]),
        when: wikiAgo(job.endedAt ?? job.updatedAt, now),
      };
    }
    case 'failed':
      return {
        kind, mark: 'error', tone: 'error', state: WIKI_RUN_FAILED,
        text: join([firstLine(job.error) ?? WIKI_RUN_NO_RESULT, job.calls.total > 0 && wikiCalls(job.calls.total)]),
        when: wikiAgo(job.endedAt ?? job.updatedAt, now),
      };
    case 'cancelled':
    default:
      return { kind, mark: 'none', tone: 'muted', state: WIKI_RUN_CANCELLED, text: '', when: wikiAgo(job.endedAt ?? job.updatedAt, now) };
  }
}

/** The line under a run's call log: its calls and their tokens, `so far` while it is not over, and how many are listed. */
export function wikiRunFootText(job: WikiJobView): string {
  const over = job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled';
  let text = wikiRunFoot(job.calls.total, job.calls.inputTokens, job.calls.outputTokens);
  if (!over) text = `${text} ${WIKI_RUN_SO_FAR}`;
  // The read lists a run's newest calls (contract `jobs.read.limits.callsPerJob`): say so when it left some out.
  if (job.requests.length > 0 && job.requests.length < job.calls.total) text = `${text} · ${wikiShowingLast(job.requests.length)}`;
  return text;
}

// ── a call ──────────────────────────────────────────────────────────────────────────────────────

/** One row of a run's call log: what it was, where it stands, how long it waited and ran, what it spent, how it failed. */
export interface WikiCallRow {
  /** `verify · 3f2a9c1e`: the step and the unit, a uuid cut to its first eight. */
  call: string;
  state: string;
  /** `1 retry`, beside the state, when the call was tried again. */
  retries: string | null;
  /** ok: green; warn: amber; error: red; run: blue; muted: grey. */
  tone: 'ok' | 'warn' | 'error' | 'run' | 'muted';
  waited: string;
  ran: string;
  tokens: string;
  /** The phone's second line: `waited 1s · ran 14s · 1,204 → 296 tokens`. */
  line: string;
  /** Why it failed, or why it waits again, in the queue's words; null when nothing went wrong. */
  error: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A unit as the log names it: a uuid cut to its first eight characters, anything else as the pipeline wrote it. */
export const wikiCallUnit = (unit: string): string => (UUID.test(unit) ? unit.slice(0, 8) : unit);

export function wikiCallRow(call: WikiJobCallView, now: number): WikiCallRow {
  const waitedFor = call.state === 'queued' ? between(call.enqueuedAt, now) : between(call.enqueuedAt, call.startedAt);
  const ranFor = call.state === 'running' ? between(call.startedAt, now) : call.startedAt && call.endedAt ? between(call.startedAt, call.endedAt) : null;
  const waited = waitedFor === null ? WIKI_NO_VALUE : wikiDuration(waitedFor);
  const ran = call.state === 'queued' || ranFor === null ? WIKI_NO_VALUE : wikiDuration(ranFor);
  const tokens = call.inputTokens !== null && call.outputTokens !== null ? wikiCallTokens(call.inputTokens, call.outputTokens) : WIKI_NO_VALUE;
  const [state, tone] = ((): [string, WikiCallRow['tone']] => {
    switch (call.state) {
      case 'queued':
        return [call.ahead === null ? WIKI_CALL_QUEUED : wikiCallAhead(call.ahead), 'warn'];
      case 'running':
        return [WIKI_CALL_RUNNING, 'run'];
      case 'succeeded':
        return [WIKI_CALL_DONE, 'ok'];
      case 'failed':
        return [WIKI_CALL_FAILED, 'error'];
      case 'cancelled':
      default:
        return [WIKI_CALL_CANCELLED, 'muted'];
    }
  })();
  const line = [
    waited !== WIKI_NO_VALUE ? wikiWaited(waited) : null,
    ran !== WIKI_NO_VALUE ? wikiRan(ran) : null,
    tokens !== WIKI_NO_VALUE ? `${tokens} tokens` : null,
  ].filter((part): part is string => !!part).join(' · ');
  return {
    call: `${call.step} · ${wikiCallUnit(call.unit)}`,
    state,
    retries: call.attempts > 0 ? wikiRetries(call.attempts) : null,
    tone,
    waited,
    ran,
    tokens,
    line,
    error: call.state === 'succeeded' || call.state === 'cancelled' ? null : firstLine(call.error),
  };
}

/** A failure's first line: what a row has room for. */
function firstLine(text: string | null | undefined): string | null {
  const line = (text ?? '').split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

/** Whether Activity draws the Runs card: the server runs this account's wiki, or ran something for the space. */
export const wikiRunsShown = (serverExecutes: boolean, jobs: readonly WikiJobView[] | null | undefined): boolean =>
  serverExecutes || (jobs?.length ?? 0) > 0;
