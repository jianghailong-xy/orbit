package io.orbitd.android.cards

import android.content.Context
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.AccountSecret
import io.orbitd.android.core.cards.OwnerRequest
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.OwnerRequestsApi
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.schedule.ScheduleApi
import io.orbitd.android.core.schedule.ScheduleWaitingItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject

/**
 * The owner requests this account has, as the conversation that asked reads them: one read per list (`open`, `all`), each
 * request's answer standing in for it in every list as soon as a door returns it. One store
 * per signed-in handle; another account's requests are never drawn.
 */
class OwnerRequestStore internal constructor(private val auth: AuthSession, val handle: SessionHandle, private val scope: CoroutineScope,
    private val api: OwnerRequestsApi = OwnerRequestsApi(auth, handle)) {

    data class State(
        val lists: Map<String, List<OwnerRequest>> = emptyMap(),
        val savedSecrets: List<AccountSecret> = emptyList(),
        /** The tasks a request holds up, by id, as their titles were read. */
        val taskTitles: Map<String, String> = emptyMap(),
        /** The scheduled tasks' four kinds, pending (docs/scheduled-tasks-design.md §6.4): their cards head the Scheduled page, whole,
         * and are answered at the schedule's own doors. There is no Waiting on you page (docs/mocks/waiting-on-you-removal). */
        val scheduleItems: List<ScheduleWaitingItem> = emptyList(),
        /** A condition's two kinds, pending: the can't-read card and the 30-day question (docs/condition-triggers-design.md §5.3,
         * §6.2). They head the Scheduled page with the schedule's. */
        val conditionItems: List<io.orbitd.android.core.schedule.ConditionWaitingItem> = emptyList(),
    ) {
        fun list(filter: String) = lists[filter].orEmpty()
        val open get() = list(OPEN)
        /** A request by either spelling of its id, from any list. */
        fun find(id: String): OwnerRequest? = lists.values.flatten().firstOrNull { OwnerRequests.key(it.id) == OwnerRequests.key(id) }
    }

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    private val accountState = MutableStateFlow<JsonObject?>(null)
    /** `GET /users/me` as last read: the marks (`changedBy`) a SETTINGS_CHANGE card's Undo reads (design §5.3). */
    val account: StateFlow<JsonObject?> = accountState.asStateFlow()

    /** The account read again, for the marks a just-applied card wrote. A failed read keeps what was drawn. */
    suspend fun loadAccount() {
        try {
            val me = Wire.decode(auth.request(handle, ApiRequest(listOf("users", "me"))).requireSuccess().body, JsonObject.serializer())
            if (live()) accountState.value = me
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* The card shows no Undo until it can be read. */ }
    }

    /** Undo of a change made from a conversation (design §5.3): the owner's own preferences PATCH with each key's `from`. Null when
     * it went through, else what to say. */
    suspend fun undoSettings(values: JsonObject): String? {
        if (values.isEmpty()) return null
        return try {
            val bytes = values.toString().encodeToByteArray()
            auth.request(handle, ApiRequest(listOf("users", "me", "preferences"), HttpMethod.PATCH, body = bytes)).requireSuccess()
            loadAccount(); null
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { message(error) }
    }

    private fun live() = (auth.state.value as? AuthState.SignedIn)?.handle === handle

    /** Read these lists again, on the store's scope, so leaving a page doesn't strand a read half-done. */
    fun load(vararg filters: String) {
        filters.forEach { filter ->
            scope.launch {
                try {
                    val (requests, scheduled, conditions) = api.listWithConditions(filter)
                    if (!live()) return@launch
                    mutable.update { state -> state.copy(lists = state.lists + (filter to requests),
                        scheduleItems = if (filter == OPEN) scheduled.filter { it.state == OwnerRequests.PENDING } else state.scheduleItems,
                        conditionItems = if (filter == OPEN) conditions.filter { it.state == OwnerRequests.PENDING } else state.conditionItems) }
                    titles(requests.flatMap { it.blocksTaskIds })
                } catch (cancel: CancellationException) { throw cancel }
                catch (_: Exception) { /* The list stands as it was last read. */ }
            }
        }
    }

    fun loadSavedSecrets() {
        scope.launch {
            try { api.accountSecrets().let { secrets -> if (live()) mutable.update { it.copy(savedSecrets = secrets) } } }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* No saved secrets to offer. */ }
        }
    }

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
    suspend fun act(door: suspend OwnerRequestsApi.() -> OwnerRequest): String? = attempt(door)?.let(::message)

    /** One press through a door: null when it was recorded, else why not. */
    suspend fun attempt(door: suspend OwnerRequestsApi.() -> OwnerRequest): Exception? = try {
        adopt(api.door()); null
    } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { error }

    companion object {
        const val OPEN = "open"
        const val ALL = "all"
        private var shared: OwnerRequestStore? = null

        fun of(auth: AuthSession, handle: SessionHandle, scope: CoroutineScope): OwnerRequestStore {
            shared?.takeIf { it.handle === handle }?.let { return it }
            return OwnerRequestStore(auth, handle, scope).also { shared = it }
        }

        /** What a refused press says: the server's own sentence where it gave one. */
        fun message(error: Throwable): String = when {
            error is ApiError && error.messages.isNotEmpty() -> error.messages.first()
            error is NetworkException -> "Can't reach Orbit. Check your connection and try again."
            error is ApiError -> "Orbit couldn't do this (error ${error.status}). Try again."
            error is ProtocolException || error is SerializationException -> ScheduleApi.UNREADABLE
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
