package io.orbitd.android.reader

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.cards.BackgroundWakeLine
import io.orbitd.android.cards.QueuedFoot
import io.orbitd.android.cards.TranscriptCardView
import io.orbitd.android.cards.dashedBorder
import io.orbitd.android.core.cards.InteractionCard
import io.orbitd.android.core.cards.objects
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.text.MarkdownText
import kotlinx.serialization.json.*

/**
 * One turn still waiting in this conversation's queue, drawn at the end of the transcript as the turn it will become (A08-4; iOS
 * f350ee7a1, 52819d05c `UserTurnRow` with `QueuedControls`): its event is the echo it will be delivered as — the listing's `content`
 * as its text, and every card the listing carries — so a session reply is its reply cards and a resumed task's brief its task-start
 * card, not the blocks they are delivered with. A steer and a turn the server has not named yet take no Cancel.
 */
internal data class QueuedTurn(val turnId: String?, val steer: Boolean, val event: RunEvent, val cards: List<InteractionCard>,
    val wake: JsonObject?) {
    val cancelable: Boolean get() = turnId != null && !steer
    val key: String get() = "queued:" + (turnId?.let { ObjectId.canonical(it) ?: it } ?: event.fields.text("text").hashCode().toString())
}

/** The card keys a queued turn carries, the same ones its echo will (`TurnCards`). */
private val cardKeys = listOf("openItemDelivery", "ownerAnswer", "taskStart", "projectStarted", "confirmationReviewRequest",
    "confirmationReturn", "sessionMessage", "sessionReplies")

/** The queue as the transcript's tail draws it: every row still waiting, in the listing's order, except one whose echo the window
 * already holds (delivered between the echo and the queue's own re-read) and a receipt or an accepted head. */
internal fun queuedTail(rows: List<JsonObject>, events: List<RunEvent>): List<QueuedTurn> {
    val delivered = events.filter { it.type == "user" }.mapNotNull { it.turnId }
    return rows.mapNotNull { row ->
        if (row["delivery"] != null && row["delivery"] != JsonNull || row.text("placement") == "accepted") return@mapNotNull null
        val turnId = row.text("turnId")
        if (turnId != null && delivered.any { ObjectId.same(it, turnId) }) return@mapNotNull null
        val content = row.text("content").orEmpty()
        val payload = buildJsonObject {
            put("text", content)
            putJsonArray("attachments") {
                row.objects("attachments").forEach { attachment -> addJsonObject {
                    attachment.text("id")?.let { put("id", it) }; attachment.text("mimeType")?.let { put("mime", it) }
                    attachment.text("name")?.let { put("name", it) }
                } }
            }
            cardKeys.forEach { key -> row[key]?.takeIf { it != JsonNull }?.let { put(key, it) } }
            if (row.text("kind") == "steer") put("steer", true)
        }
        val event = RunEvent("user", 0, payload, turnId)
        QueuedTurn(turnId, row.text("kind") == "steer", event, transcriptCards(event), io.orbitd.android.core.cards.queuedWake(content))
    }
}

/** One queued turn at the transcript's end: its card (dashed while it can still be withdrawn), its reply cards, its wake's line, or its
 * words — then the queue's own line: "Queued" and "Cancel", or, for a steer on its way into the running turn, how far it got. */
@Composable
internal fun QueuedTurnRow(turn: QueuedTurn, open: (String) -> Unit, cancelEnabled: Boolean, cancel: (String) -> Unit) {
    val withdraw: (() -> Unit)? = if (turn.cancelable && cancelEnabled) ({ cancel(turn.turnId!!) }) else null
    val foot = @Composable { if (withdraw != null) QueuedFoot(cancel = withdraw) else if (turn.steer) SteerLine() }
    Column(Modifier.fillMaxWidth().testTag(turn.key), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when {
            turn.wake != null -> BackgroundWakeLine(turn.wake, null, steerState = if (turn.steer) "Sending…" else null, queued = turn.cancelable,
                onCancelQueued = withdraw)
            turn.cards.any { it.key.contains(":reply:") } -> {
                // A session's reply: its reply cards, solid, and one queue line under them all.
                turn.cards.forEach { TranscriptCardView(it, open, turn.event) }
                foot()
            }
            turn.cards.isNotEmpty() -> {
                // A resumed task's brief, a project's start, an item or a message from another session: the card it will be, dashed
                // while it is still the queue's to withdraw.
                Box(if (turn.cancelable) Modifier.dashedBorder(MaterialTheme.colorScheme.primary.copy(alpha = 0.28f)) else Modifier) {
                    Column(Modifier.padding(if (turn.cancelable) 2.dp else 0.dp)) { turn.cards.forEach { TranscriptCardView(it, open, turn.event) } }
                }
                QueuedAttachments(turn, open)
                foot()
            }
            else -> {
                Text("You", style = MaterialTheme.typography.labelMedium)
                turn.event.fields.text("text")?.takeIf { it.isNotBlank() }?.let { MarkdownText(it, open = open) }
                QueuedAttachments(turn, open)
                foot()
            }
        }
    }
}

@Composable
private fun SteerLine() = Text("Sending…", Modifier.testTag("queued-steer"), style = MaterialTheme.typography.labelSmall,
    color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun QueuedAttachments(turn: QueuedTurn, open: (String) -> Unit) {
    turn.event.fields.objects("attachments").forEach { attachment ->
        attachment.text("id")?.let { id -> TextButton(onClick = { open("orbit-attachment:$id") }) { Text(attachment.text("name") ?: "Attachment") } }
    }
}
