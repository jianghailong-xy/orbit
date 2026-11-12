package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.text
import io.orbitd.android.projects.CrossingRow
import io.orbitd.android.projects.ProjectCrossings
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant
import kotlinx.serialization.json.JsonObject

/**
 * One batch of task moves in a conversation (board waiting-on-you-removal ②, iOS's move card). Waiting, it is the card: what it asks,
 * where from and who asked, each move with the criterion it asks for, the batch's two presses, and Show all — every move as the project
 * page's crossing row, answerable on its own. The second press lists the moves with the crossing key each answer sends and says what
 * follows. Answered, it is one line, like an answered owner request.
 */
@Composable
fun TaskMoveCard(batch: JsonObject, store: TaskMoveStore, now: Instant = Instant.now()) {
    if (!TaskMoves.pending(batch)) { TaskMoveResolved(batch, now); return }
    val state by store.state.collectAsState()
    val key = TaskMoves.key(batch)
    val tag = "task-moves:$key"
    val moves = TaskMoves.moves(batch)
    val n = moves.size
    val asking = state.asking?.takeIf { it.first == key }?.second
    val busy = state.busy == key
    val locked = state.busy != null && !busy
    val expanded = key in state.expanded
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag(tag)
        .background(tone.copy(alpha = 0.07f), RoundedCornerShape(14.dp)).border(1.dp, tone.copy(alpha = 0.28f), RoundedCornerShape(14.dp))
        .padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.size(28.dp).background(tone.copy(alpha = 0.18f), RoundedCornerShape(50)), contentAlignment = Alignment.Center) {
                Icon(painterResource(NeedsYouGlyph.HAND.drawable), null, Modifier.size(16.dp), tint = tone)
            }
            Text(if (asking != null) TaskMoves.question(n, asking) else TaskMoves.title(batch), Modifier.weight(1f).testTag("$tag:title"),
                style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        }
        if (asking == null) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(buildAnnotatedString {
                    withStyle(SpanStyle(color = secondary)) { append("From ") }
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(TaskMoves.fromTitle(batch)) }
                    TaskMoves.fromStatus(batch)?.let { withStyle(SpanStyle(color = secondary)) { append(" ($it)") } }
                }, Modifier.testTag("$tag:from"), style = MaterialTheme.typography.bodyMedium)
                Text(TaskMoves.askedLine(batch), Modifier.testTag("$tag:asked"), style = MaterialTheme.typography.bodySmall, color = secondary)
            }
            if (expanded) moves.forEach { row ->
                val id = row.text("id").orEmpty()
                CrossingRow(row, state.askingMove?.takeIf { it.first == id }?.second, busy = state.busy == id, locked = state.busy != null && state.busy != id,
                    connected = true, refusal = state.refusals[id], ask = { store.askMove(row, it) }, cancel = store::cancelMove,
                    answer = { store.answerMove(row, it) })
            } else moves.take(TaskMoves.shown).forEach { row -> MoveLine(row, TaskMoves.moveLine(row), "$tag:move:${row.text("id")}") }
            if (n > TaskMoves.shown) TextButton(onClick = { store.expand(batch, !expanded) }, Modifier.testTag("$tag:show-all"),
                contentPadding = PaddingValues(0.dp)) { Text(if (expanded) TaskMoves.showFewer else TaskMoves.showAll(n)) }
        } else {
            Text(buildAnnotatedString {
                withStyle(SpanStyle(color = secondary)) { append("From ") }
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(TaskMoves.fromTitle(batch)) }
                withStyle(SpanStyle(color = secondary)) { append(ProjectCrossings.arrow) }
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(TaskMoves.toTitle(batch)) }
            }, Modifier.testTag("$tag:route"), style = MaterialTheme.typography.bodyMedium)
            moves.take(TaskMoves.shown).forEach { row -> MoveLine(row, TaskMoves.keyLine(row), "$tag:confirm:${row.text("id")}") }
            if (n > TaskMoves.shown) Text(TaskMoves.andMore(n - TaskMoves.shown), Modifier.testTag("$tag:more"), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.primary)
            Text(TaskMoves.consequence(asking), Modifier.fillMaxWidth().background(tone.copy(alpha = 0.12f), RoundedCornerShape(8.dp)).padding(10.dp)
                .testTag("$tag:consequence"), style = MaterialTheme.typography.bodySmall)
        }
        state.refusals[key]?.let { refused ->
            Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.error.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).padding(8.dp)
                .testTag("$tag:refusal"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("⚠ ${ProjectCrossings.notRecorded}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.error)
                Text(buildAnnotatedString {
                    refused.code?.let { withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append("$it ") } }
                    append(refused.message)
                }, style = MaterialTheme.typography.labelMedium)
            }
        }
        // The board's two presses: a grey one and the amber one, each half the card, with room for "Approve 8 moves…".
        val quiet = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant,
            contentColor = MaterialTheme.colorScheme.primary)
        val tight = PaddingValues(horizontal = 8.dp, vertical = 8.dp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (asking == null) {
                FilledTonalButton(onClick = { store.ask(batch, false) }, Modifier.weight(1f).testTag("$tag:refuse"), enabled = !locked,
                    colors = quiet, contentPadding = tight) {
                    Text(TaskMoves.refuseAsk, color = if (locked) androidx.compose.ui.graphics.Color.Unspecified else MaterialTheme.colorScheme.error)
                }
                Button(onClick = { store.ask(batch, true) }, Modifier.weight(1f).testTag("$tag:approve"), enabled = !locked, contentPadding = tight,
                    colors = ButtonDefaults.buttonColors(containerColor = tone, contentColor = androidx.compose.ui.graphics.Color.Black)) {
                    Text(TaskMoves.approveAsk(n), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            } else {
                FilledTonalButton(onClick = store::cancel, Modifier.weight(1f).testTag("$tag:cancel"), enabled = !busy, colors = quiet, contentPadding = tight) { Text(ProjectCrossings.cancel) }
                Button(onClick = { store.answer(batch, asking) }, Modifier.weight(1f).testTag("$tag:answer"), enabled = !busy && !locked, contentPadding = tight,
                    colors = ButtonDefaults.buttonColors(containerColor = if (asking) tone else MaterialTheme.colorScheme.error,
                        contentColor = if (asking) androidx.compose.ui.graphics.Color.Black else MaterialTheme.colorScheme.onError)) {
                    if (busy) { CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp); Spacer(Modifier.width(6.dp)) }
                    Text(TaskMoves.confirmLabel(n, asking), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** One move in the card: the task as it reads now, and the line under it. */
@Composable
private fun MoveLine(row: JsonObject, line: String, tag: String) {
    HorizontalDivider()
    Column(Modifier.fillMaxWidth().testTag(tag), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(ProjectCrossings.subjectTitle(row), style = MaterialTheme.typography.bodyMedium)
        Text(line, Modifier.testTag("$tag:line"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** An answered batch: one line, as an answered owner request is ([OwnerRequestResolved]). */
@Composable
fun TaskMoveResolved(batch: JsonObject, now: Instant = Instant.now()) {
    val tag = "task-moves:${TaskMoves.key(batch)}"
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val (icon, tint) = when (batch.text("state")) {
        "APPLIED", "APPROVED" -> R.drawable.ic_check_circle to LocalOrbitColors.current.success
        else -> R.drawable.ic_x_circle to secondary
    }
    Row(Modifier.fillMaxWidth().testTag("$tag:resolved").background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
        .padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(painterResource(icon), null, Modifier.size(18.dp), tint = tint)
        Text(TaskMoves.resolvedLine(batch), Modifier.weight(1f).testTag("$tag:resolved-line"), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
            maxLines = 2, overflow = TextOverflow.Ellipsis)
        TaskMoves.resolvedTime(batch, now)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary) }
    }
}
