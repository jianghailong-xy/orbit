package io.orbitd.android

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import io.orbitd.android.auth.AuthScreen
import io.orbitd.android.auth.AuthViewModel
import io.orbitd.android.auth.loginBackground
import io.orbitd.android.auth.openInSignInBrowser
import io.orbitd.android.core.BuildIdentity
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.reader.LastPageMarks
import io.orbitd.android.reader.ProjectLandingsWindow
import io.orbitd.android.reader.SessionDestination
import io.orbitd.android.reader.GuestSessionPage
import io.orbitd.android.reader.WorktreeModel
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastHost
import io.orbitd.android.tasks.TasksScreen
import io.orbitd.android.projects.ProjectAttention
import io.orbitd.android.projects.ProjectsScreen
import io.orbitd.android.wiki.PageBar
import io.orbitd.android.wiki.WikiDrawerCount
import io.orbitd.android.wiki.WikiDrawerRow
import io.orbitd.android.wiki.WikiDestination
import io.orbitd.android.wiki.wikiEntered
import io.orbitd.android.watch.WatchDestination
import io.orbitd.android.cards.OwnerRequestStore
import io.orbitd.android.cards.WaitingOnYouDestination
import io.orbitd.android.cards.WaitingOnYouDrawerCount
import io.orbitd.android.cards.rememberTerminalsChanged
import io.orbitd.android.watch.WatchStore
import io.orbitd.android.composer.MachineSetup
import io.orbitd.android.composer.MachineSetupCopy
import io.orbitd.android.composer.NewSessionComposer
import io.orbitd.android.composer.NoMachineWelcomeCard
import io.orbitd.android.composer.rememberAccountName
import io.orbitd.android.composer.rememberManagedOffered
import io.orbitd.android.composer.rememberManagedRunner
import io.orbitd.android.composer.rememberNewAccount
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.text.ReaderResources
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.*
import io.orbitd.android.navigation.*
import io.orbitd.android.management.*
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.push.PushNoticeHost
import io.orbitd.android.push.NotificationSettings
import io.orbitd.android.update.AboutSection
import io.orbitd.android.update.UpdatePromptHost
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString

class MainActivity : ComponentActivity() {
    private lateinit var auth: AuthViewModel
    private var incoming by mutableStateOf<Pair<Long, String>?>(null)
    private var linkSequence = 0L
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        auth = ViewModelProvider(this, ViewModelProvider.AndroidViewModelFactory(application))[AuthViewModel::class.java]
        // A recreated activity's intent was handled when it first arrived.
        if (savedInstanceState == null) acceptIntent(intent)
        setContent {
            AccountAppearance(application as OrbitApplication) {
                UpdatePromptHost((application as OrbitApplication).updates) {
                    PushNoticeHost((application as OrbitApplication).push) {
                        OrbitShell(auth, application as OrbitApplication, incoming) { address ->
                            auth.continueWithGoogle(address) { url -> openInSignInBrowser(this@MainActivity, url) }
                        }
                    }
                }
            }
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); acceptIntent(intent) }
    // After onNewIntent: back from the browser with Google's answer, or without one (A03c).
    override fun onResume() { super.onResume(); auth.onResumed() }
    // D09 P02: a session a tap opens is stamped with the tap's own time (LastPageMarks).
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked != MotionEvent.ACTION_UP) return super.dispatchTouchEvent(event)
        LastPageMarks.touchNanos = if (Build.VERSION.SDK_INT >= 34) event.eventTimeNanos else event.eventTime * 1_000_000
        return try { super.dispatchTouchEvent(event) } finally { LastPageMarks.touchNanos = LastPageMarks.NO_TOUCH }
    }
    private fun acceptIntent(intent: Intent) {
        // `orbit://auth/google`, from GoogleSignInRedirectActivity; any other address is not Google's answer.
        intent.data?.let { auth.handleGoogleCallback(it.toString()) }
        if (intent.action == Intent.ACTION_VIEW) intent.dataString?.let {
            // A notification's tap carries the notification's tag as the intent's identifier (PushNotifications.show).
            LastPageMarks.delivered(it, intent.identifier != null)
            incoming = ++linkSequence to it
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrbitShell(auth: AuthViewModel, app: OrbitApplication, incoming: Pair<Long, String>?, continueWithGoogle: (String) -> Unit) {
    val authState by auth.state.collectAsState()
    val authMessage by auth.message.collectAsState()
    val googleBusy by auth.googleBusy.collectAsState()
    val signedIn = authState as? AuthState.SignedIn
    val accountKey = signedIn?.handle?.account?.let { "${it.server}|${it.userId}" }
    val saver = remember { Saver<OrbitNavigation, String>(save = { Wire.json.encodeToString(it) }, restore = { Wire.json.decodeFromString<OrbitNavigation>(it) }) }
    var navigation by rememberSaveable(stateSaver = saver) { mutableStateOf(OrbitNavigation()) }
    var showBuild by rememberSaveable { mutableStateOf(false) }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(authState) {
        if (authState != AuthState.Restoring) {
            navigation = navigation.bindAccount(accountKey)
            if (signedIn == null) drawer.close()
        }
    }
    LaunchedEffect(incoming) {
        incoming?.second?.let { raw ->
            OrbitLinks.parse(raw, signedIn?.handle?.account?.server, Origin.EXTERNAL)?.let { route ->
                if (navigation.current != route) LastPageMarks.arrived(route, raw)
                navigation = navigation.receive(route)
            }
        }
    }
    // Android dispatches IME Back before this callback. Animated IME visibility can lag
    // its actual dismissal; gating the route callback on it can finish the Activity.
    BackHandler(enabled = navigation.account == accountKey && (drawer.isOpen || navigation.canGoBack || showBuild)) {
        when { drawer.isOpen -> scope.launch { drawer.close() }; showBuild -> showBuild = false; else -> navigation = navigation.back() }
    }
    if (signedIn == null) {
        Scaffold { padding ->
            val backdrop = if (showBuild) Modifier else Modifier.loginBackground(MaterialTheme.colorScheme.primary)
            Box(Modifier.fillMaxSize().then(backdrop).padding(padding).consumeWindowInsets(padding).imePadding()) {
                if (showBuild) BuildInformation { showBuild = false }
                else AuthScreen(authState, authMessage, googleBusy, auth::login, auth::logout, auth::signInMethods, auth::rememberedEmail,
                    continueWithGoogle) { showBuild = true }
            }
        }
        return
    }
    if (navigation.account != accountKey) {
        // The one frame between the sign-in being restored and the shell: the same bare spinner on either side of it.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    // Saved UI keys must survive a process restart; request ownership still uses the live handle.
    key(accountKey) {
        val api = remember(signedIn.handle) { DirectoryApi(app.session, signedIn.handle) }
        val management = remember(signedIn.handle) { ManagementApi(app.session, signedIn.handle, app.processScope) }
        val scopeList = remember(api) { SessionScopeList(api) }
        val data by rememberDirectoryData(app, signedIn.handle)
        val live by remember(app) { app.realtime.state.map { it.handle to it.invalidationRevision }.distinctUntilChanged() }
            .collectAsState(null to 0L)
        val revision = if (live.first === signedIn.handle) live.second else 0L
        // `terminals.changed`: the approve cards' requests and Settings → Terminals are read again, and nothing else (iOS `AppModel`).
        val terminalsChanged = rememberTerminalsChanged(app, signedIn.handle)
        // The sessions parked on a watch that will resume them, as Following last read them: a project row's line says so (A05-6).
        val watches by remember(signedIn.handle) { WatchStore.of(app.session, signedIn.handle, app.processScope).state }.collectAsState()
        val holder = rememberSaveableStateHolder()
        // A13's settings and runner pages are built anew each time they are pushed, as on iOS: once such a route has
        // left every stack, its saved state goes too, so a cancelled edit or an old draft never comes back.
        val held = remember { mutableSetOf<OrbitRoute>() }
        LaunchedEffect(navigation.stacks) {
            val kept = navigation.stacks.values.flatten().toSet()
            held.filterNot(kept::contains).forEach { holder.removeState(Wire.json.encodeToString(it)) }
            held.retainAll(kept)
            held += kept.filter { it.destination == Destination.SETTINGS || it.destination == Destination.RUNNER }
        }
        // A12's Wiki and Watch pages start afresh each time they are pushed, as on iOS: once such a route has left every
        // stack its saved state goes too, so a document opened again at a section scrolls there and an old refusal is
        // not shown on the next visit. (A link's arrival is a route of its own: OrbitRoute.entry.)
        val wikiHeld = remember { mutableSetOf<OrbitRoute>() }
        LaunchedEffect(navigation.stacks) {
            val kept = navigation.stacks.values.flatten().toSet()
            wikiHeld.filterNot(kept::contains).forEach { holder.removeState(Wire.json.encodeToString(it)) }
            wikiHeld.retainAll(kept)
            wikiHeld += kept.filter { it.isWikiOrWatch }
        }
        val route = navigation.current
        fun open(next: OrbitRoute) {
            keyboard?.hide(); focus.clearFocus()
            if (navigation.current != next) LastPageMarks.opened(next)
            navigation = navigation.push(next)
        }
        // A drawer row: the destination already showing only closes the drawer, any other opens at its root (A05-8) — a
        // workspace's, on the folder page its list was left on, while the directory still has that folder.
        fun select(key: String, root: OrbitRoute) {
            keyboard?.hide(); focus.clearFocus()
            navigation = navigation.select(key, root) { id -> data.folders.any { ObjectId.same(it.id, id) } }
            scope.launch { drawer.close() }
        }
        // A page sending the reader to a destination: its root, whatever was showing.
        fun land(key: String, root: OrbitRoute) { keyboard?.hide(); focus.clearFocus(); navigation = navigation.land(key, root) }
        val workspaces = orderedWorkspaces(data.workspaces)
        val machinesToSetUp = MachineSetup.machinesToSetUp(data.effectiveRunnerRows, data.effectiveWorkspaceRows)
        val firstOnline = MachineSetup.firstOnlineRunnerId(data.effectiveRunnerRows)
        fun openNewSession(origin: Origin = Origin.LIST) {
            val workspace = route.workspaceId ?: workspaces.firstOrNull()?.id
            when {
                workspace != null -> open(OrbitRoute(Destination.DRAFT, workspaceId = workspace, origin = origin))
                firstOnline != null -> select(machineDraftDestination(firstOnline), OrbitRoute(Destination.DRAFT, id = firstOnline, origin = origin))
                else -> open(OrbitRoute(Destination.RUNNER, origin = origin))
            }
        }
        // Rule 10 & 11: with no workspaces, an online machine lands on its new session page; if all machines are offline, lands on Machines & models.
        LaunchedEffect(route, data.ready, data.workspaces.isEmpty(), data.effectiveRunnerRows.isNotEmpty(), firstOnline, navigation.canGoBack, navigation.pending) {
            if (data.ready && data.workspaces.isEmpty() &&
                route.destination == Destination.WORKSPACES && !navigation.canGoBack && navigation.pending == null) {
                if (firstOnline != null) {
                    land(machineDraftDestination(firstOnline), OrbitRoute(Destination.DRAFT, id = firstOnline))
                } else if (data.effectiveRunnerRows.isNotEmpty()) {
                    land("settings", OrbitRoute(Destination.RUNNER))
                }
            }
        }
        // iOS `resolveDefaultLanding`: the launch default gives way to the workspace used last, as soon as there is a list to pick from.
        // One this phone saved is good enough to land on; the first read from the server decides again unless something has been
        // opened over it since.
        val lastWorkspace = remember(signedIn.handle) { LastWorkspace(app.session, signedIn.handle) }
        var provisionalLanding by remember(signedIn.handle) { mutableStateOf<String?>(null) }
        var deletedWorkspace by remember(signedIn.handle) { mutableStateOf<String?>(null) }
        LaunchedEffect(lastWorkspace) { lastWorkspace.load() }
        fun rootOf(shown: OrbitNavigation) = shown.frames.first().takeIf { it.destination == Destination.WORKSPACE }?.id
        LaunchedEffect(lastWorkspace, rootOf(navigation)) { rootOf(navigation)?.let { lastWorkspace.save(it) } }
        LaunchedEffect(lastWorkspace.loaded, data.ready, data.cached, workspaces, navigation.frames, navigation.pending, deletedWorkspace) {
            if (!lastWorkspace.loaded || !data.ready) return@LaunchedEffect
            val top = navigation.current
            val opened = top.workspaceId ?: top.takeIf { it.destination == Destination.SESSION }?.let { session ->
                data.sessions["open"].orEmpty().firstOrNull { ObjectId.same(it.id, session.id) }?.workspace
            }
            val before = navigation
            navigation = before.landHome(workspaces.map { it.id }.filterNot { ObjectId.same(it, deletedWorkspace) }, lastWorkspace.id, opened, provisionalLanding)
            if (!data.cached) provisionalLanding = null else if (navigation !== before) provisionalLanding = rootOf(navigation)
        }
        // A new account whose only workspace is its managed runner's default lands on that workspace's draft, where the welcome card
        // stands (docs/mocks/new-user-onboarding; the web's DefaultLanding + WorkspaceView). Once per sign-in, over the list the launch
        // landed on, so Back still reaches it; an account that has had a session keeps today's landing.
        var managedLanded by remember(signedIn.handle) { mutableStateOf(false) }
        val onlyWorkspace = workspaces.singleOrNull()?.id
        val managedForLanding = rememberManagedRunner(management, ask = data.ready && onlyWorkspace != null && !managedLanded)
        val managedDefault = managedForLanding.shown?.status?.workspaceId
            ?.takeIf { onlyWorkspace != null && ObjectId.same(it, onlyWorkspace) }?.let { onlyWorkspace }
        val newManagedAccount = rememberNewAccount(management, managedDefault != null && !managedLanded)
        LaunchedEffect(newManagedAccount, managedDefault, route, navigation.canGoBack) {
            val workspace = managedDefault ?: return@LaunchedEffect
            if (!newManagedAccount || managedLanded || navigation.canGoBack) return@LaunchedEffect
            if (route.destination == Destination.WORKSPACE && ObjectId.same(route.id, workspace)) {
                managedLanded = true
                open(OrbitRoute(Destination.DRAFT, workspaceId = workspace))
            }
        }
        // A merge's push (A11-9) names its project only: once the directory is read, its sessions page lands as the project's root
        // over the workspace the drawer's row would pick (iOS 6b4bef713 `openProjectMerge`).
        val arrival = navigation.pending?.takeIf { it.waitsForDirectory }
        LaunchedEffect(arrival, data.ready, data.error) {
            val id = arrival?.id ?: return@LaunchedEffect
            if (data.ready || data.error != null)
                navigation = navigation.landPending(projectRoot(id, data, navigation.current.workspaceId, arrival.origin))
        }
        LaunchedEffect(route, signedIn.handle, live.first) {
            // A landing session is the platform's, not a conversation's: it opens no `sessions/:id/events` stream (LS6), and
            // SessionDestination never mounts the reader for one. The reader selects the conversation it shows, and clears
            // the selection when it leaves; leaving a session for any other page clears it here.
            if (live.first === signedIn.handle && route.destination != Destination.SESSION) app.realtime.selectSession(null)
        }
        // iOS `NavigationDrawer(live: progress > 0)`: the drawer's animated marks move only while any of it is on screen. The closed
        // drawer stays composed, one sheet's width off screen (Material's closed anchor), where a spinner would redraw every frame.
        var sheetWidth by remember { mutableIntStateOf(0) }
        val drawerLive by remember { derivedStateOf { sheetWidth > 0 && drawer.currentOffset > -sheetWidth } }
        ModalNavigationDrawer(drawerState = drawer,
            drawerContent = {
                ModalDrawerSheet(modifier = Modifier.onSizeChanged { sheetWidth = it.width }, drawerContainerColor = LocalOrbitColors.current.drawer,
                    drawerContentColor = MaterialTheme.colorScheme.onSurface) {
                    Column(Modifier.fillMaxHeight().widthIn(max = 360.dp).verticalScroll(rememberScrollState()).imePadding().padding(12.dp)) {
                        val projects = rememberDrawerProjects(app, signedIn.handle, api)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("Orbit", style = MaterialTheme.typography.headlineMedium)
                            IconButton(onClick = { scope.launch { drawer.close() }; open(OrbitRoute(Destination.SEARCH, origin = Origin.DRAWER)) }) {
                                Icon(painterResource(R.drawable.ic_search), "Search sessions")
                            }
                        }
                        listOf(Triple("Projects", Destination.PROJECTS, R.drawable.ic_project), Triple("Tasks", Destination.TASKS, R.drawable.ic_task),
                            Triple("Wiki", Destination.WIKI, R.drawable.ic_wiki)).forEach { (name, dest, icon) ->
                            val row = @Composable {
                                NavigationDrawerItem(label = { Text(name) }, selected = navigation.section == name,
                                    icon = { Icon(painterResource(icon), null) }, onClick = {
                                        // Coming into the Wiki from another section, it opens the space bound to where the reader was.
                                        if (dest == Destination.WIKI && navigation.section != name) wikiEntered(app, signedIn.handle, navigation)
                                        select(name, OrbitRoute(dest, origin = Origin.DRAWER))
                                    },
                                    badge = when (dest) {
                                        Destination.WIKI -> ({ WikiDrawerCount(app, signedIn.handle) })
                                        Destination.PROJECTS -> ({ ProjectsDrawerCount(projects) })
                                        else -> null
                                    })
                            }
                            if (dest == Destination.WIKI) WikiDrawerRow(app, signedIn.handle, drawer.isOpen, row) else row()
                        }
                        // What sessions asked the owner to do (web `WaitingOnYouPage`), with how many are waiting.
                        NavigationDrawerItem(label = { Text(WAITING_ON_YOU) }, selected = navigation.section == WAITING_ON_YOU,
                            icon = { Icon(painterResource(R.drawable.ic_bell), null) },
                            onClick = { select(WAITING_ON_YOU, OrbitRoute(Destination.WAITING_ON_YOU, origin = Origin.DRAWER)) },
                            badge = { WaitingOnYouDrawerCount(remember(signedIn.handle) { OwnerRequestStore.of(app.session, signedIn.handle, app.processScope) }, projects.projects, revision, terminalsChanged) },
                            modifier = Modifier.testTag("drawer:waiting-on-you"))
                        SectionHeading("Workspaces")
                        DrawerUnreachableRow(data) { app.realtime.refreshDirectory() }
                        if (data.ready && data.workspaces.isEmpty() && machinesToSetUp.isEmpty()) Text(MachineSetupCopy.NO_WORKSPACES_YET, Modifier.padding(16.dp))
                        workspaces.forEach { workspace ->
                            val runner = data.runners.firstOrNull { ObjectId.same(it.id, workspace.runnerId) }
                            val sessions = data.sessions["open"].orEmpty().filter { ObjectId.same(it.workspace, workspace.id) }
                            NavigationDrawerItem(selected = navigation.section == workspace.id,
                                label = { Column { Text(workspace.name); Text(listOfNotNull(runner?.name,
                                    if (!workspace.enabled) "Disabled" else if (runner?.online == false) "Offline" else null,
                                    sessions.sumOf { it.pendingApprovals }.takeIf { it > 0 }?.let { "$it need you" },
                                    sessions.count { it.runState == "RUNNING" || it.status == "RUNNING" }.takeIf { it > 0 }?.let { "$it running" }).joinToString(" · "), style = MaterialTheme.typography.bodySmall) } },
                                icon = { Icon(painterResource(R.drawable.ic_workspace), null) },
                                onClick = { select(workspace.id, OrbitRoute(Destination.WORKSPACE, workspace.id, workspace.id, origin = Origin.DRAWER)) })
                        }
                        machinesToSetUp.forEach { machine ->
                            val dest = machineDraftDestination(machine.id)
                            val selected = navigation.section == dest ||
                                (route.destination == Destination.DRAFT && route.workspaceId == null && ObjectId.same(route.id, machine.id))
                            NavigationDrawerItem(selected = selected,
                                label = { Text(MachineSetupCopy.setupTitle(machine.name), color = MaterialTheme.colorScheme.primary) },
                                icon = { Icon(painterResource(R.drawable.ic_folder_plus), null, tint = MaterialTheme.colorScheme.primary) },
                                onClick = { select(dest, OrbitRoute(Destination.DRAFT, id = machine.id, origin = Origin.DRAWER)) },
                                modifier = Modifier.testTag("setup-machine:${machine.id}"))
                        }
                        // A drawer project row: the project's sessions page as its root, over its coordinator's workspace — or the one
                        // showing, or the first — and the project's page when there is no workspace to open it over (iOS 6f5f883c8).
                        DrawerProjects(projects, ProjectAttention.coordinatorPulses(data.sessions["open"].orEmpty()), drawerLive,
                            navigation.section, root = { id -> projectRoot(id, data, route.workspaceId, Origin.DRAWER) }) { key, root -> select(key, root) }
                        // Shared with me, the drawer's last group (web `SharedWithMeGroup`): the open row is the guest view showing, by a
                        // row of its own or by a session link the owner's read answered 404 for.
                        val sharedWithMe by rememberSharedWithMe(app.session, signedIn.handle)
                        DrawerSharedWithMe(sharedWithMe, route.id?.takeIf {
                            (route.destination == Destination.GUEST_SESSION || route.destination == Destination.SESSION) && sharedWithMeContains(sharedWithMe, it)
                        }) { key, root -> select(key, root) }
                        Spacer(Modifier.height(24.dp))
                        Button(onClick = { scope.launch { drawer.close() }; openNewSession(Origin.DRAWER) }) { Text("New session") }
                        TextButton(onClick = { scope.launch { drawer.close() }; open(OrbitRoute(Destination.SETTINGS, origin = Origin.DRAWER)) }) {
                            Icon(painterResource(R.drawable.ic_settings), null); Spacer(Modifier.width(8.dp)); Text("Settings")
                        }
                    }
                }
            }) {
            Scaffold(topBar = {
                // iOS `ConsoleView.foldsChrome`: a phone's page folds the bar away while its own composer holds the
                // keyboard — back, title and the page's buttons come back when the keyboard goes.
                val machineName = if (route.destination == Destination.DRAFT && route.workspaceId == null && route.id != null) {
                    data.effectiveRunnerRows.firstOrNull { ObjectId.same(it.text("id"), route.id) }?.let(RunnerPage::displayName)
                        ?: data.runners.firstOrNull { ObjectId.same(it.id, route.id) }?.name
                } else null
                if (!PageBar.folds(route)) TopAppBar(modifier = Modifier.testTag("app-bar"),
                    title = {
                        PageBar.Title(route) {
                            if (machineName != null) {
                                Column {
                                    Text(MachineSetupCopy.SETUP_PAGE_TITLE, maxLines = 1, style = MaterialTheme.typography.titleMedium)
                                    Text(machineName, maxLines = 1, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            } else {
                                Text(routeTitle(route, data), maxLines = 2, style = MaterialTheme.typography.titleMedium)
                            }
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = { if (navigation.canGoBack) navigation = navigation.back() else scope.launch { focus.clearFocus(); drawer.open() } }) {
                            Icon(painterResource(if (navigation.canGoBack) R.drawable.ic_back else R.drawable.ic_menu), if (navigation.canGoBack) "Back" else "Open navigation")
                        }
                    }, actions = {
                        PageBar.Actions(route, this)
                        if (navigation.canGoBack) IconButton(onClick = { scope.launch { focus.clearFocus(); drawer.open() } }) { Icon(painterResource(R.drawable.ic_menu), "Open navigation") }
                        // iOS: a session list is refreshed by pulling it.
                        if (route.destination != Destination.WORKSPACES && route.destination != Destination.WORKSPACE && route.destination != Destination.FOLDER)
                            IconButton(onClick = { app.realtime.refreshDirectory() }) { Icon(painterResource(R.drawable.ic_refresh), "Refresh directory") }
                    })
            }) { padding ->
                Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding(), contentAlignment = Alignment.TopCenter) {
                    Box(Modifier.fillMaxHeight().widthIn(max = 840.dp).fillMaxWidth()) {
                        CompositionLocalProvider(LocalReaderResources provides remember(signedIn.handle) { ReaderResources(app.session, signedIn.handle) }) {
                        holder.SaveableStateProvider(Wire.json.encodeToString(route)) {
                            when (route.destination) {
                                Destination.WORKSPACES -> WorkspaceHome(data, management, startSession = { openNewSession() }) { app.realtime.refreshDirectory() }
                                Destination.WORKSPACE, Destination.FOLDER -> DirectoryScreen(route, data, api, signedIn.handle, ::open, { app.realtime.refreshDirectory() },
                                    watches.summaries, scopeList)
                                Destination.PROJECT_SESSIONS -> SessionProjectPage(app, signedIn.handle, route, data, api, ::open)
                                Destination.LANDINGS -> route.id?.let { project ->
                                    ProjectLandingsWindow(app, signedIn.handle, route, api, project, route.recordId, ::open)
                                }
                                Destination.SEARCH -> SearchScreen(api, ::open)
                                // A member picked from a conversation's project sheet takes that conversation's place: Back returns
                                // to the list it was opened from (owner 2026-11-11, docs/mocks/project-sessions-column board 5).
                                Destination.SESSION -> SessionDestination(app, signedIn.handle, route, api, data, ::open, scopeList::holds,
                                    swap = { next -> keyboard?.hide(); focus.clearFocus(); navigation = navigation.back().push(next) }) {
                                    navigation = navigation.dropSession(route.id!!)
                                }
                                Destination.DRAFT -> NewSessionComposer(app, signedIn.handle, route, data, ::open) { key, root -> land(key, root) }
                                Destination.TASKS, Destination.TASK, Destination.LIST -> TasksScreen(app, signedIn.handle, route, revision, ::open) { navigation = navigation.back() }
                                Destination.PROJECTS, Destination.PROJECT -> ProjectsScreen(app, signedIn.handle, route, ::open) { navigation = navigation.back() }
                                Destination.WIKI, Destination.WIKI_ENTRY, Destination.WIKI_BROWSE, Destination.WIKI_INDEX,
                                Destination.WIKI_ARTICLE, Destination.WIKI_DOC, Destination.WIKI_REVIEW, Destination.WIKI_SETTINGS,
                                Destination.WIKI_RUN, Destination.WIKI_JOB, Destination.WIKI_PLAN, Destination.WIKI_PLAN_DOC, Destination.WIKI_PLAN_SECTION,
                                Destination.WIKI_ACTIVITY, Destination.WIKI_TRASH ->
                                    WikiDestination(app, signedIn.handle, route, data, ::open) { change -> navigation = change(navigation) }
                                Destination.WATCH -> WatchDestination(app, signedIn.handle, route,
                                    navigate = { change -> navigation = change(navigation) }, open = ::open)
                                Destination.SETTINGS -> SettingsScreen(management, route, revision, ::open, { navigation = navigation.back() }, auth::logout,
                                    changed = { app.realtime.refreshDirectory() },
                                    workspaceDeleted = { deletedWorkspace = route.workspaceId; land("workspaces", OrbitRoute(Destination.WORKSPACES)) },
                                    deviceAlerts = { if (app.push.configured) app.push.notifications.allowed() else null },
                                    notifications = { NotificationSettings(app.push) }, about = { AboutSection(app.updates) }, terminalsChanged = terminalsChanged)
                                Destination.RUNNER -> RunnerScreen(management, route.id, route.recordId, revision, ::open, { navigation = navigation.back() }) {
                                    land(it, OrbitRoute(Destination.WORKSPACE, it, it))
                                }
                                Destination.BUILD -> BuildInformation { navigation = navigation.back() }
                                Destination.GUEST_SESSION -> route.id?.let { GuestSessionPage(app, signedIn.handle, route, it) }
                                Destination.WAITING_ON_YOU -> WaitingOnYouDestination(app, signedIn.handle, route, data, revision, ::open)
                                else -> ObjectDestination(route, api, data, revision, ::open) { app.realtime.refreshDirectory() }
                            }
                        }
                        }
                    }
                    // A05-4: the app's one toast surface, under the bar and over every page, so an outcome outlives the
                    // page that asked for it. A toast that names a session opens it — unless it is the page showing —
                    // and following it takes the toast down.
                    fun openSession(id: String) {
                        if (route.destination != Destination.SESSION || !ObjectId.same(route.id, id)) open(OrbitRoute(Destination.SESSION, id, origin = Origin.LINK))
                    }
                    ToastHost(open = { toast -> OrbitToasts.dismiss(toast.id); toast.sessionId?.let(::openSession) },
                        undo = { toast ->
                            OrbitToasts.dismiss(toast.id)
                            toast.sessionId?.let { SessionActions(api, app) { app.realtime.refreshDirectory(); app.realtime.refreshSession() }.restore(it, toast.subtitle) }
                        },
                        resolve = { toast ->
                            val session = toast.sessionId; val conflict = toast.mergeConflict
                            OrbitToasts.dismiss(toast.id)
                            if (session != null && conflict != null) {
                                openSession(session)
                                WorktreeModel(api, session, app.processScope).resolveInSession(conflict.branch, conflict.target)
                            }
                        }, modifier = Modifier.widthIn(max = 560.dp))
                }
            }
        }
    }
}

private fun routeTitle(route: OrbitRoute, data: DirectoryData): String = when (route.destination) {
    Destination.WORKSPACES -> ""
    Destination.WORKSPACE -> data.workspaces.firstOrNull { ObjectId.same(it.id, route.id) }?.name ?: "Workspace"
    Destination.FOLDER -> data.folders.firstOrNull { ObjectId.same(it.id, route.id) }?.name ?: "Folder unavailable"
    Destination.SEARCH -> "Search sessions"
    Destination.DRAFT -> "New session"
    Destination.PROJECT_SESSIONS -> "Project"
    Destination.LANDINGS -> SessionLandingsCopy.title
    Destination.WIKI, Destination.WIKI_ENTRY -> "Wiki"
    Destination.WIKI_BROWSE -> "Browse"
    Destination.WIKI_INDEX -> "Index"
    Destination.WIKI_ARTICLE -> "Article"
    Destination.WIKI_DOC -> "Document"
    Destination.WIKI_REVIEW -> "Review"
    Destination.WIKI_ACTIVITY -> "Activity"
    Destination.WIKI_SETTINGS -> "Wiki settings"
    Destination.WIKI_TRASH -> "Trash"
    Destination.WIKI_RUN -> "Maintenance"
    Destination.WIKI_JOB -> "Run"
    Destination.WIKI_PLAN, Destination.WIKI_PLAN_DOC, Destination.WIKI_PLAN_SECTION -> "Wiki plan"
    Destination.WATCH -> if (route.id == null) "Following" else "Watch"
    Destination.WAITING_ON_YOU -> WAITING_ON_YOU
    Destination.GUEST_SESSION -> io.orbitd.android.core.guests.GuestCopy.SHARED_WITH_ME
    Destination.SETTINGS -> if (route.id == "workspace") data.workspaces.firstOrNull { ObjectId.same(it.id, route.workspaceId) }?.name
        ?.let { "$it settings" } ?: settingsTitle(route.id) else settingsTitle(route.id, route.recordId)
    Destination.RUNNER -> runnerTitle(route.recordId, route.id, data.runners.firstOrNull { ObjectId.same(it.id, route.id) }?.name)
    else -> route.destination.name.lowercase().replaceFirstChar(Char::uppercase)
}

/** What stands in for a workspace's list until the launch has landed on one (iOS `workspaceList`): a bare spinner while the list is
 * coming, or why it can't, or that there is nothing to land on. With workspaces this page is gone a frame later. */
@Composable
private fun WorkspaceHome(data: DirectoryData, management: ManagementApi, startSession: () -> Unit, retry: () -> Unit) {
    // Before the phone has said what network it has, having none yet means nothing.
    var patient by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) { delay(2_000); patient = false }
    // A new account with no machine at all, on a server that starts none for it, meets the welcome card (docs/mocks/new-user-onboarding,
    // P3): how to connect a computer. Once one comes online the launch's landing takes its setup page.
    val noMachine = data.ready && data.workspaces.isEmpty() && data.effectiveRunnerRows.isEmpty()
    val managedOffered = rememberManagedOffered(management, noMachine)
    val welcome = rememberNewAccount(management, noMachine && managedOffered == false) && noMachine && managedOffered == false
    val welcomeName = rememberAccountName(management, welcome)
    var troubled by remember { mutableStateOf(false) }
    if (troubled) AddRunnerDialog(management, onDismiss = { troubled = false }) { troubled = false; retry() }
    if (welcome) {
        ReportDirectoryDrawn(data, rememberLazyListState()) { false }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 12.dp)) {
            NoMachineWelcomeCard(welcomeName, management, onTrouble = { troubled = true }, onArrived = retry)
        }
        return
    }
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        when {
            data.ready && data.workspaces.isEmpty() -> {
                // A launch that lands here has drawn all it is going to.
                ReportDirectoryDrawn(data, rememberLazyListState()) { false }
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(MachineSetupCopy.NO_WORKSPACES_YET, style = MaterialTheme.typography.titleMedium)
                    Text(MachineSetupCopy.NO_WORKSPACES_DETAIL, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = startSession) { Text(MachineSetupCopy.START_A_SESSION) }
                }
            }
            !data.ready && (data.error != null || (data.waitingForConnection && !patient)) ->
                Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(SessionListCopy.WORKSPACES_FAILED, style = MaterialTheme.typography.titleMedium)
                    Text(data.error ?: SessionListCopy.REQUEST_FAILED, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = retry) { Text(SessionListCopy.RETRY) }
                }
            else -> CircularProgressIndicator(Modifier.testTag("workspaces-loading"))
        }
    }
}

@Composable
internal fun BuildInformation(onBack: () -> Unit) {
    val identity = BuildIdentity(
        versionName = BuildConfig.VERSION_NAME,
        sourceRevision = BuildConfig.SOURCE_SHA,
        buildType = BuildConfig.BUILD_TYPE,
        isSourceDirty = BuildConfig.SOURCE_DIRTY,
    )
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.build_information), style = MaterialTheme.typography.headlineMedium)
        Button(onClick = onBack) { Text(stringResource(R.string.back)) }
        IdentityField(stringResource(R.string.package_label), BuildConfig.APPLICATION_ID)
        IdentityField(stringResource(R.string.build_label), identity.displayId)
        IdentityField(stringResource(R.string.source_sha_label), identity.sourceRevision)
        IdentityField(
            stringResource(R.string.source_tree_label),
            stringResource(if (identity.isSourceDirty) R.string.source_modified else R.string.source_clean),
        )
        IdentityField(stringResource(R.string.device_label), "${Build.MANUFACTURER} ${Build.MODEL}")
        IdentityField(
            stringResource(R.string.android_label),
            stringResource(R.string.android_version, Build.VERSION.RELEASE, Build.VERSION.SDK_INT),
        )
        IdentityField(stringResource(R.string.os_build_label), Build.DISPLAY)
    }
}

@Composable
private fun IdentityField(label: String, value: String) {
    Column {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

private const val WAITING_ON_YOU = io.orbitd.android.core.cards.OwnerRequests.waitingOnYou
