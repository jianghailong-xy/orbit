package io.orbitd.android.reader

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.cards.BackgroundWakeLine
import io.orbitd.android.cards.LocalAnsweredQuestions
import io.orbitd.android.cards.OwnerAnswerLineView
import io.orbitd.android.cards.QueuedFoot
import io.orbitd.android.cards.TranscriptCardView
import io.orbitd.android.cards.WatchWakeLine
import io.orbitd.android.cards.dashedBorder
import io.orbitd.android.core.cards.InteractionCard
import io.orbitd.android.core.cards.objects
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.core.translation.Translation
import io.orbitd.android.translation.UserTranslationFoot
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.text.MarkdownText
import kotlinx.serialization.json.*

/**
 * One turn still waiting in this conversation's queue, drawn at the end of the transcript as the turn it will become (A08-4; iOS
 * f350ee7a1, 52819d05c `UserTurnRow` with `QueuedControls`): its event is the echo it will be delivered as — the listing's `content`
 * as its text, and every card the listing carries — so a session reply is its reply cards and a resumed task's brief its task-start
 * card, not the blocks they are delivered with. A steer and a turn the server has not named yet take no Cancel.
 *
 * [readersOwn]: the reader's own words, named by their turn (web `returnsToComposer`) — not what Orbit queued: a brief, a delivery,
 * another session's message, a wake, which keeps its card in the tail. [shell] is a `!cmd`, [createdAt] when the server filed it.
 * [delivery], with its [deliveryCode] and [deliveryReason]: the server's durable receipt that a steer was not delivered (`failed`) or
 * not known to be read (`unconfirmed`) — over, and no turn of the queue's. [translation]: Settings › Translation's state of the owner's
 * message; one still held for it (translating, or failed — 1A) is drawn here in the conversation with its chip or its way out, never in
 * the tray (board frame 6, web `inPendingTray`).
 */
internal data class QueuedTurn(val turnId: String?, val steer: Boolean, val event: RunEvent, val cards: List<InteractionCard>,
    val wake: JsonObject?, val watch: JsonObject? = null, val shell: Boolean = false, val createdAt: String? = null,
    val readersOwn: Boolean = false, val delivery: String? = null, val deliveryCode: String? = null, val deliveryReason: String? = null,
    val translation: Translation.Turn? = null) {
    /** The reader's own words still on their way — queued for the next turn, or a steer no runner has taken yet — which the tray above
     * the composer holds instead of the tail (docs/mocks/steer-tray; web `inPendingTray`, OrbitKit `PendingTray.holds`). */
    val inTray: Boolean get() = readersOwn && delivery == null && translation?.held != true
    val cancelable: Boolean get() = turnId != null && !steer && delivery == null
    val key: String get() = "queued:" + (turnId?.let { ObjectId.canonical(it) ?: it } ?: event.fields.text("text").hashCode().toString())
}

/** The queue as the composer's list holds it: every row still waiting, in the listing's order, except one whose echo the window
 * already holds (delivered between the echo and the queue's own re-read) and a receipt or an accepted head. The transcript's tail
 * draws the ones the tray does not hold ([QueuedTurn.inTray]). */
internal fun queuedTail(rows: List<JsonObject>, events: List<RunEvent>): List<QueuedTurn> {
    val delivered = events.filter { it.type == "user" }.mapNotNull { it.turnId }
    return rows.mapNotNull { row ->
        if (row.isReceipt() || row.text("placement") == "accepted") return@mapNotNull null
        val turnId = row.text("turnId")
        if (turnId != null && delivered.any { ObjectId.same(it, turnId) }) return@mapNotNull null
        listedTurn(row)
    }
}

/**
 * The reader's steers known only from the server's receipt not to have been delivered (web `queuedTurnsOutsideTranscript`): a receipt
 * of their own words whose turn the window holds no word of — no echo, which is drawn with how it came out instead, and no runner's
 * `user_delivery` that it failed or went unconfirmed. Drawn at the end of the queued tail, as the one place they are drawn at all. What
 * Orbit filed keeps showing what it showed: nothing.
 */
internal fun undeliveredTail(rows: List<JsonObject>, events: List<RunEvent>): List<QueuedTurn> {
    val spoken = events.mapNotNull { event ->
        when {
            event.type == "user" -> event.turnId
            event.type == "user_delivery" && SteerDelivery.undelivered(event.fields.string("delivery")) -> event.fields.string("turnId") ?: event.turnId
            else -> null
        }
    }
    return rows.mapNotNull { row ->
        val turnId = row.text("turnId")
        if (!row.isReceipt() || turnId == null || spoken.any { ObjectId.same(it, turnId) }) return@mapNotNull null
        listedTurn(row).takeIf { it.readersOwn }
    }
}

/** One row of the queue's listing as the turn it will be — or, for a receipt, the turn it was. */
private fun listedTurn(row: JsonObject): QueuedTurn {
    val turnId = row.text("turnId")
    val content = row.text("content").orEmpty()
    val event = RunEvent("user", 0, echoPayload(row), turnId)
    val cards = transcriptCards(event)
    val wake = io.orbitd.android.core.cards.queuedWake(content)
    val orbits = row["authoredByOrbit"] == JsonPrimitive(true) || SteerDelivery.cardKeys.any { row[it] != null && row[it] != JsonNull }
    return QueuedTurn(turnId, row.text("kind") == "steer", event, cards, wake, cards.firstOrNull { it.key.endsWith(":watch") }?.source,
        shell = row.text("kind") == "shell", createdAt = row.text("createdAt"),
        readersOwn = turnId != null && !orbits && cards.isEmpty() && wake == null,
        delivery = row.text("delivery"), deliveryCode = row.text("deliveryCode"), deliveryReason = row.text("deliveryReason"),
        translation = Translation.turn(row["translation"]))
}

/**
 * The accepted head (A07-14; iOS 0588fe262 `TranscriptState.accepted`): the turn a runner has taken, or is about to, whose echo has
 * not arrived — the listing's `placement` "accepted". Nothing withdraws it any more, so it is no row of the queue's: it is drawn where
 * its echo will land, as the echo will be drawn — the person's words, or the card it carries — stamped with when it was filed. Once
 * the window holds its echo, that is what is drawn, and its own turn_end ends it; a `!` command, which has no echo (the runner runs
 * it as a Bash card), and a delivery receipt are never one.
 */
internal fun acceptedHeads(rows: List<JsonObject>, events: List<RunEvent>): List<RunEvent> {
    val done = events.filter { it.type == "user" || it.type == "turn_end" }.mapNotNull { it.turnId }
    return rows.mapNotNull { row ->
        if (row.text("placement") != "accepted" || row.text("kind") == "shell" || row.isReceipt()) return@mapNotNull null
        val turnId = row.text("turnId") ?: return@mapNotNull null
        if (done.any { ObjectId.same(it, turnId) }) return@mapNotNull null
        RunEvent("user", 0, echoPayload(row), turnId, row.text("createdAt"))
    }
}

/** A steer's receipt that it never made it (`failed`, `unconfirmed`): over, and no turn of the tail's. */
private fun JsonObject.isReceipt() = this["delivery"] != null && this["delivery"] != JsonNull

/** The `user` event a listed turn will be delivered as: the listing's `content` as its text, its files, and every card it carries. */
private fun echoPayload(row: JsonObject) = buildJsonObject {
    put("text", row.text("content").orEmpty())
    putJsonArray("attachments") {
        row.objects("attachments").forEach { attachment -> addJsonObject {
            attachment.text("id")?.let { put("id", it) }; attachment.text("mimeType")?.let { put("mime", it) }
            attachment.text("name")?.let { put("name", it) }
        } }
    }
    SteerDelivery.cardKeys.forEach { key -> row[key]?.takeIf { it != JsonNull }?.let { put(key, it) } }
    // Who outside Orbit sent it, which the listing carries beside the cards (turn-cards.ts): the accepted head says what its echo will.
    row["externalSender"]?.takeIf { it != JsonNull }?.let { put("externalSender", it) }
    // And a translated message's own words and state, as the runner's echo will carry them (Settings › Translation).
    row["translation"]?.takeIf { it != JsonNull }?.let { put("translation", it) }
    if (row.text("kind") == "steer") put("steer", true)
}

/** One queued turn at the transcript's end: its card (dashed while it can still be withdrawn), its reply cards, its wake's line, or its
 * words — then the queue's own line: "Queued" and "Cancel", or, for a steer on its way into the running turn, how far it got. A steer
 * known only from its receipt says how it came out and why, with [putBack], its words' way back to the composer (web `QueuedTurnMeta`).
 * The owner's answer to a question the conversation holds is that question's card, which says it is queued itself, and has no Cancel:
 * the answer is given, and taking it off the queue would leave the coordinator never told (web `OwnerAnswerLine`). */
@Composable
internal fun QueuedTurnRow(turn: QueuedTurn, open: (String) -> Unit, cancelEnabled: Boolean, putBack: (() -> Unit)? = null,
    cancel: (String) -> Unit) {
    val answered = LocalAnsweredQuestions.current
    val handover = turn.cards.firstOrNull { it.key.endsWith(":ownerAnswer") && answered?.record(it.source) != null }
    val withdraw: (() -> Unit)? = if (turn.cancelable && cancelEnabled && handover == null) ({ cancel(turn.turnId!!) }) else null
    val foot = @Composable {
        if (turn.delivery != null) SteerStateLine(SteerOutcome(turn.delivery, turn.deliveryReason),
            why = SteerDelivery.failureExplanation(turn.deliveryCode, turn.deliveryReason), putBack = putBack)
        else if (withdraw != null) QueuedFoot(cancel = withdraw) else if (turn.steer) SteerLine()
    }
    Column(Modifier.fillMaxWidth().testTag(turn.key), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when {
            turn.wake != null -> BackgroundWakeLine(turn.wake, null, steerState = if (turn.steer) "Sending…" else null, queued = turn.cancelable,
                onCancelQueued = withdraw)
            // A watch's wake waiting for a runner (A08-14): its line, dashed, and the queue's own line, which asks before it withdraws.
            turn.watch != null -> WatchWakeLine(turn.watch, null, open, queued = turn.cancelable, onWithdraw = withdraw)
            handover != null -> {
                turn.cards.forEach { card ->
                    if (card === handover) OwnerAnswerLineView(card, turn.event, queued = turn.delivery == null) else TranscriptCardView(card, open, turn.event)
                }
                foot()
            }
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
            // The owner's message held for its translation (board frame 6): what they wrote, and the chip or the way out of a failure.
            turn.translation?.held == true && turn.turnId != null -> {
                val doors = LocalSessionConsole.current?.composer
                Text("You", style = MaterialTheme.typography.labelMedium)
                turn.translation.original.takeIf { it.isNotBlank() }?.let { MarkdownText(it, open = open) }
                QueuedAttachments(turn, open)
                UserTranslationFoot(turn.translation, flipped = false, onFlip = {},
                    retry = doors?.let { { it.translationAction("turns/${turn.turnId}/translation/retry") } },
                    sendAsWritten = doors?.let { { it.translationAction("turns/${turn.turnId}/translation/send-as-written") } })
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
