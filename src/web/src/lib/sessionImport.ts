import { getSession, getSessionEventPage, importClaudeSession } from '../api';

/** How long the workspace-settings import waits for the runner to replay the transcript —
 *  the CLI's own timeout. */
export const SESSION_IMPORT_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_IMPORT_POLL_MS = 3000;

/** The shape the CLI refuses locally, so the two entry points read identically. */
export const CLAUDE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Import a local Claude Code transcript as a session of a workspace and wait for it to settle,
 *  mirroring `orbit session import`: the create succeeds before the runner has even seen the
 *  transcript, so "done" is the replay landing as events, and the runner settles a refusal as
 *  FAILED with the reason. Resolves with the imported session's id. */
export async function importClaudeSessionAndWait(
  claudeSessionId: string,
  workspaceId: string,
): Promise<string> {
  const created = await importClaudeSession({ claudeSessionId, workspaceId });
  const deadline = Date.now() + SESSION_IMPORT_TIMEOUT_MS;
  for (;;) {
    const [page, sess] = await Promise.all([
      getSessionEventPage(created.id, { tail: 1 }),
      getSession(created.id),
    ]);
    if (page.events.length > 0) return created.id; // the replay landed — import settled
    if (sess.status === 'FAILED' || sess.status === 'CANCELLED' || sess.status === 'INTERRUPTED') {
      throw new Error(sess.error || `import failed: ${sess.status}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for the import to finish — check the session at /sessions/${created.id}`,
      );
    }
    await new Promise((r) => setTimeout(r, SESSION_IMPORT_POLL_MS));
  }
}
