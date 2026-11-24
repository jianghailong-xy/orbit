package io.orbitd.android.core.drive

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.Wire
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

// Resumable uploads into Drive (docs/drive-technical-design.md §4.1, D3, D12; board 04-android frames 6, 7 and 13).
// Each file is opened with `POST /drive/uploads`, sent as chunks of at most the size the server answers (8 MiB) and completed.
// What has arrived is asked of the server, never assumed, so an upload goes on from where it stopped: after a lost connection on
// its own, and after the app was closed, from the file the phone still grants it. The twin of OrbitKit's DriveUploads.swift.

/** Where an upload stands. */
@Serializable
enum class DriveUploadState { QUEUED, UPLOADING, PAUSED, FAILED, DONE }

/** One file going up, and what is kept of it across a restart of the app. */
@Serializable
data class DriveUploadItem(
    val id: String,
    val name: String,
    val size: Long,
    /** The file's modification time when it was picked (0 where the provider says none): a file changed since is not resumed into
     * the same upload. */
    val modifiedAt: Long = 0,
    /** Where the bytes are read from: a `content://` address the phone granted, or a path in a test. */
    val source: String,
    /** The folder it was put in (null for the drive's root), and that folder's name for the sheet and the notification. */
    val parentId: String? = null,
    val parentName: String = DriveLogic.TITLE,
    /** A file of a picked folder: `Dir/sub/name`. */
    val relativePath: String? = null,
    /** The pick it came in, so every file of a picked folder lands under one top folder. */
    val dropKey: String? = null,
    val uploadId: String? = null,
    val sentBytes: Long = 0,
    val state: DriveUploadState = DriveUploadState.QUEUED,
    /** Why it stopped, in the server's words or [DriveUploadQueue.CONNECTION_LOST]. */
    val error: String? = null,
    /** Bytes a second over this run, while uploading. */
    @Transient val rate: Double? = null,
    val entryId: String? = null,
) {
    /** 0…100, for the row's bar. */
    val percent: Int get() = if (size == 0L) 100 else minOf(100L, sentBytes * 100 / size).toInt()
    /** Whether the row can be paused (it is going or waiting to). */
    val pausable: Boolean get() = state == DriveUploadState.UPLOADING || state == DriveUploadState.QUEUED
    val resumable: Boolean get() = state == DriveUploadState.PAUSED || state == DriveUploadState.FAILED
}

/** One file to send: a file picked, with where it goes. A picked folder is one request per file under it, each with its path inside
 * the folder and one [dropKey] (`drop-<uuid>`), so the whole folder lands under one top folder. */
data class DriveUploadRequest(
    val source: String,
    val name: String,
    val size: Long,
    val modifiedAt: Long = 0,
    val parentId: String?,
    val parentName: String,
    val relativePath: String? = null,
    val dropKey: String? = null,
) {
    companion object {
        fun dropKey() = "drop-${UUID.randomUUID()}"
    }
}

/** Where the bytes come from: the phone's content resolver in the app, files in a test. */
interface DriveFileSource {
    /** The file's size and modification time now, or null when it can no longer be read. */
    fun stat(source: String): Pair<Long, Long>?
    /** [length] bytes from [offset]; fewer means the file changed. */
    fun read(source: String, offset: Long, length: Int): ByteArray
}

/** Where the queue keeps its uploads across a restart. */
interface DriveUploadStore {
    fun load(): String?
    fun save(json: String)
}

@Serializable
private data class Kept(val uploads: List<DriveUploadItem> = emptyList(), val drops: Map<String, String> = emptyMap())

/** Which chunks a file still needs, given the chunks the server already has. */
object DriveChunkPlan {
    data class Chunk(val index: Int, val offset: Long, val length: Int)

    /** Every chunk of a file of [size] bytes cut at [chunkSize]; an empty file has none. */
    fun chunks(size: Long, chunkSize: Int): List<Chunk> {
        if (size <= 0 || chunkSize <= 0) return emptyList()
        val count = ((size + chunkSize - 1) / chunkSize).toInt()
        return (0 until count).map { idx ->
            val offset = idx.toLong() * chunkSize
            Chunk(idx, offset, minOf(chunkSize.toLong(), size - offset).toInt())
        }
    }

    /** The chunks still to send: those the server lacks, or holds at another size (a chunk sent again replaces). */
    fun missing(size: Long, chunkSize: Int, arrived: Map<Int, Long>): List<Chunk> =
        chunks(size, chunkSize).filter { arrived[it.index] != it.length.toLong() }

    /** The bytes the server already holds of the file. */
    fun arrivedBytes(size: Long, chunkSize: Int, arrived: Map<Int, Long>): Long =
        chunks(size, chunkSize).filter { arrived[it.index] == it.length.toLong() }.sumOf { it.length.toLong() }
}

/**
 * The owner's uploads, one file at a time, in the order they were added. Lives as long as the app's process, not the page: leaving
 * Drive does not stop it, and the background work (the app's upload worker) drives it with the app closed.
 */
class DriveUploadQueue(
    private val transport: DriveUploadTransport,
    private val store: DriveUploadStore? = null,
    private val files: DriveFileSource,
    private val scope: CoroutineScope,
    private val retryDelayMillis: Long = 1_000,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutable = MutableStateFlow<List<DriveUploadItem>>(emptyList())
    val items: StateFlow<List<DriveUploadItem>> = mutable.asStateFlow()
    private val completions = MutableStateFlow(0)
    /** How many uploads completed since the process started: what the page re-reads its folder on. */
    val completedCount: StateFlow<Int> = completions.asStateFlow()
    /** Called when an upload completes, with the file it made. */
    var onCompleted: ((DriveUploadItem) -> Unit)? = null

    private val lock = Any()
    private var drops: Map<String, String> = emptyMap()
    private var running: Pair<String, Job>? = null

    init {
        store?.load()?.let { raw -> runCatching { Wire.json.decodeFromString(Kept.serializer(), raw) }.getOrNull() }?.let { kept ->
            drops = kept.drops
            // A restart: what was going on goes on, from the parts already sent, if its file is still there.
            mutable.value = kept.uploads.filter { it.state != DriveUploadState.DONE }.map {
                if (it.state == DriveUploadState.UPLOADING) it.copy(state = DriveUploadState.QUEUED) else it
            }
        }
    }

    /** Whether anything is going up or waiting its turn. */
    val busy: Boolean get() = synchronized(lock) { running != null } || mutable.value.any { it.state == DriveUploadState.QUEUED }

    /** Start what a restart left. */
    fun start() = pump()

    /** Queue files. A file already waiting (same source, size and time, same place) is not added twice. */
    fun add(requests: List<DriveUploadRequest>) {
        mutable.update { items ->
            requests.fold(items) { acc, r ->
                if (acc.any { it.state != DriveUploadState.DONE && it.source == r.source && it.size == r.size && it.modifiedAt == r.modifiedAt &&
                        it.parentId == r.parentId && it.relativePath == r.relativePath }) acc
                else acc + DriveUploadItem(id = UUID.randomUUID().toString(), name = r.name, size = r.size, modifiedAt = r.modifiedAt,
                    source = r.source, parentId = r.parentId, parentName = r.parentName, relativePath = r.relativePath, dropKey = r.dropKey)
            }
        }
        changed()
        pump()
    }

    fun pause(id: String) {
        val job = synchronized(lock) { running?.takeIf { it.first == id }?.second }
        patch(id) { it.copy(state = DriveUploadState.PAUSED, rate = null, error = null) }
        job?.cancel()
    }

    /** Pause everything going up or waiting: the notification's Pause. */
    fun pauseAll() = mutable.value.filter { it.pausable }.forEach { pause(it.id) }

    fun resume(id: String) {
        val item = find(id) ?: return
        if (!item.resumable) return
        patch(id) { it.copy(state = DriveUploadState.QUEUED, error = null) }
        pump()
    }

    /** Stop and forget an upload; the server drops what it had. */
    fun cancel(id: String) {
        val item = find(id) ?: return
        val job = synchronized(lock) { running?.takeIf { it.first == id }?.second }
        mutable.update { items -> items.filterNot { it.id == id } }
        changed()
        job?.cancel()
        item.uploadId?.let { upload -> scope.launch { runCatching { transport.abandonUpload(upload) } } }
    }

    /** Clear the finished rows. */
    fun clearFinished() {
        mutable.update { items -> items.filterNot { it.state == DriveUploadState.DONE } }
        changed()
    }

    /** A connection that came back: what a lost connection paused goes on. */
    fun resumeInterrupted(): Boolean {
        var woke = false
        mutable.update { items ->
            items.map {
                if (it.state == DriveUploadState.PAUSED && it.error == CONNECTION_LOST) { woke = true; it.copy(state = DriveUploadState.QUEUED, error = null) }
                else it
            }
        }
        if (woke) { changed(); pump() }
        return woke
    }

    /** Wait until nothing is uploading or waiting. */
    suspend fun idle() {
        while (true) {
            val job = synchronized(lock) { running?.second }
            if (job != null) { job.join(); continue }
            if (mutable.value.none { it.state == DriveUploadState.QUEUED }) return
            pump()
            delay(10)
        }
    }

    // ---- the run

    private fun find(id: String) = mutable.value.firstOrNull { it.id == id }

    private fun patch(id: String, quiet: Boolean = false, change: (DriveUploadItem) -> DriveUploadItem) {
        mutable.update { items -> items.map { if (it.id == id) change(it) else it } }
        if (!quiet) changed()
    }

    private fun changed() {
        val items = mutable.value
        val live = items.filter { it.state != DriveUploadState.DONE }
        synchronized(lock) {
            val keys = live.mapNotNull { it.dropKey }.toSet()
            drops = drops.filterKeys { it in keys }
        }
        store?.save(Wire.json.encodeToString(Kept.serializer(), Kept(live, synchronized(lock) { drops })))
    }

    private fun pump() {
        synchronized(lock) {
            if (running != null) return
            val next = mutable.value.firstOrNull { it.state == DriveUploadState.QUEUED } ?: return
            val id = next.id
            val job = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
                try { send(id) } finally {
                    synchronized(lock) { if (running?.first == id) running = null }
                    pump()
                }
            }
            running = id to job
            job.start()
        }
    }

    private class Stopped : Exception()
    private class Refused(override val message: String) : Exception(message)

    private suspend fun send(id: String) {
        if (find(id)?.state != DriveUploadState.QUEUED) return
        patch(id) { it.copy(state = DriveUploadState.UPLOADING, error = null) }
        try {
            val entry = sendOnce(id)
            if (find(id) == null) return
            patch(id) { it.copy(state = DriveUploadState.DONE, entryId = entry, sentBytes = it.size, rate = null) }
            completions.update { it + 1 }
            find(id)?.let { onCompleted?.invoke(it) }
        } catch (e: CancellationException) {
            // Paused or cancelled: whoever stopped it has said where it stands.
        } catch (e: Stopped) {
        } catch (e: Exception) {
            if (find(id) == null || find(id)?.state != DriveUploadState.UPLOADING) return
            if (transient(e)) patch(id) { it.copy(state = DriveUploadState.PAUSED, rate = null, error = CONNECTION_LOST) }
            else {
                val message = (e as? Refused)?.message ?: (e as? ApiError)?.messages?.firstOrNull()?.takeIf { it.isNotBlank() }
                    ?: (e as? ApiError)?.let { "Orbit refused the upload (error ${it.status})." } ?: "Couldn't upload."
                patch(id) { it.copy(state = DriveUploadState.FAILED, rate = null, error = message) }
            }
        }
    }

    private suspend fun sendOnce(id: String): String {
        val item = find(id) ?: throw Stopped()
        val now = withContext(io) { files.stat(item.source) } ?: throw Refused("${item.name} is no longer where it was picked from.")
        if (now.first != item.size || (item.modifiedAt != 0L && now.second != 0L && now.second != item.modifiedAt))
            throw Refused("${item.name} changed since it was picked. Upload it again.")

        var chunkSize = 8 * 1024 * 1024
        var arrived = emptyMap<Int, Long>()
        item.uploadId?.let { uploadId ->
            try {
                val status = transport.uploadStatus(uploadId)
                if (status.completed && status.entryId != null) return status.entryId
                chunkSize = status.chunkSize
                arrived = status.chunks.associate { it.idx to it.sizeBytes }
            } catch (e: ApiError) {
                // Gone (abandoned, or swept after a long while): start it again.
                if (e.status != 404) throw e
                patch(id) { it.copy(uploadId = null) }
            }
        }
        check(id)
        if (find(id)?.uploadId == null) {
            val dropRoot = item.dropKey?.let { synchronized(lock) { drops[it] } }
            val opened = transport.openUpload(item.parentId, item.name, item.size, item.relativePath, dropRoot)
            val key = item.dropKey
            if (key != null && opened.dropRootId != null) synchronized(lock) { if (drops[key] == null) drops = drops + (key to opened.dropRootId) }
            chunkSize = opened.chunkSize
            arrived = emptyMap()
            patch(id) { it.copy(uploadId = opened.id) }
        }
        val uploadId = find(id)?.uploadId ?: throw Stopped()

        var sent = DriveChunkPlan.arrivedBytes(item.size, chunkSize, arrived)
        patch(id, quiet = true) { it.copy(sentBytes = sent) }
        val started = clock()
        var sentThisRun = 0L
        for (chunk in DriveChunkPlan.missing(item.size, chunkSize, arrived)) {
            check(id)
            val bytes = withContext(io) { files.read(item.source, chunk.offset, chunk.length) }
            if (bytes.size != chunk.length) throw Refused("${item.name} changed since it was picked. Upload it again.")
            val sha = sha256(bytes)
            var attempt = 0
            while (true) {
                check(id)
                try {
                    transport.putChunk(uploadId, chunk.index, bytes, sha)
                    break
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (!transient(e) || attempt >= RETRIES) throw e
                    val wait = retryDelayMillis * (1L shl attempt)
                    attempt++
                    if (wait > 0) delay(wait)
                }
            }
            sent += chunk.length
            sentThisRun += chunk.length
            val seconds = (clock() - started) / 1000.0
            val total = sent
            patch(id) { it.copy(sentBytes = total, rate = if (seconds > 0) sentThisRun / seconds else null) }
        }
        check(id)
        return transport.completeUpload(uploadId).id
    }

    /** Stop here if the upload was paused or cancelled meanwhile. */
    private suspend fun check(id: String) {
        kotlin.coroutines.coroutineContext.ensureActive()
        if (find(id)?.state != DriveUploadState.UPLOADING) throw Stopped()
    }

    companion object {
        /** A chunk that fails for want of a connection is tried this many more times, waiting longer each time, before the upload
         * pauses itself. */
        const val RETRIES = 3
        const val CONNECTION_LOST = "Connection lost."

        /** Whether a failure is the network's (try again) rather than the server's answer (stop and say it). */
        fun transient(error: Throwable): Boolean = error is NetworkException || error is java.io.IOException ||
            (error is ApiError && error.status >= 500)

        /** SHA-256 of a chunk as lowercase hex. */
        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
