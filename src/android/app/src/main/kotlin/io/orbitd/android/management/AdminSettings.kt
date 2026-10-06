package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** The current /users/me role hides the surface; AdminRoleGuard remains the authority per write. */
internal suspend fun adminSnapshot(api: ManagementApi): JsonObject {
    val me = api.get("users/me").jsonObject
    val users = if (me.text("role") == "ADMIN") api.get("admin/users") else JsonArray(emptyList())
    return buildJsonObject { put("me", me); put("users", users) }
}

@Composable
fun AdminSettings(api: ManagementApi, revision: Long) {
    val record = remember(api) { PersonalRecord { adminSnapshot(api) } }
    PersonalRecordLifecycle(record, revision)
    val scope = rememberCoroutineScope()
    val snapshot = record.value as? JsonObject
    val me = snapshot?.get("me") as? JsonObject
    val allowed = me?.text("role") == "ADMIN"
    var email by remember(api) { mutableStateOf("") }
    var name by remember(api) { mutableStateOf("") }
    var password by remember(api) { mutableStateOf<String?>(null) }
    var delete by remember(api) { mutableStateOf<JsonObject?>(null) }
    var roleChange by remember(api) { mutableStateOf<Pair<JsonObject, String>?>(null) }
    LaunchedEffect(allowed) { if (!allowed) password = null }
    val owner = LocalLifecycleOwner.current
    var foreground by remember(owner) { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE) { foreground = false; password = null }
            if (event == Lifecycle.Event.ON_RESUME) foreground = true
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); password = null }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Admin", style = MaterialTheme.typography.titleLarge)
        PersonalRecordStatus(record)
        if (snapshot != null && !allowed) Text("Administrator access is required. Your account role is ${me?.text("role") ?: "unknown"}.")
        if (allowed) {
            Text("New user", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, enabled = record.ready)
            OutlinedTextField(name, { name = it }, label = { Text("Name (optional)") }, enabled = record.ready)
            Text("A strong password is generated and shown once after creating.")
            Button(onClick = { scope.launch {
                password = null
                record.mutate {
                    val created = api.post("admin/users", buildJsonObject {
                        put("email", email.trim()); if (name.trim().isNotEmpty()) put("name", name.trim())
                    }).jsonObject
                    // The password cannot be fetched again if the following list refresh fails.
                    password = if (foreground) created.text("generatedPassword").ifBlank { null } else null
                    email = ""; name = ""
                }
            } }, enabled = record.ready && email.trim().isNotEmpty()) { Text("Create user") }
            password?.let { secret ->
                Text("Generated password — copy now, shown once")
                SelectionContainer { Text(secret) }
                TextButton(onClick = { password = null }) { Text("Dismiss password") }
            }
            snapshot?.list("users").orEmpty().forEach { user ->
                HorizontalDivider()
                Text(user.text("name").ifBlank { user.text("email") }, style = MaterialTheme.typography.titleMedium)
                Text("${user.text("email")} · ${user.text("role")}\nCreated: ${user.text("createdAt")}")
                PersonalChoice("Role", user.text("role"), listOf("MEMBER" to "Member", "ADMIN" to "Admin"), record.ready) {
                    if (it != user.text("role")) roleChange = user to it
                }
                TextButton(onClick = { delete = user }, enabled = record.ready && user.text("id") != me?.text("id")) { Text("Delete user") }
            }
            Text("The server prevents removal of the last administrator and refuses deletion while the user owns resources.")
        }
    }
    delete?.let { user -> AlertDialog(onDismissRequest = { delete = null }, title = { Text("Delete ${user.text("email")}?" ) },
        text = { Text("This permanently removes the account if the server permits it.") },
        confirmButton = { TextButton(enabled = record.ready && allowed, onClick = { delete = null; scope.launch {
            record.mutate { api.delete("admin/users/${user.text("id")}") }
        } }) { Text("Delete user") } }, dismissButton = { TextButton(onClick = { delete = null }) { Text("Cancel") } }) }
    roleChange?.let { (user, role) -> AlertDialog(onDismissRequest = { roleChange = null }, title = { Text("Change role?") },
        text = { Text("${user.text("email")} will become $role.") },
        confirmButton = { TextButton(enabled = record.ready && allowed, onClick = { roleChange = null; scope.launch {
            record.mutate { api.patch("admin/users/${user.text("id")}/role", buildJsonObject { put("role", role) }) }
        } }) { Text("Change role") } }, dismissButton = { TextButton(onClick = { roleChange = null }) { Text("Cancel") } }) }
}
