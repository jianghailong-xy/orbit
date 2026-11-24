// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu } from './ui/Menu';
import { useSessionTagLevel } from './SessionTagPicker';
import type { SessionTagRef } from '../lib/sessionGrouping';

/**
 * The session menu's Tags level (docs/mocks/session-header-menu ②-C): however large the library, it shows the
 * session's own tags, five more, an All N tags… level and the seven colour tags as swatches; a search names every
 * match and offers Create "…" when none is the typed name.
 */

vi.mock('../lib/sessionTags', () => ({
  recentSessionTagIds: () => ['t-3'],
  createSessionTag: vi.fn(async (name: string, color: string) => ({ id: 't-new', name, color, isSystem: false, position: 99 })),
}));

const COLOURS = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Gray'];
const LIBRARY: SessionTagRef[] = [
  ...COLOURS.map((name, i) => ({ id: `c-${i}`, name, color: `#00000${i}`, isSystem: true, position: i })),
  ...Array.from({ length: 30 }, (_, i) => ({ id: `t-${i}`, name: `topic ${i}`, color: '#123456', isSystem: false, position: 7 + i })),
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const toggled: string[] = [];
const created: string[] = [];

function Harness({ selected }: { selected: string[] }) {
  const [open, setOpen] = useState(true);
  const level = useSessionTagLevel({
    library: LIBRARY,
    selectedIds: selected,
    saving: false,
    onToggle: (id) => toggled.push(id),
    onCreated: (tag) => created.push(tag.name),
  });
  return (
    <Menu trigger={<button type="button">More</button>} open={open} onOpenChange={setOpen}
      items={[{ key: 'tags', label: 'Tags', open: true, children: level.children, levelHeader: level.levelHeader, levelFooter: level.levelFooter }]} />
  );
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 6; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const level = () => document.querySelectorAll<HTMLElement>('[role="menu"]')[1];
const rowNames = () => [...level().querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"]')].map((el) => (el.textContent ?? '').trim());

async function type(text: string): Promise<void> {
  const input = level().querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  toggled.length = 0;
  created.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe('the Tags level', () => {
  it('stays short with 37 tags: the session’s own, five more, All 30 tags…, and seven swatches', async () => {
    await act(async () => root!.render(<Harness selected={['t-0', 'c-2']} />));
    await settle();
    expect(rowNames()).toEqual(['Yellow', 'topic 0', 'topic 3', 'All 30 tags…']);
    const swatches = level().querySelectorAll<HTMLButtonElement>('.session-tags-swatch');
    expect([...swatches].map((s) => s.getAttribute('aria-label'))).toEqual(COLOURS);
    expect(swatches[2].getAttribute('aria-pressed')).toBe('true');
    await act(async () => swatches[0].click());
    expect(toggled).toEqual(['c-0']);
  });

  it('a search lists every match and offers Create only when no tag is the typed name', async () => {
    await act(async () => root!.render(<Harness selected={[]} />));
    await settle();
    await type('topic 2');
    expect(rowNames()).toEqual(['topic 2', 'topic 20', 'topic 21', 'topic 22', 'topic 23', 'topic 24', 'topic 25', 'topic 26', 'topic 27', 'topic 28', 'topic 29']);
    await type('Login');
    expect(rowNames()).toEqual(['Create "Login"']);
    expect(level().querySelector('.session-tags-colours')).toBeNull();
    await act(async () => level().querySelector<HTMLElement>('[role="menuitem"]')!.click());
    await settle();
    expect(created).toEqual(['Login']);
  });
});
