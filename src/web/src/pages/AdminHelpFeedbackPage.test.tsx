// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelpFeedbackSummary } from '@orbit/shared';

/**
 * Admin → Help feedback (docs/mocks/help-center board 03, decision 3): GET /admin/help-feedback drawn as the Ask
 * answers' Yes / No totals and a table of articles, most No first, each linking to its article. Counts only: the page
 * has nothing of what anyone asked or wrote.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../api');
const { AdminHelpFeedbackPage } = await import('./AdminHelpFeedbackPage');

let summary: HelpFeedbackSummary;
let asked: string[];
let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function open(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/admin/help-feedback']}>
        <QueryClientProvider client={client}>
          <AdminHelpFeedbackPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  asked = [];
  summary = {
    articles: [
      { slug: 'machine-offline', title: 'A machine shows Offline', category: 'machines-and-engines', yes: 4, no: 7 },
      { slug: 'api-keys', title: 'API keys', category: 'models-keys-and-accounts', yes: 9, no: 2 },
      { slug: 'old-article', title: null, category: null, yes: 1, no: 0 },
    ],
    answers: { yes: 12, no: 5 },
  };
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    asked.push(path);
    if (path !== '/admin/help-feedback') throw new Error(`the stand-in server has no GET ${path}`);
    return summary;
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
});

describe('Admin → Help feedback', () => {
  it('shows the Ask answers\' totals and the articles by No count, each linking to its article', async () => {
    await open();
    expect(asked).toEqual(['/admin/help-feedback']);
    expect(container!.textContent).toContain('Help feedback');
    expect(container!.textContent).toContain('Did this answer it?');
    expect(container!.textContent).toContain('12 Yes · 5 No');
    const rows = [...container!.querySelectorAll('table[aria-label="Articles"] tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ['A machine shows Offline', 'Machines & engines', '4', '7'],
      ['API keys', 'Models, keys & accounts', '9', '2'],
      ['old-article (removed)', '', '1', '0'],
    ]);
    expect(container!.querySelector('tbody a')?.getAttribute('href')).toBe('/help/machines-and-engines/machine-offline');
  });

  it('says so when no one has answered yet', async () => {
    summary = { articles: [], answers: { yes: 0, no: 0 } };
    await open();
    expect(container!.querySelector('tbody')!.textContent).toBe('No one has answered Did this help? yet.');
    expect(container!.textContent).toContain('0 Yes · 0 No');
  });

  it('says what went wrong when the counts cannot be read', async () => {
    vi.mocked(api).mockRejectedValue(new Error('admin only'));
    await open();
    expect(container!.querySelector('[role="alert"]')!.textContent).toBe('Couldn’t load help feedback: admin only');
  });
});
