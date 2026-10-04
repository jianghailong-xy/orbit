package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.Serializable

/** A reading window is separate from the replay frontier. Paging cannot move sinceSeq or
 * splice the live tail across an unread gap. Cap the far edge, never the reader's near edge. */
@Serializable
data class ReadingWindow(
    val events: List<RunEvent> = emptyList(),
    val hasOlder: Boolean = false,
    val newerAfter: Long? = null,
    val seeded: Boolean = false,
) {
    fun seed(page: EventPage) = ReadingWindow(page.events.filter { it.durable }, page.hasMore, page.after, true)
    fun older(page: EventPage): ReadingWindow {
        val merged = merge(page.events, events)
        val kept = merged.take(LIMIT)
        return copy(events = kept, hasOlder = page.hasMore,
            newerAfter = if (merged.size > LIMIT) kept.last().seq else newerAfter, seeded = true)
    }
    fun newer(page: EventPage): ReadingWindow {
        val merged = merge(events, page.events)
        return copy(events = merged.takeLast(LIMIT), hasOlder = hasOlder || merged.size > LIMIT,
            newerAfter = page.after, seeded = true)
    }
    fun live(tail: Transcript, following: Boolean): ReadingWindow {
        if (!tail.seeded || newerAfter != null) return this
        if (!seeded) return seed(EventPage(tail.events, tail.hasMore))
        if (tail.events === events) return this
        // A resync can replace the entire tail. A reader in history keeps their window and
        // explicitly pages across the gap; a pinned reader can take the fresh tail immediately.
        val overlaps = events.isEmpty() || tail.events.isEmpty() ||
            tail.events.first().seq <= events.last().seq && tail.events.last().seq >= events.first().seq
        if (!overlaps) return if (following) seed(EventPage(tail.events, tail.hasMore))
            else copy(newerAfter = events.lastOrNull()?.seq)
        val merged = merge(events, tail.events)
        if (!following && merged.size > LIMIT) return copy(newerAfter = events.lastOrNull()?.seq)
        return copy(events = merged.takeLast(LIMIT), hasOlder = hasOlder || tail.hasMore || merged.size > LIMIT)
    }
    companion object {
        const val LIMIT = 2_000
        private fun merge(a: List<RunEvent>, b: List<RunEvent>) =
            (a + b).filter { it.durable }.associateBy { it.seq }.values.sortedBy { it.seq }
    }
}

class TranscriptApi(private val api: OrbitApi, private val handle: SessionHandle, private val id: String) {
    suspend fun page(query: Pair<String, String>): EventPage = Wire.decode(api.request(handle,
        ApiRequest(listOf("sessions", id, "events", "page"),
            query = listOf(query, "limit" to "200", "maxPayload" to "2048"))).body, EventPage.serializer())
    suspend fun full(seq: Long): RunEvent = Wire.decode(api.request(handle,
        ApiRequest(listOf("sessions", id, "events", "$seq", "full"), maxResponseBytes = 40L * 1024 * 1024)).body, RunEvent.serializer())
}
