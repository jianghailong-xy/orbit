package io.orbitd.android.composer

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
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
    // Held outside the workspace's read, which a directory refresh briefly clears: the engine list stays open across one.
    var choosingEngine by remember(target) { mutableStateOf(false) }
    // Where an engine or a credential that can't run here is fixed: the runner's page for that engine.
    val openRunner = { runner: String, engine: String -> open(OrbitRoute(Destination.RUNNER, runner, recordId = "engine:$engine")) }
    LaunchedEffect(handle, target, data.fresh, retry) {
        detail = null
        if (!data.fresh) return@LaunchedEffect
        try { detail = ComposerApi(app.session, handle, target.key, target).detail(); error = null }
        catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { error = directoryError(e) }
    }
    LaunchedEffect(state.draft.createdSessionId, state.acknowledgementPending) {
        state.draft.createdSessionId?.takeUnless { state.acknowledgementPending }?.let { id ->
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
        // First the engine — the CLI this session runs on for good — then, in the composer's model menu, the credential it spends.
        detail?.let { workspace ->
            val effective = JsonObject(workspace + state.draft.resumeConfig)
            val engine = state.catalog?.engineOf(effective)
                ?: ProviderEngines.sessionEngine(effective.text("engine") ?: effective.text("lastEngine"), effective.text("provider"), emptyList())
            Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(EngineCopy.ENGINE, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(enabled = state.loaded && !state.busy && state.draft.pending == null && state.draft.createdSessionId == null,
                    onClick = { choosingEngine = true; model.loadCatalog() }, modifier = Modifier.testTag("new-session-engine")) {
                    Text("${ProviderEngines.cliName(engine)} ⌄", style = MaterialTheme.typography.titleMedium)
                }
            }
            if (choosingEngine) EngineChoices(model, state, effective, handle.account.server, openRunner) { choosingEngine = false }
        }
        Spacer(Modifier.weight(1f))
        val current = detail
        val fresh = data.fresh && current != null && current.flag("enabled") != false
        val session = current?.let { SessionState(target.key, snapshot = SessionSnapshot(it, emptyList(), emptyList(), emptyList(), emptyMap()), fresh = fresh) }
        Box(Modifier.heightIn(max = composerHeight)) { SessionComposer(app, handle, target.key, session, target, openRunner = openRunner) }
      }
    }
}
