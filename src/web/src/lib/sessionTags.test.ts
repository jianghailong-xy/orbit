import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({ api: apiMock }));

import { setSessionTags } from './sessionTags';

describe('session tags API client', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('replaces a session tag selection with PUT', async () => {
    const tags = [
      { id: 'blue', name: 'Blue', color: '#007AFF', isSystem: true, position: 4 },
    ];
    apiMock.mockResolvedValue(tags);

    await expect(setSessionTags('session-1', ['blue'])).resolves.toEqual(tags);

    expect(apiMock).toHaveBeenCalledWith('/sessions/session-1/tags', {
      method: 'PUT',
      body: { tagIds: ['blue'] },
    });
  });

  it('sends an empty selection to clear all tags', async () => {
    apiMock.mockResolvedValue([]);

    await setSessionTags('session-1', []);

    expect(apiMock).toHaveBeenCalledWith('/sessions/session-1/tags', {
      method: 'PUT',
      body: { tagIds: [] },
    });
  });
});
