package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.tasks.TaskRunConflictCard
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * iOS `AutoRetryCardView` (baseline; ceaf27657 for A07-12): a failure that fixes itself — a spent account quota, or the provider
 * briefly unable to answer — in place of the runtime's sentence: the message goes out again by itself, here is when, and here is
 * how to take over. Every decision is [AutoRetryLogic]'s; this only draws it.
 */
@Composable
internal fun AutoRetryCard(notice: AutoRetryNotice, console: SessionConsole) {
    // The armed retry is a fact about the session, not the transcript: asked for once as the card appears — and, when this window
    // holds no message of the reader's to re-send, what the server would re-send, or that it has nothing to.
    LaunchedEffect(notice.stale) { if (!notice.stale) { console.reloadRetryState(); console.loadRetryText() } }
    val retryAt = console.retryAtMs
    // A second hand only where one moves: a settled card, and a live one with nothing armed, are static text.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(notice.stale, retryAt) {
        now = System.currentTimeMillis()
        if (!notice.stale && retryAt != null) while (true) { delay(1_000); now = System.currentTimeMillis() }
    }
    val composer by console.composer.state.collectAsState()
    val retryText = console.retryText
    val s = AutoRetryLogic.state(notice, live = !notice.stale, retryAtMs = retryAt, attempts = console.retryAttempts,
        provider = console.provider, runnerName = console.runnerName, hasRetryText = retryText.isNotEmpty(),
        nothingToResend = console.retryContinues, nowMs = now, takenOver = console.takenOver)
    val tint = if (s.needsYou) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().background(tint.copy(alpha = .08f), RoundedCornerShape(10.dp)).padding(10.dp).testTag("auto-retry-card"),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(if (s.needsYou) "⚠" else "◷", color = tint, modifier = Modifier.clearAndSetSemantics { })
            Text(s.title, color = tint, fontWeight = FontWeight.SemiBold)
        }
        Text(s.body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (s.showsMessage) SelectionContainer {
            Text(notice.message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // A quota leads with the moment its window resets, the countdown beside it; a provider error's minutes are the whole story.
        s.countdown?.let { countdown ->
            Text(buildAnnotatedString {
                if (s.showsResetAt && retryAt != null) {
                    append(if (s.continues) "Continues " else "Resets ")
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(resetAt(retryAt, now)) }
                    append(" · $countdown")
                } else {
                    append(if (s.continues) "Continuing " else "Retrying ")
                    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(countdown) }
                }
            }, style = MaterialTheme.typography.bodySmall)
        }
        // A real two-state switch: off is drawn, not implied by the row vanishing.
        if (s.showsAutoRow) Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(s.autoLabel, style = MaterialTheme.typography.bodySmall)
                Text(s.autoDetail, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = s.armed, onCheckedChange = { on ->
                if (!on || s.rearmAtMs != null) console.setAutoRetry(if (on) s.rearmAtMs else null)
            }, modifier = Modifier.testTag("auto-retry-switch"))
        }
        if (s.firing) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("↻", modifier = Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.bodySmall)
            Text(s.firingText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        s.retryNowTitle?.let { title ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                // Quoted: by now it has scrolled away, and on a first-turn limit it never was in the transcript.
                if (s.quotesRetryText) {
                    Text("Will re-send:", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(retryText, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .12f),
                        RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 6.dp),
                        style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                // A press already on its way is not offered a second one.
                OutlinedButton(enabled = !console.retryInFlight && !composer.busy && !composer.waiting && composer.draft.pending == null,
                    onClick = console::retryLastMessage) { Text(title) }
                s.retryNowNote?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
        // Where the Retry was, so the answer arrives where the press did: another run has the task.
        s.takenOver?.let { conflict -> TaskRunConflictCard(conflict, { console.openSession(it) }, null) { console.takenOver = null } }
        console.retryError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }
}

/** "6:20 PM" today, "Aug 6, 2026, 1:00 PM" beyond it — a bare time on another day misleads. */
private fun resetAt(atMs: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    val at = Instant.ofEpochMilli(atMs).atZone(zone)
    val sameDay = at.toLocalDate() == Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
    return (if (sameDay) DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT) else DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT))
        .format(at)
}
