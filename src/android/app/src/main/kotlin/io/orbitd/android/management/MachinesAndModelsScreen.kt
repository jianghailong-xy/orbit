package io.orbitd.android.management

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.FollowManagedRunner
import io.orbitd.android.composer.ManagedRunner
import io.orbitd.android.composer.rememberManagedRunner
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * The lists the Machines & models page is read from (iOS MachinesAndModelsLists): the machines with their workspaces (RunnersModel), the
 * account's own keys (GET providers/mine) with each DeepSeek key's balance, its own pools (GET providers/pools) — a Codex one with who
 * can use it read beside its accounts — and the pools it is in (GET providers/shared-pools). Each is its own read, best-effort: a failed
 * one keeps what was read before.
 */
@Stable
internal class MachinesAndModelsModel(val api: ManagementApi) {
    val machines = RunnersModel(api)
    var keys by mutableStateOf<List<JsonObject>>(emptyList()); private set
    /** Why the last read of the keys failed, while none has been read. */
    var keysError by mutableStateOf<String?>(null); private set
    var keysLoaded by mutableStateOf(false); private set
    /** Each DeepSeek key's account balance by provider id, as the server last answered — or why it didn't; absent while asked. */
    var balances by mutableStateOf<Map<String, DeepSeekBalance.Reading>>(emptyMap()); private set
    private var own by mutableStateOf<List<JsonObject>>(emptyList())
    private var shared by mutableStateOf<List<JsonObject>>(emptyList())
    private var access by mutableStateOf<Map<String, JsonObject>>(emptyMap())
    private var keysAnswered by mutableStateOf(false)
    private var poolsAnswered by mutableStateOf(false)
    private var sharedAnswered by mutableStateOf(false)

    /** Every list has had its answer, a failed one included: Needs you at the top waits for that, as iOS's does, so it doesn't change
     * under the reader as each list arrives. */
    val settled get() = (machines.loaded || machines.failed) && keysAnswered && poolsAnswered && sharedAnswered

    /** Both pool lists have had their answer: all a pool's Needs you line is read from, as Settings' Providers row counts them. */
    val poolsSettled get() = poolsAnswered && sharedAnswered

    suspend fun loadKeys() {
        val read = try { providerObjects(api.get("providers/mine")) } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (!keysLoaded) keysError = personalFailure(e); keysAnswered = true; return }
        keys = read; keysLoaded = true; keysError = null; keysAnswered = true
        readDeepSeekBalances(api, read) { id, reading -> balances = balances + (id to reading) }
    }

    /** The account's own pools, then who can use each Codex one of them: its people and keys, read pool by pool. */
    suspend fun loadPools() {
        own = try { providerObjects(api.get("providers/pools")) } catch (e: CancellationException) { throw e }
            catch (_: Exception) { poolsAnswered = true; return }
        poolsAnswered = true
        access = own.filter { it.str("engine") == "codex" }.mapNotNull { pool ->
            val id = pool.text("id")
            try { id to api.get("providers/shared-pools/$id").jsonObject } catch (e: CancellationException) { throw e }
            catch (_: Exception) { access[id]?.let { id to it } }
        }.toMap()
    }

    suspend fun loadShared() {
        try { shared = providerObjects(api.get("providers/shared-pools")) } catch (e: CancellationException) { throw e } catch (_: Exception) { }
        sharedAnswered = true
    }

    /** The pools the account is in, as GET providers/shared-pools lists them. */
    fun memberPools(nowMs: Long) = shared.map { ProviderPools.shared(it, nowMs) }

    /** Its own pools — not one the list of those it is in holds too — a Codex one with its people and keys once they are read. */
    fun ownPools(nowMs: Long) = own.filter { pool -> shared.none { ObjectId.same(it.text("id"), pool.text("id")) } }.map { json ->
        val pool = ProviderPools.own(json, nowMs)
        access[pool.id]?.let { ProviderPools.withAccess(pool, it, nowMs) } ?: pool
    }

    fun attention(runners: List<JsonObject>, workspaces: List<JsonObject>, nowMs: Long, managedRunnerId: String? = null) =
        MachinesAndModels.attention(runners, workspaces, memberPools(nowMs), ownPools(nowMs), nowMs, managedRunnerId)
}

/** Which of the Machines & models page's halves is shown (iOS RunnersListView.Part): Settings opens it twice, as the web's Settings nav
 * has Machines and Providers; everywhere else it is the whole page. */
internal enum class MachinesAndModelsPart { ALL, MACHINES, PROVIDERS }

/**
 * The Machines & models page (iOS RunnersListView, docs/mocks/infrastructure-page/03-ios.png), Settings › Machines & models: what needs a person,
 * the machines (each opening its record; reordered and removed here), Add Runner, then the account pools and the API keys. Every way out
 * stays in the app: an engine is signed in on its page, a machine on its record, a pool on its page, a DeepSeek key on its page.
 */
@Composable
internal fun MachinesAndModelsPage(api: ManagementApi, revision: Long, open: (OrbitRoute) -> Unit,
    part: MachinesAndModelsPart = MachinesAndModelsPart.ALL, record: String? = null) {
    val machinesHalf = part != MachinesAndModelsPart.PROVIDERS
    val providersHalf = part != MachinesAndModelsPart.MACHINES
    val model = remember(api) { MachinesAndModelsModel(api) }
    // Terminals asking to be approved head Needs you (docs/mocks/waiting-on-you-removal/02 ①); opened from the push
    // ([record] `terminal:<id>`), the page is at its top with that card lit.
    val terminalStore = remember(api) { TerminalRequestStore.of(api) }
    // Terminals are machines' business: the Providers half draws none.
    val terminals = if (machinesHalf) rememberLiveTerminalRequests(terminalStore) else emptyList()
    val litTerminal = TerminalNeedsYou.requestOf(record)
    val scroll = rememberScrollState()
    LaunchedEffect(litTerminal) { if (litTerminal != null) scroll.animateScrollTo(0) }
    val machines = model.machines
    val resumed = rememberResumed()
    val now = rememberNow()
    val scope = rememberCoroutineScope()
    var adding by rememberSaveable { mutableStateOf(false) }
    var removing by remember { mutableStateOf<JsonObject?>(null) }
    val notice = remember { Notice() }
    // The account's managed runner: nothing is read without the capability (no GET managed-runner), and no section or label without a
    // display for it (docs/managed-runner-existing-account-entry-design.md).
    val managed = rememberManagedRunner(api, ask = true)
    FollowManagedRunner(managed, follow = resumed && managed.shown != null)
    var confirmingSetup by remember { mutableStateOf(false) }
    val managedStatus = managed.shown?.status
    val managedRunnerId = managedStatus?.runnerId?.let { id -> machines.runners.firstOrNull { ObjectId.same(it.text("id"), id) }?.text("id") }
    val managedRow = ManagedRunner.row(managedRunnerId, managedStatus)
    // Set up: the server's answer names the runner, whose page opens; a refusal is the server's own sentence.
    fun setUp() = scope.launch {
        managed.ensure()
        managed.refusal?.let { notice.show(it); return@launch }
        machines.load()
        managed.shown?.status?.runnerId?.let { open(OrbitRoute(Destination.RUNNER, it)) }
    }
    // Each list is its own read, so they are asked for side by side. A machine checks in every 30s: the machines are read again every
    // 15 s while the page is up, so where each one stands — its row, and what needs you — moves with it, as a machine's own page does.
    LaunchedEffect(model, revision, resumed) {
        if (!resumed) return@LaunchedEffect
        launch { model.loadKeys() }
        launch { model.loadPools() }
        launch { model.loadShared() }
        launch { machines.loadReleaseVersion() }
        machines.load()
        while (true) { delay(15_000); machines.load() }
    }
    fun runner(id: String) = open(OrbitRoute(Destination.RUNNER, id))
    fun page(record: String) = open(OrbitRoute(Destination.SETTINGS, "machines-and-models", recordId = record))
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(horizontal = 16.dp, vertical = 8.dp)) {
            if (machinesHalf) when {
                !machines.loaded && machines.failed -> Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Machines couldn't be loaded", style = MaterialTheme.typography.titleMedium)
                    Text(machines.error ?: "Request failed — check your connection.", color = Ink.muted)
                    Button(onClick = { scope.launch { machines.load() } }) { Text("Retry") }
                }
                !machines.loaded -> Text("Loading…", Modifier.fillMaxWidth().padding(24.dp), color = Ink.muted)
                // A later read that failed: the rows stay as last read, under a notice that can be put away.
                machines.failed -> machines.error?.let { error ->
                    Row(Modifier.fillMaxWidth().background(Ink.amber.copy(alpha = .12f)).padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text("⚠ $error", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, maxLines = 2)
                        TextButton(onClick = { machines.error = null }) { Text("Dismiss") }
                    }
                }
            }
            if (model.settled || terminals.isNotEmpty()) {
                val attention = if (model.settled) model.attention(machines.runners, machines.workspaces, now, managedRow?.let { managedRunnerId })
                    .filter { part == MachinesAndModelsPart.ALL || it.isMachine == machinesHalf } else emptyList()
                if (attention.isNotEmpty() || terminals.isNotEmpty()) NeedsYouSection(attention, {
                    TerminalRequestCards(terminals, terminalStore, litTerminal, notice::show)
                }) { item ->
                    when (val kind = item.kind) {
                        is MachinesAndModels.Kind.Offline -> runner(kind.runnerId)
                        is MachinesAndModels.Kind.NoCliSignedIn -> runner(kind.runnerId)
                        is MachinesAndModels.Kind.Updating -> runner(kind.runnerId)
                        is MachinesAndModels.Kind.PoolUnavailable -> page(if (kind.own) "own:${kind.poolId}" else "shared:${kind.poolId}")
                    }
                }
            }
            if (machinesHalf) managed.shown?.takeIf { it.display.ensure && it.display.kind == "setup" }?.let { shown ->
                ManagedRunnerSection(shown.display, busy = managed.busy) {
                    // An account with a machine or a workspace is asked first (D3); a new one sets it up at once.
                    if (machines.runners.isNotEmpty() || machines.workspaces.isNotEmpty()) confirmingSetup = true else setUp()
                }
            }
            if (machinesHalf) {
                if (machines.loaded && machines.runners.isNotEmpty()) {
                    FormSection(MachinesAndModels.MACHINES, MachinesAndModels.machinesCount(machines.runners), MachinesAndModels.MACHINES_DETAIL) {
                        MachineRows(machines, now, ::runner, managedStatus) { removing = it }
                    }
                }
                FormSection(footer = RunnerCopy.ADD_FOOTER) { TextButton(onClick = { adding = true }) { Text(RunnerCopy.ADD) } }
            }
            if (providersHalf) {
                PoolsSection(model.memberPools(now), model.ownPools(now), now, ::page)
                KeysSection(model, ::page)
                ModelTiersSection(api, revision)
            }
            Spacer(Modifier.height(48.dp))
        }
        notice.Host(Modifier.align(Alignment.BottomCenter))
    }
    removing?.let { runner ->
        AlertDialog(onDismissRequest = { removing = null }, title = { Text("Remove “${RunnerPage.displayName(runner)}”?") },
            text = { Text(RunnerCopy.REMOVE_FOOTER) }, confirmButton = {
                TextButton(onClick = { removing = null; scope.launch {
                    machines.press { api.delete("runners/${runner.text("id")}") }?.let { machines.error = it; notice.show(it) }
                } }) { Text(RunnerCopy.REMOVE, color = Ink.red) }
            }, dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } })
    }
    if (confirmingSetup) ManagedRunnerSetupConfirm(onDismiss = { confirmingSetup = false }) { confirmingSetup = false; setUp() }
    if (adding) AddRunnerDialog(api, onDismiss = { adding = false }) { id ->
        adding = false
        val ws = machines.workspacesOf(id).firstOrNull()?.text("id")
        open(OrbitRoute(Destination.DRAFT, workspaceId = ws, id = if (ws == null) id else null))
    }
}

/** Machines & models' Managed runner section (board 3): the managed runner the server offers this account, and its Set up. */
@Composable
internal fun ManagedRunnerSection(display: ManagedRunner.Display, busy: Boolean, setUp: () -> Unit) {
    FormSection(ManagedRunner.Entry.TITLE) {
        Row(Modifier.fillMaxWidth().clickable(enabled = !busy, role = Role.Button, onClick = setUp).padding(vertical = 8.dp)
            .testTag("managed-runner-entry"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("+", Modifier.clearAndSetSemantics { }, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(display.title)
                Text(ManagedRunner.Entry.SUBTITLE, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            }
            TextButton(enabled = !busy, onClick = setUp) { Text(ManagedRunner.Entry.ACTION) }
        }
    }
}

/** The question asked before Set up on an account that already has a machine or a workspace (D3). */
@Composable
internal fun ManagedRunnerSetupConfirm(onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.testTag("managed-runner-confirm"),
        title = { Text(ManagedRunner.Confirm.TITLE) }, text = { Text(ManagedRunner.Confirm.BODY) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(ManagedRunner.Confirm.CONFIRM) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(ManagedRunner.Confirm.CANCEL) } })
}

/** A line for each thing that waits on a person, in the web's words, each with its way out: a machine's record, a pool's page; the
 * terminals asking to be approved above them, as their cards. */
@Composable
private fun NeedsYouSection(items: List<MachinesAndModels.Attention>, terminals: @Composable () -> Unit,
    open: (MachinesAndModels.Attention) -> Unit) {
    FormSection(MachinesAndModels.NEEDS_YOU) {
        // Terminals first: a request lives ten minutes. Each is the whole card, its own way out.
        terminals()
        items.forEachIndexed { index, item ->
            if (index > 0) HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("needs-you:${item.id}"), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                // Grey for a machine that is away, amber for the rest — the web's two dots.
                Dot(if (item.kind is MachinesAndModels.Kind.Offline) IDLE_DOT else Ink.amber)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(bold(item.line, item.names))
                    Text(item.detail, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                }
                when (item.kind) {
                    is MachinesAndModels.Kind.Offline, is MachinesAndModels.Kind.NoCliSignedIn, is MachinesAndModels.Kind.Updating ->
                        OutlinedButton(onClick = { open(item) }) { Text(MachinesAndModels.DETAILS) }
                    is MachinesAndModels.Kind.PoolUnavailable -> OutlinedButton(onClick = { open(item) }) { Text(MachinesAndModels.MANAGE) }
                }
            }
        }
    }
}

/** [text] with each of [names] set in bold, the way the web's lines set them: each found after the one before it. */
private fun bold(text: String, names: List<String>): AnnotatedString = buildAnnotatedString {
    append(text)
    var from = 0
    names.filter { it.isNotEmpty() }.forEach { name ->
        val at = text.indexOf(name, from).takeIf { it >= 0 } ?: return@forEach
        addStyle(SpanStyle(fontWeight = FontWeight.Bold), at, at + name.length)
        from = at + name.length
    }
}

/** The pools the account is in, then its own: a row each, saying where it stands, opening the pool's page. */
@Composable
private fun PoolsSection(memberPools: List<Pool>, ownPools: List<Pool>, now: Long, page: (String) -> Unit) {
    if (memberPools.isEmpty() && ownPools.isEmpty()) return
    FormSection(MachinesAndModels.ACCOUNT_POOLS, footer = MachinesAndModels.ACCOUNT_POOLS_DETAIL) {
        val rows = memberPools.map { "shared:${it.id}" to it } + ownPools.map { "own:${it.id}" to it }
        rows.forEachIndexed { index, (record, pool) ->
            if (index > 0) HorizontalDivider()
            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { page(record) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (ProviderPools.runsCodex(pool)) {
                    val value = ProviderPools.codexPoolValue(pool, now)
                    Column(Modifier.weight(1f)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(pool.label, Modifier.align(Alignment.CenterVertically), maxLines = 1)
                            if (ProviderPools.isShared(pool)) Chip("SHARED", Modifier.align(Alignment.CenterVertically), brand = true)
                        }
                        Text(ProviderPools.codexPoolLine(pool, now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                    }
                    value?.let { Text(it.label, color = poolTone(it.tone), style = MaterialTheme.typography.bodySmall) }
                } else {
                    Text(pool.label, Modifier.weight(1f), maxLines = 1)
                    Text(ProviderPools.poolSummary(pool, now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                }
                Text("›", Modifier.clearAndSetSemantics { }, color = Ink.muted)
            }
        }
    }
}

/** The account's own keys, each vendor's together, each with the model a session on it starts on and the engines it runs on — and
 * Disabled for one that is switched off. A DeepSeek key's row ends with its account's balance, and opens the key's page; so does a
 * Cursor key's, which says Rejected there once Cursor refused it (iOS 4 ①②) and starts a session on Auto. Keys are added and changed
 * on the web. */
@Composable
private fun KeysSection(model: MachinesAndModelsModel, page: (String) -> Unit) {
    FormSection(MachinesAndModels.API_KEYS, footer = MachinesAndModels.API_KEYS_DETAIL + " " + DeepSeekBalance.EDIT_ON_WEB) {
        when {
            // A read that failed is not a list with nothing in it.
            !model.keysLoaded -> model.keysError?.let { error ->
                Text(error, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.labelMedium, color = Ink.red)
            } ?: Text("Loading…", Modifier.padding(vertical = 8.dp), color = Ink.muted)
            model.keys.isEmpty() -> Text(MachinesAndModels.NO_KEYS, Modifier.padding(vertical = 8.dp), color = Ink.muted)
        }
        KeyEngines.byVendor(model.keys).forEachIndexed { index, key ->
            if (index > 0) HorizontalDivider()
            val deepSeek = DeepSeekBalance.key(key, model.keys)?.str("id")
            val cursor = key.str("id")?.takeIf { it.isNotEmpty() && CursorCopy.isKey(key) }
            val record = deepSeek?.let { "key:$it" } ?: cursor?.let { "cursor-key:$it" }
            Row(Modifier.fillMaxWidth().then(if (record != null) Modifier.clickable(role = Role.Button) { page(record) } else Modifier)
                .padding(vertical = 8.dp).testTag("api-key:${key.text("slug")}"), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(key.str("label") ?: key.text("slug"), maxLines = 1)
                    // A Cursor key has no model list of its own: its sessions start on Cursor CLI's default, Auto unless a runner names another.
                    (if (cursor != null) MachinesAndModels.cursorModel(model.machines.runners.filter { it.bool("online") == true })
                        else MachinesAndModels.defaultModel(key))?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                    }
                    // Every engine it runs on: one key, under each engine that can spend it.
                    KeyEngines.line(key)?.let { Text(it, Modifier.testTag("key-engines"), style = MaterialTheme.typography.bodySmall, color = Ink.muted) }
                    // A key an account refused runs on: the provider's words, the next trial, Check again (§8).
                    key.str("id")?.takeIf { it.isNotEmpty() }?.let { AccountHealthProviderLine(model.api, it) }
                }
                if (key.bool("enabled") == false) Text(MachinesAndModels.DISABLED, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                else if (deepSeek != null) DeepSeekBalance.rowValue(DeepSeekBalance.state(model.balances[deepSeek]))?.let {
                    Text(it.label, color = poolTone(it.tone), style = MaterialTheme.typography.bodySmall)
                }
                else if (cursor != null) CursorCopy.rowValue(key)?.let { Text(it.label, color = poolTone(it.tone), style = MaterialTheme.typography.bodySmall) }
                if (record != null) Text("›", Modifier.clearAndSetSemantics { }, color = Ink.muted)
            }
        }
    }
}
