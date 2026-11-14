package io.orbitd.android.cards

import android.content.Context
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.AccountSecret
import io.orbitd.android.core.cards.OwnerRequest
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.OwnerRequestsApi
import io.orbitd.android.core.cards.TerminalRequest
import io.orbitd.android.core.cards.TerminalsApi
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * The owner requests this account has, as the conversation that asked and the "Waiting on you" inbox read them: one read per list
 * (`open`, `all`, `done`, `declined`), each request's answer standing in for it in every list as soon as a door returns it. One store
 * per signed-in handle; another account's requests are never drawn.
 */
class OwnerRequestStore internal constructor(private val auth: AuthSession, val handle: SessionHandle, private val scope: CoroutineScope,
    private val api: OwnerRequestsApi = OwnerRequestsApi(auth, handle), private val terminals: TerminalsApi = TerminalsApi(auth, handle)) {

    data class State(
        val lists: Map<String, List<OwnerRequest>> = emptyMap(),
        /** The lists the last read of failed for, so a page can say it could not read them. */
        val failed: Set<String> = emptySet(),
        val savedSecrets: List<AccountSecret> = emptyList(),
        /** The tasks a request holds up, by id, as their titles were read. */
        val taskTitles: Map<String, String> = emptyMap(),
        /** The open projects as `GET /projects?status=OPEN` last answered: their attention counts the coordinators' questions. */
        val projects: List<JsonObject> = emptyList(),
        /** The coordinators' open questions, off the open items of each project that has one (web `WaitingOnYouPage`). */
        val questions: List<OwnerRequests.CoordinatorQuestionRow> = emptyList(),
        /** Terminals asking to be approved (docs/terminal-session-design.md): their cards head the Open tab, whole, and count with the
         * rest. Each waits ten minutes at most. */
        val terminalRequests: List<TerminalRequest> = emptyList(),
    ) {
        fun list(filter: String) = lists[filter].orEmpty()
        val open get() = list(OPEN)
        /** The inbox's one count: [OwnerRequests.waitingCount] and the terminals waiting for a decision. */
        fun waitingCount(projects: List<JsonObject>, snoozes: Map<String, Long>, now: java.time.Instant) =
            OwnerRequests.waitingCount(open, projects, snoozes, now) + terminalRequests.size
        /** A request by either spelling of its id, from any list. */
        fun find(id: String): OwnerRequest? = lists.values.flatten().firstOrNull { OwnerRequests.key(it.id) == OwnerRequests.key(id) }
    }

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    private fun live() = (auth.state.value as? AuthState.SignedIn)?.handle === handle

    /** Read these lists again, on the store's scope, so leaving a page doesn't strand a read half-done. */
    fun load(vararg filters: String) {
        filters.forEach { filter ->
            scope.launch {
                try {
                    val requests = api.list(filter)
                    if (!live()) return@launch
                    mutable.update { it.copy(lists = it.lists + (filter to requests), failed = it.failed - filter) }
                    titles(requests.flatMap { it.blocksTaskIds })
                } catch (cancel: CancellationException) { throw cancel }
                catch (_: Exception) { mutable.update { it.copy(failed = it.failed + filter) } }
            }
        }
    }

    /**
     * The coordinators' questions, which stay on their own table: the open projects, and — for the inbox's rows ([items]) — the open
     * items of each project whose attention says a question is waiting. The drawer's count needs only the projects.
     */
    fun loadQuestions(items: Boolean) {
        scope.launch {
            try {
                val projects = Wire.decode(auth.request(handle, ApiRequest(listOf("projects"), query = listOf("status" to "OPEN"))).requireSuccess().body,
                    JsonArray.serializer()).filterIsInstance<JsonObject>()
                if (!live()) return@launch
                mutable.update { it.copy(projects = projects) }
                if (!items) return@launch
                val questions = OwnerRequests.projectsWithQuestions(projects).flatMap { project ->
                    val id = project.text("id") ?: return@flatMap emptyList()
                    val read = try {
                        Wire.decode(auth.request(handle, ApiRequest(listOf("projects", id, "open-items"))).requireSuccess().body, JsonObject.serializer())
                    } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
                    OwnerRequests.coordinatorQuestions(project, read)
                }
                if (live()) mutable.update { it.copy(questions = questions) }
            } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* The requests still stand on their own. */ }
        }
    }

    fun loadSavedSecrets() {
        scope.launch {
            try { api.accountSecrets().let { secrets -> if (live()) mutable.update { it.copy(savedSecrets = secrets) } } }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* No saved secrets to offer. */ }
        }
    }

    /** The terminals waiting for a decision. A server that predates terminals answers none; a failed read keeps what was drawn. */
    fun loadTerminalRequests() {
        scope.launch {
            try { terminals.requests().let { requests -> if (live()) mutable.update { it.copy(terminalRequests = requests) } } }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* The next read tries again. */ }
        }
    }

    /** Approve or Deny a terminal: null when it was recorded — its card leaves at once — else what to say. The list is read again
     * either way. */
    suspend fun decideTerminal(request: TerminalRequest, approve: Boolean): String? = try {
        if (approve) terminals.approve(request.id) else terminals.deny(request.id)
        mutable.update { state -> state.copy(terminalRequests = state.terminalRequests.filterNot { it.id == request.id }) }
        null
    } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { message(error) }
    finally { loadTerminalRequests() }

    private suspend fun titles(ids: List<String>) {
        ids.distinct().filterNot { it in mutable.value.taskTitles }.forEach { id ->
            try {
                val row = Wire.decode(auth.request(handle, ApiRequest(listOf("tasks", id))).requireSuccess().body, JsonObject.serializer())
                row.text("title")?.let { title -> mutable.update { it.copy(taskTitles = it.taskTitles + (id to title)) } }
            } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* A task that cannot be read keeps a chip with no name. */ }
        }
    }

    /** The door's answer stands in for the request everywhere it is listed, and the lists are read again behind it. */
    private fun adopt(view: OwnerRequest) {
        mutable.update { state ->
            state.copy(lists = state.lists.mapValues { (filter, list) ->
                val kept = list.map { if (OwnerRequests.key(it.id) == OwnerRequests.key(view.id)) view else it }
                if (filter == OPEN && !view.pending) kept.filterNot { it === view } else kept
            })
        }
        load(*mutable.value.lists.keys.toTypedArray())
    }

    /** One press through a door: null when it was recorded, else what to say. */
    suspend fun act(door: suspend OwnerRequestsApi.() -> OwnerRequest): String? = try {
        adopt(api.door()); null
    } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { message(error) }

    companion object {
        const val OPEN = "open"
        const val ALL = "all"
        const val DONE = "done"
        const val DECLINED = "declined"
        private var shared: OwnerRequestStore? = null

        fun of(auth: AuthSession, handle: SessionHandle, scope: CoroutineScope): OwnerRequestStore {
            shared?.takeIf { it.handle === handle }?.let { return it }
            return OwnerRequestStore(auth, handle, scope).also { shared = it }
        }

        /** What a refused press says: the server's own sentence where it gave one. */
        fun message(error: Throwable): String = when {
            error is ApiError && error.messages.isNotEmpty() -> error.messages.first()
            error is NetworkException -> "Can't reach Orbit. Check your connection and try again."
            else -> "Couldn't reach Orbit. Please try again."
        }
    }
}

/**
 * Remind me later, which the server does not hold: a request put off is folded in its conversation and left out of the count on this
 * device until its time comes, and nothing about the request itself changes. Request id → until, in epoch milliseconds.
 */
class OwnerRequestSnoozes private constructor(context: Context) {
    private val preferences = context.getSharedPreferences("orbit.owner-request-snoozes", Context.MODE_PRIVATE)
    private val mutable = MutableStateFlow(read())
    val state: StateFlow<Map<String, Long>> = mutable.asStateFlow()

    private fun read(): Map<String, Long> = preferences.all.mapNotNull { (key, value) -> (value as? Long)?.let { key to it } }.toMap()

    @Synchronized fun snooze(id: String, until: Long, now: Long = System.currentTimeMillis()) {
        val editor = preferences.edit()
        // Spent reminders go with any write.
        mutable.value.filterValues { it <= now }.keys.forEach(editor::remove)
        editor.putLong(OwnerRequests.key(id), until).apply()
        mutable.value = read() + (OwnerRequests.key(id) to until)
    }

    @Synchronized fun wake(id: String) {
        preferences.edit().remove(OwnerRequests.key(id)).apply()
        mutable.value = mutable.value - OwnerRequests.key(id)
    }

    fun until(id: String): Long = mutable.value[OwnerRequests.key(id)] ?: 0

    companion object {
        @Volatile private var shared: OwnerRequestSnoozes? = null
        fun of(context: Context): OwnerRequestSnoozes = shared ?: synchronized(this) {
            shared ?: OwnerRequestSnoozes(context.applicationContext).also { shared = it }
        }
        /** Tests start from an empty device. */
        internal fun reset(context: Context) {
            context.getSharedPreferences("orbit.owner-request-snoozes", Context.MODE_PRIVATE).edit().clear().commit()
            shared = null
        }
    }
}
