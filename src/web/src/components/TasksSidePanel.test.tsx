import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  handleProjectsShortcut,
  handleNavActivation,
  projectsShortcutLabel,
  WorkspaceRow,
  WorkspaceStateMark,
  workspaceCountsPollInterval,
  workspaceRunnerIsOffline,
  workspaceShortcutLabel,
} from './TasksSidePanel';

// TasksSidePanel itself reaches for localStorage, several polled queries and an SSE hook on
// mount, none of which exist in this Node test environment — so instead of mounting it, this
// asserts directly on the source for the two contract points TOP (not exported) drives: the
// fixed nav array both surfaces render from, and the `sel === t.key` highlight it feeds.
const source = readFileSync(fileURLToPath(new URL('./TasksSidePanel.tsx', import.meta.url)), 'utf8');
const styles = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

describe('TasksSidePanel nav', () => {
  it('adds Projects (icon, label, and shortcut) to the fixed TOP nav', () => {
    const topBlock =
      source.match(/const TOP(?:\s*:\s*TopNavItem\[\])?\s*=\s*\[([\s\S]*?)\n\];/)?.[1] ?? '';
    expect(topBlock).toMatch(
      /\{\s*key:\s*'projects',\s*icon:\s*<ProjectOutlined\s*\/>,\s*label:\s*'Projects',\s*shortcut:\s*projectsShortcutLabel\(\)\s*,?\s*\}/,
    );
  });

  it('opens Projects with Cmd/Ctrl+P and takes the chord from browser Print', () => {
    const run = (overrides: Partial<Parameters<typeof handleProjectsShortcut>[0]> = {}) => {
      let opened = 0;
      let prevented = 0;
      const handled = handleProjectsShortcut(
        {
          altKey: false,
          ctrlKey: false,
          key: 'p',
          metaKey: true,
          preventDefault: () => {
            prevented += 1;
          },
          shiftKey: false,
          ...overrides,
        },
        () => {
          opened += 1;
        },
      );
      return { handled, opened, prevented };
    };

    expect(run()).toEqual({ handled: true, opened: 1, prevented: 1 });
    expect(run({ ctrlKey: true, key: 'P', metaKey: false })).toEqual({
      handled: true,
      opened: 1,
      prevented: 1,
    });
    expect(run({ metaKey: false })).toEqual({ handled: false, opened: 0, prevented: 0 });
    expect(run({ altKey: true })).toEqual({ handled: false, opened: 0, prevented: 0 });
    expect(run({ shiftKey: true })).toEqual({ handled: false, opened: 0, prevented: 0 });
    expect(run({ key: 'k' })).toEqual({ handled: false, opened: 0, prevented: 0 });
    expect(source).toContain("handleProjectsShortcut(event, () => openTopNav('projects'))");
  });

  it('shows the Projects shortcut in the expanded sidebar and collapsed-rail tooltip', () => {
    expect(projectsShortcutLabel(true)).toBe('⌘P');
    expect(projectsShortcutLabel(false)).toBe('Ctrl P');
    expect(source).toContain('className="tp-count tp-nav-shortcut"');
    expect(source).toContain("title={`${t.label}${t.shortcut ? `  ${t.shortcut}` : ''}`}");
    expect(styles).toMatch(
      /\.tp-workspace-shortcut,\s*\.tp-nav-shortcut\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(styles).toMatch(
      /@media \(min-width:\s*961px\)[\s\S]*?\.app-shell \.app-nav:not\(\.collapsed\) \.tp-nav-shortcut\s*\{[\s\S]*?display:\s*inline;/,
    );
  });

  it('keeps the fixed destinations in TOP while leaving individual Workspaces out of a redundant parent', () => {
    const topBlock =
      source.match(/const TOP(?:\s*:\s*TopNavItem\[\])?\s*=\s*\[([\s\S]*?)\n\];/)?.[1] ?? '';
    const keys = [...topBlock.matchAll(/key:\s*'([^']+)'/g)].map((match) => match[1]);
    // The judgment inbox stood first here until migration 0229 removed the project acceptance
    // judgment: the page it opened read an endpoint that is no longer served. Following (the
    // watches page, docs/watch-contract.md) stood after Projects until it left the sidebar: its
    // watches are agents' waits, reached from the session that keeps them.
    expect(keys).toEqual(['projects', 'runners', 'providers']);
    expect(source).not.toContain('tp-workspaces-head');
    expect(source).not.toContain('<span className="tp-group-name">Workspaces</span>');
  });

  it('renders TOP-derived items in both the collapsed rail and the expanded nav', () => {
    // The rail maps TOP directly; the expanded section maps navItems, which starts from TOP —
    // so a TOP entry reaches both surfaces without either render site needing its own list.
    expect(source).toMatch(
      /const navItems(?:\s*:\s*TopNavItem\[\])?\s*=\s*\n?\s*me\.data\?\.role === 'ADMIN'\s*\n?\s*\?\s*\[\.\.\.TOP,/,
    );
    expect(source).toContain('{TOP.map((t) => (');
    expect(source).toContain('{navItems.map((t) => (');
  });

  it('makes both fixed-nav surfaces keyboard-operable links with a current-page state', () => {
    let opened = 0;
    let prevented = 0;
    expect(handleNavActivation({
      key: 'Enter',
      preventDefault: () => { prevented += 1; },
    }, () => { opened += 1; })).toBe(true);
    expect({ opened, prevented }).toEqual({ opened: 1, prevented: 1 });
    expect(handleNavActivation({ key: ' ', preventDefault: () => { prevented += 1; } },
      () => { opened += 1; })).toBe(false);
    expect(source.match(/role="link"/g)).toHaveLength(2);
    expect(source.match(/tabIndex=\{0\}/g)).toHaveLength(2);
    expect(source.match(/aria-current=\{sel === t\.key \? 'page' : undefined\}/g)).toHaveLength(2);
  });

  it('highlights the matching TOP item by sel === t.key in both surfaces', () => {
    expect(source).toContain("`tp-rail-item ${sel === t.key ? 'active' : ''}`");
    expect(source).toContain("`tp-item ${sel === t.key ? 'active' : ''}`");
  });

  it('still falls back to pathname.slice(1) for sel — /projects resolves via this untouched branch', () => {
    // Guards against a sidebar-selection refactor: /projects matches none of the special-cased
    // prefixes (/workspaces/, /sessions/, /runner, /lists/), so it must keep landing here to
    // produce sel === 'projects' and light up the entry asserted above.
    expect(source).toContain(': loc.pathname.slice(1);');
  });

  it('leaves fixed navigation unselected for an unresolved workspace/session route', () => {
    expect(source).toMatch(
      /startsWith\('\/workspaces\/'\)[\s\S]*startsWith\('\/sessions\/'\)[\s\S]*\? ''/,
    );
  });

  it('keeps Projects selected on a project detail URL', () => {
    // /projects/<id> would otherwise reach the slice(1) fallback above and produce
    // sel === 'projects/<id>', which matches no TOP key — the entry would go dark on the very
    // page you navigated to from it. This branch has to map the whole subtree back to 'projects'.
    expect(source).toMatch(/startsWith\('\/projects\/'\)\s*\n?\s*\?\s*'projects'/);
    // The runner branch is checked first and its /runner prefix must not swallow it.
    expect(source).not.toMatch(/startsWith\('\/project'\)/);
  });
});

const FIRST = '11111111-1111-4111-8111-111111111111';
const workspace = {
  id: FIRST,
  name: 'orbit',
  createdAt: '2026-08-26T00:00:00.000Z',
  runnerId: 'runner-1',
};

describe('TasksSidePanel workspace navigation', () => {
  it('keeps polling the aggregate quickly for running-only work that coarse SSE omits', () => {
    expect(workspaceCountsPollInterval([{ active: 0, running: 1 }])).toBe(5_000);
    expect(workspaceCountsPollInterval([{ active: 1, running: 0 }])).toBe(5_000);
    // A job in flight is live work the coarse stream cannot see either: at the slow cadence the
    // rail's mark would arrive after the job it is describing.
    expect(workspaceCountsPollInterval([{ active: 0, running: 0, jobs: 1 }])).toBe(5_000);
    expect(workspaceCountsPollInterval([{ active: 0, running: 0 }])).toBe(15_000);
    expect(source).not.toContain('controlLive ? false');
  });

  it('only calls a Runner offline after an explicit resolved false', () => {
    expect(workspaceRunnerIsOffline('runner-1', false)).toBe(true);
    expect(workspaceRunnerIsOffline('runner-1', true)).toBe(false);
    expect(workspaceRunnerIsOffline('runner-1', undefined)).toBe(false);
    expect(workspaceRunnerIsOffline(null, false)).toBe(false);
  });

  it('does not add a second divider when there are no Workspace rows', () => {
    expect(source).toMatch(
      /orderedWorkspaces\.length > 0 &&\s*\(unlistedCount > 0 \|\| activeLists\.length > 0/,
    );
  });

  it('labels exactly the first nine Workspace shortcuts for each desktop platform', () => {
    expect(workspaceShortcutLabel(0, true)).toBe('⌘1');
    expect(workspaceShortcutLabel(8, true)).toBe('⌘9');
    expect(workspaceShortcutLabel(0, false)).toBe('Ctrl 1');
    expect(workspaceShortcutLabel(8, false)).toBe('Ctrl 9');
    expect(workspaceShortcutLabel(9, true)).toBeNull();
    expect(workspaceShortcutLabel(-1, true)).toBeNull();
    expect(workspaceShortcutLabel(0.5, true)).toBeNull();
  });
});

describe('TasksSidePanel workspace rows', () => {
  it('keeps workspace and runner metadata on one row', () => {
    const html = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active={false}
        offline={false}
        running={false}
        jobs={0}
        needsYou={0}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('tp-workspace-label');
    expect(html).toContain('tp-workspace-name">orbit');
    expect(html).toContain('tp-workspace-runner');
    expect(html).toContain('wikova');
    expect(html).not.toContain('inset');
  });

  it('puts a folder in the shared first-level icon column and keeps the collapsed rail unchanged', () => {
    const html = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active
        offline={false}
        running={false}
        jobs={0}
        needsYou={0}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('class="tp-item active"');
    expect(html).toContain('class="tp-ico tp-workspace-icon"');
    expect(html).toContain('anticon-folder');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('tp-workspace-icon-offline');
    expect(html).not.toContain('online');
    expect(html.indexOf('tp-workspace-icon')).toBeLessThan(html.indexOf('tp-workspace-label'));
    expect(styles).toMatch(/\.tp-ico\s*\{[\s\S]*?color:\s*var\(--text-2\)/);
    expect(styles).toMatch(/\.tp-item\.active \.tp-ico\s*\{[\s\S]*?color:\s*var\(--brand\)/);
    expect(styles).toMatch(/\.tp-workspace-icon-offline\s*\{[\s\S]*?position:\s*absolute/);
    expect(source).toContain('<span className="tp-rail-avatar">');
  });

  it('restores the visible desktop shortcut without displacing higher-priority attention', () => {
    const idle = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active={false}
        offline={false}
        running={false}
        jobs={0}
        needsYou={0}
        shortcutLabel="⌘1"
        onOpen={() => undefined}
      />,
    );
    const running = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active={false}
        offline={false}
        running
        jobs={0}
        needsYou={0}
        shortcutLabel="⌘1"
        onOpen={() => undefined}
      />,
    );
    const needsYou = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active={false}
        offline={false}
        running
        jobs={0}
        needsYou={2}
        shortcutLabel="⌘1"
        onOpen={() => undefined}
      />,
    );
    expect(idle).toContain('<kbd class="tp-count tp-workspace-shortcut"');
    expect(idle).toContain('>⌘1</kbd>');
    expect(running).toContain('>⌘1</kbd>');
    expect(running).toContain('tp-workspace-icon-running');
    expect(needsYou).not.toContain('tp-workspace-shortcut');
    expect(needsYou).toContain('tp-count needs-you');
    expect(styles).toMatch(/\.tp-workspace-shortcut\s*\{[\s\S]*?display:\s*none;/);
    expect(styles).toMatch(
      /@media \(min-width:\s*961px\)[\s\S]*?\.app-shell \.app-nav:not\(\.collapsed\) \.tp-workspace-shortcut\s*\{[\s\S]*?display:\s*inline;/,
    );
    expect(source).toContain('{orderedWorkspaces.map((a, index) => {');
    expect(source).toContain('shortcutLabel={workspaceShortcutLabel(index)}');
  });

  it('gives the drawer the folder dot rather than a trailing spinner of its own', () => {
    // The expanded list's trailing slot is the count's alone at every width, so the drawer's
    // running rows line up with its idle ones instead of pushing a spinner in front of a count.
    for (const running of [true, false]) {
      expect(
        renderToStaticMarkup(<WorkspaceStateMark offline={false} running={running} needsYou={0} />),
      ).toBe('');
    }
    // …and no width hides the folder's dots: they are not a desktop-only reveal any more.
    expect(styles).not.toMatch(/\.tp-workspace-icon-(?:running|jobs)\s*\{[^}]*display:\s*none/);
  });

  it('uses quiet Workspace dots at every width and in both sidebar densities', () => {
    const html = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active
        offline={false}
        running
        jobs={0}
        needsYou={0}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('tp-workspace-icon-running');
    expect(html).toContain('title="Running"');
    expect(html).toContain('aria-label="Workspace has a running session"');
    expect(html).not.toContain('anticon-loading');
    expect(styles).toMatch(
      /\.tp-workspace-icon-running\s*\{[\s\S]*?width:\s*6px;[\s\S]*?height:\s*6px;[\s\S]*?background:\s*var\(--brand\)/,
    );
    const dotRule = styles.match(/\.tp-workspace-icon-running\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(dotRule).not.toContain('animation');
    expect(styles).toMatch(
      /\.tp-item\.active \.tp-workspace-icon-running\s*\{[\s\S]*?box-shadow:\s*0 0 0 1\.5px var\(--bg-raised\)/,
    );
    const collapsedRailSpinnerSelector =
      '.app-shell .app-nav.collapsed .tp-rail-running';
    const collapsedRailSvgSelector = `${collapsedRailSpinnerSelector} > svg`;
    const collapsedRailDotSelector = `${collapsedRailSpinnerSelector}::after`;
    const desktopStart = styles.indexOf('@media (min-width: 961px)');
    const mobileStart = styles.indexOf('@media (max-width: 960px)', desktopStart);
    const desktopStyles = styles.slice(desktopStart, mobileStart);
    expect(desktopStart).toBeGreaterThanOrEqual(0);
    expect(mobileStart).toBeGreaterThan(desktopStart);
    expect(desktopStyles).not.toContain(':has(.workspace-split > .session-col)');
    expect(desktopStyles).toContain(collapsedRailSpinnerSelector);
    expect(desktopStyles).toContain(collapsedRailSvgSelector);
    expect(desktopStyles).toContain(collapsedRailDotSelector);
    expect(
      styles.match(new RegExp(`${collapsedRailSpinnerSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`))?.[1],
    ).toMatch(/background:\s*transparent;[\s\S]*animation:\s*none !important;/);
    expect(
      styles.match(new RegExp(`${collapsedRailSvgSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`))?.[1],
    ).toMatch(/visibility:\s*hidden;[\s\S]*animation:\s*none !important;/);
    const collapsedDotRule =
      styles.match(new RegExp(`${collapsedRailDotSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
    expect(collapsedDotRule).toMatch(
      /width:\s*6px;[\s\S]*height:\s*6px;[\s\S]*background:\s*var\(--brand\);[\s\S]*box-shadow:\s*0 0 0 1\.5px var\(--bg-raised\);/,
    );
    expect(collapsedDotRule).not.toContain('animation');
  });

  it('marks background work the rail was silent about, one slot below the working dot', () => {
    const row = (jobs: number, running = false) =>
      renderToStaticMarkup(
        <WorkspaceRow
          workspace={workspace}
          runnerLabel="wikova"
          active={false}
          offline={false}
          running={running}
          jobs={jobs}
          needsYou={0}
          onOpen={() => undefined}
        />,
      );

    // A job in flight with nobody generating: the workspace row was previously blank here.
    const jobsOnly = row(2);
    expect(jobsOnly).toContain('tp-workspace-icon-jobs');
    expect(jobsOnly).toContain('title="2 background jobs running"');
    expect(jobsOnly).toContain('aria-label="Workspace has a background job running"');
    expect(jobsOnly).not.toContain('tp-workspace-icon-running');

    // The same count with a turn also in flight: generation is the louder claim and keeps the slot.
    const both = row(2, true);
    expect(both).toContain('tp-workspace-icon-running');
    expect(both).not.toContain('tp-workspace-icon-jobs');

    // The drawer draws this same breathing dot on the folder; its trailing slot stays the count's.
    const trailing = renderToStaticMarkup(
      <WorkspaceStateMark offline={false} running={false} jobs={1} needsYou={0} />,
    );
    expect(trailing).toBe('');

    // Same brand blue as the dot above — work in flight is activity too — and the only animated
    // mark in this rail: the dot beside it stays still.
    const jobsRule = styles.match(/\.tp-workspace-icon-jobs\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(jobsRule).toMatch(/background:\s*var\(--brand\)/);
    expect(jobsRule).toContain('animation: status-glyph-breathe');
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.tp-workspace-icon-jobs\s*\{\s*animation:\s*none;/,
    );

    // The collapsed rail keeps the language it already has for the spinner: the mark sits at the
    // avatar's corner and becomes the same brand dot there, breathing instead of still.
    const collapsed = renderToStaticMarkup(
      <WorkspaceStateMark compact offline={false} running={false} jobs={1} needsYou={0} />,
    );
    expect(collapsed).toContain('tp-rail-jobs');
    expect(styles).toMatch(/\.tp-rail-jobs\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*1px;/);
    const desktopBlock = styles.slice(styles.indexOf('@media (min-width: 961px)'));
    expect(desktopBlock).toMatch(
      /\.app-shell \.app-nav\.collapsed \.tp-rail-jobs > svg\s*\{\s*visibility:\s*hidden;/,
    );
    expect(
      desktopBlock.match(/\.app-shell \.app-nav\.collapsed \.tp-rail-jobs::after\s*\{([\s\S]*?)\}/)?.[1] ?? '',
    ).toMatch(/background:\s*var\(--brand\);[\s\S]*animation:\s*status-glyph-breathe/);
  });

  it('shows activity beside a needs-you count in every density, and keeps offline ahead of it', () => {
    const needsYou = (running: boolean) =>
      renderToStaticMarkup(
        <WorkspaceRow
          workspace={workspace}
          runnerLabel="wikova"
          active={false}
          offline={false}
          running={running}
          jobs={3}
          needsYou={2}
          onOpen={() => undefined}
        />,
      );
    const offline = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active={false}
        offline
        running
        jobs={3}
        needsYou={0}
        onOpen={() => undefined}
      />,
    );
    // The count and the dot sit at opposite ends of the row and say different things: the server
    // leaves the sessions waiting on you out of `running`/`jobs`, so the dot is other work.
    expect(needsYou(true)).toContain('tp-count needs-you');
    expect(needsYou(true)).toContain('tp-workspace-icon-running');
    expect(needsYou(true)).not.toContain('tp-workspace-icon-jobs');
    // The drawer shows the same folder dot, so no spinner squeezes in front of the count there.
    expect(needsYou(true)).not.toContain('anticon-loading');
    expect(needsYou(false)).toContain('tp-count needs-you');
    expect(needsYou(false)).toContain('tp-workspace-icon-jobs');
    expect(needsYou(false)).not.toContain('tp-workspace-icon-running');
    expect(offline).toContain('tp-workspace-icon-offline');
    expect(offline).not.toContain('tp-workspace-icon-running');
    expect(offline).not.toContain('tp-workspace-icon-jobs');
    expect(offline).not.toContain('anticon-loading');

    // The collapsed rail: the count in the avatar's top corner, activity in its bottom one.
    const rail = (running: boolean, jobs: number) =>
      renderToStaticMarkup(
        <WorkspaceStateMark compact offline={false} running={running} jobs={jobs} needsYou={2} />,
      );
    expect(rail(true, 0)).toContain('tp-rail-badge needs-you');
    expect(rail(true, 0)).toContain('tp-rail-running');
    expect(rail(false, 1)).toContain('tp-rail-badge needs-you');
    expect(rail(false, 1)).toContain('tp-rail-jobs');
    expect(styles).toMatch(/\.tp-rail-badge\s*\{[\s\S]*?top:\s*1px;[\s\S]*?right:\s*1px;/);
    expect(styles).toMatch(/\.tp-rail-running\s*\{[\s\S]*?right:\s*1px;[\s\S]*?bottom:\s*1px;/);
  });

  it('moves expanded offline state onto the folder and suppresses a stale running signal', () => {
    const expanded = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active={false}
        offline
        running
        jobs={0}
        needsYou={0}
        onOpen={() => undefined}
      />,
    );
    const compact = renderToStaticMarkup(
      <WorkspaceStateMark compact offline running needsYou={0} runnerLabel="wikova" />,
    );
    expect(expanded).toContain('tp-workspace-icon-offline');
    expect(expanded).toContain('anticon-disconnect');
    expect(expanded).toContain('role="img"');
    expect(expanded).toContain('aria-label="wikova is offline"');
    expect(expanded).toContain('wikova is offline');
    expect(expanded).not.toContain('tp-workspace-offline');
    expect(expanded).not.toContain('>Offline<');
    expect(expanded).not.toContain('anticon-loading');
    expect(compact).toContain('tp-rail-offline');
    expect(compact).toContain('anticon-disconnect');
    expect(compact).not.toContain('anticon-loading');
  });

  it('uses one priority order in expanded rows and the collapsed rail', () => {
    const expanded = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active={false}
        offline
        running
        jobs={0}
        needsYou={2}
        onOpen={() => undefined}
      />,
    );
    const compact = renderToStaticMarkup(
      <WorkspaceStateMark compact offline running needsYou={2} />,
    );
    expect(expanded).toContain('tp-count needs-you');
    expect(expanded).toContain('tp-workspace-icon-offline');
    expect(compact).toContain('tp-rail-badge needs-you');
    expect(expanded).toContain('aria-label="2 sessions need your reply"');
    expect(compact).toContain('aria-label="2 sessions need your reply"');
    expect(expanded).not.toContain('anticon-loading');
    expect(compact).not.toContain('anticon-loading');
    expect(expanded).toContain('anticon-disconnect');
    expect(compact).not.toContain('anticon-disconnect');

    const compactRunning = renderToStaticMarkup(
      <WorkspaceStateMark compact offline={false} running needsYou={0} />,
    );
    expect(compactRunning).toContain('tp-rail-running');
    expect(compactRunning).toContain('anticon-spin');
    expect(compactRunning).not.toContain('tp-rail-offline');
  });
});
