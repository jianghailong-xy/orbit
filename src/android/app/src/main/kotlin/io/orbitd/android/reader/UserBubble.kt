package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.MultiContentMeasurePolicy
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.drive.DriveChatCopy
import io.orbitd.android.text.MarkdownText
import io.orbitd.android.text.TranscriptImage
import io.orbitd.android.translation.BilingualEnglish
import kotlinx.coroutines.delay

/**
 * The reader's own turn, drawn as iOS draws it (OrbitApp `UserBubbleView`, web `.chat-user-wrap`): on the trailing side behind a
 * 60 dp gutter, a sender's line when it was not the reader, then its images and files, then its words in a tinted bubble that hugs
 * them, then [content] — the meta line and whatever states hang under it, each on the trailing edge.
 */
@Composable
internal fun UserTurnColumn(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Row(modifier.fillMaxWidth()) {
        Spacer(Modifier.width(60.dp))
        Column(Modifier.weight(1f).testTag("user-turn"), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp),
            content = content)
    }
}

/** Who sent it when it was not the reader (`From Feishu · <name>`): one muted line over the bubble, as on iOS. */
@Composable
internal fun UserTurnSender(label: String) =
    Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)

/** The tint of a person's bubble, as iOS's `.tint.opacity(0.15)` reads on an iPhone (measured: light #E0E9FF, dark #071026). */
@Composable
internal fun userBubbleColor(): Color = if (MaterialTheme.colorScheme.surface.luminance() > 0.5f) Color(0xFFE0E9FF) else Color(0xFF071026)

/** The words, and under them the English the agent read when both languages are shown: 12dp corners, 12 by 8 inside. */
@Composable
internal fun UserWordsBubble(words: String, english: String?, open: (String) -> Unit) {
    Column(Modifier.testTag("user-bubble").clip(RoundedCornerShape(12.dp)).background(userBubbleColor())
        .padding(horizontal = 12.dp, vertical = 8.dp)) {
        MarkdownText(words, open = open)
        english?.let { BilingualEnglish(it) }
    }
}

/** A sent image is a fitted thumbnail a tap opens; two or more wrap as square thumbnails. Files are chips a tap opens. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun UserTurnAttachments(images: List<Pair<String, String>>, files: List<Pair<String, String>>, open: (String) -> Unit) {
    if (images.size == 1) TranscriptImage(images[0].first, images[0].second, open, inBubble = true)
    else if (images.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        images.forEach { (source, name) -> TranscriptImage(source, name, open, inBubble = true, square = true) }
    }
    if (files.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        files.forEach { (source, name) ->
            Row(Modifier.widthIn(max = 280.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant)
                .clickable(role = Role.Button) { open(source) }.padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(painterResource(R.drawable.ic_paperclip), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(name, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** The copy glyph of the meta line, a check for a moment once pressed (iOS `doc.on.doc` → `checkmark`). */
@Composable
internal fun UserTurnCopy(copy: () -> Unit) {
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1_600); copied = false } }
    Icon(painterResource(if (copied) R.drawable.ic_check else R.drawable.ic_copy), "Copy message",
        Modifier.testTag("user-turn-copy").size(16.dp).clickable(role = Role.Button, onClickLabel = "Copy message") { copy(); copied = true },
        tint = MaterialTheme.colorScheme.onSurfaceVariant)
}

/**
 * The meta line under the bubble: [lead] (copy, the time), then a delivered translation's [foot]. On one line, after a dot when
 * [dotted], where all of it fits; otherwise the foot drops to a line of its own under them, and the dot goes with it rather than
 * hanging off the time (iOS `meta`'s ViewThatFits). Both lines sit on the trailing edge.
 */
@Composable
internal fun UserTurnMetaLine(lead: @Composable () -> Unit, foot: (@Composable () -> Unit)?, dotted: Boolean) {
    Layout(listOf<@Composable () -> Unit>(lead, { if (foot != null && dotted) UserTurnMetaText("·") }, { foot?.invoke() }), Modifier.testTag("user-turn-meta"),
        MultiContentMeasurePolicy { parts, constraints ->
        val (leadPart, dotPart, footPart) = parts
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val gap = 6.dp.roundToPx()
        val l = leadPart.firstOrNull()?.measure(loose)
        val d = dotPart.firstOrNull()?.measure(loose)
        val f = footPart.firstOrNull()?.measure(loose)
        val lw = l?.width ?: 0
        val fw = f?.width ?: 0
        val dw = if (lw > 0 && fw > 0) d?.width ?: 0 else 0
        val widths = listOf(lw, dw, fw).filter { it > 0 }
        val inline = widths.sum() + gap * (widths.size - 1).coerceAtLeast(0)
        if (inline <= constraints.maxWidth) {
            val height = maxOf(l?.height ?: 0, d?.height ?: 0, f?.height ?: 0)
            layout(inline, height) {
                var x = 0
                listOfNotNull(l, d.takeIf { dw > 0 }, f).filter { it.width > 0 }.forEach { part ->
                    part.place(x, (height - part.height) / 2); x += part.width + gap
                }
            }
        } else {
            val width = maxOf(lw, fw)
            val top = l?.height ?: 0
            val between = 2.dp.roundToPx()
            layout(width, top + between + (f?.height ?: 0)) {
                l?.place(width - lw, 0)
                f?.place(width - fw, top + between)
            }
        }
    })
}

/** The meta line's muted words: the send time, or the state that stands in for it. */
@Composable
internal fun UserTurnMetaText(text: String) =
    Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)

/** `⊕ Orbit attached: Folder · Scans` under the owner's message: what Orbit told the agent beside their words (a page chat's note). */
@Composable
internal fun OrbitAttachedLine(label: String) = Row(Modifier.testTag("orbit-attached"), horizontalArrangement = Arrangement.spacedBy(5.dp),
    verticalAlignment = Alignment.CenterVertically) {
    Icon(painterResource(R.drawable.ic_add_circle), null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    Text("${DriveChatCopy.ORBIT_ATTACHED}: $label", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
