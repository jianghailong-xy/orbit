package io.orbitd.android.watch

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.launch
import java.time.Instant

/** One watch's page (iOS `WatchDetailView`). A deep link or a push can name a watch the list doesn't hold — an
 * older one — so a miss fetches it before saying so. */
@Composable
internal fun WatchDetailScreen(store: WatchStore, route: OrbitRoute, id: String, sessionTitle: (String?) -> String?,
    open: (OrbitRoute) -> Unit) {
    val state by store.state.collectAsState()
    val found = WatchIndex.find(id, state.watches)
    // The copy last shown, kept while a re-read list that dropped an older watch fetches it again.
    var last by remember(id) { mutableStateOf<Watch?>(null) }
    var missing by remember(id) { mutableStateOf(false) }
    LaunchedEffect(found) { if (found != null) { last = found; missing = false } }
    LaunchedEffect(id, found == null) {
        if (found != null) return@LaunchedEffect
        store.fetch(id)
        if (store.watch(id) == null) missing = true
    }
    val shown = found ?: last.takeIf { !missing }
    when {
        shown != null -> WatchDetailContent(store, shown, route, sessionTitle, open, opensTargets = true)
        missing -> WatchUnavailable(WatchIcons.eyeSlash, "Watch not found", "It may have been deleted, or this server doesn't serve watches.",
            Modifier.testTag("watch-not-found"))
        else -> WatchSpinner(Modifier.testTag("watch-loading"))
    }
}

/** A watch's whole record: what it's doing and for what, where each target stands, how fresh that is, what happens
 * when the condition holds, and every Match or end with what its delivery did (iOS `WatchDetailContent`). Its
 * controls are the bar's: Pause and Stop while ACTIVE, Resume and Stop while PAUSED, none once it ended — and no
 * Edit, which iOS parks until the server tells the waiting agent its condition changed. */
@Composable
internal fun WatchDetailContent(store: WatchStore, watch: Watch, route: OrbitRoute, sessionTitle: (String?) -> String?,
    open: (OrbitRoute) -> Unit, opensTargets: Boolean) {
    val now = rememberWatchClock()
    var busy by remember { mutableStateOf(false) }
    var errorText by rememberSaveable(watch.id) { mutableStateOf<String?>(null) }
    var confirmingStop by rememberSaveable(watch.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val current by rememberUpdatedState(watch)

    fun run(control: WatchControl) {
        busy = true
        errorText = null
        scope.launch { try { errorText = store.perform(control, current) } finally { busy = false } }
    }
    fun tap(control: WatchControl) {
        when (control) {
            WatchControl.VIEW, WatchControl.EDIT -> Unit
            WatchControl.STOP -> confirmingStop = true
            WatchControl.PAUSE, WatchControl.RESUME -> run(control)
        }
    }

    // No View here — the page IS the record — and no Edit (docs/watch-contract.md).
    val controls = WatchStateMachine.controls(watch.state).filter { it != WatchControl.VIEW && it != WatchControl.EDIT }
    PageBar.Bind(route, WatchProjection.headline(watch)) {
        controls.forEach { control ->
            TextButton(onClick = { tap(control) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)
                .testTag("watch:${watch.id}:${controlTag(control)}")) { Text(control.title) }
        }
    }

    val observerTitle = sessionTitle(watch.observerSessionId)
    val reasons = WatchProjection.attention(watch, now)
    LazyColumn(Modifier.fillMaxSize().testTag("watch-detail:${watch.id}"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item(key = "overview") {
            Column {
                WatchSectionHeader(WatchProjection.headline(watch))
                WatchLabeledRow("Progress", WatchProjection.progress(watch))
                WatchLabeledRow("Condition", WatchProjection.condition(watch.predicate, WatchProgress.of(watch.targets).live))
                WatchLabeledRow("When it holds", WatchProjection.action(watch, observerTitle))
                WatchLabeledRow("Freshness", WatchProjection.lastEvaluated(watch, now))
                WatchProjection.deadline(watch, now)?.let { WatchLabeledRow("Deadline", it) }
                WatchProjection.deliveryStatus(watch)?.let { WatchLabeledRow("Delivery", it) }
            }
        }
        if (reasons.isNotEmpty()) item(key = "attention") {
            Column(Modifier.testTag("watch-attention")) {
                WatchSectionHeader("Needs attention")
                reasons.forEach { reason ->
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(WatchIcons.warning, null, Modifier.size(18.dp), tint = WatchPalette.orange)
                        Text(reason.text, color = WatchPalette.orange, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        }
        item(key = "targets") { WatchSectionHeader("Targets") }
        itemsIndexed(watch.targets, key = { index, _ -> "target:$index" }) { _, target ->
            WatchTargetRow(target, opensTargets, sessionTitle, open)
        }
        if (watch.matches.isNotEmpty() || watch.expiryDeliveries.isNotEmpty()) {
            item(key = "history") { WatchSectionHeader("History") }
            itemsIndexed(watch.matches, key = { index, _ -> "match:$index" }) { _, match ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(matchedLine(match, now), style = MaterialTheme.typography.bodyLarge)
                    Text(match.reason, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = WatchPalette.secondary)
                    match.deliveries.forEach { delivery -> DeliveryLine(delivery) }
                }
            }
            itemsIndexed(watch.expiryDeliveries, key = { index, _ -> "end:$index" }) { _, end ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(WatchProjection.endTitle(end.kind), style = MaterialTheme.typography.bodyLarge)
                    DeliveryLine(end.delivery)
                }
            }
        }
        errorText?.let { text ->
            item(key = "error") {
                Text(text, Modifier.fillMaxWidth().padding(16.dp).testTag("watch-error").semantics { liveRegion = LiveRegionMode.Polite },
                    color = WatchPalette.red, style = MaterialTheme.typography.bodyLarge)
            }
        }
    }

    if (confirmingStop) AlertDialog(
        onDismissRequest = { confirmingStop = false },
        title = { Text("Stop watching?") },
        text = { Text(WatchProjection.stopWarning(watch)) },
        confirmButton = {
            TextButton(onClick = { confirmingStop = false; run(WatchControl.STOP) }, modifier = Modifier.testTag("watch-stop-confirm")) {
                Text("Stop", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = {
            TextButton(onClick = { confirmingStop = false }, modifier = Modifier.testTag("watch-stop-cancel")) { Text("Cancel") }
        },
        modifier = Modifier.testTag("watch-stop-dialog"),
    )
}

/** The bar's tags keep the device journey's names (A08's card verbs) for the same three doors. */
private fun controlTag(control: WatchControl) = when (control) {
    WatchControl.PAUSE -> "WATCH_PAUSE"
    WatchControl.RESUME -> "WATCH_RESUME"
    WatchControl.STOP -> "WATCH_CANCEL"
    WatchControl.VIEW, WatchControl.EDIT -> control.name
}

private fun matchedLine(match: WatchMatch, now: Instant): String =
    WatchTime.format(match.matchedAt, now)?.let { "Matched $it" } ?: "Matched"

@Composable
private fun DeliveryLine(delivery: WatchDelivery) {
    val status = WatchProjection.deliveryStatus(delivery) ?: return
    Text(status, style = MaterialTheme.typography.labelSmall,
        color = if (WatchDeadLetter.needsAttention(delivery)) WatchPalette.orange else WatchPalette.secondary)
}

/** Where a target opens: its session or its task — nothing once it was deleted, or for a kind this build can't name. */
internal fun watchTargetRoute(target: WatchTarget): OrbitRoute? {
    if (target.state == WatchTargetState.GONE || target.targetResourceId.isEmpty()) return null
    return when (target.targetKind) {
        WatchTargetKind.SESSION -> OrbitRoute(Destination.SESSION, target.targetResourceId, origin = Origin.LINK)
        WatchTargetKind.TASK -> OrbitRoute(Destination.TASK, target.targetResourceId, origin = Origin.LINK)
        WatchTargetKind.UNKNOWN -> null
    }
}

/** One frozen target: what it is, where it stands, and — while it still exists — a way to it. Named from what
 * this client holds (a session's title); a task, which this client keeps no list of, by the title the watch carries;
 * else by kind and short id. */
@Composable
private fun WatchTargetRow(target: WatchTarget, opens: Boolean, sessionTitle: (String?) -> String?, open: (OrbitRoute) -> Unit) {
    val route = watchTargetRoute(target)?.takeIf { opens }
    val held = if (target.targetKind == WatchTargetKind.SESSION) sessionTitle(target.targetResourceId) else null
    val title = WatchProjection.targetTitle(target.targetKind, target.targetResourceId, held ?: target.targetTitle)
    // One element either way: a row that doesn't open still reads as its name and where it stands.
    Row(Modifier.fillMaxWidth()
        .then(if (route != null) Modifier.clickable(role = Role.Button) { open(route) } else Modifier.semantics(mergeDescendants = true) {})
        .heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp).testTag("watch-target:${target.targetResourceId}"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(if (target.targetKind == WatchTargetKind.SESSION) WatchIcons.sessions else WatchIcons.checklist, null,
            Modifier.size(18.dp), tint = WatchPalette.secondary)
        Text(title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
        Text(WatchProjection.targetStateWord(target.state), style = MaterialTheme.typography.labelSmall,
            color = if (target.state == WatchTargetState.SATISFIED) WatchPalette.green else WatchPalette.secondary)
    }
}
