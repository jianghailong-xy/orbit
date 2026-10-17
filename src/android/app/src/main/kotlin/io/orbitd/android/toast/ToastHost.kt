package io.orbitd.android.toast

import android.os.SystemClock
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.ui.LocalOrbitColors
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** The app's one toast feed (iOS `AppModel.toasts` and `showToast`). The session actions, the worktree bar and the Wiki
 * post here and the shell's [ToastHost] draws it, so a toast outlives the page that posted it. One per process, as
 * iOS's is: signing out, or in as another account, clears it. */
object OrbitToasts {
    private val mutable = MutableStateFlow(ToastFeed())
    val feed: StateFlow<ToastFeed> = mutable.asStateFlow()
    private val holding = MutableStateFlow<Long?>(null)
    /** The transient toast a finger rests on: its dwell waits for it to be let go, then starts over. */
    val held: StateFlow<Long?> = holding.asStateFlow()

    /** Floats an outcome. [subtitle] names what it happened to — the session, an entry's title; [sessionId] makes the
     * toast the way into that session; [key] makes one operation one toast. The id it is shown under, or null for a
     * repeat of what went up under two seconds ago. */
    fun show(message: String, subtitle: String? = null, sessionId: String? = null, detail: String? = null,
        tone: ToastTone = ToastTone.SUCCESS, glyph: ToastGlyph? = null, canUndo: Boolean = false,
        mergeConflict: ToastMergeConflict? = null, key: String? = null, inProgress: Boolean = false): Long? {
        val item = ToastItem(message = message, subtitle = subtitle, detail = detail, tone = tone, glyph = glyph, sessionId = sessionId,
            canUndo = canUndo, mergeConflict = mergeConflict, key = key, inProgress = inProgress)
        var shown: Long? = null
        mutable.update { feed -> feed.post(item, SystemClock.elapsedRealtime()).let { (next, id) -> shown = id; next } }
        return shown
    }

    fun dismiss(id: Long) = mutable.update { it.dismiss(id) }
    fun expire(id: Long) = mutable.update { it.expire(id) }
    fun fold(id: Long) = mutable.update { it.fold(id) }
    fun unfold(id: Long) = mutable.update { it.unfold(id) }
    fun hold(id: Long) { if (mutable.value.transient?.id == id) holding.value = id }
    fun release(id: Long) { holding.compareAndSet(id, null) }

    /** Nothing up: another account's outcomes never show under this one. */
    fun clear() { mutable.value = ToastFeed(); holding.value = null }
}

/** The session's name for a toast's second line: its first line only, and none for a session with no title (iOS
 * `toastSessionTitle`). */
fun toastTitle(title: String?): String? = title?.lineSequence()?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }

/**
 * The app's one toast surface (iOS `ToastHost`, docs/mocks/toast-system), under the shell's bar, where it covers neither
 * the composer nor the keyboard. A phone shows the newest of the toasts that wait for you — a tinted card that folds into
 * a pill after six seconds and opens again from it — and the one transient toast under it: a pill that hugs its words,
 * or a card when it carries an Undo or a diagnostic. A toast naming a session is the way into it ([open]); flicking a
 * toast up takes it away early; a finger resting on a transient toast keeps it until it is let go.
 */
@Composable
fun ToastHost(open: (ToastItem) -> Unit, undo: (ToastItem) -> Unit, resolve: (ToastItem) -> Unit, modifier: Modifier = Modifier) {
    val feed by OrbitToasts.feed.collectAsState()
    val held by OrbitToasts.held.collectAsState()
    val transient = feed.transient
    // Its dwell, unless something replaced it first or a finger rests on it; let go, it starts over.
    LaunchedEffect(transient?.id, transient?.revision, held) {
        val toast = transient ?: return@LaunchedEffect
        val dwell = toast.dwellMillis ?: return@LaunchedEffect
        if (held == toast.id) return@LaunchedEffect
        delay(dwell)
        OrbitToasts.expire(toast.id)
    }
    // An open pinned card folds into its pill after six seconds: it stops covering the page and stays one tap away.
    LaunchedEffect(feed.expanded, feed.openings) {
        val id = feed.expanded ?: return@LaunchedEffect
        delay(6_000)
        OrbitToasts.fold(id)
    }
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val front = feed.front?.let { Front(it, feed.expanded == it.id, feed.behindFront) }
        AnimatedContent(front, contentKey = { it?.toast?.id }, transitionSpec = { arrival() }, label = "pinned toast") { shown ->
            if (shown != null) SwipeAway(shown.toast.id, hold = false) {
                if (shown.open) AttentionCard(shown.toast, open, resolve)
                else Pill(shown.toast, shown.behind, "Shows the whole message") { OrbitToasts.unfold(shown.toast.id) }
            }
        }
        AnimatedContent(transient, contentKey = { it?.id }, transitionSpec = { arrival() }, label = "toast") { toast ->
            when {
                toast == null -> Unit
                toast.level == ToastLevel.RESULT -> SwipeAway(toast.id, hold = true) { ResultCard(toast, open, undo) }
                toast.opens -> SwipeAway(toast.id, hold = true) { Pill(toast, 0, "Opens the session") { open(toast) } }
                // A pill that names nothing passes touches through to the page under it for its three seconds.
                else -> Box(Modifier.testTag("toast").semantics { liveRegion = LiveRegionMode.Polite }) { Pill(toast, 0, null, null) }
            }
        }
    }
}

private data class Front(val toast: ToastItem, val open: Boolean, val behind: Int)

/** Slides down from under the bar; one operation's next words take its place where it stands. */
private fun arrival() = (slideInVertically { -it / 2 } + fadeIn()) togetherWith fadeOut()

/** Flick a toast up and it goes, the way a notification banner does; a drag down holds it where it is. With [hold] a
 * finger resting on it keeps it until let go. */
@Composable
private fun SwipeAway(id: Long, hold: Boolean, content: @Composable () -> Unit) {
    var travel by remember(id) { mutableFloatStateOf(0f) }
    val away = with(LocalDensity.current) { 32.dp.toPx() }
    Box(Modifier.testTag("toast").semantics { liveRegion = LiveRegionMode.Polite }
        .offset { IntOffset(0, travel.roundToInt()) }
        .pointerInput(id) {
            detectVerticalDragGestures(onDragEnd = { travel = 0f }, onDragCancel = { travel = 0f }) { change, amount ->
                travel = (travel + amount).coerceAtMost(0f)
                if (travel < -away) { change.consume(); OrbitToasts.dismiss(id) }
            }
        }
        .then(if (hold) Modifier.pointerInput(id) {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false)
                OrbitToasts.hold(id)
                try { waitForUpOrCancellation() } finally { OrbitToasts.release(id) }
            }
        } else Modifier)) { content() }
}

/** A pill: one line — two when it names what it happened to — hugging its words. ① a confirmation, a progress line with
 * its spinner, or a folded ③ with the count of the others behind it. A pill a tap does something on says so with a
 * chevron. */
@Composable
private fun Pill(toast: ToastItem, behind: Int, pressLabel: String?, press: (() -> Unit)?) {
    val shape = RoundedCornerShape(percent = 50)
    val colors = MaterialTheme.colorScheme
    Row(Modifier.widthIn(max = 300.dp).heightIn(min = if (toast.subtitle == null) 40.dp else 52.dp)
        .surface(shape, background(toast, card = false), colors.onSurface)
        .then(if (press != null) Modifier.clickable(onClickLabel = pressLabel, role = Role.Button, onClick = press) else Modifier)
        .padding(start = 10.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ToastIcon(toast, card = false)
        Column(Modifier.weight(1f, fill = false)) {
            Text(toast.message, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1,
                overflow = TextOverflow.Ellipsis)
            toast.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1,
                overflow = TextOverflow.Ellipsis) }
        }
        if (behind > 0) Text("+$behind", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = colors.error,
            modifier = Modifier.background(colors.error.copy(alpha = 0.14f), CircleShape).padding(horizontal = 7.dp, vertical = 1.dp))
        if (press != null) Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp), tint = colors.onSurfaceVariant)
    }
}

/** ② A card: the outcome, what it was about and its diagnostic, and the one thing to do about it (Undo). */
@Composable
private fun ResultCard(toast: ToastItem, open: (ToastItem) -> Unit, undo: (ToastItem) -> Unit) {
    Row(Modifier.fillMaxWidth().surface(RoundedCornerShape(22.dp), background(toast, card = true), MaterialTheme.colorScheme.onSurface)
        .padding(start = 14.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        ToastIcon(toast, card = true)
        ToastCopy(toast, showsDetail = true, Modifier.weight(1f), if (toast.opens) ({ open(toast) }) else null)
        if (toast.canUndo) FilledTonalButton(onClick = { undo(toast) }, contentPadding = PaddingValues(horizontal = 14.dp)) { Text("Undo") }
    }
}

/** ③ open: what failed, what it's about, the server's words to read or copy, and what to do about it. Its copy is the way
 * into the session, as a card's is; a button is only for what does more than that (Resolve in session) or acts on the
 * card's own words (Copy error). */
@Composable
private fun AttentionCard(toast: ToastItem, open: (ToastItem) -> Unit, resolve: (ToastItem) -> Unit) {
    val clipboard = LocalClipboardManager.current
    val colors = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().surface(RoundedCornerShape(22.dp), background(toast, card = true), colors.onSurface).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            ToastIcon(toast, card = true)
            ToastCopy(toast, showsDetail = false, Modifier.weight(1f).padding(top = 2.dp), if (toast.opens) ({ open(toast) }) else null)
            IconButton(onClick = { OrbitToasts.dismiss(toast.id) }, modifier = Modifier.size(40.dp)) {
                Icon(painterResource(R.drawable.ic_close), "Dismiss", Modifier.size(28.dp).background(colors.onSurface.copy(alpha = 0.08f), CircleShape)
                    .padding(7.dp), tint = colors.onSurfaceVariant)
            }
        }
        // The server's own words, whole and selectable: a failure is the thing you want to read twice and paste somewhere.
        toast.detail?.let { detail ->
            SelectionContainer(Modifier.padding(start = 38.dp)) {
                Text(detail, Modifier.fillMaxWidth().background(colors.onSurface.copy(alpha = 0.05f), RoundedCornerShape(10.dp))
                    .padding(horizontal = 10.dp, vertical = 7.dp), style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                    color = colors.onSurfaceVariant, maxLines = 6, overflow = TextOverflow.Ellipsis)
            }
        }
        if (toast.mergeConflict != null || toast.detail != null) Row(Modifier.padding(start = 38.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (toast.mergeConflict != null) Button(onClick = { resolve(toast) }, contentPadding = PaddingValues(horizontal = 14.dp)) { Text("Resolve in session") }
            toast.detail?.let { detail ->
                OutlinedButton(onClick = { clipboard.setText(AnnotatedString(detail)) }, contentPadding = PaddingValues(horizontal = 14.dp)) { Text("Copy error") }
            }
        }
    }
}

/** The outcome, what it happened to, and — on a card — the diagnostic, leading and as wide as the card allows, so a tap
 * lands anywhere along the row. */
@Composable
private fun ToastCopy(toast: ToastItem, showsDetail: Boolean, modifier: Modifier, press: (() -> Unit)?) {
    val colors = MaterialTheme.colorScheme
    Column(modifier.then(if (press != null) Modifier.clickable(onClickLabel = "Opens the session", role = Role.Button, onClick = press) else Modifier),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(toast.message, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        toast.subtitle?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1,
            overflow = TextOverflow.Ellipsis) }
        if (showsDetail) toast.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant,
            maxLines = 4, overflow = TextOverflow.Ellipsis) }
    }
}

/** The tone's glyph — or the toast's own, so "Moved to Trash" still shows the trash — and a spinner while work is under way. */
@Composable
private fun ToastIcon(toast: ToastItem, card: Boolean) {
    val size = if (card) 26.dp else 22.dp
    if (toast.level == ToastLevel.PROGRESS) CircularProgressIndicator(Modifier.size(size).padding(3.dp), strokeWidth = 2.dp)
    else Icon(painterResource(glyph(toast)), null, Modifier.size(size), tint = toneColor(toast.tone))
}

private fun glyph(toast: ToastItem): Int = when (toast.glyph) {
    ToastGlyph.TRASH -> R.drawable.ic_trash
    ToastGlyph.FOLDER -> R.drawable.ic_folder
    null -> when (toast.tone) {
        ToastTone.SUCCESS -> R.drawable.ic_check_circle
        ToastTone.NEUTRAL, ToastTone.INFO -> R.drawable.ic_info
        ToastTone.WARNING -> R.drawable.ic_warning
        ToastTone.ERROR -> R.drawable.ic_x_circle
    }
}

@Composable
private fun toneColor(tone: ToastTone): Color = when (tone) {
    ToastTone.SUCCESS -> LocalOrbitColors.current.success
    ToastTone.NEUTRAL -> MaterialTheme.colorScheme.onSurfaceVariant
    ToastTone.INFO -> MaterialTheme.colorScheme.primary
    ToastTone.WARNING -> LocalOrbitColors.current.needsYou
    ToastTone.ERROR -> MaterialTheme.colorScheme.error
}

/** The page's surface, washed red for a failure and amber for something waiting on you when it is a ③. */
@Composable
private fun background(toast: ToastItem, card: Boolean): Color {
    val surface = MaterialTheme.colorScheme.surface
    if (toast.level != ToastLevel.ATTENTION) return surface
    return toneColor(toast.tone).copy(alpha = if (card) 0.12f else 0.16f).compositeOver(surface)
}

/** Chrome over the page rather than a slab of it: a soft shadow, a hairline edge that inverts with the appearance. */
private fun Modifier.surface(shape: Shape, color: Color, ink: Color) = shadow(8.dp, shape, clip = false)
    .background(color, shape).border(0.7.dp, ink.copy(alpha = 0.08f), shape).clip(shape)
