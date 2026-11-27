package io.orbitd.android.reader

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.cards.BackgroundWakeLine
import io.orbitd.android.core.cards.BgJob
import io.orbitd.android.core.cards.SubagentFinished
import io.orbitd.android.cards.LocalAnsweredQuestions
import io.orbitd.android.cards.OwnerAnswerLineView
import io.orbitd.android.cards.QueuedFoot
import io.orbitd.android.cards.TranscriptCardView
import io.orbitd.android.cards.WatchWakeLine
import io.orbitd.android.composer.ComposerModel
import io.orbitd.android.composer.CoordinatorHandoff
import io.orbitd.android.composer.StagedAttachment
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
    val translation: Translation.Turn? = null,
    /** A SubAgent's end the queue will deliver: its block, which each run's card says is waiting (web `queuedSubagentWake`). */
    val subagent: SubagentFinished? = null,
    /** The bg_run jobs whose news the queue will deliver, which each job's card says is waiting (web `queuedJobWake`); [wake] then holds
     * only the wakeups that came due beside them. */
    val jobIds: List<String> = emptyList()) {
    /** The reader's own words still on their way — queued for the next turn, or a steer no runner has taken yet — which the tray above
     * the composer holds instead of the tail (docs/mocks/steer-tray; web `inPendingTray`, OrbitKit `PendingTray.holds`). */
    val inTray: Boolean get() = readersOwn && delivery == null && translation?.held != true
    val cancelable: Boolean get() = turnId != null && !steer && delivery == null
    /** Still waiting for a turn of its own — not a steer, nor one whose delivery settled: what a runner's update holds, so its queue line
     * says so (docs/mocks/queued-card-runner-updating ②⑤; web `queuedTurnWaitsItsTurn`, OrbitKit `RunnerUpdating.holdsQueued`). */
    val heldByUpdate: Boolean get() = !steer && delivery == null
    val key: String get() = "queued:" + (turnId?.let { ObjectId.canonical(it) ?: it } ?: event.fields.text("text").hashCode().toString())
}

/** Whether the tail draws a queued turn: not a SubAgent's end or a job's news alone, each of which waits on its card instead (web
 * `queuedSubagentWake().alone`, `queuedJobWake().alone`). A wakeup that came due beside them keeps its line. */
internal fun QueuedTurn.inTail(): Boolean = (subagent == null && jobIds.isEmpty()) || wake != null

/**
 * The background jobs' wakes still on the queue, by job id: each job's card says the agent has not read it yet, and its `Don't send` does
 * what the tail's Cancel did (board E1, web `jobQueuedWakes`) — null while [cancelEnabled] is false. A steer is on its way into the running
 * turn and cannot be withdrawn: it has no entry.
 */
internal fun jobQueuedWakes(queued: List<QueuedTurn>, cancelEnabled: Boolean, cancel: (String) -> Unit): Map<String, (() -> Unit)?> =
    buildMap {
        queued.forEach { turn ->
            if (turn.steer || turn.jobIds.isEmpty() || !turn.cancelable) return@forEach
            val dontSend: (() -> Unit)? = if (cancelEnabled) ({ cancel(turn.turnId!!) }) else null
            turn.jobIds.forEach { put(it, dontSend) }
        }
    }

/**
 * The SubAgent end turns still on the queue, by run id: each run's card says the agent has not read it yet, and its `Don't send` does what
 * the tail's Cancel did — null where the turn cannot be taken off the queue (a steer, or while [cancelEnabled] is false).
 */
internal fun subagentQueuedWakes(queued: List<QueuedTurn>, cancelEnabled: Boolean, cancel: (String) -> Unit): Map<String, (() -> Unit)?> =
    buildMap {
        queued.forEach { turn ->
            val wake = turn.subagent ?: return@forEach
            val dontSend: (() -> Unit)? = if (turn.cancelable && cancelEnabled) ({ cancel(turn.turnId!!) }) else null
            wake.runs.forEach { put(it.runId, dontSend) }
        }
    }

/** The queue as the composer's list holds it: every row still waiting, in the listing's order, except one whose echo the window
 * already holds (delivered between the echo and the queue's own re-read) and a receipt or an accepted head. The transcript's tail
 * draws the ones the tray does not hold ([QueuedTurn.inTray]). */
internal fun queuedTail(rows: List<JsonObject>, events: List<RunEvent>): List<QueuedTurn> {
    val delivered = events.filter { it.type == "user" }.mapNotNull { it.turnId }
    return rows.mapNotNull { row ->
        if (row.isReceipt() || row.text("placement") == "accepted" || row.isHandoffNotePrompt()) return@mapNotNull null
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
    val news = io.orbitd.android.core.cards.queuedWake(content)
    // A job's news draws nothing in the tail (its card says it is waiting): only a wakeup coming due beside it keeps its line.
    val wake = BgJob.wakeupsOnly(news)
    val jobIds = news?.let(BgJob::jobIds).orEmpty()
    val subagent = SubagentFinished.parse(content)
    val orbits = row["authoredByOrbit"] == JsonPrimitive(true) || SteerDelivery.cardKeys.any { row[it] != null && row[it] != JsonNull }
    return QueuedTurn(turnId, row.text("kind") == "steer", event, cards, wake, cards.firstOrNull { it.key.endsWith(":watch") }?.source,
        shell = row.text("kind") == "shell", createdAt = row.text("createdAt"),
        readersOwn = turnId != null && !orbits && cards.isEmpty() && news == null && subagent == null,
        delivery = row.text("delivery"), deliveryCode = row.text("deliveryCode"), deliveryReason = row.text("deliveryReason"),
        translation = Translation.turn(row["translation"]), subagent = subagent, jobIds = jobIds)
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
        if (row.text("placement") != "accepted" || row.text("kind") == "shell" || row.isReceipt() || row.isHandoffNotePrompt()) return@mapNotNull null
        val turnId = row.text("turnId") ?: return@mapNotNull null
        if (done.any { ObjectId.same(it, turnId) }) return@mapNotNull null
        RunEvent("user", 0, echoPayload(row), turnId, row.text("createdAt"))
    }
}

/** The accepted head a full runner, run or batch (or a runner's update) holds, still the reader's to take back: its turn and the words
 * Cancel returns to the composer — the translation's original when there is one, as the reader typed them. */
internal data class HeldCancel(val turnId: String, val words: String)

/**
 * The message under the held tag when it is the accepted head — the last one, no runner's echo yet (web `cancellableHeldTurn`): Cancel
 * beside `Queued · runner full` withdraws it. Never the session's opening prompt (the listing's `opening`), which the server keeps.
 */
internal fun cancellableHeldTurn(rows: List<JsonObject>, events: List<RunEvent>): HeldCancel? {
    val turnId = acceptedHeads(rows, events).lastOrNull()?.turnId ?: return null
    val row = rows.firstOrNull { it.text("placement") == "accepted" && it.text("turnId")?.let { id -> ObjectId.same(id, turnId) } == true }
        ?: return null
    if (row["opening"] == JsonPrimitive(true)) return null
    return HeldCancel(turnId, Translation.turn(row["translation"])?.original ?: row.text("content").orEmpty())
}

/** The platform's turn asking a coordinator for its handoff note (board 02 ②): Orbit's, drawn only as the handoff's own row — never
 * as a queued card or an accepted head (web `queuedTurnsOutsideTranscript`, OrbitKit `PendingTray`). The listing carries no turn key,
 * so it is told by its first line, as the transcript tells its echo. */
private fun JsonObject.isHandoffNotePrompt() = CoordinatorHandoff.isNotePrompt(text("content"))

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
    // The session's opening prompt, which the server never lets be withdrawn ([cancelHeldMessage]).
    row["opening"]?.let { put("opening", it) }
    if (row.text("kind") == "steer") put("steer", true)
}

/** Said when that Cancel's DELETE fails (web `cancelTurn`). */
internal const val COULDNT_CANCEL_MESSAGE = "Couldn't cancel the message"

/**
 * Cancel on a message held because its translation failed (web `cancelTurn`): withdrawn as the tray's Withdraw does, and what the
 * owner wrote — the translation's original, a `!cmd` as the command, with its files — back in the composer. Null without a composer
 * or a turn to name, and for the session's opening prompt, which the server keeps.
 */
internal fun cancelHeldMessage(composer: ComposerModel?, event: RunEvent, shell: Boolean = false): (() -> Unit)? {
    val turnId = event.turnId
    if (composer == null || turnId == null || event.fields["opening"] == JsonPrimitive(true)) return null
    val body = Translation.turn(event.fields["translation"])?.original?.takeIf { it.isNotBlank() } ?: event.fields.text("text").orEmpty()
    val files = event.fields.objects("attachments").mapNotNull { file ->
        file.text("id")?.let { StagedAttachment(it, file.text("name") ?: "Attachment", file.text("mime") ?: "application/octet-stream") }
    }
    return { composer.cancelHeld(turnId, if (shell && body.isNotBlank()) "!$body" else body, files) }
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
            // A SubAgent's end and a job's news wait on their cards instead ([subagentQueuedWakes], [jobQueuedWakes]): the tail draws
            // only a wakeup written beside them.
            turn.subagent != null || turn.jobIds.isNotEmpty() -> turn.wake?.let { BackgroundWakeLine(it, null, steerState = if (turn.steer) "Sending…" else null,
                queued = turn.cancelable, onCancelQueued = withdraw) }
            turn.wake != null -> BackgroundWakeLine(turn.wake, null, steerState = if (turn.steer) "Sending…" else null, queued = turn.cancelable,
                onCancelQueued = withdraw)
            // A watch's wake waiting for a runner (A08-14): its line, dashed, and the queue's own line, which asks before it withdraws.
            turn.watch != null -> WatchWakeLine(turn.watch, null, open, queued = turn.cancelable, onWithdraw = withdraw)
            handover != null -> {
                turn.cards.forEach { card ->
                    if (card === handover) OwnerAnswerLineView(card, turn.event, queued = turn.delivery == null, openLink = open) else TranscriptCardView(card, open, turn.event)
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
                UserTurnColumn {
                    QueuedAttachments(turn, open)
                    turn.translation.original.takeIf { it.isNotBlank() }?.let { UserWordsBubble(it, null, open) }
                    UserTranslationFoot(turn.translation, flipped = false, onFlip = {},
                        retry = doors?.let { { it.translationAction("turns/${turn.turnId}/translation/retry") } },
                        sendAsWritten = doors?.let { { it.translationAction("turns/${turn.turnId}/translation/send-as-written") } },
                        cancel = cancelHeldMessage(doors, turn.event, turn.shell))
                }
            }
            // The reader's own message, drawn as its sent turn will be (iOS `UserBubbleView`), the queue's line under it.
            else -> UserTurnColumn {
                QueuedAttachments(turn, open)
                turn.event.fields.text("text")?.takeIf { it.isNotBlank() }?.let { UserWordsBubble(it, null, open) }
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
    val atts = turn.event.fields.objects("attachments").mapNotNull { a ->
        a.text("id")?.let { id -> Triple("orbit-attachment:$id", a.text("name") ?: "Attachment", a.text("mime")?.startsWith("image/") == true) }
    }
    UserTurnAttachments(atts.filter { it.third }.map { it.first to it.second }, atts.filterNot { it.third }.map { it.first to it.second }, open)
}
