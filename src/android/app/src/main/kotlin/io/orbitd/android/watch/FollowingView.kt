package io.orbitd.android.watch

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitNavigation
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.launch
import java.time.Instant

/** The WATCH destination: `route.id == null` is Following (iOS `FollowingListView`), a watch id is that watch's
 * record (iOS `WatchDetailView`) — an older or deep-linked one the list doesn't hold is fetched before it is called
 * missing. Following has no drawer row, as on iOS: it is reached through a watch's link. */
@Composable
fun WatchDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, open: (OrbitRoute) -> Unit) =
    WatchDestination(app, handle, route, navigate = {}, open = open)

/** The same, with the shell's navigation, so a linked watch can put Following under itself. */
@Composable
fun WatchDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute,
    navigate: ((OrbitNavigation) -> OrbitNavigation) -> Unit, open: (OrbitRoute) -> Unit) {
    val store = remember(handle) { WatchStore.of(app.session, handle, app.processScope) }
    if (!store.live()) return
    // iOS's `.watch(id)` opens the Following section with the record on top: Back from a watch lands on Following.
    if (route.id != null) LaunchedEffect(route) { navigate { it.withFollowingUnder(route) } }
    val sessionTitle = rememberSessionTitles(app, handle)
    Box(Modifier.fillMaxSize().testTag("watch-destination")) {
        val id = route.id
        if (id == null) FollowingScreen(store, route, sessionTitle, open)
        else WatchDetailScreen(store, route, id, sessionTitle, open)
    }
    // After the page, so Following's own read on appearing is the one the 30 s floor counts from.
    WatchFeed(app, handle, store)
}

/** A watch's record with Following under it, where the link was followed from below that (iOS's Following section,
 * on the stack the link was opened on, so Back still returns to the source). A record opened from Following is left. */
internal fun OrbitNavigation.withFollowingUnder(route: OrbitRoute): OrbitNavigation {
    if (current != route || route.id == null) return this
    val below = frames.getOrNull(frames.size - 2)
    if (below?.destination == Destination.WATCH && below.id == null) return this
    return copy(stacks = stacks + (section to (frames.dropLast(1) + OrbitRoute(Destination.WATCH, origin = Origin.LINK) + route)))
}

/** Following: the watches kept on sessions and tasks — yours and your agents' — in the sections
 * `WatchProjection.sections` decides: Needs attention, Active, History. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun FollowingScreen(store: WatchStore, route: OrbitRoute, sessionTitle: (String?) -> String?, open: (OrbitRoute) -> Unit) {
    PageBar.Bind(route, "Following")
    val state by store.state.collectAsState()
    // "Last evaluated" and the stale flag are relative to now: redraw between fetches.
    val now = rememberWatchClock()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(store) { store.load() }
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
        scope.launch { refreshing = true; try { store.load() } finally { refreshing = false } }
    }, modifier = Modifier.fillMaxSize().testTag("following")) {
        val sections = WatchProjection.sections(state.watches, now)
        LazyColumn(Modifier.fillMaxSize().testTag("following-list")) {
            sections.forEach { section ->
                item(key = "section:${section.group.name}") {
                    WatchSectionHeader(section.group.title, Modifier.testTag("following-section:${section.group.name}"))
                }
                items(section.watches, key = { "watch:${it.id}" }) { watch ->
                    FollowingRow(watch, now, sessionTitle(watch.observerSessionId), Modifier
                        .clickable(role = Role.Button) { open(OrbitRoute(Destination.WATCH, watch.id)) }
                        .testTag("following-row:${watch.id}"))
                }
            }
        }
        FollowingPlaceholder(state) { scope.launch { store.load() } }
    }
}

/** One watch as a Following row: what it's doing and for what, then how fresh that is — or, once it ended, what
 * its delivery did. A reason it needs attention takes that last line, in orange. */
@Composable
internal fun FollowingRow(watch: Watch, now: Instant, observerTitle: String?, modifier: Modifier = Modifier) {
    val attention = WatchProjection.attention(watch, now)
    val orange = WatchPalette.orange
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(followingSymbol(watch.state), null, Modifier.padding(top = 2.dp).size(20.dp),
            tint = if (attention.isEmpty()) followingTint(watch.state) else orange)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(WatchProjection.headline(watch), Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyLarge)
                if (WatchStateMachine.isLive(watch.state)) Text(WatchProjection.progress(watch), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium, color = WatchPalette.secondary)
            }
            Text(WatchProjection.condition(watch.predicate, WatchProgress.of(watch.targets).live), maxLines = 2, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium, color = WatchPalette.secondary)
            Text(attention.firstOrNull()?.text ?: followingFootnote(watch, now, observerTitle), maxLines = 2, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelSmall, color = if (attention.isEmpty()) WatchPalette.secondary else orange)
        }
    }
}

/** What happens when it holds, then a live watch's freshness or deadline, or what an ended one did. */
internal fun followingFootnote(watch: Watch, now: Instant, observerTitle: String?): String {
    val action = WatchProjection.action(watch, observerTitle)
    val tail = when (watch.state) {
        WatchState.ACTIVE -> WatchProjection.lastEvaluated(watch, now)
        WatchState.PAUSED -> WatchProjection.deadline(watch, now)
        else -> WatchProjection.deliveryStatus(watch) ?: WatchTime.format(watch.updatedAt, now)
    }
    return if (tail == null) action else "$action · $tail"
}

private fun followingSymbol(state: WatchState): ImageVector = when (state) {
    WatchState.ACTIVE, WatchState.UNKNOWN -> WatchIcons.eye
    WatchState.PAUSED -> WatchIcons.pauseCircle
    WatchState.MATCHED -> WatchIcons.checkCircle
    WatchState.EXPIRED -> WatchIcons.clock
    WatchState.CANCELLED -> WatchIcons.stopCircle
    WatchState.REVOKED -> WatchIcons.lock
    WatchState.UNRESOLVABLE -> WatchIcons.questionCircle
}

@Composable
private fun followingTint(state: WatchState) = when (state) {
    WatchState.ACTIVE -> WatchPalette.accent
    WatchState.MATCHED -> WatchPalette.green
    else -> WatchPalette.secondary
}

/** What stands where the rows would be. Only a fetch that succeeded may say there's nothing to show. */
@Composable
private fun FollowingPlaceholder(state: WatchStore.State, retry: () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (state.unsupported) {
            WatchUnavailable(WatchIcons.eyeSlash, "Watches aren't available", "This server doesn't serve watches yet.",
                Modifier.testTag("following-unsupported"))
            return@Box
        }
        when (watchListPresentation(state.loadState, state.watches.isEmpty())) {
            WatchListPresentation.LOADING -> WatchSpinner(Modifier.testTag("following-loading"))
            WatchListPresentation.FAILED -> WatchUnavailable(WatchIcons.eye, "Watches couldn't be loaded", "Check the connection, then try again.",
                Modifier.testTag("following-failed")) {
                Button(onClick = retry, modifier = Modifier.testTag("following-retry")) { Text("Retry") }
            }
            WatchListPresentation.EMPTY -> WatchUnavailable(WatchIcons.eye, "Not following anything",
                "When you or an agent watches sessions or tasks, the watch shows up here: what it waits for, how far along it is, and what happens when it holds.",
                Modifier.testTag("following-empty"))
            WatchListPresentation.CONTENT -> Unit
        }
    }
}
