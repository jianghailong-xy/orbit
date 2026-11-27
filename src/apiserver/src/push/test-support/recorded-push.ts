import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../../prisma/prisma.service';
import { PushService } from '../push.service';

/** APNs configured, so a decision card is refused for no want of a channel; delivery itself is recorded. */
const APNS_CONFIG = {
  get: (key: string) => ({
    APNS_KEY_ID: 'decision-cards', APNS_TEAM_ID: 'decision-cards', APNS_KEY: Buffer.from('unused').toString('base64'),
  })[key],
} as unknown as ConfigService;

/** One push as a device would have been handed it: the APNs body, and whose device it was for. */
export interface RecordedPush {
  userId: string;
  collapseId: string | undefined;
  payload: {
    aps: { alert: { title: string; body: string }; badge?: number };
    kind: string;
    cardKind?: string;
    sessionID?: string;
    projectID?: string;
    taskID?: string;
  };
}

/**
 * A PushService over a real database (pg specs), its deliveries recorded instead of sent. Writes nothing itself: the
 * spec registers the owner's device. `sweep` runs one decision-card pass and answers this owner's pushes from it.
 */
export function recordedPush(db: unknown) {
  const sent: RecordedPush[] = [];
  const push = new PushService(db as PrismaService, APNS_CONFIG);
  (push as unknown as {
    deliver: (tokens: Array<{ userId: string }>, body: string, type: string, priority: string, collapseId?: string) => Promise<number>;
  }).deliver = async (tokens, body, _type, _priority, collapseId) => {
    for (const token of tokens) sent.push({ userId: token.userId, collapseId, payload: JSON.parse(body) as RecordedPush['payload'] });
    return tokens.length;
  };
  return {
    push,
    sent,
    async sweep(ownerId: string, readAt?: Date): Promise<RecordedPush[]> {
      const before = sent.length;
      await push.notifyDecisionCards(readAt);
      return sent.slice(before).filter((one) => one.userId === ownerId);
    },
  };
}
