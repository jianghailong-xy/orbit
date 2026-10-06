package io.orbitd.android.management

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.core.net.ApiError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
fun ProviderManagement(api: ManagementApi, revision: Long, onRunner: (String) -> Unit = {}) {
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var isCodex by rememberSaveable { mutableStateOf(true) }
    var nonce by remember { mutableLongStateOf(0) }
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    val state = remember(api, selected) { ProviderResource(api, selected, isCodex) }
    ProviderLifecycle(state, revision + nonce)
    BackHandler(selected != null) { selected = null }
    if (selected != null) {
        ProviderPoolScreen(state, { selected = null; nonce++ }) { scope.launch { state.load() } }
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Providers", style = MaterialTheme.typography.headlineSmall)
        ProviderStatus(state) { scope.launch { state.load() } }
        Text("On your runners", style = MaterialTheme.typography.titleMedium)
        Text("Signed in on the remote machine. Open a runner to manage its engines and accounts.")
        state.runners.forEach { runner ->
            OutlinedButton(onClick = { onRunner(runner.text("id")) }, modifier = Modifier.fillMaxWidth()) {
                val signed = runner.list("engines").count { it.text("auth") == "yes" }
                Text("${runner.text("displayName").ifBlank { runner.text("name") }} · ${if (runner.flag("online")) "Online" else "Offline"} · $signed engines signed in")
            }
        }
        Text("Account pools", style = MaterialTheme.typography.titleMedium)
        if (state.ready && state.pools.isEmpty()) Text("No account pools")
        state.pools.forEach { pool ->
            OutlinedButton(onClick = { isCodex = pool.text("engine") == "codex"; selected = pool.text("id") }, modifier = Modifier.fillMaxWidth()) {
                Column {
                    Text(pool.text("label"))
                    Text(pool.text("unavailable").ifBlank { "${pool.text("engine")} · ${pool.text("viewerRole").ifBlank { "Your pool" }}" })
                }
            }
        }
        Text("Your API keys", style = MaterialTheme.typography.titleMedium)
        if (state.ready && state.keys.isEmpty()) Text("No keys yet")
        state.keys.forEach { key ->
            Text("${key.text("label")} · ${key.text("defaultModel").ifBlank { "Default model" }}${if (key.flag("enabled")) "" else " · Disabled"}")
        }
        Text("Adding or changing a personal API key happens on the web, as on iOS.")
        TextButton({ runCatching { uri.openUri(api.handle.account.server.trimEnd('/') + "/providers") } }) { Text("Open providers on web") }
    }
}

internal class ProviderResource(private val api: ManagementApi, val id: String?, val codex: Boolean) {
    var runners by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var pools by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var keys by mutableStateOf<List<JsonObject>>(emptyList()); private set
    var pool by mutableStateOf<JsonObject?>(null); private set
    var attempt by mutableStateOf<JsonObject?>(null); private set
    var ready by mutableStateOf(false); private set
    var fresh by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    private var generation = 0
    private var active by mutableStateOf(true)
    val resumed get() = active
    private val path get() = "providers/${if (codex) "shared-pools" else "pools"}/$id"

    fun pause() { active = false; generation++; fresh = false; busy = false }
    fun resume() { active = true }
    suspend fun load() {
        val ticket = ++generation
        fresh = false; busy = true
        try {
            if (id == null) {
                val loadedRunners = providerObjects(api.get("runners"))
                val own = providerObjects(api.get("providers/pools"))
                val shared = providerObjects(api.get("providers/shared-pools"))
                val loadedKeys = providerObjects(api.get("providers/mine"))
                if (ticket != generation || !active) return
                runners = loadedRunners; pools = (own + shared).distinctBy { it.text("id") }; keys = loadedKeys
            } else {
                val loaded = api.get(path).jsonObject
                if (ticket != generation || !active) return
                pool = loaded
            }
            ready = true; fresh = true; error = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { if (ticket == generation) fail(failure) }
        finally { if (ticket == generation) busy = false }
    }

    /** Re-read the role and target immediately before every mutation; server authorization remains final. */
    suspend fun change(allowed: (JsonObject) -> Boolean, action: suspend (JsonObject) -> Unit): Boolean {
        if (!fresh || busy || !active || id == null) return false
        val ticket = ++generation
        busy = true; fresh = false
        return try {
            val current = api.get(path).jsonObject
            if (ticket != generation || !active) return false
            pool = current
            check(allowed(current)) { "Your permissions changed. Refresh before trying again." }
            action(current)
            if (ticket != generation || !active) return false
            val updated = api.get(path).jsonObject
            if (ticket != generation || !active) return false
            pool = updated
            fresh = true; error = null; true
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { if (ticket == generation) fail(failure); false }
        finally { if (ticket == generation) busy = false }
    }

    suspend fun rule(name: String, value: Boolean) = change({ ProviderAccess(it).admin }) {
        api.patch(path, buildJsonObject { put(name, value) })
    }
    suspend fun keyAction(keyId: String, verb: String, body: JsonObject = JsonObject(emptyMap())) = change({ current ->
        current.list("keys").firstOrNull { it.text("id") == keyId }?.let {
            if (verb == "switch") ProviderAccess(current).canSwitch(it) else ProviderAccess(current).canManage(it)
        } == true
    }) {
        val keyPath = "$path/keys/$keyId"
        when (verb) {
            "delete" -> api.delete(keyPath)
            "replace" -> api.put("$keyPath/secret", body)
            else -> api.patch(keyPath, body)
        }
    }
    suspend fun addKey(body: JsonObject) = change({ ProviderAccess(it).canAddKey }) { api.post("$path/keys", body) }
    suspend fun addPerson(email: String) = change({ ProviderAccess(it).admin }) {
        api.post("$path/people", buildJsonObject { put("email", email.trim()); put("role", "MEMBER") })
    }
    suspend fun personAction(userId: String, role: String? = null) = change({ current ->
        current.list("people").firstOrNull { it.text("userId") == userId }?.let {
            if (role == null) ProviderAccess(current).canRemovePerson(it) else ProviderAccess(current).canChangeRole(it)
        } == true
    }) {
        if (role == null) api.delete("$path/people/$userId")
        else api.patch("$path/people/$userId", buildJsonObject { put("role", role) })
    }
    suspend fun keepToSelf() = change({ ProviderAccess(it).owner }) { current ->
        val ticket = generation
        for (person in current.list("people").filterNot { it.flag("creator") }) {
            if (!active || generation != ticket) throw CancellationException()
            api.delete("$path/people/${person.text("userId")}")
        }
    }
    suspend fun pauseMember(memberId: String, minutes: Int?) = change({ current ->
        if (!codex) current.list("members").any { it.text("id") == memberId }
        else if (memberId.startsWith("login:")) current.list("logins").firstOrNull { "login:${it.text("fingerprint")}" == memberId }
            ?.let { ProviderAccess(current).canRemoveAccount(it) } == true
        else current.list("keys").firstOrNull { it.text("id") == memberId }?.let { ProviderAccess(current).canManage(it) } == true
    }) {
        api.post("providers/pools/$id/members/$memberId/pause", buildJsonObject { put("durationMinutes", minutes?.let(::JsonPrimitive) ?: JsonNull) })
    }
    suspend fun startLogin(): Boolean {
        if (attempt?.text("status") == "PENDING") return false
        var response: JsonObject? = null
        val completed = change({ ProviderAccess(it).canAddAccount }) {
            response = api.post("providers/pools/$id/codex-login").jsonObject
        }
        if (completed) attempt = response
        return completed
    }
    suspend fun pollLogin(): Boolean {
        var response: JsonObject? = null
        val completed = change({ ProviderAccess(it).canAddAccount }) {
            response = api.get("providers/pools/$id/codex-login").jsonObject
        }
        if (completed) attempt = response
        return completed
    }
    suspend fun cancelLogin(): Boolean {
        val completed = change({ ProviderAccess(it).canAddAccount }) { api.delete("providers/pools/$id/codex-login") }
        if (completed) attempt = null
        return completed
    }
    suspend fun signOut(fingerprint: String) = change({ current ->
        current.list("logins").firstOrNull { it.text("fingerprint") == fingerprint }?.let { ProviderAccess(current).canRemoveAccount(it) } == true
    }) { api.delete("providers/pools/$id/codex-login/account", listOf("fingerprint" to fingerprint)) }

    suspend fun exit(): Boolean {
        if (!fresh || busy || !active) return false
        val ticket = ++generation; busy = true; fresh = false
        return try {
            val current = api.get(path).jsonObject
            if (ticket != generation || !active) return false
            val access = ProviderAccess(current)
            check(access.owner || access.pool.text("viewerRole") == "MEMBER")
            if (access.owner) api.delete(path) else api.post("$path/leave")
            ticket == generation && active
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { if (ticket == generation) fail(failure); false }
        finally { if (ticket == generation) busy = false }
    }
    private fun fail(failure: Exception) {
        fresh = false
        error = if (failure is IllegalStateException) "Your permissions changed. Refresh before trying again." else providerError(failure)
        if (failure is ApiError && failure.status in setOf(401, 403, 404)) {
            pool = null; pools = emptyList(); keys = emptyList(); runners = emptyList(); attempt = null
        }
    }
}

@Composable
private fun ProviderLifecycle(state: ProviderResource, revision: Long) {
    val owner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    DisposableEffect(state, owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) { state.resume(); scope.launch { state.load() } }
            if (event == Lifecycle.Event.ON_PAUSE) state.pause()
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); state.pause() }
    }
    LaunchedEffect(state, revision) {
        if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) { state.resume(); state.load() }
        else state.pause()
    }
}

@Composable
private fun ProviderStatus(state: ProviderResource, refresh: () -> Unit) {
    if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    if (state.ready && !state.fresh) Text("Showing earlier data. Management is disabled until a successful refresh.")
    TextButton(refresh, enabled = !state.busy) { Text("Refresh providers") }
}

private data class ProviderPrompt(val title: String, val note: String, val fields: List<String> = emptyList(),
    val secret: Boolean = false, val submit: suspend (List<String>) -> Boolean)

@Composable
private fun ProviderPoolScreen(state: ProviderResource, back: () -> Unit, refresh: () -> Unit) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var prompt by remember { mutableStateOf<ProviderPrompt?>(null) }
    val pool = state.pool
    val access = pool?.let(::ProviderAccess)
    val writable = state.fresh && !state.busy
    val pendingLogin = state.attempt?.text("status") == "PENDING"
    LaunchedEffect(state, state.resumed, pendingLogin) {
        while (state.resumed && state.attempt?.text("status") == "PENDING") {
            delay(3_000)
            if (state.resumed && state.fresh && !state.busy) state.pollLogin()
        }
    }
    fun ask(title: String, note: String, action: suspend () -> Boolean) { prompt = ProviderPrompt(title, note, submit = { action() }) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(back) { Text("Back to providers") }
        Text(pool?.text("label") ?: "Account pool", style = MaterialTheme.typography.headlineSmall)
        ProviderStatus(state, refresh)
        if (pool == null) return@Column
        if (!state.codex) {
            Text(pool.text("unavailable").ifBlank { "Sessions start on the account the server selects." })
            pool.list("members").forEach { member ->
                Text("${member.text("label")} · ${member.text("state")}${if (member.flag("next")) " · Next" else ""}")
                Text(providerUsage(member["planUsage"] as? JsonObject))
                ProviderPause(member, writable) { minutes -> scope.launch { state.pauseMember(member.text("id"), minutes) } }
            }
            Text("Adding or changing these accounts happens on the web.")
            return@Column
        }
        Text("${pool.text("viewerRole")} · ${if (access?.owner == true) "Your pool" else "Shared with you"}")
        Text("ChatGPT accounts", style = MaterialTheme.typography.titleMedium)
        if (access?.canAddAccount == true) Button(onClick = { scope.launch { state.startLogin() } }, enabled = writable && !pendingLogin) { Text("Sign in with ChatGPT") }
        state.attempt?.let { attempt ->
            Text("Sign-in: ${attempt.text("status")}")
            if (attempt.text("status") == "PENDING") {
                Text("Code: ${attempt.text("userCode")} · expires ${attempt.text("expiresAt")}")
                val url = attempt.text("verificationUrl")
                if (url.startsWith("https://")) TextButton({ runCatching { uri.openUri(url) } }) { Text("Open sign-in page") }
                TextButton({ scope.launch { state.pollLogin() } }, enabled = writable) { Text("Check sign-in") }
                TextButton({ scope.launch { state.cancelLogin() } }, enabled = writable) { Text("Cancel sign-in") }
            }
        }
        pool.list("logins").forEach { login ->
            HorizontalDivider()
            Text("${login.text("email").ifBlank { "ChatGPT account" }} · ${login.text("fingerprint")}")
            Text("${login.text("state")} · ${login.text("plan")}${if (login.flag("next")) " · Next" else ""}")
            if (login.text("expiresAt").isNotBlank()) Text("Credential expiry: ${login.text("expiresAt")}")
            if (login.text("lastError").isNotBlank()) Text("The account needs attention. Sign in again with its contributor.")
            Text(providerUsage(login["usage"] as? JsonObject))
            if (login.text("usageUnavailable").isNotBlank()) Text("Usage unavailable: ${login.text("usageUnavailable")}")
            if (access?.ownsAccount(login) == true && login.text("state") == "SIGNED_OUT")
                TextButton({ scope.launch { state.startLogin() } }, enabled = writable && !pendingLogin) { Text("Sign in again") }
            if (access?.canRemoveAccount(login) == true) {
                ProviderPause(login, writable) { minutes -> scope.launch { state.pauseMember("login:${login.text("fingerprint")}", minutes) } }
                TextButton({ ask("Sign out account?", "The server will remove this account's stored sign-in from this pool.") { state.signOut(login.text("fingerprint")) } }, enabled = writable) { Text("Sign out") }
            }
        }
        Text("API keys", style = MaterialTheme.typography.titleMedium)
        if (access?.canAddKey == true) Button(onClick = {
            prompt = ProviderPrompt("Add OpenAI API key", "The secret is stored on the server. A monthly cap limits other people's use, in whole USD; blank means no cap.", listOf("Label", "API key", "Monthly cap (optional)"), true) { values ->
                state.addKey(buildJsonObject { put("label", values[0].trim()); put("apiKey", values[1].trim()); put("shareCap", values[2].trim().toIntOrNull()?.let(::JsonPrimitive) ?: JsonNull) })
            }
        }, enabled = writable) { Text("Add API key") }
        pool.list("keys").forEach { key ->
            HorizontalDivider()
            Text("${key.text("label")} · ${key.text("fingerprint")}${if (key.flag("next")) " · Next" else ""}")
            Text("${(key["contributor"] as? JsonObject)?.text("name").orEmpty()} · ${providerKeyStatus(key)}")
            val usage = key["usage"] as? JsonObject
            Text("Others this month: $${usage?.text("othersCostUsd").orEmpty()} · cap ${key.text("shareCap").ifBlank { "None" }}")
            if (access?.canSwitch(key) == true) TextButton({ scope.launch { state.keyAction(key.text("id"), "switch", buildJsonObject { put("enabled", !key.flag("enabled")) }) } }, enabled = writable,
                modifier = Modifier.semantics { contentDescription = "${if (key.flag("enabled")) "Disable" else "Enable"} key ${key.text("label")}" }) { Text(if (key.flag("enabled")) "Disable key" else "Enable key") }
            if (access?.canManage(key) == true) {
                if (key.text("state") == "INVALID") TextButton({
                    prompt = ProviderPrompt("Replace key", "Only the replacement secret is sent; stored secrets are never read back.", listOf("API key"), true) { values -> state.keyAction(key.text("id"), "replace", buildJsonObject { put("apiKey", values[0].trim()) }) }
                }, enabled = writable) { Text("Replace rejected key") }
                ProviderPause(key, writable) { minutes -> scope.launch { state.pauseMember(key.text("id"), minutes) } }
                TextButton({ ask("Remove key?", "It is deleted from the server and no session runs on it again.") { state.keyAction(key.text("id"), "delete") } }, enabled = writable) { Text("Remove key") }
            }
        }
        Text("Who can use it", style = MaterialTheme.typography.titleMedium)
        if (access?.admin == true) {
            TextButton({ prompt = ProviderPrompt("Share pool", "Add an existing Orbit account as a member.", listOf("Email")) { state.addPerson(it[0]) } }, enabled = writable) { Text("Add person") }
            listOf("membersCanAdd" to "Members can add keys", "membersCanAddAccounts" to "Members can add accounts", "ownKeyFirst" to "Prefer each person's own key").forEach { (field, label) ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(label, Modifier.weight(1f))
                    Switch(pool.flag(field), { value -> scope.launch { state.rule(field, value) } }, enabled = writable,
                        modifier = Modifier.semantics { contentDescription = label })
                }
            }
        }
        pool.list("people").forEach { person ->
            Text("${person.text("name")} · ${person.text("role")}${if (person.flag("creator")) " · Owner" else ""}${if (person.flag("you")) " · You" else ""}")
            Text("${person.text("keys")} keys · ${person.text("sessions")} sessions · $${(person["usage"] as? JsonObject)?.text("costUsd").orEmpty()} this month")
            if (access?.canChangeRole(person) == true) TextButton({
                val role = if (person.text("role") == "ADMIN") "MEMBER" else "ADMIN"
                ask("Change pool role?", "${person.text("name")} will become $role in this pool.") { state.personAction(person.text("userId"), role) }
            }, enabled = writable) { Text(if (person.text("role") == "ADMIN") "Make member" else "Make admin") }
            if (access?.canRemovePerson(person) == true) TextButton({ ask("Remove person?", "Their keys and access leave with them.") { state.personAction(person.text("userId")) } }, enabled = writable) { Text("Remove person") }
        }
        if (access?.owner == true && pool.list("people").size > 1) TextButton({ ask("Keep pool to yourself?", "Everyone else and their keys will leave this pool. If any removal fails, refresh to see the partial result.") { state.keepToSelf() } }, enabled = writable) { Text("Just me") }
        if (access?.owner == true || pool.text("viewerRole") == "MEMBER") TextButton({
            ask(if (access?.owner == true) "Delete pool?" else "Leave pool?", "This removes access and stored pool credentials. Existing sessions may need another provider.") {
                state.exit().also { if (it) back() }
            }
        }, enabled = writable) { Text(if (access?.owner == true) "Delete pool" else "Leave pool") }
        else if (access?.admin == true) Text("Another pool admin must make you a member before you can leave.")
    }
    prompt?.let { current -> ProviderPromptDialog(current, writable, { prompt = null }) }
}

@Composable
private fun ProviderPause(member: JsonObject, enabled: Boolean, pause: (Int?) -> Unit) {
    val until = member.text("pausedUntil")
    if (until.isNotBlank()) Text("Paused until $until")
    Row {
        TextButton({ pause(30) }, enabled = enabled) { Text("Pause 30 min") }
        TextButton({ pause(120) }, enabled = enabled) { Text("Pause 2 hours") }
        if (until.isNotBlank()) TextButton({ pause(null) }, enabled = enabled) { Text("Resume") }
    }
}

@Composable
private fun ProviderPromptDialog(prompt: ProviderPrompt, writable: Boolean, dismiss: () -> Unit) {
    val values = remember(prompt) { mutableStateListOf<String>().apply { repeat(prompt.fields.size) { add("") } } }
    var sending by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val valid = values.withIndex().all { (index, value) ->
        if (prompt.fields[index].contains("optional")) value.isBlank() || (value.toIntOrNull()?.let { it >= 0 } == true)
        else value.isNotBlank()
    }
    AlertDialog(onDismissRequest = { if (!sending) dismiss() }, title = { Text(prompt.title) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(prompt.note)
            if (failed) Text("The action did not complete. Close this dialog and refresh to check the current state.", color = MaterialTheme.colorScheme.error)
            prompt.fields.forEachIndexed { index, field ->
                OutlinedTextField(values[index], { values[index] = it }, label = { Text(field) }, singleLine = true,
                    visualTransformation = if (prompt.secret && field == "API key") PasswordVisualTransformation() else VisualTransformation.None)
            }
        }
    }, confirmButton = {
        TextButton({ scope.launch { sending = true; try { if (prompt.submit(values.toList())) dismiss() else failed = true } finally { sending = false } } }, enabled = writable && valid && !sending) { Text("Confirm") }
    }, dismissButton = { TextButton({ dismiss() }, enabled = !sending) { Text("Cancel") } })
}
