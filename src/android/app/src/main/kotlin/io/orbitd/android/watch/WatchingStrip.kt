package io.orbitd.android.watch

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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.navigation.OrbitRoute
import java.time.Instant

/** What this session is waiting on, above the composer: the live watches that will resume it (iOS
 * `WatchingCardStack`). One line, and opened, each watch's targets with a freshness reminder when the watch has gone
 * unchecked. Read-only: a wait is changed by talking to the agent, and Pause/Stop live on the watch's own page; the
 * only way out is a target's own page. Nothing at all while nothing live will resume the session. */
@Composable
fun SessionWatches(app: OrbitApplication, handle: SessionHandle, sessionId: String, open: (OrbitRoute) -> Unit) {
    val store = remember(handle) { WatchStore.of(app.session, handle, app.processScope) }
    if (!store.live()) return
    WatchFeed(app, handle, store)
    WatchingCardStack(store, sessionId, rememberSessionTitles(app, handle), open)
}

@Composable
internal fun WatchingCardStack(store: WatchStore, sessionId: String, sessionTitle: (String?) -> String?, open: (OrbitRoute) -> Unit) {
    val state by store.state.collectAsState()
    val summary = state.summaries[watchKey(sessionId)] ?: return
    // The "Not checked for" reminder is relative to now: redraw between fetches so it doesn't freeze.
    val now = rememberWatchClock()
    var opened by rememberSaveable(sessionId) { mutableStateOf(false) }
    val shape = RoundedCornerShape(8.dp)
    val ink = MaterialTheme.colorScheme.onSurface
    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 6.dp).clip(shape)
        .background(ink.copy(alpha = 0.04f)).border(1.dp, ink.copy(alpha = 0.1f), shape).testTag("session-watches")) {
        StripLine(summary, opened, sessionTitle) { opened = !opened }
        if (opened) {
            HorizontalDivider(color = ink.copy(alpha = 0.08f))
            // Natural height where the band has room; past about five rows it stops and scrolls inside, so opening
            // it never pushes the conversation off.
            Column(Modifier.fillMaxWidth().heightIn(max = 190.dp).verticalScroll(rememberScrollState()).testTag("watch-strip-list")) {
                summary.watches.forEachIndexed { index, watch ->
                    if (index > 0) HorizontalDivider(color = ink.copy(alpha = 0.08f))
                    WatchBlock(watch, now, sessionTitle, open)
                }
            }
        }
    }
}

/** The one line the strip always reads as: the fixed label, then the lone target by name with where it stands, or
 * what several need beside Tasks created here's sentence. All of it opens and closes the list. */
@Composable
private fun StripLine(summary: WatchSessionSummary, opened: Boolean, sessionTitle: (String?) -> String?, toggle: () -> Unit) {
    val label = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold)
    val meta = MaterialTheme.typography.labelSmall
    Row(Modifier.fillMaxWidth()
        .clickable(role = Role.Button, onClickLabel = if (opened) "Hides what this session waits on" else "Shows what this session waits on", onClick = toggle)
        .heightIn(min = 48.dp).padding(horizontal = 10.dp, vertical = 3.dp).testTag("watch-strip-line"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(WatchIcons.eye, null, Modifier.size(14.dp), tint = WatchPalette.secondary)
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(WatchProjection.STRIP_LABEL, style = label, maxLines = 1)
            val target = summary.lineTarget
            if (target != null) {
                // Enough of the name to tell which it is; where it stands keeps its size.
                Text(stripName(target, sessionTitle), Modifier.weight(1f), style = meta, color = WatchPalette.accent,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                WatchTargetStanding(target)
            } else {
                // The sentence is what the line is for: when it grows, what the wait needs yields.
                Text(summary.lineTargetWord, Modifier.weight(1f, fill = false), style = meta, color = WatchPalette.accent,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                CountText(summary.lineParts)
            }
        }
        Icon(if (opened) WatchIcons.chevronDown else WatchIcons.chevronRight, null, Modifier.size(14.dp), tint = WatchPalette.secondary)
    }
}

/** Tasks created here's sentence, secondary, with its failed part red. */
@Composable
private fun CountText(parts: List<WatchCountCopy.Part>) {
    val secondary = WatchPalette.secondary
    val red = WatchPalette.red
    Text(buildAnnotatedString {
        parts.forEachIndexed { index, part ->
            if (index > 0) withStyle(SpanStyle(color = secondary)) { append(WatchCountCopy.SEPARATOR) }
            withStyle(SpanStyle(color = if (part.failed) red else secondary)) { append(part.text) }
        }
    }, style = MaterialTheme.typography.labelSmall, maxLines = 1)
}

/** One watch: its stale reminder when nobody is checking it, and its targets. */
@Composable
private fun WatchBlock(watch: Watch, now: Instant, sessionTitle: (String?) -> String?, open: (OrbitRoute) -> Unit) {
    val ink = MaterialTheme.colorScheme.onSurface
    Column(Modifier.fillMaxWidth()) {
        WatchProjection.stripStaleLine(watch, now)?.let { stale ->
            Text(stale, Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp).testTag("watch-strip-stale:${watch.id}"),
                style = MaterialTheme.typography.labelSmall, color = WatchPalette.orange)
        }
        WatchProjection.stripTargets(watch).forEach { target ->
            HorizontalDivider(color = ink.copy(alpha = 0.08f))
            StripTargetRow(watch, target, sessionTitle, open)
        }
    }
}

/** One target: where it stands in a column of its own, and its name. A tap opens its page. */
@Composable
private fun StripTargetRow(watch: Watch, target: WatchTarget, sessionTitle: (String?) -> String?, open: (OrbitRoute) -> Unit) {
    val route = watchTargetRoute(target)
    Row(Modifier.fillMaxWidth()
        .clickable(enabled = route != null, role = Role.Button, onClickLabel = "Opens it") { route?.let(open) }
        .alpha(if (route == null) 0.5f else 1f)
        .heightIn(min = 48.dp).padding(horizontal = 12.dp).testTag("watch-strip-target:${watch.id}:${target.targetResourceId}"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.widthIn(min = 70.dp)) { WatchTargetStanding(target) }
        Text(stripName(target, sessionTitle), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(WatchIcons.chevronRight, null, Modifier.size(12.dp), tint = WatchPalette.tertiary)
    }
}

/** A target by the name the watch carries for it, else the one this client holds, else by kind and short id: a
 * strip that can't name what it waits on leaves several watches looking alike. */
private fun stripName(target: WatchTarget, sessionTitle: (String?) -> String?): String =
    WatchProjection.targetTitle(target.targetKind, target.targetResourceId,
        target.targetTitle ?: if (target.targetKind == WatchTargetKind.SESSION) sessionTitle(target.targetResourceId) else null)
