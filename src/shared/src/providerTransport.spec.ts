import { describe, expect, it } from 'vitest';
import { AgentProvider } from './enums';
import { PROVIDER_TRANSPORTS, SESSION_CODEX_STEER_V1, supportsMidTurnSteer } from './providerTransport';

/**
 * Which runtimes a message may be written INTO the running turn for, and on whose word.
 *
 * The answer decides a `steer` before the turn is filed. Get it wrong upward and the message
 * is leased by a session loop with no case for it — and a steer's lease is never reclaimed,
 * so it is gone. Get it wrong downward and the message merely queues, which is what it always
 * did. Every default below therefore falls the second way.
 */

const DECLARED = [SESSION_CODEX_STEER_V1];

describe('supportsMidTurnSteer', () => {
  it('lets claude steer on any runner that speaks the kind at all', () => {
    // Claude's mid-turn delivery shipped WITH the steer kind, so every runner in the field
    // already does this. Requiring a new declaration would withdraw a working feature from
    // the entire installed fleet on the day the control plane deployed.
    expect(supportsMidTurnSteer(AgentProvider.CLAUDE)).toBe(true);
    expect(supportsMidTurnSteer(AgentProvider.CLAUDE, [])).toBe(true);
  });

  it('lets codex steer only on a runner that has declared it', () => {
    expect(supportsMidTurnSteer(AgentProvider.CODEX, DECLARED)).toBe(true);
    // A runner that predates `turn/steer` refuses every steer handed to it, loudly. Filing one
    // for it would turn today's quiet queueing into a visible failure on every mid-turn message.
    expect(supportsMidTurnSteer(AgentProvider.CODEX, [])).toBe(false);
    expect(supportsMidTurnSteer(AgentProvider.CODEX, ['session-worktree-ops-v1'])).toBe(false);
  });

  it('treats an unknown capability set as not declared, never as permission', () => {
    // Nothing to consult — no runner assigned yet, or a caller that cannot see one. The
    // message queues, exactly as it does today.
    expect(supportsMidTurnSteer(AgentProvider.CODEX)).toBe(false);
  });

  it('keeps kimi and opencode queueing however capable the runner claims to be', () => {
    // The bug this closes was deriving the answer from the transport. Codex and kimi are both
    // json-rpc; only one of them has anything to fold a message into.
    expect(PROVIDER_TRANSPORTS[AgentProvider.KIMI]).toBe(PROVIDER_TRANSPORTS[AgentProvider.CODEX]);
    expect(supportsMidTurnSteer(AgentProvider.KIMI, DECLARED)).toBe(false);
    expect(supportsMidTurnSteer(AgentProvider.OPENCODE, DECLARED)).toBe(false);
  });

  it('says no to a runtime it has never heard of', () => {
    // A configured (BYOK) slug reaches here only through execRuntime; anything else is a
    // runtime this build does not know, and an unknown engine cannot be written to mid-turn.
    expect(supportsMidTurnSteer('some-openai-endpoint', DECLARED)).toBe(false);
  });

  it('reads a declaration the way the runner header is parsed', () => {
    // Runner.capabilities is stored lowercased and trimmed (parseRunnerCapabilities); matching
    // the same way keeps a header read and a stored read from disagreeing about one runner.
    expect(supportsMidTurnSteer(AgentProvider.CODEX, [` ${SESSION_CODEX_STEER_V1.toUpperCase()} `])).toBe(true);
  });
});
