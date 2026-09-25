// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { currentProviderChoice, providerChoices, type PoolChoiceSource } from '../lib/sessionProviderChoices';
import type { ConfiguredProvider } from '../lib/workspaceDefaults';
import { NewSessionProviderHero } from './NewSessionProviderHero';

/**
 * An account pool in the New Session picker: one tile with its vendor's mark and the number of its
 * accounts, and the accounts themselves one step further in, under "Pin a specific account".
 */

const work: ConfiguredProvider = { slug: 'anthropic', label: 'Work', runtime: 'claude', models: [], presetSlug: 'anthropic', modelsFromRuntime: true };
const home: ConfiguredProvider = { ...work, slug: 'anthropic-2', label: 'Home' };
const deepseek: ConfiguredProvider = {
  slug: 'deepseek',
  label: 'DeepSeek',
  runtime: 'claude',
  models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
  defaultModel: 'deepseek-v4-pro',
  presetSlug: 'deepseek',
};
const pool: PoolChoiceSource = {
  id: '019fc086-c7c7-7c92-8215-778ad8a62801',
  slug: 'claude-accounts',
  label: 'Claude accounts',
  members: [{ slug: 'anthropic' }, { slug: 'anthropic-2' }],
};
/** A pool none of whose accounts can run, as GET /providers/pools says it (`unavailable`). */
const deadPool: PoolChoiceSource = {
  id: '019fc086-c7c7-7c92-8215-778ad8a62802',
  slug: 'old-accounts',
  label: 'Old accounts',
  members: [{ slug: 'anthropic-3' }],
  unavailable: 'No account can run',
};
const configured: ConfiguredProvider[] = [
  work,
  home,
  deepseek,
  { slug: pool.slug, label: pool.label, runtime: 'claude', models: [], presetSlug: 'anthropic', modelsFromRuntime: true },
];
const catalog = { claude: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }] } as never;

describe('an account pool in the New Session picker', () => {
  let container: HTMLDivElement;
  let root: Root;
  let picked: string[];

  const mount = async (current: string, pools: PoolChoiceSource[] = [pool]) => {
    const choices = providerChoices(configured, catalog, undefined, undefined, pools);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <NewSessionProviderHero
            current={currentProviderChoice(current, choices, catalog, configured)}
            choices={choices}
            onPick={(slug) => picked.push(slug)}
            runnerId="019fc086-c7c7-7c92-8215-778ad8a6280a"
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  /** The names on the open list's rows, top to bottom. */
  const rows = () =>
    Array.from(document.body.querySelectorAll<HTMLElement>('.np-list .np-row .np-row-name')).map((el) => el.textContent);
  const rowNamed = (name: string) =>
    Array.from(document.body.querySelectorAll<HTMLElement>('.np-list .np-row')).find(
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
    // The popover measures itself; jsdom has nothing to measure with.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('is one tile with the vendor mark and its account count; its accounts wait behind "Pin a specific account"', async () => {
    await mount('claude-accounts');
    const card = container.querySelector<HTMLElement>('.np-card')!;
    expect(card.getAttribute('aria-label')).toBe('Provider: Claude accounts');
    expect(card.querySelector('.np-pool-badge')?.textContent).toBe('2');
    expect(card.querySelector('.np-pool-badge')?.getAttribute('aria-label')).toBe('2 accounts');

    await click(card);
    expect(rows()).toEqual(['Claude', 'Codex', 'Kimi', 'Claude accounts', 'DeepSeek', 'Pin a specific account', 'Connect a provider…']);
    expect(rowNamed('Claude accounts')?.querySelector('.np-pool-badge')?.textContent).toBe('2');
    const pin = rowNamed('Pin a specific account')!;
    expect(pin.getAttribute('aria-expanded')).toBe('false');

    await click(pin);
    expect(pin.getAttribute('aria-expanded')).toBe('true');
    expect(rows()).toEqual([
      'Claude', 'Codex', 'Kimi', 'Claude accounts', 'DeepSeek', 'Pin a specific account', 'Work', 'Home', 'Connect a provider…',
    ]);
    // Pinning one account is a real pick: it dispatches that account's own slug.
    await click(rowNamed('Home'));
    expect(picked).toEqual(['anthropic-2']);
  });

  it('opens the fold from the start when the pick already is one of its accounts', async () => {
    await mount('anthropic');
    await click(container.querySelector('.np-card'));
    expect(rowNamed('Pin a specific account')?.getAttribute('aria-expanded')).toBe('true');
    expect(rowNamed('Work')?.classList.contains('on')).toBe(true);
  });

  it("greys out a pool none of whose accounts can run, says why, and sends the pick to the pool's page instead", async () => {
    await mount('claude-accounts', [pool, deadPool]);
    await click(container.querySelector('.np-card'));

    // A pool that can run stays a pick.
    const live = rowNamed('Claude accounts')!;
    expect(live.tagName).toBe('BUTTON');
    expect(live.classList.contains('np-unavailable')).toBe(false);

    // The one that cannot is listed — its account count and all — but greyed, with the server's reason
    // where its model would be, and a link to the pool's own page where the fix is.
    const dead = rowNamed('Old accounts')!;
    expect(dead.tagName).toBe('A');
    expect(dead.classList.contains('np-unavailable')).toBe(true);
    expect(dead.querySelector('.np-pool-badge')?.textContent).toBe('1');
    expect(dead.querySelector('.np-row-model.np-fix')?.textContent).toBe('No account can run');
    expect(dead.getAttribute('href')).toBe(`/providers/pools/${encodeId(deadPool.id)}`);
    // Nothing about this runner: the problem is the pool's accounts, not the machine.
    expect(dead.getAttribute('title')).toBe('Old accounts: No account can run — fix it on the Providers page');
    await click(dead);
    expect(picked).toEqual([]);
  });

  it('says why under the card when the sticky pick is a pool that can run nothing', async () => {
    await mount('old-accounts', [pool, deadPool]);
    const summary = container.querySelector('.np-summary')!;
    expect(summary.textContent).toBe('Old accounts·No account can run·Fix it');
    expect(summary.querySelector('a')?.getAttribute('href')).toBe(`/providers/pools/${encodeId(deadPool.id)}`);
  });
});
