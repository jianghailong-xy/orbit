package io.orbitd.android.composer

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.realtime.*
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.directoryError
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.rememberNow
import io.orbitd.android.management.rememberResumed
import io.orbitd.android.navigation.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
fun NewSessionComposer(
    app: OrbitApplication,
    handle: SessionHandle,
    route: OrbitRoute,
    data: DirectoryData,
    open: (OrbitRoute) -> Unit,
    land: (String, OrbitRoute) -> Unit = { _, next -> open(next) },
    replace: (OrbitRoute) -> Unit = open,
) {
    val workspaceId = route.workspaceId
    if (workspaceId == null) {
        val runnerId = route.id ?: MachineSetup.firstOnlineRunnerId(data.effectiveRunnerRows, managedStatus = LocalManagedRunnerStatus.current) ?: return
        MachineDraftComposer(app, handle, route, runnerId, data, open, land)
        return
    }
    val target = remember(workspaceId, route.folderId) { DraftTarget(workspaceId, route.folderId) }
    val model = remember(handle, target) { app.composer(handle, target.key, target) }
    val state by model.state.collectAsState()
    var detail by remember(target) { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    // Held outside the workspace's read: the engine list stays open across one.
    var choosingEngine by remember(target) { mutableStateOf(false) }
    // Where an engine or a credential that can't run here is fixed: the runner's page for that engine.
    val openRunner = { runner: String, engine: String -> open(OrbitRoute(Destination.RUNNER, runner, recordId = "engine:$engine")) }
    // The page does not wait for the directory's read (iOS). A read of the directory that lands after a reconnect reads the workspace
    // again behind it, in place.
    LaunchedEffect(handle, target, data.fresh, retry) {
        if (detail != null && !data.fresh) return@LaunchedEffect
        try { detail = ComposerApi(app.session, handle, target.key, target).detail(); error = null }
        catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { if (detail == null) error = directoryError(e) }
    }
    LaunchedEffect(state.draft.createdSessionId, state.acknowledgementPending) {
        state.draft.createdSessionId?.takeUnless { state.acknowledgementPending }?.let { id ->
            // The draft's page becomes the session's, as on iOS (`openCreatedAgentSession`): Back leaves for the page under it.
            replace(OrbitRoute(Destination.SESSION, id, workspaceId = workspaceId, origin = route.origin))
            model.consumeCreated()
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val composerHeight = if (maxHeight < 320.dp) maxHeight else maxHeight * 0.65f
        Column(Modifier.fillMaxSize()) {
            // The workspace's name is the bar's title (iOS `WorkspaceTitle`), so the page opens on the hero.
            route.folderId?.let { id -> Text(data.folders.firstOrNull { ObjectId.same(it.id, id) }?.name ?: "Folder", Modifier.padding(horizontal = 16.dp)) }
            error?.let { Text(it); TextButton(onClick = { retry++ }) { Text("Retry workspace") } }
            // First the engine — the CLI this session runs on for good — then, in the composer's model menu, the credential it spends.
            // The engine is the hero, as iOS draws it: the vendor's mark, the engine's name as the one tappable identity, then the line
            // that says what to do and the model it starts on.
            Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 24.dp), contentAlignment = Alignment.Center) {
                detail?.let { workspace ->
                    val effective = JsonObject(workspace + state.draft.resumeConfig)
                    val engine = state.catalog?.engineOf(effective)
                        ?: ProviderEngines.sessionEngine(effective.text("engine") ?: effective.text("lastEngine"), effective.text("provider"), emptyList())
                    val engineName = ProviderEngines.cliName(engine)
                    val modelId = effective.text("model").orEmpty()
                    val modelName = if (modelId.isBlank()) "Runtime default"
                        else state.catalog?.modelLabel(engine, effective.text("provider") ?: engine, modelId)
                            ?: if (engine == ProviderEngines.CLAUDE) ProviderEngines.claudeModelName(modelId) else modelId
                    val choosable = state.loaded && !state.busy && state.draft.pending == null && state.draft.createdSessionId == null
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        ProviderMark(AgentBrand.of(engine), engineName)
                        Spacer(Modifier.height(14.dp))
                        Row(Modifier.clickable(enabled = choosable, role = Role.Button) { choosingEngine = true; model.loadCatalog() }
                            .semantics(mergeDescendants = true) { contentDescription = "Engine: $engineName. Switch" }
                            .testTag("new-session-engine"), verticalAlignment = Alignment.CenterVertically) {
                            Text(engineName, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, maxLines = 1,
                                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            Spacer(Modifier.width(7.dp))
                            Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Spacer(Modifier.height(18.dp))
                        Text("Send a task to get started.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(5.dp))
                        Text(modelName, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f))
                    }
                    if (choosingEngine) EngineChoices(model, state, effective, handle.account.server, openRunner) { choosingEngine = false }
                }
            }
            val current = detail
            val fresh = current != null && current.flag("enabled") != false
            val session = current?.let { SessionState(target.key, snapshot = SessionSnapshot(it, emptyList(), emptyList(), emptyList(), emptyMap()), fresh = fresh) }
            // The managed runner asleep is no fault: sending wakes it, and the composer says so (the shared composer line).
            ManagedRunnerAsleepLine(detail?.text("runnerId"), LocalManagedRunnerStatus.current)
            // The page opens with the box focused and the keyboard up, as iOS's draft does (`focusesComposer`): asked for once the
            // draft is restored, since the box can't take the focus before (it is disabled until then).
            Box(Modifier.heightIn(max = composerHeight)) {
                SessionComposer(app, handle, target.key, session, target, focusRequest = if (state.loaded) 1 else 0, openRunner = openRunner)
            }
        }
    }
}

/**
 * A machine with no workspace (owner 2026-11-16, docs/mocks/new-folder-in-home/workspace-card-with-name): its page is the setup card
 * alone, which makes the workspace with `POST /workspaces`, and then moves on to the new workspace's new session page. Opened as New
 * workspace on a machine that has one ([addsWorkspace]), the same card makes one more.
 */
@Composable
private fun MachineDraftComposer(
    app: OrbitApplication,
    handle: SessionHandle,
    route: OrbitRoute,
    runnerId: String,
    data: DirectoryData,
    open: (OrbitRoute) -> Unit,
    land: (String, OrbitRoute) -> Unit,
) {
    val target = remember(runnerId) { DraftTarget(workspaceId = "", runnerId = runnerId) }
    val api = remember(handle, target) { ComposerApi(app.session, handle, target.key, target) }
    val managementApi = remember(handle) { ManagementApi(app.session, handle, app.processScope) }
    val scope = rememberCoroutineScope()
    val resumed = rememberResumed()
    val nowMs = rememberNow()

    var liveRunner by remember(runnerId) { mutableStateOf<JsonObject?>(null) }
    val directoryRunner = data.effectiveRunnerRows.firstOrNull { ObjectId.same(it.text("id"), runnerId) }
    val runner = liveRunner ?: directoryRunner
    var creating by remember(runnerId) { mutableStateOf(false) }
    var createError by remember(runnerId) { mutableStateOf<String?>(null) }

    LaunchedEffect(api, runnerId, resumed) {
        if (!resumed) return@LaunchedEffect
        runCatching { api.runner(runnerId) }.getOrNull()?.let { liveRunner = it }
        while (true) {
            // More often while it is still connecting: its first heartbeat opens the folder field.
            delay(MachineSetup.refreshMs(liveRunner))
            runCatching { api.runner(runnerId) }.getOrNull()?.let { liveRunner = it }
        }
    }

    val online = runner != null && !RunnerPage.isOffline(runner, nowMs)
    // Opened as New workspace on a machine that has one (docs/mocks/new-workspace-form/02-apple-entry): the page makes one more, so it
    // neither moves on to the first nor greets a new account.
    val addsWorkspace = route.addsWorkspace
    val existingWorkspace = data.workspaces.firstOrNull { ObjectId.same(it.runnerId, runnerId) }
    val bare = data.ready && existingWorkspace == null && !addsWorkspace
    // A new account's first machine: the setup card greets it (docs/mocks/new-user-onboarding).
    val machineWelcome = rememberNewAccount(managementApi, bare) && bare
    val welcomeName = rememberAccountName(managementApi, machineWelcome)

    // The machine has a workspace (made here, or elsewhere meanwhile): on to its new session page.
    LaunchedEffect(existingWorkspace?.id, creating) {
        val ws = existingWorkspace ?: return@LaunchedEffect
        if (creating || addsWorkspace) return@LaunchedEffect
        land(ws.id, OrbitRoute(Destination.DRAFT, workspaceId = ws.id, origin = route.origin))
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        if (runner != null) {
            MachineSetupCard(
                runner = runner,
                managedSetup = ManagedRunner.managedSetupState(runnerId, LocalManagedRunnerStatus.current),
                online = online,
                probeDir = { path, ask -> api.probeDir(runner.text("id") ?: runnerId, path, ask) },
                onCreate = { folder, name ->
                    creating = true
                    createError = null
                    scope.launch {
                        try {
                            val made = api.createWorkspace(MachineSetup.createWorkspaceBody(name, runner.text("id") ?: runnerId, folder))
                            val id = made.text("id") ?: error("The server didn't answer the workspace's id.")
                            app.realtime.refreshDirectory()
                            land(id, OrbitRoute(Destination.DRAFT, workspaceId = id, origin = route.origin))
                        } catch (cancel: CancellationException) {
                            throw cancel
                        } catch (e: Exception) {
                            createError = if (e is ApiError) e.messages.firstOrNull() ?: directoryError(e) else directoryError(e)
                        } finally {
                            creating = false
                        }
                    }
                },
                creating = creating,
                createError = createError,
                onOpenMachine = { open(OrbitRoute(Destination.RUNNER, runner.text("id") ?: runnerId)) },
                welcome = machineWelcome,
                welcomeName = welcomeName,
                github = remember(managementApi) { ManagementGithub(managementApi) },
                onOpenGithubSettings = { open(OrbitRoute(Destination.SETTINGS, "github")) },
                addsWorkspace = addsWorkspace,
            )
        } else if (data.ready) {
            Text("This runner is no longer on your account.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            CircularProgressIndicator()
        }
    }
}
