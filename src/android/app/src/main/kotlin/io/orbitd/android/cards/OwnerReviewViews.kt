package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.tasks.TaskReopenCopy
import io.orbitd.android.text.MarkdownText
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject

/**
 * The reviewer's box on an owner-confirmation card (A08-1; iOS `OwnerConfirmationReviewBarView`): every line is one
 * [OwnerReview.bar] made — the same lines the web and the Apple clients draw, held to the shared fixture. On the card it carries
 * the answer blocks for the reviewer's questions ([answers], at the ANSWERS line); under a receipt it offers Reopen task.
 */
@Composable
internal fun ReviewBarView(review: JsonObject, place: OwnerReview.Place, answers: (@Composable () -> Unit)? = null,
    reopen: (() -> Unit)? = null) {
    val bar = OwnerReview.bar(review, place) { OwnerReview.receiptTime(it) }
    val items = remember(review) { OwnerReview.itemsByKey(review) }
    var oldOpen by rememberSaveable(review.text("reviewId")) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().testTag("review-bar").background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(8.dp))
        .padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ReviewBarHead(bar)
        bar.lines.forEach { ReviewBarLine(it, items, answers) }
        if (bar.folded.isNotEmpty()) {
            Disclosure(OwnerReview.showOldReview, oldOpen, "review-bar:old") { oldOpen = !oldOpen }
            if (oldOpen) bar.folded.forEach { ReviewBarLine(it, items, null) }
        }
        if (bar.reopen && reopen != null) OutlinedButton(onClick = reopen, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("review-bar:reopen")) {
            Text(TaskReopenCopy.actionLabel)
        }
    }
}

/** `REVIEW · <reviewer> · <time>`, the reviewer's name giving way before the label or the time, and the commit at the right —
 * struck through once the record no longer describes what is waiting. */
@Composable
private fun ReviewBarHead(bar: OwnerReview.Bar) {
    val style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace)
    val tone = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f)) {
            Text("${OwnerReview.reviewHeading} · ", style = style, color = tone, maxLines = 1)
            Text(bar.reviewer, Modifier.weight(1f, fill = false), style = style, color = tone, maxLines = 1, overflow = TextOverflow.Ellipsis)
            bar.time?.let { Text(" · $it", style = style, color = tone, maxLines = 1) }
        }
        bar.sha?.let {
            Spacer(Modifier.width(8.dp))
            Text(it, Modifier.testTag("review-bar:sha"), style = style.copy(textDecoration = if (bar.shaStruck) TextDecoration.LineThrough else null),
                color = tone, maxLines = 1)
        }
    }
}

@Composable
private fun ReviewBarLine(line: OwnerReview.Line, items: Map<String, JsonObject>, answers: (@Composable () -> Unit)?) {
    val warn = LocalOrbitColors.current.needsYou
    val emphasis = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold)
    when (line.kind) {
        "STATUS" -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            line.icon?.let { icon ->
                Icon(painterResource(if (icon == "CLOCK") R.drawable.ic_clock else R.drawable.ic_remove_circle), null,
                    Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(line.text, style = emphasis, color = if (line.warn == true) warn else MaterialTheme.colorScheme.onSurface)
        }
        "NOTE", "FOOTER" -> Text(line.text, Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        // Orbit's first line: one line, the whole of it in the lines below.
        "HEADLINE" -> Text(line.text, Modifier.fillMaxWidth().testTag("review-bar:headline"), style = emphasis,
            color = if (line.warn == true) warn else MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
        "ANSWERS" -> answers?.invoke()
        "ROW" -> ReviewRow(line, line.keys.orEmpty().mapNotNull { items[it] })
        "QUOTE" -> Text("“${line.text}”", Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyLarge)
    }
}

/** One of the reviewer's lists: its lines joined, two lines at most, opening in place to each line with what it rests on. The
 * whole row is the press. */
@Composable
private fun ReviewRow(line: OwnerReview.Line, items: List<JsonObject>) {
    var open by rememberSaveable(line.row, line.keys?.joinToString()) { mutableStateOf(false) }
    val tone = when (line.row) {
        "CHECKED" -> LocalOrbitColors.current.success
        "NOT_CHECKED", "PROBLEM" -> LocalOrbitColors.current.needsYou
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { open = !open }.testTag("review-row:${line.row}:${line.keys?.firstOrNull()}"),
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(line.label.orEmpty(), Modifier.width(84.dp), style = MaterialTheme.typography.bodySmall, color = tone)
        if (open) Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items.forEach { item ->
                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(item.text("text").orEmpty(), style = MaterialTheme.typography.bodyMedium)
                    item.text("whyNotProven")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    item.text("coordinatorChecked")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    item.strings("evidenceRefs").forEach {
                        Text(it, style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        } else Text(line.text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** A plain fold toggle with a chevron, as iOS's `DisclosureToggle`. */
@Composable
internal fun Disclosure(label: String, open: Boolean, tag: String, toggle: () -> Unit) {
    Row(Modifier.clickable(role = Role.Button, onClick = toggle).heightIn(min = 32.dp).testTag(tag), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.size(12.dp).rotate(if (open) 180f else 0f), tint = MaterialTheme.colorScheme.primary)
    }
}

/**
 * One block per question only the owner can decide (iOS `ReviewAnswerBlocks`): its evidence, its options with the recommendation
 * chosen and marked, then a row for the owner's own words. The first question's words are the bar's first line already, so its
 * block starts at its options.
 */
@Composable
internal fun ReviewAnswerBlocks(questions: List<JsonObject>, choices: List<OwnerAnswer>, enabled: Boolean, choose: (OwnerAnswer) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        questions.forEachIndexed { index, question ->
            val id = question.text("key") ?: return@forEachIndexed
            val chosen = OwnerReview.choice(question, choices)
            key(id) {
                Column(Modifier.testTag("owner-question:$id"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (index > 0) Text(question.text("text").orEmpty(), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold))
                    val refs = question.strings("evidenceRefs")
                    if (refs.isNotEmpty()) {
                        var open by rememberSaveable(id) { mutableStateOf(false) }
                        Disclosure(OwnerReview.reviewEvidence, open, "owner-question:$id:evidence") { open = !open }
                        if (open) refs.forEach {
                            Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    question.objects("options").forEachIndexed { option, choice ->
                        ReviewChoiceRow(choice.text("label").orEmpty(), choice.text("description"), chosen.option == option, enabled,
                            recommended = option == question.number("recommendedOption")) { choose(OwnerAnswer(id, option)) }
                    }
                    ReviewChoiceRow(OwnerReview.otherOwnWords, null, chosen.option == null, enabled) {
                        if (chosen.option != null) choose(OwnerAnswer(id, text = ""))
                    }
                    if (chosen.option == null) OutlinedTextField(chosen.text.orEmpty(), { choose(OwnerAnswer(id, text = it)) },
                        Modifier.fillMaxWidth().testTag("owner-question:$id:other"), enabled = enabled, minLines = 2, maxLines = 8,
                        placeholder = { Text(question.text("text").orEmpty()) })
                }
            }
        }
        Text(OwnerReview.answersSentWithConfirm, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ReviewChoiceRow(label: String, description: String?, selected: Boolean, enabled: Boolean, recommended: Boolean = false, choose: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected, enabled, role = Role.RadioButton, onClick = choose).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        RadioButton(selected, null, enabled = enabled)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyLarge)
                if (recommended) Text(OwnerReview.recommended, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
            }
            description?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/**
 * What a decision left in the conversation it was made in (iOS `OwnerDecisionReceiptView`): the task, who answered and when,
 * whether the review came in after, the review as it stands now — with Reopen task once the task has settled and the review found
 * problems — the owner's answers, and for a confirmation what counted as done. [view] is the confirmation read it came from.
 */
@Composable
internal fun OwnerDecisionReceiptBody(decided: JsonObject, view: JsonObject, open: (String) -> Unit, reopen: (() -> Unit)?) {
    val confirmed = decided.text("decision") == "CONFIRM"
    var settledOpen by rememberSaveable(decided.text("id")) { mutableStateOf(false) }
    Text(view.text("title").orEmpty(), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold))
    Text(OwnerReview.receiptLine(decided, decided.text("decidedAt")?.let { OwnerReview.receiptTime(it) }), Modifier.testTag("owner-receipt:line"),
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (OwnerReview.cameInAfter(decided)) Text(OwnerReview.beforeReview, style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant)
    OwnerReview.readable(decided["review"])?.let { review -> ReviewBarView(review, OwnerReview.Place.RECEIPT, reopen = reopen) }
    val answers = OwnerReview.answerLines(decided)
    if (answers.isNotEmpty()) Column(Modifier.testTag("owner-receipt:answers"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(OwnerReview.yourAnswers, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold))
        answers.forEach { (line, notShown) ->
            Text(line, style = MaterialTheme.typography.bodySmall)
            if (notShown) Text(OwnerReview.answerNotShown, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (confirmed) {
        Disclosure(if (settledOpen) "${OwnerReview.hideWhatSettledIt} ▴" else "${OwnerReview.showWhatSettledIt} ▾", settledOpen, "owner-receipt:settled") {
            settledOpen = !settledOpen
        }
        if (settledOpen) {
            view.text("acceptanceCriteria")?.takeIf { it.isNotBlank() }?.let { MarkdownText(it, open = open) }
            decided.obj("report")?.text("text")?.takeIf { it.isNotBlank() }?.let { MarkdownText(it, open = open) }
        }
    }
}

/** The owner's answers on the card, and the way to change one (iOS `answers(review)`): kept per card version by the card. */
internal class OwnerForm(val choices: List<OwnerAnswer>, val enabled: Boolean, val choose: (OwnerAnswer) -> Unit)

/**
 * The owner-confirmation card's body in its three shapes (A08-1): the question — the task, what counts as done, what the agent
 * said, the reviewer's box with the answer blocks, what confirming sets off; the receipt a decision left; and the record a
 * reviewer's return left, which asks nothing and draws no buttons.
 */
@Composable
internal fun OwnerCardBody(card: InteractionCard, open: (String) -> Unit, owner: OwnerForm?, reopen: (() -> Unit)?) {
    val view = card.context.obj("view") ?: card.source
    when (card.context.text("ownerCard")) {
        "receipt" -> OwnerDecisionReceiptBody(card.source, view, open, reopen)
        "returned" -> {
            Text(view.text("title").orEmpty(), style = MaterialTheme.typography.titleSmall)
            OwnerReview.readable(card.source["review"])?.let { ReviewBarView(it, OwnerReview.Place.CARD) }
        }
        else -> {
            Text(view.text("title").orEmpty(), style = MaterialTheme.typography.titleSmall)
            Field("Done when", view["acceptanceCriteria"], open)
            val waiting = view.obj("waiting")
            Field("The run's report", waiting?.obj("report")?.get("text"), open)
            // The reviewer's box, between what the agent said and what confirming sets off (contract §6 H1).
            OwnerReview.readable(waiting?.get("review"))?.let { review ->
                val questions = OwnerReview.questions(review)
                ReviewBarView(review, OwnerReview.Place.CARD, answers = if (owner == null || questions.isEmpty()) null else {
                    { ReviewAnswerBlocks(questions, owner.choices, owner.enabled, owner.choose) }
                })
            }
            Field("If confirmed", view["ifConfirmed"], open)
        }
    }
}

/** The two turns a review puts in a conversation (A08-1; iOS `ConfirmationReviewTurnCardViews`): the reviewer's own conversation
 * is asked to review ("Review requested"), and the run's conversation is told what came back ("Sent back by the reviewer"). */
@Composable
internal fun ReviewTurnCard(card: InteractionCard, ts: String?, open: (String) -> Unit) {
    val source = card.source
    val requested = card.key.endsWith(":confirmationReviewRequest")
    val tone = if (requested) MaterialTheme.colorScheme.primary else LocalOrbitColors.current.needsYou
    Column(Modifier.fillMaxWidth().testTag(if (requested) "review-requested" else "review-sent-back")
        .background(tone.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
        .border1(tone.copy(alpha = 0.30f)).padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(if (requested) R.drawable.ic_task else R.drawable.ic_back), null, Modifier.size(16.dp), tint = tone)
            Text(if (requested) OwnerReview.reviewRequested else OwnerReview.sentBackByReviewer, Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = tone)
            if (!requested) ts?.let { OwnerReview.receiptTime(it) }?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (requested) {
            val task = source.text("taskId")
            Text(source.text("title").orEmpty(), Modifier.then(if (task != null) Modifier.clickable(role = Role.Button) { open("orbit-task:$task") } else Modifier),
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
                color = if (task != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            source.text("dueAt")?.let { OwnerReview.receiptTime(it) }?.let {
                Text("Due $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            source.text("runSessionId")?.let { run ->
                OutlinedButton(onClick = { open("orbit-session:$run") }, Modifier.heightIn(min = 48.dp)) { Text(OwnerReview.openTaskSession) }
            }
        } else {
            val reviewer = OwnerReview.reviewerName(source.text("reviewerTitle"))
            val session = source.text("reviewerSessionId")
            Text(reviewer, Modifier.then(if (session != null) Modifier.clickable(role = Role.Button) { open("orbit-session:$session") } else Modifier),
                style = MaterialTheme.typography.bodyMedium, color = if (session != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            source.text("reason")?.takeIf { it.isNotBlank() }?.let { Text("“$it”", style = MaterialTheme.typography.bodyLarge) }
            source.objects("problems").forEach { problem ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(OwnerReview.reviewProblem, Modifier.width(64.dp), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.needsYou)
                    Text(problem.text("text").orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

private fun Modifier.border1(color: androidx.compose.ui.graphics.Color) =
    this.then(Modifier.border(1.dp, color, RoundedCornerShape(8.dp)))
