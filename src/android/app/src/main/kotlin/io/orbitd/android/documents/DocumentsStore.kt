package io.orbitd.android.documents

import android.graphics.Bitmap
import android.util.LruCache
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.documents.DocumentsApi
import io.orbitd.android.core.documents.DocumentsLogic
import io.orbitd.android.core.documents.DocumentsShareLink
import io.orbitd.android.core.documents.DocumentsSync
import io.orbitd.android.core.documents.DocumentsUploadQueue
import io.orbitd.android.core.documents.DocumentsWriter
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * What the Documents pages share for one signed-in account, kept for the process (the uploads outlive the page): whether the drawer
 * has the row, the sessions' titles that name a writer, each subfolder's count, the files' share links, the agents' syncs and the
 * owner's upload queue. The page's own folder, Trash and Storage reads are the pages' own.
 */
class DocumentsStore private constructor(val app: OrbitApplication, val handle: SessionHandle, private val scope: CoroutineScope) {
    val api = DocumentsApi(app.session, handle)
    val uploads: DocumentsUploadQueue get() = DocumentsUploads.queue(app, handle)

    /** The capabilities read: null until it has finished; then whether the drawer shows Documents. */
    var shown by mutableStateOf<Boolean?>(null)
        private set

    /** Sessions' titles by canonical id, for "Agent in <session>"; "" while reading or unreadable. */
    val titles = mutableStateMapOf<String, String>()
    /** Each subfolder's count of entries, read after its folder (the board's "14 items"). */
    val counts = mutableStateMapOf<String, Int>()
    /** The drive files' open links. */
    val links = mutableStateListOf<DocumentsShareLink>()
    /** The agents' syncs, minus those whose finished rows were cleared here. */
    val syncs = mutableStateListOf<DocumentsSync>()
    val syncRates = mutableStateMapOf<String, Double>()
    private val cleared = mutableSetOf<String>()
    /** Set by the upload notification's Show: the next Documents page opens its uploads sheet. */
    var showUploads by mutableStateOf(false)
    /** Bumped after every write a page made, so every page showing re-reads. */
    var revision by mutableStateOf(0)
        private set

    val thumbnails = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    fun changed() { revision++ }

    /** `GET /auth/capabilities`, once per sign-in: a server from before the switch, or a failed read, counts as on. */
    fun loadCapability() {
        if (shown != null) return
        scope.launch {
            shown = try { DocumentsLogic.shown(read = true, enabled = api.documentsEnabled()) }
            catch (e: ApiError) { DocumentsLogic.shown(read = true, enabled = null, failed = true) }
            catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; true }
        }
    }

    /** The writer's name: "You", "Agent in <session>", "An agent on Orbit Cloud"; reads the session's title once. */
    fun writerName(writer: DocumentsWriter): String {
        val session = DocumentsLogic.writerSession(writer)
        val key = session?.let { ObjectId.canonical(it) ?: it }
        if (key != null && key !in titles) {
            titles[key] = ""
            scope.launch { api.sessionTitle(session)?.let { titles[key] = it } }
        }
        return DocumentsLogic.writerText(writer, key?.let { titles[it] }?.takeIf { it.isNotEmpty() })
    }

    fun readCounts(folders: List<String>) {
        val missing = folders.filter { it !in counts }.take(60)
        if (missing.isEmpty()) return
        scope.launch { missing.forEach { id -> runCatching { api.folder(id) }.getOrNull()?.let { counts[id] = it.entries.size } } }
    }

    fun loadLinks() {
        scope.launch { runCatching { api.shareLinks() }.getOrNull()?.let { links.clear(); links.addAll(it) } }
    }

    fun linkOf(entryId: String): DocumentsShareLink? = links.firstOrNull { ObjectId.same(it.root.id, entryId) && it.state == "ACTIVE" }

    /** Read the agents' syncs again; called every few seconds while a Documents page is up. */
    suspend fun readSyncs() {
        val read = runCatching { api.syncs() }.getOrNull() ?: return
        val before = syncs.associateBy { it.id }
        read.forEach { now -> DocumentsLogic.syncRate(before[now.id], syncRates[now.id], now)?.let { syncRates[now.id] = it } ?: syncRates.remove(now.id) }
        val shownNow = read.filterNot { it.id in cleared && !it.running }
        if (shownNow != syncs.toList()) { syncs.clear(); syncs.addAll(shownNow) }
    }

    /** Clear finished: the owner's finished uploads and the ended syncs' rows. */
    fun clearFinished() {
        uploads.clearFinished()
        cleared += syncs.filterNot { it.running }.map { it.id }
        syncs.removeAll { !it.running }
    }

    /** What a refusal says, in the server's words where it gave some. */
    fun failure(what: String, error: Throwable): String = when (error) {
        is ApiError -> error.messages.firstOrNull()?.takeIf { it.isNotBlank() } ?: "${DocumentsLogic.failedTo(what)} (error ${error.status})."
        is ProtocolException -> "${DocumentsLogic.failedTo(what)}: this version of the app couldn't read Orbit's answer."
        else -> "${DocumentsLogic.failedTo(what)}: couldn't reach Orbit."
    }

    companion object {
        private var stores = mutableMapOf<SessionHandle, DocumentsStore>()
        fun of(app: OrbitApplication, handle: SessionHandle): DocumentsStore = synchronized(this) {
            stores.keys.filter { it !== handle }.forEach { stores.remove(it) }
            stores.getOrPut(handle) { DocumentsStore(app, handle, app.processScope) }
        }
    }
}
