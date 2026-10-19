package io.orbitd.android.reader

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.core.cards.CardQuestion
import io.orbitd.android.core.cards.QuestionOption
import io.orbitd.android.core.cards.QuestionRecords

// An agent's question (AskUserQuestion) once it has ended, as the transcript's tool card draws it (A06-15, iOS 94f61b52c and
// 010e59792, `QuestionRecordViews.swift`). Folded, the card is the record: what was asked, in its opening, and how it was
// answered. Opened, it replays every question and option as they were offered, the pick ticked. How it ended is read off the
// result (`QuestionRecords`); every word is shared with the browser and OrbitKit (`question-record.fixture.json`).

/** The folded card's lines: each question's opening, then its answer. One question keeps two lines of its opening and several
 * keep one each, so the card stays a record instead of becoming the replay. */
@Composable
internal fun QuestionFoldedLines(questions: List<CardQuestion>, outcome: QuestionRecords.Outcome?, modifier: Modifier = Modifier) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(modifier.fillMaxWidth().testTag("question-record"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        questions.forEachIndexed { index, question ->
            Text(QuestionRecords.lead(question.question), Modifier.padding(top = if (index > 0) 4.dp else 0.dp),
                color = secondary, style = MaterialTheme.typography.labelLarge, maxLines = if (questions.size > 1) 1 else 2,
                overflow = TextOverflow.Ellipsis)
            QuestionRecords.answerLine(question, (outcome as? QuestionRecords.Outcome.Answered)?.answers?.getOrNull(index))?.let { line ->
                AnswerRow({ PickGlyph(picked = true, square = false) }) {
                    Text(line, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        if (outcome is QuestionRecords.Outcome.Replied) AnswerRow({ ReplyGlyph() }) {
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(QuestionRecords.replyLine(outcome.words), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(QuestionRecords.REPLIED_IN_CHAT, color = secondary, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
private fun AnswerRow(glyph: @Composable () -> Unit, words: @Composable () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 3.dp)) { glyph() }
        words()
    }
}

/**
 * The opened card: every question as it was asked and every option as it was offered, with its whole description — the pick
 * ticked on a light tint, the rest grey but readable — then the words typed instead of an option, or the reply given in the
 * conversation instead of any. Nothing here is cut to a line count: a replay that drops the end of a sentence is not one
 * (iOS 010e59792).
 */
@Composable
internal fun QuestionReplay(questions: List<CardQuestion>, outcome: QuestionRecords.Outcome?) {
    Column(Modifier.fillMaxWidth().testTag("question-replay"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        questions.forEachIndexed { index, question ->
            if (index > 0) HorizontalDivider(Modifier.padding(vertical = 2.dp))
            QuestionBlock(question, (outcome as? QuestionRecords.Outcome.Answered)?.answers?.getOrNull(index), several = questions.size > 1)
        }
        if (outcome is QuestionRecords.Outcome.Replied) WordsBox(QuestionRecords.REPLIED_IN_CHAT, outcome.words)
    }
}

@Composable
private fun QuestionBlock(question: CardQuestion, answer: QuestionRecords.Answer?, several: Boolean) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    // A header is the only way to tell several questions apart at a glance; one question's header is already in the row.
    // "Multiple choice" sits on that line, as it does when asked.
    val header = question.header?.takeIf { it.isNotEmpty() && several }
    if (header != null || question.multiSelect) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        header?.let { Text(it.uppercase(), color = secondary, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, letterSpacing = 0.4.sp) }
        if (question.multiSelect) Text(QuestionRecords.MULTIPLE_CHOICE, Modifier.background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f),
            RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp), color = secondary, style = MaterialTheme.typography.labelSmall)
    }
    SelectionContainer { Text(question.question, Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyMedium) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        question.options.forEachIndexed { index, option -> OptionRow(option, picked = answer?.picked?.contains(index) == true, square = question.multiSelect) }
    }
    answer?.typed?.let { WordsBox(QuestionRecords.YOUR_ANSWER, it) }
}

/** One option as it was offered, ticked when it is the answer. The glyph says what kind of question it was, as the asking card's
 * does: a square where several could be picked. */
@Composable
private fun OptionRow(option: QuestionOption, picked: Boolean, square: Boolean) {
    val tint = MaterialTheme.colorScheme.primary
    Row(Modifier.fillMaxWidth().background(if (picked) tint.copy(alpha = 0.08f) else Color.Transparent, RoundedCornerShape(8.dp))
        .semantics(mergeDescendants = true) { selected = picked }.padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 3.dp)) { PickGlyph(picked, square) }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(option.label, color = if (picked) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium)
            option.description?.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (picked) 1f else 0.75f), style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

/** The person's own words, read-only: typed instead of an option, or replied in the conversation. */
@Composable
private fun WordsBox(label: String, words: String) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
        .padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
        SelectionContainer { Text(words, style = MaterialTheme.typography.bodyMedium) }
    }
}

/** A circle for a one-pick question and a square for a several-pick one, filled and ticked when picked (iOS `checkmark.circle.fill`,
 * `circle`, `checkmark.square.fill`, `square`). Tagged with its shape and state, which is all a reader of the tree can see of it. */
@Composable
private fun PickGlyph(picked: Boolean, square: Boolean) {
    val tint = MaterialTheme.colorScheme.primary
    val outline = MaterialTheme.colorScheme.outline
    val onTint = MaterialTheme.colorScheme.onPrimary
    Canvas(Modifier.size(14.dp).clearAndSetSemantics { testTag = (if (square) "square" else "circle") + if (picked) "-picked" else "" }) {
        val stroke = 1.5.dp.toPx()
        if (square) {
            val radius = CornerRadius(3.dp.toPx())
            if (picked) drawRoundRect(tint, cornerRadius = radius)
            else drawRoundRect(outline, Offset(stroke / 2, stroke / 2), Size(size.width - stroke, size.height - stroke), radius, style = Stroke(stroke))
        } else {
            if (picked) drawCircle(tint) else drawCircle(outline, radius = (size.minDimension - stroke) / 2, style = Stroke(stroke))
        }
        if (picked) tick(onTint)
    }
}

private fun DrawScope.tick(color: Color) {
    val w = size.width
    val path = Path().apply { moveTo(w * 0.27f, w * 0.52f); lineTo(w * 0.44f, w * 0.68f); lineTo(w * 0.74f, w * 0.34f) }
    drawPath(path, color, style = Stroke(1.6.dp.toPx(), cap = StrokeCap.Round))
}

/** The speech bubble a reply given in the conversation carries in place of a tick (iOS `bubble.left.fill`). */
@Composable
private fun ReplyGlyph() {
    val tint = MaterialTheme.colorScheme.primary
    Canvas(Modifier.size(14.dp).clearAndSetSemantics { testTag = "reply" }) {
        val w = size.width
        drawRoundRect(tint, Offset(0f, 0f), Size(w, w * 0.78f), CornerRadius(w * 0.3f))
        drawPath(Path().apply { moveTo(w * 0.18f, w * 0.6f); lineTo(w * 0.12f, w); lineTo(w * 0.48f, w * 0.7f); close() }, tint)
    }
}
