import type { PermissionRule } from './dto';

// Shared rather than client-side because the same decomposition has to run twice, at two ends
// of a rule's life: once in the client that DERIVES a rule from a command a human approved, and
// once in the control plane that decides whether a later command is COVERED by that rule. Two
// implementations would drift, and a drift here means a rule quietly grants something other than
// what it was created from.

// Split a shell command into its top-level sub-commands at unquoted ; && || | and
// newlines, so every real command in a compound line can get its own allow rule — claude
// gates each segment separately, so remembering only the leading one (e.g. `cd`) leaves
// the rest re-prompting. Quote- and backslash-aware so an operator inside a quoted string
// stays literal (e.g. the | in grep "a\|b"). Best-effort, not a full shell parser.
export function bashSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\' && i + 1 < cmd.length) {
      cur += c + cmd[i + 1];
      i++;
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    if ((c === '&' || c === '|') && cmd[i + 1] === c) {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === '|') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
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
  const seen = new Set<string>();
  const rules: PermissionRule[] = [];
  for (const seg of bashSegments(cmd)) {
    const p = bashPrefix(seg);
    if (p && !seen.has(p)) {
      seen.add(p);
      rules.push({ toolName: 'Bash', ruleContent: `${p}:*` });
    }
  }
  return rules;
}
