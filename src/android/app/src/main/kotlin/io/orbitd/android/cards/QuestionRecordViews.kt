package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.text.MarkdownText
import io.orbitd.android.ui.LocalOrbitColors

/**
 * What a coordinator's question became once it ended (A08-13; iOS `CoordinatorQuestionRecordView`), where its question card was: the
 * heading and when, the question's opening, how it ended — the option chosen or the owner's own words, the note beside the option,
 * an answer no coordinator has had yet, or who withdrew it and why — and "View details", which replays it ([onOpen]). Dimmed: it
 * asks nothing, and no count reads it.
 */
@Composable
internal fun QuestionRecordCard(card: InteractionCard, onOpen: () -> Unit) {
    val record = card.source
    val tone = if (CoordinatorQuestions.withdrawn(record)) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary
    val chrome = MaterialTheme.colorScheme.primary
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag(card.key).alpha(0.72f).background(chrome.copy(alpha = 0.07f), RoundedCornerShape(14.dp))
        .border(1.dp, chrome.copy(alpha = 0.28f), RoundedCornerShape(14.dp)).clickable(role = Role.Button, onClick = onOpen)
        .padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(22.dp).background(tone.copy(alpha = 0.16f), RoundedCornerShape(6.dp)))
            Text(CoordinatorQuestions.recordHeading(record), Modifier.weight(1f).testTag("${card.key}:heading"),
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            CoordinatorQuestions.time(record)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = secondary) }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(CoordinatorQuestions.lead(record.obj("question")), Modifier.testTag("${card.key}:lead"), style = MaterialTheme.typography.bodySmall,
                color = secondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            CoordinatorQuestions.answerLine(record)?.let { answer ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(painterResource(R.drawable.ic_check_circle), null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                    Text(answer, Modifier.testTag("${card.key}:answer"), style = MaterialTheme.typography.bodyMedium)
                }
            }
            CoordinatorQuestions.noteLine(record)?.let {
                Text(it, Modifier.padding(start = 22.dp).testTag("${card.key}:note"), style = MaterialTheme.typography.bodySmall, color = secondary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            CoordinatorQuestions.waitingLine(record)?.let {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(painterResource(R.drawable.ic_clock), null, Modifier.size(14.dp), tint = LocalOrbitColors.current.needsYou)
                    Text(it, Modifier.testTag("${card.key}:waiting"), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.needsYou)
                }
            }
            CoordinatorQuestions.withdrewLine(record)?.let {
                Text(it, Modifier.testTag("${card.key}:withdrew"), style = MaterialTheme.typography.bodySmall, color = secondary)
            }
            CoordinatorQuestions.withdrawReasonLine(record)?.let {
                Text(it, Modifier.testTag("${card.key}:reason"), style = MaterialTheme.typography.bodyMedium)
            }
        }
        HorizontalDivider(color = chrome.copy(alpha = 0.28f))
        Row(Modifier.testTag("${card.key}:details"), verticalAlignment = Alignment.CenterVertically) {
            Text(CoordinatorQuestions.viewDetails, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.primary)
            Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
        }
    }
}

/**
 * The record's review (iOS `CoordinatorQuestionRecordView` in its sheet): the question as it was asked and every option as it was
 * offered — the one chosen ticked, the recommendation marked, the owner's note inside the chosen one, the Other row ticked over their
 * own words, or a read-only box for a question asked without options — and, where Send answer was, who ended it and when, then where
 * the answer went or why it was withdrawn. What the question blocked while it waited is not repeated: it waits no more.
 */
@Composable
internal fun QuestionRecordReview(card: InteractionCard, open: (String) -> Unit) {
    val record = card.source
    val question = record.obj("question")
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxSize().testTag(card.key)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp).testTag("${card.key}:replay"),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(CoordinatorQuestions.provenance, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = secondary)
                CoordinatorQuestions.askedAtLine(record)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary) }
            }
            MarkdownText(question?.text("question").orEmpty(), open = open)
            val chosen = CoordinatorQuestions.chosenOption(record)
            question?.objects("options").orEmpty().forEachIndexed { index, option ->
                ReplayOption("${card.key}:option:$index", option.text("label").orEmpty(), option.text("description"),
                    recommended = index == question?.number("recommendedOption"), chosen = chosen == index,
                    words = if (chosen == index) CoordinatorQuestions.note(record) else null, wordsLabel = CoordinatorQuestions.yourNote)
            }
            if (CoordinatorQuestions.choseOther(record)) ReplayOption("${card.key}:option:other", CoordinatorQuestions.otherOption, null,
                recommended = false, chosen = true, words = CoordinatorQuestions.ownWords(record), wordsLabel = null)
            if (question?.objects("options").isNullOrEmpty()) CoordinatorQuestions.ownWords(record)?.let {
                Words("${card.key}:own", CoordinatorQuestions.freeAnswerPrompt, it, MaterialTheme.colorScheme.primary.copy(alpha = 0.08f))
            }
        }
        HorizontalDivider()
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).testTag("${card.key}:footer"),
            verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val withdrawn = CoordinatorQuestions.withdrawn(record)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(painterResource(if (withdrawn) R.drawable.ic_back else R.drawable.ic_check_circle), null, Modifier.size(16.dp),
                    tint = if (withdrawn) secondary else LocalOrbitColors.current.success)
                Text(CoordinatorQuestions.footerLine(record), Modifier.testTag("${card.key}:footer-line"),
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
            }
            CoordinatorQuestions.footerDetail(record)?.let {
                Text(it, Modifier.padding(start = 22.dp).testTag("${card.key}:footer-detail"), style = MaterialTheme.typography.bodySmall,
                    color = if (CoordinatorQuestions.waitingLine(record) != null) LocalOrbitColors.current.needsYou else secondary)
            }
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

/** The owner's own words, read-only: a note on the chosen option, the Other row's answer, or a free answer. */
@Composable
private fun Words(tag: String, label: String?, words: String, background: Color?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().background(background ?: MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
        .padding(horizontal = 10.dp, vertical = 8.dp).testTag(tag), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        label?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Text(words, style = MaterialTheme.typography.bodyMedium)
    }
}
