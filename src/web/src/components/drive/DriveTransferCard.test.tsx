import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../api';
import { LiveToolOutputsCtx, Transcript } from '../Transcript';

const put = (seq: number, id: string, path: string, name = 'mcp__orbit__drive_put'): RunEvent => ({
  seq,
  type: 'tool_use',
  ts: `2026-11-24T10:00:${String(seq).padStart(2, '0')}Z`,
  payload: { id, name, input: { localPath: `/w/${id}.jpg`, path } },
});
const putDone = (seq: number, id: string, size: number): RunEvent => ({
  seq,
  type: 'tool_result',
  ts: `2026-11-24T10:00:${String(seq).padStart(2, '0')}Z`,
  payload: { toolUseId: id, content: JSON.stringify({ id: `e-${id}`, link: `orbit-drive:e-${id}`, sizeBytes: size }) },
});

function render(events: RunEvent[], outputs: [string, string][] = [], live = true) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <LiveToolOutputsCtx.Provider value={new Map(outputs.map(([id, content]) => [id, { content }]))}>
          <Transcript events={events} live={live} />
        </LiveToolOutputsCtx.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('drive transfer card', () => {
  const calls = [
    put(1, 'toolu_a', '/Shuge/2026-11-24/单幅/万寿宫香.jpg'),
    put(2, 'toolu_b', '/Shuge/2026-11-24/单幅/魁星图.jpg'),
    put(3, 'toolu_c', '/Shuge/2026-11-24/老地图/廣東至暹羅水陸道里圖.jpg'),
  ];

  it('draws a stored transcript of documents_put calls, the name while Drive was called Documents, as the same card', () => {
    const html = render([put(1, 'toolu_x', '/Shuge/a.jpg', 'mcp__orbit__documents_put'), put(2, 'toolu_y', '/Shuge/b.jpg', 'mcp__orbit__documents_put')], [], false);
    expect(html.match(/class="drive-xfer"/g)).toHaveLength(1);
    expect(html).not.toContain('chat-steps-line');
  });

  it('draws a running batch as one card with a bar, the bytes and a row per file', () => {
    const html = render([...calls, putDone(4, 'toolu_a', 2_600_000)], [['toolu_b', 'Uploaded 3200000 of 11400000 bytes']]);

    expect(html.match(/class="drive-xfer"/g)).toHaveLength(1);
    expect(html).toContain('Uploading to Drive');
    expect(html).toContain('/Shuge/2026-11-24/');
    expect(html).toContain('Uploading 2 of 3');
    expect(html).toContain('5.8 MB so far');
    expect(html).toContain('3.2 MB of 11 MB');
    expect(html).toContain('Waiting');
    expect(html).toContain('单幅/');
    expect(html).not.toContain('chat-steps-line');
  });

  it('keeps a finished batch as its card, with the files listed, rather than folding it away', () => {
    const html = render([
      ...calls,
      putDone(4, 'toolu_a', 2_600_000),
      putDone(6, 'toolu_b', 11_400_000),
      putDone(9, 'toolu_c', 12_900_000),
    ]);

    expect(html).toContain('class="drive-xfer"');
    expect(html).toContain('Uploaded 3 files');
    expect(html).toContain('3 uploaded');
    expect(html).toContain('27 MB in 8 s');
    expect(html).toContain('Show in Drive');
    expect(html).toContain('Hide files');
    expect(html).toContain('魁星图.jpg');
    expect(html).not.toContain('class="drive-xfer-fold"');
  });

  it('reads the size and link of a runner that answers with a receipt', () => {
    const receipt = (seq: number, id: string, size: number): RunEvent => ({
      seq,
      type: 'tool_result',
      ts: `2026-11-24T10:00:${String(seq).padStart(2, '0')}Z`,
      payload: {
        toolUseId: id,
        isError: null,
        content: JSON.stringify({
          receiptVersion: 1,
          ok: true,
          outcome: 'written',
          operation: 'drive_put',
          entity: { id: `e-${id}`, path: '/x', link: `orbit-drive:e-${id}`, sizeBytes: size },
        }),
      },
    });
    const html = render([calls[0], calls[1], receipt(3, 'toolu_a', 2_600_000), receipt(4, 'toolu_b', 11_400_000)]);

    expect(html).toContain('14 MB in 3 s');
    expect(html).toContain('2.6 MB');
    expect(html).toContain('Show in Drive');
  });

  it('keeps a batch with a failed file open, with the error on its row', () => {
    const html = render([
      ...calls,
      putDone(4, 'toolu_a', 2_600_000),
      { seq: 5, type: 'tool_result', payload: { toolUseId: 'toolu_b', content: 'Drive quota reached.', isError: true } },
      putDone(6, 'toolu_c', 12_900_000),
    ]);

    expect(html).toContain('Uploaded 2 of 3 files');
    expect(html).toContain('2 uploaded, 1 failed');
    expect(html).toContain('Drive quota reached.');
  });

  it('draws one file as a line, and a call cut off by a stopped session as stopped', () => {
    expect(render([calls[1]], [['toolu_b', 'Uploaded 3200000 of 11400000 bytes']])).toContain('Uploading 魁星图.jpg');
    expect(render([calls[1], putDone(2, 'toolu_b', 11_400_000)])).toContain('Uploaded <button');
    expect(render([calls[1]], [], false)).toContain('Uploading 魁星图.jpg stopped');
  });
});

describe('drive transfer pace', () => {
  it('shows the speed and time left as bytes arrive, then says when nothing has moved for 20 s', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { JSDOM } = await import('jsdom');
    const { vi } = await import('vitest');
    const { DriveTransferCard } = await import('./DriveTransferCard');
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ now: Date.parse('2026-11-24T10:00:00Z') });
    const root = createRoot(dom.window.document.getElementById('root')!);
    const file = (id: string, sent: number) => ({ id, path: `/S/${id}.jpg`, status: 'running' as const, sent, size: 100_000_000 });
    const draw = (sent: number) =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <DriveTransferCard
              kind="put"
              live
              files={[{ id: 'a', path: '/S/a.jpg', status: 'done', sent: 1_000_000, size: 1_000_000 }, file('b', sent)]}
            />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    try {
      await act(async () => draw(0));
      for (let s = 1; s <= 3; s++) {
        await act(async () => vi.advanceTimersByTime(1000));
        await act(async () => draw(s * 5_000_000));
      }
      const text = () => dom.window.document.body.textContent ?? '';
      expect(text()).toContain('5 MB/s');
      expect(text()).toContain('under a minute left');
      await act(async () => vi.advanceTimersByTime(21_000));
      expect(text()).toContain('No progress for 21 s');
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
