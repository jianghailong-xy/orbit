package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.reader.AttachedNoteCard
import io.orbitd.android.reader.personWords
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@Composable
internal fun TranscriptCardView(card: InteractionCard, open: (String) -> Unit, event: RunEvent? = null) {
    val ts = event?.ts
    // A review's two turns are drawn as their own cards (A08-1), not as a list of their fields.
    if (card.family == CardFamily.REVIEW && (card.key.endsWith(":confirmationReviewRequest") || card.key.endsWith(":confirmationReturn"))) {
        ReviewTurnCard(card, ts, open); return
    }
    // A background job's news or a wakeup coming due is a line in the agent's stream (A08-11), not a card of fields.
    if (card.family == CardFamily.BACKGROUND && card.key.endsWith(":wake")) {
        val fields = event?.fields
        val delivery = event?.turnId?.let { LocalSteerDeliveries.current[it] } ?: fields?.text("delivery")
        val undelivered = delivery == "failed"
        BackgroundWakeLine(card.source, ts, BackgroundWakeCard.steerReceipt(
            BackgroundWakeCard.steerState(fields?.get("steer") == JsonPrimitive(true), delivery, undelivered)), undelivered)
        return
    }
    // The owner's answer handed to the coordinator is one line that opens to the words the agent read, not a card of fields.
    if (card.key.endsWith(":ownerAnswer")) {
        OwnerAnswerLineView(card, event); return
    }
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

/**
 * The owner's answer handed to the coordinator (`OwnerAnswerLine`): one line, "Sent to the coordinator · 08:29" — the pill a revision handed to
 * its coordinator leaves (`SentToCoordinatorLine`) — in place of the owner's own bubble, which asked the question a second time in the
 * reader's name. Pressing it opens the words the agent read (web `OwnerAnswerLine.tsx`, iOS `OwnerAnswerLineView`).
 */
@Composable
internal fun OwnerAnswerLineView(card: InteractionCard, event: RunEvent?) {
    var open by rememberSaveable(card.key) { mutableStateOf(false) }
    val undelivered = event?.fields?.text("delivery") in setOf("failed", "unconfirmed")
    val tone = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag(card.key), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClickLabel = OwnerAnswerLine.told) { open = true }.padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("→", Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.labelMedium, color = tone)
            Text(OwnerAnswerLine.line(card.source), style = MaterialTheme.typography.labelMedium, color = tone)
            Text("›", Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.labelMedium, color = tone)
        }
        if (undelivered) Text(OwnerAnswerLine.undelivered, style = MaterialTheme.typography.labelSmall, color = LocalOrbitColors.current.needsYou)
    }
    if (open) OwnerAnswerTold(card, event) { open = false }
}

/** What the coordinator was told: the line it was sent as, then its words verbatim, and what delivery appended folded under them. */
@Composable
private fun OwnerAnswerTold(card: InteractionCard, event: RunEvent?, close: () -> Unit) {
    val words = event?.personWords().orEmpty()
    val note = event?.fields?.text("controlPlaneNote")?.takeIf { it.isNotBlank() }
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) {
            Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState()).testTag("${card.key}:told"),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(OwnerAnswerLine.told, style = MaterialTheme.typography.titleSmall)
                    TextButton(onClick = close) { Text("Close") }
                }
                Text(OwnerAnswerLine.line(card.source), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                SelectionContainer { Text(words, style = MaterialTheme.typography.bodyMedium) }
                note?.let { AttachedNoteCard(it.trim()) }
            }
        }
    }
}
