package io.orbitd.android.composer

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.foundation.shape.CircleShape
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
import io.orbitd.android.directory.DirectoryWorkspace
import io.orbitd.android.directory.Folder
import io.orbitd.android.directory.orderedWorkspaces
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
            // The workspace's name is the bar's title (iOS `WorkspaceTitle`), so the page opens on the hero; its folder is the place
            // pill's to say.
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
                        Spacer(Modifier.height(10.dp))
                        PlacePill(
                            workspaces = orderedWorkspaces(data.workspaces).filter { it.runnerId != null || ObjectId.same(it.id, workspaceId) },
                            workspaceId = workspaceId,
                            workspaceName = data.workspaces.firstOrNull { ObjectId.same(it.id, workspaceId) }?.name ?: workspace.text("name").orEmpty(),
                            folders = data.folders.sortedBy { it.name.lowercase() },
                            folderId = route.folderId,
                            enabled = choosable,
                            // A workspace and a folder of it, or none: the draft that place keeps (`DraftTarget`), with what was typed there.
                            onPick = { id, folder -> replace(route.copy(workspaceId = id, folderId = folder)) },
                        )
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
 * Where the session runs, under the engine (docs/mocks/new-session-place, option A's pill, board 02 option D's menu; web's
 * `PlacePill`): one bordered pill, `[workspace] / [folder] ▾`, naming the folder only when one is picked — a folder is a sidebar
 * group, so none is the quiet default. Its menu lists the workspaces alone, this one first; a workspace with folders opens them in
 * place of the list (the board's phone drill-in, ③), under None and a way back, so a folder of any workspace is one pick.
 */
@Composable
private fun PlacePill(
    workspaces: List<DirectoryWorkspace>,
    workspaceId: String,
    workspaceName: String,
    /** Every workspace's folders. */
    folders: List<Folder>,
    folderId: String?,
    enabled: Boolean,
    onPick: (String, String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    // The workspace whose folders the menu shows in place of the workspaces; null is the workspaces.
    var level by remember { mutableStateOf<String?>(null) }
    val folder = folders.firstOrNull { ObjectId.same(it.workspaceId, workspaceId) && ObjectId.same(it.id, folderId) }
    val label = folder?.let { "$workspaceName / ${it.name}" } ?: workspaceName
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val close = { open = false; level = null }
    val pick = { id: String, f: String? ->
        close()
        if (!ObjectId.same(id, workspaceId) || !ObjectId.same(f, folder?.id)) onPick(id, f)
    }
    val foldersOf = { id: String -> folders.filter { ObjectId.same(it.workspaceId, id) } }
    Box {
        Row(
            Modifier.clip(CircleShape).border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape)
                .clickable(enabled = enabled, role = Role.Button) { open = true }
                .semantics(mergeDescendants = true) { contentDescription = "Runs in: $label" }
                .testTag("new-session-place")
                .heightIn(min = 32.dp).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(R.drawable.ic_terminal), null, Modifier.size(15.dp), tint = muted)
            Spacer(Modifier.width(6.dp))
            Text(workspaceName, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 140.dp))
            folder?.let {
                Text(" / ", style = MaterialTheme.typography.bodyMedium, color = muted.copy(alpha = 0.6f))
                Icon(painterResource(R.drawable.ic_folder), null, Modifier.size(15.dp), tint = muted)
                Spacer(Modifier.width(6.dp))
                Text(it.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 120.dp))
            }
            Spacer(Modifier.width(6.dp))
            Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.size(14.dp), tint = muted)
        }
        DropdownMenu(open, onDismissRequest = close, modifier = Modifier.testTag("new-session-place-menu").widthIn(min = 240.dp)) {
            val shown = level?.let { id -> workspaces.firstOrNull { ObjectId.same(it.id, id) } }
            if (shown == null) {
                (listOfNotNull(workspaces.firstOrNull { ObjectId.same(it.id, workspaceId) }) +
                    workspaces.filterNot { ObjectId.same(it.id, workspaceId) }).forEach { w ->
                    val count = foldersOf(w.id).size
                    val here = ObjectId.same(w.id, workspaceId)
                    DropdownMenuItem(
                        text = { Text(w.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (here) FontWeight.SemiBold else null) },
                        onClick = { if (count > 0) level = w.id else pick(w.id, null) },
                        leadingIcon = { Icon(painterResource(R.drawable.ic_terminal), null, Modifier.size(18.dp), tint = muted) },
                        trailingIcon = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (here) Icon(painterResource(R.drawable.ic_check), null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                                if (count > 0) {
                                    Text("$count", Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodySmall, color = muted)
                                    Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(16.dp), tint = muted)
                                }
                            }
                        },
                    )
                }
            } else {
                val here = ObjectId.same(shown.id, workspaceId)
                DropdownMenuItem(
                    text = { Text("Workspaces", color = MaterialTheme.colorScheme.primary) },
                    onClick = { level = null },
                    leadingIcon = { Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(16.dp).rotate(180f),
                        tint = MaterialTheme.colorScheme.primary) },
                )
                PlaceHeading("Folders in ${shown.name}")
                PlaceRow("None", null, here && folder == null) { pick(shown.id, null) }
                foldersOf(shown.id).forEach { f -> PlaceRow(f.name, R.drawable.ic_folder, here && ObjectId.same(f.id, folder?.id)) { pick(shown.id, f.id) } }
            }
        }
    }
}

@Composable
private fun PlaceHeading(text: String) {
    Text(text.uppercase(), Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp),
        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
        overflow = TextOverflow.Ellipsis)
}

/** A row of the place menu: its name, ticked when it is the draft's; None has no icon. */
@Composable
private fun PlaceRow(name: String, icon: Int?, on: Boolean, pick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (on) FontWeight.SemiBold else null) },
        onClick = pick,
        leadingIcon = icon?.let { { Icon(painterResource(it), null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) } },
        trailingIcon = if (on) { { Icon(painterResource(R.drawable.ic_check), null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary) } } else null,
    )
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
