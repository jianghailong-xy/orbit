import { createHash } from 'crypto';

/**
 * The UUID namespace (RFC 9562 §5.5) a forked import's Claude session id is derived in. The runner
 * derives the same id (src/runner-go/transcript_import.go importForkSessionID).
 */
const IMPORT_FORK_NAMESPACE = Buffer.from('4fe309cdd99445b0a281ff981e57f5fd', 'hex');

/**
 * The Claude session id an import forks the transcript of `claudeSessionId` under: a version-5
 * UUID of the lowercase id.
 *
 * A runner forks when the place `--resume` reads for the imported session is the transcript
 * itself (a workspace with no worktree, in the directory the conversation was recorded in), so
 * the session and whoever still holds the original never write one file. Being derived, the fork
 * is the one id /import-result may move a session to, and it still says which transcript the
 * session came from: a second import of the original is refused by it.
 */
export function importForkSessionId(claudeSessionId: string): string {
  const u = createHash('sha1')
    .update(IMPORT_FORK_NAMESPACE)
    .update(claudeSessionId.toLowerCase(), 'utf8')
    .digest()
    .subarray(0, 16);
  u[6] = (u[6] & 0x0f) | 0x50; // version 5
  u[8] = (u[8] & 0x3f) | 0x80; // the RFC variant
  const hex = u.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
