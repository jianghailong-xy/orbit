package io.orbitd.android.directory

import androidx.compose.runtime.*
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.ConnectionState
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.JsonObject

/** A04 owns disk/SSE/REST recovery. A05 only projects the current handle's complete snapshot. */
@Composable
fun rememberDirectoryData(app: OrbitApplication, handle: SessionHandle): State<DirectoryData> {
    val live by app.realtime.state.collectAsState()
    return remember(live, handle) { mutableStateOf(
        if (live.handle !== handle) DirectoryData() else {
            val snapshot = live.directory
            fun <T> decode(rows: List<JsonObject>, serializer: DeserializationStrategy<T>) = rows.map { Wire.json.decodeFromJsonElement(serializer, it) }
            try {
                DirectoryData(workspaces = decode(snapshot?.workspaces.orEmpty(), DirectoryWorkspace.serializer()),
                    runners = decode(snapshot?.runners.orEmpty(), DirectoryRunner.serializer()),
                    sessions = snapshot?.sessions.orEmpty().mapValues { decode(it.value, DirectorySession.serializer()) },
                    folders = decode(snapshot?.folders.orEmpty(), Folder.serializer()), tags = decode(snapshot?.tags.orEmpty(), Tag.serializer()),
                    waitingForConnection = snapshot == null && !live.directoryRefreshing && live.controlConnection == ConnectionState.STOPPED && live.directoryError == null,
                    ready = snapshot != null, fresh = live.directoryFresh, refreshing = live.directoryRefreshing,
                    error = live.directoryError?.let { when (it.httpStatus) {
                        403 -> "You don't have permission to load this directory."
                        401 -> "Your access changed. Please sign in again."
                        else -> "Can't reach Orbit. Showing the last available directory."
                    } })
            } catch (_: Exception) { DirectoryData(error = "Orbit returned an unreadable directory. Please retry.") }
        }
    ) }
}
