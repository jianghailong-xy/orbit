package io.orbitd.android.watch

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.directory.directoryError
import io.orbitd.android.navigation.*
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** The existing internal Following destination; it is intentionally absent from the drawer. */
@Composable
fun WatchDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute,
    revision: Long, open: (OrbitRoute) -> Unit) {
    val model = remember(handle, route.id) { WatchModel(WatchApi(app.session, handle) { watchCanAct(app, handle) }, route.id) }
    val state by model.state.collectAsState()
    val realtime by app.realtime.state.collectAsState()
    val auth by app.session.state.collectAsState()
    val ready = (auth as? AuthState.SignedIn)?.handle === handle && realtime.handle === handle && realtime.directoryFresh && realtime.controlConnection == ConnectionState.CONNECTED
    var retry by remember { mutableIntStateOf(0) }
    var now by remember { mutableStateOf(Instant.now()) }
    var stopping by remember { mutableStateOf<WatchRecord?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(model, revision, retry, ready) {
        if (!ready) { model.invalidate(); return@LaunchedEffect }
        while (true) { model.load(); now = Instant.now(); delay(30_000) }
    }
    val enabled = ready && state.fresh && !state.busy
    LaunchedEffect(state.watches, ready) {
        if (!ready || stopping?.let { shown -> state.watches.none { ObjectId.same(it.id, shown.id) && it.card.binding == shown.card.binding } } == true) stopping = null
    }
    LazyColumn(Modifier.fillMaxSize().testTag("watch-destination"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text(if (route.id == null) "Following" else state.watches.firstOrNull()?.let(WatchProjection::headline) ?: "Watch", style = MaterialTheme.typography.headlineMedium) }
        if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        if (!ready) item { Text("Reconnecting · actions are unavailable until the server is checked.") }
        if (state.unavailable) item {
            Text(if (route.id == null) "Watches aren't available" else "Watch not found", style = MaterialTheme.typography.titleMedium)
            Text(if (route.id == null) "This server doesn't serve watches yet." else "It may have been deleted, or this server doesn't serve watches.")
        } else state.error?.let { error -> item {
            Text(error, color = MaterialTheme.colorScheme.error)
            TextButton(onClick = { retry++ }, enabled = ready && !state.busy) { Text("Retry") }
        } }
        if (state.watches.isNotEmpty() && !state.fresh && !state.loading) item {
            Text("Showing previously loaded details. Reconnect and retry before making changes.")
        }
        if (route.id == null) {
            if (state.loaded && state.fresh && state.watches.isEmpty()) item {
                Text("Not following anything", style = MaterialTheme.typography.titleMedium)
                Text("When you or an agent watches sessions or tasks, the watch shows up here: what it waits for, how far along it is, and what happens when it holds.")
            }
            listOf("Needs attention", "Active", "History").forEach { group ->
                val rows = state.watches.filter { WatchProjection.group(it, now) == group }
                if (rows.isNotEmpty()) item { Text(group, style = MaterialTheme.typography.titleMedium) }
                items(rows, key = { it.id }) { watch ->
                    WatchListRow(watch, now, enabled) { open(OrbitRoute(Destination.WATCH, watch.id, origin = Origin.LIST)) }
                }
            }
        } else state.watches.firstOrNull()?.let { watch ->
            item {
                WatchField("Progress", WatchProjection.progress(watch))
                WatchField("Condition", WatchProjection.condition(watch.predicate, watch.liveTargets.size))
                WatchField("When it holds", WatchProjection.action(watch))
                WatchField("Freshness", WatchProjection.checked(watch, now))
                WatchProjection.deadline(watch, now)?.let { WatchField("Deadline", it) }
                watch.deliveries.lastOrNull()?.let(WatchProjection::delivery)?.let { WatchField("Delivery", it) }
            }
            val attention = WatchProjection.attention(watch, now)
            if (attention.isNotEmpty()) item {
                Text("Needs attention", style = MaterialTheme.typography.titleMedium)
                attention.forEach { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            item { Text("Targets", style = MaterialTheme.typography.titleMedium) }
            items(watch.targets) { target -> WatchTargetRow(target, enabled, false, open) }
            if (watch.matches.isNotEmpty() || watch.ends.isNotEmpty()) item { Text("History", style = MaterialTheme.typography.titleMedium) }
            items(watch.matches) { match ->
                Text("Matched ${WatchProjection.relative(match.text("matchedAt"), now).orEmpty()}", style = MaterialTheme.typography.titleSmall)
                Text(match.text("reason").orEmpty())
                match.objects("deliveries").forEach { row -> WatchProjection.delivery(row)?.let { Text(it) } }
            }
            items(watch.ends) { end ->
                Text(WatchProjection.endTitle(end.text("kind")), style = MaterialTheme.typography.titleSmall)
                WatchProjection.delivery(end)?.let { Text(it) }
            }
            // Swift WatchEditSheet is parked. Only the A08 state-authorized pause/resume/stop doors.
            item { Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                watch.card.actions.forEach { verb ->
                    TextButton(modifier = Modifier.testTag("watch:${watch.id}:$verb"), enabled = enabled, onClick = {
                        if (verb == CardVerb.WATCH_CANCEL) stopping = watch
                        else scope.launch { model.control(watch, verb) }
                    }) { Text(controlLabel(verb)) }
                }
            } }
        }
    }
    stopping?.let { watch ->
        AlertDialog(onDismissRequest = { stopping = null }, title = { Text("Stop watching?") },
            text = { Text(WatchProjection.stopWarning(watch)) },
            confirmButton = { TextButton(modifier = Modifier.testTag("watch-stop-confirm"), enabled = enabled, onClick = { stopping = null; scope.launch { model.control(watch, CardVerb.WATCH_CANCEL) } }) { Text("Stop") } },
            dismissButton = { TextButton(onClick = { stopping = null }) { Text("Keep watching") } })
    }
}

private fun controlLabel(verb: CardVerb) = when (verb) {
    CardVerb.WATCH_PAUSE -> "Pause"; CardVerb.WATCH_RESUME -> "Resume"; CardVerb.WATCH_CANCEL -> "Stop"; else -> verb.label
}

private fun watchCanAct(app: OrbitApplication, handle: SessionHandle): Boolean {
    val live = app.realtime.state.value
    return (app.session.state.value as? AuthState.SignedIn)?.handle === handle && live.handle === handle &&
        live.directoryFresh && live.controlConnection == ConnectionState.CONNECTED
}

@Composable
private fun WatchField(label: String, value: String) {
    Column(Modifier.padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value)
    }
}

@Composable
private fun WatchListRow(watch: WatchRecord, now: Instant, enabled: Boolean, open: () -> Unit) {
    val attention = WatchProjection.attention(watch, now)
    ListItem(headlineContent = { Text(WatchProjection.headline(watch)) },
        supportingContent = { Column {
            if (watch.live) Text(WatchProjection.progress(watch))
            Text(WatchProjection.condition(watch.predicate, watch.liveTargets.size))
            Text(attention.firstOrNull() ?: (WatchProjection.action(watch) + " · " +
                (if (watch.live) WatchProjection.checked(watch, now) else watch.deliveries.lastOrNull()?.let(WatchProjection::delivery)
                    ?: WatchProjection.relative(watch.raw.text("updatedAt"), now).orEmpty())),
                color = if (attention.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
        } }, modifier = Modifier.clickable(enabled, role = Role.Button, onClick = open))
}

@Composable
private fun WatchTargetRow(target: JsonObject, enabled: Boolean, standing: Boolean, open: (OrbitRoute) -> Unit) {
    val route = WatchProjection.targetRoute(target)
    ListItem(headlineContent = { Text(WatchProjection.targetName(target)) }, supportingContent = {
        Text(if (standing) WatchProjection.standing(target) ?: WatchProjection.targetState(target) else WatchProjection.targetState(target))
    }, modifier = Modifier.clickable(enabled = enabled && route != null, role = Role.Button) { route?.let(open) })
}

/** WatchingCardStack's read-only band: only expanding and opening a target are reachable on iOS. */
@Composable
fun SessionWatches(app: OrbitApplication, handle: SessionHandle, sessionId: String, open: (OrbitRoute) -> Unit) {
    val model = remember(handle, sessionId) { WatchModel(WatchApi(app.session, handle)) }
    val state by model.state.collectAsState()
    val realtime by app.realtime.state.collectAsState()
    val auth by app.session.state.collectAsState()
    val selected = realtime.session
    val ready = (auth as? AuthState.SignedIn)?.handle === handle && realtime.handle === handle &&
        ObjectId.same(selected?.id, sessionId) && selected?.fresh == true && !selected.accessDenied
    var expanded by rememberSaveable(sessionId) { mutableStateOf(false) }
    var hadWatch by remember(handle, sessionId) { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(model, ready, realtime.invalidationRevision, retry) {
        if (!ready) { model.invalidate(); return@LaunchedEffect }
        while (true) { model.load(); now = Instant.now(); delay(30_000) }
    }
    val watches = WatchProjection.observing(sessionId, state.watches)
    LaunchedEffect(watches) { if (watches.isNotEmpty()) hadWatch = true }
    if ((auth as? AuthState.SignedIn)?.handle !== handle || selected?.accessDenied == true) return
    if (watches.isEmpty()) {
        if (hadWatch && state.error != null) Column(Modifier.fillMaxWidth().padding(8.dp)) {
            Text(state.error!!, color = MaterialTheme.colorScheme.error)
            TextButton(enabled = ready && !state.loading, onClick = { retry++ }) { Text("Retry watching status") }
        }
        return
    }
    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier.fillMaxWidth().testTag("session-watches")) {
        Column {
            TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth()) {
                Text(WatchProjection.stripLine(watches) + if (expanded) " ▾" else " ▸", modifier = Modifier.weight(1f))
            }
            if (expanded) Column(Modifier.heightIn(max = 190.dp).verticalScroll(rememberScrollState())) {
                if (!state.fresh || !ready) Text("Reconnecting · showing previously loaded watches.", Modifier.padding(8.dp))
                watches.forEach { watch ->
                    WatchProjection.staleLine(watch, now)?.let { Text(it, Modifier.padding(8.dp), color = MaterialTheme.colorScheme.error) }
                    watch.liveTargets.sortedBy { if (it.text("state") == "SATISFIED") 0 else 1 }.forEach { target ->
                        WatchTargetRow(target, state.fresh && ready, true, open)
                    }
                }
            }
        }
    }
}

/** A11 task detail owns this entry, matching TaskFollowSheet and its Followed by section. */
@Composable
fun TaskWatchSubscription(app: OrbitApplication, handle: SessionHandle, taskId: String, title: String,
    revision: Long, fresh: Boolean, open: (OrbitRoute) -> Unit) {
    val currentFresh by rememberUpdatedState(fresh)
    val api = remember(handle) { WatchApi(app.session, handle) { currentFresh && watchCanAct(app, handle) } }
    val model = remember(handle, taskId) { WatchModel(api) }
    val state by model.state.collectAsState()
    val auth by app.session.state.collectAsState()
    val realtime by app.realtime.state.collectAsState()
    val ready = fresh && (auth as? AuthState.SignedIn)?.handle === handle && realtime.handle === handle &&
        realtime.directoryFresh && realtime.controlConnection == ConnectionState.CONNECTED
    var dialog by rememberSaveable(taskId) { mutableStateOf(false) }
    var key by rememberSaveable(taskId) { mutableStateOf("") }
    var selectedCondition by rememberSaveable(taskId) { mutableIntStateOf(0) }
    var ttl by rememberSaveable(taskId) { mutableIntStateOf(86_400) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(model, revision, realtime.invalidationRevision, ready) { if (ready) model.load() else model.invalidate() }
    val followers = state.watches.filter { watch -> watch.targets.any { it.text("targetKind") == "TASK" && ObjectId.same(it.text("targetResourceId"), taskId) } }
    Column {
        Text("Followed by", style = MaterialTheme.typography.titleMedium)
        followers.filter { it.live }.forEach { watch ->
            TextButton(enabled = ready && state.fresh, onClick = { open(OrbitRoute(Destination.WATCH, watch.id)) }) { Text(WatchProjection.headline(watch)) }
        }
        if (followers.any { !it.live }) Text("${followers.count { !it.live }} ended")
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        notice?.let { Text(it) }
        TextButton(enabled = ready && state.fresh, onClick = {
            key = UUID.randomUUID().toString(); selectedCondition = 0; ttl = 86_400; error = null; dialog = true
        }) { Text("Follow") }
    }
    if (dialog) AlertDialog(onDismissRequest = { if (!saving) dialog = false }, title = { Text("Follow task") }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
            Text(title); Text("Wait until the task", style = MaterialTheme.typography.titleSmall)
            WatchProjection.followConditions.forEachIndexed { index, predicate ->
                Row(Modifier.fillMaxWidth().clickable(enabled = !saving, role = Role.RadioButton) { selectedCondition = index }) {
                    RadioButton(selectedCondition == index, onClick = null)
                    Text(WatchProjection.condition(predicate, 1), Modifier.padding(top = 12.dp))
                }
            }
            Text("Then: Notify me")
            Text("Stop watching after", style = MaterialTheme.typography.titleSmall)
            WatchProjection.deadlines.forEach { seconds ->
                Row(Modifier.fillMaxWidth().clickable(enabled = !saving, role = Role.RadioButton) { ttl = seconds }) {
                    RadioButton(ttl == seconds, onClick = null); Text(WatchProjection.deadlineTitle(seconds), Modifier.padding(top = 12.dp))
                }
            }
            Text("The watch expires if the condition hasn't held by then.")
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = { TextButton(enabled = ready && !saving, onClick = {
        saving = true; error = null
        scope.launch {
            try {
                val created = api.followTask(taskId, WatchProjection.followConditions[selectedCondition], ttl, key)
                notice = if (created.state == "MATCHED") "Already true, so the watch triggered at once" else "Following"
                dialog = false; model.load()
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = directoryError(failure) }
            finally { saving = false }
        }
    }) { Text("Follow") } }, dismissButton = { TextButton(enabled = !saving, onClick = { dialog = false }) { Text("Cancel") } })
}
