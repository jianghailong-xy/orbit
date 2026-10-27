package io.orbitd.android.core.realtime

/**
 * What the store took in, for a measurement to check against the server's own record (D09 P06's zero-loss, zero-duplicate
 * witness, A15): each durable session event an SSE frame or a REST page brought, with whether the window already held its
 * sequence, and each account event. The store asks [enabled] first and, without a witness or while it is off, does nothing
 * more; nothing it reports changes what the store does.
 */
interface RealtimeWitness {
    val enabled: Boolean
    /** [via]: `sse`, a frame; `page`, a REST page past the cursor (a gap closed, or the page verifying where the stream began);
     * `tail`, a fresh window (a cold open, a reseed after resync, recovered access), which held nothing before it. */
    fun durable(sessionId: String, seq: Long, duplicate: Boolean, via: String)
    fun account(type: String, sessionId: String)
}
