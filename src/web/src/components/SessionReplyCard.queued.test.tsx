import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { SessionReplyCard as Card } from '@orbit/shared';
import { SessionReplyCards } from './SessionReplyCard';
import { QueuedTurnMeta, queuedTurnFromActiveSnapshot } from './WorkspaceView';

const CARD: Card = {
  requestId: 'req1',
  outcome: 'REPLIED',
  fromSessionId: '00000000-0000-4000-8000-000000000001',
  fromTitle: '分析 session 列表页性能',
  requestTurnId: null,
  requestPreview: '再跑一组只读探针',
  replyText: '全部只读执行',
};

describe('a reply turn waiting on the queue', () => {
  it('keeps the reply cards the snapshot carried, and draws them rather than the delivered blocks', () => {
    const queued = queuedTurnFromActiveSnapshot({
      turnId: 'reply-turn',
      kind: 'message',
      placement: 'queued',
      content: '<orbit-session-reply request-id="req1" outcome="REPLIED">\n你问的是：再跑一组只读探针\n</orbit-session-reply>',
      createdAt: '2026-10-06T09:40:00.000Z',
      sessionReplies: [CARD],
      authoredByOrbit: true,
    });
    expect(queued?.sessionReplies).toEqual([CARD]);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SessionReplyCards
          cards={queued!.sessionReplies!}
          ts={queued!.createdAt}
          attached={<QueuedTurnMeta placement={queued!.placement} onCancel={() => {}} />}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('分析 session 列表页性能');
    expect(html).toContain('全部只读执行');
    expect(html).toContain('Queued for next turn');
    expect(html).not.toContain('&lt;orbit-session-reply');
  });
});
