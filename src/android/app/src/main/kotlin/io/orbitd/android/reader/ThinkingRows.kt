package io.orbitd.android.reader

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.text.StreamingText
import kotlinx.coroutines.flow.filter
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.util.Locale
import kotlin.math.roundToLong

/**
 * What a settled stretch of reasoning says on its folded row (A06-11; OrbitKit `ThinkingSummary`, web `thinkingDraft.ts`,
 * word for word): `Thought for 1m 47s · 3 blocks · 21k chars`. A bare "Thinking" told a reader nothing about whether opening it
 * was worth it, and a turn stacks ten of them.
 *
 * The duration is the runner's: it times the stretch while its deltas pass through and stores `thinkingMs` on the durable
 * `thinking` that closes it (runner-go `thinking_clock.go`, iOS d55e9900b), which is what a reload still has. A block an older
 * runner stored has no such figure and states its size alone — this client measures no span of its own: the server sends
 * `thinking_delta` without a stamp, and the device's clock would restart on a reconnect's replayed prefix, so it could only
 * guess, and a stretch is reported with no duration rather than with a wrong one.
 */
internal object ThinkingSummary {
    /** Whole seconds under a minute. Never "0s": rounding a 400 ms block to zero reads as "it did not happen". */
    fun duration(seconds: Double): String {
        val total = maxOf(1L, seconds.roundToLong())
        if (total < 60) return "${total}s"
        val rest = total % 60
        return if (rest == 0L) "${total / 60}m" else "${total / 60}m ${rest}s"
    }

    /** Size in characters rather than words: the reasoning is as often CJK as English, and a word count reads as 1 for a whole
     * Chinese paragraph. */
    fun size(chars: Int): String =
        if (chars < 1000) "$chars chars" else String.format(Locale.ROOT, "%.1f", chars / 1000.0).removeSuffix(".0") + "k chars"

    /** The whole row: the block count only when blocks were folded together, the duration only when the runner stored one. */
    fun settledLabel(chars: Int, blocks: Int, thinkingMs: Long?): String = buildList {
        add(if (thinkingMs != null && thinkingMs > 0) "Thought for ${duration(thinkingMs / 1000.0)}" else "Thought")
        if (blocks > 1) add("$blocks blocks")
        add(size(chars))
    }.joinToString(" · ")
}

/** The reasoning a thinking row holds: its block's words, and the words of each adjacent block folded into it. */
internal fun TranscriptRow.thinkingText(): String = (listOf(event) + folded).map { it.body() }.filter { it.isNotEmpty() }.joinToString("\n\n")

/** How long the runner timed the row's blocks, summed; null when none of them says. */
internal fun TranscriptRow.thinkingMs(): Long? = (listOf(event) + folded).mapNotNull { block ->
    (block.fields["thinkingMs"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.roundToLong()
}.ifEmpty { null }?.sum()

/** How many blocks the row folds together. */
internal val TranscriptRow.blocks: Int get() = 1 + folded.size

/**
 * A thinking row's one tap line (iOS `ThinkingView.row`): a chevron turned rather than swapped, so the line never jumps, the
 * reasoning glyph, and what the stretch says. The whole line folds and opens it.
 */
@Composable
internal fun ThinkingFold(label: String, expanded: Boolean, toggle: () -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().heightIn(min = 32.dp)
        .clickable(onClickLabel = if (expanded) "Hide thinking" else "Show thinking", role = Role.Button, onClick = toggle)
        .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }.testTag("thinking-fold"),
        horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("▸", Modifier.rotate(if (expanded) 90f else 0f).clearAndSetSemantics { }, color = MaterialTheme.colorScheme.outline,
            style = MaterialTheme.typography.labelLarge)
        Text("💭", Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.labelLarge)
        Text(label, Modifier.weight(1f), color = secondary, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * A stretch of reasoning still being written (iOS `ThinkingView` before it settles): open, since watching it think is the point
 * of showing it at all, and held to about 160 dp that keep themselves at the newest line — unbounded, it pushed the answer and the
 * calls on the way to it out of a transcript pinned to its tail (a DeepSeek turn writes 23k characters of reasoning at the
 * median). Sticky but not forced, as the web holds it: a reader who scrolls up inside it stays there. A tap folds it.
 */
@Composable
internal fun LiveThinking(parent: String, text: String, open: (String) -> Unit) {
    var pinned by rememberSaveable(parent) { mutableStateOf<Boolean?>(null) }
    val expanded = pinned ?: true
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ThinkingFold(if (parent.isEmpty()) "Thinking…" else "Subagent · Thinking…", expanded) { pinned = !expanded }
        if (expanded) {
            val scroll = rememberScrollState()
            LaunchedEffect(scroll) {
                // Unmeasured, the box opens at its newest line; after that it follows only a reader still at the end.
                var end: Int? = null
                snapshotFlow { scroll.maxValue }.filter { it != Int.MAX_VALUE }.collect { max ->
                    if (end.let { it == null || scroll.value >= it - 1 }) scroll.scrollTo(max)
                    end = max
                }
            }
            CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant) {
                Box(Modifier.fillMaxWidth().heightIn(max = 160.dp).verticalScroll(scroll).testTag("thinking-live")) { StreamingText(text, open) }
            }
        }
    }
}
