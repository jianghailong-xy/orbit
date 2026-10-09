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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.text
import io.orbitd.android.tasks.TaskTime
import io.orbitd.android.watch.*

/**
 * The session's one Tasks card above its composer (A08-6; iOS 516ac3389 `CreatedTasksCard`): the tasks this conversation created and
 * the tasks its watches wait on, one row per task. Folded, it reads "Tasks", the eye with how many rows are watched — orange while a
 * watch over them goes unchecked — and the count sentence (or the one task by name and pill); opened, each row's pill, eye, title and
 * age ("elsewhere" for a watched task created elsewhere), each opening its task. The Watching card keeps only the waits on anything
 * else. Nothing at all when the session neither created nor waits on any task.
 */
@Composable
fun SessionTasksCard(app: OrbitApplication, handle: SessionHandle, sessionId: String, cards: SessionCardsModel, open: (String) -> Unit) {
    val store = remember(handle) { WatchStore.of(app.session, handle, app.processScope) }
    val watches by store.state.collectAsState()
    val now = rememberWatchClock()
    val summary = watches.summaries[watchKey(sessionId)]
    val card = SessionTaskCard.of(cards.created, summary?.watchedTasks(now).orEmpty()) ?: return
    val staleLines = summary?.taskStaleLines(now).orEmpty()
    var opened by rememberSaveable(sessionId) { mutableStateOf(false) }
    val shape = RoundedCornerShape(8.dp)
    val accent = MaterialTheme.colorScheme.primary
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp).clip(shape)
        .background(accent.copy(alpha = 0.04f)).border(1.dp, accent.copy(alpha = 0.10f), shape).testTag("session-tasks")) {
        Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = if (opened) "Hides the tasks" else "Shows the tasks") { opened = !opened }
            .heightIn(min = 48.dp).padding(horizontal = 10.dp, vertical = 3.dp).testTag("session-tasks:line"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(painterResource(R.drawable.ic_task), null, Modifier.size(14.dp), tint = secondary)
            Text(SessionTaskCard.title, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
            val single = card.single
            if (single != null) {
                Text(single.title, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (single.watched) Eye(single.stale)
                single.pill?.let { WatchTaskStatusPill(it) }
            } else {
                if (card.watching > 0) Row(Modifier.testTag("session-tasks:watching"), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                    Eye(card.stale)
                    Text("${card.watching}", style = MaterialTheme.typography.labelSmall, color = if (card.stale) LocalOrbitColorsNeedsYou() else accent)
                }
                CountSentence(card, Modifier.weight(1f))
            }
            Icon(if (opened) WatchIcons.chevronDown else WatchIcons.chevronRight, null, Modifier.size(14.dp), tint = secondary)
        }
        if (opened) {
            HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            Column(Modifier.fillMaxWidth().heightIn(max = 170.dp).verticalScroll(rememberScrollState()).testTag("session-tasks:list")) {
                staleLines.forEach { line ->
                    Text(line, Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp), style = MaterialTheme.typography.labelSmall,
                        color = LocalOrbitColorsNeedsYou())
                    HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
                }
                card.rows.forEachIndexed { index, row ->
                    if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
                    TaskRow(row, now, open)
                }
            }
        }
    }
}

@Composable
private fun LocalOrbitColorsNeedsYou() = io.orbitd.android.ui.LocalOrbitColors.current.needsYou

/** The eye a watched row carries, orange while the watch over it goes unchecked. */
@Composable
private fun Eye(stale: Boolean) {
    Icon(WatchIcons.eye, null, Modifier.size(12.dp).semantics { contentDescription = SessionTaskCard.watchingLabel },
        tint = if (stale) LocalOrbitColorsNeedsYou() else MaterialTheme.colorScheme.primary)
}

/** "2 running · 1 failed · 4/8 done", the failed part red. */
@Composable
private fun CountSentence(card: SessionTaskCard, modifier: Modifier) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val red = MaterialTheme.colorScheme.error
    val parts = WatchCountCopy.parts(card.running, card.failed, card.done, card.total)
    Text(buildAnnotatedString {
        parts.forEachIndexed { index, part ->
            if (index > 0) withStyle(SpanStyle(color = secondary)) { append(WatchCountCopy.SEPARATOR) }
            withStyle(SpanStyle(color = if (part.failed) red else secondary)) { append(part.text) }
        }
    }, modifier.testTag("session-tasks:count"), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** One task: its pill, its eye, its title (and what it replaced), its age — or "elsewhere" — and the press that opens it. */
@Composable
private fun TaskRow(row: SessionTaskCard.Row, now: java.time.Instant, open: (String) -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Opens the task") { open("orbit-task:${row.id}") }
        .heightIn(min = 48.dp).padding(horizontal = 12.dp).testTag("created-task:${row.id}"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.widthIn(min = 70.dp)) { row.pill?.let { WatchTaskStatusPill(it) } }
        Box(Modifier.width(14.dp)) { if (row.watched) Eye(row.stale) }
        Text(buildAnnotatedString {
            append(row.title)
            row.replaces?.text("title")?.let { withStyle(SpanStyle(color = secondary)) { append(" · ${SessionTaskCard.replacesPrefix}$it") } }
        }, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(if (row.elsewhere) SessionTaskCard.elsewhere else row.createdAt?.let { TaskTime.relative(it, now) }.orEmpty(),
            style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1)
        Icon(WatchIcons.chevronRight, null, Modifier.size(12.dp), tint = secondary.copy(alpha = 0.6f))
    }
}
