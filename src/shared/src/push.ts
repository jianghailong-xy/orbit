/** S1 Android push contract. FCM data values are strings; `payload` is JSON of AndroidPushPayload. */
export const ANDROID_PUSH_VERSION = '1';

export interface AndroidPushRegistration {
  platform: 'android';
  token: string;
  /** Android applicationId, including .debug for a debug installation. */
  bundleId: string;
  environment?: 'production';
  /** Random UUID v4 persisted per installation and server, retained across account/token changes. */
  installationId: string;
}

export interface AndroidPushRegistrationResult {
  ok: true;
  /** Opaque binding identity, replaced on every successful registration, including account changes. */
  registrationKey: string;
}

export interface AndroidPushUnregistration {
  platform: 'android';
  token: string;
  registrationKey: string;
}

export interface AndroidPushData {
  version: typeof ANDROID_PUSH_VERSION;
  type: 'alert' | 'sync';
  registrationKey: string;
  /** Same across transport retries. Deduplicate before displaying or reconciling. */
  eventId: string;
  /** Stable for an approval/session/owner item; use as the local notification tag, within a binding. */
  notificationKey: string;
  sentAt: string;
  payload: string;
}

/** A hint to reconcile with REST, never authority to perform an approval or revive a closed card. */
export interface AndroidPushPayload {
  title?: string;
  body?: string;
  category?: string;
  threadId?: string;
  kind?: string;
  /** Session count, with the same needs-you predicate as APNs; launcher badges are optional. */
  badge?: number;
  /** Remove only needs-you notifications for these sessions, not unrelated finished/message alerts. */
  clearSessions?: string[];
  sessionID?: string;
  projectID?: string;
  openItemID?: string;
  taskID?: string;
  recordID?: string;
  runnerID?: string;
  engine?: string;
  watchID?: string;
  generation?: number;
  wikiSpaceID?: string;
}
