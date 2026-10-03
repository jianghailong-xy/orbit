import { AgentProvider } from '@orbit/shared';
import { describe, expect, it } from 'vitest';
import { loginLine, loginSpentUntil, withLogin, type CodexLogin } from './codexLogin';
import { poolsAsProviders, type ProviderPool } from './providerPools';
import { providerChoices } from './sessionProviderChoices';

/**
 * A Codex pool of one's own ChatGPT accounts, as every reader of the pool list gets it: each account it
 * holds as a member of its own (`withLogin`), where it stands read off the account — the first being the
 * one a session runs on — and the pool itself offered as Codex, never as the Claude pool every other
 * pool of one's own is.
 */

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const LATER = '2026-09-28T15:00:00.000Z';
const NEXT_WEEK = '2026-10-03T09:00:00.000Z';

function account(over: Partial<CodexLogin> = {}): CodexLogin {
  return {
    state: 'ACTIVE',
    email: 'lin@example.com',
    plan: 'pro',
    fingerprint: '…AB12',
    lastError: null,
    expiresAt: NEXT_WEEK,
    linkedAt: '2026-09-28T10:00:00.000Z',
    usage: null,
    usageUnavailable: 'no quota has been read for this account yet',
    ...over,
  };
}

const pool = (login: CodexLogin | null): ProviderPool => ({
  id: 'p1',
  slug: 'my-codex',
  label: 'My Codex',
  engine: 'codex',
  login,
  resetsAt: null,
  unavailable: login ? null : 'the pool "My Codex" has no ChatGPT account signed in — sign in on its page',
  members: [],
});

const windows = (primary: number, secondary: number) => ({
  provider: 'codex',
  primary: { utilization: primary, resetsAt: LATER, windowDurationMins: 300 },
  secondary: { utilization: secondary, resetsAt: NEXT_WEEK, windowDurationMins: 10080 },
});

describe('withLogin', () => {
  it('draws the account as the one member, next while it can run', () => {
    const drawn = withLogin(pool(account()), NOW);
    expect(drawn.members).toHaveLength(1);
    const [member] = drawn.members;
    expect(member).toMatchObject({
      label: 'lin@example.com',
      presetSlug: 'openai',
      state: 'AVAILABLE',
      next: true,
      resetsAt: null,
    });
    expect(member.login?.fingerprint).toBe('…AB12');
    expect(drawn.unavailable).toBeNull();
    expect(loginLine(member.login!)).toBe('ChatGPT Pro · …AB12');
    expect(loginLine(account({ plan: null }))).toBe('ChatGPT · …AB12');
  });

  it('says why nothing can run in words a pool head has room for', () => {
    expect(withLogin(pool(null), NOW)).toMatchObject({ members: [], unavailable: 'Not signed in', resetsAt: null });
    const signedOut = withLogin(pool(account({ state: 'SIGNED_OUT' })), NOW);
    expect(signedOut.unavailable).toBe('Signed out');
    expect(signedOut.members[0]).toMatchObject({ state: 'SIGNED_OUT', next: false });
  });

  it('waits out a used-up window until its reset — the latest, when both are used up', () => {
    const spent = withLogin(pool(account({ usage: windows(100, 40) })), NOW);
    expect(spent.members[0]).toMatchObject({ state: 'SPENT', next: false, resetsAt: LATER });
    expect(spent.resetsAt).toBe(LATER);
    expect(spent.unavailable).toBeNull();
    expect(loginSpentUntil(account({ usage: windows(100, 100) }), NOW)).toBe(NEXT_WEEK);
    // A reading from before its window turned over is no reason to wait.
    expect(loginSpentUntil(account({ usage: windows(100, 40) }), Date.parse(LATER) + 1)).toBeUndefined();
    expect(withLogin(pool(account({ usage: windows(23, 41) })), NOW).members[0].state).toBe('AVAILABLE');
  });

  it('draws each account of a pool that holds several as a member of its own, the first the one a session runs on', () => {
    const first = account();
    const second = account({ email: 'hl.work@gmail.com', fingerprint: '…7QX4', linkedAt: NEXT_WEEK });
    const drawn = withLogin({ ...pool(null), login: first, logins: [first, second] }, NOW);
    expect(drawn.members.map((member) => [member.label, member.next])).toEqual([
      ['lin@example.com', true],
      ['hl.work@gmail.com', false],
    ]);
    expect(drawn.members.map((member) => member.id)).toEqual(['login:…AB12', 'login:…7QX4']);
    expect(drawn.unavailable).toBeNull();
    // An account OpenAI signed out is its own row's business: the pool runs on the others.
    const oneOut = withLogin(
      { ...pool(null), login: second, logins: [second, account({ state: 'SIGNED_OUT' })] },
      NOW,
    );
    expect(oneOut.members.map((member) => member.state)).toEqual(['AVAILABLE', 'SIGNED_OUT']);
    expect(oneOut.unavailable).toBeNull();
  });

  it('waits for the first account to free up, once every one of them is spent', () => {
    const spent = account({ usage: windows(100, 40) });
    const barelySpent = account({ email: 'hl.work@gmail.com', fingerprint: '…7QX4', usage: windows(100, 100) });
    const drawn = withLogin({ ...pool(null), login: spent, logins: [spent, barelySpent] }, NOW);
    expect(drawn.members.map((member) => [member.state, member.next])).toEqual([
      ['SPENT', false],
      ['SPENT', false],
    ]);
    // The EARLIEST of the two: one account freeing up is enough for a session to continue.
    expect(drawn.resetsAt).toBe(LATER);
  });

  it('leaves every other kind of pool as it was', () => {
    const claude: ProviderPool = { id: 'c', slug: 'claude-accounts', label: 'Claude accounts', resetsAt: null, members: [] };
    expect(withLogin(claude, NOW)).toBe(claude);
    const legacy = { ...claude, engine: 'claude', login: null };
    expect(withLogin(legacy, NOW)).toBe(legacy);
  });
});

describe('a pool of one’s own ChatGPT account in the pickers', () => {
  it('is offered as Codex, with the Codex CLI’s models', () => {
    const drawn = withLogin(pool(account()), NOW);
    const [provider] = poolsAsProviders([drawn]);
    expect(provider).toMatchObject({ slug: 'my-codex', runtime: AgentProvider.CODEX, presetSlug: 'openai', modelsFromRuntime: true });
    const choice = providerChoices([provider], null, undefined, null, [drawn]).find((c) => c.slug === 'my-codex');
    expect(choice).toMatchObject({ kind: 'pool', poolSize: 1 });
    expect(choice?.unavailable).toBeUndefined();
  });

  it('is greyed out while nobody is signed in, pointing at its page', () => {
    const drawn = withLogin(pool(null), NOW);
    const choice = providerChoices(poolsAsProviders([drawn]), null, undefined, null, [drawn]).find(
      (c) => c.slug === 'my-codex',
    );
    expect(choice).toMatchObject({ unavailable: 'Not signed in', fixHref: '/providers/pools/p1' });
  });

  it('needs the Codex CLI on the runner, not Claude', () => {
    const drawn = withLogin(pool(account()), NOW);
    const health = [
      { engine: 'claude', installed: true, auth: 'yes' },
      { engine: 'codex', installed: false, auth: 'no' },
    ] as never;
    const choice = providerChoices(poolsAsProviders([drawn]), null, undefined, health, [drawn]).find(
      (c) => c.slug === 'my-codex',
    );
    expect(choice).toMatchObject({ unavailable: 'Not installed', fixEngine: AgentProvider.CODEX });
  });
});
