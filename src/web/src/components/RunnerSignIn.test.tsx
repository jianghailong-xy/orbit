import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KIMI_LOGIN_REGION_V1, type KimiRegion, type RunnerLoginState } from '@orbit/shared';
import { ENGINE_NAME, kimiSiteOf, probeReportsSignedIn, RunnerSignIn } from './RunnerSignIn';

const RUNNER = 'runner-1';

const loginState = (over: Partial<RunnerLoginState>): RunnerLoginState => ({
  status: null,
  engine: null,
  url: null,
  userCode: null,
  message: null,
  ...over,
});

/** Render the card over a login state the runner already had when the card appeared. */
function open(state: RunnerLoginState, onUseApiKey?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runner-login', RUNNER], state);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <RunnerSignIn runnerId={RUNNER} engine="codex" onUseApiKey={onUseApiKey} />
    </QueryClientProvider>,
  );
}

describe('the name each login engine signs in under', () => {
  it('has one for every login engine, Antigravity included', () => {
    expect(ENGINE_NAME).toEqual({
      claude: 'Claude Code',
      codex: 'Codex',
      kimi: 'Kimi Code',
      antigravity: 'Antigravity',
    });
  });

  // Kimi's is a choice of site instead (below).
  it.each([
    ['claude', 'Sign in to Claude Code'],
    ['codex', 'Sign in to Codex'],
  ] as const)('still offers %s the sign-in it had', (engine, label) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['runner-login', RUNNER], loginState({}));
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <RunnerSignIn runnerId={RUNNER} engine={engine} />
      </QueryClientProvider>,
    );

    expect(html).toContain(label);
  });
});

describe('RunnerSignIn on a runner with an earlier sign-in on record', () => {
  it("doesn't call a signed-out runner ready because an older sign-in succeeded", () => {
    const html = open(loginState({ status: 'done', engine: 'codex' }));

    expect(html).not.toContain('this runner is ready');
    expect(html).toContain('Sign in to Codex');
  });

  it("doesn't blame this failure on an older attempt's error", () => {
    const html = open(
      loginState({ status: 'failed', engine: 'codex', message: 'sign-in did not complete' }),
    );

    expect(html).not.toContain('sign-in did not complete');
    expect(html).toContain('Sign in to Codex');
  });

  // A device flow gets no auto-opened tab (its page is useless before the code exists), so the
  // card itself has to carry both halves of what the user does next.
  it('still shows a sign-in that is actually under way', () => {
    const html = open(
      loginState({
        status: 'awaiting_approval',
        engine: 'codex',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ZXHO-K06HC',
      }),
    );

    expect(html).toContain('ZXHO-K06HC');
    expect(html).toContain('href="https://auth.openai.com/codex/device"');
  });

  // The code comes first, and the one press both copies it and opens the page it goes into (VS Code's
  // "Copy & Continue to GitHub"), so all that is left over there is a paste.
  it('puts the one-time code first, above the press that copies it and opens its page', () => {
    const html = open(
      loginState({
        status: 'awaiting_approval',
        engine: 'codex',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ZXHO-K06HC',
      }),
    );

    expect(html).toContain('Enter this one-time code on the sign-in page:');
    expect(html.indexOf('ZXHO-K06HC')).toBeGreaterThan(-1);
    expect(html.indexOf('ZXHO-K06HC')).toBeLessThan(html.indexOf('Copy Code &amp; Open Sign-In Page'));
  });
});

// What ends the wait for the runner to re-report after a sign-in lands. Getting this wrong is
// what left a signed-in engine reading "Signed out" under a card saying it was ready.
describe('waiting for the runner to confirm a sign-in', () => {
  const runners = (auth: 'yes' | 'no' | 'unknown') => [
    { id: 'other', engines: [{ engine: 'kimi' as const, installed: true, auth: 'yes' as const }] },
    {
      id: RUNNER,
      engines: [
        { engine: 'claude' as const, installed: true, auth: 'yes' as const },
        { engine: 'kimi' as const, installed: true, auth },
      ],
    },
  ];

  it('ends once that machine reports this engine signed in', () => {
    expect(probeReportsSignedIn(runners('yes'), RUNNER, 'kimi')).toBe(true);
  });

  it('keeps waiting while the runner still reports the pre-sign-in probe', () => {
    expect(probeReportsSignedIn(runners('no'), RUNNER, 'kimi')).toBe(false);
    // A CLI that wouldn't answer is not a yes — the wait is bounded, not ended, by this.
    expect(probeReportsSignedIn(runners('unknown'), RUNNER, 'kimi')).toBe(false);
  });

  it('answers for this runner and this engine, not another that happens to be signed in', () => {
    expect(probeReportsSignedIn(runners('no'), 'other', 'kimi')).toBe(true);
    expect(probeReportsSignedIn(runners('no'), RUNNER, 'claude')).toBe(true);
  });

  it('keeps waiting on a runner that has reported nothing yet', () => {
    expect(probeReportsSignedIn(undefined, RUNNER, 'kimi')).toBe(false);
    expect(probeReportsSignedIn([{ id: RUNNER, engines: null }], RUNNER, 'kimi')).toBe(false);
    expect(probeReportsSignedIn([], RUNNER, 'kimi')).toBe(false);
  });

  it('keeps waiting for a newly named account when Default is already signed in', () => {
    const before = [
      {
        id: RUNNER,
        engines: [
          {
            engine: 'claude' as const,
            installed: true,
            auth: 'yes' as const,
            accounts: [{ id: 'default', home: '/root/.claude', auth: 'yes' as const }],
          },
        ],
      },
    ];
    const after = [
      {
        id: RUNNER,
        engines: [
          {
            engine: 'claude' as const,
            installed: true,
            auth: 'yes' as const,
            accounts: [
              { id: 'default', home: '/root/.claude', auth: 'yes' as const },
              { id: '3fa91c2e', name: 'Personal', home: '/slot', auth: 'yes' as const },
            ],
          },
        ],
      },
    ];

    // The engine-level answer belongs to Default. It must not stop the refresh before the new
    // account has appeared in the list and been confirmed there.
    expect(probeReportsSignedIn(before, RUNNER, 'claude', undefined, 'Personal')).toBe(false);
    expect(probeReportsSignedIn(after, RUNNER, 'claude', undefined, 'Personal')).toBe(true);
    // An account-specific wait must not fall back to Default when an older/transient report omits
    // the account list altogether.
    expect(
      probeReportsSignedIn(
        [{ id: RUNNER, engines: [{ engine: 'claude', installed: true, auth: 'yes' }] }],
        RUNNER,
        'claude',
        '3fa91c2e',
      ),
    ).toBe(false);
  });
});

describe('RunnerSignIn choice of route', () => {
  it('offers the API key beside the sign-in while it is still a choice', () => {
    const html = open(loginState({}), () => {});

    expect(html).toContain('Sign in to Codex');
    expect(html).toContain('Use an API key instead');
  });

  it('drops the alternative once a sign-in is under way', () => {
    const html = open(
      loginState({
        status: 'awaiting_approval',
        engine: 'codex',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ZXHO-K06HC',
      }),
      () => {},
    );

    expect(html).not.toContain('Use an API key instead');
  });
});

// One runner, several Codex accounts, one sign-in relay row. A card belongs to one account, and
// the device code it shows is the one the user will type — for the account under that card.
describe('RunnerSignIn for one Codex account', () => {
  const WORK = '3fa91c2e';
  const underWay = (account: string | null) =>
    loginState({
      status: 'awaiting_approval',
      engine: 'codex',
      url: 'https://auth.openai.com/codex/device',
      userCode: 'ZXHO-K06HC',
      account,
    });
  const card = (state: RunnerLoginState, props: { account?: string; accountName?: string }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['runner-login', RUNNER], state);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <RunnerSignIn runnerId={RUNNER} engine="codex" {...props} />
      </QueryClientProvider>,
    );
  };

  it("shows an account's own sign-in under it", () => {
    expect(card(underWay(WORK), { account: WORK })).toContain('ZXHO-K06HC');
    expect(card(underWay('default'), { account: 'default' })).toContain('ZXHO-K06HC');
  });

  it("never shows another account's code under this one", () => {
    // Typed into the page, that code would sign Default in while the user meant Work.
    const html = card(underWay('default'), { account: WORK });
    expect(html).not.toContain('ZXHO-K06HC');
    expect(html).toContain('Sign in to Codex');
    expect(card(underWay(WORK), { account: 'default' })).not.toContain('ZXHO-K06HC');
  });

  it('adds an account only through a sign-in it started itself', () => {
    // A card that has not pressed anything owns no sign-in, whatever is running on the runner.
    for (const account of [null, 'default', WORK]) {
      const html = card(underWay(account), { accountName: 'Personal' });
      expect(html).not.toContain('ZXHO-K06HC');
      expect(html).toContain('Sign in to Codex');
    }
  });

  it("waits for that account's own probe, not the engine's", () => {
    const runners = (work: 'yes' | 'no') => [
      {
        id: RUNNER,
        engines: [
          {
            engine: 'codex' as const,
            installed: true,
            // The engine's answer is Default's.
            auth: 'yes' as const,
            accounts: [
              { id: 'default', codexHome: '/root/.codex', auth: 'yes' as const },
              { id: WORK, codexHome: `/root/.orbit/codex-accounts/${WORK}`, auth: work },
            ],
          },
        ],
      },
    ];
    expect(probeReportsSignedIn(runners('no'), RUNNER, 'codex', WORK)).toBe(false);
    expect(probeReportsSignedIn(runners('yes'), RUNNER, 'codex', WORK)).toBe(true);
    // An account the runner hasn't listed yet is not signed in, whatever Default says.
    expect(probeReportsSignedIn(runners('yes'), RUNNER, 'codex', '0b05070e')).toBe(false);
    // No account named: the engine's own answer, as before accounts.
    expect(probeReportsSignedIn(runners('no'), RUNNER, 'codex')).toBe(true);
  });
});

// kimi.com and kimi.ai keep separate accounts, so a Kimi sign-in starts with the site.
describe('RunnerSignIn for Kimi', () => {
  const runner = (over: { capabilities?: string[]; kimiRegion?: KimiRegion } = {}) => ({
    id: RUNNER,
    capabilities: over.capabilities ?? ['session-worktree-ops-v1', KIMI_LOGIN_REGION_V1],
    engines: [{ engine: 'kimi' as const, installed: true, auth: 'no' as const, ...(over.kimiRegion ? { kimiRegion: over.kimiRegion } : {}) }],
  });
  const kimi = (state: RunnerLoginState, onRunner = runner()) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['runner-login', RUNNER], state);
    qc.setQueryData(['runners'], [onRunner]);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <RunnerSignIn runnerId={RUNNER} engine="kimi" />
      </QueryClientProvider>,
    );
  };
  const sites = (html: string) =>
    [...html.matchAll(/<button class="rsi-site" type="button"( disabled="")?><span class="rsi-site-name">([^<]+)(<span class="rsi-site-tag">Current<\/span>)?<\/span><span class="rsi-site-sub">([^<]+)<\/span><\/button>/gu)]
      .map(([, disabled, domain, current, where]) => `${domain} · ${where}${current ? ' · Current' : ''}${disabled ? ' (disabled)' : ''}`);
  const device = (url: string) =>
    loginState({ status: 'awaiting_approval', engine: 'kimi', url, userCode: '7K06-QP86' });

  it('asks which site the account is on, and picks neither', () => {
    const html = kimi(loginState({}));
    expect(html).toContain('Which Kimi account are you signing in with?');
    expect(sites(html)).toEqual(['kimi.com · Mainland China', 'kimi.ai · International']);
    expect(html).toContain('The two sites keep separate accounts — pick the one you signed up on.');
    expect(html).not.toContain('Sign in to Kimi Code');
  });

  it("marks the site the runner's login is on", () => {
    expect(sites(kimi(loginState({}), runner({ kimiRegion: 'global' })))).toEqual([
      'kimi.com · Mainland China',
      'kimi.ai · International · Current',
    ]);
  });

  it('offers kimi.ai only on a runner that can be told the site', () => {
    const html = kimi(loginState({}), runner({ capabilities: ['session-worktree-ops-v1'] }));
    expect(sites(html)).toEqual(['kimi.com · Mainland China', 'kimi.ai · International (disabled)']);
    expect(html).toContain('This runner signs in on kimi.com only. Update it to sign in with a kimi.ai account.');
  });

  it('says why the last attempt failed above the choice', () => {
    const html = kimi(loginState({ status: 'failed', engine: 'kimi', message: 'This runner is too old to choose a Kimi site — update it, then try again.' }));
    // An outcome this card did not watch is history (see above): the choice, without the message.
    expect(html).not.toContain('too old');
    expect(sites(html)).toHaveLength(2);
  });

  it('names the site of the page the code is for, and offers the other one', () => {
    const html = kimi(device('https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86'));
    // The code first, under the one press that copies it and opens its site's page.
    expect(html).toContain('Copy Code &amp; Open kimi.ai');
    expect(html).toContain('Sign in with your <b>kimi.ai</b> account there, then enter this one-time code:');
    expect(html).toContain('7K06-QP86');
    expect(html).toContain('Use kimi.com instead');

    const com = kimi(device('https://www.kimi.com/code/authorize_device?user_code=7K06-QP86'));
    expect(com).toContain('Copy Code &amp; Open kimi.com');
    expect(com).toContain('Use kimi.ai instead');
  });

  it('offers no other site where the runner could not be told it', () => {
    const html = kimi(device('https://www.kimi.com/code/authorize_device?user_code=7K06-QP86'), runner({ capabilities: [] }));
    expect(html).toContain('Copy Code &amp; Open kimi.com');
    expect(html).not.toContain('instead');
    expect(html).toContain('Cancel');
  });

  it("leaves a page of neither site unnamed, as every other engine's is", () => {
    const html = kimi(device('https://auth.example.test/verify?user_code=7K06-QP86'));
    expect(html).toContain('Copy Code &amp; Open Sign-In Page');
    expect(html).toContain('Enter this one-time code on the sign-in page:');
    expect(html).not.toContain('instead');
  });

  it("reads the site off the page's own address", () => {
    expect(kimiSiteOf('https://www.kimi.ai/code/authorize_device?user_code=X')).toBe('global');
    expect(kimiSiteOf('https://auth.kimi.com/verify?user_code=X')).toBe('mainland-cn');
    expect(kimiSiteOf('https://kimi.ai')).toBe('global');
    expect(kimiSiteOf('https://notkimi.ai')).toBeNull();
    expect(kimiSiteOf('https://kimi.ai.example.test')).toBeNull();
    expect(kimiSiteOf('not a url')).toBeNull();
    expect(kimiSiteOf(null)).toBeNull();
  });

  it('waits for the login on the site just signed in on, not the one it replaced', () => {
    const on = (kimiRegion: KimiRegion) => [
      { id: RUNNER, engines: [{ engine: 'kimi' as const, installed: true, auth: 'yes' as const, kimiRegion }] },
    ];
    // Moving from kimi.com to kimi.ai: the yes before the runner re-probes is kimi.com's.
    expect(probeReportsSignedIn(on('mainland-cn'), RUNNER, 'kimi', undefined, undefined, 'global')).toBe(false);
    expect(probeReportsSignedIn(on('global'), RUNNER, 'kimi', undefined, undefined, 'global')).toBe(true);
    // No site to wait for: the engine's own answer, as before.
    expect(probeReportsSignedIn(on('mainland-cn'), RUNNER, 'kimi')).toBe(true);
  });
});
