// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentProvider } from '@orbit/shared';
import { NewSessionProviderHero, type NewSessionPlace } from './NewSessionProviderHero';
import { currentEngineChoice, engineChoices, type ChoiceSources } from '../lib/sessionProviderChoices';

/** The place pill's menu (docs/mocks/new-session-place 02, option D): the workspaces, each with its folders one level
 *  down under None, and a search pinned over them that lists both levels' matches. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

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

const pill = () => container!.querySelector<HTMLButtonElement>('.np-place-pill')!;
async function openMenu(): Promise<void> {
  await act(async () => pill().click());
  await settle();
}
const menus = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')];
const rowsOf = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('.orbit-menu-list [role="menuitem"], .orbit-menu-list .orbit-menu-group-label, :scope > [role="menuitem"]')]
  .map((el) => el.textContent);
const row = (menu: HTMLElement, text: string) =>
  [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === text)!;

const place = (over: Partial<NewSessionPlace> = {}): NewSessionPlace => ({
  workspace: { id: 'w2', name: 'orbit-ws01' },
  workspaces: [{ id: 'w1', name: 'Penetration Testing' }, { id: 'w2', name: 'orbit-ws01' }, { id: 'w3', name: 'orbit-develop' }],
  folder: null,
  folders: [
    { id: 'f1', name: 'Orbit Drive', workspaceId: 'w2' },
    { id: 'f2', name: 'Orbit Session', workspaceId: 'w2' },
    { id: 'f3', name: 'Driver tests', workspaceId: 'w3' },
  ],
  onPick: vi.fn(),
  ...over,
});

describe('NewSessionProviderHero place menu', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    document.body.innerHTML = '';
  });

  it('lists the workspaces alone, this one first, with how many folders each opens', async () => {
    await render(place());
    await openMenu();
    const [menu] = menus();
    expect(rowsOf(menu)).toEqual(['orbit-ws012', 'Penetration Testing', 'orbit-develop1']);
    expect(row(menu, 'orbit-ws012').getAttribute('data-selected')).not.toBeNull();
    expect(menu.querySelector('.orbit-menu-header input[placeholder="Find a workspace or folder"]')).not.toBeNull();
    expect(menu.textContent).not.toContain('Orbit Drive');
  });

  it('picks a workspace with no folders from its row', async () => {
    const p = place();
    await render(p);
    await openMenu();
    await act(async () => row(menus()[0], 'Penetration Testing').click());
    await settle();
    expect(p.onPick).toHaveBeenCalledWith('w1', null);
    expect(menus()).toHaveLength(0);
  });

  it('picks a folder of another workspace in one go, from its level', async () => {
    const p = place();
    await render(p);
    await openMenu();
    await act(async () => row(menus()[0], 'orbit-develop1').click());
    await settle();
    const level = menus()[1];
    expect(rowsOf(level)).toEqual(['None', 'Driver tests']);
    await act(async () => row(level, 'Driver tests').click());
    await settle();
    expect(p.onPick).toHaveBeenCalledWith('w3', 'f3');
  });

  it('searches both levels into one list, a folder saying whose it is', async () => {
    const p = place();
    await render(p);
    await openMenu();
    const input = document.querySelector<HTMLInputElement>('.np-place-search input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'dri');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const [menu] = menus();
    expect(rowsOf(menu)).toEqual(['Folders', 'Orbit Drivein orbit-ws01', 'Driver testsin orbit-develop']);
    await act(async () => row(menu, 'Driver testsin orbit-develop').click());
    await settle();
    expect(p.onPick).toHaveBeenCalledWith('w3', 'f3');
  });
});
