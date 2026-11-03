import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bashCommandRules,
  bashPrefix,
  bashSegments,
  isBashCommandKeyword,
  readableBashSegments,
} from './bashRules';

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

  it('takes a backslash inside single quotes as a plain character, so the quote closes there', () => {
    expect(bashSegments("ls '\\'; touch x #'").map((s) => s.trim())).toEqual(["ls '\\'", 'touch x']);
  });

  it('still escapes with a backslash inside double quotes and outside quotes', () => {
    expect(bashSegments('echo "a\\"; b"').map((s) => s.trim())).toEqual(['echo "a\\"; b"']);
    expect(bashSegments('echo a\\; b').map((s) => s.trim())).toEqual(['echo a\\; b']);
  });

  it('keeps the shell idiom for a quote inside single quotes in one sub-command', () => {
    expect(bashSegments("echo 'it'\\''s; fine'").map((s) => s.trim())).toEqual(["echo 'it'\\''s; fine'"]);
  });

  it('reads ANSI-C quoting, where a backslash does escape', () => {
    expect(bashSegments("echo $'a\\'b; c'; d").map((s) => s.trim())).toEqual(["echo $'a\\'b; c'", 'd']);
  });

  it('drops a comment, and the newline after it still ends the sub-command', () => {
    expect(bashSegments("ls #'\ntouch x #'").map((s) => s.trim())).toEqual(['ls', 'touch x']);
    expect(bashSegments('ls # one; two\nb').map((s) => s.trim())).toEqual(['ls', 'b']);
  });

  it('reads # as a comment only where a word could start', () => {
    expect(bashSegments('ls a#b; c').map((s) => s.trim())).toEqual(['ls a#b', 'c']);
    expect(bashSegments('ls "#"; c').map((s) => s.trim())).toEqual(['ls "#"', 'c']);
    expect(bashSegments("ls ''#b; c").map((s) => s.trim())).toEqual(["ls ''#b", 'c']);
    expect(bashSegments('ls \\#b; c').map((s) => s.trim())).toEqual(['ls \\#b', 'c']);
    expect(bashSegments('ls;#b\nc').map((s) => s.trim())).toEqual(['ls', '', 'c']);
  });

  it('leaves the word state alone across a line continuation', () => {
    expect(bashSegments("ls \\\n#'\ntouch x #'").map((s) => s.trim())).toEqual(['ls \\', 'touch x']);
    expect(bashSegments('ls\\\n#b; c').map((s) => s.trim())).toEqual(['ls\\\n#b', 'c']);
  });
});

describe('readableBashSegments', () => {
  const trimmed = (cmd: string) => readableBashSegments(cmd)?.map((s) => s.trim()) ?? null;

  it('reads the ordinary shapes the way bashSegments does', () => {
    expect(trimmed('git status')).toEqual(['git status']);
    expect(trimmed('a && b')).toEqual(['a', 'b']);
    expect(trimmed('grep "a;b|c" x')).toEqual(['grep "a;b|c" x']);
    expect(trimmed("grep 'a\\|b' x")).toEqual(["grep 'a\\|b' x"]);
    expect(trimmed('ls -la # list the files')).toEqual(['ls -la']);
    expect(trimmed('git commit -m "one\n\ntwo"')).toEqual(['git commit -m "one\n\ntwo"']);
    expect(trimmed('  ls  \n')).toEqual(['ls']);
  });

  it('refuses an assignment ahead of a program, in any sub-command', () => {
    expect(trimmed('PATH=/tmp/x ls')).toBeNull();
    expect(trimmed('LD_PRELOAD=/tmp/x.so ls')).toBeNull();
    expect(trimmed('BASH_ENV=/tmp/x ls')).toBeNull();
    expect(trimmed('FOO=bar git diff')).toBeNull();
    expect(trimmed('ls && FOO=bar git diff')).toBeNull();
    // An argument that looks like one is only an argument.
    expect(trimmed('ls FOO=bar')).toEqual(['ls FOO=bar']);
  });

  it('refuses the other spellings of an assignment, behind any keyword', () => {
    for (const cmd of [
      'env FOO=bar ls',
      'env ls',
      'env -i ls',
      'export PATH=/tmp/x; ls',
      'export FOO',
      'declare -x FOO=bar',
      'typeset -x FOO=bar',
      'readonly FOO=bar',
      'local FOO=bar',
      'if true; then PATH=/tmp/x ls; fi',
      'for f in a; do env ls; done',
      'do time FOO=bar ls',
    ]) {
      expect(trimmed(cmd), cmd).toBeNull();
    }
    // `env` alone only prints, and a program named like one of them is another program.
    expect(trimmed('env')).toEqual(['env']);
    expect(trimmed('env | grep x')).toEqual(['env', 'grep x']);
    expect(trimmed('environ x')).toEqual(['environ x']);
    expect(trimmed('exporter x')).toEqual(['exporter x']);
  });

  it('refuses a line that names PATH as a word, whichever builtin would set it', () => {
    for (const cmd of [
      'read PATH',
      "read PA''TH",
      'read PA\\\nTH',
      'printf -v PATH /tmp/x; ls',
      'printf -vPATH /tmp/x; ls',
      'for PATH in /tmp/x; do ls; done',
      'echo /tmp/x | while read PATH; do ls; done',
    ]) {
      expect(trimmed(cmd), cmd).toBeNull();
    }
    // Reading it is not setting it, and a longer name is another name.
    expect(trimmed('echo $PATH')).toEqual(['echo $PATH']);
    expect(trimmed('echo "$PATH"')).toEqual(['echo "$PATH"']);
    expect(trimmed('echo MYPATH PATHS')).toEqual(['echo MYPATH PATHS']);
  });

  it('refuses a line a shell could end somewhere else', () => {
    for (const cmd of ["ls 'a", 'ls "a', 'ls a\\', "ls 'a\\'", "ls $'a'", "ls '\\'; touch x #'"]) {
      expect(trimmed(cmd), cmd).toBeNull();
    }
  });

  it('refuses a comment that would mean something if it were not one', () => {
    expect(trimmed("ls #'\ntouch x #'")).toBeNull();
    expect(trimmed('ls # a; b')).toBeNull();
    expect(trimmed('ls # $(b)')).toBeNull();
  });

  it('refuses a subshell and a glob qualifier', () => {
    expect(trimmed('(ls)')).toBeNull();
    expect(trimmed('ls *(x)')).toBeNull();
    // Inside quotes or escaped, a parenthesis is only text.
    expect(trimmed('grep "(a)" x')).toEqual(['grep "(a)" x']);
    expect(trimmed('find . \\( -name a \\)')).toEqual(['find . \\( -name a \\)']);
  });

  it('refuses a close brace with no open one in its word, which can end a command in zsh', () => {
    expect(trimmed('ls a}\\\n touch x')).toBeNull();
    expect(trimmed('ls $a}\\\n touch x')).toBeNull();
    expect(trimmed('ls a}')).toBeNull();
    expect(trimmed('ls {a b}')).toBeNull();
    expect(trimmed('ls {}}')).toBeNull();
    expect(trimmed('ls \\{a}')).toBeNull();
    // A pair is brace expansion, and a quoted or escaped one is only text.
    expect(trimmed('ls {a,b}')).toEqual(['ls {a,b}']);
    expect(trimmed('ls x{a,b}y{c,d}')).toEqual(['ls x{a,b}y{c,d}']);
    expect(trimmed('find . -exec ls {} +')).toEqual(['find . -exec ls {} +']);
    expect(trimmed("ls 'a}'")).toEqual(["ls 'a}'"]);
    expect(trimmed('ls "a}"')).toEqual(['ls "a}"']);
    expect(trimmed('ls a\\}')).toEqual(['ls a\\}']);
  });

  it('refuses a character JS takes for a space and a shell takes for part of a word', () => {
    for (const odd of ['\r', '\f', '\v', '\u00a0', '\u2028', '\u3000', '\ufeff', '\u0000']) {
      expect(trimmed(`ls${odd}x`), JSON.stringify(odd)).toBeNull();
      expect(trimmed(`${odd}ls`), JSON.stringify(odd)).toBeNull();
    }
    // Quoted, it is only text.
    expect(trimmed('echo "a\u3000b"')).toEqual(['echo "a\u3000b"']);
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

describe('isBashCommandKeyword', () => {
  it('knows the keywords a command follows, and no program', () => {
    for (const word of ['if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time', 'coproc']) {
      expect(isBashCommandKeyword(word), word).toBe(true);
    }
    for (const word of ['for', 'fi', 'done', 'ls', 'do echo', 'git status', '']) {
      expect(isBashCommandKeyword(word), word).toBe(false);
    }
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
