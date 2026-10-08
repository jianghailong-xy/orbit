package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

/** The maintenance workspace as this client holds it, and whether its runner is online — nil when unknown. */
internal fun wikiMaintenanceRunnerOnline(space: WikiSpace?, data: DirectoryData): Boolean? {
    val workspace = space?.settings?.maintenance?.workspaceId?.let { id -> data.workspaces.firstOrNull { ObjectId.same(it.id, id) } } ?: return null
    val runner = workspace.runnerId ?: return null
    if (!data.ready) return null
    return data.runners.firstOrNull { ObjectId.same(it.id, runner) }?.online
}
/** Where a draft runs: the workspace and its runner (`wikiMaintenanceWhere`). */
internal fun wikiMaintenanceWhere(space: WikiSpace?, data: DirectoryData): String? {
    val workspace = space?.settings?.maintenance?.workspaceId?.let { id -> data.workspaces.firstOrNull { ObjectId.same(it.id, id) } } ?: return null
    return WikiModeLogic.workspaceLabel(workspace.name, workspace.runnerId?.let { r -> data.runners.firstOrNull { ObjectId.same(it.id, r) }?.name })
}

/** A minute's clock for the relative times, as iOS's `TimelineView(.periodic(by: 60))`. No network call. */
@Composable
internal fun rememberMinuteClock(): Instant {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) { while (true) { delay(60_000); now = Instant.now() } }
    return now
}

/** The Wiki section's root (iOS `WikiHomeView`): the content of the space the reader opened. Its head is drawn at once from
 * the spaces list the drawer has read; its own reads once they answer, the plan's read beside them (the Contents sheet's
 * Plan count). What the home used to say of how the wiki is kept — the status line, what waits, the decisions, the
 * changes, the agents' use — is Activity's, behind the bar's history mark with what waits on the owner on it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiHomeScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var contentsShown by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    /** When the reader last looked, read as the home opens, before its look moves it: what the dots mark. */
    var seen by remember { mutableStateOf<Double?>(null) }
    // A space a link named (`orbit://wiki/<spaceId>`) is picked once its row is known; the route keeps only the id.
    // A space the account does not have — deleted, or another account's — is said to be unavailable, and no other
    // space's home stands in for it; until the link is settled, nothing is drawn.
    var linkedSpaceApplied by rememberSaveable(route.id) { mutableStateOf(route.id == null) }
    var linkedSpaceMissing by rememberSaveable(route.id) { mutableStateOf(false) }
    LaunchedEffect(state.spaces, route.id) {
        if (linkedSpaceApplied || !state.spacesState.hasLoaded) return@LaunchedEffect
        val linked = state.spaces.firstOrNull { sameWikiId(it.id, route.id) }
        linkedSpaceApplied = true
        if (linked == null) linkedSpaceMissing = true else store.select(linked.slug)
    }
    val space = state.currentSpace
    // The space on screen, read and looked at: as the home opens, and again when another is picked. What came after the
    // reader's last look is new, and this look moves the stamp (design §12.3.2, the web home's `readWikiSeen`, then
    // `moveWikiSeen`).
    LaunchedEffect(store, space?.slug, linkedSpaceApplied) {
        // Opened before the drawer read the spaces: the head waits for them, then this runs again.
        if (space == null) { store.loadSpaces(); return@LaunchedEffect }
        if (!linkedSpaceApplied || linkedSpaceMissing) return@LaunchedEffect
        seen = store.seen(space.slug); store.moveSeen(space.slug)
        wikiHomeLoad(store)
    }
    if (state.disabled) {
        PageBar.Bind(route, title = "")
        WikiDisabledNote()
        return
    }
    if (linkedSpaceMissing || !linkedSpaceApplied) {
        PageBar.Bind(route, title = "")
        Box(Modifier.fillMaxSize().testTag(if (linkedSpaceMissing) "wiki-space-unavailable" else "wiki-home-loading"), contentAlignment = Alignment.Center) {
            if (linkedSpaceMissing) StatusMessage(WikiCopy.spaceUnavailable, WikiCopy.spaceUnavailableNote) else LoadingMessage("Loading…")
        }
        return
    }
    if (space == null) {
        PageBar.Bind(route, title = "")
        WikiHomePlaceholder(state) { scope.launch { store.loadSpaces() } }
        return
    }
    // The page's own header carries the title; the bar takes it once the header scrolls away (iOS's large title). The
    // bar's actions are the web head's — Contents, Activity, Settings — and Activity wears the drawer's number.
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    val headerOnScreen by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    PageBar.Bind(route, title = if (headerOnScreen) "" else WikiCopy.title) {
        BarIcon(R.drawable.ic_contents, WikiArticleCopy.contents, "wiki-bar-contents") { contentsShown = true }
        WikiActivityButton(state.waiting) { nav.open(OrbitRoute(Destination.WIKI_ACTIVITY)) }
        BarIcon(R.drawable.ic_settings, WikiModeCopy.settings, "wiki-bar-settings") { nav.open(OrbitRoute(Destination.WIKI_SETTINGS)) }
    }
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { wikiHomeLoad(store) } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-home")) {
        WikiHomePage(space, state, seen, store, nav, listState, retry = { scope.launch { wikiHomeLoad(store) } },
            // The home reads the space picked as its effect's key changes.
            pickSpace = store::select, manageSpaces = { nav.open(OrbitRoute(Destination.WIKI_SETTINGS)) })
    }
    if (contentsShown) WikiContentsSheet(store, WikiContentsAt.Home, wikiMaintenanceRunnerOnline(space, data), close = { contentsShown = false }) { pick ->
        // The home is where the reader already is; the rest open as pages.
        if (pick != WikiContentsPick.Home) wikiGo(pick, nav)
    }
}

/** The home's reads, and the plan's beside them — the count on the Contents' Plan row. */
private suspend fun wikiHomeLoad(store: WikiStore) = kotlinx.coroutines.coroutineScope {
    val plan = launch { store.loadPlan() }
    store.loadHome()
    plan.join()
}

/** The Wiki reached on an account the server has not switched the wiki on for — a link, or a page kept from before: the
 * web page's own sentence, not a failure to retry (iOS `WikiDisabledNote`). */
@Composable
internal fun WikiDisabledNote() {
    Box(Modifier.fillMaxSize().testTag("wiki-disabled"), contentAlignment = Alignment.Center) { StatusMessage(WikiCopy.title, WikiCopy.disabledNote) }
}

/** What stands where the home would be before there is a space to draw: a spinner, the reason the spaces could not be
 * read, or — only after a read that succeeded — that there is no space yet. */
@Composable
private fun WikiHomePlaceholder(state: WikiState, retry: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        when {
            state.spacesState.lastLoadFailed -> StatusMessage("The wiki couldn't be loaded", "Check the connection, then try again.", retry)
            state.spacesState.hasLoaded && state.spaces.isEmpty() -> StatusMessage(WikiCopy.title, WikiCopy.noSpaces)
            else -> LoadingMessage("Loading…")
        }
    }
}

@Composable
private fun WikiHomePage(space: WikiSpace, state: WikiState, seen: Double?, store: WikiStore, nav: WikiNav,
    listState: androidx.compose.foundation.lazy.LazyListState, retry: () -> Unit, pickSpace: (String) -> Unit, manageSpaces: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var hits by remember { mutableStateOf<List<WikiSearchHit>>(emptyList()) }
    var searched by rememberSaveable { mutableStateOf("") }
    val searching = query.trim { it == ' ' }.isNotEmpty()
    LaunchedEffect(query) {
        val text = query
        if (text.trim { it == ' ' }.isEmpty()) { hits = emptyList(); searched = ""; return@LaunchedEffect }
        delay(250)
        // A failed search reads as no results, as iOS's `try?` does.
        val found = try { store.search(text) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { emptyList() }
        hits = found; searched = text
    }
    fun openEntry(id: String) = nav.entry(id)
    val principles = WikiLogic.principles(state.principles)
    val now = rememberMinuteClock()
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-home-list"), state = listState) {
        item(key = "header") { HomeHeader(space, state.spaces, pickSpace, manageSpaces) }
        item(key = "search") { SearchField(query) { query = it } }
        if (!searching) {
            if (state.homeLoading) {
                if (state.homeState.lastLoadFailed) item(key = "failed") {
                    StatusMessage("The wiki couldn't be loaded", "Check the connection, then try again.", retry)
                }
            } else {
                item(key = "principles") {
                    WikiBandHeader(WikiCopy.principles, principles.size,
                        badge = if (principles.isNotEmpty() && principles.all { it.trust == "owner" }) WikiCopy.trustLabel("owner") else null)
                }
                if (principles.isEmpty()) item(key = "principles-empty") { WikiEmptyLine(WikiCopy.noPrinciples) }
                items(principles, key = { "principle:${it.id}" }) { entry ->
                    WikiRowButton("wiki-entry:${entry.id}", onClick = { openEntry(entry.id) }) {
                        WikiRowLabel(entry.displayTitle, WikiDate.relative(entry.validFrom, now), entry.summary, struck = entry.isEnded,
                            dot = seen?.let { if (WikiSeenLog.isNew(entry.validFrom, it)) wikiNewDot(true) else null })
                    }
                }
            }
            item(key = "end") { Spacer(Modifier.height(24.dp)) }
        } else {
            if (hits.isEmpty() && searched == query && query.isNotEmpty()) item(key = "no-results") {
                // iOS's system `ContentUnavailableView.search(text:)`, in its English words.
                StatusMessage("No Results for “$query”", "Check the spelling or try a new search.")
            } else items(hits, key = { "hit:${it.id}" }) { hit ->
                WikiRowButton("wiki-hit:${hit.id}", onClick = { openEntry(hit.id) }) {
                    WikiRowLabel(hit.title ?: hit.id, detail = listOf(WikiCopy.kindLabel(hit.kind), hit.summary ?: "").filter { it.isNotEmpty() }.joinToString(" · "))
                }
            }
        }
    }
}

/** The title and the space on one row — the web's page head. */
@Composable
private fun HomeHeader(space: WikiSpace, spaces: List<WikiSpace>, pickSpace: (String) -> Unit, manageSpaces: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(WikiCopy.title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.headlineLarge)
        WikiSpacePicker(space, spaces, pickSpace, manageSpaces)
    }
}

/** The space beside the title, by the name a reader knows it by (design §12.3.4, mock 31 ④; iOS `WikiSpacePicker`): with
 * one space a grey label and no control; with several a menu of every space, the current one ticked — its name, the
 * repository and its documents under it, what waits in it as the amber number — and Manage spaces at the foot, into Wiki
 * settings. */
@Composable
internal fun WikiSpacePicker(space: WikiSpace, spaces: List<WikiSpace>, pick: (String) -> Unit, manage: () -> Unit) {
    val names = WikiSpaceLogic.names(spaces)
    val name = names[space.id] ?: space.title ?: space.slug
    val capsule = Modifier.background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f), CircleShape)
    if (spaces.size < 2) {
        // The name is its own text: as a state as well, TalkBack read it twice.
        Box(capsule.padding(horizontal = 12.dp, vertical = 6.dp).testTag("wiki-space-picker")
            .semantics(mergeDescendants = true) { contentDescription = WikiCopy.spacePickerHint }) {
            Text(name, style = WikiType.label, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        return
    }
    var expanded by remember { mutableStateOf(false) }
    Box {
        Row(capsule.clickable(role = Role.Button) { expanded = true }.heightIn(min = 36.dp).padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag("wiki-space-picker").semantics(mergeDescendants = true) { contentDescription = WikiCopy.spacePickerHint },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(name, Modifier.weight(1f, fill = false), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(painterResource(R.drawable.ic_chevron_updown), null, Modifier.size(14.dp))
        }
        DropdownMenu(expanded, { expanded = false }) {
            WikiSpaceLogic.menuRows(spaces, names).forEach { row ->
                val current = row.id == space.id
                DropdownMenuItem(modifier = Modifier.testTag("wiki-space:${row.slug}").semantics { selected = current },
                    leadingIcon = { if (current) Icon(painterResource(R.drawable.ic_check), null) else Spacer(Modifier.size(24.dp)) },
                    text = {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(row.name)
                            Text(row.subtitle(sayWaiting = false), style = WikiType.label, color = WikiPalette.secondary)
                        }
                    },
                    trailingIcon = if (row.waiting > 0) ({ WikiWaitingBadge(row.waiting, WikiCopy.spaceWaiting(row.waiting).removePrefix("· ")) }) else null,
                    onClick = { expanded = false; if (!current) pick(row.slug) })
            }
            HorizontalDivider()
            DropdownMenuItem(modifier = Modifier.testTag("wiki-space-manage"), text = { Text(WikiCopy.manageSpaces) },
                leadingIcon = { Icon(painterResource(R.drawable.ic_settings), null) }, onClick = { expanded = false; manage() })
        }
    }
}

/** What waits on the owner as an amber number in a circle — said in [words] to TalkBack. */
@Composable
internal fun WikiWaitingBadge(count: Int, words: String) {
    Text("$count", Modifier.background(Color(0xFFFF9500), CircleShape).padding(horizontal = 6.dp, vertical = 1.dp)
        .semantics { contentDescription = words }, color = Color.White, style = WikiType.meta.copy(fontWeight = FontWeight.SemiBold))
}

/** The bar's way into Activity (design §12.3.2): the history mark, with the drawer's orange number in its corner — what
 * waits on the owner across every space — and nothing at zero; TalkBack says "Activity" and the number in words. */
@Composable
internal fun WikiActivityButton(waiting: Int, onClick: () -> Unit) {
    IconButton(onClick = onClick, modifier = Modifier.testTag("wiki-bar-activity")
        .semantics { if (waiting > 0) stateDescription = WikiCopy.waitingOnYou(waiting) }) {
        BadgedBox(badge = {
            if (waiting > 0) Badge(Modifier.testTag("wiki-bar-activity-badge").clearAndSetSemantics {}, containerColor = Color(0xFFFF9500),
                contentColor = Color.White) { Text("$waiting") }
        }) { Icon(painterResource(R.drawable.ic_history), WikiCopy.activity) }
    }
}

/** The search under the title (the owner's call for iOS: under the title, never at the bottom). */
@Composable
private fun SearchField(query: String, change: (String) -> Unit) {
    val focus = LocalFocusManager.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f), RoundedCornerShape(10.dp)).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(painterResource(R.drawable.ic_search), null, Modifier.size(20.dp), tint = WikiPalette.secondary)
        BasicTextField(query, change, Modifier.weight(1f).heightIn(min = 40.dp).wrapContentHeight(Alignment.CenterVertically).testTag("wiki-search"),
            singleLine = true, textStyle = WikiType.prose.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
            keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = { focus.clearFocus() }),
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) Text(WikiCopy.searchPlaceholder, style = WikiType.prose, color = WikiPalette.secondary)
                    inner()
                }
            })
        if (query.isNotEmpty()) IconButton(onClick = { change("") }, Modifier.size(40.dp)) {
            Icon(painterResource(R.drawable.ic_clear), "Clear", Modifier.size(18.dp), tint = WikiPalette.secondary)
        }
    }
}

