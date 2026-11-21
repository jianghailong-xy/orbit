@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.management.LocalTranslation
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.translation.CardTranslationFoot
import io.orbitd.android.core.cards.*
import io.orbitd.android.projects.CoordinatorChange
import io.orbitd.android.projects.CoordinatorChangeSheet
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.projects.failureReason
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * An exception that became the owner's without anybody asking, or the pause only they can lift, as the coordinator's conversation
 * draws it (A08-17; iOS `OwnerItemCardView`). It opens with what has to happen next — the server's own sentence, who is already
 * fixing it, and the doors the server listed in their three weights, the server's `primaryAction` first, each with the line under it
 * saying what pressing it does — then the item's facts, then who owes the answer and for how long. `Review` is drawn only where the
 * merge card it points at is in this conversation ([mergeCard]) and brings it into view ([review]). A rerun or an observation in
 * flight is said under the facts (§4.7 H1), naming the project's main branch, [main]. The owner's own ending comes last and quietest,
 * and asks for the reason it is not allowed to go without, as Observe again asks for its own. A card whose item the read no longer
 * carries says so.
 */
@Composable
internal fun ExceptionCard(card: InteractionCard, fresh: Boolean, result: CardActionState, mergeCard: String?, open: (String) -> Unit,
    discuss: ((String) -> Unit)?, review: (String) -> Unit, main: String = RunSettings.defaultMainBranch, projectName: String? = null,
    escalationSeconds: Long? = null, coordinator: CoordinatorDoors? = null, submit: (CardVerb, CardInput) -> Unit) {
    val row = card.source
    val gone = card.status == CardPreviews.stale
    val enabled = fresh && !result.busy && !result.uncertain && !result.settled
    // An owner item by escalation, a hand-over, an ended or missing coordinator: the card organised around "Who fixes it?"
    // (board owner-exception-who-fixes, D1–D4 = A). Every other kind keeps the layout below.
    val whoFixes = !gone && ExceptionCards.whoFixesIt(row)
    // The reason a "Mark as handled" press would carry, and whether its panel is up: closing the panel keeps what was typed, and
    // only the door taking it clears it. Observe again's reason is kept the same way.
    var asking by rememberSaveable(card.key) { mutableStateOf(false) }
    var reason by rememberSaveable(card.key) { mutableStateOf("") }
    var marking by remember(card.key) { mutableStateOf(false) }
    var lookingAgain by rememberSaveable(card.key) { mutableStateOf(false) }
    var why by rememberSaveable(card.key) { mutableStateOf("") }
    var observing by remember(card.key) { mutableStateOf(false) }
    var cancelling by remember(card.key) { mutableStateOf(false) }
    LaunchedEffect(marking, result.settled) { if (marking && result.settled) { reason = ""; asking = false; marking = false } }
    LaunchedEffect(observing, result.settled) { if (observing && result.settled) { why = ""; lookingAgain = false; observing = false } }
    // A door this client cannot make from here draws nothing, its line included: one the catalogue did not grant, or one the row
    // carries no address for.
    fun pressFor(action: String): (() -> Unit)? {
        val verb = ExceptionCards.verb(row, action)
        return when {
            verb != null -> if (verb !in card.actions) null else ({
                if (verb == CardVerb.CANCEL_TASK) cancelling = true
                // The observation door requires a reason: the press asks for it first.
                else if (verb == CardVerb.OBSERVE) lookingAgain = true
                else submit(verb, CardInput(triggerId = if (verb == CardVerb.RETRY_TASK) UUID.randomUUID().toString() else null))
            })
            action == "OPEN_TASK_SESSION" -> ExceptionCards.openTaskSessionLink(row)?.let { link -> { open(link) } }
            // §2.9 LS6's reading door: the landing this item is about, opened where the reader is.
            action == "OPEN_LANDING" -> row.text("landingSessionId")?.takeIf { it.isNotEmpty() }?.let { id -> { open("orbit-session:$id") } }
            action == "OPEN_COORDINATOR" -> row.obj("delivery")?.text("sessionId")?.let { id -> { open("orbit-session:$id") } }
            action == "REVIEW" -> row.text("promotionId")?.let { id -> { review(id) } }
            else -> null
        }
    }
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    // A repair task is live on the item (any `handledBy` not DONE or CANCELLED): the card says so once and asks nothing of the reader.
    val fixing = !gone && !whoFixes && ExceptionCards.fixing(row)
    Column(Modifier.fillMaxWidth().testTag(card.key).alpha(if (gone) 0.72f else 1f)
        .background(tone.copy(alpha = 0.07f), RoundedCornerShape(14.dp)).border(1.dp, tone.copy(alpha = 0.28f), RoundedCornerShape(14.dp))
        .padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // Work that landed without the owner's confirmation is about a merge into main, and wears the merge's mark.
            val glyph = when (row.text("kind")) {
                "FUSE_PAUSED" -> R.drawable.ic_pause
                "LANDED_WITHOUT_CONFIRMATION" -> R.drawable.ic_merge
                else -> R.drawable.ic_warning
            }
            Icon(painterResource(glyph), null, Modifier.size(18.dp), tint = tone)
            Text(ExceptionCards.title(row), Modifier.weight(1f, fill = !fixing).testTag("${card.key}:title"),
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold))
            // The "Fixing" tag beside the kind while a repair task is live (board card-ui-polish ①), in the blue the board's Handling
            // tag wears. As on iPhone, the "Who fixes it?" card keeps its own heading line and draws no tag.
            if (fixing) {
                FixingTag("${card.key}:fixing-tag")
                Spacer(Modifier.weight(1f))
            }
            // D3 = A: the card's one clock, the total wait, at its top right.
            if (whoFixes) Text(ExceptionCards.whoFixesClock(row), Modifier.testTag("${card.key}:clock"), style = MaterialTheme.typography.labelSmall,
                color = secondary)
        }
        if (whoFixes) {
            WhoFixesBody(card, enabled, fresh, result, mergeCard, projectName, escalationSeconds, coordinator, open, discuss, main, ::pressFor,
                markHandled = { asking = true }, cancel = { cancelling = true })
            if (asking) ReasonPanel("${card.key}:mark-handled", "${card.key}:reason", ExceptionCards.markHandledTitle, ExceptionCards.markHandledBody,
                ExceptionCards.markHandledReason, ExceptionCards.markHandled, reason, { reason = it.take(ExceptionCards.markHandledMaxLength) }, enabled,
                back = { asking = false }) {
                marking = true; submit(CardVerb.MARK_HANDLED, CardInput(text = reason))
            }
            Text(ExceptionCards.provenance, style = MaterialTheme.typography.labelSmall, color = secondary)
            return@Column
        }
        Text(ExceptionCards.provenance, style = MaterialTheme.typography.labelSmall, color = secondary)
        if (gone) {
            Text(ExceptionCards.gone, Modifier.testTag("${card.key}:gone"), style = MaterialTheme.typography.bodySmall, color = secondary)
            return@Column
        }
        Text(ExceptionCards.headingLine(row), Modifier.testTag("${card.key}:heading"), style = MaterialTheme.typography.bodyMedium)
        // While a repair task is live, the server's sentence and the handled-by line say the same thing twice (board card-ui-polish
        // ①): the block becomes the one line naming the task, and the doors wait under the facts as quiet links.
        if (fixing) FixingBlock(card.key, row, open)
        // What has to happen next and the doors that do it, ahead of the facts: it is what the reader came for.
        else Column(Modifier.fillMaxWidth().background(tone.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
            .border(1.dp, tone.copy(alpha = 0.22f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 9.dp)
            .testTag("${card.key}:next"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(ExceptionCards.requiredAction(row), Modifier.testTag("${card.key}:required"),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
            ExceptionCards.handledByLine(row)?.let {
                Text(it, Modifier.testTag("${card.key}:handled-by"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }
            ExceptionCards.cardPresses(row, mergeCard).forEach { press ->
                val verb = ExceptionCards.verb(row, press.action)
                val pressed = pressFor(press.action)
                // A door that sends is addressed by its request, as every card's are (`<card>:<verb>`); one that only looks by its action.
                val tag = "${card.key}:${verb?.name ?: press.action}"
                if (pressed != null) Door(tag, press.consequence) {
                    // The two ways onto the work and Review only look: they stay pressable while the card is being checked.
                    // Abandon ends the attempt and is drawn in the alarm's ink, as every end is (iOS `.red` on the same door).
                    Weighted(press.tier, press.label, if (verb == null) true else enabled, tag, danger = press.action == "ABANDON", onClick = pressed)
                }
            }
            CardDiscussion.context(card)?.let { context ->
                if (discuss != null) OutlinedButton(onClick = { discuss(context) }, Modifier.heightIn(min = 48.dp), enabled = fresh && !result.busy) {
                    Text("Chat about this")
                }
            }
            if (ExceptionCards.markable(row) && CardVerb.MARK_HANDLED in card.actions) Door("${card.key}:MARK_HANDLED", ExceptionCards.markHandledConsequence) {
                Weighted(ExceptionCards.PressTier.LINK, ExceptionCards.markHandled, enabled, "${card.key}:MARK_HANDLED") { asking = true }
            }
            result.message?.let {
                Text(it, Modifier.testTag("card-result"), style = MaterialTheme.typography.bodySmall,
                    color = if (result.uncertain) MaterialTheme.colorScheme.error else secondary)
            }
            // A run that is already going says where (the execute door's own refusal).
            result.response?.takeIf { it.text("code") in setOf("TASK_ALREADY_RUNNING", "TASK_RUN_PIN_CONFLICT", "TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED") }
                ?.text("conflictingSessionId")?.takeIf { it.isNotBlank() }?.let { LinkButton("Open the run", "orbit-session:$it", open) }
            if (result.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        ExceptionFacts(card.key, row, open)
        // §4.7 H1: what is handling it while that runs — a rerun, or an observation of the line — and the reason it was asked for.
        ExceptionCards.handlingLine(row, main = main)?.let { line ->
            Column(Modifier.testTag("${card.key}:handling"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                FactRowView(card.key, ExceptionCards.FactRow(ExceptionCards.handlingLabel, line))
                ExceptionCards.handlingReason(row)?.let { FactRowView(card.key, ExceptionCards.FactRow(ExceptionCards.reasonLabel, it)) }
            }
        }
        // Every door a quiet link in one row with Chat about this, under the facts, while the repair runs (board card-ui-polish ①,
        // D1 = A; iOS `quietRow`). What a press came back with is said under the row, as the doors' block says it otherwise.
        if (fixing) {
            FlowRow(Modifier.fillMaxWidth().testTag("${card.key}:quiet"), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                // A pause keeps its one Resume, drawn quiet like the rest.
                (if (row.text("kind") == "FUSE_PAUSED") ExceptionCards.cardPresses(row, mergeCard) else ExceptionCards.presses(row, mergeCard, quiet = true))
                    .forEach { press ->
                        val verb = ExceptionCards.verb(row, press.action)
                        pressFor(press.action)?.let { pressed ->
                            QuietLink(press.label, if (verb == null) true else enabled, "${card.key}:${verb?.name ?: press.action}", pressed)
                        }
                    }
                CardDiscussion.context(card)?.let { context ->
                    if (discuss != null) QuietLink("Chat about this", fresh && !result.busy, "${card.key}:chat") { discuss(context) }
                }
                if (ExceptionCards.markable(row) && CardVerb.MARK_HANDLED in card.actions) {
                    QuietLink(ExceptionCards.markHandled, enabled, "${card.key}:MARK_HANDLED") { asking = true }
                }
            }
            result.message?.let {
                Text(it, Modifier.testTag("card-result"), style = MaterialTheme.typography.bodySmall,
                    color = if (result.uncertain) MaterialTheme.colorScheme.error else secondary)
            }
            result.response?.takeIf { it.text("code") in setOf("TASK_ALREADY_RUNNING", "TASK_RUN_PIN_CONFLICT", "TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED") }
                ?.text("conflictingSessionId")?.takeIf { it.isNotBlank() }?.let { LinkButton("Open the run", "orbit-session:$it", open) }
            if (result.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        if (lookingAgain) ReasonPanel("${card.key}:observe", "${card.key}:observe-reason", ExceptionCards.observeTitle, ExceptionCards.observeBody,
            ExceptionCards.observeReason, ExceptionCards.observeAgain, why, { why = it.take(ExceptionCards.observeReasonMaxLength) }, enabled,
            back = { lookingAgain = false }) {
            observing = true; submit(CardVerb.OBSERVE, CardInput(text = why))
        }
        if (asking) ReasonPanel("${card.key}:mark-handled", "${card.key}:reason", ExceptionCards.markHandledTitle, ExceptionCards.markHandledBody,
            ExceptionCards.markHandledReason, ExceptionCards.markHandled, reason, { reason = it.take(ExceptionCards.markHandledMaxLength) }, enabled,
            back = { asking = false }) {
            marking = true; submit(CardVerb.MARK_HANDLED, CardInput(text = reason))
        }
        Text(ExceptionCards.ownerLine(row), Modifier.testTag("${card.key}:owner"), style = MaterialTheme.typography.labelSmall, color = secondary)
    }
    if (cancelling) AlertDialog(onDismissRequest = { cancelling = false },
        title = { Text("${CardVerb.CANCEL_TASK.label}?") },
        text = { Text("This ends the task's attempt and closes its exceptions. Its branch and history remain.") },
        confirmButton = { TextButton(modifier = Modifier.testTag("confirm:${CardVerb.CANCEL_TASK.name}"), enabled = enabled,
            onClick = { cancelling = false; submit(CardVerb.CANCEL_TASK, CardInput()) }) { Text(CardVerb.CANCEL_TASK.label) } },
        dismissButton = { TextButton(onClick = { cancelling = false }) { Text("Back") } })
}

/** "Fixing": the small blue tag beside the card's kind while a repair task is live (web `FIXING_TAG` in the Handling tag's tone). */
@Composable
private fun FixingTag(tag: String) {
    val blue = MaterialTheme.colorScheme.primary
    Text(ExceptionCards.fixingTag, Modifier.testTag(tag).background(blue.copy(alpha = 0.16f), RoundedCornerShape(50))
        .border(1.dp, blue.copy(alpha = 0.35f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold), color = blue, maxLines = 1)
}

/** The one line a live repair is drawn as: "Being fixed in <task ↗>", each title a link to its task (the rest after a middot), and under
 * it what it asks of the reader — nothing unless it fails (iOS `fixingBlock`). An id that names no task is drawn as plain words rather
 * than as a link that could only do nothing. One annotated line, so a long title wraps inside the card. */
@Composable
private fun FixingBlock(key: String, row: JsonObject, open: (String) -> Unit) {
    val blue = MaterialTheme.colorScheme.primary
    val linkStyle = TextLinkStyles(SpanStyle(color = blue, fontWeight = FontWeight.SemiBold))
    val line = buildAnnotatedString {
        append("${ExceptionCards.beingFixedIn} ")
        ExceptionCards.liveRepairs(row).forEachIndexed { index, task ->
            if (index > 0) append(" · ")
            val title = "${task.text("title").orEmpty()} ↗"
            val id = task.text("taskId")?.takeIf { ObjectId.canonical(it) != null }
            if (id == null) append(title)
            else withLink(LinkAnnotation.Clickable("orbit-task:$id", linkStyle) { open("orbit-task:$id") }) { append(title) }
        }
    }
    Row(Modifier.fillMaxWidth().background(blue.copy(alpha = 0.10f), RoundedCornerShape(8.dp))
        .border(1.dp, blue.copy(alpha = 0.35f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 9.dp).testTag("$key:fixing"),
        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CircularProgressIndicator(Modifier.padding(top = 2.dp).size(14.dp), color = blue, strokeWidth = 2.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(line, Modifier.testTag("$key:being-fixed"), style = MaterialTheme.typography.bodyMedium)
            Text(ExceptionCards.fixingNothingForYou, Modifier.testTag("$key:nothing-for-you"), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** A door while a repair runs: a quiet link in the tint, with no line under it — link text, as iOS draws it (`quietRow`'s plain
 * buttons), not a Material button, so the row wraps as words do. */
@Composable
private fun QuietLink(label: String, enabled: Boolean, tag: String, onClick: () -> Unit) {
    Text(label, Modifier.clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(vertical = 6.dp).testTag(tag),
        style = MaterialTheme.typography.bodyMedium,
        color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f))
}

/** One door and, under it, the line that says what pressing it does. */
@Composable
private fun Door(tag: String, consequence: String, button: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        button()
        Text(consequence, Modifier.testTag("$tag:consequence"), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A press in the weight the card gave it: the step it asks for filled, the other way to take it outlined, the rest a quiet link. */
@Composable
private fun Weighted(tier: ExceptionCards.PressTier, label: String, enabled: Boolean, tag: String, danger: Boolean = false, onClick: () -> Unit) {
    when (tier) {
        ExceptionCards.PressTier.PRIMARY -> Button(onClick, Modifier.heightIn(min = 48.dp).testTag(tag), enabled = enabled,
            colors = if (danger) ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error) else ButtonDefaults.buttonColors()) { Text(label) }
        ExceptionCards.PressTier.SECONDARY -> OutlinedButton(onClick, Modifier.heightIn(min = 48.dp).testTag(tag), enabled = enabled) { Text(label) }
        ExceptionCards.PressTier.LINK -> TextButton(onClick, Modifier.testTag(tag), enabled = enabled,
            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 8.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = if (enabled) MaterialTheme.colorScheme.onSurfaceVariant else Color.Unspecified)
        }
    }
}

/** What happened, in the rows of the item's payload — or, for a row whose payload this build cannot read, what escalated and the
 * fact that opened it. The failed check's log hangs under the Check row it belongs to. */
@Composable
private fun ExceptionFacts(key: String, row: JsonObject, open: (String) -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    when (val facts = ExceptionCards.facts(row)) {
        is ExceptionCards.Facts.DetailLine -> Column(Modifier.testTag("$key:facts"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ExceptionCards.subject(row)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = secondary) }
            if (facts.line.isNotEmpty()) Text(facts.line, style = MaterialTheme.typography.bodySmall, color = secondary)
        }
        is ExceptionCards.Facts.Rows -> Column(Modifier.testTag("$key:facts"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            facts.rows.forEach { fact ->
                FactRowView(key, fact)
                fact.logTail?.let { LogTail(key, it) }
            }
        }
    }
    if (row.obj("baseline") != null) {
        var heldOpen by remember { mutableStateOf(false) }
        TextButton(onClick = { heldOpen = !heldOpen }) { Text(LandingCheckCopy.viewHeld) }
        if (heldOpen) row.strings("heldTaskIds").forEach { id -> TextButton(onClick = { open("orbit-task:$id") }) { Text(id) } }
    }

}

/** One fact: its label, and its value in the faces the model gave each run — a command in mono, a check's verdict in red. */
@Composable
private fun FactRowView(key: String, fact: ExceptionCards.FactRow, labelWidth: androidx.compose.ui.unit.Dp = 62.dp) {
    var expanded by rememberSaveable(key, fact.label) { mutableStateOf(false) }
    val long = fact.value.length > 120 || fact.value.contains('\n')
    val red = MaterialTheme.colorScheme.error
    Row(Modifier.fillMaxWidth().testTag("$key:fact:${fact.label}"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(fact.label, Modifier.width(labelWidth), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            SelectionContainer {
                Text(buildAnnotatedString {
                    fact.runs.forEach { run ->
                        when (run.face) {
                            ExceptionCards.Face.PLAIN -> append(run.text)
                            ExceptionCards.Face.MONO -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(run.text) }
                            ExceptionCards.Face.BAD -> withStyle(SpanStyle(color = red)) { append(run.text) }
                        }
                    }
                }, style = MaterialTheme.typography.bodySmall, maxLines = if (long && !expanded) 3 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
            }
            if (long) Text(if (expanded) ExceptionCards.CheckTail.less else "Show details", Modifier.clickable(role = Role.Button) { expanded = !expanded },
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}

/** The tail of a failed check's output, folded from the end, where the reason a check is red always is. */
@Composable
private fun LogTail(key: String, tail: ExceptionCards.CheckTail) {
    var expanded by rememberSaveable(key) { mutableStateOf(false) }
    val folds = tail.more != null || tail.shown.joinToString("\n").length > 120
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SelectionContainer {
            Text((if (expanded) tail.lines else tail.shown).joinToString("\n"), Modifier.fillMaxWidth()
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
                .padding(horizontal = 8.dp, vertical = 6.dp).testTag("$key:log"),
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = if (folds && !expanded) 6 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
        }
        if (folds) Text(if (expanded) ExceptionCards.CheckTail.less else tail.more ?: "Show details",
            Modifier.clickable(role = Role.Button) { expanded = !expanded }.testTag("$key:log-toggle"),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
    }
}

/** A reason a door requires, asked for in place — the owner's own ending's, and Observe again's: what the press does, the field, and
 * the press itself, which waits for a reason because an empty one is not a press. [tag] names the panel and its two buttons, [field]
 * the field. */
@Composable
private fun ReasonPanel(tag: String, field: String, title: String, body: String, label: String, confirmLabel: String, reason: String,
    edit: (String) -> Unit, enabled: Boolean, back: () -> Unit, confirm: () -> Unit) {
    val line = MaterialTheme.colorScheme.onSurface
    Column(Modifier.fillMaxWidth().background(line.copy(alpha = 0.04f), RoundedCornerShape(8.dp)).border(1.dp, line.copy(alpha = 0.12f), RoundedCornerShape(8.dp))
        .padding(horizontal = 10.dp, vertical = 9.dp).testTag("$tag-panel"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
        Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(reason, edit, Modifier.fillMaxWidth().testTag(field), enabled = enabled, minLines = 2, maxLines = 5,
            label = { Text(label) })
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(back, Modifier.heightIn(min = 48.dp).testTag("$tag-back")) { Text("Back") }
            Button(confirm, Modifier.heightIn(min = 48.dp).testTag("$tag-confirm"), enabled = enabled && reason.isNotBlank()) {
                Text(confirmLabel)
            }
        }
    }
}

/**
 * Where the who-fixes card reads its coordinator from and what repairs it (D1 = A: a repair only repairs the coordinator; Ask again is
 * pressed on its own once the item reads askable). The conversation's is the project page's own reads and writes ([ProjectCoordinatorDoors]).
 */
internal interface CoordinatorDoors {
    /** `GET /projects/:id/coordinator/status`. */
    suspend fun status(projectId: String): JsonObject
    /** `GET /workspaces`, for the two facts a LIVE status does not carry. */
    suspend fun workspaces(): List<JsonObject>
    /** `POST /projects/:id/coordinator/replace`, then the conversation's reads again: the card stays where it is. */
    suspend fun replace(projectId: String, revision: String, workspaceId: String? = null)
    /** The project page's Change workspace… list. */
    @Composable fun ChangeSheet(currentWorkspaceId: String?, close: () -> Unit, pick: (CoordinatorChange.Row) -> Unit)
}

/** The project page's coordinator reads and writes, and its Change workspace… sheet. [refresh] reads the conversation again. */
internal class ProjectCoordinatorDoors(private val api: ProjectApi, private val refresh: () -> Unit) : CoordinatorDoors {
    override suspend fun status(projectId: String) = api.coordinator(projectId)
    override suspend fun workspaces() = api.workspaces()
    override suspend fun replace(projectId: String, revision: String, workspaceId: String?) {
        api.replaceCoordinator(projectId, revision, workspaceId); refresh()
    }
    @Composable override fun ChangeSheet(currentWorkspaceId: String?, close: () -> Unit, pick: (CoordinatorChange.Row) -> Unit) =
        CoordinatorChangeSheet(api, currentWorkspaceId, close, pick)
}

/**
 * The owner exception card organised around "Who fixes it?" (board owner-exception-who-fixes ②, Android ⑤; web `WhoFixesItCard`):
 * the live cause as the heading, a subline, the coordinator row and the You row (a hand-over puts You first), the line about how it
 * ends, Details folded, and after a divider the two ways to end it without fixing it. No footer and no Chat about this button: where a
 * message can go the coordinator row offers "or Chat about this first" beside Ask again (D2); where none can, nothing.
 */
@Composable
private fun WhoFixesBody(card: InteractionCard, enabled: Boolean, fresh: Boolean, result: CardActionState, mergeCard: String?, projectName: String?, escalationSeconds: Long?,
    doors: CoordinatorDoors?, open: (String) -> Unit, discuss: ((String) -> Unit)?, main: String, pressFor: (String) -> (() -> Unit)?,
    markHandled: () -> Unit, cancel: () -> Unit) {
    val row = card.source
    val key = card.key
    val projectId = card.projectId
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val askable = ExceptionCards.askable(row)
    // The coordinator status is read only where the server did not draw Ask again; the workspace list only for a LIVE one.
    var status by remember(key) { mutableStateOf<JsonObject?>(null) }
    var workspaces by remember(key) { mutableStateOf<List<JsonObject>?>(null) }
    var reads by remember(key) { mutableIntStateOf(0) }
    LaunchedEffect(key, card.binding, reads, askable, doors) {
        if (askable || doors == null || projectId == null) return@LaunchedEffect
        status = try { doors.status(projectId) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { status }
        if (status?.text("state") == "LIVE") workspaces = try { doors.workspaces() }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { workspaces }
    }
    val statusRead = if (askable) null else status
    val parsed = ExceptionCards.CoordinatorStatus.of(statusRead)
    val workspace = if (parsed?.state == "LIVE" && parsed.workspaceId != null)
        ExceptionCards.WorkspaceFacts.of(workspaces?.firstOrNull { it.text("id") == parsed.workspaceId }) else null
    val reading = ExceptionCards.readCoordinatorCause(row, parsed, workspace)
    val drawn = ExceptionCards.drawn(row, mergeCard)
    val owner = LocalTranslation.current.cardLanguage
    var showOriginalNote by remember(key) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var repairing by remember(key) { mutableStateOf(false) }
    var repairFailed by remember(key) { mutableStateOf<String?>(null) }
    var changing by remember(key) { mutableStateOf(false) }
    var changeTo by remember(key) { mutableStateOf<CoordinatorChange.Row?>(null) }
    val revision = "replace:${statusRead?.obj("coordination")?.text("sessionId")}"
    fun replace(workspaceId: String?) {
        val doorsNow = doors ?: return
        val id = projectId ?: return
        repairing = true; repairFailed = null
        scope.launch {
            try { doorsNow.replace(id, revision, workspaceId); reads++ }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { repairFailed = "No new coordinator was started — ${failureReason(failure)}" }
            finally { repairing = false }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(ExceptionCards.whoFixesHeading(reading.cause), Modifier.testTag("$key:heading"),
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
        Text(ExceptionCards.whoFixesSubline(row, projectName), Modifier.testTag("$key:subline"), style = MaterialTheme.typography.bodyMedium, color = secondary)
        ExceptionCards.handledByLine(row)?.let {
            Text(it, Modifier.testTag("$key:handled-by"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }
    }

    val coordinatorRow: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().testTag("$key:who:coordinator"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(ExceptionCards.whoFixesCoordinator, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
            val sentence = ExceptionCards.coordinatorRowSentence(row, reading)
            Text(buildAnnotatedString {
                val name = reading.workspaceName
                val at = if (name != null) sentence.indexOf(" $name ") else -1
                if (name == null || at < 0) append(sentence) else {
                    append(sentence.substring(0, at + 1))
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(name) }
                    append(sentence.substring(at + 1 + name.length))
                }
            }, Modifier.testTag("$key:who:status"), style = MaterialTheme.typography.bodySmall, color = secondary)
            // The coordinator's hand-over note under its caption, in the owner's language with its own flip while a usable translation exists.
            if (reading.cause == ExceptionCards.CoordinatorCause.HANDED_OVER) {
                OwnerCardTranslation.handoverNote(row, owner, showOriginalNote)?.let { note ->
                    Column(Modifier.testTag("$key:who:handover"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(ExceptionCards.handoverNoteCaption, Modifier.testTag("$key:who:handover:caption"),
                            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold), color = secondary)
                        Text(note, Modifier.testTag("$key:who:handover:note"), style = MaterialTheme.typography.bodySmall)
                        if (OwnerCardTranslation.handoverNoteTranslates(row, owner))
                            CardTranslationFoot(showOriginalNote, { showOriginalNote = !showOriginalNote }, Modifier.testTag("$key:who:handover:foot"))
                    }
                }
            }
            ExceptionCards.coordinatorRowPresses(reading).forEach { press ->
                val tag = "$key:who:${press.kind.name}"
                when (press.kind) {
                    ExceptionCards.RowPressKind.ASK_AGAIN -> if (CardVerb.RETURN_COORDINATOR in card.actions)
                        Weighted(press.tier, press.label, enabled, "$key:${CardVerb.RETURN_COORDINATOR.name}") { pressFor("ASK_COORDINATOR_AGAIN")?.invoke() }
                    // D2 = A: only where a message can go.
                    ExceptionCards.RowPressKind.CHAT_FIRST -> CardDiscussion.context(card)?.let { context ->
                        if (discuss != null && row.obj("chat")?.text("refusal") == null)
                            LinkPress(press.label, fresh && !result.busy, tag) { discuss(context) }
                    }
                    // Android has no workspace page a card can open: the fix is the project's, where the coordinator is configured.
                    ExceptionCards.RowPressKind.FIX, ExceptionCards.RowPressKind.SET_UP_COORDINATOR -> projectId?.let { id ->
                        Weighted(press.tier, press.label, true, tag) { open("orbit-project:$id") }
                    }
                    ExceptionCards.RowPressKind.START_NEW_COORDINATOR -> if (doors != null && projectId != null)
                        Weighted(press.tier, press.label, fresh && !repairing, tag) { replace(null) }
                    ExceptionCards.RowPressKind.CHANGE_WORKSPACE -> if (doors != null && statusRead != null) {
                        if (press.tier == ExceptionCards.PressTier.LINK) LinkPress(press.label, fresh && !repairing, tag) { changing = true }
                        else Weighted(press.tier, press.label, fresh && !repairing, tag) { changing = true }
                    }
                }
            }
            if (repairing) LinearProgressIndicator(Modifier.fillMaxWidth())
            repairFailed?.let { Text(it, Modifier.testTag("$key:who:repair-failed"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            ExceptionCards.coordinatorRowNote(row, reading, escalationSeconds)?.let {
                Text(it, Modifier.testTag("$key:who:note"), style = MaterialTheme.typography.bodySmall, color = secondary)
            }
        }
    }
    // The owner's other ways onto the work the server listed (a failed task's Retry, say), after "Fix it myself", in the second weight.
    val youDoors = drawn.filter { it !in setOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "CANCEL_TASK", "OPEN_LANDING", "OPEN_COORDINATOR") }
        .mapNotNull { action -> pressFor(action)?.let { action to it } }
    val fixMyself = if ("OPEN_TASK_SESSION" in drawn) pressFor("OPEN_TASK_SESSION") else null
    val youRow: (@Composable () -> Unit)? = if (fixMyself == null && youDoors.isEmpty()) null else ({
        Column(Modifier.fillMaxWidth().testTag("$key:who:you"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(ExceptionCards.whoFixesYou, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
            fixMyself?.let {
                Door("$key:OPEN_TASK_SESSION", ExceptionCards.fixItMyselfLine(row)) {
                    Weighted(if (ExceptionCards.fixItMyselfLeads(reading)) ExceptionCards.PressTier.PRIMARY else ExceptionCards.PressTier.SECONDARY,
                        ExceptionCards.fixItMyself, true, "$key:OPEN_TASK_SESSION", onClick = it)
                }
            }
            youDoors.forEach { (action, pressed) ->
                val verb = ExceptionCards.verb(row, action)
                val tag = "$key:${verb?.name ?: action}"
                Door(tag, ExceptionCards.actionConsequence(row, action)) {
                    Weighted(ExceptionCards.PressTier.SECONDARY, ExceptionCards.actionLabel(row, action) ?: action, if (verb == null) true else enabled, tag,
                        danger = action == "ABANDON", onClick = pressed)
                }
            }
        }
    })

    Column(Modifier.fillMaxWidth().background(tone.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
        .border(1.dp, tone.copy(alpha = 0.22f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 9.dp)
        .testTag("$key:who"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(ExceptionCards.whoFixesIt.uppercase(), style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Bold), color = tone)
        // D4 = A: a hand-over leads with the owner's own row.
        val rows = listOfNotNull(coordinatorRow, youRow).let { if (ExceptionCards.youLead(reading)) it.reversed() else it }
        rows.forEachIndexed { index, drawRow ->
            if (index > 0) HorizontalDivider(color = tone.copy(alpha = 0.22f))
            drawRow()
        }
        result.message?.let {
            Text(it, Modifier.testTag("card-result"), style = MaterialTheme.typography.bodySmall,
                color = if (result.uncertain) MaterialTheme.colorScheme.error else secondary)
        }
        result.response?.takeIf { it.text("code") in setOf("TASK_ALREADY_RUNNING", "TASK_RUN_PIN_CONFLICT", "TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED") }
            ?.text("conflictingSessionId")?.takeIf { it.isNotBlank() }?.let { LinkButton("Open the run", "orbit-session:$it", open) }
        if (result.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }

    if (ExceptionCards.closesByItself(row)) {
        val green = LocalOrbitColors.current.success
        Text("✓ ${ExceptionCards.closesByItself}", Modifier.fillMaxWidth().background(green.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
            .border(1.dp, green.copy(alpha = 0.25f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 8.dp).testTag("$key:closes"),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
    }

    ExceptionCards.handlingLine(row, main = main)?.let { line ->
        Column(Modifier.testTag("$key:handling"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            FactRowView(key, ExceptionCards.FactRow(ExceptionCards.handlingLabel, line))
            ExceptionCards.handlingReason(row)?.let { FactRowView(key, ExceptionCards.FactRow(ExceptionCards.reasonLabel, it)) }
        }
    }

    // Details, folded (board ② 4): the facts, how long the coordinator had it, and the landing.
    val landing = if ("OPEN_LANDING" in drawn) pressFor("OPEN_LANDING") else null
    var unfolded by rememberSaveable(key) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("${if (unfolded) "⌄" else "›"} ${if (unfolded) ExceptionCards.detailsLabel else ExceptionCards.detailsSummary(row, landing != null)}",
            Modifier.clickable(role = Role.Button) { unfolded = !unfolded }.padding(vertical = 6.dp).testTag("$key:details"),
            style = MaterialTheme.typography.bodySmall, color = secondary)
        if (unfolded) Column(Modifier.testTag("$key:details-body"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            ExceptionCards.detailRows(row, projectName).forEach { fact ->
                FactRowView(key, fact, labelWidth = 76.dp)
                fact.logTail?.let { LogTail(key, it) }
            }
            landing?.let { go ->
                Row(Modifier.fillMaxWidth().testTag("$key:fact:${ExceptionCards.landingFactLabel}"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(ExceptionCards.landingFactLabel, Modifier.width(76.dp), style = MaterialTheme.typography.bodySmall, color = secondary)
                    Text(buildAnnotatedString {
                        withStyle(SpanStyle(color = MaterialTheme.colorScheme.primary)) { append(ExceptionCards.openLanding) }
                        append(" — ${ExceptionCards.openLandingDetail}")
                    }, Modifier.weight(1f).clickable(role = Role.Button, onClick = go).testTag("$key:OPEN_LANDING"), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }

    // After a divider, the two ways to end it without fixing it.
    val handClosable = ExceptionCards.markable(row) && CardVerb.MARK_HANDLED in card.actions
    val cancellable = "CANCEL_TASK" in drawn && CardVerb.CANCEL_TASK in card.actions
    if (handClosable || cancellable) {
        HorizontalDivider(color = tone.copy(alpha = 0.22f))
        Column(Modifier.testTag("$key:settled"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(ExceptionCards.alreadySettled, style = MaterialTheme.typography.labelMedium, color = secondary)
            if (handClosable) Door("$key:MARK_HANDLED", ExceptionCards.markHandledSettledConsequence) {
                LinkPress(ExceptionCards.markHandled, enabled, "$key:MARK_HANDLED", onClick = markHandled)
            }
            if (cancellable) Door("$key:CANCEL_TASK", ExceptionCards.cancelTaskSettledConsequence) {
                LinkPress(CardVerb.CANCEL_TASK.label, enabled, "$key:CANCEL_TASK", danger = true, onClick = cancel)
            }
        }
    }

    if (changing && doors != null) doors.ChangeSheet(statusRead?.obj("coordination")?.text("workspaceId"), close = { changing = false }) { picked ->
        changing = false; changeTo = picked
    }
    changeTo?.let { to ->
        val outgoing = CoordinatorChange.outgoing(statusRead)
        AlertDialog(onDismissRequest = { changeTo = null }, title = { Text(CoordinatorChange.title(projectName ?: "this project", to.name)) },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                CoordinatorChange.paragraphs(to.name, statusRead?.obj("coordination")?.text("workspaceName"), outgoing).forEach { Text(it) }
            } },
            confirmButton = { TextButton(onClick = { changeTo = null; replace(to.workspaceId) }, enabled = fresh && !repairing,
                modifier = Modifier.testTag("$key:who:change-confirm")) {
                Text(CoordinatorChange.action(to.name, outgoing),
                    color = if (outgoing == CoordinatorChange.Outgoing.OPEN) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) } },
            dismissButton = { TextButton(onClick = { changeTo = null }) { Text(CoordinatorChange.cancel) } })
    }
}

/** A text link press: the coordinator row's quiet doors and the two settled endings, the alarm's ink for an end. */
@Composable
private fun LinkPress(label: String, enabled: Boolean, tag: String, danger: Boolean = false, onClick: () -> Unit) {
    TextButton(onClick, Modifier.testTag(tag), enabled = enabled, contentPadding = PaddingValues(horizontal = 4.dp, vertical = 8.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium,
            color = if (!enabled) Color.Unspecified else if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
    }
}
