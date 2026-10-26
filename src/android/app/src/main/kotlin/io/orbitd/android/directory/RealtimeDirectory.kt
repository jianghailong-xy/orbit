package io.orbitd.android.directory

import androidx.compose.runtime.*
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.ConnectionState
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.JsonObject
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import io.orbitd.android.core.realtime.RealtimeState

/** A04 owns disk/SSE/REST recovery. A05 only projects the current handle's complete snapshot. */
@Composable
fun rememberDirectoryData(app: OrbitApplication, handle: SessionHandle): State<DirectoryData> {
    // A streaming delta cannot change the directory. Avoid decoding every session on each one.
    val live by remember(app) { app.realtime.state.map { it.copy(session = null) }.distinctUntilChanged() }
        .collectAsState(RealtimeState())
    val trashing by app.trashing.ids.collectAsState()
    return remember(live, handle, trashing) { mutableStateOf(if (live.handle !== handle) DirectoryData() else directoryData(live, trashing)) }
}

/** One row that does not decode makes the whole directory unreadable. A session on its way to Trash ([trashing], keyed as
 * [TrashingSessions.key]) is in none of the views, whichever read the snapshot came from (A05-9). */
internal fun directoryData(live: RealtimeState, trashing: Set<String> = emptySet()): DirectoryData {
    val snapshot = live.directory
    fun <T> decode(rows: List<JsonObject>, serializer: DeserializationStrategy<T>) = rows.map { Wire.json.decodeFromJsonElement(serializer, it) }
    return try {
        DirectoryData(workspaces = decode(snapshot?.workspaces.orEmpty(), DirectoryWorkspace.serializer()),
            runners = decode(snapshot?.runners.orEmpty(), DirectoryRunner.serializer()),
            sessions = snapshot?.sessions.orEmpty().mapValues { TrashingSessions.without(decode(it.value, DirectorySession.serializer()), trashing) { s -> s.id } },
            folders = decode(snapshot?.folders.orEmpty(), Folder.serializer()), tags = decode(snapshot?.tags.orEmpty(), Tag.serializer()),
            waitingForConnection = snapshot == null && !live.directoryRefreshing && live.controlConnection == ConnectionState.STOPPED && live.directoryError == null,
            ready = snapshot != null, fresh = live.directoryFresh, refreshing = live.directoryRefreshing, cached = live.directoryCached,
            error = live.directoryError?.let { when (it.httpStatus) {
                403 -> "You don't have permission to load this directory."
                401 -> "Your access changed. Please sign in again."
                else -> "Can't reach Orbit. Showing the last available directory."
            } })
    } catch (_: Exception) { DirectoryData(error = "Orbit returned an unreadable directory. Please retry.") }
}
