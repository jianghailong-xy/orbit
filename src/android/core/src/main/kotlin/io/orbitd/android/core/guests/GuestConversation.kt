package io.orbitd.android.core.guests

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.realtime.RunEvent
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
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
 * and a text-only message. A send asks at once and keeps asking every 4 s until the run it started has been seen. A 404 at any point is
 * the not-shared state, and nothing is read after it. [initial] is the root an owner's 404 already read, so the view opens on it.
 */
class GuestConversation(
    private val api: OrbitApi,
    private val handle: SessionHandle,
    val id: String,
    private val myName: String?,
    private val scope: CoroutineScope,
    initial: GuestSession? = null,
    private val newTurnId: () -> String = { UUID.randomUUID().toString() },
) {
    private val mutable = MutableStateFlow(GuestView())
    val state: StateFlow<GuestView> = mutable.asStateFlow()
    private var raw: List<RunEvent> = emptyList()
    private var after = 0L
    private var expecting = false
    private var followed = false
    private val kick = Channel<Unit>(Channel.CONFLATED)

    init { initial?.let(::seed) }

    private fun seed(root: GuestSession) {
        raw = merge(emptyList(), root.events)
        after = raw.lastOrNull()?.seq ?: 0
        mutable.update { it.copy(loaded = true, error = null, title = root.title, ownerName = root.ownerName, state = root.state,
            events = GuestTranscript.ownMessages(raw, myName), hasOlder = root.hasMore && raw.isNotEmpty()) }
    }

    private fun publish() = mutable.update { it.copy(events = GuestTranscript.ownMessages(raw, myName)) }

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
        if (answer.state.live) expecting = false
        mutable.update { it.copy(state = answer.state, title = answer.title ?: it.title, events = GuestTranscript.ownMessages(raw, myName)) }
        if (answer.after != null) 0 else GuestFollow.delay(answer.state, added.isNotEmpty(), expecting)
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
        mutable.update { it.copy(sending = true, sendError = null) }
        scope.launch {
            try {
                api.sendGuestTurn(handle, id, newTurnId(), content)
                expecting = true
                mutable.update { it.copy(draft = "") }
                kick.trySend(Unit)
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) {
                if (gone(failure)) mutable.update { it.copy(gone = true) }
                else mutable.update { it.copy(sendError = (failure as? ApiError)?.messages?.firstOrNull() ?: failure.message) }
            } finally { mutable.update { it.copy(sending = false) } }
        }
    }

    private companion object {
        fun merge(a: List<RunEvent>, b: List<RunEvent>) = (a + b).associateBy { it.seq }.values.sortedBy { it.seq }
    }
}
