// The background-shell derivation now lives in @orbit/shared so the apiserver (which serves the
// authoritative, complete list at GET /sessions/:id/background — derived over ALL persisted
// events) and this client (which derives over its loaded event window for a live overlay) can
// never drift. This module re-exports it and adds the client-only merge that folds the two
// sources into the list the tray renders.
export type { BgShell, BgShellStatus, BgShellCtx } from '@orbit/shared';
export { deriveBackgroundShells, classifyShellStatus } from '@orbit/shared';

import type { BgShell } from '@orbit/shared';

/**
 * Fold the server's authoritative list (`server` — every shell the session ever launched, with
 * output recovered from the agent's persisted Read polls) together with the list derived from the
 * currently-loaded event window (`live` — fewer shells, but the freshest tail for anything still
 * running and any launch that streamed in after the server fetch).
 *
 * Per shell id: a *running* shell prefers `live` (its background_output tail advances live and
 * isn't persisted), everything else prefers `server` (a completed shell's authoritative output
 * comes from a Read poll that may sit outside the loaded window, so `live` can lack it). A shell
 * present in only one source is taken as-is — so older completed shells (server-only) and brand-new
 * launches that arrived over SSE after the fetch (live-only) both survive. Sorted by launch order.
 */
export function mergeBackgroundShells(server: BgShell[], live: BgShell[]): BgShell[] {
  const byId = new Map<string, BgShell>();
  for (const s of server) byId.set(s.shellId, s);
  for (const l of live) {
    const s = byId.get(l.shellId);
    // Keep the server row for a shell that already terminated there, unless the live row is fresher
    // (only possible while it's still running); otherwise the live row wins / introduces the shell.
    if (s && l.status === 'running') byId.set(l.shellId, l);
    else if (!s) byId.set(l.shellId, l);
  }
  return [...byId.values()].sort((a, b) => a.startedSeq - b.startedSeq);
}
