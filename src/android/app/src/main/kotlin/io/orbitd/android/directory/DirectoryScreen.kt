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
import androidx.compose.foundation.lazy.itemsIndexed
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
import io.orbitd.android.cards.SessionNeedsYouBar
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.management.LocalSessionRecaps
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.text
import io.orbitd.android.navigation.*
import io.orbitd.android.perf.OrbitPerf
import io.orbitd.android.watch.WatchSessionSummary
import io.orbitd.android.watch.watchKey
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** What a page's list draws, worked out once per change of what it is worked out from: the body also runs for what moves no row. */
private class ListContent(val groups: List<SessionGroup>, val projects: Map<String, SessionProjectRow>, val folders: List<Pair<Folder, List<DirectorySession>>>)

/** How long a pull's spinner stays for a read that has not answered: a read gets 10 s, and past that the store keeps retrying by itself. */
private const val PULL_WAIT_MS = 12_000L

/**
 * A workspace's session list, or a folder's page (iOS `AgentPanes`, `SessionFolderPage`). The bar holds the scope and everything
 * else in ≡, and ✎; the list holds the needs-you capsule, rows that a tap opens and a long press offers the menu of, and a search
 * at its foot; a pull refreshes it. Nothing is drawn beside rows while a read is out, and nothing waits on one: a server's refusal
 * says so through the prompts it always has. A folder's page has ⋯ for ≡, and no capsule or search: its scope is its list's.
 * [revision] re-reads the project rows' progress after a control event; [watching] is every session parked on a watch that will
 * resume it, which a row's line says.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
internal fun DirectoryScreen(route: OrbitRoute, data: DirectoryData, api: DirectoryApi, handle: SessionHandle,
    open: (OrbitRoute) -> Unit, refresh: () -> Unit, revision: Long = 0L, watching: Map<String, WatchSessionSummary> = emptyMap(),
    scopeList: SessionScopeList = remember(api) { SessionScopeList(api) }) {
    val app = LocalContext.current.applicationContext as OrbitApplication
    var view by rememberSaveable { mutableStateOf(SessionView.entries.firstOrNull { it.query == route.sessionView } ?: SessionView.OPEN) }
    var grouping by rememberSaveable { mutableStateOf(Grouping.RECENCY) }
    var tag by rememberSaveable { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var action by remember { mutableStateOf<DirectoryDialog?>(null) }
    var projectMenu by remember { mutableStateOf<SessionProjectRow?>(null) }
    var pulling by remember { mutableStateOf(false) }
    val swipe = remember { RowSwipeState() }
    RowSwipeBack(swipe)
    val refreshed by rememberUpdatedState(refresh)
    val rowWrites = remember(api) { SessionActions(api, app) { refreshed() } }
    var pinnedCollapsed by rememberPinnedCollapsed()
    val sidebar by rememberProjectSidebar(api, revision)
    val asks by app.realtime.directoryAsks.collectAsState()
    val trashing by app.trashing.ids.collectAsState()
    val recaps = LocalSessionRecaps.current
    val list = rememberLazyListState()
    val coroutines = rememberCoroutineScope()
    val folder = data.folders.firstOrNull { ObjectId.same(it.id, route.id) }
    val workspace = route.workspaceId ?: route.id.orEmpty()
    val isFolder = route.destination == Destination.FOLDER
    val folderId = if (isFolder) route.id else null
    val workspaceName = data.workspaces.firstOrNull { ObjectId.same(it.id, workspace) }?.name ?: "Workspace"
    val runnerOffline = data.runners.firstOrNull { ObjectId.same(it.id, data.workspaces.firstOrNull { w -> ObjectId.same(w.id, workspace) }?.runnerId) }?.online == false

    LaunchedEffect(view, asks) { if (view == SessionView.OPEN) scopeList.clear() else scopeList.show(view, asks) }

    val openRows = data.sessions[SessionView.OPEN.query].orEmpty()
    val scopeRows = if (view == SessionView.OPEN) null else scopeList.rows(view)
    val sessions = remember(view, openRows, scopeRows, trashing) {
        if (view == SessionView.OPEN) openRows else TrashingSessions.without(scopeRows.orEmpty(), trashing) { it.id }
    }
    val content = remember(sessions, openRows, data.folders, sidebar, view, workspace, folderId, tag, grouping, runnerOffline, watching, recaps) {
        // This workspace's rows, by the few spellings of a workspace there are: `ObjectId.same` parses both ids, and an owner's Completed
        // has thousands of rows, mostly in other workspaces.
        val spellings = sessions.mapTo(HashSet()) { it.workspace }.filterTo(HashSet()) { ObjectId.same(it, workspace) }
        val local = sessions.filter { it.workspace in spellings }
        // A05-6: in Open and Completed, a project's members are one row in its coordinator's place. Its coordinator may be in another
        // workspace, and so may members whose words the row borrows; what the row counts and shows moving is this workspace's.
        val listing = if (!SessionProjectGrouping.listShowsProjects(view, byTag = tag != null || grouping == Grouping.TAG)) null else {
            SessionProjectGrouping.listing(local, data.folders.filter { ObjectId.same(it.workspaceId, workspace) },
                sidebar, view, byTag = false, folderId = folderId, runnerOffline = runnerOffline,
                coordinators = (sessions + openRows).filter { it.projectMembership?.isCoordinator == true },
                // The view's own list across every workspace (iOS: the account's Open list, or the scope's `allSessions`).
                contentSessions = sessions, watching = watching, recaps = recaps)
        }
        val groups = directoryGroups(listing?.entries?.map { it.groupingSession } ?: visibleSessions(local, data.folders, workspace,
            folderId, view, tag, grouping == Grouping.TAG), view, grouping)
        // A folder counts a project's members where their coordinator is filed.
        val counted = listing?.assigned ?: local
        val folders = if (isFolder || view == SessionView.TRASH || tag != null || grouping == Grouping.TAG) emptyList() else data.folders.filter { f ->
            ObjectId.same(f.workspaceId, workspace) && (view == SessionView.OPEN || counted.any { ObjectId.same(it.folderId, f.id) })
        }.sortedBy { it.name.lowercase() }.map { f -> f to counted.filter { ObjectId.same(it.folderId, f.id) } }
        ListContent(groups, listing?.projects.orEmpty().associateBy { it.projectId }, folders)
    }
    val waiting = if (view == SessionView.OPEN) !data.ready && data.error == null else scopeRows == null && scopeList.error(view) == null
    val failure = if (view == SessionView.OPEN) data.error.takeIf { !data.ready } else scopeList.error(view).takeIf { scopeRows == null }
    val machine = data.machineName(workspace)

    PageBar.Bind(route, title = folder?.name.takeIf { isFolder }, subtitle = workspaceName.takeIf { isFolder && folder != null }, actions = {
        if (isFolder) {
            if (folder != null) IconButton(onClick = { action = DirectoryDialog.EditFolder(folder) }) { Icon(painterResource(R.drawable.ic_more), SessionListCopy.FOLDER_ACTIONS) }
        } else SessionOptionsMenu(view, data.tags, tag, grouping == Grouping.TAG, onView = { next -> view = next; coroutines.launch { list.scrollToItem(0) } },
            onTag = { tag = it }, onByTag = { grouping = if (it) Grouping.TAG else Grouping.RECENCY },
            onNewFolder = { action = DirectoryDialog.NewFolder(workspace) },
            onSettings = { open(OrbitRoute(Destination.SETTINGS, id = "workspace", workspaceId = workspace)) })
        IconButton(onClick = { open(OrbitRoute(Destination.DRAFT, workspaceId = workspace, folderId = folderId)) }) {
            Icon(painterResource(R.drawable.ic_compose), if (isFolder) SessionListCopy.startSessionIn(folder?.name ?: "Folder") else SessionListCopy.startSession(workspaceName))
        }
    })

    Column(Modifier.fillMaxSize()) {
        if (!isFolder) SessionNeedsYouBar(app, handle, null, list, hidden = false, below = null, onBelow = {}, open = open)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (query.isNotBlank()) {
                SearchResultsList(query, api, open, bottom = SEARCH_FIELD_ROOM)
            } else {
                // Its rows are the folders and the session and project rows, keyed by id; not the headings.
                ReportDirectoryDrawn(data, list) { (it.key as? String)?.startsWith("heading:") == false }
                PullToRefreshBox(isRefreshing = pulling, onRefresh = {
                    pulling = true
                    coroutines.launch {
                        try {
                            if (view != SessionView.OPEN) scopeList.read(view, asks)
                            // Offline there is no read to wait for: the rows stay, and the drawer says why.
                            else if (!data.offline) withTimeoutOrNull(PULL_WAIT_MS) { app.realtime.rereadDirectory() }
                        } finally { pulling = false }
                    }
                }, modifier = Modifier.fillMaxSize()) {
                    LazyColumn(Modifier.fillMaxSize().testTag("directory-list"), state = list,
                        contentPadding = PaddingValues(bottom = if (isFolder) 24.dp else SEARCH_FIELD_ROOM)) {
                        if (data.ready && isFolder && folder == null) {
                            item { StatusMessage("Folder unavailable", "It may have been deleted or moved.", refresh) }
                        } else {
                            items(content.folders, key = { "folder:${it.first.id}" }) { (f, children) ->
                                FolderRow(f, children, runnerOffline, watching,
                                    onOpen = { open(OrbitRoute(Destination.FOLDER, f.id, workspace, origin = Origin.LIST, sessionView = view.query)) },
                                    onOptions = { action = DirectoryDialog.EditFolder(f) })
                                RowDivider()
                            }
                            content.groups.forEachIndexed { index, group ->
                                val pinned = group.id == "time:0"
                                // iOS: a list that opens on today would be saying what its rows say, and the title costs half a row.
                                if (index != 0 || group.id != "time:1") stickyHeader(key = "heading:${group.id}") {
                                    when {
                                        pinned -> PinnedHeading(group.title, pinnedCollapsed) { pinnedCollapsed = !pinnedCollapsed }
                                        group.id.startsWith("tag:") -> TagHeading(group.sessions.first().tags.first())
                                        group.id == "bucket:untagged" -> TagHeading(null)
                                        else -> ListHeading(group.title)
                                    }
                                }
                                if (!pinned || !pinnedCollapsed) itemsIndexed(group.sessions, key = { _, session -> session.id }) { index, session ->
                                    val project = content.projects[session.id]
                                    if (project != null) {
                                        val rowActions = SessionRowActionList.projectRowActions(project, pin = { rowWrites.pin(it.id, it.pinnedAt == null) }, move = { action = DirectoryDialog.Move(it) })
                                        SwipeRow(session.id, swipe, rowActions) {
                                            SessionProjectRowView(project, { open(OrbitRoute(Destination.PROJECT_SESSIONS, project.projectId, workspace, origin = Origin.LIST)) }, rowActions.accessibility) {
                                                projectMenu = project
                                            }
                                        }
                                    } else {
                                        val rowActions = SessionRowActionList.rowActions(session, view, rowWrites) { action = it }
                                        SwipeRow(session.id, swipe, rowActions) {
                                            SessionRow(session, machine, { open(OrbitRoute(Destination.SESSION, session.id, workspace, folderId)) },
                                                deleted = view == SessionView.TRASH, watching = watching[watchKey(session.id)], actions = rowActions.accessibility) {
                                                action = DirectoryDialog.SessionMenu(session, view)
                                            }
                                        }
                                    }
                                    RowDivider(hidden = swipe.hidesDivider(session.id, group.sessions.getOrNull(index + 1)?.id))
                                }
                            }
                            // iOS's overlay on an empty list: Loading…, or that there is nothing. A read that failed says so.
                            if (content.groups.isEmpty() && content.folders.isEmpty()) item(key = "empty") {
                                Box(Modifier.fillParentMaxHeight(0.8f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                                    // Open not read yet is a page brought back with no rows yet: a bare spinner, as at a launch.
                                    if (failure != null) StatusMessage("Couldn't load sessions", failure) {
                                        if (view == SessionView.OPEN) refresh() else coroutines.launch { scopeList.read(view, asks) }
                                    } else if (waiting && view == SessionView.OPEN) CircularProgressIndicator()
                                    else Text(when {
                                        waiting -> SessionListCopy.LOADING
                                        tag != null -> "No matches"
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
    // A row's menu does not wait for a read either (iOS): what the server refuses comes back in its own words.
    action?.let { DirectoryActionDialog(it, api, data.copy(fresh = true), setDialog = { action = it }, onChanged = refresh) }
    projectMenu?.let { row ->
        ProjectRowMenu(row, true, close = { projectMenu = null },
            openSession = { id -> open(OrbitRoute(Destination.SESSION, id, workspace, folderId)) },
            openSessions = { open(OrbitRoute(Destination.PROJECT_SESSIONS, row.projectId, workspace, origin = Origin.LIST)) },
            openProject = { open(OrbitRoute(Destination.PROJECT, row.projectId)) },
            pin = { coordinator -> SessionActions(api, app) { refresh() }.pin(coordinator.id, coordinator.pinnedAt == null) },
            move = { coordinator -> action = DirectoryDialog.Move(coordinator) })
    }
}

/** What the list leaves clear at its foot for the field floating there. */
private val SEARCH_FIELD_ROOM = 84.dp

/** The hairline between a list's rows, from the rows' leading edge. */
@Composable
internal fun RowDivider(hidden: Boolean = false) = HorizontalDivider(Modifier.padding(start = 16.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = if (hidden) 0f else 0.5f))

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
                ListItem(headlineContent = { Text(hit.title) }, supportingContent = {
                    Column { Text(listOfNotNull(hit.agent?.name, hit.lifecycleState, hit.runState ?: hit.status).joinToString(" · "))
                        hit.snippet?.let { Text(it, style = MaterialTheme.typography.bodyMedium) } }
                }, modifier = Modifier.clickable(role = Role.Button) { open(OrbitRoute(Destination.SESSION, hit.id, hit.agent?.id, origin = Origin.SEARCH)) })
            }
        }
    }
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
