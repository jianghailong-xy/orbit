package io.orbitd.android.management

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.CursorRuntime
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * The lists the Infrastructure page is read from (iOS InfrastructureLists): the machines with their workspaces (RunnersModel), the
 * account's own keys (GET providers/mine) with each DeepSeek key's balance, its own pools (GET providers/pools) — a Codex one with who
 * can use it read beside its accounts — and the pools it is in (GET providers/shared-pools). Each is its own read, best-effort: a failed
 * one keeps what was read before.
 */
@Stable
internal class InfrastructureModel(private val api: ManagementApi) {
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

    /** Every list has had its answer, a failed one included: the two blocks at the top wait for that, as iOS's and the web's do — an
     * engine called Not set up before its keys arrived would be wrong. */
    val settled get() = (machines.loaded || machines.failed) && keysAnswered && poolsAnswered && sharedAnswered

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

    fun attention(runners: List<JsonObject>, nowMs: Long) = Infrastructure.attention(runners, memberPools(nowMs), ownPools(nowMs), nowMs)

    /** Every engine a session can run on, and what can pay for it now — a key under every engine it runs on. */
    fun engines(nowMs: Long) = Infrastructure.engineCards(machines.runners, keys, memberPools(nowMs) + ownPools(nowMs))
}

/**
 * The Infrastructure page (iOS RunnersListView, docs/mocks/infrastructure-page/03-ios.png), Settings › Infrastructure: what needs a person,
 * what each engine can run on, the machines (each opening its record; reordered and removed here), Add Runner, then the account pools and
 * the API keys. Every way out stays in the app: an engine is signed in or installed on its page, a machine on its record, a pool on its
 * page, a DeepSeek key on its page.
 */
@Composable
internal fun InfrastructurePage(api: ManagementApi, revision: Long, open: (OrbitRoute) -> Unit) {
    val model = remember(api) { InfrastructureModel(api) }
    val machines = model.machines
    val resumed = rememberResumed()
    val now = rememberNow()
    val scope = rememberCoroutineScope()
    var adding by rememberSaveable { mutableStateOf(false) }
    var removing by remember { mutableStateOf<JsonObject?>(null) }
    val notice = remember { Notice() }
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
    fun engine(runnerId: String, engine: String) = open(OrbitRoute(Destination.RUNNER, runnerId, recordId = "engine:$engine"))
    fun page(record: String) = open(OrbitRoute(Destination.SETTINGS, "infrastructure", recordId = record))
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
            when {
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
            if (model.settled) {
                val attention = model.attention(machines.runners, now)
                if (attention.isNotEmpty()) NeedsYouSection(attention) { item ->
                    when (val kind = item.kind) {
                        is Infrastructure.Kind.SignedOut -> engine(kind.runnerId, kind.engine)
                        is Infrastructure.Kind.Offline -> runner(kind.runnerId)
                        is Infrastructure.Kind.PoolUnavailable -> page(if (kind.own) "own:${kind.poolId}" else "shared:${kind.poolId}")
                    }
                }
                // Install on a machine: that engine's page on the first machine online, where Install is — or, with none online,
                // registering one.
                EnginesSection(model.engines(now)) { slug ->
                    Infrastructure.installTarget(machines.runners)?.let { engine(it.text("id"), slug) } ?: run { adding = true }
                }
            }
            if (machines.loaded && machines.runners.isNotEmpty()) {
                FormSection(Infrastructure.MACHINES, Infrastructure.machinesCount(machines.runners), Infrastructure.MACHINES_DETAIL) {
                    MachineRows(machines, now, ::runner) { removing = it }
                }
            }
            FormSection(footer = RunnerCopy.ADD_FOOTER) { TextButton(onClick = { adding = true }) { Text(RunnerCopy.ADD) } }
            PoolsSection(model.memberPools(now), model.ownPools(now), now, ::page)
            KeysSection(model, ::page)
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
    if (adding) AddRunnerDialog(api, onDismiss = { adding = false }) { id -> adding = false; runner(id) }
}

/** A line for each thing that waits on a person, in the web's words, each with its way out: an engine signed in again on its page, a
 * machine's record, a pool's page. */
@Composable
private fun NeedsYouSection(items: List<Infrastructure.Attention>, open: (Infrastructure.Attention) -> Unit) {
    FormSection(Infrastructure.NEEDS_YOU) {
        items.forEachIndexed { index, item ->
            if (index > 0) HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("needs-you:${item.id}"), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                // Grey for a machine that is away, amber for the rest — the web's two dots.
                StatusDot(if (item.kind is Infrastructure.Kind.Offline) "offline" else "draining")
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(bold(item.line, item.names))
                    Text(item.detail, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                }
                when (item.kind) {
                    is Infrastructure.Kind.SignedOut -> Button(onClick = { open(item) }) { Text(Infrastructure.SIGN_IN) }
                    is Infrastructure.Kind.Offline -> OutlinedButton(onClick = { open(item) }) { Text(Infrastructure.DETAILS) }
                    is Infrastructure.Kind.PoolUnavailable -> OutlinedButton(onClick = { open(item) }) { Text(Infrastructure.MANAGE) }
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

/** A row per engine — all six, in the pickers' order, each by its CLI's name — Ready with what can pay for it now: its machines (a
 * subscription; OpenCode's own sign-in), every key that runs on it with the model a session there starts on, its pools. Or Not set up,
 * with the way to install it on a machine. */
@Composable
private fun EnginesSection(engines: List<Infrastructure.EngineCard>, install: (String) -> Unit) {
    FormSection(Infrastructure.ENGINES_TITLE, footer = Infrastructure.ENGINES_DETAIL) {
        engines.forEachIndexed { index, card ->
            if (index > 0) HorizontalDivider()
            Column(Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("engine-sources:${card.engine}"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(card.name, style = MaterialTheme.typography.titleMedium)
                    StateChip(card.ready)
                }
                if (card.ready) {
                    if (card.machines.isNotEmpty()) SourceLine(card.machinesLabel, AnnotatedString(card.machines.joinToString(", ")))
                    if (card.keys.isNotEmpty()) SourceLine(Infrastructure.API_KEY, keys(card.keys))
                    if (card.pools.isNotEmpty()) SourceLine(Infrastructure.POOL, AnnotatedString(card.pools.joinToString(", ")))
                } else {
                    Text(Infrastructure.NOTHING_CAN_PAY, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                    TextButton(onClick = { install(card.engine) }, contentPadding = PaddingValues(vertical = 4.dp)) {
                        Text(Infrastructure.INSTALL_ON_A_MACHINE, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

/** "DeepSeek DeepSeek V4 Pro, DeepSeek 2 DeepSeek V4 Pro": each key, and its model set apart. */
@Composable
private fun keys(keys: List<Infrastructure.EngineCard.Key>): AnnotatedString {
    val faint = Ink.muted.copy(alpha = .75f)
    return buildAnnotatedString {
        keys.forEachIndexed { index, key ->
            if (index > 0) append(", ")
            append(key.label)
            key.model?.let { withStyle(SpanStyle(color = faint)) { append(" $it") } }
        }
    }
}

/** "Subscription · Mac Studio ×2, HPC", its source's name in bold. */
@Composable
private fun SourceLine(source: String, names: AnnotatedString) {
    Text(buildAnnotatedString {
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(source) }
        append(RunnerCopy.SEP)
        append(names)
    }, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
}

/** Ready in green, Not set up in grey — the web card's tag. */
@Composable
private fun StateChip(ready: Boolean) {
    val ink = if (ready) Ink.green else Ink.muted
    Text(if (ready) Infrastructure.READY else Infrastructure.NOT_SET_UP, Modifier.clip(RoundedCornerShape(5.dp))
        .background(ink.copy(alpha = if (ready) .12f else .1f)).padding(horizontal = 6.dp, vertical = 1.dp),
        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold), color = ink, maxLines = 1, softWrap = false)
}

/** The pools the account is in, then its own: a row each, saying where it stands, opening the pool's page. */
@Composable
private fun PoolsSection(memberPools: List<Pool>, ownPools: List<Pool>, now: Long, page: (String) -> Unit) {
    if (memberPools.isEmpty() && ownPools.isEmpty()) return
    FormSection(Infrastructure.ACCOUNT_POOLS, footer = Infrastructure.ACCOUNT_POOLS_DETAIL) {
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
private fun KeysSection(model: InfrastructureModel, page: (String) -> Unit) {
    FormSection(Infrastructure.API_KEYS, footer = Infrastructure.API_KEYS_DETAIL + " " + DeepSeekBalance.EDIT_ON_WEB) {
        when {
            // A read that failed is not a list with nothing in it.
            !model.keysLoaded -> model.keysError?.let { error ->
                Text(error, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.labelMedium, color = Ink.red)
            } ?: Text("Loading…", Modifier.padding(vertical = 8.dp), color = Ink.muted)
            model.keys.isEmpty() -> Text(Infrastructure.NO_KEYS, Modifier.padding(vertical = 8.dp), color = Ink.muted)
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
                    // A Cursor key has no model list of its own: its sessions start on Cursor CLI's Auto.
                    (if (cursor != null) CursorRuntime.AUTO else Infrastructure.defaultModel(key))?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                    }
                    // Every engine it runs on: one key, under each engine that can spend it.
                    KeyEngines.line(key)?.let { Text(it, Modifier.testTag("key-engines"), style = MaterialTheme.typography.bodySmall, color = Ink.muted) }
                }
                if (key.bool("enabled") == false) Text(Infrastructure.DISABLED, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                else if (deepSeek != null) DeepSeekBalance.rowValue(DeepSeekBalance.state(model.balances[deepSeek]))?.let {
                    Text(it.label, color = poolTone(it.tone), style = MaterialTheme.typography.bodySmall)
                }
                else if (cursor != null) CursorCopy.rowValue(key)?.let { Text(it.label, color = poolTone(it.tone), style = MaterialTheme.typography.bodySmall) }
                if (record != null) Text("›", Modifier.clearAndSetSemantics { }, color = Ink.muted)
            }
        }
    }
}
