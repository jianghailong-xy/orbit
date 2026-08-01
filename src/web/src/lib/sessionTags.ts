import { api } from '../api';
import type { SessionTagRef } from './sessionGrouping';

/** Replace the complete set of colored tags applied to one session. */
export const setSessionTags = (sessionId: string, tagIds: string[]): Promise<SessionTagRef[]> =>
  api(`/sessions/${sessionId}/tags`, { method: 'PUT', body: { tagIds } });
