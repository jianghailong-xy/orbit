package io.orbitd.android.management

import android.content.Intent
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.verticalDrag
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.currentStateAsState
import io.orbitd.android.R
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** RunnersModel: the account's runners and workspaces as GET /runners and /workspaces answer them. */
@Stable
internal class RunnersModel(private val api: ManagementApi) {
    var runners by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var workspaces by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var counts by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var published by mutableStateOf<String?>(null); private set
    var loaded by mutableStateOf(false); private set
    var failed by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null)
    private var releaseRead = false
    val latestVersion get() = RunnerPage.latestRunnerVersion(published, runners.map { it.str("version") })
    fun runner(id: String) = runners.firstOrNull { ObjectId.same(it.text("id"), id) }
    fun workspacesOf(runnerId: String) = workspaces.filter { ObjectId.same(it.text("runnerId"), runnerId) }

    suspend fun load() {
        try {
            runners = providerObjects(api.get("runners"))
            runners.forEach { runnerNames[ObjectId.canonical(it.text("id")) ?: it.text("id")] = RunnerPage.displayName(it) }
            try { workspaces = providerObjects(api.get("workspaces")) } catch (e: CancellationException) { throw e } catch (_: Exception) { }
            loaded = true; failed = false; error = null
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            failed = true
            error = if (e is ApiError && e.status == 401) "Session expired — sign in again." else "Request failed — check your connection."
        }
    }
    suspend fun loadReleaseVersion() { if (!releaseRead) { releaseRead = true; published = runnerReleaseVersion(api.handle.account.server) } }
    suspend fun loadSessionCounts() {
        try { counts = providerObjects(api.get("sessions/counts")) } catch (e: CancellationException) { throw e } catch (_: Exception) { }
    }
    /** Each press answers null once it went through (then reads again), else why not. */
    suspend fun press(op: suspend () -> Unit): String? = try { op(); load(); null }
        catch (e: CancellationException) { throw e } catch (e: Exception) { personalFailure(e) }
    /** The rows move at once; the server's order settles it. */
    suspend fun reorder(ids: List<String>) {
        val before = runners
        runners = ids.mapNotNull { id -> before.firstOrNull { it.text("id") == id } }
        try { runners = providerObjects(api.post("runners/reorder", buildJsonObject { put("ids", JsonArray(ids.map(::JsonPrimitive))) })) }
        catch (e: CancellationException) { throw e } catch (e: Exception) { runners = before; error = personalFailure(e) }
    }
}

private val releaseClient by lazy { OkHttpClient.Builder().followRedirects(false).callTimeout(15, TimeUnit.SECONDS).build() }

/** <origin>/dl/version.json, unauthenticated, as iOS APIClient.runnerReleaseVersion reads it; null when unreadable. */
internal suspend fun runnerReleaseVersion(server: String): String? = withContext(Dispatchers.IO) {
    try {
        val url = server.toHttpUrl().newBuilder().addPathSegments("dl/version.json").build()
        releaseClient.newCall(Request.Builder().url(url).build()).execute().use { response ->
            if (!response.isSuccessful) null
            else (Wire.json.parseToJsonElement(response.body?.string().orEmpty()) as? JsonObject)?.str("version")?.trim()?.takeIf { it.isNotEmpty() }
        }
    } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
}

@Composable
internal fun rememberResumed(): Boolean {
    val state by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    return state.isAtLeast(Lifecycle.State.RESUMED)
}

/** The clock as of this composition (iOS reads `Date()` in the view body), moved on while the page is up. */
@Composable
internal fun rememberNow(every: Long = 15_000): Long {
    var tick by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(every) { while (true) { delay(every); tick = System.currentTimeMillis() } }
    return maxOf(tick, System.currentTimeMillis())
}

/** The aliases runner pages have read, so the shell's title says what the page head says. */
private val runnerNames = mutableStateMapOf<String, String>()

fun runnerTitle(record: String?, runnerId: String?, fallback: String?): String = when {
    record == "name" -> RunnerCopy.ABOUT_NAME
    record?.startsWith("engine:") == true -> RunnerPage.engineName(record.removePrefix("engine:"))
    else -> runnerId?.let { runnerNames[ObjectId.canonical(it) ?: it] } ?: fallback ?: "Runner"
}

@Composable
private fun StatusDot(presence: String, size: Int = 8) {
    Box(Modifier.size(size.dp).clip(CircleShape).background(when (presence) {
        "online" -> Ink.green; "draining" -> Ink.amber; else -> Color(0xFFA8A8AD)
    }))
}

@Composable
/** A row's "opens a page" mark: drawn, not read (TalkBack would say the character's name). */
private fun Chevron() = Text("›", Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.titleLarge, color = Ink.muted.copy(alpha = .6f))

/** A sentence with the workspace names it names set bold and the command it quotes in monospace. */
private fun styled(text: String, strong: List<String> = emptyList(), code: List<String> = emptyList()): AnnotatedString = buildAnnotatedString {
    append(text)
    strong.filter { it.isNotEmpty() }.forEach { word -> text.indexOf(word).takeIf { it >= 0 }?.let { addStyle(SpanStyle(fontWeight = FontWeight.SemiBold), it, it + word.length) } }
    code.filter { it.isNotEmpty() }.forEach { word -> text.indexOf(word).takeIf { it >= 0 }?.let { addStyle(SpanStyle(fontFamily = FontFamily.Monospace), it, it + word.length) } }
}

/** RunnersSettingsList: every runner — a row opens it, its handle reorders it and its ⋯ menu removes it, with no Edit mode (iOS
 * 91316c246) — and Add Runner under them. */
@Composable
fun RunnersList(api: ManagementApi, revision: Long, openRunner: (String) -> Unit) {
    val model = remember(api) { RunnersModel(api) }
    val resumed = rememberResumed()
    val now = rememberNow()
    val scope = rememberCoroutineScope()
    var adding by rememberSaveable { mutableStateOf(false) }
    var removing by remember { mutableStateOf<JsonObject?>(null) }
    var drag by remember { mutableStateOf<RunnerDrag?>(null) }
    val heights = remember { mutableStateMapOf<String, Int>() }
    val handles = remember { mutableStateMapOf<String, Rect>() }
    var list by remember { mutableStateOf<LayoutCoordinates?>(null) }
    val notice = remember { Notice() }
    LaunchedEffect(model, revision, resumed) { if (resumed) { model.load(); model.loadReleaseVersion() } }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
            when {
                !model.loaded && model.failed -> Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Runners couldn't be loaded", style = MaterialTheme.typography.titleMedium)
                    Text(model.error ?: "Request failed — check your connection.", color = Ink.muted)
                    Button(onClick = { scope.launch { model.load() } }) { Text("Retry") }
                }
                !model.loaded -> Text("Loading…", Modifier.fillMaxWidth().padding(24.dp), color = Ink.muted)
                else -> {
                    if (model.failed) model.error?.let { error ->
                        Row(Modifier.fillMaxWidth().background(Ink.amber.copy(alpha = .12f)).padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text("⚠ $error", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, maxLines = 2)
                            TextButton(onClick = { model.error = null }) { Text("Dismiss") }
                        }
                    }
                    if (model.runners.isNotEmpty()) {
                        FormSection {
                            // A row moves by dragging its handle, as the Wiki plan's Edit sheet moves a section (the owner's
                            // decision, card 34bs0PdYUHHwiKHYn3rCp): rows trade places as it passes half of the next one, and the
                            // order goes out once, when it is let go. The drag is measured on the list, which stays put, not on
                            // the row, which moves with the finger.
                            val shown = drag?.order?.mapNotNull { id -> model.runners.firstOrNull { it.text("id") == id } } ?: model.runners
                            Column(Modifier.onPlaced { list = it }.pointerInput(Unit) {
                                awaitEachGesture {
                                    val down = awaitFirstDown(requireUnconsumed = false)
                                    // Only the handle of a row shown now: a removed row's handle lay where the next row moved to.
                                    val current = model.runners.map { it.text("id") }
                                    val id = handles.entries.firstOrNull { it.key in current && it.value.contains(down.position) }?.key ?: return@awaitEachGesture
                                    drag = RunnerDrag(id, current, 0f)
                                    // Let go or cancelled: the rows stand in order again.
                                    try {
                                        val ended = verticalDrag(down.id) { change -> drag = drag?.moved(change.positionChange().y, heights); change.consume() }
                                        val order = drag?.order
                                        if (ended && order != null && order != current) scope.launch { model.reorder(order) }
                                    } finally { drag = null }
                                }
                            }) {
                                shown.forEachIndexed { index, runner ->
                                    val id = runner.text("id")
                                    if (index > 0) HorizontalDivider()
                                    key(id) {
                                        // A row that goes takes its handle with it.
                                        DisposableEffect(id) { onDispose { handles.remove(id); heights.remove(id) } }
                                        val dragged = drag?.id == id
                                        Box(Modifier.onSizeChanged { heights[id] = it.height }.zIndex(if (dragged) 1f else 0f)
                                            .graphicsLayer { translationY = if (dragged) drag?.offset ?: 0f else 0f }) {
                                            RunnerRow(runner, model.workspacesOf(id), model.latestVersion, now,
                                                canMoveUp = index > 0, canMoveDown = index < shown.lastIndex,
                                                open = { openRunner(id) }, remove = { removing = runner },
                                                move = { by -> scope.launch {
                                                    val ids = model.runners.map { it.text("id") }.toMutableList()
                                                    ids.add(index + by, ids.removeAt(index))
                                                    model.reorder(ids)
                                                } },
                                                handle = Modifier.onGloballyPositioned { at -> list?.takeIf { it.isAttached }?.let { handles[id] = it.localBoundingBoxOf(at) } })
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            FormSection(footer = RunnerCopy.ADD_FOOTER) { TextButton(onClick = { adding = true }) { Text(RunnerCopy.ADD) } }
        }
        notice.Host(Modifier.align(Alignment.BottomCenter))
    }
    removing?.let { runner ->
        AlertDialog(onDismissRequest = { removing = null }, title = { Text("Remove “${RunnerPage.displayName(runner)}”?") },
            text = { Text(RunnerCopy.REMOVE_FOOTER) }, confirmButton = {
                TextButton(onClick = { removing = null; scope.launch {
                    model.press { api.delete("runners/${runner.text("id")}") }?.let { model.error = it; notice.show(it) }
                } }) { Text(RunnerCopy.REMOVE, color = Ink.red) }
            }, dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } })
    }
    if (adding) AddRunnerDialog(api, onDismiss = { adding = false }) { id -> adding = false; openRunner(id) }
}

/** One drag of a row's handle: the row being moved, the order as it stands, and how far the row is from its slot. */
internal data class RunnerDrag(val id: String, val order: List<String>, val offset: Float) {
    /** Moved by [dy]: it takes the next row's place once past half of it, and the offset is kept relative to its new slot. */
    fun moved(dy: Float, heights: Map<String, Int>): RunnerDrag {
        var order = order; var offset = offset + dy
        while (true) {
            val at = order.indexOf(id)
            if (at < 0) return this // not a row of this order: nothing moves
            val next = order.getOrNull(at + 1)?.let { heights[it] }
            val previous = order.getOrNull(at - 1)?.let { heights[it] }
            if (next != null && offset > next / 2f) { order = order.toMutableList().apply { add(at + 1, removeAt(at)) }; offset -= next }
            else if (previous != null && offset < -previous / 2f) { order = order.toMutableList().apply { add(at - 1, removeAt(at)) }; offset += previous }
            else return RunnerDrag(id, order, offset)
        }
    }
}

/** One runner: a press opens it, its handle — the list's drag — moves it, and its ⋯ menu removes it (iOS's swipe). TalkBack, which
 * cannot drag, moves it with the row's Move up and Move down actions. */
@Composable
private fun RunnerRow(runner: JsonObject, workspaces: List<JsonObject>, latest: String?, now: Long,
                      canMoveUp: Boolean, canMoveDown: Boolean, open: () -> Unit, remove: () -> Unit, move: (Int) -> Unit, handle: Modifier) {
    val items = RunnerPage.attention(runner, workspaces, now, latest)
    val name = RunnerPage.displayName(runner)
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).clickable(role = Role.Button, onClick = open).semantics {
                customActions = listOfNotNull(CustomAccessibilityAction("Move up") { move(-1); true }.takeIf { canMoveUp },
                    CustomAccessibilityAction("Move down") { move(1); true }.takeIf { canMoveDown })
            }.padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatusDot(RunnerPage.presence(runner, now))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, Modifier.weight(1f), maxLines = 2)
                    RunnerPage.slots(runner, now)?.let { (active, max) ->
                        Text(RunnerCopy.slots(active, max), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                        Spacer(Modifier.width(7.dp))
                        Gauge(if (max > 0) active.toFloat() / max else 0f, if (active >= max) Ink.amber else MaterialTheme.colorScheme.primary, Modifier.width(44.dp))
                    }
                }
                Text(RunnerPage.listSubtitle(runner, now), style = MaterialTheme.typography.bodySmall, color = Ink.muted, maxLines = 1)
                RunnerPage.listAttentionLine(items)?.let { line ->
                    Text("⚠ $line", style = MaterialTheme.typography.bodySmall, color = Ink.tone(RunnerPage.listTone(items) ?: "warn"), maxLines = 2)
                }
            }
        }
        Box {
            TextButton(onClick = { menu = true }) { Text("⋯", Modifier.clearAndSetSemantics { contentDescription = "More for $name" }) }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text(AccountCopy.REMOVE, color = Ink.red) }, onClick = { menu = false; remove() })
            }
        }
        // The handle a row is dragged by; the drag itself is the list's.
        Box(handle.size(48.dp).testTag("runner-handle:${runner.text("id")}").clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_reorder), null, tint = Ink.muted)
        }
    }
}

/** The RUNNER destination: a runner's page, or its engine's or name's page one push further. */
@Composable
fun RunnerScreen(api: ManagementApi, runnerId: String?, record: String?, revision: Long, open: (OrbitRoute) -> Unit,
                 back: () -> Unit, openWorkspace: (String) -> Unit) {
    when {
        runnerId == null -> RunnersList(api, revision) { open(OrbitRoute(Destination.RUNNER, it)) }
        record == "name" -> RunnerNamePage(api, runnerId, revision, back)
        record?.startsWith("engine:") == true -> RunnerEnginePage(api, runnerId, record.removePrefix("engine:"), revision)
        else -> RunnerDetail(api, runnerId, revision, open, back, openWorkspace)
    }
}

@Composable
private fun RunnerGone(title: String) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text("This runner is no longer on your account.", color = Ink.muted)
    }
}

/** RunnerDetailContent: Needs Attention, Capacity, Engines, Workspaces, About, then rotate and remove. */
@Composable
private fun RunnerDetail(api: ManagementApi, id: String, revision: Long, open: (OrbitRoute) -> Unit, back: () -> Unit, openWorkspace: (String) -> Unit) {
    val model = remember(api) { RunnersModel(api) }
    val resumed = rememberResumed()
    val now = rememberNow()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val notice = remember { Notice() }
    LaunchedEffect(model, revision, resumed) {
        if (!resumed) return@LaunchedEffect
        model.load(); model.loadReleaseVersion(); model.loadSessionCounts()
        // A machine checks in every 30s: read it again while its page is up.
        while (true) { delay(15_000); model.load(); model.loadSessionCounts() }
    }
    val runner = model.runner(id)
    if (runner == null) {
        if (model.loaded) RunnerGone("Runner") else Text(if (model.failed) model.error.orEmpty() else "Loading…", Modifier.padding(24.dp), color = Ink.muted)
        return
    }
    val workspaces = model.workspacesOf(id)
    val offline = RunnerPage.isOffline(runner, now)
    val items = RunnerPage.attention(runner, workspaces, now, model.latestVersion)
    var choosingReserve by remember { mutableStateOf(false) }
    var confirmingRotate by remember { mutableStateOf(false) }
    var confirmingRemove by remember { mutableStateOf(false) }
    var rotatedToken by remember(id) { mutableStateOf<String?>(null) }
    fun show(failure: String?) { failure?.let(notice::show) }
    fun keepFree(mb: Int?) {
        if (mb == RunnerPage.keepFreeValue(runner.int("minFreeDiskMb"))) return
        scope.launch { show(model.press { api.patch("runners/$id", buildJsonObject { put("minFreeDiskMb", mb?.let(::JsonPrimitive) ?: JsonNull) }) }) }
    }
    fun updateEngines() = scope.launch { show(model.press { api.post("runners/$id/engine-update") }) }
    // Checks for its own release now rather than at its next 10-minute check, by the same rules: a turn in flight still holds it.
    fun updateRunner() = scope.launch { notice.show(model.press { api.post("runners/$id/self-update") } ?: RunnerCopy.UPDATE_RUNNER_REQUESTED) }
    fun copy(text: String) { copyText(context, "Orbit", text); notice.show("Copied") }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
            RunnerHead(runner, now)
            if (model.failed) model.error?.let { Text("⚠ $it", Modifier.padding(top = 8.dp), color = Ink.amber, style = MaterialTheme.typography.labelMedium) }
            if (items.isNotEmpty()) FormSection(RunnerCopy.NEEDS_ATTENTION) {
                items.forEachIndexed { index, item ->
                    if (index > 0) HorizontalDivider()
                    AttentionRow(item, now) {
                        val action = item.action
                        when (action?.kind) {
                            "signIn" -> AttentionButton(RunnerCopy.SIGN_IN) { open(OrbitRoute(Destination.RUNNER, id, recordId = "engine:${action.engine}")) }
                            "repair" -> AttentionButton(RunnerCopy.REPAIR) { scope.launch { show(model.press { api.post("workspaces/${action.workspaceId}/repo-cleanup") }) } }
                            "setReserve" -> AttentionButton(RunnerCopy.SET_A_RESERVE) { choosingReserve = true }
                            "copyCommand" -> AttentionButton(RunnerCopy.COPY_COMMAND) { copy(action.command.orEmpty()) }
                            "updateEngines" -> AttentionButton(RunnerCopy.UPDATE_ENGINES_NOW, enabled = !RunnerPage.engineUpdateInFlight(runner.obj("install"))) { updateEngines() }
                            "updateRunner" -> AttentionButton(RunnerCopy.UPDATE_RUNNER_NOW) { updateRunner() }
                        }
                    }
                }
            }
            RunnerCapacity(runner, workspaces, model, notice, api)
            FormSection(RunnerCopy.ENGINES, RunnerPage.enginesNote(runner, now),
                if (offline) RunnerCopy.ENGINES_OFFLINE_FOOTER else RunnerCopy.ENGINES_FOOTER) {
                if (runner["engines"] == null || runner["engines"] is JsonNull) Text("This runner hasn’t reported its engines yet.", Modifier.padding(vertical = 8.dp), color = Ink.muted)
                RunnerPage.engines(runner).forEachIndexed { index, health ->
                    if (index > 0) HorizontalDivider()
                    EngineRow(runner, health, offline, now) { open(OrbitRoute(Destination.RUNNER, id, recordId = "engine:${health.text("engine")}")) }
                }
                if (!offline) {
                    HorizontalDivider()
                    TextButton(onClick = { updateEngines() }, enabled = !RunnerPage.engineUpdateInFlight(runner.obj("install"))) { Text(RunnerCopy.UPDATE_ENGINES_NOW) }
                    RunnerPage.updateRelayLine(runner.obj("install"))?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
                    TextButton(onClick = { scope.launch {
                        notice.show(model.press { api.post("runners/$id/refresh-models") } ?: "Re-reading this machine’s model lists — the picker updates within a minute.")
                    } }) { Text(RunnerCopy.REFRESH_MODEL_LISTS) }
                }
            }
            FormSection(RunnerCopy.WORKSPACES, workspaces.size.takeIf { it > 0 }?.toString(), RunnerCopy.WORKSPACES_FOOTER) {
                if (workspaces.isEmpty()) Text("No workspaces on this runner yet.", Modifier.padding(vertical = 8.dp), color = Ink.muted)
                workspaces.forEachIndexed { index, workspace ->
                    if (index > 0) HorizontalDivider()
                    WorkspaceRow(workspace, RunnerPage.runningCount(workspace, model.counts)) { openWorkspace(workspace.text("id")) }
                }
            }
            FormSection(RunnerCopy.ABOUT, footer = if (runner.bool("runsAsRoot") == true) RunnerCopy.ROOT_NO_BYPASS else null) {
                Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { open(OrbitRoute(Destination.RUNNER, id, recordId = "name")) }.padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Text(RunnerCopy.ABOUT_NAME, Modifier.weight(1f)); Text(RunnerPage.displayName(runner), color = Ink.muted, maxLines = 1); Spacer(Modifier.width(8.dp)); Chevron()
                }
                AboutRows(RunnerCopy.ABOUT_HOSTNAME to runner.str("hostname"), RunnerCopy.ABOUT_VERSION to RunnerPage.versionValue(runner, model.latestVersion),
                    RunnerCopy.ABOUT_LAST_UPDATE to RunnerPage.lastUpdate(runner))
                if (RunnerPage.canUpdateNow(runner, now)) { HorizontalDivider(); TextButton(onClick = { updateRunner() }) { Text(RunnerCopy.UPDATE_RUNNER_NOW) } }
                AboutRows(RunnerCopy.ABOUT_RUNS_AS to RunnerPage.runsAsValue(runner), RunnerCopy.ABOUT_REPOS_FOLDER to runner.str("reposRoot"),
                    RunnerCopy.ABOUT_LAST_CHECK_IN to RunnerPage.lastCheckIn(runner, now), RunnerCopy.ABOUT_REGISTERED to RunnerPage.registered(runner, now))
            }
            FormSection(footer = RunnerCopy.ROTATE_TOKEN_FOOTER) {
                TextButton(onClick = { confirmingRotate = true }) { Text(RunnerCopy.ROTATE_TOKEN) }
                rotatedToken?.let { token ->
                    SelectionContainer { Text(token, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                    TextButton(onClick = { copy(token) }) { Text(RunnerCopy.COPY) }
                }
            }
            FormSection(footer = RunnerCopy.REMOVE_FOOTER) {
                TextButton(onClick = { confirmingRemove = true }, Modifier.fillMaxWidth()) { Text(RunnerCopy.REMOVE, color = Ink.red) }
            }
            Spacer(Modifier.height(48.dp))
        }
        notice.Host(Modifier.align(Alignment.BottomCenter))
    }
    val name = RunnerPage.displayName(runner)
    if (choosingReserve) AlertDialog(onDismissRequest = { choosingReserve = false }, title = { Text(RunnerCopy.KEEP_FREE) },
        text = { Column { Text(RunnerCopy.CAPACITY_FOOTER); RunnerPage.KEEP_FREE_TIERS.filter { it.first != null }.forEach { (mb, label) ->
            TextButton(onClick = { choosingReserve = false; keepFree(mb) }) { Text(label) } } } },
        confirmButton = {}, dismissButton = { TextButton(onClick = { choosingReserve = false }) { Text("Cancel") } })
    if (confirmingRotate) AlertDialog(onDismissRequest = { confirmingRotate = false }, title = { Text("Rotate token for “$name”?") },
        text = { Text(RunnerCopy.ROTATE_TOKEN_FOOTER) }, confirmButton = {
            TextButton(onClick = { confirmingRotate = false; scope.launch {
                try { rotatedToken = api.post("runners/$id/rotate-token").jsonObject.str("token") }
                catch (e: CancellationException) { throw e } catch (e: Exception) { notice.show(personalFailure(e)) }
            } }) { Text("Rotate Token", color = Ink.red) }
        }, dismissButton = { TextButton(onClick = { confirmingRotate = false }) { Text("Cancel") } })
    if (confirmingRemove) AlertDialog(onDismissRequest = { confirmingRemove = false }, title = { Text("Remove “$name”?") },
        text = { Text(RunnerCopy.REMOVE_FOOTER) }, confirmButton = {
            TextButton(onClick = { confirmingRemove = false; scope.launch {
                model.press { api.delete("runners/$id") }?.let(notice::show) ?: back()
            } }) { Text(RunnerCopy.REMOVE, color = Ink.red) }
        }, dismissButton = { TextButton(onClick = { confirmingRemove = false }) { Text("Cancel") } })
}

@Composable
private fun RunnerHead(runner: JsonObject, now: Long) {
    val presence = RunnerPage.presence(runner, now)
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.size(56.dp).clip(RoundedCornerShape(15.dp)).background(Color(0xFF6E7076)), Alignment.BottomEnd) {
            Text("▣", Modifier.align(Alignment.Center).clearAndSetSemantics { }, color = Color.White, style = MaterialTheme.typography.titleLarge)
            Box(Modifier.padding(3.dp)) { StatusDot(presence, 14) }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(RunnerPage.displayName(runner), style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold), maxLines = 2)
            val line = RunnerPage.statusLine(runner, now)
            val word = if (RunnerPage.isOffline(runner, now)) RunnerCopy.OFFLINE else RunnerCopy.ONLINE
            val wordColor = if (word == RunnerCopy.ONLINE) Ink.green else Ink.muted
            Text(buildAnnotatedString {
                append(line)
                if (line.startsWith(word)) addStyle(SpanStyle(color = wordColor, fontWeight = FontWeight.Medium), 0, word.length)
            }, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            RunnerPage.hostLine(runner).takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.muted) }
        }
    }
}

@Composable
private fun AttentionRow(item: AttentionItem, now: Long, action: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.size(28.dp).clip(RoundedCornerShape(8.dp)).background(Ink.tone(item.tone).copy(alpha = .13f)), Alignment.Center) {
            Text("!", Modifier.clearAndSetSemantics { }, color = Ink.tone(item.tone), fontWeight = FontWeight.Bold)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(item.title, style = MaterialTheme.typography.titleMedium)
            Text(styled(RunnerPage.attentionDetail(item, now), item.names.filter { RunnerPage.attentionDetail(item, now).contains(it) },
                listOfNotNull(item.action?.command)), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            action()
        }
    }
}

/** About's label/value rows; a value the runner doesn't report has no row. */
@Composable
private fun AboutRows(vararg rows: Pair<String, String?>) = rows.filter { !it.second.isNullOrEmpty() }.forEach { (label, value) ->
    HorizontalDivider()
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) { Text(label, Modifier.weight(1f)); SelectionContainer { Text(value!!, color = Ink.muted) } }
}

@Composable
private fun AttentionButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    FilledTonalButton(onClick = onClick, enabled = enabled, modifier = Modifier.padding(top = 4.dp), shape = RoundedCornerShape(50)) { Text(label) }
}

/** Max Concurrent (saved once the presses settle), Disk, and Keep Free. */
@Composable
private fun RunnerCapacity(runner: JsonObject, workspaces: List<JsonObject>, model: RunnersModel, notice: Notice, api: ManagementApi) {
    val id = runner.text("id")
    val serverMax = runner.int("maxConcurrent") ?: 1
    var maxConc by remember(id) { mutableIntStateOf(serverMax) }
    var pending by remember(id) { mutableStateOf(false) }
    var edits by remember(id) { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(serverMax) { if (!pending) maxConc = serverMax }
    // Saved once the presses settle, as the stepper's release and settle save it on iOS.
    LaunchedEffect(edits) {
        if (edits == 0) return@LaunchedEffect
        delay(900)
        val value = maxConc
        if (value != (model.runner(id)?.int("maxConcurrent") ?: 1)) {
            model.press { api.patch("runners/$id", buildJsonObject { put("maxConcurrent", value) }) }?.let { failure ->
                maxConc = model.runner(id)?.int("maxConcurrent") ?: value; notice.show(failure)
            }
        }
        pending = false
    }
    // A press still settling is sent when the page goes (iOS saves on the stepper's release), so leaving at once loses nothing.
    DisposableEffect(id) {
        onDispose {
            val value = maxConc
            if (pending && value != (model.runner(id)?.int("maxConcurrent") ?: 1))
                api.background.launch { try { api.patch("runners/$id", buildJsonObject { put("maxConcurrent", value) }) } catch (_: Exception) { } }
        }
    }
    FormSection(RunnerCopy.CAPACITY, footer = RunnerCopy.CAPACITY_FOOTER) {
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(RunnerCopy.MAX_CONCURRENT, Modifier.weight(1f))
            Text("$maxConc", color = Ink.muted)
            // The glyph carries the words, so TalkBack says them alone, not "…, minus".
            TextButton(onClick = { maxConc -= 1; pending = true; edits++ }, enabled = maxConc > 1) {
                Text("−", Modifier.clearAndSetSemantics { contentDescription = "Decrease ${RunnerCopy.MAX_CONCURRENT}" })
            }
            TextButton(onClick = { maxConc += 1; pending = true; edits++ }, enabled = maxConc < 64) {
                Text("+", Modifier.clearAndSetSemantics { contentDescription = "Increase ${RunnerCopy.MAX_CONCURRENT}" })
            }
        }
        RunnerPage.runnerDisk(workspaces)?.let { disk ->
            HorizontalDivider()
            Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row { Text(RunnerCopy.DISK, Modifier.weight(1f)); Text(RunnerPage.diskUsedLine(disk), style = MaterialTheme.typography.bodySmall, color = Ink.muted) }
                Gauge(disk.usedPercent / 100f, if (RunnerPage.diskIsTight(disk, runner.int("minFreeDiskMb"))) Ink.amber else MaterialTheme.colorScheme.primary, height = 7.dp)
            }
        }
        HorizontalDivider()
        var expanded by remember { mutableStateOf(false) }
        val current = RunnerPage.keepFreeValue(runner.int("minFreeDiskMb"))
        Box {
            Row(Modifier.fillMaxWidth().clickable(role = Role.DropdownList) { expanded = true }.padding(vertical = 10.dp)) {
                Text(RunnerCopy.KEEP_FREE, Modifier.weight(1f)); Text(RunnerPage.keepFreeLabel(current), color = Ink.muted)
            }
            DropdownMenu(expanded, { expanded = false }) {
                RunnerPage.keepFreeChoices(current).forEach { (mb, label) ->
                    DropdownMenuItem(text = { Text(label) }, trailingIcon = if (mb == current) { { Text("✓") } } else null, onClick = {
                        expanded = false
                        if (mb != current) scope.launch {
                            model.press { api.patch("runners/$id", buildJsonObject { put("minFreeDiskMb", mb?.let(::JsonPrimitive) ?: JsonNull) }) }?.let(notice::show)
                        }
                    })
                }
            }
        }
    }
}

/** RunnerEngineRow: its version and where its sign-ins stand, a failed update that has become its problem, Sign In when a
 * login it needs is out (or, for an Antigravity that can't sign in with Google here, why not), and one quota window — with
 * several accounts, that of the account a new session starts on, named. */
@Composable
private fun EngineRow(runner: JsonObject, health: JsonObject, offline: Boolean, now: Long, open: () -> Unit) {
    val engine = health.text("engine")
    val installed = health.bool("installed") == true
    val status = RunnerPage.engineStatus(health, runner)
    // Kimi's site after its version while it has the one login: `2.1.1 · kimi.ai`.
    val version = if (installed) listOfNotNull(RunnerPage.engineVersion(health.str("version")), RunnerPage.engineSite(health))
        .takeIf { it.isNotEmpty() }?.joinToString(RunnerCopy.SEP) else null
    val hint = RunnerPage.signInHint(runner, engine)
    val next = RunnerPage.engineNextAccount(runner, engine, now)
    Row(Modifier.fillMaxWidth().clickable(enabled = installed, role = Role.Button, onClick = open).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(RunnerPage.engineName(engine))
            Text(buildAnnotatedString {
                append(version.orEmpty())
                status?.let { (text, tone) ->
                    if (version != null) append(RunnerCopy.SEP)
                    if (tone == "muted") append(text) else withStyle(SpanStyle(color = Ink.tone(tone))) { append(text) }
                }
            }, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            RunnerPage.updateFailedLine(health, now)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.amber) }
            if (hint != null) Text(hint, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
            else if (RunnerPage.needsSignIn(health)) Text(RunnerCopy.SIGN_IN, Modifier.padding(top = 4.dp).clip(RoundedCornerShape(50))
                .background(if (offline) Ink.muted.copy(alpha = .1f) else MaterialTheme.colorScheme.primary.copy(alpha = .12f)).padding(horizontal = 14.dp, vertical = 6.dp),
                color = if (offline) Ink.muted else MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
            next?.let { Text(AccountCopy.next(it), Modifier.padding(top = 8.dp), style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
            val windows = RunnerPage.engineWindows(runner, engine, now)
            if (windows.isNotEmpty()) Column(Modifier.padding(top = if (next == null) 8.dp else 4.dp)) {
                windows.forEach { UsageWindowRow(it, RunnerPage.resetsLine(it, now), withGroup = true) }
            }
        }
        if (installed) Chevron()
    }
}

@Composable
private fun WorkspaceRow(workspace: JsonObject, running: Int, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(workspace.text("name"), maxLines = 1)
            RunnerPage.workspaceLine(workspace).takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.muted, maxLines = 1) }
        }
        if (running > 0) Text(RunnerCopy.workspaceRunning(running), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        Chevron()
    }
}

/** RunnerNamePage: the alias, saved on Done or when the page goes; empty uses the machine's name. */
@Composable
private fun RunnerNamePage(api: ManagementApi, id: String, revision: Long, back: () -> Unit) {
    val model = remember(api) { RunnersModel(api) }
    LaunchedEffect(model, revision) { model.load() }
    val runner = model.runner(id)
    if (runner == null) { if (model.loaded) RunnerGone(RunnerCopy.ABOUT_NAME); return }
    var name by rememberSaveable(id) { mutableStateOf<String?>(null) }
    var seeded by rememberSaveable(id) { mutableStateOf<String?>(null) }
    LaunchedEffect(runner) { if (name == null) RunnerPage.displayName(runner).let { name = it; seeded = it } }
    val current by rememberUpdatedState(RunnerPage.displayName(runner))
    var saved by remember { mutableStateOf(false) }
    fun save() {
        // The field's own state, not a copy made at the last composition: a page that goes right after a keystroke
        // is disposed before it recomposes.
        val typed = name?.trim() ?: return
        // Only what was typed here goes out. iOS sends any difference from the live name (RunnerNamePage.save), which
        // writes an untouched field back over a rename made elsewhere while the page was open.
        if (saved || typed == seeded?.trim() || typed == current) return
        saved = true
        api.background.launch { try { api.patch("runners/$id", buildJsonObject { put("displayName", typed) }) } catch (_: Exception) { } }
    }
    // Leaving saves; a rotation does not leave.
    val activity = LocalActivity.current
    DisposableEffect(id) { onDispose { if (activity?.isChangingConfigurations != true) save() } }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(name.orEmpty(), { name = it }, Modifier.fillMaxWidth(), placeholder = { Text(runner.text("name")) }, singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { save(); back() }))
        Text("Leave empty to use the machine name (${runner.text("name")}).", style = MaterialTheme.typography.bodySmall, color = Ink.muted)
    }
}

/** RunnerEnginePage: one engine CLI on one runner, every account it is signed into, and their sign-ins. */
@Composable
private fun RunnerEnginePage(api: ManagementApi, id: String, engine: String, revision: Long) {
    val model = remember(api) { RunnersModel(api) }
    val resumed = rememberResumed()
    val now = rememberNow(10_000)
    val scope = rememberCoroutineScope()
    val notice = remember { Notice() }
    LaunchedEffect(model, revision, resumed) {
        if (!resumed) return@LaunchedEffect
        model.load()
        // A sign-in lands on the machine's next check-in: read it again while the page is up.
        while (true) { delay(10_000); model.load() }
    }
    val runner = model.runner(id)
    if (runner == null) { if (model.loaded) RunnerGone(RunnerPage.engineName(engine)); return }
    val health = RunnerPage.engines(runner).firstOrNull { it.str("engine") == engine }
    val offline = RunnerPage.isOffline(runner, now)
    // Whose sign-in card is open: an account's id, or "+" for a new one. One at a time: the runner runs one relay at a time.
    var signingIn by remember(id, engine) { mutableStateOf<String?>(null) }
    // The account whose card said its sign-in landed: the card folds back once the runner reports it signed in too.
    var landedHere by remember(id, engine) { mutableStateOf<String?>(null) }
    var renaming by remember { mutableStateOf<RunnerPage.AccountLine?>(null) }
    var removing by remember { mutableStateOf<RunnerPage.AccountLine?>(null) }
    var pausing by remember { mutableStateOf<RunnerPage.AccountLine?>(null) }
    fun show(failure: String?) { failure?.let(notice::show) }
    fun closeSignIn() { signingIn = null; landedHere = null; scope.launch { model.load() } }
    // Said for a moment, then read again now rather than on the next pass.
    fun landed(account: String) = scope.launch { delay(1_500); landedHere = account; model.load() }
    suspend fun pause(line: RunnerPage.AccountLine, minutes: Int?) = model.press {
        api.post("runners/$id/accounts/$engine/${line.id}/pause", buildJsonObject { put("durationMinutes", minutes?.let(::JsonPrimitive) ?: JsonNull) })
    }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
            Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(RunnerPage.engineName(engine), style = MaterialTheme.typography.titleMedium)
                Text(buildAnnotatedString {
                    if (health?.bool("installed") != true) append(RunnerCopy.NOT_INSTALLED) else {
                        val version = RunnerPage.engineVersion(health.str("version"))
                        append(version.orEmpty())
                        RunnerPage.updateNoteOf(health.obj("update"), now)?.let { (tone, text) ->
                            if (version != null) append(RunnerCopy.SEP)
                            if (tone == "warn") withStyle(SpanStyle(color = Ink.amber)) { append(text) } else append(text)
                        }
                    }
                }, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                health?.let { RunnerPage.updateFailedLine(it, now) }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.amber) }
            }
            if (health != null && health.bool("installed") == true && RunnerPage.isLoginEngine(engine)) {
                // Every Google sign-in on the page starts above this footer, so Google's terms are said here, once.
                val terms = engine == "antigravity" && RunnerPage.antigravityCanSignIn(runner)
                FormSection(RunnerPage.accountsTitle(runner, engine), footer = if (offline && !terms) RunnerCopy.ENGINES_OFFLINE_FOOTER else null,
                    footerContent = if (terms) { { GoogleSignInTerms(); if (offline) FooterText(RunnerCopy.ENGINES_OFFLINE_FOOTER) } } else null) {
                    val alone = health.list("accounts").size < 2
                    RunnerPage.accountLines(health).forEachIndexed { index, line ->
                        if (index > 0) HorizontalDivider()
                        AccountRow(api, runner, engine, line, offline, now, signingIn == line.id, next = RunnerPage.marksNext(runner, engine, line.id, now),
                            canPause = RunnerPage.keepsAccounts(engine) && health.list("accounts").any { it.str("id") == line.id }, alone = alone,
                            foldsBack = signingIn == line.id && landedHere == line.id && line.auth == "yes" && RunnerPage.loginExpiresLine(line, now) == null,
                            signIn = { signingIn = line.id }, close = ::closeSignIn, landed = { landed(line.id) },
                            rename = { renaming = line }, remove = { removing = line }, pause = { pausing = line },
                            resume = { scope.launch { show(pause(line, null)) } })
                    }
                    if (RunnerPage.canAddAccount(runner, engine)) {
                        HorizontalDivider()
                        AddAccountRow(api, model, runner, engine, health, offline, adding = signingIn == "+", start = { signingIn = "+" },
                            close = ::closeSignIn, show = ::show)
                    } else RunnerPage.signInHint(runner, engine)?.let { hint ->
                        HorizontalDivider()
                        Text(hint, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                    }
                }
            }
            FormSection(footer = if (offline) RunnerCopy.ENGINES_OFFLINE_FOOTER else RunnerCopy.ENGINES_FOOTER) {
                TextButton(enabled = !offline && !RunnerPage.engineUpdateInFlight(runner.obj("install")), onClick = {
                    scope.launch { show(model.press { api.post("runners/$id/engine-update") }) }
                }) { Text(RunnerCopy.UPDATE_ENGINES_NOW) }
                RunnerPage.updateRelayLine(runner.obj("install"))?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
            }
            Spacer(Modifier.height(48.dp))
        }
        notice.Host(Modifier.align(Alignment.BottomCenter))
    }
    renaming?.let { line ->
        var draft by remember(line.id) { mutableStateOf(line.name) }
        AlertDialog(onDismissRequest = { renaming = null }, title = { Text("Rename Account") }, text = {
            OutlinedTextField(draft, { draft = it }, placeholder = { Text(if (line.isDefault) "Default" else "Name") }, singleLine = true)
        }, confirmButton = { TextButton(onClick = {
            renaming = null
            // The session rename's rules: trimmed, and an empty or unchanged name changes nothing.
            val name = draft.trim()
            if (name.isNotEmpty() && name != line.name) scope.launch {
                show(model.press { api.patch("runners/$id/accounts/$engine/${line.id}", buildJsonObject { put("name", name) }) })
            }
        }) { Text("Save") } }, dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } })
    }
    removing?.let { line ->
        AlertDialog(onDismissRequest = { removing = null }, title = { Text("Remove “${line.name}” from ${RunnerPage.displayName(runner)}?") },
            text = { Text("${line.home ?: "Its sign-in"} goes from this machine, and sessions stop running on it. Default is untouched.") },
            confirmButton = { TextButton(onClick = { removing = null; scope.launch {
                try {
                    val state = api.delete("runners/$id/accounts/$engine/${line.id}") as? JsonObject
                    model.load()
                    if (state?.str("status") == "failed") show(state.str("message"))
                } catch (e: CancellationException) { throw e } catch (e: Exception) { show(personalFailure(e)) }
            } }) { Text("Remove", color = Ink.red) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } })
    }
    pausing?.let { line -> AccountPauseDialog(line.name, PAUSE_SCOPE, onDismiss = { pausing = null }) { minutes -> pause(line, minutes) } }
}

/** What a runner account's pause applies to, as the Pause Account dialog says it. */
private const val PAUSE_SCOPE = "Personal account · This runner. Paused sessions wait until it resumes or you switch accounts."

/**
 * One account: its name — NEXT beside it where a new session starts on it ([next]) — and where it lives, where it stands,
 * its windows — a login about to lapse, a pause, what being signed out costs — and its way (back) in where it is out. Its
 * presses are its ⋯ menu's (the swipe iOS gives it): Rename…, Sign In Again, Pause… or Resume Now and Change Duration…,
 * Remove… for an added one. None reach an offline machine but Rename… and the pause, which Orbit keeps.
 */
@Composable
private fun AccountRow(api: ManagementApi, runner: JsonObject, engine: String, line: RunnerPage.AccountLine, offline: Boolean, now: Long,
                       signingIn: Boolean, next: Boolean, canPause: Boolean, alone: Boolean, foldsBack: Boolean, signIn: () -> Unit,
                       close: () -> Unit, landed: () -> Unit, rename: () -> Unit, remove: () -> Unit, pause: () -> Unit, resume: () -> Unit) {
    val windows = RunnerPage.accountWindows(runner, engine, line.id)
    val removal = RunnerPage.removal(runner.obj("accountRemove"), engine, line.id)
    val paused = RunnerPage.isPaused(line.pausedUntil, now)
    val canSignIn = RunnerPage.canSignIn(runner, engine)
    val signInBlocked = offline || removal?.first == true
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(foldsBack) { if (foldsBack) close() }
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                // Where Automatic starts the next session: the account pools' mark for the same thing.
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(line.name, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.titleMedium)
                    if (next) Chip("NEXT")
                }
                // What doesn't fit goes from the middle: a Kimi account's site leads the line, and the directory's last part
                // is what tells two accounts apart.
                line.subtitle?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.muted, maxLines = 1, overflow = TextOverflow.MiddleEllipsis) }
            }
            RunnerPage.authStatus(line.auth)?.let { (text, tone) -> Text(text, style = MaterialTheme.typography.bodySmall, color = Ink.tone(tone)) }
            Box {
                TextButton(onClick = { menu = true }) { Text("⋯", Modifier.clearAndSetSemantics { contentDescription = "More for ${line.name}" }) }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text(AccountCopy.RENAME) }, onClick = { menu = false; rename() })
                    if (line.auth == "yes" && !line.envKey && canSignIn) DropdownMenuItem(text = { Text(AccountCopy.SIGN_IN_AGAIN) },
                        enabled = !signInBlocked, onClick = { menu = false; signIn() })
                    if (canPause) {
                        if (paused) {
                            DropdownMenuItem(text = { Text(AccountCopy.RESUME_NOW) }, onClick = { menu = false; resume() })
                            DropdownMenuItem(text = { Text(AccountCopy.CHANGE_DURATION) }, onClick = { menu = false; pause() })
                        } else if (line.auth == "yes") DropdownMenuItem(text = { Text(AccountCopy.PAUSE) }, onClick = { menu = false; pause() })
                    }
                    if (!line.isDefault) {
                        HorizontalDivider()
                        DropdownMenuItem(text = { Text(AccountCopy.REMOVE, color = if (offline) Ink.muted else Ink.red) }, enabled = !offline,
                            onClick = { menu = false; remove() })
                    }
                }
            }
        }
        if (windows.isNotEmpty()) windows.forEach { UsageWindowRow(it, RunnerPage.resetsLine(it, now), withGroup = true) }
        else if (line.envKey) Text(AccountCopy.ENV_KEY_LINE, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
        else if (line.auth == "yes" && RunnerPage.reportsQuota(engine)) Text(
            if (RunnerPage.accountNoQuotaLimit(runner, engine, line.id)) RunnerCopy.NO_QUOTA_LIMIT else RunnerCopy.NO_QUOTA,
            style = MaterialTheme.typography.labelMedium, color = Ink.muted)
        // A login about to lapse, said before it does the way Claude Code says it, with the way to renew it beside it.
        if (!signingIn) RunnerPage.loginExpiresLine(line, now)?.let { expiring ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("⚠ $expiring", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = Ink.amber)
                OutlinedButton(onClick = signIn, enabled = !signInBlocked) { Text(AccountCopy.RENEW) }
            }
        }
        removal?.second?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.red) }
        if (signingIn) RunnerSignInCard(api, runner, engine, account = line.signInAccount, autoStart = true, onClose = close, onSignedIn = landed)
        else {
            // Paused is the row's state; Resume and a new duration are its menu's.
            AccountPauseLine(line.pausedUntil)
            RunnerPage.signedOutNote(line, alone, engine)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
            // A Default on the machine's Gemini key is not signed in to Google: alone, it offers that sign-in; beside Google
            // accounts, Add Account is where another joins. An account signed in is signed in again from its menu.
            if (canSignIn && (!line.envKey || alone) && line.auth != "yes") OutlinedButton(onClick = signIn, enabled = !signInBlocked) {
                Text(if (line.envKey) AccountCopy.SIGN_IN_WITH_GOOGLE else RunnerCopy.SIGN_IN)
            }
        }
    }
}

/** GoogleSignInTermsView: Google's terms, with the way to read them. */
@Composable
private fun GoogleSignInTerms() {
    val uri = LocalUriHandler.current
    FooterText(AccountCopy.GOOGLE_TERMS_WARNING)
    Text(AccountCopy.GOOGLE_TERMS, Modifier.clickable(role = Role.Button) { runCatching { uri.openUri(AccountCopy.GOOGLE_TERMS_URL) } }
        .padding(vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun FooterText(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

/**
 * Add Account: the same sign-in, started by the press under a name the page picks; the name stays editable and is
 * given to the account once the runner reports it. The card folds back when that account is signed in and named.
 */
@Composable
private fun AddAccountRow(api: ManagementApi, model: RunnersModel, runner: JsonObject, engine: String, health: JsonObject, offline: Boolean,
                          adding: Boolean, start: () -> Unit, close: () -> Unit, show: (String?) -> Unit) {
    val id = runner.text("id")
    var name by remember(id, engine) { mutableStateOf("") }
    var picked by remember(id, engine) { mutableStateOf("") }
    var before by remember(id, engine) { mutableStateOf<Set<String>?>(null) }
    var waiting by remember(id, engine) { mutableStateOf<String?>(null) }
    var renamingAdded by remember(id, engine) { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val accounts = health.list("accounts")
    val added = before?.let { had -> accounts.lastOrNull { it.text("id") !in had } }
    fun renameAdded(account: JsonObject, to: String) {
        if (to == RunnerPage.accountLabel(account.text("id"), listOf(account))) return
        renamingAdded = true
        scope.launch {
            show(model.press { api.patch("runners/$id/accounts/$engine/${account.text("id")}", buildJsonObject { put("name", to) }) })
            renamingAdded = false
        }
    }
    fun saveName() {
        val typed = name.trim()
        when {
            typed.isEmpty() -> name = added?.let { RunnerPage.accountLabel(it.text("id"), listOf(it)) } ?: waiting ?: picked
            added != null -> renameAdded(added, typed)
            else -> waiting = typed
        }
    }
    LaunchedEffect(added?.text("id")) { val account = added ?: return@LaunchedEffect; waiting?.let { waiting = null; renameAdded(account, it) } }
    val done = added != null && added.str("auth") == "yes" && !focused && waiting == null && !renamingAdded &&
        name.trim() == RunnerPage.accountLabel(added.text("id"), listOf(added))
    LaunchedEffect(done) { if (done && adding) close() }
    if (adding) Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth().onFocusChanged { state -> if (focused && !state.isFocused) saveName(); focused = state.isFocused },
            label = { Text("Account name") }, placeholder = { Text("Work") }, singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { saveName() }))
        // The card's own Cancel or Close puts it away; the name typed so far is saved as it goes.
        RunnerSignInCard(api, runner, engine, accountName = name, autoStart = true, onClose = { saveName(); close() })
    } else TextButton(enabled = !offline, onClick = {
        picked = RunnerPage.defaultAccountName(accounts); name = picked
        before = accounts.map { it.text("id") }.toSet(); waiting = null
        start()
    }) { Text(AccountCopy.ADD_ACCOUNT) }
}

/** RunnerSignInModel: one engine/account's sign-in relay on a runner, read every 2s while it is in flight. */
@Stable
private class SignInRelay(private val api: ManagementApi, val runnerId: String, val engine: String, val account: String?, val adding: Boolean) {
    var relay by mutableStateOf<JsonObject?>(null); private set
    var busy by mutableStateOf(false); private set
    var submitting by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var code by mutableStateOf("")
    private var sent by mutableStateOf(false)
    private var watched by mutableStateOf(false)
    private var startedHere = false
    private var poll: Job? = null

    private val mine get(): Boolean {
        val relayEngine = relay?.str("engine") ?: return true
        if (relayEngine != engine) return false
        if (adding) return startedHere
        return account == null || relay?.str("account") == account
    }
    private fun inFlight(status: String?) = status in setOf("pending", "awaiting_code", "awaiting_approval")
    val status get(): String? {
        val reported = if (mine) relay?.str("status") else null
        return if (watched || inFlight(reported)) reported else null
    }
    /** A sign-in of this card's is under way: one another device started for the account is followed, not started over. */
    val underWay get() = inFlight(status)
    val verifying get() = submitting || (sent && status == "awaiting_code" && relay?.str("message") == null)
    val url get() = if (mine) relay?.str("url") else null
    val userCode get() = if (mine) relay?.str("userCode") else null
    val message get() = if (mine) relay?.str("message") else null
    /** Kimi: the site the page it signs in on belongs to, read off its address. */
    val site get() = if (engine == "kimi") KimiSite.ofUrl(url) else null

    suspend fun refresh(scope: CoroutineScope) {
        try { adopt(api.get("runners/$runnerId/login").jsonObject, scope) } catch (e: CancellationException) { throw e } catch (_: Exception) { }
    }
    /** [site]: Kimi's, where the press names one (KimiSite.named); naming none is the runner's bare `kimi login`. */
    suspend fun begin(accountName: String?, scope: CoroutineScope, site: KimiSite? = null) = act(scope) {
        startedHere = true
        val name = if (adding) accountName?.trim() else null
        api.post("runners/$runnerId/login", buildJsonObject {
            put("engine", engine); account?.let { put("account", it) }; name?.let { put("accountName", it) }; site?.let { put("region", it.region) }
        })
    }
    suspend fun submit(scope: CoroutineScope) {
        val trimmed = code.trim()
        if (trimmed.isEmpty()) return
        submitting = true
        sent = true
        val ok = act(scope) { api.post("runners/$runnerId/login/code", buildJsonObject { put("code", trimmed) }) }
        if (ok) code = "" else sent = false
        submitting = false
    }
    suspend fun cancel(scope: CoroutineScope) = act(scope) { api.delete("runners/$runnerId/login") }

    private suspend fun act(scope: CoroutineScope, request: suspend () -> JsonElement): Boolean {
        error = null; busy = true
        return try { adopt(request().jsonObject, scope); true }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = if (e is ApiError && e.status == 401) "Session expired — sign in to Orbit again." else "Request failed — check your connection."; false }
        finally { busy = false }
    }
    private fun adopt(next: JsonObject, scope: CoroutineScope) {
        relay = next
        if (inFlight(next.str("status")) && mine) watched = true
        if (status != "awaiting_code") sent = false
        if (inFlight(next.str("status")) && poll?.isActive != true) poll = scope.launch {
            while (true) {
                delay(2_000)
                val read = try { api.get("runners/$runnerId/login").jsonObject } catch (e: CancellationException) { throw e } catch (_: Exception) { continue }
                adopt(read, scope)
                if (!inFlight(read.str("status"))) break
            }
        }
    }
}

/**
 * RunnerSignInView: the relay for one engine/account, from start to signed in. With [autoStart] the press that raised the
 * card — Add Account, an account's Sign In, Sign In Again or Renew — already asked for the sign-in, so it starts as the card
 * appears; a card for an account the runner has follows a sign-in already under way for it instead. Kimi's starts on the site
 * it is asked for, so its card never starts one by appearing. Given [onClose], the card offers the one way to put it away:
 * Cancel while a sign-in is under way (cancelling it first), Close otherwise — never both. [onSignedIn]: the sign-in landed.
 */
@Composable
internal fun RunnerSignInCard(api: ManagementApi, runner: JsonObject, engine: String, account: String? = null, accountName: String? = null,
                             autoStart: Boolean = false, onClose: (() -> Unit)? = null, onSignedIn: (() -> Unit)? = null) {
    val runnerId = runner.text("id")
    val scope = rememberCoroutineScope()
    val relay = remember(runnerId, engine, account) { SignInRelay(api, runnerId, engine, account, adding = accountName != null) }
    // A card adding an account signs in under its name: nothing starts while it has none.
    val named = accountName == null || accountName.isNotBlank()
    val uri = LocalUriHandler.current
    val context = LocalContext.current
    val cli = RunnerPage.engineName(engine)
    LaunchedEffect(relay) {
        if (autoStart && engine != "kimi") {
            if (accountName == null) relay.refresh(this)
            if (!relay.underWay) relay.begin(accountName, this)
        } else relay.refresh(this)
    }
    val done = relay.status == "done"
    LaunchedEffect(done) { if (done) onSignedIn?.invoke() }
    fun open(url: String) { runCatching { uri.openUri(url) } }
    val page = relay.url?.takeIf { runCatching { java.net.URI(it).scheme == "https" }.getOrDefault(false) }
    @Composable fun cancel() = TextButton(onClick = { scope.launch { if (relay.cancel(scope)) onClose?.invoke() } }, enabled = !relay.busy) {
        Text(AccountCopy.CANCEL)
    }
    @Composable fun close() { onClose?.let { TextButton(onClick = it) { Text(AccountCopy.CLOSE) } } }
    @Composable fun waiting(title: String, hint: String) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Text(title, style = MaterialTheme.typography.labelMedium)
        }
        Text(hint, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
        cancel()
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when (relay.status) {
            "done" -> { Text("✓ Signed in — this runner is ready.", style = MaterialTheme.typography.labelMedium, color = Ink.green); close() }
            "pending" -> waiting("Starting sign-in on the runner…", "The runner picks it up on its next check-in, so the link can take up to a minute to show here.")
            // Device flow: the code comes first, and one press both copies it and opens the page it goes into — over there,
            // all that is left is a paste.
            "awaiting_approval" -> {
                // Kimi's page belongs to one of its two sites, named so the user knows which account it wants — on a card
                // adding one, the account being added.
                val site = relay.site
                Text((if (accountName != null) site?.enterCodeAdding else site?.enterCode) ?: AccountCopy.ENTER_CODE,
                    style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                relay.userCode?.let { code ->
                    SelectionContainer { Text(code, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold), fontFamily = FontFamily.Monospace) }
                }
                page?.let { url ->
                    Button(onClick = { relay.userCode?.let { copyText(context, "Sign-in code", it) }; open(url) }) {
                        Text(if (relay.userCode != null) site?.copyCodeAndOpen ?: AccountCopy.COPY_CODE_AND_OPEN else site?.openPage ?: AccountCopy.OPEN_PAGE)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Text(AccountCopy.WAITING_FOR_APPROVAL, style = MaterialTheme.typography.labelMedium)
                }
                // The wrong site is the one mistake the user can't see until they are on its page: their account isn't there.
                // Starting over on the other one — under the same name, for an account being added — is a single press.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    cancel()
                    site?.other?.let { other ->
                        TextButton(onClick = { scope.launch { relay.begin(accountName, scope, KimiSite.named(other, runner)) } }, enabled = !relay.busy) {
                            Text(other.useInstead)
                        }
                    }
                }
            }
            "awaiting_code" -> if (relay.verifying) waiting("Signing in with your code…", "The runner picks it up on its next check-in, so this can take up to a minute.")
            else PasteBack(relay, page, ::open) { cancel() }
            else -> {
                if (engine == "antigravity") GoogleSignInTerms()
                if (relay.status == "failed") relay.message?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.amber) }
                // Kimi's sign-in is itself a choice: kimi.com and kimi.ai keep separate accounts, and left to itself the CLI goes
                // to the site its installer came from. So the press that starts it picks the site, and nothing is picked for the
                // user; Current marks the site of the login it signs in again.
                if (engine == "kimi") {
                    Text(KimiSite.QUESTION, style = MaterialTheme.typography.labelMedium)
                    val current = KimiSite.current(runner, account, adding = accountName != null)
                    KimiSite.entries.forEach { site ->
                        KimiSiteButton(site, current == site, enabled = !relay.busy && named) {
                            scope.launch { relay.begin(accountName, scope, KimiSite.named(site, runner)) }
                        }
                    }
                    Text(KimiSite.SEPARATE_ACCOUNTS, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                } else Button(onClick = { scope.launch { relay.begin(accountName, scope) } }, enabled = !relay.busy && named) {
                    Text(when {
                        relay.busy -> "Starting…"; relay.status == "failed" -> "Try signing in to $cli again"
                        engine == "antigravity" -> AccountCopy.SIGN_IN_WITH_GOOGLE; else -> "Sign in to $cli"
                    })
                }
                close()
            }
        }
        relay.error?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.red) }
    }
}

/** One of Kimi's sites as the press that signs in on it: its domain, whose accounts it holds, and Current on the site of the
 * login the card signs in again. */
@Composable
private fun KimiSiteButton(site: KimiSite, current: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().alpha(if (enabled) 1f else .38f),
        shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surface) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(site.domain, style = MaterialTheme.typography.titleMedium)
                Text(site.place, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
            }
            if (current) Chip(KimiSite.CURRENT, brand = true)
        }
    }
}

/**
 * PasteBackForm (Claude, Antigravity): the page hands over a code that comes back through here. The prominent press follows
 * the next step: Open the sign-in page until it was opened from here and the app came back, then Paste, which reads the
 * clipboard and sends the code at once (Android says it was pasted, as it does for every app). A code typed by hand goes
 * with Submit, or Done.
 */
@Composable
private fun PasteBack(relay: SignInRelay, page: String?, open: (String) -> Unit, cancel: @Composable () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var opened by remember { mutableStateOf(false) }
    var returned by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Back from the page this opened: the code is on the clipboard now, so Paste is the press.
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME && opened) returned = true }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    fun submit() { scope.launch { relay.submit(scope) } }
    // A rejected code lands back here with the same page still valid: the message is what says anything changed.
    relay.message?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.amber) }
    page?.let { url ->
        if (returned) TextButton(onClick = { open(url) }) { Text(AccountCopy.OPEN_PAGE) }
        else Button(onClick = { opened = true; open(url) }) { Text(AccountCopy.OPEN_PAGE) }
    }
    Text(AccountCopy.APPROVE_THEN_PASTE, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        OutlinedTextField(relay.code, { relay.code = it }, Modifier.weight(1f), placeholder = { Text(AccountCopy.PASTE_THE_CODE) }, singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }))
        if (relay.code.isNotBlank()) OutlinedButton(onClick = ::submit, enabled = !relay.busy) { Text(AccountCopy.SUBMIT) }
        else {
            val paste = {
                pasteText(context)?.trim()?.takeIf { it.isNotEmpty() }?.let { code -> relay.code = code; submit() }
                Unit
            }
            if (returned) Button(onClick = paste, enabled = !relay.busy) { Text("Paste") }
            else OutlinedButton(onClick = paste, enabled = !relay.busy) { Text("Paste") }
        }
    }
    cancel()
}

/** AddRunnerSheet: the install command, waiting for the new machine, and approving one with no browser. */
@Composable
private fun AddRunnerDialog(api: ManagementApi, onDismiss: () -> Unit, open: (String) -> Unit) {
    val model = remember(api) { RunnersModel(api) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var platform by rememberSaveable { mutableStateOf("macOS") }
    var copied by remember { mutableStateOf(false) }
    var baseline by remember { mutableStateOf<Set<String>?>(null) }
    var arrived by remember { mutableStateOf<JsonObject?>(null) }
    var code by rememberSaveable { mutableStateOf("") }
    var lookedUp by remember { mutableStateOf<String?>(null) }
    var device by remember { mutableStateOf<JsonObject?>(null) }
    var looking by remember { mutableStateOf(false) }
    var approving by remember { mutableStateOf(false) }
    var approved by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val command = RunnerPage.installCommand(platform, RunnerPage.origin(api.handle.account.server))
    LaunchedEffect(model) {
        // No push says a runner came online, so the list is read until one does.
        while (true) {
            model.load()
            if (baseline != null) { if (arrived == null) arrived = RunnerPage.newlyOnline(model.runners, baseline!!) }
            else if (model.loaded && !model.failed) baseline = model.runners.filter { it.bool("online") == true }.map { it.text("id") }.toSet()
            delay(5_000)
        }
    }
    LaunchedEffect(copied) { if (copied) { delay(1_600); copied = false } }
    fun lookUp(userCode: String) {
        lookedUp = userCode; device = null; approved = false; message = null; looking = true
        scope.launch {
            try {
                val info = api.get("runners/device/$userCode").jsonObject
                if (lookedUp == userCode) { device = info; approved = info.str("status") == "APPROVED" }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (lookedUp == userCode) message = personalFailure(e) }
            finally { looking = false }
        }
    }
    LaunchedEffect(code) { RunnerPage.deviceCode(code)?.takeIf { it != lookedUp }?.let(::lookUp) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(RunnerCopy.ADD, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = onDismiss) { Text("Close") }
                }
                Text(RunnerCopy.ADD_LEAD, Modifier.padding(vertical = 12.dp))
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    listOf("macOS", "Linux", "Windows").forEachIndexed { index, choice ->
                        SegmentedButton(selected = platform == choice, onClick = { platform = choice },
                            shape = SegmentedButtonDefaults.itemShape(index, 3)) { Text(choice) }
                    }
                }
                Column(Modifier.fillMaxWidth().padding(top = 12.dp).clip(RoundedCornerShape(16.dp)).background(Color(0xFF1C1C1E)).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    SelectionContainer { Text(buildAnnotatedString { withStyle(SpanStyle(color = Color.Gray)) { append("$ ") }; append(command) },
                        color = Color.White, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilledTonalButton(onClick = { copyText(context, "Install command", command); copied = true }) { Text(if (copied) "Copied" else RunnerCopy.COPY) }
                        FilledTonalButton(onClick = { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                            .putExtra(Intent.EXTRA_TEXT, command), null)) }) { Text(RunnerCopy.SHARE) }
                    }
                }
                FormSection {
                    val newRunner = arrived
                    if (newRunner != null) Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("✓ Runner online — “${RunnerPage.displayName(newRunner)}” is ready", Modifier.weight(1f), color = Ink.green)
                        Button(onClick = { open(newRunner.text("id")) }) { Text("Open") }
                    } else Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Text(RunnerCopy.WAITING_FOR_NEW)
                    }
                }
                FormSection(RunnerCopy.NO_BROWSER, footer = RunnerCopy.DEVICE_CODE_FOOTER) {
                    OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth().padding(vertical = 4.dp), label = { Text(RunnerCopy.DEVICE_CODE) },
                        placeholder = { Text(RunnerCopy.DEVICE_CODE_PLACEHOLDER) }, singleLine = true, textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false, imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { code.trim().uppercase().takeIf { it.isNotEmpty() }?.let { lookUp(RunnerPage.deviceCode(it) ?: it) } }))
                    if (looking) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    device?.let { info ->
                        val name = info.text("name")
                        Row(Modifier.padding(vertical = 6.dp)) { Text("Runner", Modifier.weight(1f)); Text(name, color = Ink.muted) }
                        info.str("hostname")?.takeIf { it.isNotEmpty() && it != name }?.let { host ->
                            Row(Modifier.padding(vertical = 6.dp)) { Text(RunnerCopy.ABOUT_HOSTNAME, Modifier.weight(1f)); Text(host, color = Ink.muted) }
                        }
                        (info["labels"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.takeIf { it.isNotEmpty() }?.let { labels ->
                            Row(Modifier.padding(vertical = 6.dp)) { Text("Labels", Modifier.weight(1f)); Text(labels.joinToString(", "), color = Ink.muted) }
                        }
                        if (approved) Text("✓ “$name” is now registered. Return to your terminal — it will continue automatically.", color = Ink.green)
                        else {
                            val conflict = info.bool("nameConflict") == true
                            if (conflict) Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text("This runner (“$name”) is already registered on your account.", color = Ink.amber, fontWeight = FontWeight.SemiBold)
                                Text("Approving re-issues its credential. The old credential stops working; no duplicate runner is created.",
                                    color = Ink.amber, style = MaterialTheme.typography.labelMedium)
                            }
                            TextButton(enabled = !approving, onClick = {
                                val userCode = lookedUp ?: return@TextButton
                                approving = true; message = null
                                scope.launch {
                                    try { api.post("runners/device/$userCode/approve"); approved = true }
                                    catch (e: CancellationException) { throw e } catch (e: Exception) { message = personalFailure(e) }
                                    finally { approving = false }
                                }
                            }) { Text(if (conflict) "Re-register machine" else RunnerCopy.APPROVE, color = if (conflict) Ink.red else MaterialTheme.colorScheme.primary) }
                        }
                    }
                    message?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.red) }
                }
            }
        }
    }
}
