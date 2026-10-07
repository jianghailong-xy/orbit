package io.orbitd.android.management

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** The current /users/me role decides whether the list is asked for; AdminRoleGuard rechecks every request. */
internal suspend fun adminSnapshot(api: ManagementApi): JsonObject {
    val me = api.get("users/me").jsonObject
    val users = if (me.text("role") == "ADMIN") api.get("admin/users") else JsonArray(emptyList())
    return buildJsonObject { put("me", me); put("users", users) }
}

/** AdminUsersView / AdminUserDetailView / NewUserSheet: every account, one account's role and removal, a new account. */
@Composable
fun AdminSettings(api: ManagementApi, revision: Long, userId: String?, open: (OrbitRoute) -> Unit, back: () -> Unit) {
    val record = remember(api) { PersonalRecord { adminSnapshot(api) } }
    PersonalRecordLifecycle(record, revision)
    val scope = rememberCoroutineScope()
    val snapshot = record.value as? JsonObject
    val allowed = (snapshot?.get("me") as? JsonObject)?.text("role") == "ADMIN"
    val users = snapshot?.list("users").orEmpty()
    var creating by remember(api) { mutableStateOf(false) }
    var password by remember(api) { mutableStateOf<String?>(null) }
    var failure by remember(api) { mutableStateOf<String?>(null) }
    var confirmingDelete by remember(api) { mutableStateOf(false) }
    // The generated password lives in memory only, and only while the page is in front.
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) password = null }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); password = null }
    }
    fun write(done: () -> Unit = {}, action: suspend () -> Unit) {
        failure = null
        scope.launch {
            try { action(); record.load(); done() }
            catch (e: CancellationException) { throw e } catch (e: Exception) { failure = personalFailure(e); record.load() }
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (record.busy || record.error != null) PersonalRecordStatus(record)
        failure?.let { Text(it, color = Ink.red, style = MaterialTheme.typography.labelMedium) }
        if (snapshot != null && !allowed) { Text("Administrator access is required.", color = Ink.muted); return@Column }
        password?.let { secret ->
            FormSection("Generated password — copy now, shown once") {
                SelectionContainer { Text(secret, Modifier.padding(vertical = 8.dp), fontFamily = FontFamily.Monospace) }
                TextButton(onClick = { password = null }) { Text("Dismiss") }
            }
        }
        if (userId == null) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { creating = true }, enabled = allowed) { Text("New user") }
            }
            if (snapshot == null) Text("Loading…", color = Ink.muted)
            else if (users.isEmpty()) Text("No users", color = Ink.muted)
            else FormSection {
                users.forEachIndexed { index, user ->
                    if (index > 0) HorizontalDivider()
                    Column(Modifier.fillMaxWidth().clickable(role = Role.Button) {
                        open(OrbitRoute(Destination.SETTINGS, "admin", recordId = user.text("id")))
                    }.padding(vertical = 8.dp)) {
                        Text(user.str("name")?.takeIf { it.isNotEmpty() } ?: user.text("email"), maxLines = 1)
                        Text("${user.text("email")} · ${user.text("role")}", style = MaterialTheme.typography.bodySmall, color = Ink.muted, maxLines = 2)
                    }
                }
            }
        } else {
            val user = users.firstOrNull { ObjectId.same(it.text("id"), userId) }
            if (user == null) { if (snapshot != null) Text("Select a user", color = Ink.muted); return@Column }
            FormSection {
                listOfNotNull("Email" to user.text("email"), user.str("name")?.takeIf { it.isNotEmpty() }?.let { "Name" to it },
                    user.str("createdAt")?.let { "Created" to it }).forEachIndexed { index, (label, value) ->
                    if (index > 0) HorizontalDivider()
                    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) { Text(label, Modifier.weight(1f)); SelectionContainer { Text(value, color = Ink.muted) } }
                }
            }
            FormSection("Role") {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    listOf("MEMBER" to "Member", "ADMIN" to "Admin").forEachIndexed { index, (role, label) ->
                        SegmentedButton(selected = (user.str("role") ?: "MEMBER") == role, shape = SegmentedButtonDefaults.itemShape(index, 2),
                            enabled = record.ready, onClick = {
                                if (role != user.str("role")) write { api.patch("admin/users/${user.text("id")}/role", buildJsonObject { put("role", role) }) }
                            }) { Text(label) }
                    }
                }
            }
            FormSection { TextButton(onClick = { confirmingDelete = true }, enabled = record.ready) { Text("Delete user", color = Ink.red) } }
            if (confirmingDelete) AlertDialog(onDismissRequest = { confirmingDelete = false }, title = { Text("Delete ${user.text("email")}?") },
                text = { Text("This permanently removes the account if the server permits it.") },
                confirmButton = { TextButton(onClick = {
                    confirmingDelete = false
                    write(done = back) { api.delete("admin/users/${user.text("id")}") }
                }) { Text("Delete user", color = Ink.red) } },
                dismissButton = { TextButton(onClick = { confirmingDelete = false }) { Text("Cancel") } })
        }
    }
    if (creating) NewUserDialog(onDismiss = { creating = false }) { email, name ->
        creating = false
        write {
            val created = api.post("admin/users", buildJsonObject { put("email", email.trim()); name?.let { put("name", it) } }).jsonObject
            password = created.str("generatedPassword")?.takeIf { it.isNotBlank() }
        }
    }
}

@Composable
private fun NewUserDialog(onDismiss: () -> Unit, create: (String, String?) -> Unit) {
    var email by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("New user") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false))
            OutlinedTextField(name, { name = it }, label = { Text("Name (optional)") }, singleLine = true)
            Text("A strong password is generated and shown once after creating.", style = MaterialTheme.typography.labelMedium, color = Ink.muted)
        }
    }, confirmButton = { TextButton(onClick = { create(email, name.takeIf { it.isNotEmpty() }) }, enabled = email.isNotEmpty()) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
