import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { DirProbe } from '@orbit/shared';
import { askDirProbe, readDirProbe } from '../api';

/** How often the answer is looked for, and for how long: a question rides a heartbeat, half a minute
 *  away at worst, and a runner restarting mid-question never answers it (contract §2.2). */
export const DIR_PROBE_POLL_MS = 1500;
export const DIR_PROBE_WAIT_MS = 75_000;

export type DirProbeState =
  /** Nothing to ask; or the question was replaced, or a stored answer was all there was to read. */
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'answered'; probe: DirProbe }
  | { state: 'unanswered' };

/** Ask, then read until the runner has answered or the time is up. One question at a time per machine
 *  (§2): a newer one replaces this, the read says `idle`, and there is nothing more to wait for. */
async function probe(
  runnerId: string,
  path: string,
  ask: boolean,
  signal: AbortSignal,
): Promise<DirProbe | 'idle' | 'unanswered'> {
  if (ask) await askDirProbe(runnerId, path);
  const deadline = Date.now() + DIR_PROBE_WAIT_MS;
  for (;;) {
    const answer = await readDirProbe(runnerId, path, signal);
    if (answer.status === 'done' && answer.result) return answer.result;
    if (answer.status === 'idle') return 'idle';
    if (Date.now() >= deadline) return 'unanswered';
    await new Promise((resolve) => setTimeout(resolve, DIR_PROBE_POLL_MS));
    if (signal.aborted) return 'idle';
  }
}

/**
 * What is at `path` on a machine, through the directory probe relay. With `ask` false it only reads
 * what is stored, which is all an offline machine can give. Each new path is a new question, and an
 * answer is never kept past the page that asked: a folder can appear between two looks.
 */
export function useDirProbe(
  runnerId: string,
  path: string | undefined,
  ask: boolean,
): DirProbeState & { again: () => void } {
  const [attempt, setAttempt] = useState(0);
  const q = useQuery({
    queryKey: ['dir-probe', runnerId, path, ask, attempt],
    queryFn: ({ signal }) => probe(runnerId, path!, ask, signal),
    enabled: !!path,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const again = () => setAttempt((n) => n + 1);
  if (!path) return { state: 'idle', again };
  if (q.isError) return { state: 'unanswered', again };
  if (!q.data) return { state: 'checking', again };
  if (q.data === 'idle' || q.data === 'unanswered') return { state: q.data, again };
  return { state: 'answered', probe: q.data, again };
}
