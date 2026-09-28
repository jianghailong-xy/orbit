import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiSpaceHealth } from '@orbit/shared';
import { WikiPage } from '../pages/WikiPage';

vi.hoisted(() => {
  const noop = (): void => undefined;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop });
});

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

/**
 * The status line as the Wiki page draws it, for every case of `src/shared/src/wiki-health.fixture.json`:
 * the whole line in the fixture's words (the phone's line — the desktop's adds the review count, which
 * the phone hides), coloured the look's way, and its two links going where the mocks say. OrbitKit's
 * `WikiHealthCopyParityTests` holds iOS to the same `line`.
 */

interface Fixture {
  now: string;
  space: { id: string; slug: string; title: string; rootCommitSha: string; pendingOps: number };
  cases: Array<{ name: string; health: WikiSpaceHealth; text: string; line: string }>;
}

function fixture(): Fixture {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-health.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-health.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-health.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

const shared = fixture();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(shared.now));
});

afterEach(() => {
  vi.useRealTimers();
});

/** The Wiki home with the fixture's space and a health read, as the page's own route tree draws it. */
function paint(health: WikiSpaceHealth | undefined): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { space } = shared;
  client.setQueryData(['wiki', 'spaces'], [space]);
  client.setQueryData(['wiki', 'space', space.id], { ...space, repoUrlNorm: null, settings: {}, bindings: [], topics: [] });
  if (health) client.setQueryData(['wiki', 'space', space.id, 'health'], health);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/wiki/${space.slug}`]}>
        <Routes>
          <Route path="/wiki/:space" element={<WikiPage route="home" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The status row's markup. */
function statusRow(html: string): string {
  const start = html.indexOf('<div class="project-integration wk-status-row">');
  expect(start, 'the page draws its status row').toBeGreaterThan(-1);
  const end = html.indexOf('</div></div>', start);
  return html.slice(start, end);
}

/** A row's words as a reader sees them, with the review count the phone hides left out. */
function phoneText(row: string): string {
  return row
    .replace(/<span class="wk-status-review">[\s\S]*?to review<\/span><\/span>/u, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

describe('the Wiki home’s status line', () => {
  for (const one of shared.cases) {
    it(`says the fixture’s line: ${one.name}`, () => {
      const row = statusRow(paint(one.health));
      // The dot is drawn, not written: the line's `● ` is the coloured dot before the look's words.
      expect(phoneText(row)).toBe(one.line.replace('● ', ''));
      // The desktop's line: the review count after the entries, then the same.
      expect(row).toContain(`<b>${shared.space.pendingOps}</b> to review`);
    });
  }

  it('colours a run that waits amber and one that broke red, with the dot before it', () => {
    const behind = shared.cases.find((one) => one.health.maintenance.look === 'behind')!;
    const failing = shared.cases.find((one) => one.health.maintenance.look === 'failing')!;
    const amber = statusRow(paint(behind.health));
    expect(amber).toContain('<span class="wk-maint wk-maint--warn"><span class="wk-maint-dot" aria-hidden="true"></span><b>Maintenance behind</b></span>');
    const red = statusRow(paint(failing.health));
    expect(red).toMatch(/<span class="wk-maint wk-maint--error"><span class="wk-maint-dot" aria-hidden="true"><\/span><b>Maintenance failed( \d+ times)?<\/b><\/span>/u);
    const ok = statusRow(paint(shared.cases.find((one) => /^Maintained /u.test(one.text))!.health));
    expect(ok).toContain('<span class="wk-maint-ok">✓</span>');
    const running = statusRow(paint(shared.cases.find((one) => one.health.maintenance.look === 'running')!.health));
    expect(running).toContain('<span class="wk-maint-spin" aria-hidden="true"></span>');
  });

  it('leads Set up to the space’s Wiki settings and View run to the session of the run that failed', () => {
    const off = statusRow(paint(shared.cases.find((one) => one.health.maintenance.look === 'off')!.health));
    expect(off).toMatch(new RegExp(`<a class="wk-maint-link" href="/wiki/${shared.space.slug}/settings"[^>]*>Set up</a>`, 'u'));
    const failing = shared.cases.find((one) => one.health.maintenance.lastRun?.sessionId && one.health.maintenance.look === 'failing')!;
    const row = statusRow(paint(failing.health));
    expect(row).toMatch(new RegExp(`<a class="wk-maint-link" href="/sessions/${failing.health.maintenance.lastRun!.sessionId}"[^>]*>View run</a>`, 'u'));
  });

  it('counts every active entry the health read says, and says nothing of maintenance before it is in', () => {
    const one = shared.cases[0]!;
    expect(statusRow(paint(one.health))).toContain('<b>11,689</b> entries');
    const before = statusRow(paint(undefined));
    expect(before).not.toContain('wk-maint');
    expect(before).toContain('Anchors verified at 1588c3b');
  });
});
