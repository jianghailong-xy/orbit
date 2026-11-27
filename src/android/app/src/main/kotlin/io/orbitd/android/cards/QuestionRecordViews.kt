package io.orbitd.android.cards

import io.orbitd.android.management.LocalTranslation
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.translation.CardTranslationFoot
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.reader.personWords
import io.orbitd.android.text.MarkdownText
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject

/**
 * What a coordinator's question became once it ended (A08-13; iOS `CoordinatorQuestionRecordView`), where its question card was — or in
 * the place of the turn that handed its answer to the coordinator (`OwnerAnswerLineView`): the heading and when, the question's opening,
 * how it ended — the option chosen or the owner's own words, the note beside the option, an answer no coordinator has had yet, or who
 * withdrew it and why — and "View details". It asks nothing, and no count reads it: in the neutral frame a decided record takes, with the
 * answer ticked green, it reads apart from the open question card, which stays blue (docs/mocks/owner-answer-sent-card/tone.html).
 * [queued]: the turn handing it over still waits on the queue — dashed, as a queued turn is, and saying so. [notice]: what to say when
 * that turn's delivery went unconfirmed.
 *
 * Tapping it unfolds the full record in place (board card-ui-polish ③, as on iOS and the web) — the question, every option with the
 * chosen one ticked, the owner's note, the words a turn [told] the coordinator folded, and the footer — and its last row then says
 * "Hide details". No sheet opens: the record stays where it belongs in the conversation, and the reader keeps reading around it.
 * [initiallyOpen] draws it unfolded (the evidence shots; iOS's `initiallyOpen`).
 */
@Composable
internal fun QuestionRecordCard(card: InteractionCard, queued: Boolean = false, notice: String? = null, told: RunEvent? = null,
    initiallyOpen: Boolean = false, open: (String) -> Unit = {}) {
    var expanded by rememberSaveable(card.key) { mutableStateOf(initiallyOpen) }
    // The question in the owner's language as it was translated while open (Settings › Translation); the unfolded record flips it.
    var showOriginal by rememberSaveable(card.key) { mutableStateOf(false) }
    val owner = LocalTranslation.current.cardLanguage
    val translated = remember(card.source, owner) { OwnerCardTranslation.closedQuestion(card.source, owner) }
    val record = if (translated != null && !showOriginal) translated else card.source
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val line = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f)
    val shape = RoundedCornerShape(14.dp)
    Column(Modifier.fillMaxWidth().testTag(card.key).background(MaterialTheme.colorScheme.surfaceVariant, shape)
        .then(if (queued) Modifier.dashedBorder(line, 14.dp) else Modifier.border(1.dp, line, shape)).clip(shape)) {
        Column(Modifier.fillMaxWidth().clickable(role = Role.Button) { expanded = !expanded }
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(22.dp).background(secondary.copy(alpha = 0.16f), RoundedCornerShape(6.dp)))
                Text(CoordinatorQuestions.recordHeading(record), Modifier.weight(1f).testTag("${card.key}:heading"),
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                CoordinatorQuestions.time(record)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = secondary) }
            }
            RecordLines(card.key, record, queued, notice)
            if (!expanded) {
                HorizontalDivider(color = line)
                Row(Modifier.testTag("${card.key}:details"), verticalAlignment = Alignment.CenterVertically) {
                    Text(CoordinatorQuestions.viewDetails, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                        color = MaterialTheme.colorScheme.primary)
                    Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
        if (expanded) Column(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, bottom = 14.dp).testTag("${card.key}:unfolded"),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                RecordDetails(card.key, record, translated != null, showOriginal, { showOriginal = !showOriginal }, told, open)
            }
            // As on iOS, the footer follows the options with no rule between them.
            RecordFootLines(card.key, record)
            Row(Modifier.clickable(role = Role.Button) { expanded = false }.padding(vertical = 4.dp).testTag("${card.key}:hide"),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(CoordinatorQuestions.hideDetails, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.primary)
                Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.size(14.dp).rotate(180f), tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

/** The card's lines under its heading: the question's opening, cut at two lines, then how it ended. */
@Composable
private fun RecordLines(key: String, record: JsonObject, queued: Boolean, notice: String?) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(CoordinatorQuestions.lead(record.obj("question")), Modifier.testTag("$key:lead"), style = MaterialTheme.typography.bodySmall,
            color = secondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
        CoordinatorQuestions.answerLine(record)?.let { answer ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(painterResource(R.drawable.ic_check_circle), null, Modifier.size(16.dp), tint = LocalOrbitColors.current.success)
                Text(answer, Modifier.testTag("$key:answer"), style = MaterialTheme.typography.bodyMedium)
            }
        }
        CoordinatorQuestions.noteLine(record)?.let {
            Text(it, Modifier.padding(start = 22.dp).testTag("$key:note"), style = MaterialTheme.typography.bodySmall, color = secondary,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val clockLine: @Composable (String, String) -> Unit = { words, tag ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(painterResource(R.drawable.ic_clock), null, Modifier.size(14.dp), tint = LocalOrbitColors.current.needsYou)
                Text(words, Modifier.testTag("$key:$tag"), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.needsYou)
            }
        }
        CoordinatorQuestions.waitingLine(record)?.let { clockLine(it, "waiting") }
        if (queued) clockLine(CoordinatorQuestions.queuedForCoordinator, "queued")
        notice?.let {
            Text(it, Modifier.testTag("$key:notice"), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.needsYou)
        }
        CoordinatorQuestions.withdrewLine(record)?.let {
            Text(it, Modifier.testTag("$key:withdrew"), style = MaterialTheme.typography.bodySmall, color = secondary)
        }
        CoordinatorQuestions.withdrawReasonLine(record)?.let {
            Text(it, Modifier.testTag("$key:reason"), style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/**
 * The record's review (iOS `CoordinatorQuestionRecordView` in its review): a question answered while its review was open becomes its
 * record there, and the review replays it — the question as it was asked and every option as it was offered, the one chosen ticked, the
 * recommendation marked, the owner's note inside the chosen one, the Other row ticked over their own words, or a read-only box for a
 * question asked without options — and, where Send answer was, who ended it and when, then where the answer went or why it was withdrawn.
 * Drawn for the turn that [told] the coordinator its answer, the words that turn handed over are folded at the foot of the replay.
 */
@Composable
internal fun QuestionRecordReview(card: InteractionCard, told: RunEvent? = null, open: (String) -> Unit) {
    var showOriginal by remember(card.key) { mutableStateOf(false) }
    val owner = LocalTranslation.current.cardLanguage
    val translated = remember(card.source, owner) { OwnerCardTranslation.closedQuestion(card.source, owner) }
    val record = if (translated != null && !showOriginal) translated else card.source
    Column(Modifier.fillMaxSize().testTag(card.key)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp).testTag("${card.key}:replay"),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RecordDetails(card.key, record, translated != null, showOriginal, { showOriginal = !showOriginal }, told, open)
        }
        HorizontalDivider()
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) { RecordFootLines(card.key, record) }
    }
}

/** The full record: who asked and when, the question as it was asked, every option as it was offered, the owner's own words, and the
 * words a turn told the coordinator, folded. Drawn into the caller's column. */
@Composable
private fun RecordDetails(key: String, record: JsonObject, translated: Boolean, showOriginal: Boolean, flip: () -> Unit, told: RunEvent?,
    open: (String) -> Unit) {
    val question = record.obj("question")
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(CoordinatorQuestions.provenance, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = secondary)
        CoordinatorQuestions.askedAtLine(record)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary) }
    }
    MarkdownText(question?.text("question").orEmpty(), open = open)
    if (translated) CardTranslationFoot(showOriginal, flip)
    val chosen = CoordinatorQuestions.chosenOption(record)
    question?.objects("options").orEmpty().forEachIndexed { index, option ->
        ReplayOption("$key:option:$index", option.text("label").orEmpty(), option.text("description"),
            recommended = index == question?.number("recommendedOption"), chosen = chosen == index,
            words = if (chosen == index) CoordinatorQuestions.note(record) else null, wordsLabel = CoordinatorQuestions.yourNote)
    }
    if (CoordinatorQuestions.choseOther(record)) ReplayOption("$key:option:other", CoordinatorQuestions.otherOption, null,
        recommended = false, chosen = true, words = CoordinatorQuestions.ownWords(record), wordsLabel = null)
    if (question?.objects("options").isNullOrEmpty()) CoordinatorQuestions.ownWords(record)?.let {
        Words("$key:own", CoordinatorQuestions.freeAnswerPrompt, it, MaterialTheme.colorScheme.primary.copy(alpha = 0.08f))
    }
    told?.let { ToldFold("$key:told", it) }
}

/** Where the record's buttons were: who ended it and when, then where the answer went or why it was withdrawn. */
@Composable
private fun RecordFootLines(key: String, record: JsonObject) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag("$key:footer"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        val withdrawn = CoordinatorQuestions.withdrawn(record)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(if (withdrawn) R.drawable.ic_back else R.drawable.ic_check_circle), null, Modifier.size(16.dp),
                tint = if (withdrawn) secondary else LocalOrbitColors.current.success)
            Text(CoordinatorQuestions.footerLine(record), Modifier.testTag("$key:footer-line"),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
        }
        CoordinatorQuestions.footerDetail(record)?.let {
            Text(it, Modifier.padding(start = 22.dp).testTag("$key:footer-detail"), style = MaterialTheme.typography.bodySmall,
                color = if (CoordinatorQuestions.waitingLine(record) != null) LocalOrbitColors.current.needsYou else secondary)
        }
    }
}

/** One option as it was offered, ticked when it is the answer, with the owner's words inside it. A review's record draws its
 * answers with it too. */
@Composable
internal fun ReplayOption(tag: String, label: String, why: String?, recommended: Boolean, chosen: Boolean, words: String?, wordsLabel: String?) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().background(if (chosen) MaterialTheme.colorScheme.primary.copy(alpha = 0.08f) else Color.Transparent,
        RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 8.dp).testTag(tag), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (chosen) Icon(painterResource(R.drawable.ic_check_circle), "Chosen", Modifier.size(16.dp).testTag("$tag:chosen"), tint = MaterialTheme.colorScheme.primary)
        else Box(Modifier.size(16.dp).border(1.5.dp, secondary, RoundedCornerShape(50)))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium, color = if (chosen) MaterialTheme.colorScheme.onSurface else secondary)
            if (recommended) Text(CoordinatorQuestions.recommended, Modifier.testTag("$tag:recommended"), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary)
            why?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = secondary) }
            words?.let { Words("$tag:words", wordsLabel, it, null, Modifier.padding(top = 4.dp)) }
        }
    }
}

/** What the coordinator was told (web `answered-question-told`): folded under its heading, the words verbatim, and what delivery appended
 * folded under them. [heading] names who was told: the reviewer, on the owner's answers handed to it (`YouConfirmedCard`). */
@Composable
internal fun ToldFold(tag: String, event: RunEvent, heading: String = OwnerAnswerLine.told) {
    var open by rememberSaveable(tag) { mutableStateOf(false) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(top = 4.dp).testTag(tag), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.clickable(role = Role.Button) { open = !open }.semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
            .padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("▸", Modifier.rotate(if (open) 90f else 0f).clearAndSetSemantics { }, color = secondary, style = MaterialTheme.typography.labelMedium)
            Text(heading, color = secondary, style = MaterialTheme.typography.bodySmall)
        }
        if (open) {
            SelectionContainer {
                Text(event.personWords(), Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f),
                    RoundedCornerShape(6.dp)).padding(8.dp).testTag("$tag:words"), fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** The owner's own words, read-only: a note on the chosen option, the Other row's answer, or a free answer. */
@Composable
private fun Words(tag: String, label: String?, words: String, background: Color?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().background(background ?: MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
        .padding(horizontal = 10.dp, vertical = 8.dp).testTag(tag), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        label?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Text(words, style = MaterialTheme.typography.bodyMedium)
    }
}
