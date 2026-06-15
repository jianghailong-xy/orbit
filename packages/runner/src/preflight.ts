import { spawnSync } from 'child_process';
import { hasExplicitClaudeAuth } from './claude-adapter';

export interface PreflightResult {
  ok: boolean;
  message: string;
}

/**
 * Verify the runner can authenticate to Claude Code before accepting jobs.
 *
 * - An env credential (API key / OAuth token) → good (the SDK or CLI will use it).
 * - Otherwise we rely on the machine's interactive `claude /login`. Probe it with
 *   `claude auth status` (exit 0 = logged in). A clear "not logged in" fails fast;
 *   a missing `claude` binary fails fast; an unrecognized probe (older CLI) only
 *   warns, so we don't false-block.
 * Set ORBIT_SKIP_PREFLIGHT=1 to bypass entirely.
 */
export function preflightClaudeAuth(): PreflightResult {
  if (process.env.ORBIT_SKIP_PREFLIGHT) {
    return { ok: true, message: 'preflight skipped (ORBIT_SKIP_PREFLIGHT)' };
  }
  if (hasExplicitClaudeAuth()) {
    return { ok: true, message: 'auth via env (ANTHROPIC_API_KEY / OAuth token)' };
  }

  const probe = spawnSync('claude', ['auth', 'status'], {
    encoding: 'utf8',
    timeout: 15_000,
  });

  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        message:
          'Claude Code (`claude`) was not found on PATH. Install Claude Code and run `claude` then `/login`, ' +
          'or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.',
      };
    }
    return { ok: true, message: `could not run \`claude auth status\` (${code}); proceeding` };
  }

  if (probe.status === 0) {
    return { ok: true, message: 'Claude Code is logged in (subscription)' };
  }

  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.toLowerCase();
  const looksUnauthenticated = /not.*(logged|authenticat)|unauthenticated|run .*login|please log in/.test(
    out,
  );
  if (looksUnauthenticated) {
    return {
      ok: false,
      message:
        'Claude Code is not logged in. Run `claude` then `/login` (uses your Claude subscription), ' +
        'or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.',
    };
  }
  // Non-zero but not a recognizable "not logged in" message (e.g. older CLI without
  // `auth status`). Don't hard-block — the first task will surface a real auth error.
  return {
    ok: true,
    message: 'could not verify Claude Code auth via `claude auth status`; proceeding',
  };
}
