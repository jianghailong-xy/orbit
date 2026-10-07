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

/** The Wiki section's root: the home page of the space the owner last picked (iOS `WikiHomeView`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiHomeScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    val now = rememberMinuteClock()
    var contentsShown by rememberSaveable { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    // A space a link named (`orbit://wiki/<spaceId>`) is picked once its row is known; the route keeps only the id.
    var linkedSpaceApplied by rememberSaveable(route.id) { mutableStateOf(route.id == null) }
    LaunchedEffect(store) { store.loadHome(); store.loadPlan(); store.loadDocsDirectory() }
    LaunchedEffect(state.spaces, route.id) {
        if (linkedSpaceApplied || !state.spacesState.hasLoaded) return@LaunchedEffect
        val linked = state.spaces.firstOrNull { sameWikiId(it.id, route.id) }
        linkedSpaceApplied = true
        if (linked != null && linked.slug != state.currentSpace?.slug) {
            store.select(linked.slug); store.loadHome(); store.loadPlan(); store.loadDocsDirectory()
        }
    }
    PageBar.Bind(route, title = "") {
        BarIcon(R.drawable.ic_contents, WikiArticleCopy.contents, "wiki-bar-contents") { contentsShown = true }
        BarIcon(R.drawable.ic_settings, WikiModeCopy.settings, "wiki-bar-settings") { nav.open(OrbitRoute(Destination.WIKI_SETTINGS)) }
    }
    val runnerOnline = wikiMaintenanceRunnerOnline(state.currentSpace, data)
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.loadHome(); store.loadPlan() } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-home")) {
        val home = state.home
        if (home != null) {
            val plan = state.plan
            val banner = plan?.let { p -> WikiPlanLogic.look(p, runnerOnline)?.let { look ->
                val docs = state.docsDirectory?.takeIf { it.plan != null }?.docs?.let { it.written to it.total }
                WikiPlanLogic.banner(look, p, now, docs, runnerOnline)
            } }
            WikiHomePage(home, now, banner, store, nav, openSettings = { nav.open(OrbitRoute(Destination.WIKI_SETTINGS)) }) { slug ->
                store.select(slug)
                // iOS reloads only the home here; the plan banner and the docs counts are read again too, so they never speak for the old space.
                scope.launch { store.loadHome(); store.loadPlan(); store.loadDocsDirectory() }
            }
        } else WikiHomePlaceholder(state) { scope.launch { store.loadHome() } }
    }
    if (contentsShown) WikiContentsSheet(store, WikiContentsAt.Home, runnerOnline, close = { contentsShown = false }) { pick ->
        // The home is where the reader already is; the rest open as pages.
        if (pick != WikiContentsPick.Home) wikiGo(pick, nav)
    }
}

/** A spinner, the reason the home could not be read, or — only after a read that succeeded — that there is no space yet. */
@Composable
private fun WikiHomePlaceholder(state: WikiState, retry: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        when {
            state.homeState.lastLoadFailed -> StatusMessage("The wiki couldn't be loaded", "Check the connection, then try again.", retry)
            state.homeState.hasLoaded && state.spaces.isEmpty() -> StatusMessage(WikiCopy.title, WikiCopy.noSpaces)
            else -> LoadingMessage("Loading…")
        }
    }
}

@Composable
private fun WikiHomePage(content: WikiHomeContent, now: Instant, planBanner: WikiPlanLogic.Banner?, store: WikiStore,
    nav: WikiNav, openSettings: () -> Unit, pickSpace: (String) -> Unit) {
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
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-home-list")) {
        item(key = "header") { HomeHeader(content, now, openSettings, { content.health?.maintenance?.lastRun?.sessionId?.let(nav::session) }, pickSpace) }
        item(key = "search") { SearchField(query) { query = it } }
        if (!searching) {
            if (content.proposals > 0) item(key = "review-banner") {
                HomeBanner(WikiCopy.proposalsToReview(content.proposals), amber = true, tag = "wiki-review-banner") { nav.open(OrbitRoute(Destination.WIKI_REVIEW)) }
            }
            if (planBanner != null) item(key = "plan-banner") {
                HomeBanner(planBanner.text, amber = planBanner.amber, tag = "wiki-plan-banner") {
                    nav.open(OrbitRoute(if (planBanner.toSettings) Destination.WIKI_SETTINGS else Destination.WIKI_PLAN))
                }
            }
            item(key = "principles") {
                WikiBandHeader(WikiCopy.principles, content.principles.size, badge = if (content.principlesAllOwner) WikiCopy.trustLabel("owner") else null)
            }
            if (content.principles.isEmpty()) item(key = "principles-empty") { WikiEmptyLine(WikiCopy.noEntries) }
            items(content.principles, key = { "principle:${it.id}" }) { entry ->
                WikiRowButton("wiki-entry:${entry.id}", onClick = { openEntry(entry.id) }) {
                    WikiRowLabel(entry.displayTitle, WikiDate.relative(entry.validFrom, now), entry.summary, struck = entry.isEnded)
                }
            }
            item(key = "decisions") { WikiBandHeader(WikiCopy.recentDecisions, content.recentDecisions.size) }
            if (content.recentDecisions.isEmpty()) item(key = "decisions-empty") { WikiEmptyLine(WikiCopy.noDecisions) }
            items(content.recentDecisions, key = { "decision:${it.id}" }) { entry ->
                val line = listOf(WikiCopy.statusLabel(entry.status), entry.summary ?: "").filter { it.isNotEmpty() }.joinToString(" · ")
                WikiRowButton("wiki-entry:${entry.id}", onClick = { openEntry(entry.id) }) {
                    WikiRowLabel(entry.displayTitle, WikiDate.monthDay(entry.validFrom), line, struck = entry.isEnded)
                }
            }
            item(key = "changed") { WikiBandHeader(WikiCopy.recentlyChanged) }
            if (content.timeline.isEmpty()) item(key = "changed-empty") { WikiEmptyLine(WikiCopy.noChanges) }
            else items(content.recentRows, key = { it.id }) { row ->
                when (row) {
                    is WikiModeLogic.RecentRow.Op -> ChangeRow(row.item, now) { row.item.entryId?.let(::openEntry) }
                    is WikiModeLogic.RecentRow.Run -> {
                        val summary = content.run(row.changesetId)?.let(WikiModeLogic::runSummary)
                        val line = (listOf(WikiModeCopy.appliedChanges(summary?.applied ?: row.items.size)) +
                            (summary?.let(WikiModeLogic::runCounts) ?: emptyList())).joinToString(" · ")
                        WikiRowButton("wiki-run:${row.changesetId}", onClick = { nav.open(OrbitRoute(Destination.WIKI_RUN, row.changesetId)) }) {
                            WikiRowLabel(WikiModeCopy.originWord(row.origin), WikiDate.relative(row.at, now), line)
                        }
                    }
                }
            }
            item(key = "agents") { WikiBandHeader(WikiCopy.agentsUsed, hint = WikiCopy.agentsUsedHint) }
            val usage = content.space.usage
            if (content.usedThisWeek && usage != null) {
                item(key = "usage-stats") {
                    Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                        Stat(usage.sessionsPushed ?: 0, WikiCopy.sessionsReceived); Stat(usage.searches ?: 0, WikiCopy.searches)
                    }
                }
                items(content.mostUsed, key = { "used:${it.entryId}" }) { used ->
                    WikiRowButton("wiki-used:${used.entryId}", onClick = { openEntry(used.entryId) }) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(used.title ?: used.entryId, Modifier.weight(1f), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("${used.total ?: 0}×", style = WikiType.label, color = WikiPalette.secondary)
                        }
                    }
                }
            } else item(key = "usage-empty") { WikiEmptyLine(WikiCopy.noAgentsYet) }
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

/** Title and space on one row (the web's page head), and the status line under them. */
@Composable
private fun HomeHeader(content: WikiHomeContent, now: Instant, openSettings: () -> Unit, openRun: () -> Unit, pickSpace: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(WikiCopy.title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.headlineLarge)
            SpacePicker(content, pickSpace)
        }
        Text(wikiStatusText(content.statusParts(now), openSettings, openRun), Modifier.testTag("wiki-status-line"),
            style = WikiType.label, color = WikiPalette.secondary)
    }
}

/** The space as a capsule beside the title: a menu of every space, the current one ticked, each with its repository. */
@Composable
private fun SpacePicker(content: WikiHomeContent, pickSpace: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        Row(Modifier.background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f), CircleShape).clickable(role = Role.Button) { expanded = true }
            .heightIn(min = 36.dp).padding(horizontal = 12.dp, vertical = 6.dp).testTag("wiki-space-picker")
            .semantics(mergeDescendants = true) { contentDescription = WikiCopy.spacePickerHint; stateDescription = content.space.slug },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(content.space.slug, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
            Icon(painterResource(R.drawable.ic_chevron_updown), null, Modifier.size(14.dp))
        }
        DropdownMenu(expanded, { expanded = false }) {
            content.spaces.forEach { space ->
                val current = space.id == content.space.id
                DropdownMenuItem(modifier = Modifier.testTag("wiki-space:${space.slug}"),
                    leadingIcon = { if (current) Icon(painterResource(R.drawable.ic_check), null) else Spacer(Modifier.size(24.dp)) },
                    text = { Column { Text(space.slug); space.repoUrlNorm?.let { Text(it, style = WikiType.label, color = WikiPalette.secondary) } } },
                    onClick = { expanded = false; if (!current) pickSpace(space.slug) })
            }
        }
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

/** The needs-you bar's shape: a wash, the dot, the words and a chevron — the whole bar one press. */
@Composable
private fun HomeBanner(text: String, amber: Boolean, tag: String, onClick: () -> Unit) {
    val dot = if (amber) Color(0xFFFF9500) else MaterialTheme.colorScheme.primary
    Row(Modifier.fillMaxWidth().background(if (amber) WikiPalette.amberWash else MaterialTheme.colorScheme.primary.copy(alpha = 0.10f))
        .clickable(role = Role.Button, onClick = onClick).heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp).testTag(tag)
        .semantics(mergeDescendants = true) { contentDescription = text },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        Box(Modifier.size(7.dp).background(dot, CircleShape))
        Text(text, Modifier.weight(1f), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = WikiPalette.secondary)
    }
}

/** One change: the entry, when, and what happened to it, with the mark a review mode applied it with. */
@Composable
private fun ChangeRow(item: WikiTimelineItem, now: Instant, onClick: () -> Unit) {
    val ended = item.status == "retired" || item.status == "superseded" || item.status == "rejected"
    val line = listOf(WikiLogic.changeVerb(item), WikiCopy.kindLabel(item.kind)).filter { it.isNotEmpty() }.joinToString(" · ")
    val marked = item.appliedByMode != null && !ended && (item.trust == "auto" || item.trust == "unreviewed")
    WikiRowButton("wiki-change:${item.opId}", enabled = item.entryId != null, onClick = onClick) {
        WikiRowLabel(item.title ?: "—", WikiDate.relative(item.at, now), line, WikiLogic.changeNote(item), ended, if (marked) item.trust else null)
    }
}

@Composable
private fun Stat(value: Int, label: String) {
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Text("$value", style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold))
        Text(label, style = WikiType.label, color = WikiPalette.secondary)
    }
}
