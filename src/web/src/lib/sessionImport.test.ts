import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, getSessionEventPage, importClaudeSession } from '../api';
import { importClaudeSessionAndWait } from './sessionImport';

const IMPORT_UUID = '4e453ab7-f37c-494d-8017-bb4e9beffeef';

const importClaudeSessionMock = vi.mocked(importClaudeSession);
const getSessionEventPageMock = vi.mocked(getSessionEventPage);
const getSessionMock = vi.mocked(getSession);

vi.mock('../api', () => ({
  getSession: vi.fn(),
  getSessionEventPage: vi.fn(),
  importClaudeSession: vi.fn(),
}));

describe('importClaudeSessionAndWait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    importClaudeSessionMock.mockResolvedValue({ id: 'imported-1', status: 'PENDING' });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts the import and resolves once the replay lands as events', async () => {
    getSessionMock.mockResolvedValue({ id: 'imported-1', status: 'PENDING' } as never);
    getSessionEventPageMock
      .mockResolvedValueOnce({ events: [], hasMore: false })
      .mockResolvedValueOnce({ events: [{ seq: 1, type: 'user', payload: {}, turnId: null, ts: '2026-09-15T10:00:00Z' }], hasMore: false });
    const done = importClaudeSessionAndWait(IMPORT_UUID, 'ws-1');
    await vi.advanceTimersByTimeAsync(3000);
    await expect(done).resolves.toBe('imported-1');
    expect(importClaudeSessionMock).toHaveBeenCalledWith({ claudeSessionId: IMPORT_UUID, workspaceId: 'ws-1' });
    expect(getSessionEventPageMock).toHaveBeenCalledWith('imported-1', { tail: 1 });
  });

  it('reports the session failure the runner settled the import with', async () => {
    getSessionMock.mockResolvedValue({
      id: 'imported-1',
      status: 'FAILED',
      error: 'the transcript was recorded in /elsewhere, outside the workspace /ws/proj',
    } as never);
    getSessionEventPageMock.mockResolvedValue({ events: [], hasMore: false });
    const done = importClaudeSessionAndWait(IMPORT_UUID, 'ws-1');
    // Attach the verdict before the timer fires the rejection, so it is never unhandled.
    const verdict = expect(done).rejects.toThrow('outside the workspace /ws/proj');
    await vi.advanceTimersByTimeAsync(3000);
    await verdict;
  });

  it('gives up after the CLI-shaped timeout, naming the session to check', async () => {
    getSessionMock.mockResolvedValue({ id: 'imported-1', status: 'PENDING' } as never);
    getSessionEventPageMock.mockResolvedValue({ events: [], hasMore: false });
    const done = importClaudeSessionAndWait(IMPORT_UUID, 'ws-1');
    const verdict = expect(done).rejects.toThrow('timed out waiting for the import to finish');
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    await verdict;
  });
});
