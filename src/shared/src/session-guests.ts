/**
 * Session guests (docs/session-guests-design.md): the owner of a session invites other Orbit accounts by email to
 * reply in it, and each guest's messages are turns of the owner's own session, sent as external sender ORBIT_GUEST.
 */

import type { SessionActivity } from './task-run-reason';

/** One person who can reply, as the owner's `GET /sessions/:id/guests` lists them. */
export interface SessionGuestPerson {
  userId: string;
  name: string;
  email: string;
  addedAt: string;
  /** The guest's messages to this session since midnight UTC. */
  messagesToday: number;
  /** Whether the guest has opened the session at least once. */
  opened: boolean;
}

/** One row of the guest's Shared with me (`GET /guest-sessions`). */
export interface GuestSessionSummary {
  id: string;
  title: string;
  ownerName: string;
  status: string;
  sessionState: string;
  lifecycleState: string;
  /** What the session is doing beyond its status (SessionActivity); absent from an older server. */
  activity?: SessionActivity | null;
  addedAt: string;
  lastTurnAt: string | null;
}
