import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
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
