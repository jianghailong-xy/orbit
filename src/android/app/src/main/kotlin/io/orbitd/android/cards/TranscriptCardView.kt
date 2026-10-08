package io.orbitd.android.cards

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.text.LocalReaderResources
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

@Composable
internal fun TranscriptCardView(card: InteractionCard, open: (String) -> Unit) {
    val resources = LocalReaderResources.current
    val app = LocalContext.current.applicationContext as? OrbitApplication
    val live = app?.realtime?.state?.collectAsState()?.value
    val authorized = resources != null && live?.handle === resources.handle && live?.session?.id == resources.sessionId && live?.session?.fresh == true && live?.session?.accessDenied == false
    var request by remember(card.key) { mutableStateOf<JsonObject?>(null) }
    var unread by remember(card.key) { mutableStateOf(false) }
    val requestId = card.source.text("requestId").takeIf { card.key.endsWith(":sessionMessage") }
    LaunchedEffect(resources, requestId, authorized, live?.invalidationRevision) {
        if (!authorized || requestId == null) { unread = requestId != null; return@LaunchedEffect }
        try { request = CardAuthority(resources!!.auth, resources.handle).get(listOf("session-requests", requestId)) as? JsonObject; unread = false }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { request = null; unread = true }
    }
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.secondaryContainer) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(card.title, style = MaterialTheme.typography.titleSmall)
            Text("Recorded by Orbit", style = MaterialTheme.typography.labelSmall)
            CardFields(card.source, listOf("title", "projectTitle", "fromTitle", "preview", "requestPreview", "description", "acceptanceCriteria",
                "completionCriterion", "reason", "problems", "report", "dueAt", "branch", "sha", "task", "files", "check", "failure", "settings",
                "differsFromRequest", "startedAt", "outcome", "replyOptionLabel", "replyText", "excerpt", "closeReason", "closedAt", "status", "command", "outputTail", "progress", "state", "generation", "changedTargets", "jobs", "wakeups"), open)
            if (requestId != null) {
                Text("The recipient session answers this request.", style = MaterialTheme.typography.bodySmall)
                if (unread) Text("Current request state unavailable · reconnect to check.")
                else request?.let { CardFields(it, listOf("state", "replyOptions", "replyBy", "replyText", "excerpt", "closeReason"), open) }
            }
            listOf("fromSessionId" to "Open sender session", "runSessionId" to "Open task session", "reviewerSessionId" to "Open reviewer session").forEach { (field, label) ->
                card.source.text(field)?.let { LinkButton(label, "orbit-session:$it", open) }
            }
            if (card.source.text("taskId") != null || card.source.text("projectId") != null) {
                Text("Task and project details are not connected yet.", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
