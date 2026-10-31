// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DirProbe } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The directory probe relay as a client uses it (docs/first-workspace-contract.md §2): ask, then read
 * until the runner answers. One question per machine, and a client gives up after its own timeout.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  askDirProbe: vi.fn(),
  readDirProbe: vi.fn(),
}));
const { askDirProbe, readDirProbe } = await import('../api');
const { DIR_PROBE_POLL_MS, DIR_PROBE_WAIT_MS, useDirProbe } = await import('./useDirProbe');

const RUNNER = 'runner-1';
const PATH = '/home/orbit/code/app';
const FOUND: DirProbe = {
  path: PATH,
  exists: true,
  isDir: true,
  isGit: true,
  branch: 'main',
  isHome: false,
  freeBytes: 1024,
};

let seen: ReturnType<typeof useDirProbe>;
function Probe({ path, ask }: { path?: string; ask: boolean }) {
  seen = useDirProbe(RUNNER, path, ask);
  return null;
}

let root: Root | null = null;
let client: QueryClient;

async function advance(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    // React Query hands a result over through a few short timers of its own.
    for (let turn = 0; turn < 4; turn += 1) await vi.advanceTimersByTimeAsync(1);
  });
}

async function mount(path: string | undefined, ask = true): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <Probe path={path} ask={ask} />
      </QueryClientProvider>,
    );
  });
  await advance();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.mocked(askDirProbe).mockReset();
  vi.mocked(readDirProbe).mockReset();
  vi.mocked(askDirProbe).mockResolvedValue({ path: PATH, status: 'pending' });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  client.clear();
  vi.useRealTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('useDirProbe', () => {
  it('with no path, asks nothing', async () => {
    await mount(undefined);
    expect(seen.state).toBe('idle');
    expect(askDirProbe).not.toHaveBeenCalled();
    expect(readDirProbe).not.toHaveBeenCalled();
  });

  it('asks first, then reads what the runner sends back with a later heartbeat', async () => {
    vi.mocked(readDirProbe)
      .mockResolvedValueOnce({ path: PATH, status: 'pending', result: null })
      .mockResolvedValueOnce({ path: PATH, status: 'done', result: FOUND });
    await mount(PATH);

    expect(askDirProbe).toHaveBeenCalledTimes(1);
    expect(askDirProbe).toHaveBeenCalledWith(RUNNER, PATH);
    expect(seen.state).toBe('checking');

    await advance(DIR_PROBE_POLL_MS);
    expect(readDirProbe).toHaveBeenCalledTimes(2);
    expect(seen).toMatchObject({ state: 'answered', probe: FOUND });
  });

  it('a machine that isn’t asked (offline) gives only what is stored, and is not asked', async () => {
    vi.mocked(readDirProbe).mockResolvedValue({ path: PATH, status: 'done', result: FOUND });
    await mount(PATH, false);
    expect(askDirProbe).not.toHaveBeenCalled();
    expect(seen).toMatchObject({ state: 'answered', probe: FOUND });
  });

  it('nothing stored for it reads as nothing yet, not as an answer', async () => {
    vi.mocked(readDirProbe).mockResolvedValue({ path: PATH, status: 'idle', result: null });
    await mount(PATH, false);
    expect(seen.state).toBe('idle');
  });

  it('another question took the slot: this one stops waiting, and says nothing about the path', async () => {
    vi.mocked(readDirProbe)
      .mockResolvedValueOnce({ path: PATH, status: 'pending', result: null })
      .mockResolvedValueOnce({ path: PATH, status: 'idle', result: null });
    await mount(PATH);
    await advance(DIR_PROBE_POLL_MS);
    expect(seen.state).toBe('idle');
    await advance(DIR_PROBE_POLL_MS * 3);
    expect(readDirProbe).toHaveBeenCalledTimes(2);
  });

  it('a runner that never answers is given up on after its own timeout, and can be asked again', async () => {
    vi.mocked(readDirProbe).mockResolvedValue({ path: PATH, status: 'pending', result: null });
    await mount(PATH);
    await advance(DIR_PROBE_WAIT_MS - DIR_PROBE_POLL_MS);
    expect(seen.state).toBe('checking');
    await advance(DIR_PROBE_POLL_MS * 2);
    expect(seen.state).toBe('unanswered');

    vi.mocked(readDirProbe).mockResolvedValue({ path: PATH, status: 'done', result: FOUND });
    await act(async () => seen.again());
    await advance();
    expect(askDirProbe).toHaveBeenCalledTimes(2);
    expect(seen).toMatchObject({ state: 'answered', probe: FOUND });
  });

  it('a refused question (the machine went offline a moment ago) is no answer either', async () => {
    vi.mocked(askDirProbe).mockRejectedValue(new Error('Runner is offline — it can only look while connected'));
    await mount(PATH);
    expect(seen.state).toBe('unanswered');
    expect(readDirProbe).not.toHaveBeenCalled();
  });
});
