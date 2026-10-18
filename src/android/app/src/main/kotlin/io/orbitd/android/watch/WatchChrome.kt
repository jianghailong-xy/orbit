package io.orbitd.android.watch

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import java.time.Instant

/** The SF Symbols the watch pages draw, as Material icon paths (no icon library ships with this app). */
internal object WatchIcons {
    private fun icon(name: String, vararg paths: String): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            paths.forEach { addPath(addPathNodes(it), fill = SolidColor(Color.Black)) }
        }.build()

    private const val CIRCLE = "M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM12,20c-4.41,0 -8,-3.59 -8,-8s3.59,-8 8,-8 8,3.59 8,8 -3.59,8 -8,8z"

    val eye by lazy { icon("eye", "M12,4.5C7,4.5 2.73,7.61 1,12c1.73,4.39 6,7.5 11,7.5s9.27,-3.11 11,-7.5c-1.73,-4.39 -6,-7.5 -11,-7.5zM12,17c-2.76,0 -5,-2.24 -5,-5s2.24,-5 5,-5 5,2.24 5,5 -2.24,5 -5,5zM12,9c-1.66,0 -3,1.34 -3,3s1.34,3 3,3 3,-1.34 3,-3 -1.34,-3 -3,-3z") }
    val eyeSlash by lazy { icon("eye.slash", "M12,7c2.76,0 5,2.24 5,5 0,0.65 -0.13,1.26 -0.36,1.83l2.92,2.92c1.51,-1.26 2.7,-2.89 3.43,-4.75 -1.73,-4.39 -6,-7.5 -11,-7.5 -1.4,0 -2.74,0.25 -3.98,0.7l2.16,2.16C10.74,7.13 11.35,7 12,7zM2,4.27l2.28,2.28 0.46,0.46C3.08,8.3 1.78,10.02 1,12c1.73,4.39 6,7.5 11,7.5 1.55,0 3.03,-0.3 4.38,-0.84l0.42,0.42L19.73,22 21,20.73 3.27,3 2,4.27zM7.53,9.8l1.55,1.55c-0.05,0.21 -0.08,0.43 -0.08,0.65 0,1.66 1.34,3 3,3 0.22,0 0.44,-0.03 0.65,-0.08l1.55,1.55c-0.67,0.33 -1.41,0.53 -2.2,0.53 -2.76,0 -5,-2.24 -5,-5 0,-0.79 0.2,-1.53 0.53,-2.2zM11.84,9.02l3.15,3.15 0.02,-0.16c0,-1.66 -1.34,-3 -3,-3l-0.17,0.01z") }
    val pauseCircle by lazy { icon("pause.circle", CIRCLE, "M9,16h2V8H9v8zM13,16h2V8h-2v8z") }
    val checkCircle by lazy { icon("checkmark.circle", CIRCLE, "M16.59,7.58L10,14.17l-3.59,-3.58L5,12l5,5 8,-8z") }
    val checkCircleFill by lazy { icon("checkmark.circle.fill", "M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM10,17l-5,-5 1.41,-1.41L10,14.17l7.59,-7.59L19,8l-9,9z") }
    val xmarkCircleFill by lazy { icon("xmark.circle.fill", "M12,2C6.47,2 2,6.47 2,12s4.47,10 10,10 10,-4.47 10,-10S17.53,2 12,2zM17,15.59L15.59,17 12,13.41 8.41,17 7,15.59 10.59,12 7,8.41 8.41,7 12,10.59 15.59,7 17,8.41 13.41,12 17,15.59z") }
    val clock by lazy { icon("clock", CIRCLE, "M12.5,7H11v6l5.25,3.15 0.75,-1.23 -4.5,-2.67z") }
    val stopCircle by lazy { icon("stop.circle", CIRCLE, "M8,8h8v8H8z") }
    val minusCircle by lazy { icon("minus.circle", CIRCLE, "M7,11v2h10v-2H7z") }
    val lock by lazy { icon("lock.slash", "M18,8h-1V6c0,-2.76 -2.24,-5 -5,-5S7,3.24 7,6v2H6c-1.1,0 -2,0.9 -2,2v10c0,1.1 0.9,2 2,2h12c1.1,0 2,-0.9 2,-2V10c0,-1.1 -0.9,-2 -2,-2zM12,17c-1.1,0 -2,-0.9 -2,-2s0.9,-2 2,-2 2,0.9 2,2 -0.9,2 -2,2zM15.1,8H8.9V6c0,-1.71 1.39,-3.1 3.1,-3.1 1.71,0 3.1,1.39 3.1,3.1v2z") }
    val questionCircle by lazy { icon("questionmark.circle", CIRCLE, "M11,18h2v-2h-2v2zM12,6c-2.21,0 -4,1.79 -4,4h2c0,-1.1 0.9,-2 2,-2s2,0.9 2,2c0,2 -3,1.75 -3,5h2c0,-2.25 3,-2.5 3,-5 0,-2.21 -1.79,-4 -4,-4z") }
    val warning by lazy { icon("exclamationmark.triangle", "M1,21h22L12,2 1,21zM13,18h-2v-2h2v2zM13,14h-2v-4h2v4z") }
    val sessions by lazy { icon("bubble.left.and.bubble.right", "M21,6h-2v9H6v2c0,0.55 0.45,1 1,1h11l4,4V7c0,-0.55 -0.45,-1 -1,-1zM17,12V3c0,-0.55 -0.45,-1 -1,-1H3c-0.55,0 -1,0.45 -1,1v14l4,-4h10c0.55,0 1,-0.45 1,-1z") }
    val message by lazy { icon("message", "M20,2H4c-1.1,0 -2,0.9 -2,2v18l4,-4h14c1.1,0 2,-0.9 2,-2V4c0,-1.1 -0.9,-2 -2,-2zM20,16H6l-2,2V4h16v12z") }
    val checklist by lazy { icon("checklist", "M22,7h-9v2h9V7zM22,15h-9v2h9v-2zM5.54,11L2,7.46l1.41,-1.41 2.12,2.12 4.24,-4.24 1.41,1.41L5.54,11zM5.54,19L2,15.46l1.41,-1.41 2.12,2.12 4.24,-4.24 1.41,1.41L5.54,19z") }
    val chevronRight by lazy { icon("chevron.right", "M10,6L8.59,7.41 13.17,12l-4.58,4.59L10,18l6,-6z") }
    val chevronDown by lazy { icon("chevron.down", "M16.59,8.59L12,13.17 7.41,8.59 6,10l6,6 6,-6z") }

    /** A session glyph's SF Symbol, drawn. */
    fun symbol(name: String): ImageVector = when (name) {
        "clock" -> clock
        "message" -> message
        "checkmark.circle.fill" -> checkCircleFill
        "xmark.circle.fill" -> xmarkCircleFill
        "minus.circle" -> minusCircle
        else -> checkCircle
    }
}

/** The colours iOS names in the watch pages, in this app's theme. */
internal object WatchPalette {
    val orange @Composable get() = LocalOrbitColors.current.needsYou
    val green @Composable get() = LocalOrbitColors.current.success
    val blue @Composable get() = LocalOrbitColors.current.running
    val red @Composable get() = MaterialTheme.colorScheme.error
    val secondary @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
    val tertiary @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
    val accent @Composable get() = MaterialTheme.colorScheme.primary
}

/** "Last evaluated" and the stale flag are relative to now: redraw between fetches, as iOS's
 * `TimelineView(.periodic(by: 30))`. No network call. */
@Composable
internal fun rememberWatchClock(): Instant {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = Instant.now() } }
    return now
}

/** The account events that can move a watch's targets: iOS `AppModel.apply` nudges the watches on these alone. */
internal val watchMovingEvents = setOf("session.created", "session.updated", "session.ended", "approval.requested", "approval.resolved", "task.changed")

/** What keeps the account's watches current while a watch surface is on screen (iOS `AppModel`'s three reads):
 * the stream reconnecting re-reads them, an event that can move a target nudges them, and the 30 s floor polls them. */
@Composable
internal fun WatchFeed(app: OrbitApplication, handle: SessionHandle, store: WatchStore) {
    LaunchedEffect(store) {
        app.realtime.state.filter { it.handle === handle }.map { state -> watchMovingEvents.sumOf { state.accountEvents[it] ?: 0L } }
            .distinctUntilChanged().drop(1).collect { store.nudge() }
    }
    LaunchedEffect(store) {
        app.realtime.state.map { it.handle === handle && it.controlConnection == ConnectionState.CONNECTED }
            .distinctUntilChanged().collect { store.connection(it) }
    }
    LaunchedEffect(store) { while (true) { store.refreshIfDue(); delay(5_000) } }
}

/** A session's title where this client holds it (iOS `model.session(id:)?.title`), from the account's directory.
 * Tasks have no list on this client yet, so a task is named by the title the watch carries for it. */
@Composable
internal fun rememberSessionTitles(app: OrbitApplication, handle: SessionHandle): (String?) -> String? {
    val directory by remember(app, handle) {
        app.realtime.state.map { if (it.handle === handle) it.directory else null }.distinctUntilChanged()
    }.collectAsState(null)
    return remember(directory) {
        val titles = directory?.sessions?.values?.flatten()?.mapNotNull { row ->
            val id = row["id"].watchText() ?: return@mapNotNull null
            val title = row["title"].watchText() ?: return@mapNotNull null
            watchKey(id) to title
        }?.toMap().orEmpty()
        val lookup: (String?) -> String? = { id -> id?.let { titles[watchKey(it)] } }
        lookup
    }
}

/** A Form section's header (iOS `Section("…")`). */
@Composable
internal fun WatchSectionHeader(title: String, modifier: Modifier = Modifier) {
    Text(title, modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 6.dp).semantics { heading() },
        style = MaterialTheme.typography.labelLarge, color = WatchPalette.secondary)
}

/** iOS `LabeledContent`: the label leading, the value trailing. */
@Composable
internal fun WatchLabeledRow(label: String, value: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp).semantics(mergeDescendants = true) {},
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = MaterialTheme.typography.bodyLarge)
        Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, color = WatchPalette.secondary, textAlign = TextAlign.End)
    }
}

/** iOS `ContentUnavailableView`: an icon, a title, what it means, and the one thing to do about it. */
@Composable
internal fun WatchUnavailable(icon: ImageVector, title: String, description: String, modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null) {
    Column(modifier.fillMaxWidth().padding(32.dp).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, null, Modifier.size(40.dp), tint = WatchPalette.secondary)
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Text(description, style = MaterialTheme.typography.bodyMedium, color = WatchPalette.secondary, textAlign = TextAlign.Center)
        action?.invoke()
    }
}

/** iOS's bare `ProgressView()`. */
@Composable
internal fun WatchSpinner(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(32.dp).semantics { contentDescription = "Loading" })
    }
}

/** The running pill's spinner (iOS `SpinnerGlyph` in its 9-point pill frame, as the Tasks list's pill draws it), one for the
 * task pill and the session pill alike. */
@Composable
internal fun WatchPillSpinner(color: Color) {
    CircularProgressIndicator(Modifier.size(9.dp).testTag("pill-spinner"), color = color, strokeWidth = 1.5.dp)
}

/** A task's pill as the task list draws it (iOS `TaskStatusPill`). */
@Composable
internal fun WatchTaskStatusPill(pill: WatchTaskPill) {
    val color = when (pill.kind) {
        WatchTaskPill.Kind.RUNNING, WatchTaskPill.Kind.IN_PROGRESS -> WatchPalette.blue
        WatchTaskPill.Kind.QUEUED -> WatchPalette.orange
        WatchTaskPill.Kind.DONE -> WatchPalette.green
        WatchTaskPill.Kind.OPEN -> WatchPalette.secondary
        WatchTaskPill.Kind.FAILED -> WatchPalette.red
        WatchTaskPill.Kind.CANCELLED -> WatchPalette.tertiary
    }
    Row(Modifier.background(color.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (pill.kind == WatchTaskPill.Kind.RUNNING) WatchPillSpinner(color)
        else Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(pill.label, style = MaterialTheme.typography.labelSmall, color = color, maxLines = 1)
    }
}

/** A session's glyph and word for its run state (iOS `SessionStatusPill`). */
@Composable
internal fun WatchSessionStatusPill(glyph: WatchSessionGlyph) {
    val color = when (glyph.tone) {
        WatchSessionGlyph.Tone.BRAND -> WatchPalette.blue
        WatchSessionGlyph.Tone.SUCCESS -> WatchPalette.green
        WatchSessionGlyph.Tone.WARNING -> WatchPalette.orange
        WatchSessionGlyph.Tone.ERROR -> WatchPalette.red
        WatchSessionGlyph.Tone.NEUTRAL -> WatchPalette.secondary
    }
    // The task pill's spinner and padding, so a running session and a running task look alike side by side (iOS aaf077310).
    Row(Modifier.background(color.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        val symbol = glyph.symbol
        if (symbol == null) WatchPillSpinner(color)
        else Icon(WatchIcons.symbol(symbol), null, Modifier.size(11.dp), tint = color)
        Text(glyph.label, style = MaterialTheme.typography.labelSmall, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Where a target itself stands, in its own list's pill; nothing when the watch carries no standing for it. */
@Composable
internal fun WatchTargetStanding(target: WatchTarget) {
    val pill = WatchProjection.stripPill(target)
    if (pill != null) { WatchTaskStatusPill(pill); return }
    WatchProjection.stripGlyph(target)?.let { WatchSessionStatusPill(it) }
}
