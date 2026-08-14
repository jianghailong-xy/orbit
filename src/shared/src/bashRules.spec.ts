import { describe, expect, it } from 'vitest';
import { bashCommandRules, bashPrefix, bashSegments } from './bashRules';

// Just the prefixes, for readable assertions (the rules are `${prefix}:*`).
const prefixesOf = (cmd: string): (string | undefined)[] =>
  bashCommandRules(cmd).map((r) => r.ruleContent?.replace(/:\*$/, ''));

describe('bashSegments', () => {
  it('splits on ; && || and single |', () => {
    expect(bashSegments('a; b && c || d | e').map((s) => s.trim())).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('does not split on operators inside double quotes', () => {
    expect(bashSegments('grep "a;b|c" x').map((s) => s.trim())).toEqual(['grep "a;b|c" x']);
  });

  it('does not split on operators inside single quotes', () => {
    expect(bashSegments("echo 'a || b'").map((s) => s.trim())).toEqual(["echo 'a || b'"]);
  });

  it('keeps a backslash-escaped pipe inside quotes as one segment', () => {
    // The conflict-marker grep from the real report: "^<<<<<<<\|^=======\|^>>>>>>>".
    const cmd = 'grep -rn "^<<<<<<<\\|^=======\\|^>>>>>>>" src';
    expect(bashSegments(cmd)).toHaveLength(1);
  });

  it('splits on newlines', () => {
    expect(bashSegments('a\nb').map((s) => s.trim())).toEqual(['a', 'b']);
  });
});

describe('bashPrefix', () => {
  it('takes program + one subcommand word', () => {
    expect(bashPrefix('git commit -m x')).toBe('git commit');
  });

  it('stops at a flag', () => {
    expect(bashPrefix('grep -rn foo')).toBe('grep');
  });

  it('stops at a path-like arg', () => {
    expect(bashPrefix('cd /root/x')).toBe('cd');
  });

  it('skips FOO=bar env assignments', () => {
    expect(bashPrefix('FOO=bar git diff')).toBe('git diff');
  });

  it('returns null for an empty or operator-only segment', () => {
    expect(bashPrefix('   ')).toBeNull();
    expect(bashPrefix('| head')).toBeNull();
  });
});

describe('bashCommandRules', () => {
  it('is empty for a blank command', () => {
    expect(bashCommandRules('')).toEqual([]);
    expect(bashCommandRules('   ')).toEqual([]);
  });

  it('shapes each rule as `${prefix}:*` under Bash', () => {
    expect(bashCommandRules('git add -A')).toEqual([{ toolName: 'Bash', ruleContent: 'git add:*' }]);
  });

  it('dedupes a sub-command that recurs across the line', () => {
    expect(prefixesOf('git add a; git status; git add b')).toEqual(['git add', 'git status']);
  });

  it('treats a bareword second word as a sub-command (so `npm install` stays narrow)', () => {
    // The heuristic that makes `git commit` distinct from `git diff` also narrows
    // `echo a` to `echo a` — quoted args (as in real echos) fall back to bare `echo`.
    expect(prefixesOf('npm install; npm run build')).toEqual(['npm install', 'npm run']);
    expect(prefixesOf('echo "a"; echo "b"')).toEqual(['echo']);
  });

  it('remembers EVERY sub-command of a compound line, not just the leading cd', () => {
    // The exact command from the approval card in the bug report.
    const cmd =
      'cd /root/.orbit/worktrees/019f04fc; git add -A src/macos; ' +
      'echo "=== any isSystem refs left anywhere? ==="; ' +
      'grep -rn "isSystem" src/macos || echo "(none — good)"; ' +
      'echo "=== any conflict markers left? ==="; ' +
      'grep -rn "^<<<<<<<\\|^=======\\|^>>>>>>>" src/macos || echo "(none — good)"; ' +
      'echo "=== unmerged files? ==="; git diff --name-only --diff-filter=U || true; ' +
      'echo "(empty = all resolved)"';
    expect(prefixesOf(cmd)).toEqual(['cd', 'git add', 'echo', 'grep', 'git diff', 'true']);
  });

  it('keeps a quoted separator from fragmenting a sub-command', () => {
    expect(prefixesOf('cd /x && git commit -m "a;b"')).toEqual(['cd', 'git commit']);
  });
});
