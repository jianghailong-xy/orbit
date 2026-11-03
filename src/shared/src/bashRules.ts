import type { PermissionRule } from './dto';

// Shared rather than client-side because the same decomposition has to run twice, at two ends
// of a rule's life: once in the client that DERIVES a rule from a command a human approved, and
// once in the control plane that decides whether a later command is COVERED by that rule. Two
// implementations would drift, and a drift here means a rule quietly grants something other than
// what it was created from.

const SHELL_WRAPPER_PROGRAMS = new Set([
  'bash',
  '/bin/bash',
  '/usr/bin/bash',
  'sh',
  '/bin/sh',
  '/usr/bin/sh',
  'zsh',
  '/bin/zsh',
  '/usr/bin/zsh',
]);

/** A wrapper prefix is never a useful standing grant: `/bin/bash:*` covers every command that
 * the wrapper may execute. Keep this predicate shared with the server so old or hand-written
 * rules cannot recreate the broad grant that the clients refuse to derive. */
export function isBashShellWrapperPrefix(prefix: string): boolean {
  return SHELL_WRAPPER_PROGRAMS.has(prefix.trim());
}

const COMMAND_KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', 'time', 'coproc']);

/** A shell keyword that a command follows is no program, and a rule naming one would not narrow
 * anything: `do:*` covers every command a loop runs. Shared for the same reason as the wrapper check
 * above. `do echo:*` is another matter: it names the program. */
export function isBashCommandKeyword(prefix: string): boolean {
  return COMMAND_KEYWORDS.has(prefix.trim());
}

/** Whether one command segment invokes a shell with `-c`/`-lc`-style command execution. */
export function isBashShellWrapperCommand(segment: string): boolean {
  const toks = segment.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  const program = toks[i];
  if (!program || !isBashShellWrapperPrefix(program)) return false;
  const option = toks[i + 1];
  return option === '--command' || /^-[A-Za-z]*c[A-Za-z]*$/.test(option ?? '');
}

/** What ends a word without being part of the next one, apart from the separators that end a segment. */
const WORD_BREAKS = new Set([' ', '\t', '&', '(', ')', '<', '>']);

/** Text in a comment that a reader who does not take `#` as a comment would act on. */
const ACTIVE_IN_A_COMMENT = /[;&|<>()$`'"\\]/;

/** Characters JS counts as space or as nothing, while a shell takes them as part of a word. */
const NOT_A_SHELL_SPACE = /[\x00-\x08\x0b-\x1f\x7f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/**
 * One pass over a shell line, by the rules that decide where a shell ends a command: nothing escapes
 * inside single quotes, a backslash escapes in double quotes and outside them, and a `#` where a word
 * could start runs to the end of the line. `readable` is false when the line can be taken two ways,
 * which a caller deciding whether a rule covers it has to read as "ask".
 */
function scanBashLine(cmd: string): { segments: string[]; readable: boolean } {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | "$'" | null = null;
  let readable = true;
  let atWordStart = true;
  const endSegment = () => {
    segments.push(cur);
    cur = '';
    atWordStart = true;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      cur += c;
      if (c === "'") {
        quote = null;
        // Closes here, but stays open in a shell that escapes inside single quotes.
        if (cmd[i - 1] === '\\') readable = false;
      }
      continue;
    }
    if (quote) {
      if (c === '\\' && i + 1 < cmd.length) {
        cur += c + cmd[++i];
        continue;
      }
      cur += c;
      if (c === quote[quote.length - 1]) quote = null;
      continue;
    }
    if (c === '\\') {
      cur += c;
      if (i + 1 === cmd.length) {
        readable = false;
        continue;
      }
      const next = cmd[++i];
      cur += next;
      // A line continuation is as if neither character were there, so the word state stays.
      if (next !== '\n') atWordStart = false;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      atWordStart = false;
      continue;
    }
    if (c === '$' && cmd[i + 1] === "'") {
      // ANSI-C quoting: unlike plain single quotes, a backslash escapes in it.
      quote = "$'";
      cur += "$'";
      i++;
      atWordStart = false;
      readable = false;
      continue;
    }
    if (c === '#' && atWordStart) {
      const newline = cmd.indexOf('\n', i);
      const end = newline < 0 ? cmd.length : newline;
      if (ACTIVE_IN_A_COMMENT.test(cmd.slice(i, end))) readable = false;
      i = end - 1;
      continue;
    }
    if (c === ';' || c === '\n') {
      endSegment();
      continue;
    }
    if ((c === '&' || c === '|') && cmd[i + 1] === c) {
      endSegment();
      i++;
      continue;
    }
    if (c === '|') {
      endSegment();
      continue;
    }
    // A subshell, or in zsh a glob qualifier, which can run code.
    if (c === '(' || c === ')' || NOT_A_SHELL_SPACE.test(c)) readable = false;
    cur += c;
    atWordStart = WORD_BREAKS.has(c);
  }
  segments.push(cur);
  return { segments, readable: readable && quote === null };
}

// Split a shell command into its top-level sub-commands at unquoted ; && || | and
// newlines, so every real command in a compound line can get its own allow rule — claude
// gates each segment separately, so remembering only the leading one (e.g. `cd`) leaves
// the rest re-prompting. Quote- and backslash-aware so an operator inside a quoted string
// stays literal (e.g. the | in grep "a\|b"), and comments are dropped. Best-effort, not a
// full shell parser.
export function bashSegments(cmd: string): string[] {
  return scanBashLine(cmd).segments;
}

/**
 * Sets a variable for what runs next, behind any keywords: `FOO=bar`, `env FOO=bar` (or `env` running
 * anything else) and the builtins that assign. No rule has seen the value, and it can change what
 * a program is (`PATH=`), what it loads (`LD_PRELOAD=`) or what it does. `env` alone only prints.
 */
const SETS_VARIABLES =
  /^(?:(?:if|then|elif|else|while|until|do|time|coproc)\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=|env\s|(?:export|declare|typeset|readonly|local)(?:\s|$))/;

/**
 * `PATH` as a word, quotes and backslashes aside: the builtins that set a variable without looking like
 * an assignment (`read PATH`, `for PATH in`, `printf -v PATH`), which would change what every later
 * program in the line is. `$PATH` only reads it.
 */
const NAMES_PATH = /(?:^|[^$\w]|-v)PATH(?!\w)/;
const QUOTING = /\\\n|['"\\]/g;

/**
 * The sub-commands of a line, or null when what it runs cannot be told from them: `bashSegments`
 * for the question "is this line covered by a rule?", which has to answer "ask" whenever it is unsure.
 * That is why an assignment is unreadable here though `bashPrefix` skips it: a rule remembered from
 * `FOO=bar git diff` names `git diff`, and covers it without the assignment.
 */
export function readableBashSegments(cmd: string): string[] | null {
  const { segments, readable } = scanBashLine(cmd.replace(/^[ \t\n]+|[ \t\n]+$/g, ''));
  if (!readable) return null;
  const setsVariables = (segment: string) =>
    SETS_VARIABLES.test(segment.trim()) || NAMES_PATH.test(segment.replace(QUOTING, ''));
  return segments.some(setsVariables) ? null : segments;
}

// The leading command word(s) of one sub-command, to auto-allow as "same kind" — claude
// then matches future calls against `Bash(<prefix>:*)`. Skip FOO=bar env assignments,
// take the program word, and add one following sub-command word when it looks like one
// (not a flag/path/operator), so `git commit -m x` → "git commit" and `ls -la` → "ls".
export function bashPrefix(segment: string): string | null {
  const toks = segment.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
  const prog = toks[i];
  if (!prog || !/^[A-Za-z./_-][\w./-]*$/.test(prog)) return null; // not a clean program word
  const next = toks[i + 1];
  return next && /^[A-Za-z][\w-]*$/.test(next) ? `${prog} ${next}` : prog;
}

// One session-permission rule per distinct sub-command of a Bash line, so `cd x && git
// add …` remembers both `cd` and `git add`, not just the leading `cd`. Empty when the
// command is blank or no segment yields a clean prefix.
export function bashCommandRules(cmd: string): PermissionRule[] {
  if (!cmd.trim()) return [];
  // Codex sends commands as `/bin/bash -lc '…'`. Remembering the wrapper would create a
  // rule equivalent to `Bash(/bin/bash:*)`, which is a standing grant for arbitrary shell code.
  // A compound command containing a wrapper is equally unsafe to summarize by prefixes.
  if (bashSegments(cmd).some(isBashShellWrapperCommand)) return [];
  const seen = new Set<string>();
  const rules: PermissionRule[] = [];
  for (const seg of bashSegments(cmd)) {
    const p = bashPrefix(seg);
    if (p && !seen.has(p) && !isBashCommandKeyword(p)) {
      seen.add(p);
      rules.push({ toolName: 'Bash', ruleContent: `${p}:*` });
    }
  }
  return rules;
}
