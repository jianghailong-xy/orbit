import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PlanUsage, RunnerEngineAccount, RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { RunnerEnginesSection } from './RunnerEnginesSection';
import type { Runner } from './TasksSidePanel';

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({
  engine: 'claude',
  installed: true,
  auth: 'yes',
  ...over,
});

const install = (over: Partial<RunnerInstallState>): RunnerInstallState => ({
  status: null,
  engine: null,
  command: null,
  message: null,
  mode: over.status ? 'install' : null,
  ...over,
});

const runner = (over: Partial<Runner>): Runner =>
  ({
    id: '0198f0c2-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
    name: 'wikova',
    online: true,
    ...over,
  }) as Runner;

const render = (r: Runner) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <RunnerEnginesSection runner={r} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** Each engine row as rendered: where it leads, its sign-in column (tone and words), and its quota
 *  column — one entry per window (`label percent%`, `!` when nearly spent), or the words in its place. */
const rowsOf = (html: string) =>
  [...html.matchAll(/<a class="rd-engine-row" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(([, href, row]) => ({
    name: /class="rd-engine-name">([^<]*)</.exec(row)?.[1],
    href: href.replaceAll('&amp;', '&'),
    signIn: /class="rd-engine-auth (\w+)">([^<]*)</.exec(row)?.slice(1, 3),
    quota: [
      ...row.matchAll(/class="rd-quota( near)?"><div class="rd-quota-head"><span>([^<]*)<\/span><span class="rd-quota-pct">([^<]*)</g),
    ].map(([, near, label, percent]) => `${label} ${percent}${near ? ' !' : ''}`),
    quotaNote: /class="rd-engine-muted">([^<]*)</.exec(row)?.[1] ?? null,
  }));

const account = (id: string, auth: RunnerEngineAccount['auth']): RunnerEngineAccount => ({
  id,
  home: `/root/.orbit/codex-accounts/${id}`,
  auth,
});

describe("a machine's engine CLIs", () => {
  it('lists every engine on the machine, including the one you cannot sign into', () => {
    // The whole reason this section exists on the runner's page rather than on Providers: the
    // update it offers touches all four CLIs, so all four have to be visible. Providers shows
    // three because it is asking a different question.
    const html = render(
      runner({
        engines: [
          health({ engine: 'claude', version: '2.1.228' }),
          health({ engine: 'codex', version: 'codex-cli 0.147.0' }),
          health({ engine: 'kimi', version: '0.35.0' }),
          health({ engine: 'opencode', version: '1.18.16', auth: 'unknown' }),
        ],
      }),
    );
    for (const name of ['Claude Code', 'Codex', 'Kimi Code', 'OpenCode']) {
      expect(html).toContain(name);
    }
    expect(html).toContain('1.18.16');
    expect(html).toContain('Update engines');
  });

  it('says an engine is missing rather than inventing a version for it', () => {
    const html = render(
      runner({ engines: [health({ engine: 'kimi', installed: false, version: undefined })] }),
    );
    expect(html).toContain('Not installed');
  });

  it("doesn't offer to update a machine that isn't there", () => {
    const html = render(runner({ online: false, engines: [health({})] }));
    expect(html).not.toContain('Update engines');
    // Same argument for the models button: the request is delivered by a heartbeat, so a machine
    // that isn't beating cannot be asked anything.
    expect(html).not.toContain('Refresh models');
  });

  it('offers to re-read the model lists next to the update that makes them stale', () => {
    // Installing a newer CLI does not re-read what it offers, and the runner's own pass is hours
    // away — so the two controls belong together, on the section that owns the CLIs.
    const html = render(runner({ engines: [health({ engine: 'codex', version: 'codex-cli 0.153.2' })] }));
    expect(html).toContain('Refresh models');
    expect(html).toContain('Update engines');
  });

  it('reports what a run actually did, including what it left alone', () => {
    const html = render(
      runner({
        engines: [health({ engine: 'claude', version: '2.1.228' })],
        install: install({
          status: 'done',
          engine: null,
          mode: 'update',
          command: 'orbit engine-update',
          message:
            'Claude Code updated 2.1.227 → 2.1.228\nOpenCode — already up to date (1.18.16)',
        }),
      }),
    );
    expect(html).toContain('2.1.227');
    // The part a silent skip would hide: the button did less than it looked like it did. And it
    // can say "OpenCode" here without describing something the page doesn't show.
    expect(html).toContain('OpenCode');
    expect(html).toContain('Dismiss');
  });

  it('leaves an install relay alone — it belongs to the row that started it', () => {
    // Both share the runner's one relay slot. Only a run in `update` mode is this section's news.
    const html = render(
      runner({
        engines: [health({})],
        install: install({ status: 'failed', engine: 'kimi', message: 'curl: (6) could not resolve host' }),
      }),
    );
    expect(html).not.toContain('could not resolve host');
    expect(html).not.toContain('Dismiss');
  });

  it('never reads a silent runner as an empty machine', () => {
    const html = render(runner({ engines: null }));
    expect(html).toContain('hasn’t reported its engines yet');
  });

  it("carries the drift warning onto the machine's own page", () => {
    const html = render(
      runner({
        engines: [
          health({
            engine: 'claude',
            version: '2.1.226 (Claude Code)',
            update: {
              status: 'failed',
              at: new Date(Date.now() - 3600_000).toISOString(),
              okAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
              latest: '2.1.228',
              behindSince: new Date(Date.now() - 9 * 86400_000).toISOString(),
              message: '2.1.226 → 2.1.228: `claude update` was still running after 5m1s and was stopped.',
            },
          }),
        ],
      }),
    );
    expect(html).toContain('9d behind 2.1.228');
    // The machine's own sentence rides along as the tooltip, same as on Providers.
    expect(html).toContain('5m1s');
  });
});

describe("each engine's sign-in, quota and way to its sign-in", () => {
  /** A reset this many hours after whenever the test runs: a window past its reset reads as the fresh
   *  window it now is (currentPlanUsageRows), so a fixed date would turn every reading to 0% once it
   *  went by. */
  const later = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
  // wikova's engines on 2026-09-29, as runnerAttention.cases.json has them, resetting ahead of now.
  const wikova = (over: Partial<Runner> = {}) =>
    runner({
      planUsage: {
        provider: 'claude',
        fiveHour: { utilization: 14, resetsAt: later(2) },
        sevenDay: { utilization: 98, resetsAt: later(60) },
      } as PlanUsage,
      engines: [
        health({ engine: 'claude', version: '2.1.284 (Claude Code)' }),
        health({
          engine: 'codex',
          version: 'codex-cli 0.158.0',
          accounts: [account('default', 'yes'), account('1fda3f43', 'yes')],
        }),
        health({ engine: 'kimi', version: '2.1.1' }),
        health({ engine: 'opencode', version: '1.18.33' }),
      ],
      ...over,
    });

  it('writes each version as its number, whatever the CLI wraps it in', () => {
    const html = render(wikova());
    expect([...html.matchAll(/class="rd-engine-version"[^>]*>([^<]*)</g)].map(([, v]) => v)).toEqual([
      '2.1.284',
      '0.158.0',
      '2.1.1',
      '1.18.33',
    ]);
    expect(html).not.toContain('(Claude Code)');
    expect(html).not.toContain('codex-cli');
  });

  it('says who is signed in, counting the accounts when there are several', () => {
    expect(rowsOf(render(wikova())).map((row) => [row.name, ...(row.signIn ?? [])])).toEqual([
      ['Claude Code', 'ok', 'Signed in'],
      ['Codex', 'ok', '2 accounts signed in'],
      ['Kimi Code', 'ok', 'Signed in'],
      // OpenCode signs in per provider, with nothing on the machine to report.
      ['OpenCode', 'muted', '—'],
      ['Antigravity CLI', 'muted', 'Update runner'],
    ]);
  });

  it('never reads a CLI that would not say as signed in, and names what is out or missing', () => {
    const rows = rowsOf(
      render(
        runner({
          engines: [
            health({ engine: 'claude', auth: 'unknown' }),
            health({ engine: 'codex', accounts: [account('default', 'yes'), account('work', 'no')] }),
            health({ engine: 'kimi', auth: 'no' }),
            health({ engine: 'opencode', installed: false, auth: 'unknown' }),
          ],
        }),
      ),
    );
    expect(rows.map((row) => [row.name, ...(row.signIn ?? [])])).toEqual([
      ['Claude Code', 'muted', '—'],
      // One account out is a sign-in this machine needs, whatever the others say.
      ['Codex', 'warn', 'Signed out'],
      ['Kimi Code', 'warn', 'Signed out'],
      ['OpenCode', 'muted', 'Not installed'],
      ['Antigravity CLI', 'muted', 'Update runner'],
    ]);
  });

  it('shows the quota window of a signed-in login closest to its limit, amber from 90%', () => {
    // Its runner reports Claude's windows only: Codex is signed in with nothing to show. One window
    // per row, the one that stops the login first; every window is the engine page's.
    const rows = rowsOf(render(wikova()));
    expect(rows.map((row) => [row.name, row.quota, row.quotaNote])).toEqual([
      ['Claude Code', ['Weekly · all models 98% !'], null],
      ['Codex', [], 'No quota reported'],
      ['Kimi Code', [], 'No quota reported'],
      ['OpenCode', [], '—'],
      ['Antigravity CLI', [], '—'],
    ]);
    // Signed out, the last reading is about sessions that can no longer start.
    const out = rowsOf(render(wikova({ engines: [health({ engine: 'claude', auth: 'no' })] })));
    expect(out.map((row) => [row.quota, row.quotaNote])).toEqual([[[], '—'], [[], '—']]);
  });

  it('reads a window past its reset as the fresh one it now is', () => {
    const html = render(
      wikova({
        planUsage: {
          provider: 'claude',
          fiveHour: { utilization: 100, resetsAt: later(-1) },
          sevenDay: { utilization: 59, resetsAt: later(60) },
        } as PlanUsage,
      }),
    );
    // The spent 5-hour window has rolled over, so it no longer stops the login: the weekly one does.
    expect(rowsOf(html)[0].quota).toEqual(['Weekly · all models 59%']);
  });

  it('shows an engine with several accounts by the one a new session starts on, named', () => {
    // Two Claude logins. Default's 5-hour window is spent, so a session nobody picked an account for
    // starts on jianghailong.rd — and its window is the one that says what that session has. Default's
    // under "2 accounts signed in" would read as the whole machine's.
    const html = render(
      runner({
        planUsage: {
          claude: {
            provider: 'claude',
            fiveHour: { utilization: 100, resetsAt: later(1) },
            sevenDay: { utilization: 59, resetsAt: later(100) },
            accounts: {
              fad98727: {
                provider: 'claude',
                fiveHour: { utilization: 1, resetsAt: later(4) },
                sevenDay: { utilization: 0, resetsAt: later(150) },
              },
            },
          },
        } as PlanUsage,
        engines: [
          health({
            engine: 'claude',
            version: '2.1.287 (Claude Code)',
            accounts: [
              { id: 'default', home: '/root/.claude', auth: 'yes' },
              { id: 'fad98727', name: 'jianghailong.rd', home: '/root/.orbit/claude-accounts/fad98727', auth: 'yes' },
            ],
          }),
        ],
      }),
    );
    const [claude] = rowsOf(html);
    expect(claude.signIn).toEqual(['ok', '2 accounts signed in']);
    expect(claude.quota).toEqual(['5-hour limit 1%']);
    expect(/class="rd-quota-next">([^<]*)</.exec(html)?.[1]).toBe('Next: jianghailong.rd');
  });

  it('leads every row to that engine’s sign-in on Providers, its card opened', () => {
    const r = wikova();
    expect(rowsOf(render(r)).map((row) => row.href)).toEqual(
      ['claude', 'codex', 'kimi', 'opencode', 'antigravity'].map(
        (engine) => `/providers?runner=${encodeId(r.id)}&engine=${engine}`,
      ),
    );
  });

  it('says under the rows what keeps them current — and what waits for an offline machine', () => {
    expect(render(wikova())).toContain(
      'Orbit keeps these CLIs updated every 30 min. Sign-ins live on this machine — a session spends that subscription, nothing to paste.',
    );
    expect(render(wikova({ online: false }))).toContain('Signing in and updating need the runner online.');
  });
});
