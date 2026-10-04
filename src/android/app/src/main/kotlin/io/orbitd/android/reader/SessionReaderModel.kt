package io.orbitd.android.reader

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.ApiError
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
    val window: ReadingWindow = ReadingWindow())
internal data class ReadingState(val window: ReadingWindow = ReadingWindow(), val session: SessionState? = null,
    val ready: Boolean = false, val loading: Boolean = false, val error: String? = null,
    val targetSeq: Long? = null, val targetOffset: Int = 0, val targetTick: Long = 0,
    val denied: Boolean = false)

/** One route/account lifetime; the application's A04 store continues to own all SSE and authority. */
internal class SessionReaderModel(private val auth: AuthSession, private val handle: SessionHandle,
    private val store: RealtimeStore, val id: String, private val scope: CoroutineScope, record: String?) : AutoCloseable {
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
    private val cacheKey = "reader-${ObjectId.canonical(id) ?: id}"

    init {
        owner.launch {
            val saved = try { auth.readData(handle, DataKind.CACHE, cacheKey)?.takeIf { it.size <= CACHE_LIMIT }
                ?.let { Wire.decode(it, ReadingBookmark.serializer()) } } catch (cancel: CancellationException) { throw cancel }
                catch (_: Exception) { null }
            if (record == null && saved != null && saved.window.events.size <= ReadingWindow.LIMIT) {
                bookmark = saved; following = saved.following
                mutable.value = ReadingState(window = saved.window, ready = true,
                    targetSeq = saved.seq.takeIf { !saved.following }, targetOffset = saved.offset, targetTick = 1)
                if (!saved.following && !saved.window.seeded) restore(saved.seq, saved.offset)
            } else mutable.value = ReadingState(ready = true)
            if (record != null) openRecord(record)
            var previousEvents: List<RunEvent>? = null
            store.state.collect { live ->
                val s = live.session?.takeIf { live.handle === handle && it.id == id } ?: return@collect
                val denied = s.accessDenied
                if (denied) {
                    generation++; pageJob?.cancel(); saveJob?.cancel()
                    mutable.value = ReadingState(session = s, ready = true, denied = true)
                    bookmark = ReadingBookmark()
                    auth.writeData(handle, DataKind.CACHE, cacheKey, ByteArray(0))
                    previousEvents = null
                } else {
                    val old = mutable.value
                    val restoring = !old.window.seeded && old.targetSeq != null
                    val window = if (previousEvents !== s.transcript.events && !old.loading && !restoring) old.window.live(s.transcript, following) else old.window
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
            return bookmark.copy(window = window.copy(events = events, hasOlder = window.hasOlder || from > 0,
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
        try { auth.writeData(handle, DataKind.CACHE, cacheKey, bytes) }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { mutable.update { it.copy(error = "Couldn't save reading position. Keep this session open and retry.") } }
    }
    fun older() {
        val window = mutable.value.window
        if (!window.hasOlder) return
        val before = window.events.firstOrNull()?.seq ?: return
        page { old ->
            val loaded = api.page("before" to "$before")
            old.copy(window = old.window.older(loaded), targetSeq = bookmark.seq.takeIf { it > 0 },
                targetOffset = bookmark.offset, targetTick = old.targetTick + 1)
        }
    }
    fun newer() {
        val after = mutable.value.window.newerAfter ?: return
        page { old ->
            val loaded = api.page("after" to "$after")
            old.copy(window = old.window.newer(loaded), targetSeq = bookmark.seq.takeIf { it > 0 },
                targetOffset = bookmark.offset, targetTick = old.targetTick + 1)
        }
    }
    fun show(seq: Long) { following = false; mutable.update { it.copy(targetSeq = seq, targetOffset = 0, targetTick = it.targetTick + 1) } }
    suspend fun full(seq: Long) = api.full(seq)
    fun openRecord(record: String) {
        following = false
        page(replace = true) { old ->
            try {
                val page = api.page("around" to record)
                val anchor = page.anchor ?: error("Missing anchor")
                old.copy(window = ReadingWindow().seed(page), targetSeq = anchor.seq, targetOffset = 0, targetTick = old.targetTick + 1)
            } catch (error: ApiError) {
                if (error.status == 404) old.copy(error = "That message is not in this session") else throw error
            }
        }
    }
    fun latest() {
        following = true
        page(replace = true) { old -> old.copy(window = ReadingWindow().seed(api.page("tail" to "200")),
            targetSeq = null, targetTick = old.targetTick + 1) }
    }
    private fun restore(seq: Long, offset: Int) {
        page(replace = true) { old ->
            val loaded = api.page("before" to "${seq + 1}")
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
                if (error is ApiError && error.status == 403) store.refreshSession()
            }
        }
    }
    override fun close() { owner.cancel(); scope.launch { save() } }
    companion object { private const val CACHE_LIMIT = 1024 * 1024 }
}
