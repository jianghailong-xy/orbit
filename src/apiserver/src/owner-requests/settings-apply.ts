import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { settingValueInForce } from '@orbit/shared';
import { mergePreferences, recordDefaultPermissionModeChange, withChangedBy } from '../users/preferences-merge';
import { SETTINGS_STALE } from './owner-request';
import { sameSettingValue, type SettingsChangeEntry } from './settings-change';

/**
 * What the owner's Save changes on a SETTINGS_CHANGE card writes (docs/settings-from-conversation-design.md §5.2, §5.3),
 * in the transaction that settles the card DONE (`OwnerRequestsService.applySettings`). The account's preferences are
 * re-read under the user row's lock; when any key's value in force is no longer the card's `from` it throws 409
 * SETTINGS_STALE, which rolls the settle back whole. Otherwise each `to` is merged as the owner's PATCH merges it and
 * each key written is marked `changedBy[key] = { sessionId, requestId, at, from }`.
 */
export async function applySettingsChanges(
  tx: Prisma.TransactionClient,
  card: { ownerId: string; requestId: string; askedBySessionId: string; changes: readonly SettingsChangeEntry[] },
  now: Date,
  client: string | null,
): Promise<void> {
  const [row] = await tx.$queryRaw<Array<{ preferences: Prisma.JsonValue }>>`
    SELECT "preferences" FROM "user" WHERE "id" = ${card.ownerId}::uuid FOR NO KEY UPDATE`;
  const current = (row?.preferences ?? {}) as Record<string, unknown>;
  const stale = card.changes.filter((change) => !sameSettingValue(change.key, settingValueInForce(change.key, current), change.from));
  if (stale.length > 0) {
    throw new ConflictException({
      code: SETTINGS_STALE,
      message: 'This setting changed since it was proposed; nothing was written.',
      settings: stale.map((change) => change.key),
    });
  }
  const { merged, written } = mergePreferences(current, Object.fromEntries(card.changes.map((change) => [change.key, change.to])));
  const from = new Map<string, unknown>(card.changes.map((change) => [change.key, change.from]));
  const preferences = withChangedBy(merged, written, (key) => ({
    sessionId: card.askedBySessionId,
    requestId: card.requestId,
    at: now.toISOString(),
    from: from.get(key),
  }));
  await tx.user.update({ where: { id: card.ownerId }, data: { preferences: preferences as Prisma.InputJsonValue } });
  await recordDefaultPermissionModeChange(tx, card.ownerId, current, preferences, { senderClient: client ?? undefined });
}
