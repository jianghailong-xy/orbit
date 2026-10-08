package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.launch
import java.time.Instant

// Activity (wiki design §12.3.2, mock 31 ②; iOS `WikiActivityView.swift`, 42d12db2b): what the Wiki home said besides its
// content — the status line, what waits on the owner, the decisions, the changes and the agents' use — in the order
// `WikiLogic.ActivityBand` holds to the web's `WikiActivityPage.tsx`. Its bar is Review's: the title, and the space's name
// as its second line. The screen reads the store and decides where a press goes; the page draws what it is given.

/** Activity over the store: the space's own five reads, its plan and the documents its blue banner counts, and the plans
 * of the other spaces where something waits — and when the reader last looked, read as the page opens from before the
 * home moved it, then moved to now. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiActivityScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    val now = rememberMinuteClock()
    var refreshing by remember { mutableStateOf(false) }
    /** When the reader last looked: nil until it is read, and nothing is marked before then. */
    var seen by remember { mutableStateOf<Double?>(null) }
    val space = state.currentSpace
    LaunchedEffect(store, space?.slug) {
        space?.slug?.let { slug -> seen = store.seenBefore(slug); store.moveSeen(slug) }
        val held = store.state.value.activity
        if (held == null || !sameWikiId(held.space.id, store.state.value.currentSpace?.id)) store.loadActivity()
        store.loadPlan(); store.loadDocsDirectory(); store.loadOtherPlans()
    }
    PageBar.Bind(route, title = WikiCopy.activity, subtitle = space?.let { WikiSpaceLogic.name(it, state.spaces) })
    val content = state.activity
    if (state.disabled) { WikiDisabledNote(); return }
    if (content == null || space == null) {
        Box(Modifier.fillMaxSize().testTag("wiki-activity-loading"), contentAlignment = Alignment.Center) {
            when {
                state.activityState.lastLoadFailed -> StatusMessage("The wiki couldn't be loaded", "Check the connection, then try again.") {
                    scope.launch { store.loadActivity() }
                }
                state.spacesState.hasLoaded && state.spaces.isEmpty() -> StatusMessage(WikiCopy.title, WikiCopy.noSpaces)
                else -> LoadingMessage("Loading…")
            }
        }
        return
    }
    val plans = state.otherPlans + (state.plan?.let { mapOf(space.id to it) } ?: emptyMap())
    val docs = state.docsDirectory?.takeIf { it.plan != null }?.docs?.let { it.written to it.total }
    val banners = WikiSpaceLogic.activityBanners(state.spaces, space, plans, now, docs) { wikiMaintenanceRunnerOnline(it, data) }
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.loadActivity(); store.loadPlan(); store.loadOtherPlans() } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("wiki-activity")) {
        WikiActivityPage(content, banners, seen, now, state.currentJobs,
            openEntry = nav::entry,
            openRun = { id -> nav.open(OrbitRoute(Destination.WIKI_RUN, id)) },
            openSettings = { nav.open(OrbitRoute(Destination.WIKI_SETTINGS)) },
            openSession = nav::session,
            openJob = nav::job,
            openBanner = { banner -> openActivityBanner(banner.to, store, nav) { scope.launch { store.loadActivity() } } })
    }
}

/** A banner's way: Review over every space; or a space's plan, or its settings — another space's first becoming the one on
 * screen, as the web's link to its page does. */
private fun openActivityBanner(to: WikiSpaceLogic.ActivityBanner.To, store: WikiStore, nav: WikiNav, reload: () -> Unit) {
    val (slug, destination) = when (to) {
        WikiSpaceLogic.ActivityBanner.To.Review -> { nav.open(OrbitRoute(Destination.WIKI_REVIEW)); return }
        is WikiSpaceLogic.ActivityBanner.To.Plan -> to.slug to Destination.WIKI_PLAN
        is WikiSpaceLogic.ActivityBanner.To.Settings -> to.slug to Destination.WIKI_SETTINGS
    }
    if (store.state.value.currentSpace?.slug != slug) { store.select(slug); reload() }
    nav.open(OrbitRoute(destination))
}

/** Activity's page: the status line; the banners — every space's proposals, the space's plan, the plans of the other spaces
 * that wait on the owner; then Recent decisions, Recently changed with what came after the reader last looked, and
 * Agents used the wiki. */
@Composable
internal fun WikiActivityPage(content: WikiHomeContent, banners: List<WikiSpaceLogic.ActivityBanner>, seen: Double?, now: Instant,
    jobs: List<WikiJob>?, openEntry: (String) -> Unit, openRun: (String) -> Unit, openSettings: () -> Unit, openSession: (String) -> Unit,
    openJob: (String) -> Unit, openBanner: (WikiSpaceLogic.ActivityBanner) -> Unit) {
    // How many rows came after the reader last looked, and each row's dot: none before the stamp is read.
    val newRows = seen?.let(content::newRows) ?: 0
    fun isNew(at: String?): Boolean? = seen?.let { WikiSeenLog.isNew(at, it) }
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-activity-list")) {
        WikiLogic.ActivityBand.entries.forEach { band ->
            when (band) {
                WikiLogic.ActivityBand.STATUS -> item(key = "status") {
                    Text(wikiStatusText(content.statusParts(now), openSettings) {
                        // A run the server's job made has no session: its page is the run's call log (P9).
                        val last = content.health?.maintenance?.lastRun
                        if (last?.jobId != null) openJob(last.jobId) else last?.sessionId?.let(openSession)
                    },
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-status-line"),
                        style = WikiType.label, color = WikiPalette.secondary)
                }
                WikiLogic.ActivityBand.REVIEW_BANNER, WikiLogic.ActivityBand.PLAN_BANNERS, WikiLogic.ActivityBand.OTHER_PLAN_BANNERS ->
                    items(banners.filter { it.band == band }, key = { "banner:${it.id}" }) { banner ->
                        WikiBannerRow(banner.text, banner.amber,
                            if (banner.band == WikiLogic.ActivityBand.REVIEW_BANNER) "wiki-review-banner" else "wiki-activity-banner:${banner.id}") { openBanner(banner) }
                    }
                WikiLogic.ActivityBand.RUNS -> if (WikiRunsLogic.shown(content.health?.serverExecutes == true, jobs)) {
                    item(key = "runs-head") { RunsBandHead(content.health?.systemModel) }
                    if (jobs.isNullOrEmpty()) item(key = "runs-empty") { WikiEmptyLine(WikiRunsCopy.none) }
                    else items(jobs, key = { "job:${it.id}" }) { job ->
                        WikiRunRowView(WikiRunsLogic.row(job, now)) { openJob(job.id) }
                    }
                }
                WikiLogic.ActivityBand.RECENT_DECISIONS -> {
                    item(key = "decisions") { WikiBandHeader(WikiCopy.recentDecisions, content.recentDecisions.size) }
                    if (content.recentDecisions.isEmpty()) item(key = "decisions-empty") { WikiEmptyLine(WikiCopy.noDecisions) }
                    items(content.recentDecisions, key = { "decision:${it.id}" }) { entry ->
                        val line = listOf(WikiCopy.statusLabel(entry.status), entry.summary ?: "").filter { it.isNotEmpty() }.joinToString(" · ")
                        WikiRowButton("wiki-entry:${entry.id}", onClick = { openEntry(entry.id) }) {
                            WikiRowLabel(entry.displayTitle, WikiDate.monthDay(entry.validFrom), line, struck = entry.isEnded)
                        }
                    }
                }
                WikiLogic.ActivityBand.RECENTLY_CHANGED -> {
                    item(key = "changed") {
                        WikiBandHeader(WikiCopy.recentlyChanged, new = if (newRows > 0) WikiCopy.newSinceLastLooked(newRows) else null)
                    }
                    if (content.timeline.isEmpty()) item(key = "changed-empty") { WikiEmptyLine(WikiCopy.noChanges) }
                    // One run is one row, by the changeset its items name; a row after the stamp wears the blue dot.
                    else items(content.recentRows, key = { it.id }) { row ->
                        when (row) {
                            is WikiModeLogic.RecentRow.Op -> WikiChangeRow(row.item, now, isNew(row.item.at)) { row.item.entryId?.let(openEntry) }
                            is WikiModeLogic.RecentRow.Run -> {
                                val summary = content.run(row.changesetId)?.let(WikiModeLogic::runSummary)
                                val line = (listOf(WikiModeCopy.appliedChanges(summary?.applied ?: row.items.size)) +
                                    (summary?.let(WikiModeLogic::runCounts) ?: emptyList())).joinToString(" · ")
                                WikiRowButton("wiki-run:${row.changesetId}", onClick = { openRun(row.changesetId) }) {
                                    WikiRowLabel(WikiModeCopy.originWord(row.origin), WikiDate.relative(row.at, now), line, dot = isNew(row.at)?.let { wikiNewDot(it) })
                                }
                            }
                        }
                    }
                }
                WikiLogic.ActivityBand.AGENTS_USED -> {
                    item(key = "agents") { WikiBandHeader(WikiCopy.agentsUsed, hint = WikiCopy.agentsUsedHint) }
                    val usage = content.space.usage
                    if (content.usedThisWeek && usage != null) {
                        item(key = "usage-stats") {
                            Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                                WikiStat(usage.sessionsPushed ?: 0, WikiCopy.sessionsReceived); WikiStat(usage.searches ?: 0, WikiCopy.searches)
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
                }
            }
        }
        item(key = "end") { Spacer(Modifier.height(24.dp)) }
    }
}

/** Blue for what came after the reader last looked, grey for what came before. */
@Composable
internal fun wikiNewDot(new: Boolean): Color = if (new) WikiPalette.color(WikiTone.BLUE) else WikiPalette.secondary.copy(alpha = 0.5f)

/** The needs-you bar's shape: a wash, the dot, the words and a chevron — the whole bar one press. Amber for what waits on
 * the owner, blue for what the plan is doing. */
@Composable
internal fun WikiBannerRow(text: String, amber: Boolean, tag: String, onClick: () -> Unit) {
    val dot = if (amber) Color(0xFFFF9500) else MaterialTheme.colorScheme.primary
    // Its words are its own text: a label repeating them made TalkBack read the bar twice.
    Row(Modifier.fillMaxWidth().background(if (amber) WikiPalette.amberWash else MaterialTheme.colorScheme.primary.copy(alpha = 0.10f))
        .clickable(role = Role.Button, onClick = onClick).heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
        Box(Modifier.size(7.dp).background(dot, CircleShape))
        Text(text, Modifier.weight(1f), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = WikiPalette.secondary)
    }
}

/** One change: the entry, when, and what happened to it, with the mark a review mode applied it with — and Activity's
 * dot, blue for what came after the reader last looked ([new]; none when the stamp is not read yet). */
@Composable
internal fun WikiChangeRow(item: WikiTimelineItem, now: Instant, new: Boolean?, onClick: () -> Unit) {
    val ended = item.status == "retired" || item.status == "superseded" || item.status == "rejected"
    val line = listOf(WikiLogic.changeVerb(item), WikiCopy.kindLabel(item.kind)).filter { it.isNotEmpty() }.joinToString(" · ")
    val marked = item.appliedByMode != null && !ended && (item.trust == "auto" || item.trust == "unreviewed")
    WikiRowButton("wiki-change:${item.opId}", enabled = item.entryId != null, onClick = onClick) {
        WikiRowLabel(item.title ?: "—", WikiDate.relative(item.at, now), line, WikiLogic.changeNote(item), ended, if (marked) item.trust else null,
            dot = new?.let { wikiNewDot(it) })
    }
}

@Composable
internal fun WikiStat(value: Int, label: String) {
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Text("$value", style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold))
        Text(label, style = WikiType.label, color = WikiPalette.secondary)
    }
}

/** The Runs band's heading, a band heading's shape: the System model and its state beside it, as the web card's head
 * says them — never where the model answers (P9, as main drew it on the Wiki page). */
@Composable
private fun RunsBandHead(model: WikiSystemModelStatus?) {
    Row(Modifier.fillMaxWidth().padding(start = 32.dp, end = 16.dp, top = 18.dp, bottom = 4.dp)
        .semantics(mergeDescendants = true) { heading() }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(WikiRunsCopy.runs, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold))
        if (model != null) {
            Text(WikiRunsCopy.systemModelLabel(model.model), Modifier.weight(1f), style = WikiType.label, color = WikiPalette.secondary,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            WikiModelStateText(model)
        }
    }
}
