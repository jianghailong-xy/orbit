package io.orbitd.android.composer

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.realtime.*
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.directoryError
import io.orbitd.android.navigation.*
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

@Composable
fun NewSessionComposer(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, data: DirectoryData, open: (OrbitRoute) -> Unit) {
    val workspace = route.workspaceId ?: return
    val target = remember(workspace, route.folderId) { DraftTarget(workspace, route.folderId) }
    val model = remember(handle, target) { app.composer(handle, target.key, target) }
    val state by model.state.collectAsState()
    var detail by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    LaunchedEffect(handle, target, data.fresh, retry) {
        detail = null
        if (!data.fresh) return@LaunchedEffect
        try { detail = ComposerApi(app.session, handle, target.key, target).detail(); error = null }
        catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { error = directoryError(e) }
    }
    LaunchedEffect(state.draft.createdSessionId) {
        state.draft.createdSessionId?.let { id ->
            open(OrbitRoute(Destination.SESSION, id, workspaceId = workspace, origin = route.origin))
            model.consumeCreated()
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
      val composerHeight = if (maxHeight < 320.dp) maxHeight else maxHeight * 0.65f
      Column(Modifier.fillMaxSize()) {
        Text(data.workspaces.firstOrNull { ObjectId.same(it.id, workspace) }?.name ?: "New session", Modifier.padding(16.dp), style = MaterialTheme.typography.titleMedium)
        route.folderId?.let { id -> Text(data.folders.firstOrNull { ObjectId.same(it.id, id) }?.name ?: "Folder", Modifier.padding(horizontal = 16.dp)) }
        error?.let { Text(it); TextButton(onClick = { retry++ }) { Text("Retry workspace") } }
        Spacer(Modifier.weight(1f))
        val current = detail
        val fresh = data.fresh && current != null && current.flag("enabled") != false
        val session = current?.let { SessionState(target.key, snapshot = SessionSnapshot(it, emptyList(), emptyList(), emptyList(), emptyMap()), fresh = fresh) }
        Box(Modifier.heightIn(max = composerHeight)) { SessionComposer(app, handle, target.key, session, target) }
      }
    }
}
