import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { providerPoolsQuery, type ProviderPool } from '../lib/providerPools';
import { meQuery, runnersQuery, workspacesQuery, type UserPreferences } from '../lib/queries';
import { sharedPoolsQuery } from '../lib/sharedPools';
import { SettingsPage } from './SettingsPage';

// The theme control reaches for localStorage and matchMedia, neither of which Node has, and it
// is not what these tests are about.
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));

/** The page with the queries it reads seeded, so nothing has to be fetched — the machines and the pools
 *  only when given, as they are still being read otherwise, and with them their workspaces (none unless
 *  given; null leaves them still being read). */
function render(
  preferences: UserPreferences,
  machines?: { runners: unknown[]; pools: ProviderPool[]; workspaces?: unknown[] | null },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meQuery().queryKey, { id: 'u1', email: 'a@b.c', name: 'A', preferences });
  if (machines) {
    qc.setQueryData(runnersQuery().queryKey, machines.runners);
    if (machines.workspaces !== null) qc.setQueryData(workspacesQuery().queryKey, machines.workspaces ?? []);
    qc.setQueryData(providerPoolsQuery().queryKey, machines.pools);
    qc.setQueryData(sharedPoolsQuery().queryKey, []);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The switch in the row that names it — the page has other switches (the two alert ones). */
function switchAfter(html: string, label: string): string {
  const row = html.slice(html.indexOf(`<div>${label}</div>`));
  return row.match(/<[a-z]+[^>]*role="switch"[^>]*>/)?.[0] ?? '';
}

describe('session orchestration, one switch for the whole account', () => {
  it('is on for an account that never said otherwise', () => {
    // Absent means on: only turning it off is ever written.
    const html = render({});
    expect(switchAfter(html, 'Let sessions orchestrate')).toContain('aria-checked="true"');
    expect(html).toContain('Sessions in every workspace can spawn and manage other sessions');
  });

  it('reads off once the account turned it off', () => {
    const html = render({ enableOrchestration: false });
    expect(switchAfter(html, 'Let sessions orchestrate')).toContain('aria-checked="false"');
  });

  it('no longer counts or sets workspaces one by one', () => {
    const html = render({});
    expect(html).not.toContain('can orchestrate now');
    expect(html).not.toContain('Turn on for all');
  });
});

describe('the way into Settings → Shared links', () => {
  it('is a Sharing section that names the page and offers to manage it', () => {
    const html = render({});
    // Card title, then the row: what the page is, what it holds, and the button that opens it.
    expect(html).toMatch(/<h2[^>]*>Sharing<\/h2>/);
    expect(html).toContain('<div>Shared links</div>');
    expect(html).toContain('Everything you’ve made viewable by link');
    expect(html).toMatch(/<button[^>]*><span>Manage<\/span><\/button>/);
  });
});

describe('the way into Machines & models (docs/mocks/machines-and-models, 02)', () => {
  const online = (id: string) => ({ id, name: id, online: true });
  const value = (html: string) => html.match(/class="settings-machines-value"[^>]*>([^<]*)</)?.[1] ?? null;

  it('is a card that names what the page holds, with its line and Manage', () => {
    const html = render({});
    expect(html).toMatch(/<h2[^>]*>Machines &amp; models<\/h2>/);
    expect(html).toContain('<div>Machines, API keys and account pools</div>');
    expect(html).toContain('Where your agents run, and whose model quota they spend.');
    expect(html.slice(html.indexOf('Machines, API keys'))).toMatch(/<button[^>]*><span>Manage<\/span><\/button>/);
  });

  it('says nothing more until the machines and the pools have been read', () => {
    expect(value(render({}))).toBeNull();
  });

  it('says how many machines are online when nothing needs you, as the phone’s row does', () => {
    expect(value(render({}, { runners: [online('a'), online('b')], pools: [] }))).toBe('2 of 2 online');
    expect(value(render({}, { runners: [], pools: [] }))).toBe('None');
  });

  it('counts, in amber, a machine offline and a pool nothing can start on', () => {
    const pool = { id: 'p1', slug: 'team', label: 'Team', resetsAt: null, unavailable: 'Not signed in', members: [], engine: 'claude' };
    const html = render({}, { runners: [online('a'), { id: 'b', name: 'b', online: false }], pools: [pool] });
    expect(value(html)).toBe('2 need you');
    expect(html).toMatch(/class="settings-machines-value" style="[^"]*color:var\(--warning\)/);
    expect(value(render({}, { runners: [online('a'), { id: 'b', name: 'b', online: false }], pools: [] }))).toBe('1 needs you');
  });

  // docs/mocks/first-workspace-in-conversation 02 (Settings) and rule 10 of 04: the machine's page
  // says "No coding CLI is signed in" (runnerAttention's noCliSignedIn), and this row counts it.
  describe('a machine online where no coding CLI is signed in', () => {
    const cli = (engine: string, auth: string) => ({ engine, installed: true, auth });
    // orbit@austin on 2026-10-31: Claude Code and Codex installed, neither signed in, no workspace.
    const austin = { ...online('austin'), engines: [cli('claude', 'no'), cli('codex', 'no')] };
    const workspace = (runnerId: string, lastProvider: string | null) => ({
      id: `w-${runnerId}`,
      name: 'app',
      runnerId,
      lastProvider,
    });

    it('needs you, with no workspace or with workspaces on those logins', () => {
      const html = render({}, { runners: [austin], pools: [] });
      expect(value(html)).toBe('1 needs you');
      expect(html).toMatch(/class="settings-machines-value" style="[^"]*color:var\(--warning\)/);
      expect(value(render({}, { runners: [austin], pools: [], workspaces: [workspace('austin', 'claude')] }))).toBe(
        '1 needs you',
      );
      expect(value(render({}, { runners: [austin], pools: [], workspaces: [workspace('austin', null)] }))).toBe(
        '1 needs you',
      );
    });

    it('is not counted while a workspace on it runs on a key or a pool, which needs no sign-in', () => {
      expect(value(render({}, { runners: [austin], pools: [], workspaces: [workspace('austin', 'deepseek')] }))).toBe(
        '1 of 1 online',
      );
      // A key another machine's workspace runs on does nothing for this one.
      const hpc = { ...online('hpc'), engines: [cli('claude', 'yes')] };
      expect(
        value(render({}, { runners: [hpc, austin], pools: [], workspaces: [workspace('hpc', 'deepseek')] })),
      ).toBe('1 needs you');
    });

    it('adds to the machines offline and the pools nothing can start on, and an offline one counts once', () => {
      const pool = {
        id: 'p1',
        slug: 'team',
        label: 'Team',
        resetsAt: null,
        unavailable: 'Not signed in',
        members: [],
        engine: 'claude',
      };
      const offline = { id: 'b', name: 'b', online: false, engines: [cli('claude', 'no')] };
      expect(value(render({}, { runners: [austin, offline], pools: [pool] }))).toBe('3 need you');
      expect(value(render({}, { runners: [online('a'), offline], pools: [] }))).toBe('1 needs you');
    });

    it('says nothing more until the workspaces have been read', () => {
      expect(value(render({}, { runners: [austin], pools: [], workspaces: null }))).toBeNull();
    });
  });

  it('counts no engine signed out beside one that is signed in, though the machine’s page tells a workspace on it', () => {
    const out = {
      ...online('a'),
      engines: [
        { engine: 'claude', installed: true, auth: 'yes' },
        { engine: 'codex', installed: true, auth: 'no' },
      ],
    };
    const onCodex = { id: 'w', name: 'tools', runnerId: 'a', lastProvider: 'codex' };
    expect(value(render({}, { runners: [out], pools: [] }))).toBe('1 of 1 online');
    expect(value(render({}, { runners: [out], pools: [], workspaces: [onCodex] }))).toBe('1 of 1 online');
  });
});

describe('the order of the cards', () => {
  it('reads how sessions start, then where agents run, then the alerts and the look, then sharing', () => {
    // The phones open with Machines & models instead and keep the session cards on a page of their own
    // (SettingsHome and SessionSettings in OrbitKit, docs/mocks/ios-settings-order); this page keeps its
    // order. Access tokens comes last: the web's alone until the apps list tokens too.
    const html = render({});
    const titles = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    expect(titles).toEqual([
      'Session defaults',
      'Session orchestration',
      'Machines & models',
      'Notifications',
      'Appearance',
      'Sharing',
      'Access tokens',
    ]);
  });
});
