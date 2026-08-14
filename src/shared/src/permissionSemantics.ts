import { AgentProvider, PermissionMode } from './enums';
import type { ApprovalSupport, PermissionSemantics } from './dto';

/**
 * Whether a runtime can put a human in the loop, which is what a permission mode is really
 * asking for. Verified against the runner:
 *
 *  - CLAUDE   full    — `--permission-prompt-tool mcp__orbit__permission_prompt` blocks on a human
 *                       and fails CLOSED if the control plane is unreachable.
 *  - KIMI     partial — ACP permission requests are bridged to the same approval UI, but Kimi
 *                       never asks about tools it deems safe, and a denylist cannot be enforced
 *                       ahead of execution (the runner refuses to start rather than pretend).
 *  - OPENCODE none    — driven as a one-shot non-interactive CLI, which REJECTS an "ask"
 *                       decision; there is no channel to answer.
 *  - CODEX    partial — in an ask-me mode the runner starts it with approvalPolicy "untrusted"
 *                       and bridges its approval requests to the same card. Those cover command
 *                       execution and patches — its dangerous primitives — but not every tool,
 *                       and Don't Ask is still not enforced (see below).
 *
 * Shared rather than server-only so the composer can describe a session it has not created yet
 * with the same table the server will apply to it. Update it together with the runner; this is
 * the claim the UI shows to users.
 */
export function runtimeApprovalSupport(provider: string): ApprovalSupport {
  switch (provider) {
    case AgentProvider.CLAUDE:
      return 'full';
    case AgentProvider.KIMI:
    case AgentProvider.CODEX:
      return 'partial';
    default:
      return 'none';
  }
}

/** Modes whose whole point is that a human is consulted before an unapproved action. */
const ASK_MODES: ReadonlySet<string> = new Set([
  PermissionMode.DEFAULT,
  PermissionMode.ACCEPT_EDITS,
  PermissionMode.PLAN,
]);

/** Modes that deliberately never ask and simply allow. */
const ALLOW_MODES: ReadonlySet<string> = new Set([PermissionMode.AUTO, PermissionMode.BYPASS]);

/**
 * Resolve a permission mode against the runtime that will honor it — the single answer to "what
 * will this session actually do with an action nobody pre-approved".
 *
 * Deliberately derived and never written back onto the session: the persisted mode is the user's
 * INTENT. Rewriting it would either overstate safety (recording "deny" for a runtime that in fact
 * allows) or silently widen trust later, because a session whose mode was rewritten to a broader
 * one keeps that value when it is switched to a runtime that would have honored the original.
 */
export function derivePermissionSemantics(
  provider: string,
  permissionMode?: string | null,
): PermissionSemantics {
  const mode = (permissionMode ?? PermissionMode.DONT_ASK) as string;
  const approvalSupport = runtimeApprovalSupport(provider);

  // Codex enforces the ask-me modes (approvals bridged to the same card) but NOT Don't Ask: it is
  // never handed an allowlist, so fail-closed autonomy would deny every command in the mode agents
  // default to. Approvals therefore stay off there and unapproved actions run.
  if (provider === AgentProvider.CODEX && !ASK_MODES.has(mode) && !ALLOW_MODES.has(mode)) {
    return {
      mode,
      unapproved: 'allow',
      approvalSupport,
      honored: false,
      note:
        "Don't Ask is not enforced on Codex: it takes no allowlist, so approvals stay off and " +
        'actions you have not pre-approved still run.',
    };
  }

  if (ALLOW_MODES.has(mode)) {
    return { mode, unapproved: 'allow', approvalSupport, honored: true };
  }

  if (ASK_MODES.has(mode)) {
    if (approvalSupport === 'none') {
      // OpenCode: no way to ask, so an unapproved action is refused rather than waved through.
      return {
        mode,
        unapproved: 'deny',
        approvalSupport,
        honored: false,
        note:
          'This runtime cannot ask for approval, so actions you have not pre-approved are ' +
          'denied instead of prompting you.',
      };
    }
    return {
      mode,
      unapproved: 'ask',
      approvalSupport,
      honored: true,
      ...(approvalSupport === 'partial'
        ? {
            note:
              provider === AgentProvider.CODEX
                ? 'Codex asks before running commands and applying patches; commands it considers ' +
                  'safe and read-only run without asking.'
                : 'This runtime decides which tools warrant a prompt; the ones it considers safe ' +
                  'run without asking.',
          }
        : {}),
    };
  }

  // Don't Ask: fail-closed autonomy. Every remaining runtime implements it as a refusal.
  return {
    mode,
    unapproved: 'deny',
    approvalSupport,
    honored: true,
    ...(approvalSupport === 'partial'
      ? { note: 'Tools this runtime considers safe still run without a prompt.' }
      : {}),
  };
}
