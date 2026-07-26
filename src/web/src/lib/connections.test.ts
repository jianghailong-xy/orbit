import { describe, expect, it } from 'vitest';
import { localLoginCoverage, vendorGroups, type RunnerLike } from './connections';
import type { ProviderRow } from './providerAdmin';

const runner = (id: string, engines: RunnerLike['engines']): RunnerLike => ({
  id,
  name: id,
  engines,
});

const key = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: 'p1',
  slug: 'anthropic',
  label: 'Anthropic (Claude)',
  runtime: 'claude',
  baseUrl: 'https://api.anthropic.com',
  models: [],
  defaultModel: null,
  presetSlug: 'anthropic',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  ...over,
});

const signedIn = { provider: 'claude', installed: true, auth: 'yes' as const, onServicePath: true };
const signedOut = { provider: 'claude', installed: true, auth: 'no' as const, onServicePath: true };

describe('vendorGroups', () => {
  it('puts a local login and an API key for the same vendor in one group', () => {
    const groups = vendorGroups([runner('r1', [signedIn])], [key()]);
    const anthropic = groups.find((g) => g.key === 'anthropic')!;
    expect(anthropic.localLogin?.signedIn).toBe(1);
    expect(anthropic.apiKeys).toHaveLength(1);
    // One vendor, one card — the whole point of the merge.
    expect(groups.filter((g) => g.key === 'anthropic')).toHaveLength(1);
  });

  it('reports per-runner reach, not just a global yes/no', () => {
    const groups = vendorGroups([runner('r1', [signedIn]), runner('r2', [signedOut])], []);
    const login = groups.find((g) => g.key === 'anthropic')!.localLogin!;
    expect(login.signedIn).toBe(1);
    expect(login.runners.map((r) => r.state)).toEqual(['signedIn', 'signedOut']);
    expect(localLoginCoverage(login)).toBe('Signed in on 1 of 2 runners');
  });

  it('keeps "never reported" distinct from "not installed"', () => {
    // An older runner sends no engines field at all; that must not read as a missing CLI,
    // which would tell the user to install something that may already be there.
    const groups = vendorGroups([runner('old', null), runner('new', [])], []);
    const login = groups.find((g) => g.key === 'anthropic')!.localLogin!;
    expect(login.runners.map((r) => r.state)).toEqual(['notReported', 'notReported']);
    const missing = vendorGroups(
      [runner('r1', [{ provider: 'claude', installed: false, auth: 'unknown', onServicePath: false }])],
      [],
    );
    expect(missing.find((g) => g.key === 'anthropic')!.localLogin!.runners[0].state).toBe('missing');
  });

  it('flags an engine that is signed in but off the service PATH', () => {
    // Works when you run it by hand, fails under the runner service — the failure that
    // otherwise looks like "the CLI is fine, Orbit is broken".
    const groups = vendorGroups(
      [runner('r1', [{ provider: 'claude', installed: true, auth: 'yes', onServicePath: false }])],
      [],
    );
    const only = groups.find((g) => g.key === 'anthropic')!.localLogin!.runners[0];
    expect(only.state).toBe('signedIn');
    expect(only.pathWarning).toBe(true);
  });

  it('groups a second key for the same vendor under that vendor, not its suffixed slug', () => {
    const groups = vendorGroups([], [key(), key({ id: 'p2', slug: 'anthropic-2' })]);
    expect(groups.find((g) => g.key === 'anthropic')!.apiKeys).toHaveLength(2);
  });

  it('gives a key-only vendor its own group and no local login', () => {
    const groups = vendorGroups([], [key({ id: 'p3', slug: 'kimi', presetSlug: 'kimi', label: 'Kimi' })]);
    const kimi = groups.find((g) => g.key === 'kimi')!;
    expect(kimi.localLogin).toBeUndefined();
    expect(kimi.label).toBe('Kimi (Moonshot)');
  });

  it('shows nothing at all when the user has neither runners nor keys', () => {
    expect(vendorGroups([], [])).toEqual([]);
  });

  it('surfaces a vendor with a runner but no credential, so "nothing signed in" is visible', () => {
    const groups = vendorGroups([runner('r1', [])], []);
    expect(groups.map((g) => g.key)).toEqual(['anthropic', 'openai']);
    expect(localLoginCoverage(groups[0].localLogin!)).toBe('Not signed in on any of your 1 runner');
  });
});
