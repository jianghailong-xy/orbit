package io.orbitd.android.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.CoordinatorCleanStart
import io.orbitd.android.R
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.directoryError
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
    const val OPEN_PREVIOUS = CoordinatorCleanStart.openPrevious
    fun historyBefore(decisions: Int, merges: Int) = CoordinatorCleanStart.historyBefore(decisions, merges)
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
    /** The phones' confirm body, board 03 iOS 2 (`coordinatorHandoffPhoneConfirmBody`, OrbitKit's `phoneConfirmBody`): the waits as
     * a count only, and no count when there are none. */
    fun phoneConfirmBody(waits: Int, running: Boolean): String {
        val lead = if (running) "After the current turn ends, this coordinator writes a handoff note" else "This coordinator writes a handoff note"
        val moves = if (waits > 0) " ${waitsRowTitle(waits)}." else ""
        return "$lead, then the project continues in a new conversation.$moves Nothing is deleted."
    }
    fun waitsRowTitle(count: Int) = if (count == 1) "1 pending wait moves over" else "$count pending waits move over"
    const val CANCEL = "Cancel"
    const val HAND_OVER = "Hand over"
    const val BADGE_HANDING_OVER = "Handing over"
    const val WRITING = "Writing the handoff note"
    /** Board 02 ⑥: in WRITING's place while the engine compacts before it can write the note. */
    const val COMPACTING = "Compacting…"
    const val SKIP_NOTE = "Skip the note"
    const val CANCEL_HANDOVER = "Cancel handover"
    const val HANDING_OVER = "Handing over to a new coordinator…"
    const val NOTE_CARD_TITLE = "Handoff from the previous coordinator"
    fun waitsMovedHere(count: Int) = if (count == 1) "1 wait moved here" else "$count waits moved here"
    /** After a paused wait's label in the moved-here list (web's `pendingWaitLabel`, OrbitKit's `pausedSuffix`). */
    const val PAUSED_SUFFIX = " (paused)"
    /** The words after a wait's label naming its kind (`COORDINATOR_PENDING_WAIT_KIND_LABELS`); none for a watch, whose label
     *  already says what it waits for — nor for a missing or unknown kind, which reads as a watch. */
    val WAIT_KINDS = mapOf("SUBAGENT" to "SubAgent", "JOB" to "Background job", "WAKEUP" to "Scheduled wakeup", "LOOP" to "Wakeup loop")
    const val HANDED_OVER = "Handed over to a new coordinator."
    const val OPEN_IT = "Open it"
    const val TRY_AGAIN = "Try again"
    const val HAND_OVER_WITHOUT_NOTE = "Hand over without a note"
    const val KEEP_THIS_COORDINATOR = "Keep this coordinator"
    const val SUCCESSOR_ROW_TITLE = "New coordinator runs on"
    const val SUCCESSOR_KEEP = "Same as this one"
    const val SUCCESSOR_ROW_DETAIL = "Pick another if this one's model or provider has stopped working."
    /** A handoff press the server refused (`refused`): web's toast title, this line's lead. */
    const val REFUSED = "Couldn't hand over"
    fun refusal(reason: String) = "$REFUSED: $reason"
    /** The sentence a FAILED handoff shows when the server sent none (`coordinatorHandoffFailureSentence`). */
    val FAILURE_REASONS = mapOf(
        "TURN_FAILED" to "the turn failed.",
        "TURN_STOPPED" to "the turn was stopped.",
        "TIMED_OUT" to "the turn timed out.",
        "EMPTY_NOTE" to "the reply was empty.",
        "REPLACE_FAILED" to "the new coordinator could not be opened.",
        "COORDINATOR_CANT_RUN" to "the model of this coordinator could not start. Pick another model and hand over without a note.",
    )
    fun failureSentence(code: String?) = "The handoff note wasn't written: ${FAILURE_REASONS[code] ?: FAILURE_REASONS.getValue("TURN_FAILED")}"
    /** The first line of the platform turn that asks for the note (`COORDINATOR_HANDOFF_PROMPT_HEAD`): Orbit's, never drawn. */
    const val NOTE_PROMPT_HEAD = "From Orbit · handoff note"
}

/** The handoff on a session (`coordinatorHandoff`, on the outgoing coordinator); [compacting] is the session's `enginePhase`. */
internal data class OutgoingHandoff(val state: String, val startedAt: String?, val failureCode: String?, val failureReason: String?,
    val handedOverTo: String?, val compacting: Boolean = false, val successor: HandoffSuccessor? = null) {
    val locksComposer get() = state == "WRITING" || state == "HANDING_OVER"
}

internal data class HandoffSuccessor(val engine: String?, val provider: String?, val model: String? = null) {
    companion object {
        /** "Same as this one" said on purpose: sent as `"successor": null`, which clears a pick saved earlier. */
        val SAME = HandoffSuccessor(null, null, null)
    }
}

/** One wait as the handoff names it (`CoordinatorPendingWait`). [kind] is the server's, null from a server without it. */
internal data class HandoffWait(val id: String, val label: String, val paused: Boolean, val kind: String? = null) {
    /** The kind's words, null for a watch (or a missing or unknown kind). */
    val kindLabel get() = kind?.let { CoordinatorHandoffCopy.WAIT_KINDS[it] }
    /** The wait as the confirm and the moved-here list show it (`coordinatorPendingWaitLine`): the label, " (paused)" when
     *  paused, then " · <kind>" unless it is a watch. */
    val shownLabel get() = label + (if (paused) CoordinatorHandoffCopy.PAUSED_SUFFIX else "") + (kindLabel?.let { " · $it" } ?: "")
}

/** The handoff a successor opened with (`coordinatorHandoffReceived`). */
internal data class ReceivedHandoff(val from: String, val note: String?, val handedOverAt: String?, val movedWaits: List<HandoffWait>)

/** One section of the note as the card titles it, and its lines. */
internal data class NoteSection(val title: String, val lines: List<String>)

/** The note as the card shows it: the lines before the first heading (OrbitKit's `preamble`), then its sections. */
internal data class HandoffNote(val preamble: List<String>, val sections: List<NoteSection>)

/** The rules the context dialog and the conversation read (boards 02, 03). Pure, so the unit tests pin them. */
internal object CoordinatorHandoff {
    val SECTIONS = listOf("Where things stand", "Rulings not yet recorded", "Waiting on", "Next")

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

    /** The line a refused handoff press leaves: the server's own message where it sent one, else what kind of failure it was. */
    fun refusal(e: Exception) = CoordinatorHandoffCopy.refusal((e as? ApiError)?.messages?.firstOrNull() ?: directoryError(e))

    fun projectId(detail: JsonObject) = (detail["projectMembership"] as? JsonObject)?.text("projectId")

    fun outgoing(detail: JsonObject?): OutgoingHandoff? = (detail?.get("coordinatorHandoff") as? JsonObject)?.let { h ->
        val state = h.text("state") ?: return null
        val successor = (h["successor"] as? JsonObject)?.let {
            HandoffSuccessor(it.text("engine"), it.text("provider"), it.text("model"))
        }
        OutgoingHandoff(state, h.text("startedAt"), h.text("failureCode"), h.text("failureReason"), h.text("handedOverToSessionId"),
            compacting = detail.text("enginePhase") == "compacting", successor = successor)
    }

    /** The in-hand row's words: WRITING's, or "Compacting…" while the engine compacts first (board 02 ⑥); null for any other state. */
    fun progressLabel(handoff: OutgoingHandoff?): String? = when (handoff?.state) {
        "WRITING" -> if (handoff.compacting) CoordinatorHandoffCopy.COMPACTING else CoordinatorHandoffCopy.WRITING
        "HANDING_OVER" -> CoordinatorHandoffCopy.HANDING_OVER
        else -> null
    }

    /** The clock runs for as long as the note is asked for, compacting or not. */
    fun showsTimer(handoff: OutgoingHandoff?) = handoff?.state == "WRITING"

    fun received(detail: JsonObject?): ReceivedHandoff? = (detail?.get("coordinatorHandoffReceived") as? JsonObject)?.let { h ->
        val from = h.text("handoffFromSessionId") ?: return null
        ReceivedHandoff(from, h.text("note")?.takeIf { it.isNotBlank() }, h.text("handedOverAt"), waits(h["movedWaits"]))
    }

    fun waits(value: JsonElement?): List<HandoffWait> = (value as? JsonArray).orEmpty().filterIsInstance<JsonObject>().mapNotNull { w ->
        HandoffWait(w.text("id") ?: return@mapNotNull null, w.text("label").orEmpty(), w.flag("paused") == true, w.text("kind"))
    }

    /** The FAILED row's exits: all three, but only Hand over without a note once the outgoing conversation is already completed
     * (`REPLACE_FAILED`: Try again and Keep this coordinator cannot work then). */
    fun failureActions(failureCode: String?): List<String> = if (failureCode == "REPLACE_FAILED") listOf(CoordinatorHandoffCopy.HAND_OVER_WITHOUT_NOTE)
        else listOf(CoordinatorHandoffCopy.TRY_AGAIN, CoordinatorHandoffCopy.HAND_OVER_WITHOUT_NOTE, CoordinatorHandoffCopy.KEEP_THIS_COORDINATOR)

    /** How often a handoff in hand is read again. */
    const val FOLLOW_MS = 4_000L

    /** The handoff is still in hand (WRITING or HANDING_OVER): its next state comes after the note turn has ended — the server's
     * sweep, the replacement — when the session is no longer live and nothing else reads it again. */
    fun keepsReading(detail: JsonObject?) = outgoing(detail)?.locksComposer == true

    /** Reads the session again every [FOLLOW_MS] for as long as [detail] says the handoff is in hand, live or not; returns once it is
     * FAILED, COMPLETED or gone. [reload] asks for a fresh read; [detail] answers with the latest one. */
    suspend fun follow(detail: () -> JsonObject?, reload: suspend () -> Unit) {
        while (keepsReading(detail())) { delay(FOLLOW_MS); reload() }
    }

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

    /** The note's four sections as the card titles them, with any lines before the first heading kept above them (as OrbitKit
     * does); a note with none of them is shown as it was written. */
    fun sections(note: String): HandoffNote? {
        val found = mutableListOf<NoteSection>()
        val preamble = mutableListOf<String>()
        var title: String? = null
        val lines = mutableListOf<String>()
        fun flush() { title?.let { found += NoteSection(it, lines.toList()) }; lines.clear() }
        note.lines().forEach { raw ->
            val line = raw.trim()
            val heading = line.trimStart('#', ' ', '*').trimEnd('*', ':', ' ')
            val known = SECTIONS.firstOrNull { it.equals(heading, ignoreCase = true) }
            if (known != null) { flush(); title = known }
            else if (line.isNotEmpty()) (if (title != null) lines else preamble) += line.removePrefix("- ").removePrefix("* ").removePrefix("• ")
        }
        flush()
        return found.takeIf { it.isNotEmpty() }?.let { HandoffNote(preamble.toList(), it) }
    }
}

/** The handoff's doors on the project (docs/coordinator-handoff.md). Each POST answers the handoff as it now stands. */
internal class CoordinatorHandoffApi(private val auth: AuthSession, private val handle: SessionHandle) {
    suspend fun pendingWaits(projectId: String): List<HandoffWait> = CoordinatorHandoff.waits(
        Wire.decode(auth.request(handle, ApiRequest(listOf("projects", projectId, "coordinator", "pending-waits"))).body, JsonElement.serializer()))
    /** [action]: null starts it (Hand over); `skip`, `cancel` or `retry`. */
    suspend fun post(projectId: String, action: String? = null, successor: HandoffSuccessor? = null) {
        auth.request(handle, postRequest(projectId, action, successor))
    }

    companion object {
        fun postRequest(projectId: String, action: String?, successor: HandoffSuccessor?): ApiRequest {
            val body = buildJsonObject {
                if (successor == HandoffSuccessor.SAME) put("successor", JsonNull)
                else successor?.let { pick ->
                    put("successor", buildJsonObject {
                        pick.engine?.let { put("engine", it) }
                        pick.provider?.let { put("provider", it) }
                        pick.model?.let { put("model", it) }
                    })
                }
            }
            return ApiRequest(listOfNotNull("projects", projectId, "coordinator", "handoff", action),
                HttpMethod.POST, body = if (action == "cancel") null else body.toString().encodeToByteArray())
        }
    }
}

@Composable
private fun HandoffSuccessorPicker(model: ComposerModel, state: ComposerState, detail: JsonObject, busy: Boolean,
    successor: HandoffSuccessor?, onPick: (HandoffSuccessor?) -> Unit) {
    LaunchedEffect(model) {
        if (model.state.value.let { it.catalog == null && !it.catalogLoading }) model.loadCatalog()
    }
    val catalog = state.catalog
    val antigravityKey = catalog?.antigravityKeyAvailable(detail) == true
    val choices = catalog?.engines(listOf(successor?.engine to successor?.provider), antigravityKey).orEmpty()
    val selectedLabel = successor?.let {
        val engine = it.engine
        val provider = it.provider
        val providerLabel = provider?.let { id ->
            engine?.let { catalog?.current(it, id, antigravityKey)?.label } ?: id
        }
        listOfNotNull(engine?.let(ProviderEngines::cliName), providerLabel, it.model).joinToString(" · ")
    }
    var expanded by remember { mutableStateOf(false) }
    Column {
        Text(CoordinatorHandoffCopy.SUCCESSOR_ROW_TITLE, style = MaterialTheme.typography.labelLarge)
        Text(CoordinatorHandoffCopy.SUCCESSOR_ROW_DETAIL, style = MaterialTheme.typography.bodySmall)
        Box {
            OutlinedButton(enabled = !busy, onClick = { expanded = true }, modifier = Modifier.testTag("handoff-successor")) {
                Text(selectedLabel ?: CoordinatorHandoffCopy.SUCCESSOR_KEEP)
            }
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                DropdownMenuItem(text = { Text(CoordinatorHandoffCopy.SUCCESSOR_KEEP) }, onClick = {
                    onPick(null)
                    expanded = false
                })
                for (option in choices) {
                    val landing = option.landing ?: continue
                    if (option.unavailable != null) continue
                    DropdownMenuItem(text = {
                        Column {
                            Text(ProviderEngines.cliName(option.engine))
                            Text(landing.label, style = MaterialTheme.typography.bodySmall)
                        }
                    }, onClick = {
                        onPick(HandoffSuccessor(option.engine, landing.id))
                        expanded = false
                    })
                }
                if (state.catalogLoading) CircularProgressIndicator(Modifier.padding(12.dp).size(20.dp), strokeWidth = 2.dp)
                state.catalogError?.let { error ->
                    DropdownMenuItem(text = { Text("Retry model catalog") }, onClick = model::loadCatalog)
                    Text(error, Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
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

/** Board 02 ① as board 03 draws it for a phone (iOS 2): the title and one body, the waits a count inside it — iOS's words. */
@Composable
internal fun HandoverConfirm(running: Boolean, waits: List<HandoffWait>?, busy: Boolean, error: String?,
    model: ComposerModel, state: ComposerState, detail: JsonObject, onHandOver: (HandoffSuccessor?) -> Unit, onCancel: () -> Unit) {
    var successor by remember { mutableStateOf<HandoffSuccessor?>(null) }
    AlertDialog(onDismissRequest = onCancel, modifier = Modifier.testTag("handoff-confirm"),
        title = { Text(CoordinatorHandoffCopy.CONFIRM_TITLE) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // No count while the waits are still being read, as when there are none.
                Text(CoordinatorHandoffCopy.phoneConfirmBody(waits?.size ?: 0, running))
                // Once any wait is more than a watch, each one on its own line with its kind (handoff v2 §1), as iOS's Alert;
                // waits that are all watches, or from a server without `kind`, stay a count only.
                if (waits.orEmpty().any { it.kindLabel != null }) Column(Modifier.testTag("handoff-confirm-waits")) {
                    waits.orEmpty().forEach { Text("•  ${it.shownLabel}", style = MaterialTheme.typography.bodySmall) }
                }
                HandoffSuccessorPicker(model, state, detail, busy, successor) { successor = it }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = { TextButton(enabled = !busy, onClick = { onHandOver(successor) }, modifier = Modifier.testTag("handoff-confirm-hand-over")) {
            Text(CoordinatorHandoffCopy.HAND_OVER, fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onCancel) { Text(CoordinatorHandoffCopy.CANCEL) } })
}

/**
 * The outgoing coordinator's handoff in the conversation, above the composer: board 02 ② (writing, its timer, Skip the note and
 * Cancel handover; then Handing over…) and ⑤ (the failure and its exits). COMPLETED is the banner in the composer's place
 * ([HandedOverBanner]); nothing at all for a session with no handoff.
 */
@Composable
internal fun HandoffStatus(handoff: OutgoingHandoff?, model: ComposerModel, state: ComposerState, detail: JsonObject,
    act: (String, HandoffSuccessor?) -> Unit, busy: Boolean) {
    when (handoff?.state) {
        "WRITING", "HANDING_OVER" -> {
            val writing = CoordinatorHandoff.showsTimer(handoff)
            var now by remember { mutableStateOf(Instant.now()) }
            LaunchedEffect(handoff.startedAt, writing) { while (writing) { now = Instant.now(); delay(1_000) } }
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("handoff-progress")
                .background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.45f), RoundedCornerShape(10.dp)).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(16.dp).padding(top = 2.dp), strokeWidth = 2.dp)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(CoordinatorHandoff.progressLabel(handoff).orEmpty(),
                            color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                        if (writing) Text(CoordinatorHandoff.elapsed(handoff.startedAt, now), Modifier.testTag("handoff-timer"),
                            color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                    }
                    if (writing) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(enabled = !busy, onClick = { act("skip", null) }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text(CoordinatorHandoffCopy.SKIP_NOTE) }
                        OutlinedButton(enabled = !busy, onClick = { act("cancel", null) }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text(CoordinatorHandoffCopy.CANCEL_HANDOVER) }
                    }
                }
            }
        }
        "FAILED" -> Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("handoff-failed")
            .background(MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.6f), RoundedCornerShape(10.dp)).padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(painterResource(R.drawable.ic_info), null, Modifier.size(18.dp).padding(top = 2.dp), tint = MaterialTheme.colorScheme.error)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                var successor by remember(model, handoff.startedAt, handoff.successor) { mutableStateOf(handoff.successor) }
                Text(handoff.failureReason ?: CoordinatorHandoffCopy.failureSentence(handoff.failureCode), color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium)
                HandoffSuccessorPicker(model, state, detail, busy, successor) { successor = it }
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CoordinatorHandoff.failureActions(handoff.failureCode).forEach { label ->
                        val action = when (label) { CoordinatorHandoffCopy.TRY_AGAIN -> "retry"; CoordinatorHandoffCopy.KEEP_THIS_COORDINATOR -> "cancel"; else -> "skip" }
                        OutlinedButton(enabled = !busy, onClick = { act(action, if (action == "cancel") null else successor ?: HandoffSuccessor.SAME) },
                            contentPadding = PaddingValues(horizontal = 12.dp)) { Text(label) }
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
internal fun HandoffNoteCard(received: ReceivedHandoff, history: CoordinatorCleanStart.Counts = CoordinatorCleanStart.Counts(0, 0), open: (String) -> Unit) {
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
            CoordinatorHandoffCopy.historyBefore(history.decisions, history.merges)?.let { line ->
                Text("$line · ${CoordinatorHandoffCopy.OPEN_PREVIOUS}",
                    Modifier.clickable { open(received.from) }.padding(horizontal = 12.dp, vertical = 4.dp).testTag("handoff-history"),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }
            HorizontalDivider()
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val note = received.note
                val sections = note?.let(CoordinatorHandoff::sections)
                when {
                    sections != null -> {
                        if (sections.preamble.isNotEmpty()) Text(sections.preamble.joinToString("\n"), Modifier.testTag("handoff-note-preamble"),
                            style = MaterialTheme.typography.bodyMedium)
                        sections.sections.forEach { section ->
                        Text(section.title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(top = 4.dp))
                        section.lines.forEach { Text("•  $it", style = MaterialTheme.typography.bodyMedium) }
                        }
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
            if (waitsOpen) received.movedWaits.forEach { Text("•  ${it.shownLabel}", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}
