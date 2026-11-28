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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import io.orbitd.android.cards.NeedsYouMenuIcon
import io.orbitd.android.cards.NeedsYouToasts
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
import io.orbitd.android.toast.ToastTone
import io.orbitd.android.composer.DraftTarget
import io.orbitd.android.share.ShareCopy
import io.orbitd.android.share.ShareHandoff
import io.orbitd.android.share.ShareIntents
import io.orbitd.android.share.ShareTarget
import io.orbitd.android.share.deliverShare
import io.orbitd.android.tasks.TasksScreen
import io.orbitd.android.projects.ProjectAttention
import io.orbitd.android.projects.ProjectsScreen
import io.orbitd.android.wiki.PageBar
import io.orbitd.android.drive.DRIVE_SECTION
import io.orbitd.android.drive.DriveDestination
import io.orbitd.android.drive.driveShown
import io.orbitd.android.drive.isDrive
import io.orbitd.android.wiki.WikiDrawerCount
import io.orbitd.android.wiki.WikiDrawerRow
import io.orbitd.android.wiki.WikiDestination
import io.orbitd.android.wiki.wikiEntered
import io.orbitd.android.watch.WatchDestination
import io.orbitd.android.cards.OwnerRequestLinks
import io.orbitd.android.cards.OwnerRequestStore
import io.orbitd.android.core.cards.OwnerRequestsApi
import io.orbitd.android.core.schedule.ScheduleCopy
import io.orbitd.android.schedule.ScheduledDrawerCount
import io.orbitd.android.schedule.ScheduleChangePage
import io.orbitd.android.schedule.ScheduledPage
import io.orbitd.android.schedule.ScheduledStore
import io.orbitd.android.watch.WatchStore
import io.orbitd.android.composer.MachineSetup
import io.orbitd.android.composer.MachineSetupCopy
import io.orbitd.android.composer.NewSessionComposer
import io.orbitd.android.composer.NewWorkspaceButton
import io.orbitd.android.composer.NewWorkspaceCopy
import io.orbitd.android.composer.NoMachineWelcomeCard
import io.orbitd.android.composer.rememberAccountName
import io.orbitd.android.composer.rememberManagedOffered
import io.orbitd.android.composer.FollowManagedRunner
import io.orbitd.android.composer.LocalManagedRunnerStatus
import io.orbitd.android.composer.ManagedRunner
import io.orbitd.android.management.RunnerCopy
import io.orbitd.android.composer.rememberManagedRunner
import io.orbitd.android.composer.rememberNewAccount
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.reader.LandingPullRequestEnv
import io.orbitd.android.reader.LocalLandingPullRequest
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
    /** What ShareActivity handed over, until the shell has put it in its composer. */
    private var share by mutableStateOf<ShareHandoff?>(null)
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
                        OrbitShell(auth, application as OrbitApplication, incoming, share, { share = null }) { address ->
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
        ShareIntents.receive(intent)?.let { share = it }
        if (intent.action == Intent.ACTION_VIEW) intent.dataString?.let {
            // A notification's tap carries the notification's tag as the intent's identifier (PushNotifications.show).
            LastPageMarks.delivered(it, intent.identifier != null)
            incoming = ++linkSequence to it
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OrbitShell(auth: AuthViewModel, app: OrbitApplication, incoming: Pair<Long, String>?, share: ShareHandoff?, shareTaken: () -> Unit,
    continueWithGoogle: (String) -> Unit) {
    val authState by auth.state.collectAsState()
    val authMessage by auth.message.collectAsState()
    val googleBusy by auth.googleBusy.collectAsState()
    val signedIn = authState as? AuthState.SignedIn
    val accountKey = signedIn?.handle?.account?.let { "${it.server}|${it.userId}" }
    val saver = remember { Saver<OrbitNavigation, String>(save = { Wire.json.encodeToString(it) }, restore = { Wire.json.decodeFromString<OrbitNavigation>(it) }) }
    var navigation by rememberSaveable(stateSaver = saver) { mutableStateOf(OrbitNavigation()) }
    var showBuild by rememberSaveable { mutableStateOf(false) }
    val drawer = rememberOrbitDrawerState()
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(authState) {
        if (authState != AuthState.Restoring) {
            navigation = navigation.bindAccount(accountKey)
            if (signedIn == null) drawer.close()
        }
    }
    // An owner request's link (its push's action) names the request only: it waits here, through a sign-in, for the read that says
    // which conversation asked, and that conversation opens on its card (iOS 0efaa61e4).
    var ownerRequestLink by remember { mutableStateOf<Pair<Long, String>?>(null) }
    LaunchedEffect(incoming) {
        incoming?.second?.let { raw ->
            if (OrbitLinks.ownerRequest(raw) != null) { ownerRequestLink = incoming; return@LaunchedEffect }
            OrbitLinks.parse(raw, signedIn?.handle?.account?.server, Origin.EXTERNAL)?.let { route ->
                if (navigation.current != route) LastPageMarks.arrived(route, raw)
                // The upload notification's Show lands on Drive, its uploads sheet open, whatever was showing.
                navigation = if (route.isDrive && navigation.account != null) navigation.land(DRIVE_SECTION, route) else navigation.receive(route)
            }
        }
    }
    LaunchedEffect(ownerRequestLink, signedIn?.handle) {
        val link = ownerRequestLink ?: return@LaunchedEffect
        val handle = signedIn?.handle ?: return@LaunchedEffect
        val id = OrbitLinks.ownerRequest(link.second) ?: return@LaunchedEffect
        val route = OwnerRequestLinks.open(id) { OwnerRequestsApi(app.session, handle).get(it) }
        if (route == null) OrbitToasts.show(OwnerRequestLinks.unreadable, tone = ToastTone.ERROR)
        else {
            if (navigation.current != route) LastPageMarks.arrived(route, link.second)
            navigation = navigation.receive(route)
        }
        ownerRequestLink = null
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
        // `terminals.changed`: the approve cards' requests are read again, and nothing else (iOS `AppModel`). A machine page's Terminals
        // reads its own list when those requests change, and every 15 s.
        val terminalsChanged = rememberTerminalsChanged(app, signedIn.handle)
        LaunchedEffect(terminalsChanged) {
            if (terminalsChanged > 0) TerminalRequestStore.of(app.session, signedIn.handle, app.processScope).load()
        }
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
        fun replaceTop(next: OrbitRoute) {
            keyboard?.hide(); focus.clearFocus()
            if (navigation.current != next) LastPageMarks.opened(next)
            navigation = navigation.replaceTop(next)
        }
        fun openScheduledRun(id: String) = open(OrbitRoute(Destination.SESSION, id, folderId = ScheduledRunsFolder.ID))
        if (route.destination == Destination.SESSION && route.folderId == ScheduledRunsFolder.ID &&
            navigation.frames.getOrNull(navigation.frames.lastIndex - 1)?.let {
                it.destination == Destination.FOLDER && it.id == ScheduledRunsFolder.ID
            } != true) {
            // Use the session's own workspace and lifecycle when its normal reader gets the detail.
            // A schedule may have moved since this run, and an unavailable session can still go Back to its source.
            val target by remember(app, signedIn.handle, route.id) {
                app.realtime.state.map { state ->
                    state.session?.takeIf { state.handle === signedIn.handle && ObjectId.same(it.id, route.id) }
                        ?.snapshot?.detail?.let { detail ->
                            val workspace = sequenceOf(detail.text("workspaceId"), detail.obj("workspace")?.text("id"),
                                detail.text("agentId"), detail.obj("agent")?.text("id")).firstOrNull { !it.isNullOrEmpty() }
                            workspace?.let { it to detail.text("lifecycleState").lowercase() }
                        }
                }.distinctUntilChanged()
            }.collectAsState(null)
            LaunchedEffect(route, target, data.workspaces) {
                val (workspace, lifecycle) = target ?: return@LaunchedEffect
                val id = data.workspaces.firstOrNull { ObjectId.same(it.id, workspace) }?.id ?: return@LaunchedEffect
                val view = SessionView.entries.firstOrNull { it.query == lifecycle } ?: SessionView.OPEN
                if (navigation.current == route) {
                    navigation = navigation.land(id, OrbitRoute(Destination.WORKSPACE, id, id))
                        .push(OrbitRoute(Destination.FOLDER, ScheduledRunsFolder.ID, id, sessionView = view.query))
                        .push(route)
                }
            }
        }
        // A filed session opened from outside the app (a link, a push, a share) lands with its folder's page under it, so Back
        // reaches its row: the workspace's list hides a filed session behind its folder. A link inside the app opens over the page
        // it was on, which Back returns to. Its folder is the directory row's, else the detail's once read. Once per open, and
        // only while the session is still on top: a page opened over it, or Back, ends the open, and a return to it is no new one
        // (iOS `nav.path == openingPath`).
        var filedOpening by remember(signedIn.handle) { mutableStateOf<OrbitRoute?>(null) }
        var shownTop by remember(signedIn.handle) { mutableStateOf<Pair<String, List<OrbitRoute>>?>(null) }
        LaunchedEffect(navigation.section, navigation.frames) {
            val before = shownTop
            shownTop = navigation.section to navigation.frames
            if (before?.second?.lastOrNull() == route) return@LaunchedEffect
            val returned = before != null && before.first == navigation.section && before.second.size > navigation.frames.size &&
                before.second.take(navigation.frames.size) == navigation.frames
            filedOpening = route.takeIf {
                !returned && it.destination == Destination.SESSION && it.id != null && it.folderId == null &&
                    it.origin == Origin.EXTERNAL
            }
        }
        filedOpening?.let { opening ->
            val read by remember(app, signedIn.handle, opening.id) {
                app.realtime.state.map { state ->
                    state.session?.takeIf { state.handle === signedIn.handle && ObjectId.same(it.id, opening.id) }
                        ?.snapshot?.detail?.let { detail ->
                            val workspace = sequenceOf(detail.text("workspaceId"), detail.obj("workspace")?.text("id"),
                                detail.text("agentId"), detail.obj("agent")?.text("id")).firstOrNull { !it.isNullOrEmpty() }
                            Triple(workspace, detail.text("folderId"), detail.text("lifecycleState"))
                        }
                }.distinctUntilChanged()
            }.collectAsState(null)
            LaunchedEffect(opening, read, data.sessions, data.folders, data.workspaces) {
                if (navigation.current != opening) return@LaunchedEffect
                val row = data.sessions.values.firstNotNullOfOrNull { rows -> rows.firstOrNull { ObjectId.same(it.id, opening.id) } }
                val (workspace, folderId, lifecycle) = row?.let { Triple(it.workspace, it.folderId, it.lifecycleState) } ?: read ?: return@LaunchedEffect
                val view = SessionView.entries.firstOrNull { it.query == lifecycle.orEmpty().lowercase() } ?: SessionView.OPEN
                if (folderId.isNullOrEmpty() || !listShowsFolders(false, view, null, Grouping.RECENCY)) { filedOpening = null; return@LaunchedEffect }
                val folder = data.folders.firstOrNull { ObjectId.same(it.id, folderId) && ObjectId.same(it.workspaceId, workspace) } ?: return@LaunchedEffect
                val id = data.workspaces.firstOrNull { ObjectId.same(it.id, workspace) }?.id ?: return@LaunchedEffect
                filedOpening = null
                val beneath = navigation.frames.getOrNull(navigation.frames.lastIndex - 1)
                if (beneath?.destination != Destination.FOLDER || !ObjectId.same(beneath.id, folder.id))
                    navigation = navigation.underFolder(id, folder.id, view.query)
            }
        }
        // A drawer row: the destination already showing only closes the drawer, any other opens at its root (A05-8) — a
        // workspace's, on the folder page its list was left on, while the directory still has that folder.
        fun select(key: String, root: OrbitRoute) {
            keyboard?.hide(); focus.clearFocus()
            navigation = navigation.select(key, root) { id ->
                id == ScheduledRunsFolder.ID || data.folders.any { ObjectId.same(it.id, id) }
            }
            scope.launch { drawer.close() }
        }
        // A page sending the reader to a destination: its root, whatever was showing.
        fun land(key: String, root: OrbitRoute) { keyboard?.hide(); focus.clearFocus(); navigation = navigation.land(key, root) }
        val workspaces = orderedWorkspaces(data.workspaces)
        val managedForLanding = rememberManagedRunner(management, ask = data.ready)
        FollowManagedRunner(managedForLanding, follow = data.ready && managedForLanding.shown != null)
        val managedStatus = managedForLanding.shown?.status
        val managedOfferedForLanding = rememberManagedOffered(management, data.ready)
        val managedLandingReady = managedOfferedForLanding == false || managedForLanding.loaded
        val machinesToSetUp = MachineSetup.machinesToSetUp(data.effectiveRunnerRows, data.effectiveWorkspaceRows, managedStatus = managedStatus)
        val firstOnline = MachineSetup.firstOnlineRunnerId(data.effectiveRunnerRows, managedStatus = managedStatus)
        // The drawer's Workspaces + (docs/mocks/new-workspace-form/02-apple-entry, owner A): every machine, with what it holds. None until
        // the workspace list has answered, when every machine would read as bare.
        val newWorkspaceMachines = if (data.ready) MachineSetup.newWorkspaceMachines(data.effectiveRunnerRows, data.effectiveWorkspaceRows,
            managedStatus = managedStatus) else emptyList()
        fun openNewSession(origin: Origin = Origin.LIST) {
            val workspace = route.workspaceId ?: workspaces.firstOrNull()?.id
            when {
                workspace != null -> open(OrbitRoute(Destination.DRAFT, workspaceId = workspace, origin = origin))
                firstOnline != null -> select(machineDraftDestination(firstOnline), OrbitRoute(Destination.DRAFT, id = firstOnline, origin = origin))
                else -> open(OrbitRoute(Destination.RUNNER, origin = origin))
            }
        }
        // Share to Orbit (docs/share-to-orbit-design.md §3.2, §4): once the directory says which sessions are open, the picked one opens
        // with the items staged in its composer — or, deleted or ended meanwhile, a new-session draft in its workspace, with a toast why.
        LaunchedEffect(share, data.ready, data.error) {
            val handoff = share ?: return@LaunchedEffect
            if (!data.ready && data.error == null) return@LaunchedEffect
            shareTaken()
            val landing = if (!data.ready) handoff.target
                else handoff.landing { id -> data.sessions["open"].orEmpty().any { ObjectId.same(it.id, id) } }
            if (landing != handoff.target) OrbitToasts.show(ShareCopy.SESSION_GONE, detail = ShareCopy.SESSION_GONE_DETAIL, tone = ToastTone.WARNING)
            val model = when (landing) {
                is ShareTarget.Session -> app.composer(signedIn.handle, landing.id)
                is ShareTarget.NewSession -> DraftTarget(landing.workspaceId).let { app.composer(signedIn.handle, it.key, it) }
            }
            open(when (landing) {
                is ShareTarget.Session -> OrbitRoute(Destination.SESSION, landing.id, origin = Origin.EXTERNAL)
                is ShareTarget.NewSession -> OrbitRoute(Destination.DRAFT, workspaceId = landing.workspaceId, origin = Origin.EXTERNAL)
            })
            app.processScope.launch { deliverShare(app, model, handoff) }
        }
        // Rule 10 & 11: with no workspaces, an online machine lands on its new session page; if all machines are offline, lands on Machines & models.
        LaunchedEffect(route, data.ready, data.workspaces.isEmpty(), data.effectiveRunnerRows.isNotEmpty(), firstOnline, managedLandingReady, navigation.canGoBack, navigation.pending) {
            if (data.ready && data.workspaces.isEmpty() &&
                route.destination == Destination.WORKSPACES && !navigation.canGoBack && navigation.pending == null) {
                if (firstOnline != null) {
                    land(machineDraftDestination(firstOnline), OrbitRoute(Destination.DRAFT, id = firstOnline))
                } else if (managedLandingReady && data.effectiveRunnerRows.isNotEmpty()) {
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
        // drawer stays composed behind the page, where a spinner would redraw every frame.
        val drawerLive by remember { derivedStateOf { drawer.progress > 0f } }
        OrbitDrawerShell(drawer,
            drawer = {
                val projects = rememberDrawerProjects(app, signedIn.handle, api)
                DrawerPanel(
                    header = { DrawerHeader { scope.launch { drawer.close() }; open(OrbitRoute(Destination.SEARCH, origin = Origin.DRAWER)) } },
                    actions = {
                        DrawerActionBar(onNewSession = { scope.launch { drawer.close() }; openNewSession(Origin.DRAWER) },
                            onSettings = { scope.launch { drawer.close() }; open(OrbitRoute(Destination.SETTINGS, origin = Origin.DRAWER)) })
                    }) {
                        // Scheduled (board 01 ①): account-wide, right under Tasks and nowhere in a workspace's list; away while the
                        // server predates scheduled tasks.
                        val scheduled = remember(signedIn.handle) { ScheduledStore.of(app.session, signedIn.handle, app.processScope) }
                        val scheduledState by scheduled.state.collectAsState()
                        LaunchedEffect(scheduled, revision) { scheduled.load() }
                        listOfNotNull(Triple("Projects", Destination.PROJECTS, R.drawable.ic_project), Triple("Tasks", Destination.TASKS, R.drawable.ic_task),
                            Triple(ScheduleCopy.Nav.scheduled, Destination.SCHEDULED, R.drawable.ic_calendar).takeUnless { scheduledState.unsupported },
                            Triple("Wiki", Destination.WIKI, R.drawable.ic_wiki)).forEach { (name, dest, icon) ->
                            val row = @Composable {
                                DrawerRow(selected = navigation.section == name, icon = icon, onClick = {
                                        // Coming into the Wiki from another section, it opens the space bound to where the reader was.
                                        if (dest == Destination.WIKI && navigation.section != name) wikiEntered(app, signedIn.handle, navigation)
                                        select(name, OrbitRoute(dest, origin = Origin.DRAWER))
                                    },
                                    trailing = when (dest) {
                                        Destination.WIKI -> ({ WikiDrawerCount(app, signedIn.handle) })
                                        Destination.PROJECTS -> ({ ProjectsDrawerCount(projects) })
                                        Destination.SCHEDULED -> ({ ScheduledDrawerCount(scheduledState.needsYouCount) })
                                        else -> null
                                    }, modifier = if (dest == Destination.SCHEDULED) Modifier.testTag("drawer:scheduled") else Modifier) { DrawerLabel(name) }
                            }
                            if (dest == Destination.WIKI) WikiDrawerRow(app, signedIn.handle, drawer.isOpen, row) else row()
                        }
                        // Documents (board 04-android ①): right after Wiki, no count; away while the server says documents.enabled: false.
                        if (driveShown(app, signedIn.handle)) DrawerRow(selected = navigation.section == DRIVE_SECTION, icon = R.drawable.ic_folder,
                            onClick = { select(DRIVE_SECTION, OrbitRoute(Destination.DRIVE, origin = Origin.DRAWER)) },
                            modifier = Modifier.testTag("drawer:drive")) { DrawerLabel(DRIVE_SECTION) }
                        DrawerWorkspacesHeading("Workspaces") {
                            NewWorkspaceButton(newWorkspaceMachines) { machine ->
                                select(machineDraftDestination(machine.id), newWorkspaceRoute(machine.id, machine.workspaces > 0, Origin.DRAWER))
                            }
                        }
                        DrawerUnreachableRow(data) { app.realtime.refreshDirectory() }
                        if (data.ready && data.workspaces.isEmpty() && machinesToSetUp.isEmpty()) Text(MachineSetupCopy.NO_WORKSPACES_YET, Modifier.padding(16.dp))
                        workspaces.forEach { workspace ->
                            val runner = data.runners.firstOrNull { ObjectId.same(it.id, workspace.runnerId) }
                            val sessions = data.sessions["open"].orEmpty().filter { ObjectId.same(it.workspace, workspace.id) }
                            val onCloud = runner != null && RunnerPage.isManaged(runner.id, managed = runner.managed)
                            DrawerWorkspaceRow(name = workspace.name,
                                runner = runner?.let { if (onCloud) RunnerCopy.MANAGED_RUNNER_LABEL else it.name },
                                cloud = onCloud,
                                disabled = !workspace.enabled,
                                stateLabel = if (runner?.online == false) ManagedRunner.row(runner.id, managedForLanding.shown?.status)?.label ?: "Offline" else null,
                                waiting = sessions.sumOf { it.pendingApprovals },
                                running = sessions.count { it.isRunning() }, live = drawerLive,
                                selected = navigation.section == workspace.id,
                                onClick = { select(workspace.id, OrbitRoute(Destination.WORKSPACE, workspace.id, workspace.id, origin = Origin.DRAWER)) })
                        }
                        machinesToSetUp.forEachIndexed { index, machine ->
                            val dest = machineDraftDestination(machine.id)
                            val selected = navigation.section == dest ||
                                (route.destination == Destination.DRAFT && route.workspaceId == null && ObjectId.same(route.id, machine.id))
                            DrawerRow(selected = selected,
                                icon = if (machine.managed) R.drawable.ic_cloud else R.drawable.ic_folder_plus,
                                iconTint = MaterialTheme.colorScheme.primary,
                                onClick = { select(dest, OrbitRoute(Destination.DRAFT, id = machine.id, origin = Origin.DRAWER)) },
                                modifier = Modifier.testTag("setup-machine:${machine.id}")) {
                                Text(MachineSetupCopy.setupTitle(machine.name), color = MaterialTheme.colorScheme.primary, maxLines = 1,
                                    fontWeight = FontWeight.SemiBold.takeIf { machine.managed })
                            }
                            if (machine.managed && index < machinesToSetUp.lastIndex) {
                                HorizontalDivider(Modifier.padding(horizontal = DrawerMetrics.textLeading).testTag("setup-managed-runner-divider"),
                                    thickness = with(LocalDensity.current) { 1f.toDp() })
                            }
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
                }
            }) {
            Scaffold(topBar = {
                // iOS `ConsoleView.foldsChrome`: a phone's page folds the bar away while its own composer holds the
                // keyboard — back, title and the page's buttons come back when the keyboard goes.
                val machineName = if (route.destination == Destination.DRAFT && route.workspaceId == null && route.id != null) {
                    data.effectiveRunnerRows.firstOrNull { ObjectId.same(it.text("id"), route.id) }?.let(RunnerPage::displayName)
                        ?: data.runners.firstOrNull { ObjectId.same(it.id, route.id) }?.let { RunnerPage.nameOf(it.id, it.name, it.displayName, managed = it.managed) }
                } else null
                if (!PageBar.folds(route)) TopAppBar(modifier = Modifier.testTag("app-bar"),
                    title = {
                        PageBar.Title(route) {
                            if (machineName != null) {
                                Column {
                                    Text(if (route.addsWorkspace) NewWorkspaceCopy.NEW_WORKSPACE else MachineSetupCopy.SETUP_PAGE_TITLE, maxLines = 1,
                                        style = MaterialTheme.typography.titleMedium)
                                    Text(machineName, maxLines = 1, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            } else {
                                Text(routeTitle(route, data), maxLines = 2, style = MaterialTheme.typography.titleMedium)
                            }
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = { if (navigation.canGoBack) navigation = navigation.back() else scope.launch { focus.clearFocus(); drawer.open() } }) {
                            // The menu carries how many wait on you (needs-you-capsule/12-once).
                            if (navigation.canGoBack) Icon(painterResource(R.drawable.ic_back), "Back") else NeedsYouMenuIcon(app, "Open navigation")
                        }
                    }, actions = {
                        PageBar.Actions(route, this)
                        // A workspace's new session page has back alone in its bar, as iOS's draft does, and a session page back and
                        // its own ⋯ (iOS `ConsoleView`'s toolbar): neither carries the drawer or a refresh.
                        val draftPage = route.destination == Destination.DRAFT && route.workspaceId != null || route.destination == Destination.SESSION ||
                            // Drive' pages carry their own buttons (board 04-android ② ③): New folder and ⋮, nothing of the shell's.
                            route.isDrive
                        if (navigation.canGoBack && !draftPage) IconButton(onClick = { scope.launch { focus.clearFocus(); drawer.open() } }) { NeedsYouMenuIcon(app, "Open navigation") }
                        // iOS: a session list is refreshed by pulling it.
                        if (route.destination != Destination.WORKSPACES && route.destination != Destination.WORKSPACE && route.destination != Destination.FOLDER && !draftPage)
                            IconButton(onClick = { app.realtime.refreshDirectory() }) { Icon(painterResource(R.drawable.ic_refresh), "Refresh directory") }
                    })
            }) { padding ->
                Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding(), contentAlignment = Alignment.TopCenter) {
                    Box(Modifier.fillMaxHeight().widthIn(max = 840.dp).fillMaxWidth()) {
                        CompositionLocalProvider(LocalReaderResources provides remember(signedIn.handle) { ReaderResources(app.session, signedIn.handle) },
                            LocalManagedRunnerStatus provides managedForLanding.shown?.status,
                            LocalLandingPullRequest provides LandingPullRequestEnv(
                                { id -> data.workspaces.firstOrNull { ObjectId.same(it.id, id) }?.landingMode }, ::open)) {
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
                                Destination.DRAFT -> NewSessionComposer(app, signedIn.handle, route, data, ::open, ::land, ::replaceTop)
                                // A task opened over one of its own runs is that run's task card: the frame under it says which conversation.
                                Destination.TASKS, Destination.TASK, Destination.LIST -> TasksScreen(app, signedIn.handle, route, revision, ::open,
                                    from = navigation.frames.getOrNull(navigation.frames.lastIndexOf(route) - 1)
                                        ?.takeIf { it.destination == Destination.SESSION }?.id) { navigation = navigation.back() }
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
                                    notifications = { NotificationSettings(app.push) }, about = { AboutSection(app.updates) })
                                Destination.RUNNER -> RunnerScreen(management, route.id, route.recordId, revision, ::open, { navigation = navigation.back() }) {
                                    land(it, OrbitRoute(Destination.WORKSPACE, it, it))
                                }
                                Destination.BUILD -> BuildInformation { navigation = navigation.back() }
                                Destination.GUEST_SESSION -> route.id?.let { GuestSessionPage(app, signedIn.handle, route, it) }
                                Destination.DRIVE, Destination.DRIVE_FILE, Destination.DRIVE_TRASH, Destination.DRIVE_STORAGE ->
                                    DriveDestination(app, signedIn.handle, route, api, data, ::open) { navigation = navigation.back() }
                                // The timeline (board 01 ②) has its own bottom sheet. Change… opens the schedule's draft
                                // change conversation (§8.2), no longer a blank new session.
                                // A scheduled task's and a condition's pending items head the page (no Waiting on you page): the account's
                                // open owner requests.
                                Destination.SCHEDULED -> {
                                    val requests = remember(signedIn.handle) { OwnerRequestStore.of(app.session, signedIn.handle, app.processScope) }
                                    val requestState by requests.state.collectAsState()
                                    LaunchedEffect(requests, revision) { requests.load(OwnerRequestStore.OPEN) }
                                    ScheduledPage(remember(signedIn.handle) { ScheduledStore.of(app.session, signedIn.handle, app.processScope) },
                                        workspaces.map { it.id to it.name }, lastWorkspace.id, route.id,
                                        openSession = { open(OrbitRoute(Destination.SESSION, it, origin = Origin.LIST)) },
                                        openRun = ::openScheduledRun,
                                        change = { open(OrbitRoute(Destination.SCHEDULE_CHANGE, ObjectId.canonical(it.id) ?: it.id, origin = Origin.LIST)) },
                                        openTask = { open(OrbitRoute(Destination.TASK, it, origin = Origin.LIST)) },
                                        waiting = requestState.scheduleItems, conditionWaiting = requestState.conditionItems,
                                        answered = { requests.load(OwnerRequestStore.OPEN) })
                                }
                                // A schedule's Change… (§8.2, board 03-change ③): the draft change conversation. The
                                // conversation it opens — or the one already open — takes the page's place.
                                Destination.SCHEDULE_CHANGE -> route.id?.let { scheduleId ->
                                    ScheduleChangePage(remember(signedIn.handle) { ScheduledStore.of(app.session, signedIn.handle, app.processScope) }, scheduleId,
                                        openSession = { keyboard?.hide(); focus.clearFocus(); navigation = navigation.back().push(OrbitRoute(Destination.SESSION, it, origin = Origin.LIST)) },
                                        openSchedule = { open(OrbitRoute(Destination.SCHEDULED, ObjectId.canonical(it) ?: it, origin = Origin.LIST)) })
                                }
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
                        }, modifier = Modifier.widthIn(max = 560.dp), needsYou = { NeedsYouToasts(app, signedIn.handle, ::open) })
                }
            }
        }
    }
}

private fun routeTitle(route: OrbitRoute, data: DirectoryData): String = when (route.destination) {
    Destination.WORKSPACES -> ""
    Destination.WORKSPACE -> data.workspaces.firstOrNull { ObjectId.same(it.id, route.id) }?.name ?: "Workspace"
    Destination.FOLDER -> if (route.id == ScheduledRunsFolder.ID) ScheduledRunsFolderCopy.TITLE
        else data.folders.firstOrNull { ObjectId.same(it.id, route.id) }?.name ?: "Folder unavailable"
    Destination.SEARCH -> "Search sessions"
    // The workspace the draft will run in names the page, as iOS's bar does (`WorkspaceTitle`); a machine's setup card has none yet.
    Destination.DRAFT -> route.workspaceId?.let { id -> data.workspaces.firstOrNull { ObjectId.same(it.id, id) }?.name } ?: "New session"
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
    // The page draws its own large "Scheduled" (board 01 ②).
    Destination.SCHEDULED -> ""
    // The page draws its own "Change {title}" once the opening has been read (board 03-change ③).
    Destination.SCHEDULE_CHANGE -> ""
    Destination.GUEST_SESSION -> io.orbitd.android.core.guests.GuestCopy.SHARED_WITH_ME
    Destination.DRIVE -> route.id?.let { route.recordId } ?: "Drive"
    Destination.DRIVE_FILE -> route.recordId ?: "Drive"
    Destination.DRIVE_TRASH -> "Trash"
    Destination.DRIVE_STORAGE -> "Storage"
    Destination.SETTINGS -> if (route.id == "workspace") data.workspaces.firstOrNull { ObjectId.same(it.id, route.workspaceId) }?.name
        ?.let { "$it settings" } ?: settingsTitle(route.id) else settingsTitle(route.id, route.recordId)
    Destination.RUNNER -> runnerTitle(route.recordId, route.id, data.runners.firstOrNull { ObjectId.same(it.id, route.id) }?.let { RunnerPage.nameOf(it.id, it.name, it.displayName, managed = it.managed) })
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
