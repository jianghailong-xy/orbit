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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject
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
    discuss: ((String) -> Unit)?, review: (String) -> Unit, main: String = RunSettings.defaultMainBranch, submit: (CardVerb, CardInput) -> Unit) {
    val row = card.source
    val gone = card.status == CardPreviews.stale
    val enabled = fresh && !result.busy && !result.uncertain && !result.settled
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
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
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
            Text(ExceptionCards.title(row), Modifier.testTag("${card.key}:title"),
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold))
        }
        Text(ExceptionCards.provenance, style = MaterialTheme.typography.labelSmall, color = secondary)
        if (gone) {
            Text(ExceptionCards.gone, Modifier.testTag("${card.key}:gone"), style = MaterialTheme.typography.bodySmall, color = secondary)
            return@Column
        }
        Text(ExceptionCards.headingLine(row), Modifier.testTag("${card.key}:heading"), style = MaterialTheme.typography.bodyMedium)
        // What has to happen next and the doors that do it, ahead of the facts: it is what the reader came for.
        Column(Modifier.fillMaxWidth().background(tone.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
            .border(1.dp, tone.copy(alpha = 0.22f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 9.dp)
            .testTag("${card.key}:next"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(ExceptionCards.requiredAction(row), Modifier.testTag("${card.key}:required"),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
            ExceptionCards.handledByLine(row)?.let {
                Text(it, Modifier.testTag("${card.key}:handled-by"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }
            ExceptionCards.cardPresses(row, mergeCard).forEach { press ->
                val verb = ExceptionCards.verb(row, press.action)
                // A door this client cannot make from here draws nothing, its line included: one the catalogue did not grant, or
                // one the row carries no address for.
                val pressed: (() -> Unit)? = when {
                    verb != null -> if (verb !in card.actions) null else ({
                        if (verb == CardVerb.CANCEL_TASK) cancelling = true
                        // The observation door requires a reason: the press asks for it first.
                        else if (verb == CardVerb.OBSERVE) lookingAgain = true
                        else submit(verb, CardInput(triggerId = if (verb == CardVerb.RETRY_TASK) UUID.randomUUID().toString() else null))
                    })
                    press.action == "OPEN_TASK_SESSION" -> ExceptionCards.openTaskSessionLink(row)?.let { link -> { open(link) } }
                    // §2.9 LS6's reading door: the landing this item is about, opened where the reader is.
                    press.action == "OPEN_LANDING" -> row.text("landingSessionId")?.takeIf { it.isNotEmpty() }?.let { id -> { open("orbit-session:$id") } }
                    press.action == "OPEN_COORDINATOR" -> row.obj("delivery")?.text("sessionId")?.let { id -> { open("orbit-session:$id") } }
                    press.action == "REVIEW" -> row.text("promotionId")?.let { id -> { review(id) } }
                    else -> null
                }
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
        ExceptionFacts(card.key, row)
        // §4.7 H1: what is handling it while that runs — a rerun, or an observation of the line — and the reason it was asked for.
        ExceptionCards.handlingLine(row, main = main)?.let { line ->
            Column(Modifier.testTag("${card.key}:handling"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                FactRowView(card.key, ExceptionCards.FactRow(ExceptionCards.handlingLabel, line))
                ExceptionCards.handlingReason(row)?.let { FactRowView(card.key, ExceptionCards.FactRow(ExceptionCards.reasonLabel, it)) }
            }
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
private fun ExceptionFacts(key: String, row: JsonObject) {
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
}

/** One fact: its label, and its value in the faces the model gave each run — a command in mono, a check's verdict in red. */
@Composable
private fun FactRowView(key: String, fact: ExceptionCards.FactRow) {
    var expanded by rememberSaveable(key, fact.label) { mutableStateOf(false) }
    val long = fact.value.length > 120 || fact.value.contains('\n')
    val red = MaterialTheme.colorScheme.error
    Row(Modifier.fillMaxWidth().testTag("$key:fact:${fact.label}"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(fact.label, Modifier.width(62.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
