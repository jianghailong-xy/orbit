// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSnoozesForTest, type OwnerRequest } from '../lib/ownerRequests';
import { OwnerRequestCard, OwnerRequestResolved } from './OwnerRequestCard';

/**
 * The SETTINGS_CHANGE card (docs/settings-from-conversation-design.md §8.1, board 1 frame ②): its body — heading, the
 * Settings page, one row per key with the value now struck through and the new one as Settings shows it, the tier-2
 * note, the agent's reason, the foot — and its two buttons with no Always allow; then its three folds: saved (with
 * Undo restoring each `from`), declined through Chat about this, and stale on 409 SETTINGS_STALE. The api mock keeps
 * every write, which is the claim.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const NOW = Date.parse('2026-11-20T09:00:00.000Z');
const REQUEST_ID = '35aaSettingsReq01';

const CHANGES = [
  { key: 'translationEnabled', from: false, to: true, tier: 1 },
  { key: 'translationLanguage', from: 'en', to: 'zh-Hans', tier: 1 },
];

function settingsRequest(over: Partial<OwnerRequest> = {}): OwnerRequest {
  return {
    id: REQUEST_ID,
    kind: 'SETTINGS_CHANGE',
    state: 'PENDING',
    title: 'Change 2 settings?',
    why: 'you asked to read replies in Chinese.',
    blocksTaskIds: [],
    ifUnanswered: null,
    options: null,
    recommendedOption: null,
    steps: null,
    secretSpec: null,
    secretGrant: null,
    verifyHint: null,
    payload: { changes: CHANGES },
    expiresAt: null,
    askedBySessionId: '34uOqHiF7f3VmoARfQg6y',
    projectId: null,
    resolvedAt: null,
    resolvedByUserId: null,
    resolvedBySessionId: null,
    resolutionNote: null,
    answer: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

let root: Root | null = null;
let host: HTMLElement;
let writes: Array<{ path: string; method: string; body: unknown }> = [];
let me: Record<string, unknown>;
let applyAnswer: 'ok' | 'stale';

async function mount(node: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
  });
  await flush();
}

/** What a reader sees, each piece of text apart: the card sets its pieces side by side with gaps, not spaces. */
const words = (node: Element | null | undefined): string => {
  if (!node) return '';
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) parts.push(text.textContent ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};
const buttons = (): string[] => [...host.querySelectorAll('button')].map(words);
const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => words(b) === name || words(b).startsWith(`${name} `));
  if (!found) throw new Error(`no button named ${name}: ${host.textContent}`);
  return found;
};
async function press(target: HTMLElement) {
  await act(async () => { target.click(); });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  resetSnoozesForTest();
  writes = [];
  applyAnswer = 'ok';
  me = {
    id: 'me',
    preferences: { translationEnabled: true, translationLanguage: 'zh-Hans' },
    changedBy: {
      translationEnabled: { sessionId: 's1', requestId: REQUEST_ID, at: new Date(NOW).toISOString(), from: false, sessionTitle: 'Show replies in Chinese' },
      translationLanguage: { sessionId: 's1', requestId: REQUEST_ID, at: new Date(NOW).toISOString(), from: 'en', sessionTitle: 'Show replies in Chinese' },
    },
  };
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ path, method, body: init?.body });
    if (path.endsWith('/apply-settings')) {
      if (applyAnswer === 'stale') {
        throw Object.assign(new Error('This setting changed since it was proposed; nothing was written.'), { status: 409, code: 'SETTINGS_STALE' });
      }
      return settingsRequest({ state: 'DONE', resolvedAt: new Date(NOW).toISOString(), resolvedByUserId: 'me' });
    }
    if (path.endsWith('/decline')) {
      return settingsRequest({ state: 'DECLINED', resolutionNote: (init?.body as { reason: string }).reason });
    }
    if (path === '/users/me/preferences') {
      me = { ...me, preferences: { ...(me.preferences as object), ...(init?.body as object) }, changedBy: {} };
      return me;
    }
    if (path === '/users/me') return me;
    return { requests: [] };
  });
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
  }
  document.body.innerHTML = '';
});

describe('the SETTINGS_CHANGE card', () => {
  it('draws the confirmation card: heading, page, struck from → to per key, the reason in grey and the foot', async () => {
    await mount(<OwnerRequestCard request={settingsRequest()} now={NOW} />);
    const card = host.querySelector('.approval-card.settings-change-card')!;
    expect(card).toBeTruthy();
    expect(words(card.querySelector('.approval-head'))).toBe('⚙️ Confirm: change 2 settings?');
    expect([...card.querySelectorAll('.settings-change-path')].map(words)).toEqual(['Settings › General › Translation']);
    const rows = [...card.querySelectorAll('.settings-change-row')].map((row) => ({
      title: words(row.querySelector('.settings-change-title')),
      struck: words(row.querySelector('s.settings-change-from')),
      to: words(row.querySelector('.settings-change-to')),
      text: words(row),
    }));
    expect(rows).toEqual([
      { title: 'Translate conversations', struck: 'Off', to: 'On', text: 'Translate conversations Off → On' },
      { title: 'Your language', struck: 'English', to: 'Chinese (Simplified)', text: 'Your language English → Chinese (Simplified)' },
    ]);
    // Tier 1 rows carry no new-sessions note.
    expect(card.querySelector('.settings-change-note')).toBeNull();
    expect(words(card.querySelector('.settings-change-why'))).toBe('The agent says: you asked to read replies in Chinese.');
    expect(words(card.querySelector('.settings-change-foot'))).toBe('Only these change. You can change them back in Settings.');
  });

  it('offers Save changes (Enter) and 💬 Chat about this, and never Always allow', async () => {
    await mount(<OwnerRequestCard request={settingsRequest()} now={NOW} />);
    expect(buttons()).toEqual(['Save changes Enter', '💬 Chat about this']);
    expect(host.textContent).not.toMatch(/Always allow/);
  });

  it('says "Applies to new sessions only." under a tier-2 row only, and names each page a row is on', async () => {
    const request = settingsRequest({
      title: 'Change 2 settings?',
      payload: {
        changes: [
          { key: 'modelRouting', from: true, to: false, tier: 2 },
          { key: 'theme', from: 'system', to: 'dark', tier: 1 },
        ],
      },
    });
    await mount(<OwnerRequestCard request={request} now={NOW} />);
    const rows = [...host.querySelectorAll('.settings-change-row')];
    expect(words(rows[0])).toBe('Route by tier On → Off Applies to new sessions only.');
    expect(words(rows[1])).toBe('Theme System → Dark');
    expect([...host.querySelectorAll('.settings-change-path')].map(words)).toEqual([
      'Settings › Model routing',
      'Settings › Appearance',
    ]);
  });

  it('Save changes posts apply-settings and folds to "✓ Changed 2 settings · Undo"; Undo restores each from', async () => {
    await mount(<OwnerRequestCard request={settingsRequest()} now={NOW} />);
    await press(button('Save changes'));
    expect(writes).toEqual([{ path: `/owner-requests/${REQUEST_ID}/apply-settings`, method: 'POST', body: undefined }]);
    const folded = host.querySelector('.settings-change-folded.is-done')!;
    expect(words(folded)).toBe('✓ Changed 2 settings · Undo');
    expect(host.querySelector('.approval-card')).toBeNull();

    await press(button('Undo'));
    expect(writes.at(-1)).toEqual({
      path: '/users/me/preferences',
      method: 'PATCH',
      body: { translationEnabled: false, translationLanguage: 'en' },
    });
    expect(words(host.querySelector('.settings-change-folded'))).toBe('✓ Changed 2 settings · Undone');
  });

  it('Enter saves the card', async () => {
    await mount(<OwnerRequestCard request={settingsRequest()} now={NOW} />);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(writes.map((w) => w.path)).toEqual([`/owner-requests/${REQUEST_ID}/apply-settings`]);
  });

  it('💬 Chat about this declines with the reason typed, and the card folds to "Declined"', async () => {
    await mount(<OwnerRequestCard request={settingsRequest()} now={NOW} />);
    await press(button('💬 Chat about this'));
    const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reason for declining"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(box, 'Only the replies, not my messages.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(button('Decline'));
    expect(writes).toEqual([{
      path: `/owner-requests/${REQUEST_ID}/decline`,
      method: 'POST',
      body: { reason: 'Only the replies, not my messages.' },
    }]);
    expect(words(host.querySelector('.settings-change-folded.is-declined'))).toBe('Declined');
  });

  it('a 409 SETTINGS_STALE folds the card to "This setting changed since it was proposed."', async () => {
    applyAnswer = 'stale';
    await mount(<OwnerRequestCard request={settingsRequest()} now={NOW} />);
    await press(button('Save changes'));
    const folded = host.querySelector('.settings-change-folded.is-stale')!;
    expect(words(folded)).toBe('This setting changed since it was proposed. · Decline');
    expect(host.querySelector('.approval-card')).toBeNull();
    // Still pending on the server: the owner can decline it, so the agent hears why.
    await press(button('Decline'));
    expect(writes.at(-1)).toEqual({
      path: `/owner-requests/${REQUEST_ID}/decline`,
      method: 'POST',
      body: { reason: 'This setting changed since it was proposed.' },
    });
  });

  it('an answered card read back from the server is drawn folded, here and in the inbox summary', async () => {
    await mount(
      <>
        <OwnerRequestCard request={settingsRequest({ state: 'DONE' })} now={NOW} />
        <OwnerRequestResolved request={settingsRequest({ id: 'other', state: 'DECLINED' })} now={NOW} />
      </>,
    );
    expect([...host.querySelectorAll('.settings-change-folded')].map(words)).toEqual([
      '✓ Changed 2 settings · Undo',
      'Declined',
    ]);
  });

  it('a saved card offers no Undo once the owner has changed those settings again', async () => {
    me = { ...me, changedBy: {} };
    await mount(<OwnerRequestCard request={settingsRequest({ state: 'DONE' })} now={NOW} />);
    expect(words(host.querySelector('.settings-change-folded'))).toBe('✓ Changed 2 settings');
  });
});
