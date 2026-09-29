// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { currentProviderChoice, type ProviderChoice } from '../lib/sessionProviderChoices';
import { NewSessionProviderHero } from './NewSessionProviderHero';

/**
 * The runner's Codex accounts in the New Session picker: rows right under Codex, the one the session
 * would start on ticked, each picking Codex on that account — and one the CLI says is signed out
 * sending the pick to the Providers page, where its sign-in is.
 */

const RUNNER_ID = '019fc086-c7c7-7c92-8215-778ad8a6280a';
const brand = { mono: 'C', from: '#000', to: '#111' };
const choices: ProviderChoice[] = [
  { slug: 'claude', label: 'Claude', kind: 'engine', brand, modelLabel: 'Opus 5.5' },
  {
    slug: 'codex',
    label: 'Codex',
    kind: 'engine',
    brand,
    modelLabel: 'GPT-5.5',
    accounts: [
      { id: 'default', label: 'Default', quota: '5h 100%', nearLimit: true },
      { id: '3fa91c2e', label: 'Work', quota: 'Weekly 0%' },
      { id: 'c0ffee42', label: 'Old', unavailable: 'Not signed in' },
    ],
  },
];

describe('Codex accounts in the New Session picker', () => {
  let container: HTMLDivElement;
  let root: Root;
  let picked: Array<[string, (string | null)?]>;

  const mount = async (current: string, currentAccount?: string, automatic?: boolean) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <NewSessionProviderHero
            current={currentProviderChoice(current, choices)}
            choices={choices}
            onPick={(slug) => picked.push([slug])}
            currentAccount={currentAccount}
            automatic={automatic}
            onPickAccount={(slug, account) => picked.push([slug, account])}
            runnerId={RUNNER_ID}
          />
        </MemoryRouter>,
      );
    });
  };
  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('nothing to click');
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  };
  const accountNamed = (name: string) =>
    Array.from(document.body.querySelectorAll<HTMLElement>('.np-account')).find(
      (el) => el.querySelector('.np-row-name')?.textContent === name,
    );

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    picked = [];
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('lists them right under Codex, ticks the one the session would start on, and names it', async () => {
    await mount('codex', '3fa91c2e');
    expect(container.querySelector('.np-summary')?.textContent).toBe('Codex·GPT-5.5·Work·Manage');

    await click(container.querySelector('.np-card'));
    const names = Array.from(document.body.querySelectorAll('.np-list .np-row-name')).map((el) => el.textContent);
    expect(names.slice(0, 5)).toEqual(['Claude', 'Codex', 'Default', 'Work', 'Old']);
    expect(accountNamed('Work')?.classList.contains('picked')).toBe(true);
    expect(accountNamed('Work')?.getAttribute('aria-pressed')).toBe('true');
    expect(accountNamed('Default')?.classList.contains('picked')).toBe(false);
    // A spent window reads as one before anything is picked.
    expect(accountNamed('Default')?.querySelector('.np-row-model')?.className).toContain('near-limit');

    await click(accountNamed('Default'));
    expect(picked).toEqual([['codex', 'default']]);
  });

  it('picks Codex on an account from another provider, and ticks nothing while Codex is not the pick', async () => {
    await mount('claude', 'default');
    // Not Codex, so no account of it is named under the card.
    expect(container.querySelector('.np-summary')?.textContent).toBe('Claude·Opus 5.5·Manage');
    await click(container.querySelector('.np-card'));
    expect(document.body.querySelector('.np-account.picked')).toBeNull();
    await click(accountNamed('Work'));
    expect(picked).toEqual([['codex', '3fa91c2e']]);
  });

  it('offers Automatic above the accounts when it is on offer, ticked — not the account — while it is the pick', async () => {
    await mount('codex', '3fa91c2e', true);
    // The account Automatic would start it on is named, and marked as its choice.
    expect(container.querySelector('.np-summary')?.textContent).toBe('Codex·GPT-5.5·Work (auto)·Manage');
    await click(container.querySelector('.np-card'));
    const names = Array.from(document.body.querySelectorAll('.np-list .np-row-name')).map((el) => el.textContent);
    expect(names.slice(0, 6)).toEqual(['Claude', 'Codex', 'Automatic', 'Default', 'Work', 'Old']);
    expect(accountNamed('Automatic')?.classList.contains('picked')).toBe(true);
    expect(accountNamed('Work')?.classList.contains('picked')).toBe(false);
    await click(accountNamed('Default'));
    expect(picked).toEqual([['codex', 'default']]);
  });

  it('hands back no account when Automatic is picked over an account', async () => {
    await mount('codex', 'default', false);
    await click(container.querySelector('.np-card'));
    expect(accountNamed('Default')?.classList.contains('picked')).toBe(true);
    await click(accountNamed('Automatic'));
    expect(picked).toEqual([['codex', null]]);
  });

  it('sends a signed-out account to its sign-in on the Providers page instead of picking it', async () => {
    await mount('codex', 'default');
    await click(container.querySelector('.np-card'));
    const old = accountNamed('Old')!;
    expect(old.tagName).toBe('A');
    expect(old.getAttribute('href')).toBe(`/providers?runner=${encodeId(RUNNER_ID)}&engine=codex`);
    expect(old.querySelector('.np-row-model')?.textContent).toBe('Not signed in');
    await click(old);
    expect(picked).toEqual([]);
  });
});
