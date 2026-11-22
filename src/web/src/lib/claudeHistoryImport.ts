import { useEffect, useState } from 'react';
import { askClaudeHistory, getClaudeHistory, importClaudeHistory, type ClaudeHistoryResult } from '../api';
import type { ImportMode } from '../components/ClaudeHistoryOffer';
import type { useToast } from './toast';

/** How long the history question waits for the runner. It rides the runner's 30s heartbeat, so this
 *  is two beats plus the scan — past that the offer simply never appears. */
const HISTORY_WAIT_MS = 75_000;
const HISTORY_POLL_MS = 2500;
/** Long enough that typing a path doesn't ask once per keystroke. */
const HISTORY_DEBOUNCE_MS = 500;

/**
 * What Claude Code history the runner holds under `path`: null until an answer arrives for exactly
 * that path, and for a directory with nothing in it.
 *
 * The runner is the only one who can answer — the control plane never sees ~/.claude/projects — so
 * the question goes out on its heartbeat and the answer arrives on its own POST. Changing the path
 * drops the answer at once, and an answer about a path no longer asked about is never shown.
 */
export function useClaudeHistory(runnerId: string | null, path: string, enabled: boolean): ClaudeHistoryResult | null {
  const [history, setHistory] = useState<ClaudeHistoryResult | null>(null);
  useEffect(() => {
    setHistory(null);
    const dir = path.trim();
    if (!enabled || !runnerId || !dir) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await askClaudeHistory(runnerId, dir);
        } catch {
          return; // an offline runner, or one too old to know the question: offer nothing
        }
        const deadline = Date.now() + HISTORY_WAIT_MS;
        for (;;) {
          await new Promise((r) => setTimeout(r, HISTORY_POLL_MS));
          if (cancelled) return;
          let state;
          try {
            state = await getClaudeHistory(runnerId, dir);
          } catch {
            return;
          }
          if (cancelled) return;
          if (state.result) {
            // A directory with nothing in it is not an offer with a zero in it.
            if (state.result.conversations > 0 && state.result.transcripts.length > 0) setHistory(state.result);
            return;
          }
          if (state.status === 'failed' || Date.now() > deadline) return;
        }
      })();
    }, HISTORY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runnerId, path, enabled]);
  return history;
}

/** Import the offered history into a workspace. Not awaited by its callers: each transcript becomes
 *  a session the runner replays on its own, so the page is usable before the last one has landed. */
export function startHistoryImport(
  workspaceId: string,
  history: ClaudeHistoryResult,
  mode: ImportMode,
  message: ReturnType<typeof useToast>,
  refreshSessionLists: () => void,
): Promise<void> {
  if (mode === 'none') return Promise.resolve();
  const transcripts = mode === 'latest' ? history.transcripts.slice(0, 1) : history.transcripts;
  return importClaudeHistory({ workspaceId, transcripts })
    .then((res) => {
      message.success(
        res.imported === 1
          ? 'Importing 1 conversation — it appears as it lands.'
          : `Importing ${res.imported} conversations — they appear as they land.`,
      );
      refreshSessionLists();
    })
    .catch((e: Error) =>
      message.error(
        transcripts.length === 1 ? "Couldn't import the conversation" : "Couldn't import the conversations",
        e.message,
      ),
    );
}
