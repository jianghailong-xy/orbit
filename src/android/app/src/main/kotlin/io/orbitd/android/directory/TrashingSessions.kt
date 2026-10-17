package io.orbitd.android.directory

import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The sessions this device is moving to Trash (iOS `AppModel.trashingSessions`, 62b7009ca; A05-9). Move to Trash takes the row out of
 * every list on the tap, not once the server has answered and the lists were read again, and keeps it out of every read that lands
 * meanwhile — one that left before the server had the move would put the row back for a beat. The directory leaves these out where
 * it decodes its snapshot ([directoryData]), which the workspace and folder lists, their counts, the drawer and the project rows all
 * draw from; the project sessions page leaves them out of its own member reads. A session is let go once the lists have been read
 * again behind its move ([SessionActions.trash]), at once when the server refuses the move, and by an Undo. Main thread only, as the
 * lists it guards are.
 */
internal class TrashingSessions {
    private val held = MutableStateFlow<Set<String>>(emptySet())
    /** The sessions on their way to Trash, each by [key]. */
    val ids: StateFlow<Set<String>> = held.asStateFlow()
    /** How many times a session has been let go: a read that one overlapped may be from before that session's move. */
    var releases = 0L
        private set

    fun hide(id: String) { held.value = held.value + key(id) }

    fun reveal(id: String) {
        val key = key(id)
        if (key !in held.value) return
        held.value = held.value - key
        releases++
    }

    /** [rows] without the sessions on their way to Trash. */
    fun <T> without(rows: List<T>, id: (T) -> String?): List<T> = without(rows, held.value, id)

    companion object {
        /** Either spelling of a session's id, as one. */
        fun key(id: String) = ObjectId.canonical(id) ?: id

        fun <T> without(rows: List<T>, held: Set<String>, id: (T) -> String?): List<T> =
            if (held.isEmpty()) rows else rows.filterNot { row -> id(row)?.let { key(it) in held } == true }
    }
}
