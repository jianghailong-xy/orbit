// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseRunQuestion } from '../lib/runQuestion';
import { RunQuestionCard } from './RunQuestionCard';

const card = {"requestId": "run-question-1", "taskTitle": "Ship client cards", "runSessionId": "run-session", "replyBy": "2026-11-12T12:00:00Z", "state": "PENDING", "approvalStatus": "PENDING", "questions": [{"question": "Ship now?", "options": [{"label": "Ship", "description": "Release today"}, {"label": "Wait"}], "multiSelect": false}]};
describe('the coordinator run question record', () => {
  it('draws questions and options without owner answer controls', () => {
    const parsed = parseRunQuestion({ runQuestion: card });
    const html = renderToStaticMarkup(<RunQuestionCard card={parsed!} />);
    expect(html).toContain('Ship now?');
    expect(html).toContain('Release today');
    expect(html).toContain('Waiting for the coordinator');
    expect(html).not.toMatch(/<(button|input|textarea)/);
    expect(parseRunQuestion({ runQuestion: { requestId: 'bad' } })).toBeNull();
  });
  it('draws the settled read without a deadline', () => {
    const html = renderToStaticMarkup(<RunQuestionCard card={{ ...card, state: 'REPLIED', approvalStatus: 'ALLOWED' }} />);
    expect(html).toContain('No longer waiting for the coordinator');
    expect(html).not.toContain('Reply by');
  });
});
