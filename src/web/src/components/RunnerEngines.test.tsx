import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
import { RunnerEngines, rowKindOf, summaryOf } from './RunnerEngines';
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
  ...over,
});

describe('what one engine row says', () => {
  it('reads the CLI\'s own answer, and never guesses the third one', () => {
    expect(rowKindOf(health({ auth: 'yes' }), null, 'claude')).toBe('in');
    expect(rowKindOf(health({ auth: 'no' }), null, 'claude')).toBe('out');
    // The one that matters: an engine that wouldn't answer must not read as signed in.
    expect(rowKindOf(health({ auth: 'unknown' }), null, 'claude')).toBe('unknown');
  });

  it('offers an install when the binary is missing, or was never reported', () => {
    expect(rowKindOf(health({ installed: false, auth: 'unknown' }), null, 'claude')).toBe('missing');
    expect(rowKindOf(undefined, null, 'claude')).toBe('missing');
  });

  it('lets an install in flight outrank the last heartbeat probe', () => {
    const missing = health({ installed: false, auth: 'unknown' });
    expect(rowKindOf(missing, install({ status: 'pending', engine: 'claude' }), 'claude')).toBe(
      'installing',
    );
    expect(rowKindOf(missing, install({ status: 'installing', engine: 'claude' }), 'claude')).toBe(
      'installing',
    );
    expect(rowKindOf(missing, install({ status: 'failed', engine: 'claude' }), 'claude')).toBe(
      'install-failed',
    );
  });

  it("leaves the other engines' rows alone while one is installing", () => {
    const installing = install({ status: 'installing', engine: 'kimi' });
    expect(rowKindOf(health({ engine: 'claude' }), installing, 'claude')).toBe('in');
    expect(rowKindOf(undefined, installing, 'codex')).toBe('missing');
  });

  it('hands a finished install back to the probe as soon as the probe agrees', () => {
    // Confirmed: the probe is newer than the relay, so the row speaks from it again.
    expect(
      rowKindOf(health({ auth: 'no' }), install({ status: 'done', engine: 'claude' }), 'claude'),
    ).toBe('out');
    // Not yet confirmed: this must not offer to install what was just installed.
    expect(
      rowKindOf(
        health({ installed: false, auth: 'unknown' }),
        install({ status: 'done', engine: 'claude' }),
        'claude',
      ),
    ).toBe('installed');
  });
});

const runner = (over: Partial<Runner>): Runner => ({
  // A real UUID: the card links to /runners/<base62>, which only encodes one.
  id: '019fc086-c7c7-7c92-8215-778ad8a6280a',
  name: 'mac-studio',
  online: true,
  ...over,
});

function render(runners: Runner[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], runners);
  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <RunnerEngines />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('the "On your runners" section', () => {
  it('shows every engine on a runner that reported, with its state and way out', () => {
    const html = render([
      runner({
        version: '0.1.84',
        engines: [
          health({ engine: 'claude', version: '2.1.4' }),
          health({ engine: 'codex', auth: 'no' }),
          health({ engine: 'kimi', installed: false, auth: 'unknown' }),
        ],
      }),
    ]);

    expect(html).toContain('Claude Code');
    expect(html).toContain('Signed in');
    expect(html).toContain('Signed out');
    expect(html).toContain('Not installed');
    expect(html).toContain('Install');
    expect(html).toContain('1 runner · 1 signed in');
  });

  it("says a runner hasn't reported rather than calling its engines missing", () => {
    const html = render([runner({ engines: null })]);

    expect(html).toContain('reported its engines yet');
    expect(html).not.toContain('Not installed');
  });

  it('shows the command an install is running, and the machine\'s own error when it fails', () => {
    const running = render([
      runner({
        engines: [health({ engine: 'kimi', installed: false, auth: 'unknown' })],
        install: install({
          status: 'installing',
          engine: 'kimi',
          command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
        }),
      }),
    ]);
    expect(running).toContain('Installing…');
    expect(running).toContain('code.kimi.com');

    const failed = render([
      runner({
        engines: [health({ engine: 'kimi', installed: false, auth: 'unknown' })],
        install: install({
          status: 'failed',
          engine: 'kimi',
          command: 'npm install -g @moonshot-ai/kimi-code',
          message: 'exit status 243: EACCES on /usr/local/lib/node_modules',
        }),
      }),
    ]);
    expect(failed).toContain('Install failed');
    expect(failed).toContain('EACCES');
    expect(failed).toContain('Retry');
  });

  it('folds a runner away without hiding what it would have said', () => {
    const busy = runner({
      engines: [
        health({ engine: 'claude' }),
        health({ engine: 'codex', auth: 'no' }),
        health({ engine: 'kimi', installed: false, auth: 'unknown' }),
      ],
    });
    // Nothing in flight: the summary is the count.
    expect(summaryOf(busy)).toBe('1 of 3 signed in');
    expect(
      summaryOf(runner({ engines: [health({}), health({ engine: 'codex' }), health({ engine: 'kimi' })] })),
    ).toBe('All signed in');
    expect(summaryOf(runner({ engines: null }))).toBe('Engines not reported');
    // A folded card must still say that something needs attention, or collapsing becomes a way
    // to lose a failed install.
    expect(
      summaryOf(runner({ engines: [health({})], install: install({ status: 'failed', engine: 'kimi' }) })),
    ).toBe('Install failed');
    expect(
      summaryOf(runner({ engines: [health({})], install: install({ status: 'installing', engine: 'kimi' }) })),
    ).toBe('Installing…');
  });

  it('offers the free route first when there is no runner at all', () => {
    const html = render([]);

    expect(html).toContain('Already pay for Claude, Codex or Kimi?');
    expect(html).toContain('Add a runner');
  });
});
