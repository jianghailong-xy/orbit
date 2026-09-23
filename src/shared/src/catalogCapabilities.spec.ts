import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentProvider, PermissionMode } from './enums';
import { AUTO_CAPABLE_CLAUDE_MODELS, autoAvailable } from './permissionSemantics';
import { FAST_MODE_CAPABLE_CLAUDE_MODELS, fastModeAvailable } from './models';

/**
 * The two static Claude tables are fallbacks, not gates — so with both EMPTIED, a model the
 * assigned runner reports still has exactly the capabilities it reports.
 *
 * Asserted by actually emptying them rather than by reading the code, because "the catalogue is
 * consulted" and "the catalogue is consulted and then a table quietly has the last word" produce
 * identical results on every model both happen to agree about. Emptying is the only way to tell
 * a capability that comes from the runner apart from one the table got right by coincidence.
 */
describe('with both static Claude tables emptied', () => {
  const auto = AUTO_CAPABLE_CLAUDE_MODELS as Set<string>;
  const fast = FAST_MODE_CAPABLE_CLAUDE_MODELS as Set<string>;
  const autoWas = [...auto];
  const fastWas = [...fast];

  // Opus 5.5 as a runner with Claude Code 2.1.280 reports it: Auto among its permission modes,
  // and the fast lane. Both were measured from the CLI's own answers (its stream-json init frame
  // settles `--permission-mode auto` to `default` on a model without Auto, and `/fast` refuses
  // out loud on a model without the lane).
  const catalog = {
    [AgentProvider.CLAUDE]: [
      {
        value: 'claude-opus-5-5',
        label: 'Opus 5.5',
        permissionModes: [
          PermissionMode.DEFAULT,
          PermissionMode.ACCEPT_EDITS,
          PermissionMode.PLAN,
          PermissionMode.AUTO,
          PermissionMode.DONT_ASK,
          PermissionMode.BYPASS,
        ],
        fastMode: true,
      },
      {
        value: 'claude-haiku-4-5',
        label: 'Haiku 4.5',
        permissionModes: [PermissionMode.DEFAULT, PermissionMode.PLAN],
        fastMode: false,
      },
    ],
  };

  beforeAll(() => {
    auto.clear();
    fast.clear();
  });
  afterAll(() => {
    autoWas.forEach((model) => auto.add(model));
    fastWas.forEach((model) => fast.add(model));
  });

  it('still offers Auto and the fast lane on the model the runner reports them for', () => {
    expect(autoAvailable(AgentProvider.CLAUDE, 'claude-opus-5-5', false, catalog)).toBe(true);
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-opus-5-5', catalog)).toBe(true);
  });

  it('still withholds both on the model the runner reports them absent for', () => {
    expect(autoAvailable(AgentProvider.CLAUDE, 'claude-haiku-4-5', false, catalog)).toBe(false);
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-haiku-4-5', catalog)).toBe(false);
  });

  it('answers a model no runner has reported with the emptied tables, which is now no', () => {
    // The other half of the same claim: with nothing in the tables there is nothing to fall back
    // ON, so a silence really does resolve through them. This is what makes the first two cases
    // evidence — they cannot be the tables answering, because the tables answer nothing here.
    expect(autoAvailable(AgentProvider.CLAUDE, 'claude-opus-5', false, catalog)).toBe(false);
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-opus-5', catalog)).toBe(false);
  });
});
