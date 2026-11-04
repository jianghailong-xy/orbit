package io.orbitd.android.directory

import androidx.compose.runtime.*
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.core.realtime.DirectorySnapshot
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.JsonObject
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import io.orbitd.android.core.realtime.RealtimeState

/** A04 owns disk/SSE/REST recovery. A05 only projects the current handle's complete snapshot. Every row is decoded on the main thread, so
 * once per list: a connection's steps at a launch change none of them. */
@Composable
fun rememberDirectoryData(app: OrbitApplication, handle: SessionHandle): State<DirectoryData> {
    // Starting from what the store holds now: a first composition with nothing would flash the states of having no rows.
    val live by remember(app) { app.realtime.state.map { it.directoryFields() }.distinctUntilChanged() }
        .collectAsState(remember(app) { app.realtime.state.value.directoryFields() })
    val trashing by app.trashing.ids.collectAsState()
    val rows = remember(live.directory, trashing) { directoryRows(live.directory, trashing) }
    return remember(live, handle, rows) { mutableStateOf(if (live.handle !== handle) DirectoryData() else directoryState(live, rows)) }
}

/** The state without what never changes the directory: a streaming delta, and an account event until the read behind it lands. */
internal fun RealtimeState.directoryFields() = copy(session = null, invalidationRevision = 0, accountEvents = emptyMap())

internal fun directoryData(live: RealtimeState, trashing: Set<String> = emptySet()) = directoryState(live, directoryRows(live.directory, trashing))

/** One row that does not decode makes the whole directory unreadable. A session on its way to Trash ([trashing], keyed as
 * [TrashingSessions.key]) is in none of the views, whichever read the snapshot came from (A05-9). */
private fun directoryRows(snapshot: DirectorySnapshot?, trashing: Set<String>): DirectoryData {
    fun <T> decode(rows: List<JsonObject>, serializer: DeserializationStrategy<T>) = rows.map { Wire.json.decodeFromJsonElement(serializer, it) }
    return try {
        DirectoryData(workspaces = decode(snapshot?.workspaces.orEmpty(), DirectoryWorkspace.serializer()),
            runners = decode(snapshot?.runners.orEmpty(), DirectoryRunner.serializer()),
            sessions = snapshot?.sessions.orEmpty().mapValues { TrashingSessions.without(decode(it.value, DirectorySession.serializer()), trashing) { s -> s.id } },
            folders = decode(snapshot?.folders.orEmpty(), Folder.serializer()), tags = decode(snapshot?.tags.orEmpty(), Tag.serializer()),
            ready = snapshot != null, runnerRows = snapshot?.runners.orEmpty(), workspaceRows = snapshot?.workspaces.orEmpty())
    } catch (_: Exception) { DirectoryData(error = "Orbit returned an unreadable directory. Please retry.") }
}

/** [rows] with where the read and the connection stand. */
private fun directoryState(live: RealtimeState, rows: DirectoryData): DirectoryData = if (rows.error != null) rows else rows.copy(
    waitingForConnection = live.directory == null && live.directoryRestored && !live.directoryRefreshing && live.controlConnection == ConnectionState.STOPPED && live.directoryError == null,
    offline = live.directoryRestored && live.controlConnection == ConnectionState.STOPPED,
    fresh = live.directoryFresh, refreshing = live.directoryRefreshing, cached = live.directoryCached,
    // iOS `AgentsModel.friendly`.
    error = live.directoryError?.let { if (it.httpStatus == 401) SessionListCopy.SESSION_EXPIRED else SessionListCopy.REQUEST_FAILED })
