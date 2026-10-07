package io.orbitd.android.management

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** The account's providers as iOS's Providers page reads them: runners, own and shared pools, API keys. */
@Stable
private class ProvidersModel(private val api: ManagementApi) {
    var runners by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var keys by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var own by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var shared by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var access by mutableStateOf<Map<String, JsonObject>>(emptyMap()); private set
    var loaded by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    suspend fun load() {
        try {
            runners = providerObjects(api.get("runners"))
            keys = providerObjects(api.get("providers"))
            own = providerObjects(api.get("providers/pools"))
            shared = providerObjects(api.get("providers/shared-pools"))
            loaded = true; error = null
        } catch (e: CancellationException) { throw e } catch (e: Exception) { error = personalFailure(e); return }
        // A Codex pool of one's own is drawn with its people and keys, read pool by pool.
        access = own.filter { it.str("engine") == "codex" }.mapNotNull { pool ->
            try { pool.text("id") to api.get("providers/shared-pools/${pool.text("id")}").jsonObject }
            catch (e: CancellationException) { throw e } catch (_: Exception) { null }
        }.toMap()
    }
}

@Composable
private fun rememberReload(resumed: Boolean, revision: Long, load: suspend () -> Unit) {
    LaunchedEffect(resumed, revision) { if (resumed) load() }
}

/** ProvidersSettingsPage, or one pool's page when the route names it (own:<id> / shared:<id>). */
@Composable
fun ProviderManagement(api: ManagementApi, revision: Long, record: String?, open: (OrbitRoute) -> Unit, back: () -> Unit) {
    when {
        record?.startsWith("own:") == true -> PoolScreen(api, revision, ownId = record.removePrefix("own:"), sharedId = null, back = back)
        record?.startsWith("shared:") == true -> PoolScreen(api, revision, ownId = null, sharedId = record.removePrefix("shared:"), back = back)
        else -> ProvidersOverview(api, revision, open)
    }
}

@Composable
private fun ProvidersOverview(api: ManagementApi, revision: Long, open: (OrbitRoute) -> Unit) {
    val model = remember(api) { ProvidersModel(api) }
    val now = rememberNow()
    val scope = rememberCoroutineScope()
    rememberReload(rememberResumed(), revision) { model.load() }
    fun pool(record: String) = open(OrbitRoute(Destination.SETTINGS, "providers", recordId = record))
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        model.error?.let { error ->
            Text(error, color = Ink.red, style = MaterialTheme.typography.labelMedium)
            TextButton(onClick = { scope.launch { model.load() } }) { Text("Retry") }
        }
        if (!model.loaded) { if (model.error == null) Text("Loading…", Modifier.padding(16.dp), color = Ink.muted); return@Column }
        FormSection("On your runners", footer = "Signed in on the machine itself — a session spends that subscription, nothing to paste.") {
            model.runners.forEachIndexed { index, runner ->
                if (index > 0) HorizontalDivider()
                Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { open(OrbitRoute(Destination.RUNNER, runner.text("id"))) }.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(RunnerPage.displayName(runner))
                        Text(ProviderPools.runnerSummary(runner), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                    }
                    Text("›", color = Ink.muted)
                }
            }
        }
        if (model.own.isNotEmpty() || model.shared.isNotEmpty()) FormSection("Account pools",
            footer = "Several keys under one name — each session starts on one with room, and moves on when it runs out.") {
            val rows = model.shared.map { "shared:${it.text("id")}" to ProviderPools.shared(it, now) } +
                model.own.filter { own -> model.shared.none { ObjectId.same(it.text("id"), own.text("id")) } }.map { json ->
                    val pool = ProviderPools.own(json, now)
                    "own:${pool.id}" to (model.access[pool.id]?.let { ProviderPools.withAccess(pool, it, now) } ?: pool)
                }
            rows.forEachIndexed { index, (record, pool) ->
                if (index > 0) HorizontalDivider()
                Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { pool(record) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (ProviderPools.runsCodex(pool)) {
                        val value = ProviderPools.codexPoolValue(pool, now)
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(pool.label, maxLines = 1); if (ProviderPools.isShared(pool)) Chip("SHARED", brand = true)
                            }
                            Text(ProviderPools.codexPoolLine(pool, now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                        }
                        value?.let { Text(it.label, color = poolTone(it.tone), style = MaterialTheme.typography.bodySmall) }
                    } else {
                        Text(pool.label, Modifier.weight(1f), maxLines = 1)
                        Text(ProviderPools.poolSummary(pool, now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                    }
                    Text("›", color = Ink.muted)
                }
            }
        }
        FormSection("Your API keys", footer = "On your account and usable from every runner — billed per token. Adding or changing a key happens on the web.") {
            if (model.keys.isEmpty()) Text("No keys yet", Modifier.padding(vertical = 8.dp), color = Ink.muted)
            model.keys.forEachIndexed { index, key ->
                if (index > 0) HorizontalDivider()
                Column(Modifier.padding(vertical = 8.dp)) {
                    Text(key.str("label") ?: key.text("slug"))
                    key.str("defaultModel")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.muted) }
                }
            }
        }
        Spacer(Modifier.height(48.dp))
    }
}

@Composable
internal fun poolTone(tone: String) = when (tone) {
    "success" -> Ink.green; "brand" -> MaterialTheme.colorScheme.primary; "warning" -> Ink.amber; "danger" -> Ink.red; else -> Ink.muted
}

@Composable
private fun Chip(text: String, brand: Boolean = false) {
    Text(text, Modifier.clip(RoundedCornerShape(5.dp)).background(if (brand) MaterialTheme.colorScheme.primary.copy(alpha = .12f) else Ink.muted.copy(alpha = .1f))
        .padding(horizontal = 5.dp, vertical = 1.dp), style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold),
        color = if (brand) MaterialTheme.colorScheme.primary else Ink.muted)
}

@Composable
private fun Avatar(name: String, color: Long) {
    Box(Modifier.size(32.dp).clip(CircleShape).background(Color(color)), Alignment.Center) {
        Text(PoolPage.initial(name), color = Color.White, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold))
    }
}

@Composable
private fun FactLine(fact: Fact) {
    Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)) { append(fact.lead) }; append(fact.rest) },
        style = MaterialTheme.typography.bodySmall, color = Ink.muted)
}

/** One pool's page: an own Claude account pool, an own Codex pool, or a Codex pool shared with this account. */
@Composable
private fun PoolScreen(api: ManagementApi, revision: Long, ownId: String?, sharedId: String?, back: () -> Unit) {
    val now = rememberNow(30_000)
    val scope = rememberCoroutineScope()
    val notice = remember { Notice() }
    var own by remember { mutableStateOf<JsonObject?>(null) }
    var access by remember { mutableStateOf<JsonObject?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var gone by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val accessId = ownId ?: sharedId!!
    suspend fun load() {
        try {
            if (ownId != null) {
                own = providerObjects(api.get("providers/pools")).firstOrNull { ObjectId.same(it.text("id"), ownId) }
                gone = own == null
                access = if (own?.str("engine") == "codex") try { api.get("providers/shared-pools/$ownId").jsonObject }
                    catch (e: CancellationException) { throw e } catch (_: Exception) { null } else null
            } else access = api.get("providers/shared-pools/$sharedId").jsonObject
            loaded = true; error = null
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            if (e is io.orbitd.android.core.net.ApiError && e.status == 404) { gone = true; loaded = true } else error = personalFailure(e)
        }
    }
    rememberReload(rememberResumed(), revision) { load() }
    val ownPool = own?.let { ProviderPools.own(it, now) }
    // Re-read the server's next selection as each pause expires while the page is open.
    val pauses = (ownPool?.members.orEmpty() + (access?.let { ProviderPools.shared(it, now).members }.orEmpty())).mapNotNull { isoMs(it.pausedUntil) }.filter { it > now }
    LaunchedEffect(pauses.minOrNull()) { pauses.minOrNull()?.let { delay(maxOf(0, it - System.currentTimeMillis())); load() } }
    suspend fun press(done: String? = null, action: suspend () -> Unit) {
        try { action(); load(); done?.let(notice::show) } catch (e: CancellationException) { throw e } catch (e: Exception) { notice.show(personalFailure(e)) }
    }
    Box(Modifier.fillMaxSize()) {
        when {
            gone -> Text("That pool no longer exists.", Modifier.padding(24.dp), color = Ink.muted)
            !loaded -> Text(error ?: "Loading…", Modifier.padding(24.dp), color = if (error != null) Ink.red else Ink.muted)
            ownPool != null && !CodexLogins.isLoginPool(ownPool) && ownPool.engine != "codex" -> AccountPoolPage(ownPool, now) { member, minutes ->
                pauseMember(api, ownPool.id, member.id, minutes) { load() }
            }
            else -> {
                val view = CodexPoolView(ownPool, access, now)
                CodexPoolPage(api, view, now, notice, reload = { load() }, press = { done, action -> scope.launch { press(done, action) } },
                    pause = { member, minutes -> pauseMember(api, view.pool.id, member.id, minutes) { load() } },
                    exit = {
                        try {
                            when { ownId != null -> api.delete("providers/pools/$ownId"); view.mine -> api.delete("providers/shared-pools/$accessId")
                                else -> api.post("providers/shared-pools/$accessId/leave") }
                            back(); null
                        } catch (e: CancellationException) { throw e } catch (e: Exception) { personalFailure(e) }
                    })
            }
        }
        notice.Host(Modifier.align(Alignment.BottomCenter))
    }
}

private suspend fun pauseMember(api: ManagementApi, poolId: String, memberId: String, minutes: Int?, reload: suspend () -> Unit): String? = try {
    api.post("providers/pools/$poolId/members/$memberId/pause", buildJsonObject { put("durationMinutes", minutes?.let(::JsonPrimitive) ?: JsonNull) })
    reload(); null
} catch (e: CancellationException) { throw e } catch (e: Exception) { personalFailure(e) }

/** AccountPoolPageView: a Claude account pool — its accounts, which is next, their quota, pause. */
@Composable
private fun AccountPoolPage(pool: Pool, now: Long, pause: suspend (PoolMember, Int?) -> String?) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        Column(Modifier.padding(vertical = 8.dp)) {
            Text(pool.label, style = MaterialTheme.typography.titleLarge)
            Text("Account pool", style = MaterialTheme.typography.titleMedium)
            Text(ProviderPools.availability(pool, now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        }
        PoolHeader("Accounts", null, ProviderPools.headline(pool, now), ProviderPools.headGauge(pool))
        FormSection(footer = ProviderPools.accountsFooter + " Adding or changing a key happens on the web.") {
            pool.members.forEachIndexed { index, member ->
                if (index > 0) HorizontalDivider()
                val status = ProviderPools.memberStatus(member, now)
                val quota = ProviderPools.memberQuota(member)
                Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.Top) {
                        Column(Modifier.weight(1f)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(member.label, style = MaterialTheme.typography.titleMedium, maxLines = 1); if (member.next) Chip("NEXT")
                            }
                            Text(status.label, style = MaterialTheme.typography.bodySmall, color = poolTone(status.tone))
                        }
                        quota?.let { row ->
                            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text("${row.percent}%", style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                                Gauge(row.percent / 100f, if (row.percent >= 90) Ink.amber else MaterialTheme.colorScheme.primary, Modifier.width(96.dp))
                                Text(row.label, style = MaterialTheme.typography.labelSmall, color = Ink.muted)
                            }
                        }
                    }
                    AccountPauseControls(member.label, member.pausedUntil, "Pool account · This pool") { minutes -> pause(member, minutes) }
                }
            }
        }
        Spacer(Modifier.height(48.dp))
    }
}

@Composable
private fun PoolHeader(title: String, count: Int?, trailing: String?, reading: PoolStatus?) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp), verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = Ink.muted)
        count?.let { Text("$it", style = MaterialTheme.typography.labelMedium, color = Ink.muted.copy(alpha = .6f)) }
        Spacer(Modifier.weight(1f))
        trailing?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.muted, maxLines = 2) }
        reading?.let { Text(it.label, style = MaterialTheme.typography.labelMedium.copy(fontWeight = if (it.tone == "warning") FontWeight.SemiBold else FontWeight.Normal),
            color = poolTone(it.tone), maxLines = 1) }
    }
}

private sealed interface PoolSheet {
    data object Choose : PoolSheet
    data class SignIn(val again: JsonObject?) : PoolSheet
    data object AddKey : PoolSheet
    data class Replace(val key: JsonObject) : PoolSheet
    data object Share : PoolSheet
}

/** CodexPoolPageView: accounts and keys, who can use it, the rules, and leaving or deleting it. */
@Composable
private fun CodexPoolPage(api: ManagementApi, page: CodexPoolView, now: Long, notice: Notice, reload: suspend () -> Unit,
                          press: (String?, suspend () -> Unit) -> Unit, pause: suspend (PoolMember, Int?) -> String?, exit: suspend () -> String?) {
    val pool = page.pool
    val access = page.access
    val card = access?.let { WhoCanUseIt(it, page.accounts) }
    val scope = rememberCoroutineScope()
    var sheet by remember { mutableStateOf<PoolSheet?>(null) }
    var signingOut by remember { mutableStateOf<JsonObject?>(null) }
    var removingKey by remember { mutableStateOf<JsonObject?>(null) }
    var removingPerson by remember { mutableStateOf<JsonObject?>(null) }
    var confirmingJustMine by remember { mutableStateOf(false) }
    var confirmingExit by remember { mutableStateOf(false) }
    val accessPath = "providers/shared-pools/${access?.text("id") ?: pool.id}"
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(pool.label, style = MaterialTheme.typography.titleLarge)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Codex pool", style = MaterialTheme.typography.titleMedium); if (page.people) Chip("SHARED", brand = true)
            }
            Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(page.who) }; append(page.subtitleRest(now)) },
                style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            page.adding?.let { adding ->
                Button(onClick = { sheet = when (adding) { "choose" -> PoolSheet.Choose; "signIn" -> PoolSheet.SignIn(null); else -> PoolSheet.AddKey } },
                    Modifier.fillMaxWidth()) { Text(page.addLabel) }
            }
        }
        PoolHeader("Accounts", page.accountsCount, ProviderPools.headline(pool, now), ProviderPools.headGauge(pool))
        FormSection(footer = page.howSentence + " Paused accounts are skipped for everyone in this pool.") {
            page.emptyNote?.let { Text(it, Modifier.padding(vertical = 8.dp), color = Ink.muted) }
            pool.members.forEachIndexed { index, member ->
                if (index > 0) HorizontalDivider()
                val login = member.login
                val key = member.key
                if (login != null) {
                    val canSignInAgain = access?.let { PoolPage.canSignInAgain(login, it) } ?: page.mine
                    val canSignOut = access?.let { PoolPage.canSignOut(login, it) } ?: page.mine
                    val contributor = access?.let { a -> login.str("userId")?.let { id -> PoolPage.people(a).firstOrNull { ObjectId.same(it.str("userId"), id) }?.text("name") } }
                    CodexAccountRow(member, login, CodexLogins.showsNext(member, pool), page.tagged, canSignInAgain, canSignOut, contributor, now,
                        signInAgain = { sheet = PoolSheet.SignIn(login) }, signOut = { signingOut = login })
                    AccountPauseControls(member.label, member.pausedUntil, if (page.people) "Pool account · Paused for everyone in this pool" else "Pool account · This pool",
                        canManage = canSignOut) { minutes -> pause(member, minutes) }
                } else if (key != null && access != null) {
                    PoolKeyRow(key, access, member.next, page.tagged, replace = { sheet = PoolSheet.Replace(key) }, remove = { removingKey = key },
                        switch = { press(null) { api.patch("$accessPath/keys/${key.text("id")}", buildJsonObject { put("enabled", key.bool("enabled") != true) }) } })
                    AccountPauseControls(member.label, member.pausedUntil, if (page.people) "Pool account · Paused for everyone in this pool" else "Pool account · This pool",
                        canManage = PoolPage.canRemove(key, access)) { minutes -> pause(member, minutes) }
                }
            }
        }
        if (card != null) {
            PoolHeader(WhoCanUseIt.header, card.count, card.note, null)
            FormSection {
                if (card.showsMode) Column(Modifier.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        listOf(false to CodexPoolView.justMe, true to WhoCanUseIt.withPeopleLabel).forEachIndexed { index, (people, label) ->
                            SegmentedButton(selected = card.people == people, shape = SegmentedButtonDefaults.itemShape(index, 2), onClick = {
                                if (people != card.people) { if (people) sheet = PoolSheet.Share else confirmingJustMine = true }
                            }) { Text(label) }
                        }
                    }
                    Text(card.modeHint, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                }
                card.rows.forEachIndexed { index, person ->
                    if (index > 0 || card.showsMode) HorizontalDivider()
                    PersonRow(person, access, card.line(person), if (card.ran) PoolPage.share(person, access) else null,
                        manages = card.manages(person), offersRoles = card.offersRoles, remove = { removingPerson = person },
                        setRole = { role -> press(null) { api.patch("$accessPath/people/${person.text("userId")}", buildJsonObject { put("role", role) }) } })
                }
                if (card.addsPeople) TextButton(onClick = { sheet = PoolSheet.Share }) { Text(WhoCanUseIt.addPeople) }
            }
            if (card.showsRule) {
                FormSection(footer = WhoCanUseIt.ruleHint + "\n\n" + WhoCanUseIt.ruleAccountsHint +
                    if (card.showsFoot) "\n\n" + WhoCanUseIt.footLead + WhoCanUseIt.footRest else "") {
                    listOf("membersCanAdd" to WhoCanUseIt.ruleTitle, "membersCanAddAccounts" to WhoCanUseIt.ruleAccountsTitle).forEach { (field, title) ->
                        val on = access.bool(field) == true
                        Row(Modifier.fillMaxWidth().toggleable(on, role = Role.Switch) { value -> press(null) { api.patch(accessPath, buildJsonObject { put(field, value) }) } }
                            .padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(title, Modifier.weight(1f)); Switch(checked = on, onCheckedChange = null)
                        }
                    }
                }
            }
            card.warning?.let { warning ->
                Surface(Modifier.fillMaxWidth().padding(top = 16.dp), RoundedCornerShape(12.dp), color = Ink.amber.copy(alpha = .14f)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        FactLine(warning)
                        Button(onClick = { sheet = PoolSheet.AddKey }) { Text(WhoCanUseIt.addAPIKey) }
                    }
                }
            }
        }
        FormSection(footer = page.outNote) {
            TextButton(onClick = { confirmingExit = true }, Modifier.fillMaxWidth()) { Text(page.exitLabel, color = Ink.red) }
        }
        Spacer(Modifier.height(48.dp))
    }
    signingOut?.let { login ->
        ConfirmDialog(CodexLogins.signOutTitle(login), CodexLogins.signOutNote(pool), "Sign out", { signingOut = null }) {
            press(CodexLogins.signedOut(login)) { api.delete("providers/pools/${pool.id}/codex-login/account", listOf("fingerprint" to login.text("fingerprint"))) }
        }
    }
    removingKey?.let { key ->
        ConfirmDialog("Remove ${key.text("label")}?", PoolPage.removeKeyNote, "Remove", { removingKey = null }) {
            press("${key.text("label")} is out of the pool") { api.delete("$accessPath/keys/${key.text("id")}") }
        }
    }
    removingPerson?.let { person ->
        ConfirmDialog("Remove ${person.text("name")} from ${access?.text("label").orEmpty()}?", PoolPage.removePersonNote, "Remove", { removingPerson = null }) {
            press(null) { api.delete("$accessPath/people/${person.text("userId")}") }
        }
    }
    if (confirmingJustMine && access != null) ConfirmDialog(JustMine.title(access), JustMine.cost(access, page.accounts), JustMine.confirm, { confirmingJustMine = false }) {
        // One person at a time, stopping at the first that fails (SharedPoolsModel.keepToSelf).
        press(null) { PoolPage.people(access).filter { it.bool("creator") != true }.forEach { api.delete("$accessPath/people/${it.text("userId")}") } }
    }
    if (confirmingExit) ConfirmDialog(page.exitTitle, page.outNote, page.exitConfirm, { confirmingExit = false }) {
        scope.launch { exit()?.let(notice::show) }
    }
    when (val current = sheet) {
        PoolSheet.Choose -> AddAccountSheet(pool, page.logins.size, page.mine, onDismiss = { sheet = null }) { kind ->
            sheet = if (kind == "key") PoolSheet.AddKey else PoolSheet.SignIn(null)
        }
        is PoolSheet.SignIn -> CodexSignInSheet(api, page.own ?: pool, page.mine, current.again, onDismiss = { sheet = null }) { scope.launch { reload() } }
        PoolSheet.AddKey -> if (access != null) AddPoolKeySheet(api, access, accessPath, null, onDismiss = { sheet = null; scope.launch { reload() } })
        is PoolSheet.Replace -> if (access != null) AddPoolKeySheet(api, access, accessPath, current.key, onDismiss = { sheet = null; scope.launch { reload() } }) { notice.show(it) }
        PoolSheet.Share -> if (access != null) SharePoolSheet(api, access, accessPath, page.accounts, onDismiss = { sheet = null }, addKeyFirst = { sheet = PoolSheet.AddKey }) { outcome ->
            sheet = null; notice.show(outcome); scope.launch { reload() }
        }
        null -> Unit
    }
}

@Composable
private fun ConfirmDialog(title: String, message: String, confirm: String, dismiss: () -> Unit, action: () -> Unit) {
    AlertDialog(onDismissRequest = dismiss, title = { Text(title) }, text = { Text(message) },
        confirmButton = { TextButton(onClick = { dismiss(); action() }) { Text(confirm, color = Ink.red) } },
        dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })
}

/** A row's second line; “Everyone here” is green and wraps with the rest as one line of text. */
@Composable
private fun SharedLine(line: String, tagged: Boolean) {
    val green = Ink.green
    Text(buildAnnotatedString {
        append(line)
        if (tagged) { append(" · "); withStyle(SpanStyle(color = green)) { append("Everyone here") } }
    }, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
}

@Composable
private fun CodexAccountRow(member: PoolMember, login: JsonObject, next: Boolean, tagged: Boolean, canSignInAgain: Boolean, canSignOut: Boolean,
                            contributor: String?, now: Long, signInAgain: () -> Unit, signOut: () -> Unit) {
    val status = ProviderPools.memberStatus(member, now)
    val windows = CodexLogins.windows(login)
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(member.label, style = MaterialTheme.typography.titleMedium, maxLines = 1); if (next) Chip("NEXT")
                }
                SharedLine(CodexLogins.line(login, contributor), tagged)
                Text(if (RunnerPage.isPaused(member.pausedUntil, now) && CodexLogins.active(login)) "Signed in" else status.label,
                    style = MaterialTheme.typography.bodySmall, color = poolTone(status.tone))
                if (member.state == "SIGNED_OUT") {
                    Text(if (canSignInAgain) CodexLogins.signedOutReason else CodexLogins.signedOutReasonNotYours(contributor),
                        style = MaterialTheme.typography.labelMedium, color = Ink.red)
                    if (canSignInAgain) Button(onClick = signInAgain) { Text("Sign in again") }
                }
            }
            if (canSignOut) TextButton(onClick = signOut, modifier = Modifier.semantics { contentDescription = "Sign out ${CodexLogins.name(login)}" }) { Text("Sign out") }
        }
        if (windows.isEmpty()) Text(CodexLogins.noQuota, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
        else windows.forEach { row -> UsageWindowRow(row, CodexLogins.resets(row, now)) }
    }
}

@Composable
private fun PoolKeyRow(key: JsonObject, pool: JsonObject, next: Boolean, tagged: Boolean, replace: () -> Unit, remove: () -> Unit, switch: () -> Unit) {
    val status = PoolPage.status(key, pool)
    val contributor = PoolPage.contributor(key)
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Avatar(contributor.text("name"), PoolPage.avatarColor(contributor.text("userId"), pool))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(key.text("label"), style = MaterialTheme.typography.titleMedium, maxLines = 1)
                if (contributor.bool("you") == true) Text("you", style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                if (next) Chip("NEXT")
            }
            SharedLine(PoolPage.keyLine(key), tagged)
            Text(status.label, style = MaterialTheme.typography.bodySmall, color = poolTone(status.tone))
            PoolPage.invalidReason(key, pool)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.red) }
            if (key.str("state") == "INVALID" && PoolPage.canReplace(key, pool)) Button(onClick = replace) { Text("Replace key") }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(PoolPage.money(key), style = MaterialTheme.typography.labelMedium, color = Ink.muted)
            PoolPage.capPercent(key)?.let { Gauge(it / 100f, if (it >= 90) Ink.amber else MaterialTheme.colorScheme.primary, Modifier.width(96.dp)) }
            if (PoolPage.canRemove(key, pool) || PoolPage.canSwitch(key)) Box {
                TextButton(onClick = { menu = true }, modifier = Modifier.semantics { contentDescription = "More for ${key.text("label")}" }) { Text("⋯") }
                DropdownMenu(menu, { menu = false }) {
                    if (PoolPage.canSwitch(key)) DropdownMenuItem(text = { Text(if (key.bool("enabled") == true) "Disable" else "Enable") }, onClick = { menu = false; switch() })
                    if (PoolPage.canRemove(key, pool)) DropdownMenuItem(text = { Text("Remove", color = Ink.red) }, onClick = { menu = false; remove() })
                }
            }
        }
    }
}

@Composable
private fun PersonRow(person: JsonObject, pool: JsonObject, line: WhoCanUseIt.PersonLine, share: Int?, manages: Boolean, offersRoles: Boolean,
                      remove: () -> Unit, setRole: (String) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Avatar(person.text("name"), PoolPage.avatarColor(person.text("userId"), pool))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(person.text("name"), maxLines = 1)
                if (person.bool("you") == true) Text("you", style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                if (person.bool("creator") == true) Chip("OWNER") else if (person.str("role") == "ADMIN") Chip("ADMIN")
            }
            Text(listOfNotNull(line.runs, line.rest).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        }
        share?.let {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("$it%", style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                Gauge(it / 100f, MaterialTheme.colorScheme.primary, Modifier.width(96.dp))
            }
        }
        if (manages) Box {
            TextButton(onClick = { menu = true }, modifier = Modifier.semantics { contentDescription = "More for ${person.text("name")}" }) { Text("⋯") }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text("Remove from pool", color = Ink.red) }, onClick = { menu = false; remove() })
                if (offersRoles) {
                    val admin = person.str("role") == "ADMIN"
                    DropdownMenuItem(text = { Text(if (admin) "Make member" else "Make admin") }, onClick = { menu = false; setRole(if (admin) "MEMBER" else "ADMIN") })
                }
            }
        }
    }
}

@Composable
private fun SheetFrame(title: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = onDismiss) { Text("Close") }
                }
                content()
            }
        }
    }
}

@Composable
private fun FactsCard(facts: List<Fact>, risk: Fact?) {
    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { facts.forEach { FactLine(it) } }
    }
    risk?.let {
        Surface(shape = RoundedCornerShape(14.dp), color = Ink.amber.copy(alpha = .14f)) {
            Text(buildAnnotatedString { append("⚠ "); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(it.lead) }; append(it.rest) },
                Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall, color = Ink.amber)
        }
    }
}

@Composable
private fun AddAccountSheet(pool: Pool, accounts: Int, mine: Boolean, onDismiss: () -> Unit, onContinue: (String) -> Unit) {
    var kind by remember { mutableStateOf("chatGPT") }
    SheetFrame("Add an account to ${pool.label}", onDismiss) {
        CodexPoolView.kinds(accounts, mine).forEach { option ->
            Row(Modifier.fillMaxWidth().selectable(kind == option.id, role = Role.RadioButton) { kind = option.id }.padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                RadioButton(selected = kind == option.id, onClick = null)
                Column {
                    Text(option.title, style = MaterialTheme.typography.titleMedium)
                    Text(buildAnnotatedString { append(option.lead + " "); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(option.bold) }; append(option.rest) },
                        style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                }
            }
        }
        Button(onClick = { onContinue(kind) }, Modifier.fillMaxWidth()) { Text("Continue") }
    }
}

/** CodexSignInSheet: consent, a code to approve, then the account in the pool — or why not. Leaving gives the attempt up. */
@Composable
private fun CodexSignInSheet(api: ManagementApi, pool: Pool, mine: Boolean, again: JsonObject?, onDismiss: () -> Unit, refresh: () -> Unit) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    val context = LocalContext.current
    var step by remember { mutableStateOf<CodexSignInText.Step>(CodexSignInText.Step.Consent) }
    var starting by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var live by remember { mutableStateOf(false) }
    val path = "providers/pools/${pool.id}/codex-login"
    val another = again == null && CodexLogins.logins(pool).isNotEmpty()
    fun giveUp() { if (live) { live = false; api.background.launch { try { api.delete(path) } catch (_: Exception) { } } } }
    DisposableEffect(Unit) { onDispose { giveUp() } }
    fun close() { giveUp(); onDismiss() }
    fun start() {
        starting = true; copied = false
        scope.launch {
            step = try {
                val attempt = api.post(path).jsonObject
                live = true
                CodexSignInText.Step.Code(attempt.text("verificationUrl"), attempt.text("userCode"), attempt.text("expiresAt"))
            } catch (e: CancellationException) { throw e } catch (e: Exception) { CodexSignInText.Step.Failed(personalFailure(e)) }
            starting = false
        }
    }
    val waiting = (step as? CodexSignInText.Step.Code)?.code
    LaunchedEffect(waiting) {
        if (waiting == null) return@LaunchedEffect
        while (true) {
            delay(2_000)
            val next = try { CodexSignInText.after(api.get(path).jsonObject) } catch (e: CancellationException) { throw e } catch (e: Exception) { CodexSignInText.afterPollFailure(e) }
            if (next != null) { live = false; if (next is CodexSignInText.Step.Done) refresh(); step = next; return@LaunchedEffect }
        }
    }
    SheetFrame(CodexSignInText.title, ::close) {
        when (val current = step) {
            CodexSignInText.Step.Consent -> {
                val (prefix, label, suffix) = CodexSignInText.lead(pool, again)
                Text(buildAnnotatedString { append(prefix); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(label) }; append(suffix) })
                FactsCard(CodexSignInText.facts(pool, mine, another), CodexSignInText.risk(mine, another))
                Button(onClick = ::start, enabled = !starting, modifier = Modifier.fillMaxWidth()) { Text(if (starting) "Starting…" else "Get a code") }
            }
            is CodexSignInText.Step.Code -> {
                if (current.url.startsWith("https://")) Button(onClick = { runCatching { uri.openUri(current.url) } }, Modifier.fillMaxWidth()) { Text("Open the sign-in page") }
                SelectionContainer { Text(current.url, style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
                Text(again?.str("email")?.let { email -> buildAnnotatedString { append("Sign in there as "); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(email) }; append(", then enter this one-time code:") } }
                    ?: buildAnnotatedString { append("Sign in there, then enter this one-time code:") }, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                Surface(Modifier.fillMaxWidth().clickable { copyText(context, "Sign-in code", current.code); copied = true }, RoundedCornerShape(18.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant) {
                    Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(current.code, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.headlineMedium)
                        Text(if (copied) "Copied" else "Copy code", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Text("Waiting for you to approve it…")
                }
                CodexSignInText.expiry(current.expiresAt, System.currentTimeMillis())?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
                TextButton(onClick = ::close, Modifier.fillMaxWidth()) { Text("Cancel") }
            }
            is CodexSignInText.Step.Done -> {
                Text("✓ " + CodexSignInText.doneTitle(current.account, pool), style = MaterialTheme.typography.titleMedium, color = Ink.green)
                Text(CodexSignInText.doneDetail(pool, current.logins), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                current.account?.let { Text(CodexSignInText.doneRow(it), style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
                Button(onClick = onDismiss, Modifier.fillMaxWidth()) { Text("Done") }
            }
            else -> {
                val (title, detail, retry) = when (current) {
                    CodexSignInText.Step.Expired -> Triple("The code expired", "It wasn’t approved in time. Get a new code to try again.", "Get a new code")
                    is CodexSignInText.Step.Failed -> Triple("The sign-in didn’t finish", CodexSignInText.sentence(current.reason), "Try again")
                    is CodexSignInText.Step.Duplicate -> Triple(CodexSignInText.duplicateTitle(pool), CodexSignInText.duplicateDetail(current.email), "Get a new code")
                    else -> Triple("", "", "")
                }
                Text(title, style = MaterialTheme.typography.titleMedium, color = Ink.amber)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                Button(onClick = ::start, enabled = !starting, modifier = Modifier.fillMaxWidth()) { Text(retry) }
                TextButton(onClick = ::close, Modifier.fillMaxWidth()) { Text("Close") }
            }
        }
    }
}

/** AddPoolKeySheet: consent, then name, key and monthly limit; or, replacing a refused key, only the key. */
@Composable
private fun AddPoolKeySheet(api: ManagementApi, pool: JsonObject, path: String, replacing: JsonObject?, onDismiss: () -> Unit, replaced: (String) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf(if (replacing == null) "consent" else "form") }
    var name by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("") }
    var limit by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf<Pair<String, String>?>(null) }
    var duplicate by remember { mutableStateOf<Pair<String?, Boolean>?>(null) }
    fun send() {
        val typed = key.trim(); val label = name.trim(); val cap = limit.toIntOrNull()
        val before = PoolPage.keys(pool).map { it.text("id") }.toSet()
        sending = true
        scope.launch {
            try {
                if (replacing == null) {
                    val after = api.post("$path/keys", buildJsonObject { put("label", label); put("apiKey", typed); cap?.let { put("shareCap", it) } }) as? JsonObject
                    val added = after?.let(PoolPage::keys)?.firstOrNull { it.text("id") !in before }
                    key = ""; done = (added?.text("label") ?: label) to (added?.text("fingerprint") ?: AddPoolKeyText.fingerprint(typed)); step = "done"
                } else {
                    api.put("$path/keys/${replacing.text("id")}/secret", buildJsonObject { put("apiKey", typed) })
                    replaced(AddPoolKeyText.replaced(replacing, pool)); onDismiss()
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                val by = AddPoolKeyText.duplicateBy(e)
                when {
                    by == null -> failure = personalFailure(e)
                    replacing == null -> { duplicate = by; step = "duplicate" }
                    else -> failure = AddPoolKeyText.replaceDuplicate(by.first, by.second, pool)
                }
            } finally { sending = false }
        }
    }
    SheetFrame(replacing?.let(AddPoolKeyText::replaceTitle) ?: AddPoolKeyText.title, onDismiss) {
        when (step) {
            "consent" -> {
                Text(buildAnnotatedString { append("Paste an OpenAI API key to put in "); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(pool.text("label")) }; append(".") })
                FactsCard(AddPoolKeyText.facts(pool), AddPoolKeyText.risk)
                Button(onClick = { step = "form" }, Modifier.fillMaxWidth()) { Text("Continue") }
                Text(AddPoolKeyText.consentNext, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
            }
            "form" -> {
                Text(replacing?.let(AddPoolKeyText::replaceLead) ?: AddPoolKeyText.formLead)
                if (replacing == null) OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)
                OutlinedTextField(key, { key = it; failure = null }, Modifier.fillMaxWidth(), label = { Text("Key") }, placeholder = { Text("sk-…") },
                    singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false))
                Text(failure ?: buildAnnotatedString {
                    append("Checked once, then only its fingerprint ("); withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(AddPoolKeyText.fingerprint(key)) }
                    append(") is shown — the key itself stays on the Orbit server.")
                }.text, style = MaterialTheme.typography.labelMedium, color = if (failure != null) Ink.red else Ink.muted)
                if (replacing == null) {
                    OutlinedTextField(limit, { typed -> limit = typed.filter { it in '0'..'9' } }, Modifier.fillMaxWidth(), label = { Text("Limit") },
                        placeholder = { Text("No limit") }, prefix = { Text("$") }, suffix = { Text("a month") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    Text(AddPoolKeyText.limitHint(pool), style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                }
                val canSend = if (replacing == null) name.isNotBlank() && key.isNotBlank() else key.isNotBlank()
                Button(onClick = ::send, enabled = canSend && !sending, modifier = Modifier.fillMaxWidth()) {
                    Text(if (sending) "…" else if (replacing == null) "Add key" else "Replace key")
                }
            }
            "done" -> done?.let { (label, fingerprint) ->
                Text("✓ " + AddPoolKeyText.doneTitle(label, pool), style = MaterialTheme.typography.titleMedium, color = Ink.green)
                Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(fingerprint) }; append(AddPoolKeyText.doneDetail) },
                    style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                PoolPage.people(pool).firstOrNull { it.bool("you") == true }?.let { me ->
                    Text("${me.text("name")} · $fingerprint · only its fingerprint is ever shown", style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                }
                Button(onClick = onDismiss, Modifier.fillMaxWidth()) { Text("Done") }
            }
            else -> duplicate?.let { (byName, you) ->
                Text(AddPoolKeyText.duplicateTitle(pool), style = MaterialTheme.typography.titleMedium, color = Ink.amber)
                Text(AddPoolKeyText.duplicateDetail(byName, you), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                Button(onClick = { key = ""; step = "form" }, Modifier.fillMaxWidth()) { Text("Add another key") }
                TextButton(onClick = onDismiss, Modifier.fillMaxWidth()) { Text("Close") }
            }
        }
    }
}

/** SharePoolSheet: one or more Orbit emails, what they get, and whether they may add keys of their own. */
@Composable
private fun SharePoolSheet(api: ManagementApi, pool: JsonObject, path: String, accounts: Int?, onDismiss: () -> Unit, addKeyFirst: () -> Unit, shared: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var typed by remember { mutableStateOf("") }
    var canAdd by remember { mutableStateOf(pool.bool("membersCanAdd") == true) }
    var sending by remember { mutableStateOf(false) }
    val emails = SharePool.emails(typed)
    fun send() {
        sending = true
        scope.launch {
            val missed = mutableListOf<String>()
            for (email in emails) {
                try { api.post("$path/people", buildJsonObject { put("email", email) }) }
                catch (e: CancellationException) { throw e } catch (e: Exception) { missed += "$email (${personalFailure(e)})" }
            }
            var outcome = SharePool.outcome(pool, missed)
            if (!SharePool.noKey(pool) && canAdd != (pool.bool("membersCanAdd") == true)) {
                try { api.patch(path, buildJsonObject { put("membersCanAdd", canAdd) }) }
                catch (e: CancellationException) { throw e } catch (e: Exception) { outcome = personalFailure(e) }
            }
            sending = false
            shared(outcome)
        }
    }
    SheetFrame(SharePool.title(pool), onDismiss) {
        OutlinedTextField(typed, { typed = it }, Modifier.fillMaxWidth(), label = { Text(SharePool.emailsLabel) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false))
        if (SharePool.empty(pool, accounts)) {
            FactsCard(emptyList(), SharePool.risk(pool, accounts))
            Button(onClick = addKeyFirst, Modifier.fillMaxWidth()) { Text("Add an API key first") }
            TextButton(onClick = ::send, enabled = emails.isNotEmpty() && !sending, modifier = Modifier.fillMaxWidth()) { Text("Share anyway") }
        } else {
            FactsCard(SharePool.facts(pool, accounts), null)
            Row(Modifier.fillMaxWidth().toggleable(canAdd, role = Role.Switch) { canAdd = it }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(WhoCanUseIt.ruleTitle, Modifier.weight(1f)); Switch(checked = canAdd, onCheckedChange = null)
            }
            Button(onClick = ::send, enabled = emails.isNotEmpty() && !sending, modifier = Modifier.fillMaxWidth()) { Text(if (sending) "…" else "Share") }
        }
    }
}
