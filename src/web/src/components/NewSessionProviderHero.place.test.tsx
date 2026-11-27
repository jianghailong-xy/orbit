// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentProvider } from '@orbit/shared';
import { NewSessionProviderHero, type NewSessionPlace } from './NewSessionProviderHero';
import { currentEngineChoice, engineChoices, type ChoiceSources } from '../lib/sessionProviderChoices';

/** The place pill's one menu (docs/mocks/new-session-place ③): workspaces, then this workspace's folders. */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const sources: ChoiceSources = { configured: [], modelCatalog: { claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }] } as never };

async function render(place: NewSessionPlace): Promise<void> {
  const engines = engineChoices(sources, [{ engine: AgentProvider.CLAUDE, provider: 'claude' }]);
  await act(async () => root!.render(
    <MemoryRouter>
      <NewSessionProviderHero
        current={currentEngineChoice(AgentProvider.CLAUDE, 'claude', engines, sources)}
        engines={engines}
        onPick={() => {}}
        runnerId="r1"
        place={place}
      />
    </MemoryRouter>,
  ));
  await settle();
}

async function openMenu(): Promise<void> {
  await act(async () => container!.querySelector<HTMLButtonElement>('.np-place-pill')!.click());
  await settle();
}

const rows = () => [...document.querySelectorAll('.np-place-list .np-row, .np-place-list .np-place-head')]
  .map((el) => el.textContent);

const place = (over: Partial<NewSessionPlace> = {}): NewSessionPlace => ({
  workspace: { id: 'w1', name: 'tea-cli @ SG' },
  workspaces: [{ id: 'w1', name: 'tea-cli @ SG' }, { id: 'w2', name: 'orbit-ws01' }],
  onPickWorkspace: vi.fn(),
  folder: null,
  folders: [{ id: 'f1', name: 'Releases' }, { id: 'f2', name: 'Orbit Session' }],
  onPickFolder: vi.fn(),
  ...over,
});

describe('NewSessionProviderHero place menu', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    document.body.innerHTML = '';
  });

  it('lists the workspaces, then this workspace’s folders under None', async () => {
    await render(place());
    await openMenu();
    expect(rows()).toEqual([
      'Workspace', 'tea-cli @ SG', 'orbit-ws01',
      'Folder in tea-cli @ SG · optional', 'None', 'Releases', 'Orbit Session',
    ]);
    expect(document.querySelector('.np-place-list .np-row.on.np-place-none')?.textContent).toBe('None');
    expect(document.querySelector('.np-place-search')).toBeNull();
  });

  it('lists the workspaces alone when this workspace has no folders', async () => {
    await render(place({ folders: [] }));
    await openMenu();
    expect(rows()).toEqual(['Workspace', 'tea-cli @ SG', 'orbit-ws01']);
  });

  it('picks a folder or another workspace, and closes', async () => {
    const p = place();
    await render(p);
    await openMenu();
    const row = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('.np-place-list .np-row')]
      .find((el) => el.textContent === name)!;
    await act(async () => row('Releases').click());
    await settle();
    expect(p.onPickFolder).toHaveBeenCalledWith('f1');
    expect(container!.querySelector('.np-place-pill')?.getAttribute('aria-expanded')).toBe('false');

    await openMenu();
    await act(async () => row('orbit-ws01').click());
    await settle();
    expect(p.onPickWorkspace).toHaveBeenCalledWith('w2');
    expect(container!.querySelector('.np-place-pill')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('offers a search over both sections once the menu is long', async () => {
    const workspaces = Array.from({ length: 6 }, (_, i) => ({ id: `w${i + 1}`, name: `ws-${i + 1}` }));
    await render(place({ workspace: workspaces[0], workspaces }));
    await openMenu();
    const search = document.querySelector<HTMLInputElement>('.np-place-search')!;
    expect(search).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'rel');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows()).toEqual(['Folder in ws-1 · optional', 'Releases']);
  });
});
