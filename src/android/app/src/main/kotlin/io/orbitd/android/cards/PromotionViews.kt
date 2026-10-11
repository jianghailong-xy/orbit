package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant
import kotlinx.serialization.json.JsonObject

// The merge into main where the conversation and the project's sessions page share it (iOS 6b4bef713): the conversation's one line
// per moment, the review both open, and the receipt a merge leaves.

/** The words a press opening the review or the receipt is read with. */
internal object PromotionHints {
    const val review = "Opens the merge review"
    const val receipt = "Opens the merge's receipt"
}

/** The tone's ink: orange while it waits on the reader or cannot merge, the brand blue while it merges, grey for a record. */
@Composable
internal fun PromotionTone.ink(): Color = when (this) {
    PromotionTone.NEEDS_YOU, PromotionTone.BLOCKED -> LocalOrbitColors.current.needsYou
    PromotionTone.WORKING -> MaterialTheme.colorScheme.primary
    PromotionTone.QUIET -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** A candidate's one line in the coordinator conversation, where its card used to be drawn (iOS `PromotionEventLine`): the card is on
 * the project's sessions page now. The same state in the same words as that card, and it opens the same review. A candidate the
 * server no longer publishes ([view] null) says it is no longer on offer. [lineTag] names the press. */
@Composable
internal fun PromotionEventLine(view: JsonObject?, lineTag: String, modifier: Modifier = Modifier, onOpen: () -> Unit) {
    val (text, tone) = PromotionCards.eventLine(view)
    val ink = tone.ink()
    val icon = when (tone) {
        PromotionTone.WORKING -> R.drawable.ic_sync
        PromotionTone.BLOCKED -> R.drawable.ic_warning
        else -> R.drawable.ic_merge
    }
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Row(Modifier.background(ink.copy(alpha = if (tone == PromotionTone.QUIET) 0.1f else 0.13f), RoundedCornerShape(50))
            .clickable(role = Role.Button, onClickLabel = PromotionHints.review, onClick = onOpen).heightIn(min = 36.dp)
            .padding(horizontal = 12.dp, vertical = 6.dp).testTag(lineTag),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(icon), null, Modifier.size(14.dp), tint = ink)
            Text(text, Modifier.weight(1f, fill = false), color = ink, maxLines = 2, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelLarge, fontWeight = if (tone == PromotionTone.QUIET) FontWeight.Normal else FontWeight.SemiBold)
            if (tone == PromotionTone.NEEDS_YOU) Text("· ${PromotionCards.review}", color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1)
            Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp),
                tint = if (tone == PromotionTone.NEEDS_YOU) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The record a merge leaves in the conversation, at its moment (iOS `PromotionReceiptLine`): one line where a card used to sit. Its
 * one press, [lineTag], opens the record; nothing on it decides anything. */
@Composable
internal fun PromotionReceiptLine(promotion: JsonObject, lineTag: String, modifier: Modifier = Modifier, onOpen: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Row(Modifier.background(muted.copy(alpha = 0.1f), RoundedCornerShape(50))
            .clickable(role = Role.Button, onClickLabel = PromotionHints.receipt, onClick = onOpen).heightIn(min = 36.dp)
            .padding(horizontal = 12.dp, vertical = 6.dp).testTag(lineTag),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(PromotionCards.receiptLine(promotion), Modifier.weight(1f, fill = false), color = muted, maxLines = 2,
                overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge)
            Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp), tint = muted)
        }
    }
}

/** What a merge put on main, who merged it and when, and what was run on it (iOS `PromotionReceiptSheet`): read off the merge's own
 * row, never off the candidate the branch is offering now. Opened from the conversation's line and the sessions page's timeline. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PromotionReceiptSheet(promotion: JsonObject, close: () -> Unit) {
    ModalBottomSheet(onDismissRequest = close, modifier = Modifier.testTag("promotion-receipt")) {
        SheetHead(PromotionCards.title(promotion), "promotion-receipt", close)
        HorizontalDivider()
        SelectionContainer {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Provenance()
                PromotionRow("Commit", PromotionCards.mergedLine(promotion))
                PromotionTasksRow(PromotionCards.nowOn(PromotionCards.mainBranch(promotion)), PromotionCards.nowOnMainLine(promotion), PromotionCards.allTaskTitles(promotion))
                PromotionRow("Checks", PromotionCards.checksLine(promotion))
                PromotionRow("Landed", PromotionCards.landsLine(promotion))
                PromotionCards.changesLine(promotion)?.let { PromotionRow("Changes", it) }
                PromotionCards.revertLine(promotion)?.let { PromotionRow("Undo", it) }
            }
        }
    }
}

/** The title row of the merge's sheets: the title and a ✕ that closes. */
@Composable
internal fun SheetHead(title: String, tag: String, close: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f).semantics { heading() }.testTag("$tag:title"), style = MaterialTheme.typography.titleMedium,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
        IconButton(onClick = close, modifier = Modifier.testTag("$tag:close")) { Icon(painterResource(R.drawable.ic_close), CardPreviews.close) }
    }
}

/**
 * The merge review (iOS `PromotionReviewSheet`'s page and its presses), whichever host opened it: the coordinator conversation's line
 * or the sessions page's Details. What it says is the candidate as the host last read it — nothing at all once that candidate is no
 * longer on offer — and its presses are the host's: confirm and decline while it asks, cancel while it merges and its job has not
 * reached the push, and for a blocked one a press that reads who has it. [tag] prefixes the presses' tags.
 */
@Composable
internal fun PromotionReview(view: JsonObject?, criteriaMet: Pair<Int, Int>?, holder: PromotionHolder, acting: Boolean, error: String?,
    tag: String, confirm: () -> Unit, decline: () -> Unit, cancel: () -> Unit, enabled: Boolean = true, now: Instant = Instant.now()) {
    val pressable = enabled && !acting
    val stage = PromotionCards.stage(view)
    Column(Modifier.fillMaxSize().testTag("promotion-review")) {
        SelectionContainer(Modifier.weight(1f)) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Provenance()
                if (view == null || stage == null) Text(PromotionCards.superseded, Modifier.testTag("$tag:superseded"),
                    style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else {
                    if (stage != PromotionStage.ASKING_YOU) PromotionRow("Branch", PromotionCards.shortRef(view.text("sourceRef").orEmpty()))
                    when (stage) {
                        PromotionStage.ASKING_YOU -> {
                            PromotionRow("Branch", PromotionCards.branchLine(view))
                            PromotionTasksRow("Tasks", PromotionCards.tasksLine(view), PromotionCards.allTaskTitles(view))
                            PromotionRow("Checks", PromotionCards.checksLine(view))
                            PromotionRow(PromotionCards.shortRef(view.text("upstreamRef") ?: "main"), PromotionCards.upstreamLine(view))
                            criteriaMet?.let { (met, total) -> PromotionCards.criteriaLine(met, total) }?.let { PromotionRow("Criteria", it) }
                            PromotionRow("Lands", PromotionCards.landsLine(view))
                            // A count rather than a button: this client has no diff view.
                            view.number("filesChanged")?.let { PromotionRow("Changes", "$it file${if (it == 1) "" else "s"}") }
                            PromotionCards.askedLine(view, now)?.let {
                                Text(it, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        PromotionStage.MERGING -> {
                            PromotionRow("Status", PromotionCards.mergingStatusLine(view))
                            PromotionRow("You", PromotionCards.nothingToDo)
                        }
                        PromotionStage.MERGED -> {
                            PromotionRow("Commit", PromotionCards.mergedLine(view, now))
                            PromotionTasksRow(PromotionCards.nowOn(PromotionCards.mainBranch(view)), PromotionCards.nowOnMainLine(view), PromotionCards.allTaskTitles(view))
                            PromotionCards.revertLine(view)?.let { PromotionRow("Undo", it) }
                        }
                        PromotionStage.BLOCKED -> PromotionRow("Why", PromotionCards.blockedLine(view))
                    }
                }
            }
        }
        val resolving = if (stage == PromotionStage.BLOCKED) PromotionCards.resolvingLine(holder, now) else null
        if (acting || error != null || stage == PromotionStage.ASKING_YOU || stage == PromotionStage.MERGING || resolving != null) {
            HorizontalDivider()
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                error?.let { Text(it, Modifier.testTag("$tag:error"), color = MaterialTheme.colorScheme.error, maxLines = 3,
                    overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium) }
                if (acting) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text("Working…", style = MaterialTheme.typography.labelLarge)
                }
                when (stage) {
                    PromotionStage.ASKING_YOU -> {
                        Button(onClick = confirm, enabled = pressable && PromotionCards.confirmable(view),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag:CONFIRM_MERGE")) {
                            Text(view?.let { PromotionCards.mergeTo(PromotionCards.mainBranch(it)) } ?: PromotionCards.mergeToMain) }
                        OutlinedButton(onClick = decline, enabled = pressable,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag:DECLINE_MERGE")) { Text(PromotionCards.notNow) }
                    }
                    // Its dead press says how far its job got, beside the Cancel it still offers until the push.
                    PromotionStage.MERGING -> view?.let { merging ->
                        Button(onClick = {}, enabled = false, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag:merging")) {
                            Text(PromotionCards.mergingActionLabel(merging))
                        }
                        OutlinedButton(onClick = cancel, enabled = pressable && PromotionCards.cancellable(merging),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag:CANCEL_MERGE")) { Text(PromotionCards.cancel) }
                    }
                    // The press reads rather than acts: who has the branch and for how long. Nobody holding it draws none.
                    PromotionStage.BLOCKED -> resolving?.let { line ->
                        Button(onClick = {}, enabled = false, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag:resolving")) {
                            if (PromotionCards.resolvingSpins(holder)) {
                                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp); Spacer(Modifier.width(6.dp))
                            }
                            Text(line)
                        }
                    }
                    else -> Unit
                }
            }
        }
    }
}

/** §7.5's provenance mark, at the head of the review and the receipt. */
@Composable
private fun Provenance() = Text(PromotionCards.provenance, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)

/** One row of the review or the receipt: its label over its value (iOS `CardRow`). */
@Composable
internal fun PromotionRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
}

/** The row that names what a merge carries (iOS `PromotionTasksRow`): the count, then each task by its title — a server older than
 * `tasks` gives the count alone. */
@Composable
internal fun PromotionTasksRow(label: String, summary: String, titles: List<String>) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(summary, style = MaterialTheme.typography.bodyLarge)
        titles.forEach { title ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("•", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge)
                Text(title, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Start)
            }
        }
    }
}
