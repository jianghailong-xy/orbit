package io.orbitd.android.reader

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.R
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.Tag
import io.orbitd.android.directory.directoryError
import io.orbitd.android.management.ShareCopy
import io.orbitd.android.management.sharingPublicUrl
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.tasks.TaskDetailLogic
import io.orbitd.android.tasks.resolvedRunState
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastTone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import io.orbitd.android.reader.SessionSettings as S

private enum class SettingsPage { MAIN, VARIABLES, WORK }

/**
 * The session's Settings (docs/mocks/session-settings, Android ⑤-⑦): a whole page over the conversation, its back arrow closing it.
 * Session (labels, public link), Environment (working directory, Compact at, variables and the restart they wait for), Notifications
 * and Info — where Session details' worktree, diff and background work now live, a page down. Each change is sent as it is made.
 * [writable]: a fresh session and directory, as every Android write waits for.
 */
@Composable
internal fun SessionSettingsPage(session: SessionState?, api: DirectoryApi, server: String, allTags: List<Tag>, writable: Boolean,
    open: (String) -> Unit, refresh: () -> Unit, close: () -> Unit) {
    val detail = session?.snapshot?.detail ?: return
    val id = session.id
    var page by remember { mutableStateOf(SettingsPage.MAIN) }
    // What the last write answered, until the session's own detail catches up.
    var answered by remember(id) { mutableStateOf<S.State?>(null) }
    var labels by remember(id) { mutableStateOf<List<S.Label>?>(null) }
    val state = answered ?: S.state(detail["settings"])
    LaunchedEffect(detail) { answered = null; labels = null }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val canWrite = writable && !busy
    fun write(request: suspend () -> Unit) {
        busy = true
        scope.launch {
            try { request(); refresh() }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { OrbitToasts.show("Couldn't save the change", detail = directoryError(failure), tone = ToastTone.ERROR) }
            finally { busy = false }
        }
    }
    fun patch(body: JsonObject) = write {
        val reply = Wire.json.parseToJsonElement(api.mutate(listOf("sessions", id, "settings"), HttpMethod.PATCH, body).decodeToString())
        S.state((reply as? JsonObject)?.let { it["settings"] ?: it })?.let { answered = it }
    }
    val running = resolvedRunState(detail) == "RUNNING"
    fun restart() = write {
        try {
            val reply = Wire.json.parseToJsonElement(api.mutate(listOf("sessions", id, "restart")).decodeToString()) as? JsonObject
            OrbitToasts.show(S.restartToast(reply?.string("afterTurn") == "true"), tone = ToastTone.INFO)
        } catch (refused: ApiError) {
            if (refused.code != "ENGINE_NOT_RUNNING") throw refused
            OrbitToasts.show(S.ENGINE_ENDED, tone = ToastTone.INFO)
        }
    }
    val back = { if (page == SettingsPage.MAIN) close() else page = SettingsPage.MAIN }
    Dialog(back, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize()) { Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = back) {
                    Icon(painterResource(R.drawable.ic_back), if (page == SettingsPage.MAIN) "Close settings" else "Back to settings")
                }
                Text(when (page) { SettingsPage.MAIN -> "Session settings"; SettingsPage.VARIABLES -> "Variables"; SettingsPage.WORK -> "Worktree and background jobs" },
                    style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            when (page) {
                SettingsPage.MAIN -> LazyColumn(Modifier.fillMaxSize().testTag("session-settings"), contentPadding = PaddingValues(bottom = 24.dp)) {
                    sessionGroup(id, labels ?: S.labels(detail), allTags, server, api, canWrite) { next ->
                        labels = next; write { api.mutate(listOf("sessions", id, "tags"), HttpMethod.PUT, S.tagsBody(next.map { it.id })) }
                    }
                    if (state != null) {
                        environmentGroup(detail, state, running, canWrite, { patch(S.envPatch(it)) }, { page = SettingsPage.VARIABLES }, ::restart)
                        notificationsGroup(state, canWrite, ::patch)
                    }
                    infoGroup(id, detail, session.fresh, open) { page = SettingsPage.WORK }
                }
                SettingsPage.VARIABLES -> if (state != null) VariablesPage(state, running, canWrite, { patch(S.envPatch(it)) }, ::restart)
                SettingsPage.WORK -> SessionWorkContent(session, api, Modifier.fillMaxSize())
            }
        } }
    }
}

// ---- Groups ----

private fun LazyListScope.sessionGroup(id: String, labels: List<S.Label>, allTags: List<Tag>, server: String, api: DirectoryApi,
    enabled: Boolean, setLabels: (List<S.Label>) -> Unit) {
    item { Header("Session") }
    item { LabelsRow(labels, allTags, enabled, setLabels) }
    item { PublicLinkRow(id, server, api, enabled) }
    item { HorizontalDivider(Modifier.padding(top = 8.dp)) }
}

private fun LazyListScope.environmentGroup(detail: JsonObject, state: S.State, running: Boolean, enabled: Boolean,
    setEnv: (Map<String, String>) -> Unit, variables: () -> Unit, restart: () -> Unit) {
    item { Header("Environment", "Applies when the engine next starts") }
    item { Row2("Working directory", S.workingDirectory(detail) ?: "Not reported", mono = true) }
    item {
        var choosing by remember { mutableStateOf(false) }
        Row2("Compact at", S.compactLabel(state), onClick = { choosing = true }.takeIf { enabled })
        if (choosing) ChoiceDialog("Compact at", S.compactChoices(state), state.env[S.COMPACT_VARIABLE], { choosing = false }) {
            setEnv(S.withCompact(state.env, it))
        }
    }
    item { Row2("Variables", S.variablesSummary(state), onClick = variables, chevron = true) }
    if (state.envPendingRestart) item { RestartCard(running, enabled, restart) }
    item { HorizontalDivider(Modifier.padding(top = 8.dp)) }
}

private fun LazyListScope.notificationsGroup(state: S.State, enabled: Boolean, patch: (JsonObject) -> Unit) {
    item { Header("Notifications", "iOS and Android") }
    listOf(false to "When a turn finishes", true to "When it needs you").forEach { (needsYou, title) ->
        item {
            var choosing by remember { mutableStateOf(false) }
            val value = if (needsYou) state.notifyNeedsYou else state.notifyTurnFinished
            Row2(title, value.label, onClick = { choosing = true }.takeIf { enabled })
            if (choosing) ChoiceDialog(title, S.Notify.entries.map { it.wire to it.label }, value.wire, { choosing = false }) {
                patch(S.notifyPatch(needsYou, S.Notify.of(it)))
            }
        }
    }
    item {
        Row(Modifier.fillMaxWidth().toggleable(state.muted, enabled = enabled, role = Role.Switch) { patch(S.mutePatch(it)) }
            .padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Mute this session")
                Text("No notifications at all, until you turn this off", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(state.muted, null, enabled = enabled)
        }
    }
    item { HorizontalDivider(Modifier.padding(top = 8.dp)) }
}

private fun LazyListScope.infoGroup(id: String, detail: JsonObject, fresh: Boolean, open: (String) -> Unit, work: () -> Unit) {
    item { Header("Info") }
    item { Row2("Engine", S.engineLine(detail) ?: "Not reported") }
    item { Row2("Runner · Account", S.runnerAccount(detail) ?: "Not assigned") }
    S.branch(detail)?.let { item { Row2("Branch", it, mono = true) } }
    S.created(detail.string("createdAt"))?.let { item { Row2("Created", it) } }
    S.usage(detail)?.let { u ->
        item { Row2("Tokens", S.tokens(S.tokensTotal(u)), sub = S.tokensLine(u)) }
        item { Row2("Cost", S.cost(u), sub = S.turns(u)) }
    }
    item {
        val clipboard = LocalClipboardManager.current
        Row2("Session ID", S.shortId(id) + "  ⧉", mono = true, onClick = {
            clipboard.setText(AnnotatedString(ObjectId.toPublic(id))); OrbitToasts.show("Session ID copied")
        })
    }
    TaskDetailLogic.forkSource(detail)?.let { source -> item { Text(source, Modifier.padding(horizontal = 24.dp, vertical = 8.dp)
        .testTag("session-fork-source"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
    listOf("taskId" to "task", "projectId" to "project", "parentSessionId" to "session").forEach { (key, kind) ->
        detail.string(key)?.let { target ->
            item { Row2(if (kind == "session") "Open parent session" else "Open $kind", "", onClick = { open("orbit-$kind:$target") }.takeIf { fresh }, chevron = true) }
        }
    }
    item { Row2("Worktree and background jobs", S.branch(detail) ?: "No isolated branch", onClick = work, chevron = true) }
}

// ---- Rows ----

@Composable
private fun Header(title: String, note: String? = null) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp), verticalAlignment = Alignment.Bottom) {
        Text(title, Modifier.weight(1f), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.titleSmall)
        note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** A row: its name, what it is set to — beside the name, or under it when long — and, pressed, what it opens. */
@Composable
private fun Row2(title: String, value: String, sub: String? = null, mono: Boolean = false, chevron: Boolean = false, onClick: (() -> Unit)? = null) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).let { if (onClick != null) it.clickable(role = Role.Button, onClick = onClick) else it }
        .padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        val under = chevron || value.length > 28
        Column(Modifier.weight(1f)) {
            Text(title)
            sub?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
            if (under && value.isNotEmpty()) Text(value, style = MaterialTheme.typography.bodySmall, color = muted,
                fontFamily = if (mono) FontFamily.Monospace else null, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (!under) Text(value, Modifier.padding(start = 12.dp), color = muted, style = MaterialTheme.typography.bodyMedium,
            fontFamily = if (mono) FontFamily.Monospace else null, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (chevron) Icon(painterResource(R.drawable.ic_chevron_forward), null, tint = muted)
    }
}

@Composable
private fun LabelsRow(labels: List<S.Label>, allTags: List<Tag>, enabled: Boolean, set: (List<S.Label>) -> Unit) {
    var adding by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Labels")
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            labels.forEach { label ->
                Chip(Modifier.testTag("label-chip")) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(tagColor(label.color)))
                    Text(label.name, style = MaterialTheme.typography.labelLarge)
                    Text("×", Modifier.clickable(enabled, role = Role.Button) { set(labels - label) }.padding(horizontal = 2.dp),
                        style = MaterialTheme.typography.labelLarge)
                }
            }
            Chip(Modifier.clickable(enabled, role = Role.Button) { adding = true }) { Text("+ Add", style = MaterialTheme.typography.labelLarge) }
        }
    }
    if (adding) {
        val on = labels.map { it.id }.toSet()
        val offered = allTags.filter { tag -> on.none { ObjectId.same(it, tag.id) } }
        AlertDialog(onDismissRequest = { adding = false }, title = { Text("Add a label") }, text = {
            Column {
                if (offered.isEmpty()) Text("Every label is on this session. Make new ones from the session list's Tags….")
                offered.forEach { tag ->
                    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { adding = false; set(labels + S.Label(tag.id, tag.name, tag.color)) }
                        .padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).clip(CircleShape).background(tagColor(tag.color))); Text(tag.name)
                    }
                }
            }
        }, confirmButton = { TextButton(onClick = { adding = false }) { Text("Cancel") } })
    }
}

@Composable
private fun Chip(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(8.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
        Row(modifier.padding(horizontal = 10.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically, content = content)
    }
}

private fun tagColor(hex: String?): Color =
    hex?.let { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() } ?: Color(0xFF3B82F6)

/** Public link: on makes one (`PUT /sessions/:id/share`), off — asked first — ends it; the address and Copy while it is live. */
@Composable
private fun PublicLinkRow(id: String, server: String, api: DirectoryApi, enabled: Boolean) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var token by remember(id) { mutableStateOf<String?>(null) }
    var loaded by remember(id) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var confirmingOff by remember { mutableStateOf(false) }
    fun live(link: JsonElement?) = (link as? JsonObject)?.takeIf { it.string("state") != "ENDED" }?.string("token")
    val path = listOf("sessions", id, "share")
    LaunchedEffect(id) {
        try { token = live(api.objectRead(path)["link"]); loaded = true }
        catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
    }
    fun change(on: Boolean) {
        busy = true
        scope.launch {
            try {
                if (on) {
                    val reply = Wire.json.parseToJsonElement(api.mutate(path, HttpMethod.PUT, JsonObject(emptyMap())).decodeToString()) as? JsonObject
                    token = live(reply?.get("link") ?: reply)
                } else { api.mutate(path, HttpMethod.DELETE); token = null }
            }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { OrbitToasts.show("Couldn't change the link", detail = directoryError(failure), tone = ToastTone.ERROR) }
            finally { busy = false }
        }
    }
    val switchable = enabled && loaded && !busy
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth().toggleable(token != null, enabled = switchable, role = Role.Switch) { on ->
            if (on) change(true) else confirmingOff = true
        }, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Public link")
                Text(if (token != null) "Live · anyone with the link can read it" else if (loaded) "Off · only you can read this session" else "Loading…",
                    style = MaterialTheme.typography.bodySmall, color = if (token != null) Color(0xFF16A34A) else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(token != null, null, enabled = switchable)
        }
        token?.let { t ->
            val url = sharingPublicUrl(server, t)
            Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(url, Modifier.weight(1f), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                TextButton(onClick = { clipboard.setText(AnnotatedString(url)); OrbitToasts.show("Link copied") }) { Text("Copy") }
            }
        }
    }
    if (confirmingOff) AlertDialog(onDismissRequest = { confirmingOff = false }, title = { Text(ShareCopy.turnOffTitle) },
        text = { Text(ShareCopy.turnOffDetail) },
        confirmButton = { TextButton(onClick = { confirmingOff = false; change(false) }) { Text("Turn off", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { confirmingOff = false }) { Text("Cancel") } })
}

/** The restart the new variables wait for, while the engine runs: after the turn when one is running, else now. */
@Composable
private fun RestartCard(running: Boolean, enabled: Boolean, restart: () -> Unit) {
    val amber = Color(0xFFB45309)
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).clip(RoundedCornerShape(10.dp))
        .background(amber.copy(alpha = 0.10f)).padding(12.dp).testTag("restart-card"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(S.RESTART_TITLE, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
        Text(S.restartDetail(running), style = MaterialTheme.typography.bodySmall)
        Button(onClick = restart, enabled = enabled) { Text(S.restartAction(running)) }
    }
}

/** A single choice, saved on the press. */
@Composable
private fun ChoiceDialog(title: String, choices: List<Pair<String?, String>>, selected: String?, dismiss: () -> Unit, choose: (String?) -> Unit) {
    AlertDialog(onDismissRequest = dismiss, title = { Text(title) }, text = {
        Column {
            choices.forEach { (value, label) ->
                Row(Modifier.fillMaxWidth().selectable(value == selected, role = Role.RadioButton) {
                    dismiss(); if (value != selected) choose(value)
                }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(value == selected, null); Spacer(Modifier.width(12.dp)); Text(label)
                }
            }
        }
    }, confirmButton = { TextButton(onClick = dismiss) { Text("Cancel") } })
}

/** iOS ③: this session's variables, which it can add, change and delete; the workspace's under them, read-only. */
@Composable
private fun VariablesPage(state: S.State, running: Boolean, enabled: Boolean, setEnv: (Map<String, String>) -> Unit, restart: () -> Unit) {
    var editing by remember { mutableStateOf<Pair<String, String>?>(null) }
    var replacing by remember { mutableStateOf<String?>(null) }
    val own = S.sessionVariables(state)
    LazyColumn(Modifier.fillMaxSize().testTag("session-variables"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) { Header("This session") }
                TextButton(onClick = { replacing = null; editing = "" to "" }, enabled = enabled) { Text("Add") }
            }
        }
        if (own.isEmpty()) item { Text("No variables of its own.", Modifier.padding(horizontal = 16.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        own.forEach { (key, value) ->
            item(key) {
                Row(Modifier.fillMaxWidth().clickable(enabled, role = Role.Button) { replacing = key; editing = key to value }
                    .padding(start = 16.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(key, fontFamily = FontFamily.Monospace)
                        Text(value, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    IconButton(onClick = { setEnv(state.env - key) }, enabled = enabled) { Icon(painterResource(R.drawable.ic_close), "Delete $key") }
                }
            }
        }
        if (state.envPendingRestart) item { RestartCard(running, enabled, restart) }
        val inherited = S.workspaceVariables(state)
        if (inherited.isNotEmpty()) {
            item { Header("From the workspace") }
            inherited.forEach { (key, value) ->
                item("ws:$key") {
                    val muted = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (key in own) 0.45f else 0.8f)
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                        Text(key + if (key in own) "  · replaced" else "", fontFamily = FontFamily.Monospace, color = muted)
                        Text(value, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        item {
            Text("A session variable with the same name replaces the workspace's. They apply when the engine next starts.",
                Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    editing?.let { (startKey, startValue) ->
        var key by remember { mutableStateOf(startKey) }
        var value by remember { mutableStateOf(startValue) }
        val problem = S.keyProblem(key)
        AlertDialog(onDismissRequest = { editing = null }, title = { Text(if (replacing == null) "Add a variable" else "Edit variable") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(key, { key = it }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true,
                    isError = key.isNotEmpty() && problem != null, supportingText = problem?.takeIf { key.isNotEmpty() }?.let { { Text(it) } })
                OutlinedTextField(value, { value = it }, Modifier.fillMaxWidth(), label = { Text("Value") })
            }
        }, confirmButton = {
            TextButton(enabled = problem == null && enabled, onClick = { editing = null; setEnv(S.withVariable(state.env, key, value, replacing)) }) { Text("Save") }
        }, dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } })
    }
}
