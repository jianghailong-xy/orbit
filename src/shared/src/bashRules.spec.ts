import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bashCommandRules, bashPrefix, bashSegments } from './bashRules';

// Just the prefixes, for readable assertions (the rules are `${prefix}:*`).
const prefixesOf = (cmd: string): (string | undefined)[] =>
  bashCommandRules(cmd).map((r) => r.ruleContent?.replace(/:\*$/, ''));

/**
 * `bash-rules.fixture.json` is what "always allow" remembers from a command, and both clients are
 * proved against it: this walks it through `bashCommandRules`, which the web card calls, and
 * OrbitKit's `ApprovalRememberParityTests` walks the same file through the native port.
 */
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'bash-rules.fixture.json'), 'utf8'),
) as { cases: Array<{ name: string; command: string; rules: string[] }> };

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
  it('shapes each rule as `${prefix}:*` under Bash', () => {
    expect(bashCommandRules('git add -A')).toEqual([{ toolName: 'Bash', ruleContent: 'git add:*' }]);
  });

  it('remembers what bash-rules.fixture.json says, case by case', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
    for (const c of fixture.cases) {
      expect(prefixesOf(c.command), c.name).toEqual(c.rules);
    }
  });

  it('keeps the cases the fixture exists for', () => {
    // So a case deleted in passing is a failure at both ends rather than one fewer line of output.
    const names = fixture.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of [
      "Codex's shell wrapper is never remembered",
      'the card from 2026-10-02',
      'a wrapper anywhere in a compound line refuses the whole line',
      'every sub-command of a compound line, not just the leading cd',
      'a quoted separator does not split a sub-command',
    ]) {
      expect(names.some((n) => n.startsWith(required)), required).toBe(true);
    }
  });
});
