import type { ArtifactResultRequest } from '@orbit/shared';

export interface WorktreeArtifactRequest {
  source: 'worktree';
  path: string;
  result?: Pick<ArtifactResultRequest, 'status' | 'errorCode'> | { status: 'timeout' };
}

/** Query strings are already URL-decoded by Express. Keep the exact git path spelling. */
export function isWorktreeArtifactPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && !/[\\\x00-\x1f\x7f]/.test(value)
    && !/^[A-Za-z]:/.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

export function readWorktreeArtifactRequest(content: string | null): WorktreeArtifactRequest | null {
  if (!content?.startsWith('{')) return null;
  try {
    const value = JSON.parse(content);
    return value?.source === 'worktree' && isWorktreeArtifactPath(value.path) ? value : null;
  } catch {
    return null;
  }
}
