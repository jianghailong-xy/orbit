package io.orbitd.android.composer

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import io.orbitd.android.management.LocalDefaultModels
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.AddRunnerDialog
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
) {
    val workspaceId = route.workspaceId
    if (workspaceId == null) {
        val runnerId = route.id ?: MachineSetup.firstOnlineRunnerId(data.effectiveRunnerRows) ?: return
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
            open(OrbitRoute(Destination.SESSION, id, workspaceId = workspaceId, origin = route.origin))
            model.consumeCreated()
        }
    }
    // A new account's first draft in its managed runner's default workspace wears the welcome card (docs/mocks/new-user-onboarding)
    // in place of the engine row. Only while the account has never had a session.
    val managementApi = remember(handle) { ManagementApi(app.session, handle, app.processScope) }
    val managedReader = rememberManagedRunner(managementApi, ask = true)
    val managed = managedReader.shown
    val managedDraft = managed?.status?.workspaceId?.let { ObjectId.same(it, workspaceId) } == true
    val welcomeUp = rememberNewAccount(managementApi, managedDraft) && managedDraft
    FollowManagedRunner(managedReader, follow = welcomeUp)
    var focusRequest by remember(target) { mutableIntStateOf(0) }
    var addingOwn by remember(target) { mutableStateOf(false) }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val composerHeight = if (maxHeight < 320.dp) maxHeight else maxHeight * 0.65f
        Column(Modifier.fillMaxSize()) {
            Text(data.workspaces.firstOrNull { ObjectId.same(it.id, workspaceId) }?.name ?: "New session", Modifier.padding(16.dp), style = MaterialTheme.typography.titleMedium)
            route.folderId?.let { id -> Text(data.folders.firstOrNull { ObjectId.same(it.id, id) }?.name ?: "Folder", Modifier.padding(horizontal = 16.dp)) }
            error?.let { Text(it); TextButton(onClick = { retry++ }) { Text("Retry workspace") } }
            if (welcomeUp && managed != null) {
                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 8.dp)) {
                    ManagedWelcomeDraft(app, handle, model, state, detail, data, managed, managedReader, managementApi, open,
                        onOwnInstead = { addingOwn = true }) { focusRequest++ }
                }
            } else {
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
            }
            val current = detail
            val fresh = current != null && current.flag("enabled") != false
            val session = current?.let { SessionState(target.key, snapshot = SessionSnapshot(it, emptyList(), emptyList(), emptyList(), emptyMap()), fresh = fresh) }
            Box(Modifier.heightIn(max = composerHeight)) {
                SessionComposer(app, handle, target.key, session, target, focusRequest = focusRequest, openRunner = openRunner,
                    placeholder = if (welcomeUp) WelcomeCopy.WELCOME_PLACEHOLDER else null)
            }
        }
    }
    if (addingOwn) AddRunnerDialog(managementApi, onDismiss = { addingOwn = false }) { id ->
        addingOwn = false
        open(OrbitRoute(Destination.DRAFT, id = id))
    }
}

/**
 * The managed welcome card on its draft: the managed runner's runner read again every few seconds (its first heartbeat opens the model
 * step), the engine a sign-in is offered for, and the credential the draft would run on.
 */
@Composable
private fun ManagedWelcomeDraft(
    app: OrbitApplication,
    handle: SessionHandle,
    model: ComposerModel,
    state: ComposerState,
    detail: JsonObject?,
    data: DirectoryData,
    managed: ManagedRunner.Shown,
    reader: ManagedRunnerReader,
    managementApi: ManagementApi,
    open: (OrbitRoute) -> Unit,
    onOwnInstead: () -> Unit,
    onPicked: () -> Unit,
) {
    val runnerId = managed.status.runnerId
    val nowMs = rememberNow()
    val resumed = rememberResumed()
    val scope = rememberCoroutineScope()
    var liveRunner by remember(runnerId) { mutableStateOf<JsonObject?>(null) }
    val runner = liveRunner ?: runnerId?.let { id -> data.effectiveRunnerRows.firstOrNull { ObjectId.same(it.text("id"), id) } }
    LaunchedEffect(model) { if (model.state.value.let { it.catalog == null && !it.catalogLoading }) model.loadCatalog() }
    LaunchedEffect(model, runnerId, resumed) {
        if (!resumed || runnerId == null) return@LaunchedEffect
        while (true) {
            runCatching { model.api.runner(runnerId) }.getOrNull()?.let { liveRunner = it }
            delay(MachineSetup.refreshMs(liveRunner))
            model.refreshCatalog()
        }
    }
    val online = runner != null && !RunnerPage.isOffline(runner, nowMs)
    val startsNow = managed.display.startsNewSession
    val effective = detail?.let { JsonObject(it + state.draft.resumeConfig) } ?: state.draft.resumeConfig
    val draftEngine = state.catalog?.engineOf(effective)
    // Before a first session can start there is no draft engine to sign in, so the runner's own first one.
    val engine = draftEngine?.takeIf { startsNow && it in ProviderEngines.LOGIN_ENGINES }
        ?: runner?.let(MachineSetup::firstEngineOn) ?: ProviderEngines.CLAUDE
    val providerSlug = state.draft.resumeConfig.text("provider") ?: effective.text("provider")?.takeIf { it.isNotEmpty() } ?: engine
    val antigravityKey = state.catalog?.antigravityKeyAvailable(effective) == true
    val providerOption = state.catalog?.takeIf { startsNow || state.draft.resumeConfig["provider"] != null }
        ?.current(engine, providerSlug, antigravityKey)
    val credential = runner?.let { MachineSetup.credential(it, engine, providerOption) } ?: SetupCredential.SignIn
    val keyToUse = MachineSetup.firstKey(state.catalog?.engines(preferred = listOf(engine to providerSlug), antigravityKey = antigravityKey).orEmpty(), engine)
    ManagedWelcomeCard(
        name = rememberAccountName(managementApi, true),
        reader = reader,
        shown = managed,
        runner = runner,
        online = online,
        engine = engine,
        credential = credential,
        composerText = state.draft.text,
        startsNow = startsNow,
        managementApi = managementApi,
        onOpenRunner = { id -> open(OrbitRoute(Destination.RUNNER, id)) },
        onOwnInstead = onOwnInstead,
        onExample = { text -> model.edit(text, text.length, text.length); onPicked() },
        onUseKey = keyToUse?.let { pick -> { model.config(buildJsonObject { put("engine", pick.engine); put("provider", pick.provider) }) } },
        onChangeCredential = { model.config(buildJsonObject { put("engine", engine); put("provider", engine) }) },
        onSignedIn = {
            app.realtime.refreshDirectory()
            scope.launch {
                runnerId?.let { id -> runCatching { model.api.runner(id) }.getOrNull()?.let { liveRunner = it } }
                model.refreshCatalog()
            }
        },
    )
}

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
    val model = remember(handle, target) { app.composer(handle, target.key, target) }
    val state by model.state.collectAsState()
    val setupState = app.machineSetup(handle, runnerId)
    val managementApi = remember(handle) { ManagementApi(app.session, handle, app.processScope) }
    val scope = rememberCoroutineScope()
    val resumed = rememberResumed()
    val nowMs = rememberNow()

    var liveRunner by remember(runnerId) { mutableStateOf<JsonObject?>(null) }
    val directoryRunner = data.effectiveRunnerRows.firstOrNull { ObjectId.same(it.text("id"), runnerId) }
    val runner = liveRunner ?: state.catalog?.runner ?: directoryRunner

    LaunchedEffect(model) {
        if (model.state.value.let { it.catalog == null && !it.catalogLoading }) {
            model.loadCatalog()
        }
    }

    LaunchedEffect(model, runnerId, resumed) {
        if (!resumed) return@LaunchedEffect
        runCatching { model.api.runner(runnerId) }.getOrNull()?.let { liveRunner = it }
        while (true) {
            // More often while it is still connecting: its first heartbeat opens the folder step.
            delay(MachineSetup.refreshMs(liveRunner))
            runCatching { model.api.runner(runnerId) }.getOrNull()?.let { liveRunner = it }
            model.refreshCatalog()
        }
    }

    val openRunner = { rId: String, eng: String -> open(OrbitRoute(Destination.RUNNER, rId, recordId = "engine:$eng")) }

    val firstEngine = runner?.let(MachineSetup::firstEngineOn) ?: ProviderEngines.CLAUDE
    val draftWorkspace = runner?.let {
        MachineSetup.machineDraft(it.text("id") ?: runnerId, RunnerPage.displayName(it), firstEngine)
    }
    val effective = draftWorkspace?.let { JsonObject(it + state.draft.resumeConfig) } ?: state.draft.resumeConfig
    val engine = state.draft.resumeConfig.text("engine")
        ?: state.catalog?.engineOf(effective)
        ?: firstEngine
    val providerSlug = state.draft.resumeConfig.text("provider") ?: engine
    val antigravityKey = state.catalog?.antigravityKeyAvailable(effective) == true
    val engines = state.catalog?.engines(
        preferred = listOf(engine to providerSlug),
        antigravityKey = antigravityKey,
    ).orEmpty()
    val providerOption = state.catalog?.current(engine, providerSlug, antigravityKey)
    val credential = runner?.let { MachineSetup.credential(it, engine, providerOption) } ?: SetupCredential.SignIn
    val online = runner != null && !RunnerPage.isOffline(runner, nowMs)
    val existingWorkspace = data.workspaces.firstOrNull { ObjectId.same(it.runnerId, runnerId) }
    val bare = data.ready && existingWorkspace == null
    val ready = MachineSetup.isReady(bare = bare, folder = setupState.folder, online = online, credential = credential)
    // A new account's first machine: the setup card greets it and offers first messages (docs/mocks/new-user-onboarding).
    val machineWelcome = rememberNewAccount(managementApi, bare) && bare
    val welcomeName = rememberAccountName(managementApi, machineWelcome)
    var focusRequest by remember(target) { mutableIntStateOf(0) }
    val otherEngines = runner?.let {
        MachineSetup.otherEngines(it, engine, state.catalog?.fleet ?: data.effectiveRunnerRows)
    }.orEmpty()
    val keyToUse = MachineSetup.firstKey(engines, preferring = engine)

    val remembered = LocalDefaultModels.current
    val seed = if (state.draft.resumeConfig["model"] != null) null else state.catalog?.let { catalog ->
        catalog.liveRememberedModel(engine, providerSlug, remembered)
    }

    SideEffect {
        model.machineSend = { heldMessage ->
            val decision = app.machineSetup(handle, runnerId).send(bare = bare, ready = ready)
            if (decision == MachineSend.Hold) {
                app.updateMachineSetup(handle, runnerId) { it.hold(heldMessage) }
            }
            decision
        }
    }

    // Both steps done with a message waiting: it goes by itself (rule 6).
    LaunchedEffect(ready, setupState.held, state.busy) {
        val current = app.machineSetup(handle, runnerId)
        val taken = current.takeHeldToSend(ready = ready, busy = state.busy) ?: return@LaunchedEffect
        val (nextState, pair) = taken
        val (message, folder) = pair
        app.updateMachineSetup(handle, runnerId) { nextState }
        app.processScope.launch {
            val why = model.sendHeld(message, folder, seed)
            if (why != null) {
                app.updateMachineSetup(handle, runnerId) { it.failHeld(why) }
            }
        }
    }

    LaunchedEffect(state.draft.createdSessionId, state.acknowledgementPending) {
        state.draft.createdSessionId?.takeUnless { state.acknowledgementPending }?.let { id ->
            app.updateMachineSetup(handle, runnerId) { it.finish() }
            open(OrbitRoute(Destination.SESSION, id, origin = route.origin))
            model.consumeCreated()
        }
    }

    // Rule 9 / handoff: if the machine gets a workspace while nothing is in flight, hand off any waiting message to it.
    LaunchedEffect(existingWorkspace?.id, setupState.sendingHeld, state.busy, state.draft.createdSessionId) {
        val ws = existingWorkspace ?: return@LaunchedEffect
        if (setupState.sendingHeld || state.busy || state.draft.createdSessionId != null) return@LaunchedEffect
        val (_, held) = app.machineSetup(handle, runnerId).withdraw()
        app.updateMachineSetup(handle, runnerId) { it.finish() }
        if (held != null) {
            val wsTarget = DraftTarget(ws.id)
            app.composer(handle, wsTarget.key, wsTarget).restoreHeld(held)
        }
        land(ws.id, OrbitRoute(Destination.DRAFT, workspaceId = ws.id, origin = route.origin))
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val composerHeight = if (maxHeight < 320.dp) maxHeight else maxHeight * 0.65f
        val scrollState = rememberScrollState()
        LaunchedEffect(setupState.held != null) {
            if (setupState.held != null) {
                scrollState.scrollTo(scrollState.maxValue)
            }
        }
        Column(Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(scrollState)
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            ) {
                if (runner != null) {
                    MachineSetupCard(
                        runner = runner,
                        online = online,
                        state = setupState,
                        engine = engine,
                        credential = credential,
                        ready = ready,
                        otherEngines = otherEngines,
                        keyToUse = keyToUse,
                        managementApi = managementApi,
                        probeDir = { path, ask -> model.api.probeDir(runner.text("id") ?: runnerId, path, ask) },
                        onPickFolder = { picked ->
                            app.updateMachineSetup(handle, runnerId) { it.pick(picked) }
                        },
                        onUseEngine = { nextEngine ->
                            model.config(buildJsonObject {
                                put("engine", nextEngine)
                                put("provider", nextEngine)
                            })
                        },
                        onUseKey = {
                            keyToUse?.let { pick ->
                                model.config(buildJsonObject {
                                    put("engine", pick.engine)
                                    put("provider", pick.provider)
                                })
                            }
                        },
                        onOpenMachine = {
                            open(OrbitRoute(Destination.RUNNER, runner.text("id") ?: runnerId))
                        },
                        onSignedIn = {
                            app.realtime.refreshDirectory()
                            scope.launch {
                                runCatching { model.api.runner(runnerId) }.getOrNull()?.let { liveRunner = it }
                                model.refreshCatalog()
                            }
                        },
                        welcome = if (!machineWelcome) null else MachineWelcome(welcomeName, state.draft.text) { text ->
                            model.edit(text, text.length, text.length); focusRequest++
                        },
                    )
                    setupState.held?.let { held ->
                        HeldFirstMessageView(
                            held = held,
                            machine = RunnerPage.displayName(runner),
                            sending = setupState.sendingHeld,
                            onWithdraw = {
                                val (nextState, withdrawn) = app.machineSetup(handle, runnerId).withdraw()
                                app.updateMachineSetup(handle, runnerId) { nextState }
                                if (withdrawn != null) model.restoreHeld(withdrawn)
                            },
                            onRetry = {
                                app.updateMachineSetup(handle, runnerId) { it.retryHeld() }
                            },
                        )
                    }
                } else if (data.ready) {
                    Text("This runner is no longer on your account.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    CircularProgressIndicator()
                }
            }
            val session = draftWorkspace?.let {
                SessionState(
                    target.key,
                    snapshot = SessionSnapshot(it, emptyList(), emptyList(), emptyList(), emptyMap()),
                    fresh = true,
                )
            }
            Box(Modifier.heightIn(max = composerHeight)) {
                SessionComposer(app, handle, target.key, session, target, focusRequest = focusRequest, openRunner = openRunner,
                    placeholder = if (machineWelcome && runner != null && (online || MachineSetup.isConnecting(runner))) WelcomeCopy.WELCOME_PLACEHOLDER else null)
            }
        }
    }
}
