package io.orbitd.android.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Board 02's and board 03's words (docs/mocks/coordinator-context-actions), verbatim. The handoff's are `COORDINATOR_HANDOFF_COPY` in
 * `src/shared/src/coordinator-handoff.ts`, which CoordinatorHandoffCopyParityTest reads them against.
 */
internal object CoordinatorHandoffCopy {
    // Board 03, the context dialog's action rows.
    const val COMPACT = "Compact"
    const val COMPACT_DETAIL = "Summarize earlier turns and keep going here."
    const val COMPACT_WHILE_RUNNING = "Available when this turn ends."
    const val START_NEW_COORDINATOR = "Start a new coordinator"
    const val START_NEW_COORDINATOR_DETAIL = "This one writes a handoff note, then the project continues in a fresh conversation."
    /** While a turn runs: still pressable, and the handoff waits for the turn to end (web and OrbitKit say the same). */
    const val START_NEW_COORDINATOR_WHILE_RUNNING = "Begins after this turn ends: a handoff note, then a fresh conversation."
    /** What Compact sends: the engine's own slash command. */
    const val COMPACT_COMMAND = "/compact"

    // Board 02 (COORDINATOR_HANDOFF_COPY).
    const val CONFIRM_TITLE = "Hand over to a new coordinator?"
    fun confirmBody(projectTitle: String) =
        "This coordinator writes a handoff note, then $projectTitle continues in a new conversation that starts from that note. This one is completed — nothing is deleted."
    fun confirmBodyWhileRunning(projectTitle: String) =
        "After the current turn ends, this coordinator writes a handoff note, then $projectTitle continues in a new conversation that starts from that note. This one is completed — nothing is deleted."
    const val NOTE_ROW_TITLE = "Handoff note"
    const val NOTE_ROW_DETAIL = "Written by this coordinator before it hands over. Usually under a minute."
    fun waitsRowTitle(count: Int) = if (count == 1) "1 pending wait moves over" else "$count pending waits move over"
    const val CANCEL = "Cancel"
    const val HAND_OVER = "Hand over"
    const val BADGE_HANDING_OVER = "Handing over"
    const val WRITING = "Writing the handoff note"
    const val SKIP_NOTE = "Skip the note"
    const val CANCEL_HANDOVER = "Cancel handover"
    const val HANDING_OVER = "Handing over to a new coordinator…"
    const val NOTE_CARD_TITLE = "Handoff from the previous coordinator"
    fun waitsMovedHere(count: Int) = if (count == 1) "1 wait moved here" else "$count waits moved here"
    const val HANDED_OVER = "Handed over to a new coordinator."
    const val OPEN_IT = "Open it"
    const val TRY_AGAIN = "Try again"
    const val HAND_OVER_WITHOUT_NOTE = "Hand over without a note"
    const val KEEP_THIS_COORDINATOR = "Keep this coordinator"
    /** The sentence a FAILED handoff shows when the server sent none (`coordinatorHandoffFailureSentence`). */
    val FAILURE_REASONS = mapOf(
        "TURN_FAILED" to "the turn failed.",
        "TURN_STOPPED" to "the turn was stopped.",
        "TIMED_OUT" to "the turn timed out.",
        "EMPTY_NOTE" to "the reply was empty.",
        "REPLACE_FAILED" to "the new coordinator could not be opened.",
    )
    fun failureSentence(code: String?) = "The handoff note wasn't written: ${FAILURE_REASONS[code] ?: FAILURE_REASONS.getValue("TURN_FAILED")}"
    /** The first line of the platform turn that asks for the note (`COORDINATOR_HANDOFF_PROMPT_HEAD`): Orbit's, never drawn. */
    const val NOTE_PROMPT_HEAD = "From Orbit · handoff note"
}

/** The handoff on a session (`coordinatorHandoff`, on the outgoing coordinator). */
internal data class OutgoingHandoff(val state: String, val startedAt: String?, val failureCode: String?, val failureReason: String?,
    val handedOverTo: String?) {
    val locksComposer get() = state == "WRITING" || state == "HANDING_OVER"
}

/** One wait as the handoff names it (`CoordinatorPendingWait`). */
internal data class HandoffWait(val id: String, val label: String, val paused: Boolean)

/** The handoff a successor opened with (`coordinatorHandoffReceived`). */
internal data class ReceivedHandoff(val from: String, val note: String?, val handedOverAt: String?, val movedWaits: List<HandoffWait>)

/** One section of the note as the card titles it, and its lines. */
internal data class NoteSection(val title: String, val lines: List<String>)

/** The rules the context dialog and the conversation read (boards 02, 03). Pure, so the unit tests pin them. */
internal object CoordinatorHandoff {
    val SECTIONS = listOf("Where things stand", "Agreed with the owner", "Waiting on", "Next")

    /** Compact is offered where the engine advertises `compact` among its slash commands (the composer's Command list). */
    fun compactOffered(slashItems: List<JsonObject>) = slashItems.any { it.text("type") == "command" && it.text("name") == "compact" }

    /** Compact waits while a turn runs, and while a handoff has the composer locked: offered greyed, saying why (OrbitKit's rule). */
    fun compactEnabled(running: Boolean, handoff: OutgoingHandoff? = null) = !running && handoff?.locksComposer != true

    /** Start a new coordinator: only in the project's current coordinator (its membership's role), while that conversation is not
     * completed and has no handoff under way or behind it. */
    fun startOffered(detail: JsonObject): Boolean {
        val membership = detail["projectMembership"] as? JsonObject ?: return false
        if (membership.text("role") != "COORDINATOR") return false
        if (detail.text("lifecycleState") == "COMPLETED") return false
        return outgoing(detail) == null
    }

    fun projectId(detail: JsonObject) = (detail["projectMembership"] as? JsonObject)?.text("projectId")
    fun projectTitle(detail: JsonObject) = (detail["projectMembership"] as? JsonObject)?.text("projectTitle")?.takeIf { it.isNotEmpty() }
        ?: detail.text("projectTitle") ?: "the project"

    fun outgoing(detail: JsonObject?): OutgoingHandoff? = (detail?.get("coordinatorHandoff") as? JsonObject)?.let { h ->
        val state = h.text("state") ?: return null
        OutgoingHandoff(state, h.text("startedAt"), h.text("failureCode"), h.text("failureReason"), h.text("handedOverToSessionId"))
    }

    fun received(detail: JsonObject?): ReceivedHandoff? = (detail?.get("coordinatorHandoffReceived") as? JsonObject)?.let { h ->
        val from = h.text("handoffFromSessionId") ?: return null
        ReceivedHandoff(from, h.text("note")?.takeIf { it.isNotBlank() }, h.text("handedOverAt"), waits(h["movedWaits"]))
    }

    fun waits(value: JsonElement?): List<HandoffWait> = (value as? JsonArray).orEmpty().filterIsInstance<JsonObject>().mapNotNull { w ->
        HandoffWait(w.text("id") ?: return@mapNotNull null, w.text("label").orEmpty(), w.flag("paused") == true)
    }

    /** The FAILED row's exits: all three, but only Hand over without a note once the outgoing conversation is already completed
     * (`REPLACE_FAILED`: Try again and Keep this coordinator cannot work then). */
    fun failureActions(failureCode: String?): List<String> = if (failureCode == "REPLACE_FAILED") listOf(CoordinatorHandoffCopy.HAND_OVER_WITHOUT_NOTE)
        else listOf(CoordinatorHandoffCopy.TRY_AGAIN, CoordinatorHandoffCopy.HAND_OVER_WITHOUT_NOTE, CoordinatorHandoffCopy.KEEP_THIS_COORDINATOR)

    /** The platform's note-asking turn, which the transcript leaves out (Orbit's words, not the owner's). */
    fun isNotePrompt(text: String?) = text?.trimStart()?.startsWith(CoordinatorHandoffCopy.NOTE_PROMPT_HEAD) == true

    /** "0:24": the time since the note was asked for. */
    fun elapsed(startedAt: String?, now: Instant): String {
        val start = startedAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return "0:00"
        val seconds = (now.epochSecond - start.epochSecond).coerceAtLeast(0)
        return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
    }

    /** "3:42 PM", in the device's zone. */
    fun clock(at: String?, zone: ZoneId = ZoneId.systemDefault()): String? = at?.let { runCatching { Instant.parse(it) }.getOrNull() }
        ?.let { DateTimeFormatter.ofPattern("h:mm a", Locale.US).withZone(zone).format(it) }

    /** The note's four sections as the card titles them; a note that does not keep to them is shown as it was written. */
    fun sections(note: String): List<NoteSection>? {
        val found = mutableListOf<NoteSection>()
        var title: String? = null
        val lines = mutableListOf<String>()
        fun flush() { title?.let { found += NoteSection(it, lines.toList()) }; lines.clear() }
        note.lines().forEach { raw ->
            val line = raw.trim()
            val heading = line.trimStart('#', ' ', '*').trimEnd('*', ':', ' ')
            val known = SECTIONS.firstOrNull { it.equals(heading, ignoreCase = true) }
            if (known != null) { flush(); title = known }
            else if (line.isNotEmpty() && title != null) lines += line.removePrefix("- ").removePrefix("* ").removePrefix("• ")
        }
        flush()
        return found.takeIf { it.isNotEmpty() }
    }
}

/** The handoff's doors on the project (docs/coordinator-handoff.md). Each POST answers the handoff as it now stands. */
internal class CoordinatorHandoffApi(private val auth: AuthSession, private val handle: SessionHandle) {
    suspend fun pendingWaits(projectId: String): List<HandoffWait> = CoordinatorHandoff.waits(
        Wire.decode(auth.request(handle, ApiRequest(listOf("projects", projectId, "coordinator", "pending-waits"))).body, JsonElement.serializer()))
    /** [action]: null starts it (Hand over); `skip`, `cancel` or `retry`. */
    suspend fun post(projectId: String, action: String? = null) {
        auth.request(handle, ApiRequest(listOfNotNull("projects", projectId, "coordinator", "handoff", action), HttpMethod.POST))
    }
}

/** One of the context dialog's action rows (board 03): its glyph, its name and a line under it; greyed and inert when not [enabled]. */
@Composable
internal fun ContextActionRow(icon: Int, title: String, detail: String, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val tint = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().testTag(tag).clickable(enabled = enabled, onClick = onClick).padding(vertical = 8.dp)
        .alpha(if (enabled) 1f else 0.5f), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(painterResource(icon), null, Modifier.size(20.dp).padding(top = 2.dp), tint = tint)
        Column {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Board 02 ①, as board 03 asks of a phone: the confirm with its two rows, the waits as a count only. */
@Composable
internal fun HandoverConfirm(projectTitle: String, running: Boolean, waits: List<HandoffWait>?, busy: Boolean, error: String?,
    onHandOver: () -> Unit, onCancel: () -> Unit) {
    AlertDialog(onDismissRequest = onCancel, modifier = Modifier.testTag("handoff-confirm"),
        title = { Text(CoordinatorHandoffCopy.CONFIRM_TITLE) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(if (running) CoordinatorHandoffCopy.confirmBodyWhileRunning(projectTitle) else CoordinatorHandoffCopy.confirmBody(projectTitle))
                ConfirmFact(R.drawable.ic_note, CoordinatorHandoffCopy.NOTE_ROW_TITLE, CoordinatorHandoffCopy.NOTE_ROW_DETAIL)
                // Hidden when nothing waits, and while the count is still being read.
                if (!waits.isNullOrEmpty()) ConfirmFact(R.drawable.ic_wait, CoordinatorHandoffCopy.waitsRowTitle(waits.size), null)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = { TextButton(enabled = !busy, onClick = onHandOver, modifier = Modifier.testTag("handoff-confirm-hand-over")) {
            Text(CoordinatorHandoffCopy.HAND_OVER, fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onCancel) { Text(CoordinatorHandoffCopy.CANCEL) } })
}

@Composable
private fun ConfirmFact(icon: Int, title: String, detail: String?) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(painterResource(icon), null, Modifier.size(18.dp).padding(top = 2.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/**
 * The outgoing coordinator's handoff in the conversation, above the composer: board 02 ② (writing, its timer, Skip the note and
 * Cancel handover; then Handing over…) and ⑤ (the failure and its exits). COMPLETED is the banner in the composer's place
 * ([HandedOverBanner]); nothing at all for a session with no handoff.
 */
@Composable
internal fun HandoffStatus(handoff: OutgoingHandoff?, act: (String) -> Unit, busy: Boolean) {
    when (handoff?.state) {
        "WRITING", "HANDING_OVER" -> {
            val writing = handoff.state == "WRITING"
            var now by remember { mutableStateOf(Instant.now()) }
            LaunchedEffect(handoff.startedAt, writing) { while (writing) { now = Instant.now(); delay(1_000) } }
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("handoff-progress")
                .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f), RoundedCornerShape(10.dp)).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(16.dp).padding(top = 2.dp), strokeWidth = 2.dp)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(if (writing) CoordinatorHandoffCopy.WRITING else CoordinatorHandoffCopy.HANDING_OVER,
                            color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                        if (writing) Text(CoordinatorHandoff.elapsed(handoff.startedAt, now), Modifier.testTag("handoff-timer"),
                            color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                    }
                    if (writing) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(enabled = !busy, onClick = { act("skip") }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text(CoordinatorHandoffCopy.SKIP_NOTE) }
                        OutlinedButton(enabled = !busy, onClick = { act("cancel") }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text(CoordinatorHandoffCopy.CANCEL_HANDOVER) }
                    }
                }
            }
        }
        "FAILED" -> Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("handoff-failed")
            .background(MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.6f), RoundedCornerShape(10.dp)).padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(painterResource(R.drawable.ic_info), null, Modifier.size(18.dp).padding(top = 2.dp), tint = MaterialTheme.colorScheme.error)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(handoff.failureReason ?: CoordinatorHandoffCopy.failureSentence(handoff.failureCode), color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium)
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CoordinatorHandoff.failureActions(handoff.failureCode).forEach { label ->
                        val action = when (label) { CoordinatorHandoffCopy.TRY_AGAIN -> "retry"; CoordinatorHandoffCopy.KEEP_THIS_COORDINATOR -> "cancel"; else -> "skip" }
                        OutlinedButton(enabled = !busy, onClick = { act(action) }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text(label) }
                    }
                }
            }
        }
    }
}

/** Board 02 ④: a handed-over coordinator's composer is this line, with the way to its successor. */
@Composable
internal fun HandedOverBanner(successor: String?, open: (String) -> Unit) {
    Surface(tonalElevation = 2.dp) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).testTag("handoff-handed-over"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(CoordinatorHandoffCopy.HANDED_OVER, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (successor != null) Button(onClick = { open(successor) }, modifier = Modifier.testTag("handoff-open-successor")) { Text(CoordinatorHandoffCopy.OPEN_IT) }
        }
    }
}

/** Board 02 ③: the note the successor opened with, its link to the previous coordinator, and the waits that moved here. */
@Composable
internal fun HandoffNoteCard(received: ReceivedHandoff, open: (String) -> Unit) {
    var waitsOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().testTag("handoff-note-card"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(10.dp))) {
            Row(Modifier.fillMaxWidth().clickable { open(received.from) }.padding(12.dp).testTag("handoff-note-from"),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(painterResource(R.drawable.ic_handoff), null, Modifier.size(16.dp).padding(top = 2.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                // "Handoff from the previous coordinator · 3:42 PM": the previous coordinator is the link.
                val title = CoordinatorHandoffCopy.NOTE_CARD_TITLE
                val time = CoordinatorHandoff.clock(received.handedOverAt)
                Text(androidx.compose.ui.text.buildAnnotatedString {
                    pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.SemiBold)); append("Handoff"); pop()
                    append(" from ")
                    pushStyle(androidx.compose.ui.text.SpanStyle(color = MaterialTheme.colorScheme.primary)); append(title.removePrefix("Handoff from ")); pop()
                    time?.let { append(" · $it") }
                }, style = MaterialTheme.typography.bodyMedium)
            }
            HorizontalDivider()
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val note = received.note
                val sections = note?.let(CoordinatorHandoff::sections)
                when {
                    sections != null -> sections.forEach { section ->
                        Text(section.title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(top = 4.dp))
                        section.lines.forEach { Text("•  $it", style = MaterialTheme.typography.bodyMedium) }
                    }
                    note != null -> Text(note, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        if (received.movedWaits.isNotEmpty()) {
            Row(Modifier.clickable { waitsOpen = !waitsOpen }.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(50))
                .padding(horizontal = 10.dp, vertical = 4.dp).testTag("handoff-waits-moved"),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(painterResource(R.drawable.ic_wait), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(CoordinatorHandoffCopy.waitsMovedHere(received.movedWaits.size), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (waitsOpen) received.movedWaits.forEach { Text("•  ${it.label}", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}
