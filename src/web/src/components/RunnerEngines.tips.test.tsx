// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { hoverTooltip } from '../test/tooltipHover';
import { EngineRows } from './RunnerEngines.test-rows';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));

describe('an engine row’s update note, on hover', () => {
  it('keeps the reason reachable when the line is too short to hold it', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }));
    const message = "Installed at /usr/lib/node_modules/kimi/bin/kimi, which this runner can't replace — it runs as husong.";
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['runners'], [{
      id: '33zx0JhRhJo8rd25d3qAM',
      name: 'mac-studio',
      online: true,
      engines: [{
        engine: 'kimi', installed: true, auth: 'yes', version: '0.32.0',
        update: { status: 'skipped', at: new Date(Date.now() - 4 * 3600_000).toISOString(), message },
      }],
    }]);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <MemoryRouter><QueryClientProvider client={qc}><EngineRows /></QueryClientProvider></MemoryRouter>,
    ));
    expect(await hoverTooltip(container.querySelector('.re-upd')!)).toBe(message);
    await act(async () => root.unmount());
    container.remove();
    qc.clear();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });
});
