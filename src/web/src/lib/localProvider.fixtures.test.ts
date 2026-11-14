import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AgentProvider,
  localProviderReadiness,
  localProviderRemedy,
  localProviderStatus,
  localTargetModel,
  type LocalProviderRefusalCode,
} from '@orbit/shared';
import {
  contextWindowFor,
  defaultModelFor,
  effortOptionsFor,
  modelOptionsFor,
  type ConfiguredProvider,
} from './workspaceDefaults';
import {
  engineChoices,
  engineProviders,
  localChoiceFor,
  localFixTarget,
  type ChoiceSources,
} from './sessionProviderChoices';

/**
 * The shared case file `contracts/ollama-provider.fixtures.json` — the same bytes OrbitKit's
 * `LocalProviderFixtureTests` reads. Each case is one server response plus the session it would run
 * and the answer both clients must give: the status, the default model, the refusal (its code, its
 * sentence and where it is fixed), the context window, the efforts and the model options.
 *
 * This is the Web half of the phase 4B parity: a local provider must read the same in the browser
 * and in the native clients, or the two pickers disagree about what can run.
 */
interface FixtureCase {
  name: string;
  now: string;
  row: ConfiguredProvider;
  runner: { capabilities: string[] | null; capabilitiesReportedAt: string | null } | null;
  session: { runnerId: string | null; model: string | null };
  sessionRunner: { capabilities: string[] | null; capabilitiesReportedAt: string | null } | null;
  expect: {
    state: string;
    capability: string;
    targetModel: string | null;
    refusal: { code: LocalProviderRefusalCode; message: string } | null;
    remedy: 'provider' | 'runner' | null;
    contextWindow: number | null;
    efforts: string[];
    modelOptions: string[];
    canChoose: boolean;
  };
}

const FIXTURES: { version: number; cases: FixtureCase[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../contracts/ollama-provider.fixtures.json', import.meta.url)), 'utf8'),
);

describe('the shared Ollama provider fixtures, as the web reads them', () => {
  for (const fixture of FIXTURES.cases) {
    it(fixture.name, () => {
      const now = Date.parse(fixture.now);
      const row = fixture.row;

      // The status a picker draws: what the bound runner made of the row's last probe.
      const status = localProviderStatus(row, fixture.runner, now);
      expect(status.state, 'state').toBe(fixture.expect.state);
      expect(status.capability, 'capability').toBe(fixture.expect.capability);

      // The model a session would run: its own, else the row's default, else the first it names.
      const target = localTargetModel(row, fixture.session.model);
      expect(target, 'target model').toBe(fixture.expect.targetModel);
      // Web's default-model rule agrees on that same answer when the session names none — and
      // never falls back to the Claude default on an empty local row.
      if (fixture.session.model == null) {
        expect(defaultModelFor(AgentProvider.CLAUDE, row.slug, null, [row], undefined) || null,
          'default model').toBe(fixture.expect.targetModel);
      }

      // Whether the session may run there now, in the server's own words.
      const refusal = localProviderReadiness(row, {
        runnerId: fixture.session.runnerId,
        runner: fixture.sessionRunner,
        model: target,
      }, now);
      expect(refusal?.code ?? null, 'refusal code').toBe(fixture.expect.refusal?.code ?? null);
      expect(refusal?.message ?? null, 'refusal message').toBe(fixture.expect.refusal?.message ?? null);
      expect(refusal ? localProviderRemedy(refusal.code) : null, 'remedy')
        .toBe(fixture.expect.remedy);
      expect(refusal == null, 'can choose').toBe(fixture.expect.canChoose);

      // The composer's context gauge and effort menu read the same pair.
      expect(contextWindowFor(target, null, [row], row.slug) ?? null, 'context window')
        .toBe(fixture.expect.contextWindow);
      expect(effortOptionsFor(AgentProvider.CLAUDE, row.slug, target, null, [row]).map((o) => o.value),
        'efforts').toEqual(fixture.expect.efforts);

      // The model menu: the row's own models, then what the instance's runner discovered.
      expect(modelOptionsFor(AgentProvider.CLAUDE, row.slug, null, [row]).map((o) => o.value),
        'model options').toEqual(fixture.expect.modelOptions);
    });
  }

  // The picker's own reading of the same row: what the browser lists, disables and links to.
  const ready = FIXTURES.cases.find((c) => c.name === 'ready')!;
  const sources = (over: Partial<ChoiceSources> = {}): ChoiceSources => ({
    configured: [ready.row],
    engineHealth: [{ engine: AgentProvider.CLAUDE, installed: true, auth: 'yes' }],
    localRunner: { id: 'runner-a', name: 'studio-mac', capabilities: ['ollama-probe/v1', 'ollama-run/v1'] },
    sessionModel: null,
    now: Date.parse(ready.now),
    ...over,
  });

  it('offers a ready Ollama under Claude Code with its status and model', () => {
    const choice = localChoiceFor(ready.row, sources());
    expect(choice?.state).toBe('READY');
    expect(choice?.stateLabel).toBe('Ready');
    expect(choice?.summary).toBe('Ready · 0.40.16');
    expect(choice?.model).toBe('qwen3.8:27b');
    expect(choice?.refusal).toBeUndefined();

    const row = engineProviders(AgentProvider.CLAUDE, sources()).find((c) => c.slug === 'ollama');
    expect(row?.unavailable).toBeUndefined();
    expect(row?.glyphKey).toBe('ollama');
    expect(row?.modelLabel).toBe('Qwen3.8 27B');
  });

  it('reads a derived state the server served back in as the same state', () => {
    // The provider payload serves a derived `state`, not the stored probe column: STALE must read
    // back as STALE, and DISABLED without an `enabled` column must read as off.
    const stale = { ...ready.row, local: { ...ready.row.local!, state: 'STALE', probedAt: '2026-11-13T23:00:00Z' } };
    const staleChoice = localChoiceFor(stale, sources({ configured: [stale] }));
    expect(staleChoice?.state).toBe('STALE');
    expect(staleChoice?.refusal?.code).toBe('LOCAL_PROVIDER_STALE');
    expect(staleChoice?.remedy).toBe('runner');

    const off = { ...ready.row, enabled: undefined, local: { ...ready.row.local!, state: 'DISABLED' } };
    const offChoice = localChoiceFor(off, sources({ configured: [off] }));
    expect(offChoice?.state).toBe('DISABLED');
    expect(offChoice?.refusal?.code).toBe('LOCAL_PROVIDER_DISABLED');
    expect(offChoice?.remedy).toBe('provider');
  });

  it('targets the provider-bound runner for every runner remedy, ELSEWHERE included', () => {
    // ELSEWHERE: the session is on runner-b while the row is bound to runner-a.
    const elsewhere = localChoiceFor(ready.row, sources({
      localRunner: { id: 'runner-b', capabilities: ['ollama-probe/v1', 'ollama-run/v1'] },
    }));
    expect(elsewhere?.refusal?.code).toBe('LOCAL_PROVIDER_ELSEWHERE');
    expect(elsewhere?.runnerId).toBe('runner-a');
    expect(localFixTarget({ fixProvider: undefined, local: elsewhere }))
      .toEqual({ kind: 'runner', id: 'runner-a' });
    expect(localFixTarget({ fixProvider: undefined, local: elsewhere }))
      .not.toEqual({ kind: 'runner', id: 'runner-b' });

    // A same-runner state: the fix target is still the row's runner.
    const offlineRow = FIXTURES.cases.find((c) => c.name === 'unreachable')!.row;
    const offline = localChoiceFor(offlineRow, sources({ configured: [offlineRow] }));
    expect(offline?.refusal?.code).toBe('LOCAL_PROVIDER_UNREACHABLE');
    expect(localFixTarget({ fixProvider: undefined, local: offline }))
      .toEqual({ kind: 'runner', id: 'runner-a' });
  });

  it('reads a missing capability report as a runner that has not said, not as no runner', () => {
    // The row names its runner; `capabilities` is a separate report that has not arrived. The
    // server, the shared fixture and OrbitKit's production path all answer UNKNOWN/runner-outdated.
    const choice = localChoiceFor(ready.row, sources({
      configured: [ready.row],
      localRunner: { id: 'runner-a', capabilities: undefined },
    }));
    expect(choice?.state).toBe('UNKNOWN');
    expect(choice?.state).not.toBe('NO_RUNNER');
    expect(choice?.runnerId).toBe('runner-a');
    expect(choice?.refusal?.code).toBe('LOCAL_PROVIDER_RUNNER_OUTDATED');
    const oldRunner = FIXTURES.cases.find((c) => c.name === 'old-runner')!;
    expect(choice?.refusal?.message).toBe(oldRunner.expect.refusal!.message);
  });

  it('disables the row before a submit when the session is elsewhere or the instance is down', () => {
    const elsewhere = engineProviders(
      AgentProvider.CLAUDE,
      sources({ localRunner: { id: 'runner-b', capabilities: ['ollama-probe/v1', 'ollama-run/v1'] } }),
    ).find((c) => c.slug === 'ollama');
    expect(elsewhere?.unavailable).toBe(
      'Local provider "ollama" runs only on the runner it is bound to; start this session on that runner');
    expect(elsewhere?.fixEngine).toBeUndefined();
    expect(elsewhere?.fixHref).toBeUndefined();

    const offlineRow = FIXTURES.cases.find((c) => c.name === 'unreachable')!.row;
    const offline = engineProviders(AgentProvider.CLAUDE, sources({ configured: [offlineRow] }))
      .find((c) => c.slug === 'ollama');
    expect(offline?.unavailable).toBe(
      'Local provider "ollama" is not answering on its runner (stopped, still loading, or busy); '
      + 'this session starts once it answers');
    expect(offline?.local?.remedy).toBe('runner');
  });

  it('points a model or capability refusal at the provider page, and never lands a pick on it', () => {
    const removed = FIXTURES.cases.find((c) => c.name === 'model-removed')!.row;
    const row = engineProviders(AgentProvider.CLAUDE, sources({ configured: [removed], sessionModel: 'qwen3.5:4b' }))
      .find((c) => c.slug === 'ollama');
    expect(row?.unavailable).toBe(
      'Local provider "ollama" does not serve model "qwen3.5:4b"; pull it on its runner or choose another');
    expect(row?.local?.remedy).toBe('provider');
    expect(row?.fixHref).toBe('/settings/providers');
    expect(row?.fixEngine).toBeUndefined();
    // Every credential that cannot run leaves the engine landing on what can — its own sign-in —
    // rather than offering the dead local row as the pick.
    const hero = engineChoices(sources({ configured: [removed], sessionModel: 'qwen3.5:4b' }))
      .find((e) => e.slug === AgentProvider.CLAUDE);
    expect(hero?.provider?.slug).not.toBe('ollama');
    expect(hero?.providers.some((c) => c.slug === 'ollama')).toBe(true);
  });

  it('covers every refusal a local provider gives a session', () => {
    const codes = new Set(FIXTURES.cases.map((c) => c.expect.refusal?.code).filter(Boolean));
    expect([...codes].sort()).toEqual([
      'LOCAL_PROVIDER_CAPABILITY_MISSING',
      'LOCAL_PROVIDER_DISABLED',
      'LOCAL_PROVIDER_ELSEWHERE',
      'LOCAL_PROVIDER_MISCONFIGURED',
      'LOCAL_PROVIDER_MODEL_MISSING',
      'LOCAL_PROVIDER_NO_MODELS',
      'LOCAL_PROVIDER_NO_RUNNER',
      'LOCAL_PROVIDER_RUNNER_OUTDATED',
      'LOCAL_PROVIDER_STALE',
      'LOCAL_PROVIDER_UNPROBED',
      'LOCAL_PROVIDER_UNREACHABLE',
    ]);
  });
});
