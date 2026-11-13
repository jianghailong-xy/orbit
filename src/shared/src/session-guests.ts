/**
 * Session guests (docs/session-guests-design.md): the owner of a session invites other Orbit accounts by email to
 * reply in it, and each guest's messages are turns of the owner's own session, sent as external sender ORBIT_GUEST.
 */

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
  /** When the invitation email to this person for this session was sent; null while unsent, or never sent. */
  emailSentAt: string | null;
}

/** One row of the guest's Shared with me (`GET /guest-sessions`). */
export interface GuestSessionSummary {
  id: string;
  title: string;
  ownerName: string;
  status: string;
  sessionState: string;
  lifecycleState: string;
  addedAt: string;
  lastTurnAt: string | null;
}
