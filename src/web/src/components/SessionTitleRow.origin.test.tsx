// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { SessionTitleRow } from './WorkspaceView';

describe('the session list row’s origin tag', () => {
  const draw = async (session: Record<string, unknown>): Promise<HTMLElement> => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    await act(async () => createRoot(host).render(<SessionTitleRow session={session} />));
    return host;
  };

  it('says From Scheduled on a Scheduled page chat, and nothing on another session', async () => {
    const chat = await draw({ title: 'Scheduled chat', chatOrigin: 'SCHEDULE_CHAT', createdAt: '2025-11-14T04:00:00.000Z' });
    expect(chat.querySelector('.session-origin-tag')?.textContent).toBe('From Scheduled');
    const plain = await draw({ title: 'Fix it', chatOrigin: null, createdAt: '2025-11-14T04:00:00.000Z' });
    expect(plain.querySelector('.session-origin-tag')).toBeNull();
  });
});
