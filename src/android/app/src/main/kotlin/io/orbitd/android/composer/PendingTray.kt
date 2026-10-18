package io.orbitd.android.composer

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.attachments.decodeAttachmentImage
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.reader.QueuedTurn
import io.orbitd.android.reader.SteerDelivery
import io.orbitd.android.reader.UnreadSteer
import io.orbitd.android.reader.personWords
import io.orbitd.android.text.LocalReaderResources
import java.io.ByteArrayInputStream
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** One row of the tray above the composer: a message the reader sent that nothing has read yet (docs/mocks/steer-tray, decided
 * 2026-10-16; OrbitKit `PendingTrayRow`, web `PendingTray.tsx`). */
@Immutable
internal data class PendingTrayRow(
    val turnId: String,
    /** Where it is going: into the turn running now (a steer, ↳), or the next turn. */
    val intoTurn: Boolean,
    /** What the row says: the reader's words, a `!cmd` as the command, or what a message of attachments alone carries ("1 image"). */
    val text: String,
    /** No words of its own: the row says what it carries, in the quieter tone. */
    val filesOnly: Boolean,
    val shell: Boolean,
    /** Its first picture, by attachment id: the row's thumbnail. */
    val image: String?,
    /** How it stands: Sending…, Waiting to be read, Withdrawing…, Queued for next turn. */
    val state: String,
    /** A press for it is out: the row dims and offers nothing to press twice. */
    val busy: Boolean,
    /** Withdraw: taken back, its words returned to the composer. Not where nothing can give it back (a Codex steer once Codex has it). */
    val offersWithdraw: Boolean,
    /** Steer: a queued message sent into the turn running now. */
    val offersSteer: Boolean,
    /** On its way into the turn, whoever holds it: a refused Withdraw is said as a steer's. */
    val steer: Boolean,
    /** What Withdraw hands back to the composer: the words as typed, a `!cmd` as the command; null for pictures and files alone. */
    val restores: String?,
    /** When it was sent; null for one this device sent a moment ago. */
    val at: String?,
)

/** The tray's rows and its words, which are the web's and iOS's. */
internal object PendingTray {
    const val LABEL = "Messages not read yet"
    const val QUEUED = "Queued for next turn"
    const val WITHDRAWING = "Withdrawing…"
    const val STEER = "Steer"
    const val STEER_HINT = "Send into the current turn now"
    const val WITHDRAW = "Withdraw"
    const val WITHDRAW_HINT = "Withdraw — back to the composer"
    const val QUEUE_FOR_NEXT_TURN = "Queue for next turn"
    const val STEER_REFUSED = "Couldn't send it into this turn"
    const val STEER_UNSUPPORTED = "This agent can't take a message mid-turn. It stays queued for the next turn."
    const val TURN_OVER = "The turn is over or being stopped. It stays queued for the next turn."
    const val TOO_LATE = "Too late to withdraw"
    const val COULDNT_WITHDRAW = "Couldn't withdraw the message"
    const val ALREADY_PROCESSING = "This message is already being processed and can't be withdrawn"
    const val INTO_TURN = "Into the current turn"
    const val NEXT_TURN = "Queued for the next turn"

    /** Why a Steer was refused, by the reason CURRENT_WORK_UNAVAILABLE carries: the agent, or the turn. */
    fun steerRefusal(reason: String?) = if (reason == "STEER_UNSUPPORTED") STEER_UNSUPPORTED else TURN_OVER

    /** A Withdraw that came too late: the engine read it first. */
    fun alreadyRead(engine: String) =
        "${when (engine) { ProviderEngines.CODEX -> "Codex"; ProviderEngines.CLAUDE -> "Claude"; else -> "The agent" }} has already read it."

    /**
     * The tray's rows, in the order they were sent (OrbitKit `PendingTray.rows`, web `pendingTrayRows`): the reader's steers nothing
     * has read ([unread], `SteerDelivery.place`) and their messages still on the queue ([queued]'s `inTray`). [state] holds the presses
     * out for each and what the server confirmed before anything else said so; [steerOffered], whether a turn is running on an engine
     * that can take a message into one.
     */
    fun rows(unread: List<UnreadSteer>, queued: List<QueuedTurn>, state: ComposerState, steerOffered: Boolean): List<PendingTrayRow> {
        fun asked(set: Set<String>, turnId: String) = (ObjectId.canonical(turnId) ?: turnId) in set
        val steers = unread.map { steer ->
            val turnId = steer.event.turnId!!
            // Missed the turn it was aimed at and handed back to run as the next one: queued now, and shortly the message that opens
            // that turn.
            val requeued = steer.delivery == SteerDelivery.REQUEUED
            val taking = asked(state.withdrawing, turnId)
            row(turnId, intoTurn = !requeued, steer.event.personWords().trim(), shell = false, steer.event.fields.objects("attachments"),
                if (taking) WITHDRAWING else if (requeued) QUEUED else SteerDelivery.label(steer.delivery), busy = taking,
                offersWithdraw = !taking && !requeued && SteerDelivery.offersWithdraw(steer.delivery, steer.withdrawable),
                offersSteer = false, steer = true, at = steer.event.ts)
        }
        val echoed = steers.map { ObjectId.canonical(it.turnId) ?: it.turnId }.toSet()
        val waiting = queued.filter { it.inTray && !asked(echoed, it.turnId!!) }.map { turn ->
            val turnId = turn.turnId!!
            val steering = asked(state.steering, turnId)
            val intoTurn = turn.steer || steering || asked(state.steered, turnId)
            val taking = asked(state.withdrawing, turnId)
            val busy = taking || steering
            row(turnId, intoTurn, turn.event.fields.text("text").orEmpty().trim(), turn.shell, turn.event.fields.objects("attachments"),
                if (taking) WITHDRAWING else if (intoTurn) SteerDelivery.label(null) else QUEUED, busy = busy,
                // Not handed to a runner yet, either way: the server takes it back alone.
                offersWithdraw = !busy, offersSteer = !busy && !intoTurn && !turn.shell && steerOffered, steer = intoTurn, at = turn.createdAt)
        }
        // A row this device just sent has no time yet: it is the newest. Stable for the rest.
        return (steers + waiting).filterNot { asked(state.withdrawn, it.turnId) }
            .sortedBy { row -> row.at?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: Long.MAX_VALUE }
    }

    /** What a row of pictures and files alone says instead of words: "1 image", "2 images, 1 file". */
    fun summary(images: Int, files: Int): String = listOfNotNull(
        if (images > 0) "$images image${if (images == 1) "" else "s"}" else null,
        if (files > 0) "$files file${if (files == 1) "" else "s"}" else null,
    ).joinToString(", ")

    private fun row(turnId: String, intoTurn: Boolean, words: String, shell: Boolean, attachments: List<JsonObject>, state: String,
        busy: Boolean, offersWithdraw: Boolean, offersSteer: Boolean, steer: Boolean, at: String?): PendingTrayRow {
        val images = attachments.filter { (it.text("mime") ?: it.text("mimeType"))?.startsWith("image/") == true }
        val said = words.takeIf { it.isNotEmpty() }?.let { if (shell) "!$it" else it }
        return PendingTrayRow(turnId, intoTurn, said ?: summary(images.size, attachments.size - images.size), said == null, shell,
            images.firstOrNull()?.text("id"), state, busy, offersWithdraw, offersSteer, steer, said, at)
    }
}

/** How tall the tray grows before it scrolls: about four rows (the board's), so a long queue never pushes the composer off a phone. */
private val TRAY_MAX_HEIGHT = 248.dp

/**
 * The messages the reader sent that nothing has read yet, one row each, as the card directly above the composer they were sent from
 * (docs/mocks/steer-tray; OrbitApp `PendingTrayView`, web `PendingTray`). They are not part of the conversation until the engine reads
 * them, so what is still open about each — where it is going, how far it got, the way to take it back — is said here, where the next
 * one is being typed. Not folded while a phone types: it is about the message flow being typed into.
 *
 * A row is headed into the turn running now (↳) or queued for the next one. A queued row on an engine that takes a message mid-turn
 * offers Steer; the trash is Withdraw, and the words return to the composer under any draft. What a row cannot do — a Codex steer
 * cannot be given back once Codex has it — it does not offer.
 */
@Composable
internal fun PendingTrayCard(rows: List<PendingTrayRow>, enabled: Boolean, steer: (PendingTrayRow) -> Unit, withdraw: (PendingTrayRow) -> Unit,
    modifier: Modifier = Modifier, note: String? = null) {
    if (rows.isEmpty()) return
    val shape = RoundedCornerShape(14.dp)
    // Inset from the composer's own edges, the board's 12 dp each side on a phone.
    Column(modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 6.dp).clip(shape)
        .background(MaterialTheme.colorScheme.surface).border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
        .heightIn(max = TRAY_MAX_HEIGHT).verticalScroll(rememberScrollState())
        .semantics { contentDescription = PendingTray.LABEL }.testTag("pending-tray")) {
        rows.forEachIndexed { index, row ->
            key(row.turnId) {
                if (index > 0) HorizontalDivider(Modifier.padding(start = 38.dp), color = MaterialTheme.colorScheme.outlineVariant)
                TrayRow(row, enabled, { steer(row) }, { withdraw(row) })
            }
        }
        // Why none of them can go into the turn running now — an engine that takes no message mid-turn — said only while one waits for
        // the next turn (web `PendingTray`'s note).
        if (note != null && rows.any { !it.intoTurn }) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Text(note, Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).testTag("pending-tray-note"),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun TrayRow(row: PendingTrayRow, enabled: Boolean, steer: () -> Unit, withdraw: () -> Unit) {
    // One line, so a long message does not push the composer up the screen; tapped, the words open in place.
    var open by rememberSaveable(row.turnId) { mutableStateOf(false) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp)
        .testTag("pending-tray:${row.turnId}"), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(if (row.intoTurn) R.drawable.ic_steer else R.drawable.ic_queue_next),
            if (row.intoTurn) PendingTray.INTO_TURN else PendingTray.NEXT_TURN, Modifier.size(16.dp),
            tint = if (row.intoTurn) MaterialTheme.colorScheme.primary else secondary)
        Spacer(Modifier.width(10.dp))
        row.image?.let { TrayThumb(it); Spacer(Modifier.width(8.dp)) }
        Column(Modifier.weight(1f).alpha(if (row.busy) 0.5f else 1f)) {
            Text(row.text, (if (row.filesOnly) Modifier else Modifier.clickable { open = !open }
                .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }).fillMaxWidth().testTag("pending-tray-text"),
                maxLines = if (open) Int.MAX_VALUE else 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium,
                fontFamily = if (row.shell) FontFamily.Monospace else null,
                color = if (row.filesOnly) secondary else MaterialTheme.colorScheme.onSurface)
            Text(row.state, style = MaterialTheme.typography.bodySmall, color = secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (!row.busy) {
            if (row.offersSteer) Row(Modifier.minimumInteractiveComponentSize().clip(RoundedCornerShape(10.dp))
                .clickable(enabled = enabled, onClickLabel = PendingTray.STEER_HINT, role = Role.Button, onClick = steer)
                .padding(horizontal = 8.dp).testTag("pending-tray-steer"), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                val tint = if (enabled) MaterialTheme.colorScheme.primary else secondary
                Icon(painterResource(R.drawable.ic_steer), null, Modifier.size(16.dp), tint = tint)
                Text(PendingTray.STEER, style = MaterialTheme.typography.labelLarge, color = tint)
            }
            if (row.offersWithdraw) Box(Modifier.minimumInteractiveComponentSize().clip(CircleShape)
                .clickable(enabled = enabled, onClickLabel = PendingTray.WITHDRAW_HINT, role = Role.Button, onClick = withdraw)
                .semantics { contentDescription = PendingTray.WITHDRAW }.testTag("pending-tray-withdraw"), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_trash), null, Modifier.size(20.dp), tint = secondary)
            }
        }
    }
}

/** A row's picture, at the size of a line of text: the attachment the message carries, read as the transcript reads one. */
@Composable
private fun TrayThumb(id: String) {
    val resources = LocalReaderResources.current
    val bitmap by produceState<android.graphics.Bitmap?>(null, id, resources) {
        value = try {
            val bytes = resources?.bytes("orbit-attachment:$id") ?: return@produceState
            withContext(Dispatchers.Default) { decodeAttachmentImage({ ByteArrayInputStream(bytes) }, maxDimension = 160) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
    }
    val shape = RoundedCornerShape(6.dp)
    Box(Modifier.size(28.dp).clip(shape).background(MaterialTheme.colorScheme.surfaceVariant)
        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape).testTag("pending-tray-thumb")) {
        bitmap?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
    }
}
