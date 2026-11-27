import { describe, expect, it } from 'vitest';
import {
  SCHEDULED_CHAT_RANGE,
  SCHEDULED_CHAT_WIDTH,
  scheduledChatDefaultWorkspace,
  scheduledChatHostList,
  scheduledChatToOpen,
} from './scheduledChat';
import { wikiChatPanelWidth } from './wikiChat';

const ws = (id: string, position: number | null, runnerId: string | null = 'r') => ({
  id, name: id, position, runnerId, createdAt: '2025-01-01T00:00:00.000Z',
});

describe('Runs in’s default (design §5)', () => {
  const rows = [ws('older', 2), ws('first', 0), ws('no-machine', null, null)];

  it('is the page’s workspace filter when one is set', () => {
    expect(scheduledChatDefaultWorkspace('older', rows)?.id).toBe('older');
  });

  it('else the account’s default: first in the sidebar’s order with a machine', () => {
    expect(scheduledChatDefaultWorkspace(null, rows)?.id).toBe('first');
    expect(scheduledChatDefaultWorkspace('gone', rows)?.id, 'a filter naming no workspace of the account').toBe('first');
  });

  it('is none when no workspace has a machine', () => {
    expect(scheduledChatDefaultWorkspace(null, [ws('a', 0, null)])).toBeNull();
  });
});

describe('which chat the button opens (design §3)', () => {
  const at = (iso: string) => ({ createdAt: iso, lastTurnAt: iso });
  const list = scheduledChatHostList(
    [
      { id: 'plain', chatOrigin: null, ...at('2025-01-05T00:00:00Z') },
      { id: 'new', chatOrigin: 'SCHEDULE_CHAT', ...at('2025-01-04T00:00:00Z') },
      { id: 'asks', chatOrigin: 'SCHEDULE_CHAT', waitingOn: 'PERSON', ...at('2025-01-01T00:00:00Z') },
      { id: 'done', chatOrigin: 'SCHEDULE_CHAT', lifecycleState: 'COMPLETED', ...at('2025-01-06T00:00:00Z') },
    ],
    null,
  );

  it('lists the open Scheduled chats only, newest first', () => {
    expect(list.chats.map((row) => row.sessionId)).toEqual(['new', 'asks']);
    expect(list.fab.needsYou).toBe(1);
  });

  it('opens the one with a card waiting, else the account’s open one, else the newest, else a new chat', () => {
    expect(scheduledChatToOpen(list.chats, 'new')).toBe('asks');
    const quiet = list.chats.filter((row) => row.needsYou === 0);
    expect(scheduledChatToOpen(quiet, 'other')).toBe('other');
    expect(scheduledChatToOpen(quiet, null)).toBe('new');
    expect(scheduledChatToOpen([], null)).toBe('new');
  });
});

describe('the panel’s width (design §6)', () => {
  it('is 400 until dragged, and dragged between 400 and 480 only where it is wide', () => {
    const width = (layout: Parameters<typeof wikiChatPanelWidth>[0], dragged: number | null) =>
      wikiChatPanelWidth(layout, dragged, 1600, SCHEDULED_CHAT_WIDTH, SCHEDULED_CHAT_RANGE);
    expect(width('wide', null)).toBe(400);
    expect(width('wide', 450)).toBe(450);
    expect(width('wide', 700)).toBe(480);
    expect(width('wide', 320)).toBe(400);
    expect(width('docked', 470)).toBe(400);
    expect(width('over', 470)).toBe(400);
    expect(width('sheet', 470)).toBeNull();
  });
});
