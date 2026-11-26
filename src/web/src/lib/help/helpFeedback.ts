import { queryOptions } from '@tanstack/react-query';
import { useState } from 'react';
import type { HelpFeedbackKind, HelpFeedbackSummary } from '@orbit/shared';
import { api, getToken } from '../../api';

// Did this help? / Did this answer it? (docs/mocks/help-center board 03, decision 3): a Yes / No and nothing else —
// no text is asked for or sent. The server keeps one vote per person per item, the last one standing.

/** POST /api/help/feedback. */
export const sendHelpFeedback = (kind: HelpFeedbackKind, id: string, helpful: boolean) =>
  api<void>('/help/feedback', { method: 'POST', body: { kind, id, helpful } });

/** An Ask answer's id: the Ask and the question's place in its messages. */
export const askAnswerId = (askId: string, index: number): string => `${askId}:${index}`;

/**
 * The Yes / No buttons' state: which one is pressed, and pressing one records it. Signed out (an article read from
 * the sign-in page) there is no one to count once, so it is shown pressed and not sent. A vote that does not reach
 * the server is not worth interrupting a reader for.
 */
export function useHelpVote(kind: HelpFeedbackKind, id: string) {
  const [vote, setVote] = useState<'yes' | 'no' | null>(null);
  const choose = (answer: 'yes' | 'no') => {
    setVote(answer);
    if (getToken()) void sendHelpFeedback(kind, id, answer === 'yes').catch(() => undefined);
  };
  return { vote, choose };
}

/** GET /api/admin/help-feedback: Admin → Help feedback. */
export const helpFeedbackSummaryQuery = () =>
  queryOptions({
    queryKey: ['admin', 'help-feedback'] as const,
    queryFn: () => api<HelpFeedbackSummary>('/admin/help-feedback'),
  });
