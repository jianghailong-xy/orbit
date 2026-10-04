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
import io.orbitd.android.core.BuildIdentity
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.*
import io.orbitd.android.navigation.*
import io.orbitd.android.ui.OrbitTheme
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString

class MainActivity : ComponentActivity() {
    private var incoming by mutableStateOf<Pair<Long, String>?>(null)
    private var linkSequence = 0L
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) acceptIntent(intent)
        val auth = ViewModelProvider(this, ViewModelProvider.AndroidViewModelFactory(application))[AuthViewModel::class.java]
        setContent { OrbitTheme { OrbitShell(auth, application as OrbitApplication, incoming) } }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); acceptIntent(intent) }
    private fun acceptIntent(intent: Intent) {
        if (intent.action == Intent.ACTION_VIEW) intent.dataString?.let { incoming = ++linkSequence to it }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrbitShell(auth: AuthViewModel, app: OrbitApplication, incoming: Pair<Long, String>?) {
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
                    AuthScreen(authState, authMessage, auth::login, auth::logout)
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
    key(signedIn.handle) {
        val api = remember { DirectoryApi(app.session, signedIn.handle) }
        val data by rememberDirectoryData(app, signedIn.handle)
        val live by app.realtime.state.collectAsState()
        val revision = if (live.handle === signedIn.handle) live.invalidationRevision else 0L
        val holder = rememberSaveableStateHolder()
        val route = navigation.current
        fun open(next: OrbitRoute) { keyboard?.hide(); focus.clearFocus(); navigation = navigation.push(next) }
        fun select(key: String, root: OrbitRoute) {
            keyboard?.hide(); focus.clearFocus(); navigation = navigation.select(key, root); scope.launch { drawer.close() }
        }
        LaunchedEffect(route, signedIn.handle, live.handle) {
            if (live.handle === signedIn.handle) app.realtime.selectSession(if (route.destination == Destination.SESSION) route.id else null)
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
                                icon = { Icon(painterResource(icon), null) }, onClick = { select(name, OrbitRoute(dest, origin = Origin.DRAWER)) })
                        }
                        SectionHeading("Workspaces")
                        DirectoryStatus(data) { app.realtime.refreshDirectory() }
                        if (data.ready && data.workspaces.isEmpty()) Text("Add a workspace to start a session.", Modifier.padding(16.dp))
                        data.workspaces.sortedWith(compareBy<DirectoryWorkspace> { it.runnerId == null }.thenBy { it.position }.thenBy { it.createdAt }).forEach { workspace ->
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
                        val workspace = route.workspaceId ?: data.workspaces.firstOrNull()?.id
                        Button(onClick = { scope.launch { drawer.close() }; open(OrbitRoute(Destination.DRAFT, workspaceId = workspace, origin = Origin.DRAWER)) },
                            enabled = workspace != null && data.fresh) { Text("New session") }
                        TextButton(onClick = { scope.launch { drawer.close() }; open(OrbitRoute(Destination.SETTINGS, origin = Origin.DRAWER)) }) {
                            Icon(painterResource(R.drawable.ic_settings), null); Spacer(Modifier.width(8.dp)); Text("Settings")
                        }
                    }
                }
            }) {
            Scaffold(topBar = {
                TopAppBar(title = { Text(routeTitle(route, data), maxLines = 2, style = MaterialTheme.typography.titleMedium) },
                    navigationIcon = {
                        IconButton(onClick = { if (navigation.canGoBack) navigation = navigation.back() else scope.launch { focus.clearFocus(); drawer.open() } }) {
                            Icon(painterResource(if (navigation.canGoBack) R.drawable.ic_back else R.drawable.ic_menu), if (navigation.canGoBack) "Back" else "Open navigation")
                        }
                    }, actions = {
                        if (navigation.canGoBack) IconButton(onClick = { scope.launch { focus.clearFocus(); drawer.open() } }) { Icon(painterResource(R.drawable.ic_menu), "Open navigation") }
                        IconButton(onClick = { app.realtime.refreshDirectory() }) { Icon(painterResource(R.drawable.ic_refresh), "Refresh directory") }
                    })
            }) { padding ->
                Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding(), contentAlignment = Alignment.TopCenter) {
                    Box(Modifier.fillMaxHeight().widthIn(max = 840.dp).fillMaxWidth()) {
                        holder.SaveableStateProvider(Wire.json.encodeToString(route)) {
                            when (route.destination) {
                                Destination.WORKSPACES -> WorkspaceHome(data, { w -> select(w.id, OrbitRoute(Destination.WORKSPACE, w.id, w.id)) }) { app.realtime.refreshDirectory() }
                                Destination.WORKSPACE, Destination.FOLDER -> DirectoryScreen(route, data, api, ::open) { app.realtime.refreshDirectory() }
                                Destination.SEARCH -> SearchScreen(api, ::open)
                                Destination.SETTINGS -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    AuthScreen(authState, authMessage, auth::login, auth::logout)
                                    Button(onClick = { open(OrbitRoute(Destination.BUILD)) }) { Text("Build information") }
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

private fun routeTitle(route: OrbitRoute, data: DirectoryData): String = when (route.destination) {
    Destination.WORKSPACES -> "Workspaces"
    Destination.WORKSPACE -> data.workspaces.firstOrNull { ObjectId.same(it.id, route.id) }?.name ?: "Workspace"
    Destination.FOLDER -> data.folders.firstOrNull { ObjectId.same(it.id, route.id) }?.name ?: "Folder unavailable"
    Destination.SEARCH -> "Search sessions"
    Destination.DRAFT -> "New session"
    Destination.WIKI_ENTRY -> "Wiki"
    else -> route.destination.name.lowercase().replaceFirstChar(Char::uppercase)
}

@Composable
private fun WorkspaceHome(data: DirectoryData, open: (DirectoryWorkspace) -> Unit, refresh: () -> Unit) {
    androidx.compose.foundation.lazy.LazyColumn(Modifier.fillMaxSize()) {
        item { DirectoryStatus(data, refresh) }
        if (data.ready && data.workspaces.isEmpty()) item { StatusMessage("No workspaces", "Add a workspace to start a session.") }
        items(data.workspaces.size) { index ->
            val w = data.workspaces[index]
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
