package io.orbitd.android.management

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import io.orbitd.android.ui.LocalOrbitColors
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.WorkspaceLandingWords as Words
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.cards.LocalSettingsAnchor
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The workspace's landing setting (docs/mocks/protected-branch-landing, option A, owner 2026-11-23): a "Landing" section with both
 * choices as full-width rows, so "faster" and "needs the right to push" sit side by side. [workspace] is `GET /workspaces/:id`; a
 * choice is saved at once with `PATCH { landingMode }` and read back, as the web's section does.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun WorkspaceLandingSetting(api: ManagementApi, workspaceId: String, workspace: JsonObject, open: (OrbitRoute) -> Unit,
    changed: () -> Unit, onFailure: (Throwable) -> Unit) {
    val landing = workspace.obj("landing") ?: return
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var mode by remember(workspaceId) { mutableStateOf(landing.text("mode")) }
    var saving by remember { mutableStateOf(false) }
    if (mode == null) {
        FormSection(Words.SECTION) { Text(Words.NOT_GITHUB, Modifier.padding(vertical = 12.dp).testTag("landing-setting:not-github"),
            style = MaterialTheme.typography.bodyMedium, color = Ink.muted) }
        return
    }
    val push = landing.obj("pushAsMe")
    val pushDisabled = (push?.get("available") as? kotlinx.serialization.json.JsonPrimitive)?.content == "false"
    val refusal = landing.obj("lastRefusal")?.takeIf { mode == "PUSH_AS_ME" }
    val pending = landing.obj("permissionsPending")
    fun choose(next: String) {
        if (saving || next == mode) return
        val before = mode
        mode = next; saving = true
        scope.launch {
            try { api.patch("workspaces/$workspaceId", buildJsonObject { put("landingMode", next) }); changed() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { mode = before; onFailure(e) }
            finally { saving = false }
        }
    }
    // A link to the Landing section (`recordId == "landing"`, the web's #landing) opens the page scrolled to it.
    val requester = remember { BringIntoViewRequester() }
    val anchored = LocalSettingsAnchor.current == "landing"
    LaunchedEffect(anchored) { if (anchored) { kotlinx.coroutines.delay(100); requester.bringIntoView() } }
    Box(Modifier.bringIntoViewRequester(requester)) { FormSection(Words.SECTION) {
        Text(Words.LEAD, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodyMedium, color = Ink.muted)
        Column(Modifier.selectableGroup().testTag("landing-setting")) {
            Choice("PULL_REQUEST", Words.PULL_REQUEST, Words.DEFAULT, Words.PULL_REQUEST_BODY, mode == "PULL_REQUEST", !saving) { choose("PULL_REQUEST") }
            HorizontalDivider()
            Choice("PUSH_AS_ME", Words.PUSH_AS_ME, Words.FASTER, Words.PUSH_AS_ME_BODY, mode == "PUSH_AS_ME", !saving && !pushDisabled,
                extra = if (landing.obj("pushAsMe")?.text("reason") == "GITHUB_NOT_CONNECTED") ({
                    Text(Words.NOT_CONNECTED, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                    TextButton(onClick = { open(OrbitRoute(Destination.SETTINGS, "github")) }, modifier = Modifier.testTag("landing-setting:connect")) {
                        Text(Words.CONNECT, fontWeight = FontWeight.SemiBold) }
                }) else null) { choose("PUSH_AS_ME") }
        }
        pending?.let {
            Notice("permissions-pending", Words.permissionsText(it.text("account").orEmpty()), null, Words.REVIEW, { it.text("reviewUrl")?.let(uri::openUri) })
        }
        refusal?.let {
            Notice("refused", Words.refusalText(it.text("branch").orEmpty(), Words.repoSlug(workspace.text("repoUrl")), it.text("message").orEmpty()),
                Words.REFUSED, Words.CONNECT_AGAIN, { open(OrbitRoute(Destination.SETTINGS, "github")) })
        }
    } }
}

@Composable
private fun Choice(value: String, name: String, badge: String, body: String, selected: Boolean, enabled: Boolean,
    extra: (@Composable ColumnScope.() -> Unit)? = null, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().selectable(selected, enabled, Role.RadioButton, onClick = onClick).padding(vertical = 10.dp).testTag("landing-setting:$value"),
        verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        RadioButton(selected, onClick = null, enabled = enabled)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(name, fontWeight = FontWeight.SemiBold)
                Text(badge, Modifier.testTag("landing-setting:$value:badge"), style = MaterialTheme.typography.labelMedium, color = Ink.muted)
            }
            Text(body, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            extra?.invoke(this)
        }
    }
}

/** The amber notice box of the board (web `landing-setting-notice`): warning wash and border, warning ink, a bold lead where there is one,
 * and the link inside the box. */
@Composable
private fun Notice(tag: String, text: String, lead: String?, action: String, onAction: () -> Unit) {
    val warning = LocalOrbitColors.current.needsYou
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp).background(warning.copy(alpha = 0.1f), shape).border(1.dp, warning.copy(alpha = 0.4f), shape)
        .padding(horizontal = 12.dp, vertical = 8.dp).testTag("landing-setting:$tag")) {
        Text(buildAnnotatedString {
            if (lead != null) { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(lead) }; append(' ') }
            append(text)
        }, style = MaterialTheme.typography.bodySmall, color = warning)
        TextButton(onClick = onAction, modifier = Modifier.testTag("landing-setting:$tag:action")) { Text(action, fontWeight = FontWeight.SemiBold, color = warning) }
    }
}
