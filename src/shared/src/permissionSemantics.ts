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
 *  - CODEX    partial — in an ask-me mode the runner starts it with approvalPolicy "untrusted",
 *                       and in Auto with "on-request"; both bridge its approval requests to the
 *                       same card. Those cover command execution and patches — its dangerous
 *                       primitives — but not every tool, and Don't Ask is still not enforced
 *                       (see below).
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
 * The Claude models that accept `--permission-mode auto`; Claude Code rejects it on the rest
 * (notably Haiku). The single copy — the server's dispatch normalization and every client's
 * picker read this one, instead of the three hand-synced sets that used to disagree.
 *
 * Still a static table, and still the wrong shape long-term for the same reason the model list
 * and the context window were moved off static tables: the answer belongs to the CLI that runs
 * the model, so it goes stale a release before anyone notices. Replacing it means having the
 * runner report each runtime's permission modes in the heartbeat catalog, next to the reasoning
 * levels it already reports per model.
 */
export const AUTO_CAPABLE_CLAUDE_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5',
  'claude-fable-5',
  'claude-sonnet-5',
]);

/**
 * Whether Auto — "let the model decide when to ask a human" — is a mode this runtime actually has.
 *
 * Every runtime but Claude has it runtime-wide, for any model: Codex spells it `on-request` ("the
 * model decides when to ask the user for approval"), Kimi and OpenCode expose it as a plain mode.
 * Claude alone makes it model-specific. A configured (BYOK) provider's model space is
 * vendor-defined, so the Claude allow-list cannot police it and the CLI decides for itself.
 *
 * `runtime` is the built-in runtime that executes the session, not the persisted provider slug —
 * resolve a configured slug to its runtime first, as both callers already do.
 */
export function autoAvailable(runtime: string, model: string, customProvider = false): boolean {
  if (runtime !== AgentProvider.CLAUDE) return true;
  return customProvider || AUTO_CAPABLE_CLAUDE_MODELS.has(model);
}

/**
 * Permission modes a runner deployed as root cannot run at all.
 *
 * Claude Code refuses Bypass outright when its own process is root — it prints
 * "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons"
 * and exits during startup, before any stream-json message. The session dies on its first turn with
 * no model ever in the loop, and because the refusal arrives on stderr rather than as a run result
 * it lands as a bare FAILED. Every other mode (Default, Plan, Accept Edits, Auto, Don't Ask) starts
 * normally as root, so this set is deliberately one entry and not "the unsafe ones".
 *
 * This is the one dimension `autoAvailable` above cannot express: it is a property of how the
 * runner was *deployed*, not of the model or the runtime. The runner reports the bare fact
 * (`runsAsRoot`) and the consequence lives here, in the table the pickers and dispatch already
 * share, so neither can invent a different answer.
 */
export const ROOT_REFUSED_PERMISSION_MODES: ReadonlySet<string> = new Set([PermissionMode.BYPASS]);

/**
 * What a root runner runs instead of a mode it must refuse. Don't Ask is the honest neighbour of
 * Bypass: both never consult a human, so an unattended session still runs unattended rather than
 * parking on an approval card nobody is watching — but an action nobody pre-approved is denied
 * instead of allowed. Strictly narrower than what was asked for, which is the only direction a
 * substitution may ever go.
 */
export const ROOT_FALLBACK_PERMISSION_MODE = PermissionMode.DONT_ASK;

/**
 * Whether a runner can actually run a mode.
 *
 * `runsAsRoot` is nullable on purpose. A runner too old to report it, or one that has not
 * heartbeated since this shipped, reads as unrestricted: an unknown must never remove a mode that
 * works today. The cost of that choice is the pre-existing failure, unchanged, on exactly the
 * runners that cannot yet say — and the cost of the opposite choice would be silently withdrawing
 * Bypass from every non-root runner in the fleet.
 */
export function permissionModeAvailableOnRunner(
  mode: string,
  runsAsRoot?: boolean | null,
): boolean {
  return !runsAsRoot || !ROOT_REFUSED_PERMISSION_MODES.has(mode);
}

/**
 * Resolve a permission mode against the runtime that will honor it — the single answer to "what
 * will this session actually do with an action nobody pre-approved".
 *
 * Deliberately derived and never written back onto the session: the persisted mode is the user's
 * INTENT. Rewriting it would either overstate safety (recording "deny" for a runtime that in fact
 * allows) or silently widen trust later, because a session whose mode was rewritten to a broader
 * one keeps that value when it is switched to a runtime that would have honored the original.
 *
 * `model` is optional and only changes the answer for Auto, the one mode Claude gates per model.
 * Pass it where a mode is being described against a specific model — a composer picker — and omit
 * it where the mode has already been normalized for dispatch.
 *
 * `runsAsRoot` is the assigned runner's report about itself, and likewise only changes the answer
 * for Bypass. Omit it where no single runner is in view (an account-level default applies across a
 * fleet, and one root machine in it must not describe the setting for all of them).
 */
export function derivePermissionSemantics(
  provider: string,
  permissionMode?: string | null,
  model?: string,
  runsAsRoot?: boolean | null,
): PermissionSemantics {
  const mode = (permissionMode ?? PermissionMode.DONT_ASK) as string;
  const approvalSupport = runtimeApprovalSupport(provider);

  // Bypass on a runner deployed as root. Unlike every other unhonored mode here this one is not a
  // difference of degree: the CLI refuses to start at all, so the session produces nothing. It runs
  // as Don't Ask instead (normalizeBuiltinPermissionMode), which still never asks — disclosed here
  // rather than hidden, on the same terms as Auto below.
  if (!permissionModeAvailableOnRunner(mode, runsAsRoot)) {
    return {
      mode,
      unapproved: 'deny',
      approvalSupport,
      honored: false,
      note:
        'This runner is deployed as root, and Claude Code refuses Bypass under root. The session ' +
        "runs as Don't Ask instead: it never asks, but an action nobody pre-approved is denied.",
      shortNote: 'unavailable on a root runner, runs as Don’t Ask',
    };
  }

  // Auto on a Claude model that does not have it. The session runs as Default instead
  // (normalizeBuiltinPermissionMode), which asks — so this is a safe degradation, and it is
  // disclosed rather than hidden: the mode is the account's stored intent and starts applying the
  // moment the session moves to a model that has it, exactly like every other unhonored mode here.
  if (mode === PermissionMode.AUTO && model !== undefined && !autoAvailable(provider, model)) {
    return {
      mode,
      unapproved: 'ask',
      approvalSupport,
      honored: false,
      note:
        'Auto needs Opus 5, Fable 5 or Sonnet 5. On this model the session runs as Default, so ' +
        'you are asked before an action nobody pre-approved.',
      shortNote: 'not available on this model, runs as Default',
    };
  }

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
      shortNote: 'not enforced here, everything is allowed',
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
        shortNote: 'not enforced here, unapproved actions are denied',
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
