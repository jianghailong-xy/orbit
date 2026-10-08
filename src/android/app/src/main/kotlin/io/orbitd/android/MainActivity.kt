package io.orbitd.android

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import io.orbitd.android.auth.AuthScreen
import io.orbitd.android.auth.AuthViewModel
import io.orbitd.android.auth.openInSignInBrowser
import io.orbitd.android.core.BuildIdentity
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.reader.SessionReader
import io.orbitd.android.tasks.TasksScreen
import io.orbitd.android.projects.ProjectsScreen
import io.orbitd.android.wiki.PageBar
import io.orbitd.android.wiki.WikiDrawerCount
import io.orbitd.android.wiki.WikiDestination
import io.orbitd.android.watch.WatchDestination
import io.orbitd.android.composer.NewSessionComposer
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.text.ReaderResources
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.distinctUntilChanged
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.*
import io.orbitd.android.navigation.*
import io.orbitd.android.management.*
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.push.PushNoticeHost
import io.orbitd.android.push.NotificationSettings
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
                PushNoticeHost((application as OrbitApplication).push) {
                    OrbitShell(auth, application as OrbitApplication, incoming) { address ->
                        auth.continueWithGoogle(address) { url -> openInSignInBrowser(this@MainActivity, url) }
                    }
                }
            }
        }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); acceptIntent(intent) }
    private fun acceptIntent(intent: Intent) {
        // `orbit://auth/google`, from GoogleSignInRedirectActivity; any other address is not Google's answer.
        intent.data?.let { auth.handleGoogleCallback(it.toString()) }
        if (intent.action == Intent.ACTION_VIEW) intent.dataString?.let { incoming = ++linkSequence to it }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrbitShell(auth: AuthViewModel, app: OrbitApplication, incoming: Pair<Long, String>?, continueWithGoogle: (String) -> Unit) {
    val authState by auth.state.collectAsState()
    val authMessage by auth.message.collectAsState()
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
            Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding()) {
                if (showBuild) BuildInformation { showBuild = false } else Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge)
                    AuthScreen(authState, authMessage, auth::login, auth::logout, auth::signInMethods, continueWithGoogle)
                    Button(onClick = { showBuild = true }) { Text(stringResource(R.string.build_information)) }
                }
            }
        }
        return
    }
    if (navigation.account != accountKey) {
        LoadingMessage("Opening Orbit…")
        return
    }
    // Saved UI keys must survive a process restart; request ownership still uses the live handle.
    key(accountKey) {
        val api = remember(signedIn.handle) { DirectoryApi(app.session, signedIn.handle) }
        val management = remember(signedIn.handle) { ManagementApi(app.session, signedIn.handle, app.processScope) }
        val data by rememberDirectoryData(app, signedIn.handle)
        val live by remember(app) { app.realtime.state.map { it.handle to it.invalidationRevision }.distinctUntilChanged() }
            .collectAsState(null to 0L)
        val revision = if (live.first === signedIn.handle) live.second else 0L
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
        fun open(next: OrbitRoute) { keyboard?.hide(); focus.clearFocus(); navigation = navigation.push(next) }
        fun select(key: String, root: OrbitRoute) {
            keyboard?.hide(); focus.clearFocus(); navigation = navigation.select(key, root); scope.launch { drawer.close() }
        }
        LaunchedEffect(route, signedIn.handle, live.first) {
            if (live.first === signedIn.handle) app.realtime.selectSession(if (route.destination == Destination.SESSION) route.id else null)
        }
        ModalNavigationDrawer(drawerState = drawer,
            drawerContent = {
                ModalDrawerSheet(drawerContainerColor = LocalOrbitColors.current.drawer,
                    drawerContentColor = MaterialTheme.colorScheme.onSurface) {
                    Column(Modifier.fillMaxHeight().widthIn(max = 360.dp).verticalScroll(rememberScrollState()).imePadding().padding(12.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("Orbit", style = MaterialTheme.typography.headlineMedium)
                            IconButton(onClick = { scope.launch { drawer.close() }; open(OrbitRoute(Destination.SEARCH, origin = Origin.DRAWER)) }) {
                                Icon(painterResource(R.drawable.ic_search), "Search sessions")
                            }
                        }
                        listOf(Triple("Projects", Destination.PROJECTS, R.drawable.ic_project), Triple("Tasks", Destination.TASKS, R.drawable.ic_task),
                            Triple("Wiki", Destination.WIKI, R.drawable.ic_wiki)).forEach { (name, dest, icon) ->
                            NavigationDrawerItem(label = { Text(name) }, selected = navigation.section == name,
                                icon = { Icon(painterResource(icon), null) }, onClick = { select(name, OrbitRoute(dest, origin = Origin.DRAWER)) },
                                badge = if (dest == Destination.WIKI) ({ WikiDrawerCount(app, signedIn.handle, drawer.isOpen) }) else null)
                        }
                        SectionHeading("Workspaces")
                        DirectoryStatus(data) { app.realtime.refreshDirectory() }
                        if (data.ready && data.workspaces.isEmpty()) Text("Add a workspace to start a session.", Modifier.padding(16.dp))
                        val workspaces = orderedWorkspaces(data.workspaces)
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
                        DrawerProjects(api, revision) { next -> scope.launch { drawer.close() }; open(next) }
                        Spacer(Modifier.height(24.dp))
                        val workspace = route.workspaceId ?: workspaces.firstOrNull()?.id
                        Button(onClick = { scope.launch { drawer.close() }; open(OrbitRoute(Destination.DRAFT, workspaceId = workspace, origin = Origin.DRAWER)) },
                            enabled = workspace != null && data.fresh) { Text("New session") }
                        TextButton(onClick = { scope.launch { drawer.close() }; open(OrbitRoute(Destination.SETTINGS, origin = Origin.DRAWER)) }) {
                            Icon(painterResource(R.drawable.ic_settings), null); Spacer(Modifier.width(8.dp)); Text("Settings")
                        }
                    }
                }
            }) {
            Scaffold(topBar = {
                TopAppBar(title = { PageBar.Title(route) { Text(routeTitle(route, data), maxLines = 2, style = MaterialTheme.typography.titleMedium) } },
                    navigationIcon = {
                        IconButton(onClick = { if (navigation.canGoBack) navigation = navigation.back() else scope.launch { focus.clearFocus(); drawer.open() } }) {
                            Icon(painterResource(if (navigation.canGoBack) R.drawable.ic_back else R.drawable.ic_menu), if (navigation.canGoBack) "Back" else "Open navigation")
                        }
                    }, actions = {
                        if (route.destination == Destination.WORKSPACE) IconButton(onClick = {
                            open(OrbitRoute(Destination.SETTINGS, id = "workspace", workspaceId = route.id))
                        }) { Icon(painterResource(R.drawable.ic_settings), "Workspace settings") }
                        if (route.destination == Destination.SESSION && route.id != null) IconButton(onClick = {
                            open(OrbitRoute(Destination.SETTINGS, id = "share", recordId = "SESSION:${route.id}"))
                        }) { Icon(painterResource(R.drawable.ic_share), "Share session") }
                        PageBar.Actions(route, this)
                        if (navigation.canGoBack) IconButton(onClick = { scope.launch { focus.clearFocus(); drawer.open() } }) { Icon(painterResource(R.drawable.ic_menu), "Open navigation") }
                        IconButton(onClick = { app.realtime.refreshDirectory() }) { Icon(painterResource(R.drawable.ic_refresh), "Refresh directory") }
                    })
            }) { padding ->
                Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding(), contentAlignment = Alignment.TopCenter) {
                    Box(Modifier.fillMaxHeight().widthIn(max = 840.dp).fillMaxWidth()) {
                        CompositionLocalProvider(LocalReaderResources provides remember(signedIn.handle) { ReaderResources(app.session, signedIn.handle) }) {
                        holder.SaveableStateProvider(Wire.json.encodeToString(route)) {
                            when (route.destination) {
                                Destination.WORKSPACES -> WorkspaceHome(data, { w -> select(w.id, OrbitRoute(Destination.WORKSPACE, w.id, w.id)) }) { app.realtime.refreshDirectory() }
                                Destination.WORKSPACE, Destination.FOLDER -> DirectoryScreen(route, data, api, ::open) { app.realtime.refreshDirectory() }
                                Destination.SEARCH -> SearchScreen(api, ::open)
                                Destination.SESSION -> SessionReader(app, signedIn.handle, route, api, data, ::open)
                                Destination.DRAFT -> NewSessionComposer(app, signedIn.handle, route, data, ::open)
                                Destination.TASKS, Destination.TASK, Destination.LIST -> TasksScreen(app, signedIn.handle, route, revision, ::open) { navigation = navigation.back() }
                                Destination.PROJECTS, Destination.PROJECT -> ProjectsScreen(app, signedIn.handle, route, revision, ::open) { navigation = navigation.back() }
                                Destination.WIKI, Destination.WIKI_ENTRY, Destination.WIKI_BROWSE, Destination.WIKI_INDEX,
                                Destination.WIKI_ARTICLE, Destination.WIKI_DOC, Destination.WIKI_REVIEW, Destination.WIKI_SETTINGS,
                                Destination.WIKI_RUN, Destination.WIKI_PLAN, Destination.WIKI_PLAN_DOC, Destination.WIKI_PLAN_SECTION ->
                                    WikiDestination(app, signedIn.handle, route, data, ::open) { change -> navigation = change(navigation) }
                                Destination.WATCH -> WatchDestination(app, signedIn.handle, route,
                                    navigate = { change -> navigation = change(navigation) }, open = ::open)
                                Destination.SETTINGS -> SettingsScreen(management, route, revision, ::open, { navigation = navigation.back() }, auth::logout,
                                    changed = { app.realtime.refreshDirectory() },
                                    workspaceDeleted = { select("workspaces", OrbitRoute(Destination.WORKSPACES)) },
                                    deviceAlerts = { if (app.push.configured) app.push.notifications.allowed() else null },
                                    notifications = { NotificationSettings(app.push) })
                                Destination.RUNNER -> RunnerScreen(management, route.id, route.recordId, revision, ::open, { navigation = navigation.back() }) {
                                    select(it, OrbitRoute(Destination.WORKSPACE, it, it))
                                }
                                Destination.BUILD -> BuildInformation { navigation = navigation.back() }
                                else -> ObjectDestination(route, api, data, revision, ::open) { app.realtime.refreshDirectory() }
                            }
                        }
                        }
                    }
                }
            }
        }
    }
}

private fun routeTitle(route: OrbitRoute, data: DirectoryData): String = when (route.destination) {
    Destination.WORKSPACES -> "Workspaces"
    Destination.WORKSPACE -> data.workspaces.firstOrNull { ObjectId.same(it.id, route.id) }?.name ?: "Workspace"
    Destination.FOLDER -> data.folders.firstOrNull { ObjectId.same(it.id, route.id) }?.name ?: "Folder unavailable"
    Destination.SEARCH -> "Search sessions"
    Destination.DRAFT -> "New session"
    Destination.WIKI, Destination.WIKI_ENTRY -> "Wiki"
    Destination.WIKI_BROWSE -> "Browse"
    Destination.WIKI_INDEX -> "Index"
    Destination.WIKI_ARTICLE -> "Article"
    Destination.WIKI_DOC -> "Document"
    Destination.WIKI_REVIEW -> "Review"
    Destination.WIKI_SETTINGS -> "Wiki settings"
    Destination.WIKI_RUN -> "Maintenance"
    Destination.WIKI_PLAN, Destination.WIKI_PLAN_DOC, Destination.WIKI_PLAN_SECTION -> "Wiki plan"
    Destination.WATCH -> if (route.id == null) "Following" else "Watch"
    Destination.SETTINGS -> if (route.id == "workspace") data.workspaces.firstOrNull { ObjectId.same(it.id, route.workspaceId) }?.name
        ?.let { "$it settings" } ?: settingsTitle(route.id) else settingsTitle(route.id, route.recordId)
    Destination.RUNNER -> runnerTitle(route.recordId, route.id, data.runners.firstOrNull { ObjectId.same(it.id, route.id) }?.name)
    else -> route.destination.name.lowercase().replaceFirstChar(Char::uppercase)
}

@Composable
private fun WorkspaceHome(data: DirectoryData, open: (DirectoryWorkspace) -> Unit, refresh: () -> Unit) {
    androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxSize()) {
        item { DirectoryStatus(data, refresh) }
        if (data.ready && data.workspaces.isEmpty()) item { StatusMessage("No workspaces", "Add a workspace to start a session.") }
        val workspaces = orderedWorkspaces(data.workspaces)
        items(workspaces.size) { index ->
            val w = workspaces[index]
            TextButton(onClick = { open(w) }, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag("workspace:${w.id}")) { Text(w.name) }
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
