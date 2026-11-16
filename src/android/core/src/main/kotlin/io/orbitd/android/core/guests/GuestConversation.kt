package io.orbitd.android.core.guests

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.core.realtime.SENTINEL_SEQ
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** What the guest view draws. [events] are the door's, the reader's own messages already read as theirs ([GuestTranscript]). */
data class GuestView(
    val loaded: Boolean = false,
    /** The door answered 404: no longer shared with this account (removed, left, Trash or deleted). */
    val gone: Boolean = false,
    /** The first read failed for any other reason; the view offers to read again. */
    val error: String? = null,
    val title: String = "",
    val ownerName: String = "",
    val state: GuestState = GuestState(),
    val events: List<RunEvent> = emptyList(),
    val hasOlder: Boolean = false,
    val loadingOlder: Boolean = false,
    val draft: String = "",
    val sending: Boolean = false,
    val sendError: String? = null,
)

/**
 * One guest view's reads and its one write (web `GuestConversation`): the root, the follow loop at [GuestFollow]'s cadence, older pages,
 * and a text-only message. A sent message is drawn at once, before the door answers, until the runner's echo of its turn replaces it;
 * the send then asks at once, every [ECHO_MS] while that echo is missing (for up to [ECHO_FOR_MS]), and every 4 s until the run it
 * started has been seen. A 404 at any point is the not-shared state, and nothing is read after it. [initial] is the root an owner's 404 already read, so the view opens on it.
 */
class GuestConversation(
    private val api: OrbitApi,
    private val handle: SessionHandle,
    val id: String,
    private val myName: String?,
    private val scope: CoroutineScope,
    initial: GuestSession? = null,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newTurnId: () -> String = { UUID.randomUUID().toString() },
) {
    private val mutable = MutableStateFlow(GuestView())
    val state: StateFlow<GuestView> = mutable.asStateFlow()
    private var raw: List<RunEvent> = emptyList()
    private var after = 0L
    private var expecting = false
    private var followed = false
    private val kick = Channel<Unit>(Channel.CONFLATED)
    /** What this view sent, drawn until the runner's `user` event for its turn is read. */
    private var sent: List<SentTurn> = emptyList()
    /** The turns sent whose echo has not been read yet, each until when it is asked for every [ECHO_MS]. */
    private val awaitingEcho = mutableMapOf<String, Long>()
    private var sentCount = 0L

    private class SentTurn(val key: Long, val turnId: String?, val text: String, val ts: String)

    init { initial?.let(::seed) }

    private fun seed(root: GuestSession) {
        raw = merge(emptyList(), root.events)
        after = raw.lastOrNull()?.seq ?: 0
        mutable.update { it.copy(loaded = true, error = null, title = root.title, ownerName = root.ownerName, state = root.state,
            events = shown(), hasOlder = root.hasMore && raw.isNotEmpty()) }
    }

    /** The door's events, the reader's own read as theirs, and below them what this view sent that is not echoed yet. A drawn
     *  message's seq sits just under [SENTINEL_SEQ]: after every real event, and never one a real event can take. */
    private fun shown(): List<RunEvent> {
        val read = GuestTranscript.ownMessages(raw, myName)
        val echoed = raw.mapNotNullTo(mutableSetOf()) { e -> e.turnId?.takeIf { e.type == "user" } }
        val waiting = sent.filter { it.turnId == null || it.turnId !in echoed }
        return read + waiting.map { turn ->
            RunEvent(type = "user", seq = SENTINEL_SEQ - DRAWN_SEQS + turn.key, turnId = turn.turnId, ts = turn.ts,
                payload = buildJsonObject {
                    put("text", turn.text)
                    putJsonObject("externalSender") { put("source", GuestTranscript.READER_SOURCE) }
                })
        }
    }

    private fun publish() = mutable.update { it.copy(events = shown()) }

    private fun gone(failure: Throwable) = failure is ApiError && failure.status == 404

    /** The root, when nothing has read it yet. */
    suspend fun load() {
        if (mutable.value.loaded || mutable.value.gone) return
        try { seed(api.guestSession(handle, id)) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) {
            if (gone(failure)) mutable.update { it.copy(gone = true) }
            else mutable.update { it.copy(error = failure.message ?: GuestCopy.COULD_NOT_LOAD) }
        }
    }

    /** Asks for the root again after a failed first read. */
    fun retryLoad() = mutable.update { it.copy(error = null) }

    /** Follows the conversation until cancelled (the page leaving, or its Activity stopping). Started again, it reads at once. */
    suspend fun follow() {
        load()
        if (!mutable.value.loaded) return
        var wait: Long? = if (followed || expecting) 0 else GuestFollow.delay(mutable.value.state, moved = false, expecting = expecting)
        followed = true
        while (!mutable.value.gone) {
            val current = wait
            if (current == null) kick.receive() else if (current > 0) withTimeoutOrNull(current) { kick.receive() }
            wait = read()
        }
    }

    /** One follow read; the wait before the next, or null to wait for a send. */
    private suspend fun read(): Long? = try {
        val answer = api.guestEventsAfter(handle, id, after)
        val added = answer.events.filter { it.seq > after }
        if (added.isNotEmpty()) { raw = merge(raw, added); after = added.last().seq }
        added.forEach { e -> if (e.type == "user") e.turnId?.let(awaitingEcho::remove) }
        val now = clock()
        awaitingEcho.values.removeAll { until -> until <= now }
        if (answer.state.live) expecting = false
        mutable.update { it.copy(state = answer.state, title = answer.title ?: it.title, events = shown()) }
        val next = if (answer.after != null) 0 else GuestFollow.delay(answer.state, added.isNotEmpty(), expecting)
        if (awaitingEcho.isNotEmpty()) minOf(next ?: ECHO_MS, ECHO_MS) else next
    } catch (cancel: CancellationException) { throw cancel }
    catch (failure: Exception) {
        if (gone(failure)) { mutable.update { it.copy(gone = true) }; null } else GuestFollow.WORKING_MS
    }

    /** The page just older than the oldest event shown. */
    fun older() {
        val view = mutable.value
        val before = raw.firstOrNull()?.seq ?: return
        if (!view.hasOlder || view.loadingOlder) return
        mutable.update { it.copy(loadingOlder = true) }
        scope.launch {
            try {
                val page = api.guestEventsBefore(handle, id, before)
                raw = merge(page.events, raw)
                mutable.update { it.copy(hasOlder = page.hasMore && page.events.isNotEmpty()) }
                publish()
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { if (gone(failure)) mutable.update { it.copy(gone = true) } }
            finally { mutable.update { it.copy(loadingOlder = false) } }
        }
    }

    /** One event whole, for a card that came back `truncated`. */
    suspend fun full(seq: Long): RunEvent = api.guestEventFull(handle, id, seq)

    fun edit(text: String) = mutable.update { it.copy(draft = text, sendError = null) }

    /** Sends the draft as a turn of the owner's session, then asks at once for its echo and the run it started. */
    fun send() {
        val content = mutable.value.draft.trim()
        if (content.isEmpty() || mutable.value.sending || mutable.value.gone) return
        // Drawn the moment it is sent: the composer empties and the words sit in the conversation while the send is on its way.
        val key = ++sentCount
        sent = sent + SentTurn(key, null, content, Instant.ofEpochMilli(clock()).toString())
        mutable.update { it.copy(sending = true, sendError = null, draft = "", events = shown()) }
        scope.launch {
            try {
                val accepted = api.sendGuestTurn(handle, id, newTurnId(), content)
                expecting = true
                accepted.turnId?.let { awaitingEcho[it] = clock() + ECHO_FOR_MS }
                sent = sent.map { if (it.key == key) SentTurn(key, accepted.turnId, it.text, it.ts) else it }
                publish()
                kick.trySend(Unit)
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) {
                // Not sent: the bubble goes, and the words go back to the composer unless something new was typed meanwhile.
                sent = sent.filterNot { it.key == key }
                mutable.update { it.copy(events = shown(), draft = it.draft.ifBlank { content }) }
                if (gone(failure)) mutable.update { it.copy(gone = true) }
                else mutable.update { it.copy(sendError = (failure as? ApiError)?.messages?.firstOrNull() ?: failure.message) }
            } finally { mutable.update { it.copy(sending = false) } }
        }
    }

    private companion object {
        /** How soon it asks again while a message it sent has not come back from the runner: written a moment after the send is
         *  accepted, it was otherwise seen only at the next 4 s read. */
        const val ECHO_MS = 500L
        /** How long it asks that often. A message behind a running turn is echoed only when its turn starts, which can be minutes. */
        const val ECHO_FOR_MS = 10_000L
        /** The seqs below [SENTINEL_SEQ] a drawn message takes, one per message this view sent: far above any session's real events. */
        const val DRAWN_SEQS = 1_000_000_000L
        fun merge(a: List<RunEvent>, b: List<RunEvent>) = (a + b).associateBy { it.seq }.values.sortedBy { it.seq }
    }
}
