import { BadRequestException } from '@nestjs/common';

/**
 * POST /sessions `workSubdir`: the folder below its workspace's workDir a session with no worktree runs in
 * (`orbit` typed in a subfolder). The apiserver cannot see the runner's disk, so it checks the shape alone:
 * relative, `/`-separated, normalized, no `..` segment. The runner checks the folder itself, symlinks followed,
 * before it starts an engine there (runner-go work_subdir.go).
 *
 * Answers the value to store (null when omitted), or throws a 400 naming what is wrong with it.
 */
export function checkedWorkSubdir(value: unknown, noWorktree: boolean): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new BadRequestException('workSubdir must be a string');
  const refuse = (why: string) => new BadRequestException(`workSubdir ${JSON.stringify(value)} ${why}`);
  if (value === '' || value === '.') {
    throw refuse('names no folder below the workspace directory; omit it to run the session there');
  }
  if (value.length > 1024) throw refuse('is longer than 1024 characters');
  if (value.includes('\0')) throw refuse('contains a NUL character');
  if (value.includes('\\')) throw refuse('must separate folders with "/"');
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw refuse('must be relative to the workspace directory, not absolute');
  const segments = value.split('/');
  if (segments.includes('..')) throw refuse('must not contain a ".." segment');
  if (segments.some((s) => s === '' || s === '.')) {
    throw refuse('must be normalized: no empty or "." segment, and no leading or trailing "/"');
  }
  if (!noWorktree) throw refuse('is only for a session with no worktree: send it with worktree: false');
  return value;
}
