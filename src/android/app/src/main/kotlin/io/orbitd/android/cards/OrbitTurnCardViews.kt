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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.reader.personWords
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject

/**
 * Five more of Orbit's own turns, each drawn as the card it is (docs/mocks/orbit-turn-cards/; web `OrbitTurnCards.tsx`, OrbitKit
 * `OrbitTurnCardViews.swift`): Evidence to review, Evidence sent back, Question from a task run, Notice from a task run — built like
 * the review cards — and the opening of a session Orbit opened, which is one full-width line rather than a card. Nobody typed any of
 * them; the block the agent read folds at the foot.
 */
@Composable
internal fun OrbitTurnCardView(card: InteractionCard, event: RunEvent?, open: (String) -> Unit, undelivered: Boolean) {
    val field = card.key.substringAfterLast(':')
    val source = card.source
    val ts = event?.ts
    when (field) {
        "sessionOpening" -> { SessionOpeningLine(source, event, open); return }
        "evidenceReview" -> TurnCardFrame(
            tag = "turn-evidence-review",
            tone = if (OrbitTurnCards.evidenceReviewOpen(source)) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            icon = R.drawable.ic_task, head = OrbitTurnCards.evidenceToReview, ts = ts,
        ) {
            TaskTitle(source.text("title"), source.text("taskId"), open)
            Meta(OrbitTurnCards.evidenceReviewMeta(source))
            source.text("claim")?.takeIf { it.isNotBlank() }?.let { Claim("${card.key}:claim", it) }
            StateText(OrbitTurnCards.evidenceReviewState(source))
            if (OrbitTurnCards.evidenceReviewOpen(source)) source.text("runSessionId")?.let { OpenTaskSession(it, open) }
            if (undelivered) Undelivered()
            event?.let { BlockFold("${card.key}:told", it, OrbitTurnCards.sessionTold) }
        }
        "evidenceSendBack" -> TurnCardFrame(
            tag = "turn-evidence-sent-back", tone = LocalOrbitColors.current.needsYou,
            icon = R.drawable.ic_back, head = OrbitTurnCards.evidenceSentBack, ts = ts,
        ) {
            TaskTitle(source.text("title"), source.text("taskId"), open)
            val session = source.text("bySessionId").takeIf { source.text("by") == "SESSION" }
            Text(linked(OrbitTurnCards.sentBackPrefix(source), OrbitTurnCards.sentBackBy(source), session?.let { "orbit-session:$it" }, open),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            source.text("note")?.takeIf { it.isNotBlank() }?.let { Quote("“$it”") }
            if (undelivered) Undelivered()
            event?.let { BlockFold("${card.key}:told", it, OrbitTurnCards.runTold) }
        }
        "runQuestion" -> TurnCardFrame(
            tag = "turn-run-question", tone = MaterialTheme.colorScheme.primary,
            icon = R.drawable.ic_question_bubble, head = OrbitTurnCards.questionFromRun, ts = ts,
        ) {
            TaskTitle(OrbitTurnCards.runTaskTitle(source), source.text("taskId"), open)
            OrbitTurnCards.runQuestions(source).forEach { question ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(question.text, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
                    question.options.forEach { option ->
                        if (option.picked) Text("✓ ${option.label}", style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold))
                        else Text(option.label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    question.ownWords.forEach { words ->
                        Text("✓ “$words”", style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold))
                    }
                }
            }
            StateText(OrbitTurnCards.runQuestionState(source))
            if (!OrbitTurnCards.answered(source)) source.text("runSessionId")?.let { OpenTaskSession(it, open) }
            if (undelivered) Undelivered()
            event?.let { BlockFold("${card.key}:told", it, OrbitTurnCards.coordinatorTold) }
        }
        "runNotice" -> TurnCardFrame(
            tag = "turn-run-notice", tone = MaterialTheme.colorScheme.onSurfaceVariant,
            icon = R.drawable.ic_bell, head = OrbitTurnCards.noticeFromRun, ts = ts,
        ) {
            TaskTitle(OrbitTurnCards.runTaskTitle(source), source.text("taskId"), open)
            source.text("message")?.takeIf { it.isNotBlank() }?.let { Quote("“$it”") }
            StateText(OrbitTurnCards.StateLine(OrbitTurnCards.noticeState))
            if (undelivered) Undelivered()
            event?.let { BlockFold("${card.key}:told", it, OrbitTurnCards.coordinatorTold) }
        }
    }
}

/** Whether a card is one of the five this file draws: the row is then only that card (and the opening, only its line). */
internal fun isOrbitTurnCard(card: InteractionCard) =
    card.key.substringAfterLast(':') in setOf("evidenceReview", "evidenceSendBack", "runQuestion", "runNotice", "sessionOpening")

@Composable
private fun TurnCardFrame(tag: String, tone: Color, icon: Int, head: String, ts: String?, body: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().testTag(tag)
        .background(tone.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
        .border(1.dp, tone.copy(alpha = 0.30f), RoundedCornerShape(8.dp))
        .padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(icon), null, Modifier.size(16.dp), tint = tone)
            Text(head, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = tone)
            ts?.let { OwnerReview.receiptTime(it) }?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        body()
    }
}

@Composable
private fun TaskTitle(title: String?, taskId: String?, open: (String) -> Unit) {
    Text(title.orEmpty(), Modifier.then(if (taskId != null) Modifier.clickable(role = Role.Button) { open("orbit-task:$taskId") } else Modifier),
        style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
        color = if (taskId != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
}

/** [lead] then [target], the target a link onto [link] when there is one. */
@Composable
private fun linked(lead: String, target: String?, link: String?, open: (String) -> Unit) = buildAnnotatedString {
    append(lead)
    if (target == null) return@buildAnnotatedString
    if (link == null) { append(target); return@buildAnnotatedString }
    val style = TextLinkStyles(SpanStyle(color = MaterialTheme.colorScheme.primary))
    withLink(LinkAnnotation.Clickable(link, style) { open(link) }) { append(target) }
}

@Composable
private fun Meta(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun Quote(text: String) = Text(text, Modifier.padding(start = 4.dp), style = MaterialTheme.typography.bodyMedium)

/** What the run claims, three lines until opened. */
@Composable
private fun Claim(tag: String, claim: String) {
    var all by rememberSaveable(tag) { mutableStateOf(false) }
    var overflows by remember(tag) { mutableStateOf(false) }
    Column(Modifier.testTag(tag), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(claim, Modifier.padding(start = 4.dp), style = MaterialTheme.typography.bodyMedium,
            maxLines = if (all) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
            onTextLayout = { if (!all) overflows = it.hasVisualOverflow })
        if (overflows || all) Text(if (all) OrbitTurnCards.showLess else OrbitTurnCards.showAll,
            Modifier.clickable(role = Role.Button) { all = !all }.padding(vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun StateText(line: OrbitTurnCards.StateLine) = Text(line.text, style = MaterialTheme.typography.bodySmall, color = when (line.tone) {
    OrbitTurnCards.Tone.WARNING -> LocalOrbitColors.current.needsYou
    OrbitTurnCards.Tone.SUCCESS -> LocalOrbitColors.current.success
    OrbitTurnCards.Tone.PLAIN -> MaterialTheme.colorScheme.onSurfaceVariant
})

@Composable
private fun OpenTaskSession(run: String, open: (String) -> Unit) =
    OutlinedButton(onClick = { open("orbit-session:$run") }, Modifier.heightIn(min = 48.dp)) { Text(OwnerReview.openTaskSession) }

@Composable
private fun Undelivered() =
    Text(OwnerAnswerLine.undelivered, style = MaterialTheme.typography.labelSmall, color = LocalOrbitColors.current.needsYou)

/** The block the agent read: the turn's own words, or — for a turn whose words are written in at delivery — the control plane's note,
 * which is then the whole turn. Folded under [heading]. */
private fun RunEvent.block(): String = personWords().ifBlank { fields.text("controlPlaneNote").orEmpty() }.trim()

@Composable
private fun BlockFold(tag: String, event: RunEvent, heading: String) {
    val text = event.block().takeIf { it.isNotBlank() } ?: return
    var open by rememberSaveable(tag) { mutableStateOf(false) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(top = 4.dp).testTag(tag), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.clickable(role = Role.Button) { open = !open }.semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
            .padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("▸", Modifier.rotate(if (open) 90f else 0f).clearAndSetSemantics { }, color = secondary, style = MaterialTheme.typography.labelMedium)
            Text(heading, color = secondary, style = MaterialTheme.typography.bodySmall)
        }
        if (open) SelectionContainer {
            Text(text, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
                .padding(8.dp).testTag("$tag:words"), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** The opening of a session Orbit opened: one grey line saying why, the target a link, the brief folded under Show brief. */
@Composable
private fun SessionOpeningLine(source: JsonObject, event: RunEvent?, open: (String) -> Unit) {
    var shown by rememberSaveable(event?.seq) { mutableStateOf(false) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val (lead, target) = OrbitTurnCards.openingSentence(source)
    val link = OrbitTurnCards.openingLink(source)
    val brief = event?.block()?.takeIf { it.isNotBlank() }
    Column(Modifier.fillMaxWidth().testTag("turn-session-opening")
        .background(secondary.copy(alpha = 0.08f), RoundedCornerShape(10.dp))
        .border(1.dp, secondary.copy(alpha = 0.20f), RoundedCornerShape(10.dp))
        .padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(painterResource(R.drawable.ic_info), null, Modifier.size(16.dp), tint = secondary)
            Text(linked(lead, target, link, open), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = secondary)
            if (brief != null) Text(if (shown) OrbitTurnCards.hideBrief else OrbitTurnCards.showBrief,
                Modifier.clickable(role = Role.Button) { shown = !shown }.padding(vertical = 4.dp).testTag("turn-session-opening:toggle"),
                style = MaterialTheme.typography.labelMedium, color = secondary)
        }
        OrbitTurnCards.openingMention(source)?.let { Quote("“$it”") }
        if (shown && brief != null) SelectionContainer {
            Text(brief, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
                .padding(8.dp).testTag("turn-session-opening:brief"), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
        }
    }
}
