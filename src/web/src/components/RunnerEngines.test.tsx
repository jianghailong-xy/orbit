import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { updateNoteOf } from '../lib/runnerEngines';
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

  it('says only what is true of every skip, and never calls one an error', () => {
    // Retrying any of these does nothing, so none of them may read as a failure. And the line
    // must not name a reason: there is more than one, and naming the wrong one is worse than
    // naming none — a Kimi skipped for permissions once read "updated by its package manager",
    // promising an updater that did not exist. The specific reason travels as the tooltip.
    const packageManaged = updateNoteOf(
      { status: 'skipped', at: hoursAgo(4), okAt: daysAgo(40), message: 'Installed by a package manager (/opt/homebrew/bin/codex)' },
      NOW,
    );
    const notOurs = updateNoteOf(
      { status: 'skipped', at: hoursAgo(4), message: "Installed at /usr/lib/node_modules/opencode-ai/bin/opencode.exe, which this runner can't replace — it runs as husong." },
      NOW,
    );
    expect(packageManaged).toEqual({ tone: 'quiet', text: 'not auto-updated' });
    // Both skips get the same words, because the row can only honestly claim what they share.
    expect(notOurs).toEqual(packageManaged);
  });

  it('survives a record it cannot age', () => {
    expect(updateNoteOf({ status: 'ok', at: 'nonsense' }, NOW)).toEqual({
      tone: 'warn',
      text: 'never updated',
    });
  });

  it('tells a pass that fetched something from one that only asked', () => {
    // Two different claims, and the row may only make the one it can back up.
    expect(updateNoteOf({ status: 'updated', at: hoursAgo(6), okAt: hoursAgo(6), updatedAt: hoursAgo(6) }, NOW)?.text).toBe(
      'updated 6h ago',
    );
    expect(updateNoteOf({ status: 'checked', at: hoursAgo(6), okAt: hoursAgo(6), updatedAt: daysAgo(3) }, NOW)?.text).toBe(
      'checked 6h ago',
    );
  });

  it('warns on measured drift even while every pass keeps reporting clean', () => {
    // The regression this whole reading exists for. Workstation asked every day, was told
    // 2.1.228 was published, could never fetch it — and because "asked and answered" kept
    // stamping okAt, the old rule read a healthy week and stayed quiet. The clock that matters
    // is the one on the binary: 9 days behind is 9 days behind whatever the commands returned.
    expect(
      updateNoteOf(
        {
          status: 'checked',
          at: hoursAgo(1),
          okAt: hoursAgo(1),
          latest: '2.1.228',
          behindSince: daysAgo(9),
        },
        NOW,
      ),
    ).toEqual({ tone: 'warn', text: '9d behind 2.1.228' });
    // Same drift reached the other way — an updater that errors nightly rather than one that
    // exits 0 without moving anything. Same consequence, so the same warning.
    expect(
      updateNoteOf(
        { status: 'failed', at: hoursAgo(1), okAt: daysAgo(4), latest: '2.1.228', behindSince: daysAgo(9), message: 'timed out' },
        NOW,
      ),
    ).toEqual({ tone: 'warn', text: '9d behind 2.1.228' });
  });

  it('stays quiet about drift a daily pass is expected to close', () => {
    // These CLIs ship most days, so "behind" is the normal state of a healthy machine for a few
    // hours. Warning here would mean warning on every runner, every release.
    expect(
      updateNoteOf({ status: 'checked', at: hoursAgo(2), okAt: hoursAgo(2), latest: '2.1.228', behindSince: hoursAgo(5) }, NOW),
    ).toEqual({ tone: 'quiet', text: 'updating to 2.1.228' });
    // A failure inside that window is still just a footnote — the pass retries on its own.
    expect(
      updateNoteOf({ status: 'failed', at: hoursAgo(2), okAt: daysAgo(1), latest: '2.1.228', behindSince: hoursAgo(5), message: 'blip' }, NOW),
    ).toEqual({ tone: 'quiet', text: 'last update failed · retrying daily' });
  });

  it('falls back to the old reading for a runner that reports no drift at all', () => {
    // Runners predating the release-feed probe send no behindSince, and neither does one that
    // can't reach the feed. Their rows have to keep working rather than going blank.
    expect(updateNoteOf({ status: 'ok', at: daysAgo(30), okAt: daysAgo(30) }, NOW)).toEqual({
      tone: 'warn',
      text: 'not updated in 30d',
    });
  });
});

const runner = (over: Partial<Runner>): Runner => ({
  // The public id, because that is what an opted-in client is handed (`X-Orbit-Id-Format:
  // public`). It has to match the spelling `routeId` produces from `?runner=…`, or the
  // "came here for this row" focus silently marks nothing — which is the whole failure mode
  // the flip to one internal spelling exists to remove.
  // = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a')
  id: '33zx0JhRhJo8rd25d3qAM',
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

  it('says who keeps these current without offering to do it here', () => {
    const box = runner({ engines: [health({ engine: 'claude', version: '2.1.220' })] });
    const html = render([box]);
    // The answer to "do I have to manage this?" — said once, at the top, not per row.
    expect(html).toContain('Orbit keeps these CLIs updated daily.');
    // But not the lever. `POST /runners/:id/engine-update` takes no engine: its object is the
    // machine, and every other control on this page is scoped to one (runner, engine) pair. It
    // lives on the machine's own page, which this card already links to.
    expect(html).not.toContain('Update engines');
    expect(html).toContain(`/runners/${encodeId(box.id)}`);
  });

  it('does not report an update run it no longer owns', () => {
    // The report names every CLI the pass touched, OpenCode included — and this page has no
    // OpenCode row. A machine-scoped summary on a page that shows a subset of the machine was
    // the mismatch that put this whole panel on the wrong page.
    const html = render([
      runner({
        engines: [health({ engine: 'claude', version: '2.1.220' })],
        install: install({
          status: 'done',
          engine: null,
          mode: 'update',
          command: 'orbit engine-update',
          message:
            'Claude Code updated 2.1.219 → 2.1.220\nOpenCode — already up to date (1.18.16)',
        }),
      }),
    ]);
    expect(html).not.toContain('2.1.219');
    expect(html).not.toContain('OpenCode');
    expect(html).not.toContain('Dismiss');
  });

  it('shows only the engines it can offer a sign-in for', () => {
    // A runner reports every CLI on the machine. This page is about identity, and OpenCode has
    // no relayable sign-in — a row nobody could act on is worse than no row.
    const html = render([
      runner({
        engines: [
          health({ engine: 'claude', version: '2.1.228' }),
          health({ engine: 'opencode', version: '1.18.16', auth: 'unknown' }),
        ],
      }),
    ]);
    expect(html).toContain('Claude Code');
    expect(html).not.toContain('OpenCode');
  });

  it('never summarizes a folded card with a problem the card cannot show', () => {
    // Drift on OpenCode is real and worth saying — on the machine's page. Counting it here would
    // put "1 engine not updating" on a card whose every row is fine, with nothing to unfold to.
    // summaryOf reads the real clock (it renders, it isn't a pure rule), so these are real offsets.
    const hAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const drifting = runner({
      engines: [
        health({
          engine: 'claude',
          version: '2.1.228',
          update: { status: 'checked', at: hAgo(1), okAt: hAgo(1) },
        }),
        health({
          engine: 'opencode',
          version: '1.18.0',
          auth: 'unknown',
          update: { status: 'failed', at: hAgo(1), okAt: hAgo(30 * 24), message: 'EACCES' },
        }),
      ],
    });
    expect(summaryOf(drifting)).not.toContain('not updating');
    // Sanity: the same record on an engine this page does show is still counted, so the filter
    // is scoping the summary rather than disabling it.
    const shown = runner({
      engines: [
        health({
          engine: 'codex',
          version: '0.146.0',
          update: { status: 'failed', at: hAgo(1), okAt: hAgo(30 * 24), message: 'EACCES' },
        }),
      ],
    });
    expect(summaryOf(shown)).toBe('1 engine not updating');
  });

  it("shows a drifting engine the machine's own reason, and points at where to act", () => {
    const box = runner({
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
    });
    const html = render([box]);
    // The symptom stays on the row — it answers "is this row's version trustworthy", which is
    // this page's business. Only the remedy moved.
    expect(html).toContain('not updated in 20d');
    expect(html).toContain('EACCES');
    // No Retry: the same command will fail the same way. And no shell command either — telling
    // someone to open a terminal for something the UI can do was a symptom of the misplacement.
    expect(html).toContain(`/runners/${encodeId(box.id)}`);
    expect(html).not.toContain('orbit engine-update');
    expect(html).not.toContain('Retry');
  });

  it('keeps the reason reachable when the line is too short to hold it', () => {
    const html = render([
      runner({
        engines: [
          health({
            engine: 'kimi',
            version: '0.32.0',
            update: {
              status: 'skipped',
              at: new Date(Date.now() - 4 * 3600_000).toISOString(),
              message:
                "Installed at /usr/lib/node_modules/kimi/bin/kimi, which this runner can't replace — it runs as husong.",
            },
          }),
        ],
      }),
    ]);
    // The line says only what every skip shares...
    expect(html).toContain('not auto-updated');
    // ...and the part it had to leave out — which path, which account — is one hover away
    // rather than gone. Without this, "not auto-updated" would be unactionable.
    expect(html).toContain('it runs as husong');
    expect(html).toContain('title="Installed at');
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
