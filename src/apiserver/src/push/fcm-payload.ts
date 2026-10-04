import { ANDROID_PUSH_VERSION, type AndroidPushData, type AndroidPushPayload } from '@orbit/shared';

/** Translate the existing business payload once at the transport boundary. APNs stays unchanged. */
export function fcmData(
  body: string,
  type: 'alert' | 'background',
  eventId: string,
  sentAt: string,
  collapseId?: string,
): Omit<AndroidPushData, 'registrationKey'> {
  const { aps, ...routing } = JSON.parse(body);
  const payload: AndroidPushPayload = {
    ...routing,
    ...(aps.alert ? { title: aps.alert.title, body: aps.alert.body } : {}),
    ...(aps.category ? { category: aps.category } : {}),
    ...(aps['thread-id'] ? { threadId: aps['thread-id'] } : {}),
    ...(aps.badge !== undefined ? { badge: aps.badge } : {}),
  };
  return {
    version: ANDROID_PUSH_VERSION,
    type: type === 'background' ? 'sync' : 'alert',
    eventId,
    sentAt,
    notificationKey: collapseId ?? (type === 'background' ? 'badge-sync'
      : routing.kind === 'approval' ? `approval-${routing.sessionID}` : eventId),
    payload: JSON.stringify(payload),
  };
}
