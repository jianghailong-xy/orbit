import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CLAUDE_REGION_UNSUPPORTED,
  claudeRegionStoppedError,
  type ClaudeRegionCheckRequest,
  type RunnerRegionView,
} from '@orbit/shared';
import { api } from '../api';
import { CLAUDE_REGION_CHECK_FAILED, anthropicUnavailableOn } from './claudeRegionCopy';
import { encodeId } from './idCodec';
import { runnersQuery } from './queries';
import { sessionRunStateOf, type SessionStateSource } from './sessionState';
import { useToast } from './toast';

/**
 * The Claude region check as the web reads it (docs/claude-region-check-contract.md). The verdict is
 * the runner's (`runner.region`, §6), never an engine's health; a session's own state says only that
 * it is held, by the code its error starts with (§9, §10). A runner that reads `region: null` — one
 * without claude-region/v1, one no check has decided yet, or an older control plane's — is never
 * gated, and every surface draws what it drew before.
 */

/** Whether a runner's Anthropic-bound Claude turns are gated now. `region.verdict` is already the
 *  effective verdict (§5): the server answers blocked only for a blocked check under 24 hours old. */
export const claudeRegionBlocked = (runner: { region?: RunnerRegionView | null } | null | undefined): boolean =>
  runner?.region?.verdict === 'blocked';

const CODED = `${CLAUDE_REGION_UNSUPPORTED}: `;

/** Whether an error is a region refusal or stop: `CLAUDE_REGION_UNSUPPORTED: <sentence>` (§9, §10). */
export const isClaudeRegionError = (error: unknown): error is string =>
  typeof error === 'string' && error.trim().startsWith(CODED);

/** The stopped sentence's whole shape (owner decision ④, §10), read off the shared writer: its words
 *  around the machine and the place, so a refusal from a machine whose name starts like it is still a
 *  refusal. */
const STOPPED_SENTENCE = (() => {
  const [lead, middle, tail] = claudeRegionStoppedError('\u0000', '\u0001').split(/[\u0000\u0001]/);
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${literal(lead)}[\\s\\S]+${literal(middle)}[\\s\\S]+${literal(tail)}$`);
})();

/**
 * What the transcript draws for an error event the runner wrote: `undefined` for one that is no
 * region error, `null` for a refusal — the held session's card says it, with its ways out, so a red
 * line with the raw code would only repeat it — and, for a turn stopped by a confirmed flip, which has
 * no card, the stopped sentence without its code.
 */
export function claudeRegionErrorLine(message: string): string | null | undefined {
  const text = message.trim();
  if (!text.startsWith(CODED)) return undefined;
  return STOPPED_SENTENCE.test(text) ? text.slice(CODED.length) : null;
}

/** A session the control plane holds for the region (§10, §11): in the queue, with a region refusal
 *  as its error. Its message waits, and nothing is working on it. */
export const claudeRegionHeld = (session: SessionStateSource | null | undefined): boolean =>
  !!session && sessionRunStateOf(session) === 'QUEUED' && isClaudeRegionError(session.error);

/** A held session's status words — 'Anthropic unavailable on {machine}' — or null for any other
 *  session, and where the machine is not known. */
export const claudeRegionHeldWords = (
  session: SessionStateSource | null | undefined,
  machine: string | null | undefined,
): string | null => (machine && claudeRegionHeld(session) ? anthropicUnavailableOn(machine) : null);

/** How long Check again keeps reading the runner while its check is on the way. */
const CHECK_POLL_MS = 2_000;
const CHECK_WAIT_MS = 30_000;

/**
 * Check again (§7): POST /runners/:id/region-check, and the runner checks at once. Its answer lands
 * in `runner.region` like any other check's, so the runners are read again every two seconds until
 * the region's `checkedAt` reaches the request, for up to 30 seconds. Refused while the runner is
 * offline, or too old to check, in the server's words.
 */
export function useClaudeRegionCheckAgain(runner: { id: string; region?: RunnerRegionView | null }) {
  const qc = useQueryClient();
  const message = useToast();
  const [askedAt, setAskedAt] = useState<string | null>(null);
  const checkedAt = runner.region?.checkedAt;
  const answered = askedAt !== null && !!checkedAt && Date.parse(checkedAt) >= Date.parse(askedAt);
  const ask = useMutation({
    mutationFn: () => api<ClaudeRegionCheckRequest>(`/runners/${encodeId(runner.id)}/region-check`, { method: 'POST' }),
    onSuccess: (answer) => setAskedAt(answer?.requestedAt ?? new Date().toISOString()),
    onError: (e: Error) => message.error(CLAUDE_REGION_CHECK_FAILED, e.message),
  });
  useEffect(() => {
    if (askedAt === null) return undefined;
    if (answered) {
      setAskedAt(null);
      return undefined;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started >= CHECK_WAIT_MS) setAskedAt(null);
      else void qc.invalidateQueries({ queryKey: runnersQuery().queryKey });
    }, CHECK_POLL_MS);
    return () => clearInterval(timer);
  }, [askedAt, answered, qc]);
  return {
    checkAgain: () => ask.mutate(),
    /** The request itself is in flight. */
    asking: ask.isPending,
    /** The request, or the check it asked for, is not answered yet. */
    checking: ask.isPending || (askedAt !== null && !answered),
  };
}
