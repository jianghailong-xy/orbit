package io.orbitd.android.reader

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.*
import io.orbitd.android.directory.directoryError
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
internal data class ReadingBookmark(val seq: Long = 0, val offset: Int = 0, val following: Boolean = true,
    val window: ReadingWindow = ReadingWindow(), val accessRevision: Long = 0)
internal data class ReadingState(val window: ReadingWindow = ReadingWindow(), val session: SessionState? = null,
    val ready: Boolean = false, val loading: Boolean = false, val error: String? = null,
    val targetSeq: Long? = null, val targetOffset: Int = 0, val targetTick: Long = 0,
    val denied: Boolean = false)

/** One route/account lifetime; the application's A04 store continues to own all SSE and authority. */
internal class SessionReaderModel(private val auth: AuthSession, private val handle: SessionHandle,
    private val store: RealtimeStore, val id: String, private val scope: CoroutineScope, record: String?,
    restoreSavedRecord: Boolean = false) : AutoCloseable {
    private val job = SupervisorJob(scope.coroutineContext[Job])
    private val owner = CoroutineScope(scope.coroutineContext + job)
    private val api = TranscriptApi(auth, handle, id)
    private val mutable = MutableStateFlow(ReadingState())
    val state = mutable.asStateFlow()
    var following: Boolean = record == null
        private set
    private var bookmark = ReadingBookmark()
    private var pageJob: Job? = null
    private var saveJob: Job? = null
    private var generation = 0L
    private val canonicalId = ObjectId.canonical(id) ?: id
    private val cacheKey = "reader-$canonicalId" + (record?.let { "-${ObjectId.canonical(it) ?: it}" } ?: "")
    private val cache = ReadingCache(auth, handle, canonicalId)
    private var access = ReadingAccess()

    init {
        owner.launch {
            val saved = try { val (permission, bytes) = cache.read(cacheKey); access = permission
                bytes?.takeIf { it.size <= CACHE_LIMIT }
                ?.let { Wire.decode(it, ReadingBookmark.serializer()) } } catch (cancel: CancellationException) { throw cancel }
                catch (_: Exception) { null }
            val restoreSaved = (record == null || restoreSavedRecord) && saved != null &&
                !access.denied && saved.accessRevision == access.revision && saved.window.events.size <= ReadingWindow.LIMIT
            if (restoreSaved) {
                bookmark = saved; following = saved.following
                mutable.value = ReadingState(window = saved.window, ready = true,
                    targetSeq = saved.seq.takeIf { !saved.following }, targetOffset = saved.offset, targetTick = 1)
                if (!saved.following && !saved.window.seeded) restore(saved.seq, saved.offset)
            } else mutable.value = ReadingState(ready = true, denied = access.denied)
            if (record != null && !restoreSaved && !access.denied) openRecord(record)
            var previousEvents: List<RunEvent>? = null
            store.state.collect { live ->
                val s = live.session?.takeIf { live.handle === handle && it.id == id } ?: return@collect
                val denied = s.accessDenied
                if (denied) {
                    withdraw(s)
                    previousEvents = null
                } else if (access.denied) {
                    // Only a fresh authority response may release the session-wide marker.
                    if (!s.fresh || s.snapshot == null) return@collect
                    access = cache.authorize(access.revision)
                    if (access.denied) return@collect
                    mutable.value = ReadingState(session = s, ready = true)
                    previousEvents = null
                    if (record != null) openRecord(record) else latest()
                } else {
                    val old = mutable.value
                    val restoring = !old.window.seeded && old.targetSeq != null
                    val window = if ((previousEvents !== s.transcript.events || !old.window.seeded && s.transcript.seeded) && !old.loading && !restoring) old.window.live(s.transcript, following) else old.window
                    previousEvents = if (!old.loading) s.transcript.events else previousEvents
                    mutable.value = old.copy(window = window, session = s, denied = false)
                }
            }
        }
    }
    fun position(seq: Long, offset: Int, follow: Boolean) {
        if (bookmark.seq == seq && bookmark.offset == offset && bookmark.following == follow) return
        following = follow
        bookmark = ReadingBookmark(seq, offset, follow)
        saveJob?.cancel()
        saveJob = owner.launch { delay(300); save() }
    }
    private suspend fun save() {
        if (mutable.value.denied) return
        val window = mutable.value.window
        val index = window.events.indexOfFirst { it.seq >= bookmark.seq }.coerceAtLeast(0)
        var count = 200
        fun slice(): ReadingBookmark {
            val from = if (bookmark.following) (window.events.size - count).coerceAtLeast(0) else (index - count / 3).coerceAtLeast(0)
            val events = window.events.drop(from).take(count)
            return bookmark.copy(accessRevision = access.revision, window = window.copy(events = events, hasOlder = window.hasOlder || from > 0,
                newerAfter = if (from + events.size < window.events.size) events.lastOrNull()?.seq else window.newerAfter))
        }
        var saved = slice()
        var bytes = Wire.json.encodeToString(saved).encodeToByteArray()
        while (bytes.size > CACHE_LIMIT && count > 1) {
            count /= 2; saved = slice(); bytes = Wire.json.encodeToString(saved).encodeToByteArray()
        }
        if (bytes.size > CACHE_LIMIT) {
            // No giant payloads in saved state; online restore can page around the saved sequence.
            saved = saved.copy(window = ReadingWindow())
            bytes = Wire.json.encodeToString(saved).encodeToByteArray()
        }
        try { cache.write(cacheKey, saved.accessRevision, bytes) }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { mutable.update { it.copy(error = "Couldn't save reading position. Keep this session open and retry.") } }
    }
    fun older() {
        val window = mutable.value.window
        if (!window.hasOlder) return
        val before = window.events.firstOrNull()?.seq ?: return
        page { old ->
            val loaded = read { api.page("before" to "$before") }
            old.copy(window = old.window.older(loaded), targetSeq = bookmark.seq.takeIf { it > 0 },
                targetOffset = bookmark.offset, targetTick = old.targetTick + 1)
        }
    }
    fun newer() {
        val after = mutable.value.window.newerAfter ?: return
        page { old ->
            val loaded = read { api.page("after" to "$after") }
            old.copy(window = old.window.newer(loaded), targetSeq = bookmark.seq.takeIf { it > 0 },
                targetOffset = bookmark.offset, targetTick = old.targetTick + 1)
        }
    }
    fun show(seq: Long) { following = false; mutable.update { it.copy(targetSeq = seq, targetOffset = 0, targetTick = it.targetTick + 1) } }
    suspend fun full(seq: Long): RunEvent {
        val version = generation
        val event = read(recordScoped = true) { api.full(seq) }
        if (version != generation || mutable.value.denied || !cache.valid(access.revision)) throw CancellationException("Reading access changed")
        return event
    }
    fun openRecord(record: String) {
        following = false
        page(replace = true) { old ->
            try {
                val page = read(recordScoped = true) { api.page("around" to record) }
                val anchor = page.anchor ?: error("Missing anchor")
                old.copy(window = ReadingWindow().seed(page), targetSeq = anchor.seq, targetOffset = 0, targetTick = old.targetTick + 1)
            } catch (error: ApiError) {
                if (error.status == 404) old.copy(error = "That message is not in this session") else throw error
            }
        }
    }
    fun latest() {
        following = true
        page(replace = true) { old -> old.copy(window = ReadingWindow().seed(read { api.page("tail" to "200") }),
            targetSeq = null, targetTick = old.targetTick + 1) }
    }
    private fun restore(seq: Long, offset: Int) {
        page(replace = true) { old ->
            val loaded = read { api.page("before" to "${seq + 1}") }
            old.copy(window = ReadingWindow().seed(loaded).copy(newerAfter = loaded.events.lastOrNull()?.seq),
                targetSeq = seq, targetOffset = offset, targetTick = old.targetTick + 1)
        }
    }
    fun retry() {
        store.refreshSession()
        val state = mutable.value
        if (!state.window.seeded && state.targetSeq != null) restore(state.targetSeq, state.targetOffset)
        else if (!state.window.seeded) latest() else mutable.update { it.copy(error = null) }
    }
    private fun page(replace: Boolean = false, load: suspend (ReadingState) -> ReadingState) {
        if (mutable.value.denied || pageJob?.isActive == true && !replace) return
        if (replace) { generation++; pageJob?.cancel() }
        val version = generation
        pageJob = owner.launch {
            mutable.update { it.copy(loading = true, error = null) }
            try {
                val old = mutable.value
                val loaded = load(old)
                ensureActive()
                if (version == generation) mutable.update {
                    loaded.copy(session = it.session, loading = false,
                        window = it.session?.transcript?.let { tail -> loaded.window.live(tail, following) } ?: loaded.window)
                }
                save()
            } catch (cancel: CancellationException) { throw cancel }
            catch (error: Exception) {
                if (version == generation) mutable.update { it.copy(loading = false, error = directoryError(error)) }
            }
        }
    }
    private suspend fun withdraw(session: SessionState?) {
        generation++; pageJob?.cancel(); saveJob?.cancel()
        mutable.value = ReadingState(session = session, ready = true, denied = true)
        bookmark = ReadingBookmark()
        // Finishing a denial must survive removal of the row/route that initiated the request.
        withContext(NonCancellable) { access = cache.revoke() }
    }
    private suspend fun <T> read(recordScoped: Boolean = false, load: suspend () -> T): T {
        try { return load() }
        catch (error: ApiError) {
            var denial: ApiError? = error.takeIf { it.status == 403 || it.status == 404 && !recordScoped }
            if (recordScoped && error.status == 404) {
                // around/full can fail for one missing record in an otherwise accessible session.
                try { auth.request(handle, ApiRequest(listOf("sessions", id))) }
                catch (check: ApiError) { if (check.status in setOf(403, 404)) denial = check else throw check }
            }
            denial?.let {
                store.reportReadDenial(handle, id, it)
                withdraw(store.state.value.session?.takeIf { s -> s.id == id && s.accessDenied })
            }
            throw error
        }
    }
    override fun close() { generation++; owner.cancel(); scope.launch { save() } }
    companion object { private const val CACHE_LIMIT = 1024 * 1024 }
}
