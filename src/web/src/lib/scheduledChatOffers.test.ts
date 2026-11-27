import { describe, expect, it } from 'vitest';
import { runNowOffers } from './scheduledChatOffers';
import { WIKI_CHAT_NO_ATTACHMENTS, wikiChatAttach } from './wikiChat';
import { scheduledChatContext } from './scheduledChat';

describe('the agent’s Run now offer', () => {
  it('is read from an assistant message’s orbit-run-now link, once per schedule per message', () => {
    const events = [
      { seq: 1, type: 'user', payload: { text: 'orbit-run-now:nope' } },
      { seq: 2, type: 'assistant', ts: 'T', payload: { text: 'Here: [Run now](orbit-run-now:abc123) and again [Run now](orbit-run-now:abc123), or [Run now](orbit-run-now:def456)' } },
      { seq: 3, type: 'assistant', payload: { text: 'No offer here.' } },
    ];
    expect(runNowOffers(events)).toEqual([
      { scheduleId: 'abc123', seq: 2, at: 'T' },
      { scheduleId: 'def456', seq: 2, at: 'T' },
    ]);
  });
});

describe('the schedule chip', () => {
  const chip = { id: 's1', title: 'Codex stable check' };
  it('follows the selection, is crossed out per message, and is on again after a send', () => {
    let state = wikiChatAttach(WIKI_CHAT_NO_ATTACHMENTS, { type: 'schedule', schedule: chip });
    expect(scheduledChatContext(null, state)).toEqual({ context: { scheduleId: 's1' } });
    state = wikiChatAttach(state, { type: 'crossSchedule' });
    expect(scheduledChatContext(null, state)).toBeUndefined();
    state = wikiChatAttach(state, { type: 'sent' });
    expect(scheduledChatContext('w1', state)).toEqual({ context: { scheduleFilter: 'w1', scheduleId: 's1' } });
    state = wikiChatAttach(state, { type: 'schedule', schedule: null });
    expect(scheduledChatContext('w1', state)).toEqual({ context: { scheduleFilter: 'w1' } });
  });
});
