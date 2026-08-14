import { AgentProvider } from '@orbit/shared';
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
 * rather than skip a prompt someone already answered — and a rule can only have been created on
 * a runtime that asked in the first place. `provider` is the runner-facing built-in runtime,
 * already resolved from any configured slug.
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
