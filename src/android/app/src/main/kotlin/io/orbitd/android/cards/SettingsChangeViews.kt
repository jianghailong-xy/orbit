package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.OwnerRequest
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.SettingPlace
import io.orbitd.android.core.cards.SettingsChangeCopy
import io.orbitd.android.core.cards.SettingsChangeEntry
import io.orbitd.android.core.cards.SettingsFromConversation
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Settings from a conversation (docs/settings-from-conversation-design.md §8): the SETTINGS_CHANGE card and its folded lines, the Open in
// Settings row an `orbit-settings:` link becomes, and the grey line under a Settings row changed from a conversation. Every word is
// `SettingsChangeCopy` / `SettingsFromConversation` in core; iOS `SettingsChangeViews.swift`, web `SettingsChangeCard.tsx`.

/** A pending SETTINGS_CHANGE request, the whole card (board 1 frame ②): rows, struck from → to, tier-2 note, the agent's reason, the
 * foot, and Save changes / Chat about this. Chat about this opens the decline form: the reason goes back to the agent. */
@Composable
fun SettingsChangeCard(request: OwnerRequest, store: OwnerRequestStore) {
    val scope = rememberCoroutineScope()
    val tag = "owner-request:${request.id}"
    val entries = remember(request) { SettingsFromConversation.entries(request.payload) }
    var stale by remember(request.id) { mutableStateOf(false) }
    var declining by remember(request.id) { mutableStateOf(false) }
    var reason by remember(request.id) { mutableStateOf("") }
    var busy by remember(request.id) { mutableStateOf(false) }
    var failure by remember(request.id) { mutableStateOf<String?>(null) }
    fun decline(why: String) {
        busy = true; failure = null
        scope.launch { failure = store.act { decline(request.id, why) }; busy = false }
    }
    if (stale) { SettingsStaleLine(tag, busy) { decline(SettingsChangeCopy.stale) }; return }
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag(tag).background(tone.copy(alpha = 0.03f), RoundedCornerShape(12.dp))
        .border(1.dp, tone.copy(alpha = 0.45f), RoundedCornerShape(12.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(SettingsChangeCopy.heading(entries.size), Modifier.testTag("$tag:title"), style = MaterialTheme.typography.titleMedium)
        SettingsFromConversation.groups(entries).forEach { (path, rows) ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                path?.let { Text(it, Modifier.testTag("$tag:path"), style = MaterialTheme.typography.labelMedium, color = secondary) }
                rows.forEach { SettingsChangeRow(it, tag) }
            }
        }
        if (request.why.isNotEmpty()) Text(SettingsChangeCopy.agentSays(request.why), Modifier.testTag("$tag:why"),
            style = MaterialTheme.typography.labelMedium, color = secondary)
        Text(SettingsChangeCopy.foot, Modifier.testTag("$tag:foot"), style = MaterialTheme.typography.labelMedium, color = secondary)
        failure?.let { Text("${OwnerRequests.notRecorded}: $it", Modifier.testTag("$tag:error"), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.error) }
        if (declining) {
            OutlinedTextField(reason, { reason = it.take(2000) }, Modifier.fillMaxWidth().testTag("$tag:reason"),
                placeholder = { Text(SettingsChangeCopy.declinePlaceholder) }, minLines = 2, maxLines = 6)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { decline(reason.trim()) }, Modifier.testTag("$tag:decline-send"), enabled = reason.isNotBlank() && !busy) {
                    Text(SettingsChangeCopy.decline)
                }
                TextButton(onClick = { declining = false }, Modifier.testTag("$tag:keep")) { Text(SettingsChangeCopy.keep) }
            }
        } else FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Button(onClick = {
                busy = true; failure = null
                scope.launch {
                    val error = store.attempt { applySettings(request.id) }
                    if (error == null) store.loadAccount()
                    else if (SettingsFromConversation.isStale(error)) stale = true
                    else failure = OwnerRequestStore.message(error)
                    busy = false
                }
            }, Modifier.testTag("$tag:primary"), enabled = !busy) { Text(SettingsChangeCopy.save, fontWeight = FontWeight.Bold) }
            OutlinedButton(onClick = { declining = true }, Modifier.testTag("$tag:chat"), enabled = !busy) { Text(SettingsChangeCopy.chat) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}

@Composable
private fun SettingsChangeRow(entry: SettingsChangeEntry, tag: String) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.testTag("$tag:row:${entry.key}"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
            Text(SettingsFromConversation.title(entry.key), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium))
            Text(SettingsFromConversation.valueLabel(entry.key, entry.from), Modifier.testTag("$tag:from:${entry.key}"),
                style = MaterialTheme.typography.bodySmall.copy(textDecoration = TextDecoration.LineThrough), color = secondary)
            Text("→", style = MaterialTheme.typography.bodySmall, color = secondary)
            Text(SettingsFromConversation.valueLabel(entry.key, entry.to), Modifier.testTag("$tag:to:${entry.key}"),
                style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.Bold))
        }
        if (entry.tier == 2) Text(SettingsChangeCopy.newSessionsOnly, Modifier.testTag("$tag:new-sessions:${entry.key}"),
            style = MaterialTheme.typography.labelMedium, color = secondary)
    }
}

@Composable
private fun SettingsStaleLine(tag: String, busy: Boolean, decline: () -> Unit) {
    Row(Modifier.fillMaxWidth().testTag("$tag:stale").padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(painterResource(R.drawable.ic_warning), null, Modifier.size(16.dp), tint = LocalOrbitColors.current.needsYou)
        Text(SettingsChangeCopy.stale, style = MaterialTheme.typography.bodySmall)
        Text("·", color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = decline, enabled = !busy) { Text(SettingsChangeCopy.decline) }
    }
}

/** An answered SETTINGS_CHANGE request, one line: `✓ Changed 2 settings · Undo` (Undo is the owner's own preferences PATCH with each
 * `from`, for the keys this card still marks — a setting changed since is the owner's and is left alone), or `Declined`. */
@Composable
fun SettingsChangeFolded(request: OwnerRequest, store: OwnerRequestStore) {
    val tag = "owner-request:${request.id}"
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    if (request.state == "DECLINED") {
        Row(Modifier.fillMaxWidth().testTag("$tag:resolved").padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(R.drawable.ic_x_circle), null, Modifier.size(16.dp), tint = secondary)
            Text(SettingsChangeCopy.declined, Modifier.testTag("$tag:outcome"), style = MaterialTheme.typography.bodySmall)
        }
        return
    }
    val scope = rememberCoroutineScope()
    val account by store.account.collectAsState()
    LaunchedEffect(request.id) { store.loadAccount() }
    var busy by remember(request.id) { mutableStateOf(false) }
    var undone by remember(request.id) { mutableStateOf(false) }
    var failure by remember(request.id) { mutableStateOf<String?>(null) }
    val undo = SettingsFromConversation.undoBody(request, account)
    Row(Modifier.fillMaxWidth().testTag("$tag:resolved").padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(SettingsChangeCopy.changed(SettingsFromConversation.entries(request.payload).size), Modifier.testTag("$tag:outcome"),
            style = MaterialTheme.typography.bodySmall)
        if (undone) {
            Text("·", color = secondary)
            Text(SettingsChangeCopy.undone, Modifier.testTag("$tag:undone"), style = MaterialTheme.typography.bodySmall, color = secondary)
        } else if (undo.isNotEmpty()) {
            Text("·", color = secondary)
            TextButton(onClick = {
                busy = true; failure = null
                scope.launch { failure = store.undoSettings(undo); undone = failure == null; busy = false }
            }, Modifier.testTag("$tag:undo"), enabled = !busy, contentPadding = PaddingValues(horizontal = 4.dp)) { Text(SettingsChangeCopy.undo) }
        }
        failure?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
    }
}

/** An `orbit-settings:<key>` link on a line of its own, drawn as the Open in Settings row (board 2 frame ③): the setting's title,
 * where it is, and a button that opens Settings at that row. */
@Composable
fun SettingsLinkRow(place: SettingPlace, open: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().testTag("settings-link:${place.key}").background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
        .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.25f), RoundedCornerShape(10.dp)).padding(horizontal = 11.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(place.title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
            Text(SettingsFromConversation.pathLabel(place), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        OutlinedButton(onClick = { open("orbit-settings:${place.key}") }, Modifier.testTag("settings-link-open")) { Text(SettingsChangeCopy.openInSettings) }
    }
}

/** The grey line a Settings row draws under itself when its setting was last changed from a conversation (§8.2):
 * `Turned on from <conversation> · 2m ago · Undo`, in the description's grey. [write] is the page's own preference write. */
@Composable
fun SettingChangedLine(key: String, user: JsonObject?, write: (String, JsonPrimitive) -> Unit) {
    val mark = SettingsFromConversation.changedBy(user)[key] ?: return
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 8.dp).testTag("setting-changed-$key"), verticalAlignment = Alignment.CenterVertically) {
        Text(SettingsFromConversation.changedLine(mark), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(SettingsChangeCopy.undo, Modifier.testTag("setting-changed-undo-$key").clickable { write(key, (mark.from as? JsonPrimitive) ?: JsonNull) },
            style = MaterialTheme.typography.bodySmall.copy(textDecoration = TextDecoration.Underline), color = MaterialTheme.colorScheme.primary)
    }
}

/** The Settings row `orbit-settings:` asked for (`route.recordId` of the Settings route): the page scrolls to it and flashes it. */
val LocalSettingsAnchor = compositionLocalOf<String?> { null }

/** A Settings row the `orbit-settings:` link can scroll to: named by its key, tinted while it is the one asked for. */
@Composable
fun Modifier.settingRow(key: String): Modifier {
    val asked = LocalSettingsAnchor.current == key
    val requester = remember { BringIntoViewRequester() }
    var flash by remember { mutableStateOf(asked) }
    if (asked) LaunchedEffect(key) {
        // Let the page land before it scrolls, and leave the flash on long enough to be seen.
        delay(350); requester.bringIntoView(); delay(1800); flash = false
    }
    return this.bringIntoViewRequester(requester).background(if (flash) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f) else androidx.compose.ui.graphics.Color.Transparent)
}
