import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { RunnerEngines, rowKindOf, summaryOf, updateNoteOf } from './RunnerEngines';
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

const NOW = Date.parse('2026-08-04T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

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

  it('drops a failure the probe has since contradicted', () => {
    // The installer can land a binary and still be judged failed — a private install dir absent
    // from the service PATH did exactly that to Kimi. Once a probe finds it, the row must speak
    // from the machine, not from the stale attempt, or a working engine reads as broken.
    expect(
      rowKindOf(health({ auth: 'no' }), install({ status: 'failed', engine: 'claude' }), 'claude'),
    ).toBe('out');
    // Still genuinely missing: the failure is the whole story and must stay on screen.
    expect(
      rowKindOf(
        health({ installed: false, auth: 'unknown' }),
        install({ status: 'failed', engine: 'claude' }),
        'claude',
      ),
    ).toBe('install-failed');
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

describe('what a row says about being kept current', () => {
  it('stays quiet while the daily pass is working', () => {
    expect(updateNoteOf({ status: 'ok', at: hoursAgo(6), okAt: hoursAgo(6) }, NOW)).toEqual({
      tone: 'quiet',
      text: 'updated 6h ago',
    });
    expect(updateNoteOf({ status: 'ok', at: daysAgo(2), okAt: daysAgo(2) }, NOW)?.text).toBe(
      'updated 2d ago',
    );
  });

  it('never reported is silence, not an accusation', () => {
    // An older runner, or one whose first daily pass hasn't run. Neither is a problem, and
    // inventing one would put a warning on every machine the day this ships.
    expect(updateNoteOf(undefined, NOW)).toBeNull();
  });

  it('treats one failure over a working week as a footnote, not an alarm', () => {
    // The daily pass retries on its own; most of these are a network blip. Shouting here is how
    // a real warning gets tuned out.
    expect(
      updateNoteOf({ status: 'failed', at: hoursAgo(2), okAt: daysAgo(1), message: 'ETIMEDOUT' }, NOW),
    ).toEqual({ tone: 'quiet', text: 'last update failed · retrying daily' });
  });

  it('warns once nothing has actually landed in a week', () => {
    expect(
      updateNoteOf({ status: 'failed', at: hoursAgo(3), okAt: daysAgo(12), message: 'EACCES' }, NOW),
    ).toEqual({ tone: 'warn', text: 'not updated in 12d' });
    // Never once succeeded — a louder fact than a recent failure, not a quieter one.
    expect(updateNoteOf({ status: 'failed', at: hoursAgo(3), message: 'EACCES' }, NOW)).toEqual({
      tone: 'warn',
      text: 'never updated',
    });
  });

  it('warns when updates simply stopped running, with nothing failing', () => {
    // No failures at all, just nothing for a month: the loop isn't running (disabled, or the
    // machine only ever boots briefly). Same drift, same consequence, so the same warning.
    expect(updateNoteOf({ status: 'ok', at: daysAgo(30), okAt: daysAgo(30) }, NOW)).toEqual({
      tone: 'warn',
      text: 'not updated in 30d',
    });
  });

  it('calls a package-managed install what it is, and never an error', () => {
    // Retrying this does nothing — Orbit deliberately won't install a second copy beside it.
    // Dressing it as a failure would be a daily warning about a deliberate choice.
    expect(
      updateNoteOf(
        { status: 'skipped', at: hoursAgo(4), okAt: daysAgo(40), message: 'Installed by a package manager (/opt/homebrew/bin/codex)' },
        NOW,
      ),
    ).toEqual({ tone: 'quiet', text: 'updated by its package manager' });
  });

  it('survives a record it cannot age', () => {
    expect(updateNoteOf({ status: 'ok', at: 'nonsense' }, NOW)).toEqual({
      tone: 'warn',
      text: 'never updated',
    });
  });
});

const runner = (over: Partial<Runner>): Runner => ({
  // A real UUID: the card links to /runners/<base62>, which only encodes one.
  id: '019fc086-c7c7-7c92-8215-778ad8a6280a',
  name: 'mac-studio',
  online: true,
  ...over,
});

// Cards start folded and the section remembers which ones the user opened, in localStorage —
// which Node doesn't have. This stub is how a test says "this card is open".
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
});

function render(runners: Runner[], { open = true, path = '/providers' } = {}) {
  store.clear();
  if (open) {
    store.set('orbit:providers-expanded-runners', JSON.stringify(runners.map((r) => r.id)));
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], runners);
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
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

  it('starts folded, so a page of set-up machines is a list rather than a wall', () => {
    const html = render(
      [
        runner({
          engines: [health({ engine: 'claude' }), health({ engine: 'codex', auth: 'no' })],
        }),
      ],
      { open: false },
    );

    // The card is there and says how it's doing — it just isn't unpacked into a row per engine.
    expect(html).toContain('mac-studio');
    expect(html).toContain('1 of 3 signed in');
    expect(html).not.toContain('Signed out');
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

  it('marks the one row a "Not signed in" link came here for', () => {
    const box = runner({
      engines: [
        health({ engine: 'claude' }),
        health({ engine: 'codex', auth: 'no' }),
        health({ engine: 'kimi' }),
      ],
    });
    const path = `/providers?runner=${encodeId(box.id)}&engine=codex`;
    const html = render([box], { path });
    // Exactly one row is marked, and it's the engine the link named — not the first one drawn.
    expect(html.match(/re-row focused/g)).toHaveLength(1);
    expect(html.slice(html.indexOf('re-row focused'))).toContain('Codex');
    // An unnamed engine, or no link at all, marks nothing.
    expect(render([box], { path: `/providers?runner=${encodeId(box.id)}` })).not.toContain(
      'focused',
    );
    expect(render([box])).not.toContain('focused');
  });

  it('says who keeps these current, and offers the way to do it sooner', () => {
    const html = render([
      runner({ engines: [health({ engine: 'claude', version: '2.1.220' })] }),
    ]);
    // The answer to "do I have to manage this?" — said once, at the top, not per row.
    expect(html).toContain('Orbit keeps these CLIs updated daily.');
    expect(html).toContain('Update engines');
  });

  it("doesn't offer to update a machine that isn't there", () => {
    const html = render([runner({ online: false, engines: [health({})] })]);
    expect(html).toContain('Offline');
    expect(html).not.toContain('Update engines');
  });

  it('reports what an update actually did, including what it left alone', () => {
    const html = render([
      runner({
        engines: [health({ engine: 'claude', version: '2.1.220' })],
        install: install({
          status: 'done',
          engine: null,
          mode: 'update',
          command: 'orbit engine-update',
          message:
            'Claude Code updated 2.1.219 → 2.1.220\nCodex — 2 sessions running, it\'ll update once they finish',
        }),
      }),
    ]);
    expect(html).toContain('2.1.219');
    // The part a silent skip would have hidden: the button did less than it looked like it did.
    expect(html).toContain('sessions running');
    expect(html).toContain('Dismiss');
  });

  it('shows a drifting engine the machine\'s own reason, and how to watch it fail', () => {
    const html = render([
      runner({
        engines: [
          health({
            engine: 'codex',
            version: '0.146.0',
            update: {
              status: 'failed',
              at: new Date(Date.now() - 3600_000).toISOString(),
              okAt: new Date(Date.now() - 20 * 86400_000).toISOString(),
              message: 'npm error code EACCES: /usr/lib/node_modules/@openai/codex',
            },
          }),
        ],
      }),
    ]);
    expect(html).toContain('not updated in 20d');
    expect(html).toContain('EACCES');
    // No Retry: the same command will fail the same way. What's offered is the way to see it.
    expect(html).toContain('orbit engine-update');
    expect(html).not.toContain('Retry');
  });

  it('keeps a working machine quiet, with the fact still on the row', () => {
    const html = render([
      runner({
        engines: [
          health({
            engine: 'claude',
            version: '2.1.220',
            update: {
              status: 'ok',
              at: new Date(Date.now() - 6 * 3600_000).toISOString(),
              okAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
            },
          }),
        ],
      }),
    ]);
    expect(html).toContain('updated 6h ago');
    // Nothing to act on: no panel, no colour, no button beyond the standing one.
    expect(html).not.toContain('re-panel warn');
  });

  it("a folded card admits it isn't updating, ahead of the good news", () => {
    const drifted = runner({
      engines: [
        health({
          engine: 'claude',
          update: { status: 'failed', at: daysAgo(1), okAt: daysAgo(30), message: 'EACCES' },
        }),
      ],
    });
    expect(summaryOf(drifted)).toBe('1 engine not updating');
    // An offline machine isn't drifting, it's away — and the header already says so.
    expect(summaryOf({ ...drifted, online: false })).toBe('1 of 3 signed in');
    // An update in flight, and its outcome, are the card's news while they last.
    expect(
      summaryOf(runner({ engines: [health({})], install: install({ status: 'installing', mode: 'update' }) })),
    ).toBe('Updating…');
    expect(
      summaryOf(runner({ engines: [health({})], install: install({ status: 'failed', mode: 'update' }) })),
    ).toBe('Update failed');
  });

  it('offers the free route first when there is no runner at all', () => {
    const html = render([]);

    expect(html).toContain('Already pay for Claude, Codex or Kimi?');
    expect(html).toContain('Add a runner');
  });
});
