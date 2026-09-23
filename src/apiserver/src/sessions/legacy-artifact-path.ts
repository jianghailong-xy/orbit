import { uuidToBase62 } from '@orbit/shared';
import path from 'path';

/**
 * The path a client is asking for when it fetches a session artifact, resolved far enough to know
 * it is one of that session's own files — or null, which the door answers as "artifact not found".
 *
 * What arrives here is a path out of a transcript: an agent wrote its mock somewhere and linked it,
 * and the bytes are on the runner. Two directory layouts under `.orbit` are a session's own, named
 * for that session:
 *
 *   `.orbit/uploads/<session>/…`   the scratch dir older sessions wrote into (legacy sessions, and
 *                                  what the original artifact feature was built for)
 *   `.orbit/worktrees/<session>/…` the checkout the agent works in now — where the mocks it draws
 *                                  and links actually live
 *
 * The runner decides what is really under them (uploadLegacyArtifact reads only those two, stats the
 * file, and enforces the checkout's own spelling); this function decides only that the request is
 * about *this* session's directory and not a filesystem walk someone smuggled in. Both spellings of
 * the id are accepted because the checkout takes whichever one the claim carried, while the request
 * names the session the way the row stores it.
 *
 * `root` comes back for the one deployment that reads such a file itself (an apiserver sharing the
 * runner's filesystem); the deployed one does not, and asks the runner for the bytes instead.
 */
export function resolveLegacyArtifactPath(
  sessionId: string,
  rawPath: string | undefined,
): { original: string; file: string; root: string } | null {
  const original = (rawPath ?? '').trim();
  if (!original) return null;
  let decoded = original;
  try {
    decoded = decodeURIComponent(original);
  } catch {
    // Keep the raw value; the path checks below reject malformed or unsafe values.
  }
  if (!path.isAbsolute(decoded) || decoded.split(/[\\/]+/).includes('..')) return null;
  const normalized = path.normalize(decoded);
  const parts = normalized.split(path.sep).filter(Boolean);
  const dirNames = new Set([sessionId, uuidToBase62(sessionId)]);
  const marker = parts.findIndex(
    (part, i) =>
      part === '.orbit' &&
      (parts[i + 1] === 'uploads' || parts[i + 1] === 'worktrees') &&
      dirNames.has(parts[i + 2]),
  );
  if (marker < 0 || parts.length <= marker + 3) return null;
  const root = path.join(path.sep, ...parts.slice(0, marker + 3));
  return { original: decoded, file: normalized, root };
}
