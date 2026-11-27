package io.orbitd.android.directory

import androidx.activity.compose.LocalFullyDrawnReporterOwner
import androidx.activity.compose.ReportDrawn
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.cards.CardFocus
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.management.LocalSessionRecaps
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.text
import io.orbitd.android.navigation.*
import io.orbitd.android.perf.OrbitPerf
import io.orbitd.android.realtime.PagePoll
import io.orbitd.android.watch.WatchSessionSummary
import io.orbitd.android.watch.watchKey
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** What a page's list draws, worked out once per change of what it is worked out from: the body also runs for what moves no row.
 * [marks]: the project of each member that is a row of its own here, its project's row being where its coordinator runs. */
private class ListContent(val groups: List<SessionGroup>, val projects: Map<String, SessionProjectRow>, val marks: Map<String, SessionProjectMark>,
    val folders: List<Pair<Folder, List<DirectorySession>>>, val held: Map<String, String>)

/** How long a pull's spinner stays for a read that has not answered: a read gets 10 s, and past that the store keeps retrying by itself. */
private const val PULL_WAIT_MS = 12_000L

/**
 * A workspace's session list, or a folder's page (iOS `AgentPanes`, `SessionFolderPage`). The bar holds the scope and everything
 * else in ≡, and ✎; the list holds the needs-you capsule, rows that a tap opens and a long press offers the menu of, and a search
 * at its foot; a pull refreshes it. Nothing is drawn beside rows while a read is out, and nothing waits on one: a server's refusal
 * says so through the prompts it always has. A folder's page has ⋯ for ≡, and no capsule or search: its scope is its list's.
 * [watching] is every session parked on a watch that will resume it, which a row's line says.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
internal fun DirectoryScreen(route: OrbitRoute, data: DirectoryData, api: DirectoryApi, handle: SessionHandle,
    open: (OrbitRoute) -> Unit, refresh: () -> Unit, watching: Map<String, WatchSessionSummary> = emptyMap(),
    scopeList: SessionScopeList = remember(api) { SessionScopeList(api) }) {
    val app = LocalContext.current.applicationContext as OrbitApplication
    var view by rememberSaveable { mutableStateOf(SessionView.entries.firstOrNull { it.query == route.sessionView } ?: SessionView.OPEN) }
    var grouping by rememberSaveable { mutableStateOf(Grouping.RECENCY) }
    var tag by rememberSaveable { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var action by remember { mutableStateOf<DirectoryDialog?>(null) }
    var projectMenu by remember { mutableStateOf<SessionProjectRow?>(null) }
    var pulling by remember { mutableStateOf(false) }
    var pinnedCollapsed by rememberSectionCollapsed("pinnedCollapsed")
    var needsYouCollapsed by rememberSectionCollapsed("needsYouCollapsed")
    val sidebar by rememberProjectSidebar(app, handle, api)
    val asks by app.realtime.directoryAsks.collectAsState()
    val trashing by app.trashing.ids.collectAsState()
    val recaps = LocalSessionRecaps.current
    val list = rememberLazyListState()
    val coroutines = rememberCoroutineScope()
    val folder = data.folders.firstOrNull { ObjectId.same(it.id, route.id) }
    val workspace = route.workspaceId ?: route.id.orEmpty()
    val isFolder = route.destination == Destination.FOLDER
    val onScheduledRuns = isFolder && route.id == ScheduledRunsFolder.ID
    val folderId = if (isFolder && !onScheduledRuns) route.id else null
    val folderTitle = if (onScheduledRuns) ScheduledRunsFolderCopy.TITLE else folder?.name.takeIf { isFolder }
    val workspaceName = data.workspaces.firstOrNull { ObjectId.same(it.id, workspace) }?.name ?: "Workspace"
    val runnerOffline = data.runners.firstOrNull { ObjectId.same(it.id, data.workspaces.firstOrNull { w -> ObjectId.same(w.id, workspace) }?.runnerId) }?.online == false
    val showFolders = listShowsFolders(isFolder, view, tag, grouping)
    val readScheduled = onScheduledRuns || (showFolders && query.isBlank() && workspace.isNotEmpty())
    val scheduledList = remember(api, workspace, view) { SessionScopeList(api, scheduledWorkspace = workspace) }

    LaunchedEffect(view, asks, onScheduledRuns) {
        if (!onScheduledRuns) {
            if (view == SessionView.OPEN) scopeList.clear() else scopeList.show(view, asks)
        }
    }
    if (readScheduled) {
        // New runs are omitted from directory events, so keep a fixed cadence while the page is visible.
        PagePoll(app, handle, emptySet(), scheduledList, asks, inFlightMs = { ScheduledRunsFolder.POLL_INTERVAL_MS }) {
            scheduledList.read(view, asks)
        }
    }

    val openSnapshot = data.sessions[SessionView.OPEN.query].orEmpty()
    val openRows = remember(openSnapshot) { openSnapshot.withoutScheduledRuns() }
    val scopeRows = if (view == SessionView.OPEN) null else scopeList.rows(view)
    val scheduledSnapshot = scheduledList.rows(view)
    val scheduledSessions = remember(scheduledSnapshot, workspace, trashing) {
        TrashingSessions.without(ScheduledRunsFolder.sessions(scheduledSnapshot.orEmpty(), workspace), trashing) { it.id }
    }
    val scheduledRow = remember(scheduledSessions, showFolders) { ScheduledRunsFolder.row(scheduledSessions, showFolders) }
    var scheduledRowWasShown by remember { mutableStateOf(false) }
    SideEffect {
        // Keep the top visible when the scheduled read finishes after the ordinary list.
        if (scheduledRow != null && !scheduledRowWasShown && list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0) {
            list.requestScrollToItem(0)
        }
        scheduledRowWasShown = scheduledRow != null
    }
    val sessions = when {
        onScheduledRuns -> scheduledSessions
        view == SessionView.OPEN -> openRows
        else -> remember(scopeRows, trashing) {
            TrashingSessions.without(scopeRows.orEmpty().withoutScheduledRuns(), trashing) { it.id }
        }
    }
    val content = remember(sessions, openRows, data.folders, sidebar, view, workspace, folderId, onScheduledRuns,
        showFolders, tag, grouping, runnerOffline, watching, recaps) {
        if (onScheduledRuns) return@remember ListContent(
            directoryGroups(sessions, view, Grouping.RECENCY), emptyMap(), emptyMap(), emptyList(), emptyMap())
        // This workspace's rows, by the few spellings of a workspace there are: `ObjectId.same` parses both ids, and an owner's Completed
        // has thousands of rows, mostly in other workspaces.
        val spellings = sessions.mapTo(HashSet()) { it.workspace }.filterTo(HashSet()) { ObjectId.same(it, workspace) }
        val local = sessions.filter { it.workspace in spellings }
        // A05-6: in Open and Completed, a project's members are one row in its coordinator's place. Members elsewhere may supply the
        // words the row borrows; what the row counts and shows moving is this workspace's. A project whose coordinator runs in another
        // workspace has no row here: its members are rows of their own, each marked with it (owner 2026-11-07, option A).
        val listing = if (!SessionProjectGrouping.listShowsProjects(view, byTag = tag != null || grouping == Grouping.TAG)) null else {
            SessionProjectGrouping.listing(local, data.folders.filter { ObjectId.same(it.workspaceId, workspace) },
                sidebar, view, byTag = false, folderId = folderId, runnerOffline = runnerOffline,
                coordinators = (sessions + openRows).filter { it.projectMembership?.isCoordinator == true },
                // The view's own list across every workspace (iOS: the account's Open list, or the scope's `allSessions`).
                contentSessions = sessions, watching = watching, recaps = recaps, workspaceId = workspace)
        }
        val groups = directoryGroups(listing?.entries?.map { it.groupingSession } ?: visibleSessions(local, data.folders, workspace,
            folderId, view, tag, grouping == Grouping.TAG), view, grouping, tagFiltered = tag != null)
        // A folder counts a project's members where their coordinator is filed.
        val counted = listing?.assigned ?: local
        val folders = if (!showFolders) emptyList() else data.folders.filter { f ->
            ObjectId.same(f.workspaceId, workspace) && (view == SessionView.OPEN || counted.any { ObjectId.same(it.folderId, f.id) })
        }.sortedBy { it.name.lowercase() }.map { f -> f to counted.filter { ObjectId.same(it.folderId, f.id) } }
        ListContent(groups, listing?.projects.orEmpty().associateBy { it.projectId }, listing?.marks.orEmpty(), folders, listing?.held.orEmpty())
    }
    val failure = when {
        onScheduledRuns -> scheduledList.error(view).takeIf { scheduledSnapshot == null }
        view == SessionView.OPEN -> data.error.takeIf { !data.ready }
        else -> scopeList.error(view).takeIf { scopeRows == null }
    }
    val waiting = failure == null && when {
        onScheduledRuns -> scheduledSnapshot == null
        view == SessionView.OPEN -> !data.ready
        else -> scopeRows == null
    }
    val machine = data.machineName(workspace)

    PageBar.Bind(route, title = folderTitle, subtitle = workspaceName.takeIf { folderTitle != null }, actions = {
        if (isFolder) {
            if (!onScheduledRuns && folder != null) IconButton(onClick = { action = DirectoryDialog.EditFolder(folder) }) {
                Icon(painterResource(R.drawable.ic_more), SessionListCopy.FOLDER_ACTIONS)
            }
        } else SessionOptionsMenu(view, data.tags, tag, grouping == Grouping.TAG, onView = { next -> view = next; coroutines.launch { list.scrollToItem(0) } },
            onTag = { tag = it }, onByTag = { grouping = if (it) Grouping.TAG else Grouping.RECENCY },
            onNewFolder = { action = DirectoryDialog.NewFolder(workspace) },
            onSettings = { open(OrbitRoute(Destination.SETTINGS, id = "workspace", workspaceId = workspace)) })
        if (!onScheduledRuns) IconButton(onClick = { open(OrbitRoute(Destination.DRAFT, workspaceId = workspace, folderId = folderId)) }) {
            val composeLabel = if (isFolder) SessionListCopy.startSessionIn(folderTitle ?: "Folder")
                else SessionListCopy.startSession(workspaceName)
            Icon(painterResource(R.drawable.ic_compose), composeLabel)
        }
    })

    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize()) {
            if (query.isNotBlank()) {
                SearchResultsList(query, api, open, bottom = SEARCH_FIELD_ROOM)
            } else {
                // Its rows are the folders and the session and project rows, keyed by id; not the headings.
                ReportDirectoryDrawn(data, list) { (it.key as? String)?.startsWith("heading:") == false }
                PullToRefreshBox(isRefreshing = pulling, onRefresh = {
                    pulling = true
                    coroutines.launch {
                        try {
                            when {
                                onScheduledRuns -> scheduledList.read(view, asks)
                                view != SessionView.OPEN -> coroutineScope {
                                    if (readScheduled) launch { scheduledList.read(view, asks) }
                                    scopeList.read(view, asks)
                                }
                                // This also advances asks and refreshes the scheduled row.
                                !data.offline -> withTimeoutOrNull(PULL_WAIT_MS) { app.realtime.rereadDirectory() }
                                else -> Unit
                            }
                        } finally { pulling = false }
                    }
                }, modifier = Modifier.fillMaxSize()) {
                    LazyColumn(Modifier.fillMaxSize().testTag("directory-list"), state = list,
                        contentPadding = PaddingValues(bottom = if (isFolder) 24.dp else SEARCH_FIELD_ROOM)) {
                        if (data.ready && isFolder && folderTitle == null) {
                            item { StatusMessage("Folder unavailable", "It may have been deleted or moved.", refresh) }
                        } else {
                            if (scheduledRow != null) item(key = "folder:${ScheduledRunsFolder.ID}") {
                                FolderRow(ScheduledRunsFolder.ID, ScheduledRunsFolderCopy.TITLE, scheduledRow, onOpen = {
                                    open(OrbitRoute(Destination.FOLDER, ScheduledRunsFolder.ID, workspace, sessionView = view.query))
                                })
                                RowDivider()
                            }
                            items(content.folders, key = { "folder:${it.first.id}" }) { (f, children) ->
                                // A project is one row on the folder's page, so it counts once.
                                FolderRow(f, children, children.distinctBy { content.held[it.id]?.let { p -> "project:$p" } ?: it.id }.size, runnerOffline, watching,
                                    onOpen = { open(OrbitRoute(Destination.FOLDER, f.id, workspace, origin = Origin.LIST, sessionView = view.query)) },
                                    onOptions = { action = DirectoryDialog.EditFolder(f) })
                                RowDivider()
                            }
                            content.groups.forEachIndexed { index, group ->
                                val pinned = group.id == "time:0"
                                val needsYou = group.id == NEEDS_YOU_GROUP
                                // iOS: a list that opens on today would be saying what its rows say, and the title costs half a row.
                                if (index != 0 || group.id != "time:1") stickyHeader(key = "heading:${group.id}") {
                                    when {
                                        pinned -> FoldHeading(group.title, pinnedCollapsed, SessionListCopy.PINNED_SHOWS, SessionListCopy.PINNED_HIDES,
                                            "pinned-heading") { pinnedCollapsed = !pinnedCollapsed }
                                        needsYou -> FoldHeading(group.title, needsYouCollapsed, SessionListCopy.NEEDS_YOU_SHOWS, SessionListCopy.NEEDS_YOU_HIDES,
                                            "needs-you-heading") { needsYouCollapsed = !needsYouCollapsed }
                                        group.id.startsWith("tag:") -> TagHeading(group.sessions.first().tags.first())
                                        group.id == "bucket:untagged" -> TagHeading(null)
                                        else -> ListHeading(group.title)
                                    }
                                }
                                if (!(pinned && pinnedCollapsed) && !(needsYou && needsYouCollapsed)) items(group.sessions, key = { it.id }) { session ->
                                    val project = content.projects[session.id]
                                    // A project's row opens its coordinator's conversation (owner 2026-11-11, docs/mocks/project-sessions-column
                                    // board 5), whose bar opens the project's sessions; a project with no coordinator opens them as a page. A row
                                    // whose line says a member waits on you opens that member, onto its waiting card (owner 2026-11-14).
                                    if (project != null) SwipeableProjectRow(project, view, true, onAction = { act ->
                                        val actions = SessionActions(api, app) { refresh() }
                                        when (act) {
                                            ProjectRowAction.PAUSE -> actions.pauseProject(project)
                                            ProjectRowAction.RESUME -> actions.resumeProject(project)
                                            ProjectRowAction.COMPLETE -> actions.completeProject(project.projectId, project.title)
                                            ProjectRowAction.PIN, ProjectRowAction.UNPIN -> project.coordinator?.let { actions.pin(it.id, it.pinnedAt == null) }
                                            ProjectRowAction.MOVE -> project.coordinator?.let { action = DirectoryDialog.Move(it) }
                                        }
                                    }) { SessionProjectRowView(project, {
                                        val member = project.waitingMember
                                        if (member != null) CardFocus.request(member, CardFocus.WAITING)
                                        open((member ?: project.coordinator?.id)?.let { OrbitRoute(Destination.SESSION, it, workspace, folderId) }
                                            ?: OrbitRoute(Destination.PROJECT_SESSIONS, project.projectId, workspace, origin = Origin.LIST))
                                    }) {
                                        projectMenu = project
                                    } }
                                    else SessionRow(session, machine, { open(OrbitRoute(Destination.SESSION, session.id, workspace, folderId)) },
                                        deleted = view == SessionView.TRASH, watching = watching[watchKey(session.id)], mark = content.marks[session.id]) {
                                        action = DirectoryDialog.SessionMenu(session, view, content.marks[session.id])
                                    }
                                    RowDivider()
                                }
                            }
                            // iOS's overlay on an empty list: Loading…, or that there is nothing. A read that failed says so.
                            if (content.groups.isEmpty() && content.folders.isEmpty() && scheduledRow == null) item(key = "empty") {
                                Box(Modifier.fillParentMaxHeight(0.8f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                                    // Open not read yet is a page brought back with no rows yet: a bare spinner, as at a launch.
                                    if (failure != null) StatusMessage("Couldn't load sessions", failure) {
                                        when {
                                            onScheduledRuns -> coroutines.launch { scheduledList.read(view, asks) }
                                            view == SessionView.OPEN -> refresh()
                                            else -> coroutines.launch { scopeList.read(view, asks) }
                                        }
                                    } else if (waiting && view == SessionView.OPEN) CircularProgressIndicator()
                                    else Text(when {
                                        waiting -> SessionListCopy.LOADING
                                        tag != null -> "No matches"
                                        onScheduledRuns -> ScheduledRunsFolderCopy.EMPTY
                                        isFolder -> SessionListCopy.FOLDER_EMPTY
                                        else -> SessionListCopy.noSessions(view)
                                    }, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
            if (!isFolder) Box(Modifier.align(Alignment.BottomCenter)) { BottomSearch(list, query) { query = it } }
        }
    }
    // A row's menu does not wait for a read either (iOS): what the server refuses comes back in its own words. A marked member's
    // Sessions opens its project's sessions page, as the project's row does where its coordinator runs.
    action?.let { DirectoryActionDialog(it, api, data.copy(fresh = true), setDialog = { action = it },
        openSessions = { project -> open(OrbitRoute(Destination.PROJECT_SESSIONS, project, workspace, origin = Origin.LIST)) }, onChanged = refresh) }
    projectMenu?.let { row ->
        ProjectRowMenu(row, true, view, close = { projectMenu = null },
            complete = { SessionActions(api, app) { refresh() }.completeProject(row.projectId, row.title) },
            openSession = { id -> open(OrbitRoute(Destination.SESSION, id, workspace, folderId)) },
            openSessions = { open(OrbitRoute(Destination.PROJECT_SESSIONS, row.projectId, workspace, origin = Origin.LIST)) },
            openProject = { open(OrbitRoute(Destination.PROJECT, row.projectId)) },
            pin = { coordinator -> SessionActions(api, app) { refresh() }.pin(coordinator.id, coordinator.pinnedAt == null) },
            move = { coordinator -> action = DirectoryDialog.Move(coordinator) },
            pause = { SessionActions(api, app) { refresh() }.pauseProject(row) },
            resume = { SessionActions(api, app) { refresh() }.resumeProject(row) })
    }
}

/** What the list leaves clear at its foot for the field floating there. */
private val SEARCH_FIELD_ROOM = 84.dp

/** The hairline between a list's rows, from the rows' leading edge. */
@Composable
internal fun RowDivider() = HorizontalDivider(Modifier.padding(start = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))

@Composable
fun SearchScreen(api: DirectoryApi, open: (OrbitRoute) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(16.dp),
            singleLine = true, label = { Text("Search sessions") },
            trailingIcon = { if (query.isNotEmpty()) TextButton(onClick = { query = "" }) { Text("Clear") } })
        SearchResultsList(query, api, open)
    }
}

@Composable
private fun SearchResultsList(query: String, api: DirectoryApi, open: (OrbitRoute) -> Unit, bottom: Dp = 24.dp) {
    var results by remember { mutableStateOf<SearchResults?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    // Cancellation on every edit/disposal prevents an old query or account from replacing new hits.
    LaunchedEffect(query, retry, api) {
        loading = true; results = null; error = null
        delay(250)
        try { results = api.search(query.trim()) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = directoryError(failure) }
        finally { loading = false }
    }
    // Keep the lazy interval set stable for a complete measure pass.
    val displayedResults = results
    val displayedError = error
    val displayedLoading = loading
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = bottom)) {
        if (displayedLoading) item { LoadingMessage("Searching sessions…") }
        displayedError?.let { item { StatusMessage("Search couldn't be loaded", it, { retry++ }) } }
        displayedResults?.let { result ->
            item { SectionHeading(if (query.isBlank()) "Recent sessions" else "${result.hits.size} of ${result.total ?: result.hits.size} matching sessions") }
            if (query.isNotBlank() && !result.contentSearched) item {
                Text("Matching names only — type more to search message text.", Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
            }
            if (result.hits.isEmpty()) item { StatusMessage(if (query.isBlank()) "No sessions yet" else "No matches",
                if (query.isBlank()) "Recent sessions will appear here." else "Try another name or message.") }
            items(result.hits, key = { it.id }) { hit ->
                SearchHitRow(hit) { open(OrbitRoute(Destination.SESSION, hit.id, hit.agent?.id, origin = Origin.SEARCH)) }
            }
        }
    }
}

/** One search result. With the session facts it leads with the state icon and says the state word and then every mark (iOS
 * `SessionSearchRow`), a screen reader hearing both as the row's value, as [SessionRow]'s; from an older server, today's line. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SearchHitRow(hit: SearchHit, onOpen: () -> Unit) {
    val state = SessionDisplay.state(hit.displayFacts)
    val value = SessionDisplay.text(hit.displayFacts, ", ")
    val line = listOfNotNull(hit.agent?.name, hit.lifecycleState, state?.word ?: hit.runState ?: hit.status).joinToString(" · ")
    ListItem(headlineContent = { Text(hit.title) }, supportingContent = {
        Column {
            // The marks wrap under the line where they do not fit beside it, so none is clipped.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(7.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                Text(line)
                SessionMarkChips(SessionDisplay.marks(hit.displayFacts))
            }
            hit.snippet?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        }
    }, leadingContent = state?.let { { SessionStateGlyph(it) } },
        modifier = Modifier.clickable(role = Role.Button, onClick = onOpen)
            .then(if (value == null) Modifier else Modifier.semantics { stateDescription = value }))
}

/** The machine a workspace's sessions run on, by the name its page gives it (web `machineName(runner)`): what a session held for the
 * Claude region says Anthropic is unavailable on. Null before the runners are read. */
internal fun DirectoryData.machineName(workspaceId: String?): String? {
    val runnerId = workspaces.firstOrNull { ObjectId.same(it.id, workspaceId) }?.runnerId ?: return null
    return effectiveRunnerRows.firstOrNull { ObjectId.same(it.text("id"), runnerId) }?.let(RunnerPage::displayName)
}

/**
 * P01 TTFD (A01 D09 v2): the launch is fully drawn once the directory list on screen shows real rows from a valid snapshot —
 * [DirectoryData.ready]: the account's snapshot is published and every row of it decoded — rows a tap opens. Never the loading,
 * waiting or error states before that, which show no rows. The copy this device's cache restored is published before the
 * first read from the server leaves (RealtimeStore.account), so with one this does not wait for the network; without one (a
 * first sign-in, a cache that did not restore) it is that first read.
 *
 * The Activity's FullyDrawnReporter calls reportFullyDrawn once per Activity, from the draw of the frame showing those rows.
 * Nothing holds it before then, so a list that leaves before it is ready reports nothing. With `log.tag.OrbitPerf` at D the
 * report also logs where the rows came from and how many [isRow] items were on screen, for A15's collector. That line waits
 * for the frame to finish: the report runs from the window's draw callback, before AndroidComposeView lays the new rows out
 * in its own dispatchDraw, so counted there they are not on screen yet.
 */
@Composable
internal fun ReportDirectoryDrawn(data: DirectoryData, list: LazyListState, isRow: (LazyListItemInfo) -> Boolean) {
    val reporter = LocalFullyDrawnReporterOwner.current?.fullyDrawnReporter
    if (!data.ready || reporter == null || reporter.isFullyDrawnReported) return
    if (OrbitPerf.enabled) {
        val source = if (data.cached) "cache" else "network"
        val view = LocalView.current
        DisposableEffect(reporter) {
            val line: () -> Unit = {
                view.post { OrbitPerf.emit("p01_fully_drawn", "source=$source rows=${list.layoutInfo.visibleItemsInfo.count(isRow)}") }
            }
            reporter.addOnReportDrawnListener(line)
            onDispose { reporter.removeOnReportDrawnListener(line) }
        }
    }
    ReportDrawn()
}

@Composable
fun LoadingMessage(message: String) {
    Row(Modifier.padding(16.dp).semantics { liveRegion = LiveRegionMode.Polite }, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(Modifier.size(24.dp)); Text(message)
    }
}

@Composable
fun StatusMessage(title: String, message: String, retry: (() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(24.dp).semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(message, style = MaterialTheme.typography.bodyMedium)
        retry?.let { Button(onClick = it) { Text("Retry") } }
    }
}

@Composable
fun SectionHeading(title: String) {
    Text(title, Modifier.padding(horizontal = 16.dp, vertical = 12.dp).semantics { heading() },
        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
