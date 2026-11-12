package io.orbitd.android.reader

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import io.orbitd.android.directory.QueuedGate
import io.orbitd.android.directory.RunnerUpdating
import io.orbitd.android.directory.RunnerUpdatingPart
import java.time.Instant
import kotlinx.coroutines.delay

/** A clock that moves every 30 seconds, for the waits counted in minutes (web `useMinuteNow`). */
@Composable
internal fun rememberMinuteNow(): Instant {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = Instant.now() } }
    return now
}

/**
 * The queued page of a session held by its runner's update (board 2 ②–③, board 5's phone; web `RunnerUpdatingQueued`): why, with the
 * turns it waits for as links, and how long it has waited, centred. Later and Update Now… come in later tasks; nothing is drawn there.
 */
@Composable
internal fun RunnerUpdatingQueued(gate: QueuedGate, machine: String?, openSession: (String) -> Unit, modifier: Modifier = Modifier,
    now: Instant = rememberMinuteNow()) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val link = MaterialTheme.colorScheme.primary
    val parts = remember(gate, machine) { RunnerUpdating.runnerUpdatingDescription(gate, machine) }
    val waited = RunnerUpdating.runnerUpdatingWaited(gate, now)
    Column(modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp).testTag("runner-updating"),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(RunnerUpdating.RUNNER_UPDATING_TITLE, Modifier.testTag("runner-updating:title"), style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        val open by rememberUpdatedState(openSession)
        val text = remember(parts, link) { buildAnnotatedString {
            parts.forEach { part -> when (part) {
                is RunnerUpdatingPart.Words -> append(part.text)
                is RunnerUpdatingPart.Session ->
                    withLink(LinkAnnotation.Clickable(part.id, TextLinkStyles(SpanStyle(color = link))) { open(part.id) }) { append(part.title) }
            } }
        } }
        Text(text, Modifier.testTag("runner-updating:description"), style = MaterialTheme.typography.bodyMedium, color = secondary,
            textAlign = TextAlign.Center)
        waited?.let { Text(it, Modifier.testTag("runner-updating:waited"), style = MaterialTheme.typography.bodySmall, color = secondary) }
    }
}

/**
 * The foot row under the message the update holds (board 2 ⑤; web `RunnerUpdatingTag`): `Queued · runner updating`, in the meta
 * voice, the reason dotted-underlined because a press opens why — the update's account and, on its own line, how long it has waited.
 */
@Composable
internal fun RunnerUpdatingFoot(gate: QueuedGate, machine: String?, modifier: Modifier = Modifier, now: Instant = rememberMinuteNow()) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val style = MaterialTheme.typography.labelSmall
    var open by remember { mutableStateOf(false) }
    Row(modifier.testTag("runner-updating-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(RunnerUpdating.QUEUED, style = style, color = secondary)
        Text("·", style = style, color = secondary)
        Text(RunnerUpdating.RUNNER_UPDATING_TAG, Modifier.clickable(role = Role.Button) { open = true }
            .drawBehind {
                val y = size.height - 1.dp.toPx()
                drawLine(secondary, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx(),
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 2.dp.toPx())))
            }.testTag("runner-updating-foot:reason"), style = style, color = secondary)
    }
    if (open) Dialog({ open = false }) {
        Surface(shape = RoundedCornerShape(14.dp), tonalElevation = 6.dp, modifier = Modifier.widthIn(max = 320.dp).testTag("runner-updating-pop")) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(RunnerUpdating.RUNNER_UPDATING_TITLE, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                val waited = RunnerUpdating.runnerUpdatingWaited(gate, now)
                Text(RunnerUpdating.runnerUpdatingMessageText(gate, machine) + (waited?.let { "\n$it." } ?: ""),
                    Modifier.testTag("runner-updating-pop:text"), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}
