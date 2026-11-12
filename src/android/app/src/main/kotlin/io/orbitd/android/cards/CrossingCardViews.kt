package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.text
import io.orbitd.android.projects.CrossingBatch
import io.orbitd.android.projects.CrossingCards
import io.orbitd.android.projects.CrossingReceipt
import io.orbitd.android.projects.ProjectCrossings
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay

/**
 * A batch of cross-project requests where its target project's coordinator conversation was asked them: the criteria decision's
 * compact card ("Weaken this ruler?", [CardPreviewView]) — a swap glyph, the question, its badge, who asks for what, and "View details
 * & act" — in the orange tone. An answered one is dimmed, says "View details", and has its receipt under it.
 */
@Composable
fun CrossingCardView(batch: CrossingBatch, state: CrossingCardStore.State, onOpen: () -> Unit) {
    val tone = LocalOrbitColors.current.needsYou
    val receipt = state.receipt(batch)
    val refused = state.refused(batch).size
    Column(Modifier.fillMaxWidth().testTag(batch.id), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.fillMaxWidth().alpha(if (batch.live) 1f else 0.72f)
            .background(tone.copy(alpha = 0.07f), RoundedCornerShape(14.dp)).border(1.dp, tone.copy(alpha = 0.28f), RoundedCornerShape(14.dp))
            .clickable(role = Role.Button, onClick = onOpen).testTag("${batch.id}:preview").padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(22.dp).background(tone.copy(alpha = 0.16f), RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
                    Icon(painterResource(R.drawable.ic_swap), null, Modifier.size(14.dp), tint = tone)
                }
                Text(CrossingCards.title(batch), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold),
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(CrossingCards.badge(batch), Modifier.background(tone.copy(alpha = 0.16f), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp)
                    .testTag("${batch.id}:badge"), style = MaterialTheme.typography.labelSmall, color = tone, maxLines = 1)
            }
            Text(CrossingCards.summary(batch), Modifier.testTag("${batch.id}:summary"), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (batch.live && refused > 0) Text(CrossingCards.notRecorded(refused), Modifier.testTag("${batch.id}:not-recorded"),
                style = MaterialTheme.typography.bodySmall, color = tone)
            if (batch.live) state.batchRefusals[batch.id]?.let { BatchRefusal(it, "${batch.id}:refused") }
            HorizontalDivider(color = tone.copy(alpha = 0.28f))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(CrossingCards.link(batch), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = MaterialTheme.colorScheme.primary)
                Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.primary)
            }
        }
        receipt?.let { ReceiptLine(it, Modifier.padding(horizontal = 4.dp).testTag("${batch.id}:receipt")) }
    }
}

/** The batch door's refusal of a move batch's one answer: its code and its sentence, which names every move whose crossing key no
 * longer matched. Nothing was written, so the card still asks. */
@Composable
private fun BatchRefusal(refusal: ProjectCrossings.Refusal, tag: String) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.error.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).padding(8.dp).testTag(tag),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(CrossingCards.refusalHead(refusal), Modifier.testTag("$tag:head"), style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.error)
        Text(refusal.message, style = MaterialTheme.typography.bodySmall)
    }
}

/** "Decision recorded · ✓ Approved by you at 17:34", the outcome in green when it approved; "Refused at another end". */
@Composable
private fun ReceiptLine(receipt: CrossingReceipt, modifier: Modifier = Modifier) {
    val outcome = if (receipt.verdict == CrossingCards.Verdict.APPROVED && receipt.head != null) LocalOrbitColors.current.success
        else MaterialTheme.colorScheme.onSurfaceVariant
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Text(buildAnnotatedString {
        receipt.head?.let { withStyle(SpanStyle(color = secondary)) { append("$it · ") } }
        withStyle(SpanStyle(color = outcome, fontWeight = FontWeight.SemiBold)) { append(receipt.outcome) }
    }, modifier, style = MaterialTheme.typography.bodyMedium)
}

/** The review a crossing card opens, hosted by the reader beside the other cards' reviews so the transcript's rows cannot dismiss it.
 * After this window's own answer is recorded it leaves on its own about 2 s later, as every card review does (`CardReviewSheet`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CrossingReviewSheet(store: CrossingCardStore, projectId: String?, sessionId: String?) {
    val state by store.state.collectAsState()
    val open = state.review ?: return
    val batch = state.batches(projectId, sessionId).firstOrNull { it.id == open }
    LaunchedEffect(batch == null) { if (batch == null) store.close() }
    if (batch == null) return
    var pressedHere by remember(open) { mutableStateOf(false) }
    LaunchedEffect(pressedHere, batch.live) { if (pressedHere && !batch.live) { delay(2_000); store.close() } }
    ModalBottomSheet(onDismissRequest = { store.close() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        dragHandle = { BottomSheetDefaults.DragHandle() }) {
        CrossingReview(batch, state, close = { store.close() }) { approve -> pressedHere = true; store.decide(projectId, sessionId, batch, approve) }
    }
}

/**
 * The review page (the criteria decision's, iOS `CriteriaDecisionCard`'s layout): the question, "move · 8 waiting", Orbit's word that
 * this is not the agent speaking, both ends, the tasks — three, then "Show k more" — each with the criteria it asks for and serves and,
 * for a row the door refused, its words; the reasons given; what a yes does; Approve and Refuse pinned under it while it asks, the
 * receipt in their place once it is answered.
 */
@Composable
fun CrossingReview(batch: CrossingBatch, state: CrossingCardStore.State, close: () -> Unit, answer: (Boolean) -> Unit) {
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val sending = batch.id in state.sending
    var all by remember(batch.id) { mutableStateOf(false) }
    val tag = "${batch.id}:review"
    Column(Modifier.fillMaxWidth().fillMaxHeight().testTag(tag)) {
        SheetHead(CrossingCards.title(batch), tag, close)
        HorizontalDivider()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (batch.live) Text(CrossingCards.waitingLine(batch), Modifier.testTag("$tag:waiting"),
                style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = tone)
            Text(CrossingCards.fromOrbit, style = MaterialTheme.typography.labelLarge, color = secondary)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(buildAnnotatedString { withStyle(SpanStyle(color = secondary)) { append("From ") }; append(CrossingCards.sourceTitle(batch)) },
                    Modifier.testTag("$tag:from"), style = MaterialTheme.typography.bodyMedium)
                Text(buildAnnotatedString { withStyle(SpanStyle(color = secondary)) { append("To ") }; append(CrossingCards.toText(batch)) },
                    Modifier.testTag("$tag:to"), style = MaterialTheme.typography.bodyMedium)
            }
            Text(CrossingCards.listHead(batch), style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = secondary)
            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                    val shown = if (all) batch.rows else batch.rows.take(CrossingCards.shownRows)
                    shown.forEachIndexed { index, row ->
                        if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        CrossingRow(row, state.refusals[ProjectCrossings.doorId(row)].takeIf { ProjectCrossings.isAnswerable(row.text("state")) },
                            "$tag:row:${ProjectCrossings.doorId(row)}")
                    }
                    if (!all) CrossingCards.showMore(batch)?.let { more ->
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        Text(more, Modifier.fillMaxWidth().clickable(role = Role.Button) { all = true }.padding(vertical = 10.dp).testTag("$tag:more"),
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            CrossingCards.reasons(batch).forEach { reason ->
                Text(reason, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp))
                    .padding(horizontal = 10.dp, vertical = 8.dp), style = MaterialTheme.typography.bodyMedium)
            }
            Text(CrossingCards.consequence(batch), Modifier.testTag("$tag:consequence"), style = MaterialTheme.typography.bodySmall, color = secondary)
            if (batch.live) state.batchRefusals[batch.id]?.let { BatchRefusal(it, "$tag:refused") }
        }
        HorizontalDivider()
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val receipt = state.receipt(batch)
            if (receipt != null) ReceiptLine(receipt, Modifier.align(Alignment.CenterHorizontally).testTag("$tag:receipt"))
            else {
                Button(onClick = { answer(true) }, enabled = batch.live && !sending,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag:approve")) { Text(CrossingCards.approve) }
                OutlinedButton(onClick = { answer(false) }, enabled = batch.live && !sending,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag:refuse")) { Text(CrossingCards.refuse) }
            }
        }
    }
}

/** One crossing in the review's list: its subject, the criteria lines, its state once answered, and the door's refusal. */
@Composable
private fun CrossingRow(row: kotlinx.serialization.json.JsonObject, refusal: ProjectCrossings.Refusal?, tag: String) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag(tag), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(CrossingCards.subject(row), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        CrossingCards.rowNotes(row).forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = secondary) }
        refusal?.let {
            Text(CrossingCards.refusalHead(it), Modifier.testTag("$tag:refused"), style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold),
                color = MaterialTheme.colorScheme.error)
            Text(it.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
    }
}
