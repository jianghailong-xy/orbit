// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { ProjectSections, type ProjectSection, type SectionProject } from './ProjectSections';

// Folding is the whole point of a section header, and a fold is a button — which `react-dom/server`
// cannot press. So this file mounts into a real DOM, the way ProjectBlockingLeaderboard's suite does;
// jsdom is selected per file by the docblock above and every other test file still runs in node.

// Real UUIDs: the pill runs each id through encodeId, which throws on anything that is neither
// spelling — a placeholder here would fail the render rather than the assertion.
const project = (n: number, title: string, tasks: number): SectionProject => ({
  id: `0195c0de-0000-7000-8000-00000000000${n}`,
  title,
  _count: { tasks },
});

const STALLED = [project(1, 'FineWeb corpus', 23442)];
const RUNNING = [project(2, 'Coordinator control loop', 110), project(3, 'Runner multi-user', 26)];
const DONE = [project(4, 'Session state model', 24), project(5, 'Dark mode', 9)];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // antd's list subscribes to breakpoints on mount and jsdom ships no matchMedia. The stub answers
  // "no breakpoint matches", which is the desktop reading — the layout is not this file's subject.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(node: ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
}

/** The caller's row, marked so a test can tell an expanded section from a folded one. */
function renderProject(p: SectionProject) {
  return <div data-testid={`row-${p.id}`}>{p.title} — full row</div>;
}

function mountSections(sections: ProjectSection<SectionProject>[]): Promise<void> {
  return mount(<ProjectSections sections={sections} renderProject={renderProject} />);
}

/** Three sections, which is the point: the split gets finer later (stalled / running / …) and
 *  nothing in the component may be counting on there being exactly two. */
const THREE: ProjectSection<SectionProject>[] = [
  { key: 'stalled', title: 'Stalled', note: 'Longest since last activity', projects: STALLED },
  { key: 'running', title: 'Running', note: 'Newest first', projects: RUNNING },
  {
    key: 'completed',
    title: 'Completed',
    note: 'Newest first · folded by default',
    projects: DONE,
    defaultCollapsed: true,
  },
];

const section = (key: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-section="${key}"]`);
  if (!el) throw new Error(`no section named ${key} is on the page`);
  return el;
};

/** The section's own fold control, found the way a reader finds it — inside that header. */
function foldToggle(key: string): HTMLButtonElement {
  const button = section(key).querySelector('button');
  if (!button) throw new Error(`the ${key} section has no fold control`);
  return button;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ProjectSections', () => {
  it('renders every section it is handed, whatever the number of them', async () => {
    await mountSections(THREE);

    expect(container.querySelectorAll('[data-section]')).toHaveLength(3);
    for (const s of THREE) {
      // Name, count and the line naming what the section is ordered by — the three things a
      // header exists to say.
      const text = section(s.key).textContent ?? '';
      expect(text).toContain(s.title);
      expect(text).toContain(String(s.projects.length));
      expect(text).toContain(s.note);
    }
    // Their order is the caller's, not a re-sort of its own.
    expect(
      Array.from(container.querySelectorAll('[data-section]')).map((el) =>
        el.getAttribute('data-section'),
      ),
    ).toEqual(['stalled', 'running', 'completed']);
  });

  it('keeps a section to its own projects', async () => {
    await mountSections(THREE);

    expect(section('running').textContent).toContain('Coordinator control loop');
    expect(section('running').textContent).not.toContain('FineWeb corpus');
    expect(section('running').textContent).not.toContain('Session state model');
    expect(section('stalled').textContent).not.toContain('Runner multi-user');
  });

  it('drops a section with nothing in it — a header counting zero is noise', async () => {
    await mountSections([
      { key: 'stalled', title: 'Stalled', note: 'Longest since last activity', projects: [] },
      { key: 'running', title: 'Running', note: 'Newest first', projects: RUNNING },
    ]);

    expect(container.querySelector('[data-section="stalled"]')).toBeNull();
    expect(container.textContent).not.toContain('Stalled');
    expect(container.querySelector('[data-section="running"]')).not.toBeNull();
  });

  it('folds a defaultCollapsed section into one pill per project, rows and all', async () => {
    await mountSections(THREE);

    // Folded: the projects are still named and still counted, but none of them spends a row.
    expect(section('completed').textContent).toContain('Session state model');
    expect(section('completed').textContent).toContain('Dark mode');
    expect(section('completed').querySelectorAll('[data-testid^="row-"]')).toHaveLength(0);
    expect(section('completed').textContent).not.toContain('full row');
    expect(foldToggle('completed').getAttribute('aria-expanded')).toBe('false');

    // ...while the sections that were not asked to fold are open, with the caller's rows in them.
    expect(section('running').querySelectorAll('[data-testid^="row-"]')).toHaveLength(2);
    expect(foldToggle('running').getAttribute('aria-expanded')).toBe('true');
  });

  it('gives a folded project the same destination its row has', async () => {
    await mountSections(THREE);

    const pill = section('completed').querySelector('a');
    expect(pill?.getAttribute('href')).toBe(`/projects/${encodeId(DONE[0].id)}`);
    // The short public id, never the raw UUID — the spelling every other link in the app uses.
    expect(section('completed').innerHTML).not.toContain(DONE[0].id);
  });

  it('opens a folded section on demand, and folds an open one', async () => {
    await mountSections(THREE);

    await click(foldToggle('completed'));
    expect(section('completed').querySelectorAll('[data-testid^="row-"]')).toHaveLength(2);
    expect(section('completed').textContent).toContain('Session state model — full row');
    expect(foldToggle('completed').getAttribute('aria-expanded')).toBe('true');

    // The same control the other way round: a section that started open folds to pills.
    await click(foldToggle('running'));
    expect(section('running').querySelectorAll('[data-testid^="row-"]')).toHaveLength(0);
    expect(section('running').textContent).toContain('Coordinator control loop');
    expect(foldToggle('running').getAttribute('aria-expanded')).toBe('false');
    // Folding one section leaves every other one where the reader left it.
    expect(section('completed').querySelectorAll('[data-testid^="row-"]')).toHaveLength(2);
  });

  it('names its own body from the header, so the fold control says what it opens', async () => {
    await mountSections(THREE);

    // getElementById rather than a selector: useId spells its ids with colons, which querySelector
    // reads as a pseudo-class.
    const body = document.getElementById(foldToggle('completed').getAttribute('aria-controls') ?? '');
    expect(body && section('completed').contains(body)).toBe(true);
    const heading = document.getElementById(
      section('completed').getAttribute('aria-labelledby') ?? '',
    );
    expect(heading?.textContent).toBe('Completed');
  });
});
