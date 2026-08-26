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

  it('keeps the judgment inbox in TOP while leaving individual Workspaces out of a redundant parent', () => {
    const topBlock =
      source.match(/const TOP(?:\s*:\s*TopNavItem\[\])?\s*=\s*\[([\s\S]*?)\n\];/)?.[1] ?? '';
    const keys = [...topBlock.matchAll(/key:\s*'([^']+)'/g)].map((match) => match[1]);
    expect(keys).toEqual(['judgments', 'projects', 'runners', 'providers']);
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

  it('keeps the trailing spinner markup as the mobile fallback', () => {
    const running = renderToStaticMarkup(
      <WorkspaceStateMark offline={false} running needsYou={0} />,
    );
    expect(running).toContain('anticon-loading');
    expect(running).toContain('anticon-spin');
    expect(running).toContain('color:var(--brand)');
    expect(running).toContain('font-size:16px');
    expect(running).toContain('aria-label="Session running"');

    const idle = renderToStaticMarkup(
      <WorkspaceStateMark offline={false} running={false} needsYou={0} />,
    );
    expect(idle).toBe('');
  });

  it('uses quiet Workspace dots across desktop routes in both sidebar densities', () => {
    const html = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active
        offline={false}
        running
        needsYou={0}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('tp-workspace-icon-running');
    expect(html).toContain('title="Running"');
    expect(html).toContain('aria-label="Workspace has a running session"');
    expect(html).toContain('anticon-loading');
    expect(styles).toMatch(
      /\.tp-workspace-icon-running\s*\{[\s\S]*?display:\s*none;[\s\S]*?width:\s*6px;[\s\S]*?height:\s*6px;[\s\S]*?background:\s*var\(--brand\)/,
    );
    const dotRule = styles.match(/\.tp-workspace-icon-running\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(dotRule).not.toContain('animation');
    expect(styles).toMatch(
      /\.tp-item\.active \.tp-workspace-icon-running\s*\{[\s\S]*?box-shadow:\s*0 0 0 1\.5px var\(--bg-raised\)/,
    );
    const desktopDotSelector =
      '.app-shell .app-nav:not(.collapsed) .tp-workspace-icon-running';
    const desktopSpinnerSelector =
      '.app-shell .app-nav:not(.collapsed) .tp-workspace-running';
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
    expect(desktopStyles).toContain(desktopDotSelector);
    expect(desktopStyles).toContain(desktopSpinnerSelector);
    expect(desktopStyles).toContain(collapsedRailSpinnerSelector);
    expect(desktopStyles).toContain(collapsedRailSvgSelector);
    expect(desktopStyles).toContain(collapsedRailDotSelector);
    expect(
      styles.match(new RegExp(`${desktopDotSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`))?.[1],
    ).toContain('display: block');
    expect(
      styles.match(new RegExp(`${desktopSpinnerSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\}`))?.[1],
    ).toContain('display: none');
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

  it('keeps needs-you and offline states ahead of the quiet running dot', () => {
    const needsYou = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active={false}
        offline={false}
        running
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
        needsYou={0}
        onOpen={() => undefined}
      />,
    );
    expect(needsYou).toContain('tp-count needs-you');
    expect(needsYou).not.toContain('tp-workspace-icon-running');
    expect(needsYou).not.toContain('anticon-loading');
    expect(offline).toContain('tp-workspace-icon-offline');
    expect(offline).not.toContain('tp-workspace-icon-running');
    expect(offline).not.toContain('anticon-loading');
  });

  it('moves expanded offline state onto the folder and suppresses a stale running signal', () => {
    const expanded = renderToStaticMarkup(
      <WorkspaceRow
        workspace={workspace}
        runnerLabel="wikova"
        active={false}
        offline
        running
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
