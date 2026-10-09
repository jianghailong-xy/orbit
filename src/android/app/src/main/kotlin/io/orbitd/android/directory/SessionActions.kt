package io.orbitd.android.directory

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.projects.failureReason
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastGlyph
import io.orbitd.android.toast.ToastTone
import io.orbitd.android.toast.toastTitle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * A session's row actions and the toast each one leaves (iOS `AppModel.completeSession`, `moveSessionToOpen`,
 * `deleteSession`, `renameSession`, `moveSession`; A05-4): the request, then a toast naming the session — "Session
 * completed" or "Moved to Trash" with Undo, "Moved to Open", where a folder move went — or a pinned "Couldn't …" with
 * the server's words. Shared by the list's row menu, the session page's menu and a toast's Undo. [scope] outlives the
 * menu that asked; [changed] re-reads the lists once a write went through.
 */
internal class SessionActions(private val api: DirectoryApi, private val scope: CoroutineScope, private val changed: () -> Unit) {
    fun complete(id: String, title: String?) = act(id, title, "Couldn't complete the session") {
        api.complete(id)
        OrbitToasts.show("Session completed", toastTitle(title), id, canUndo = true)
    }

    /** Also every Undo: the server's `restore` clears both completion and trash. */
    fun restore(id: String, title: String?) = act(id, title, "Couldn't move to Open") {
        api.restore(id)
        OrbitToasts.show("Moved to Open", toastTitle(title), id, tone = ToastTone.INFO)
    }

    fun trash(id: String, title: String?) = act(id, title, "Couldn't move to Trash") {
        api.delete(id, false)
        OrbitToasts.show("Moved to Trash", toastTitle(title), id, tone = ToastTone.NEUTRAL, glyph = ToastGlyph.TRASH, canUndo = true)
    }

    /** No toast once it is renamed: the new name on the row and the page says so. */
    fun rename(id: String, title: String?, name: String) = act(id, title, "Couldn't rename the session") { api.rename(id, name) }

    /** Filed in [folder] of its workspace, or in none: where it went — or, filed in none, the folder it left. */
    fun file(id: String, title: String?, folder: MoveFolder?, from: MoveFolder?) = scope.launch {
        try {
            api.move(id, null, folder?.id)
            OrbitToasts.show(when {
                folder != null -> "Moved to “${folder.name}”"
                from != null -> "Moved out of “${from.name}”"
                else -> "Moved out of its folder"
            }, toastTitle(title), id, tone = ToastTone.INFO, glyph = ToastGlyph.FOLDER)
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) {
            OrbitToasts.show("Couldn't move the session", toastTitle(title), id, failureReason(failure), ToastTone.ERROR)
        }
        changed()
    }

    private fun act(id: String, title: String?, failed: String, write: suspend () -> Unit) = scope.launch {
        try { write() }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { OrbitToasts.show(failed, toastTitle(title), id, toastDetail(failure), ToastTone.ERROR) }
        changed()
    }

    companion object {
        /** The server's own words for a failure's diagnostic line, as web shows `e.message`; none when it sent none
         * (iOS `AppModel.toastDetail`). */
        fun toastDetail(failure: Throwable): String? {
            val error = failure as? ApiError ?: return null
            if (error.status == 401) return "Session expired — sign in again."
            return error.messages.joinToString("\n").ifEmpty { null }
                ?: ((error.body as? JsonObject)?.get("error") as? JsonPrimitive)?.contentOrNull?.ifEmpty { null }
        }
    }
}
