package io.orbitd.android.composer

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.attachments.decodeAttachmentImage
import io.orbitd.android.management.Ink
import io.orbitd.android.management.UsageRow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/*
 * The composer card's pieces (board docs/mocks/android-composer-parity, iOS ComposerView's card and toolbar): the card's surface,
 * the staged attachments inside it, and the toolbar at its foot — `+` and the permission mode on the left, the model, the usage
 * gauge, Optimize and a round Send/Stop on the right.
 */

/** The card's corner: the toolbar's round ends sit on its centre, as iOS's `cardRadius`. */
internal val ComposerCardShape = RoundedCornerShape(24.dp)

/** The card's fill: the page's own surface in light (white on the band's tint), a raised tone in dark, where the page is darker. */
@Composable
internal fun composerCardColor(): Color = MaterialTheme.colorScheme.let { if (it.surface.luminance() > 0.5f) it.surface else it.surfaceColorAtElevation(6.dp) }

/** The card's hairline, deeper while the box is being typed in (iOS: 0.22 focused, 0.10 at rest). */
@Composable
internal fun composerCardBorder(focused: Boolean): Color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (focused) 0.24f else 0.12f)

/** The toolbar's words: list-subtitle size, as iOS's `.orbitListSubtitle`. */
@Composable
internal fun toolbarTextStyle(): TextStyle = MaterialTheme.typography.bodyMedium

// Widths of the toolbar's fixed parts, in dp: what the fit below adds up.
internal const val TOOLBAR_PLUS = 40f
internal const val TOOLBAR_SEND = 44f
internal const val TOOLBAR_RING = 32f
internal const val TOOLBAR_CAPSULE = 60f
internal const val TOOLBAR_TEXT_PAD = 12f
internal const val TOOLBAR_EDGE = 8f
internal const val OPTIMIZE_COMPACT = 40f

/** What the toolbar draws when the row is full: the Optimize button's ✦-only form, and the chip without its effort. */
internal data class ToolbarFit(val compactOptimize: Boolean, val showsEffort: Boolean)

/**
 * What gives way in a full toolbar (board composer-usage-tap 04, option C, as iOS lays it out): the model chip — with its effort —
 * gets its room before Optimize, so "✦ Optimize" folds to ✦ first; the effort leaves the chip next (it stays in the model menu); only
 * then does the model's name truncate. [room] is what the row has for the chip and Optimize together; [optimize] is null with no
 * Optimize on the row.
 */
internal fun toolbarFit(room: Float, chipWithEffort: Float, optimize: Float?): ToolbarFit = when {
    optimize == null -> ToolbarFit(compactOptimize = false, showsEffort = chipWithEffort <= room)
    chipWithEffort + optimize <= room -> ToolbarFit(compactOptimize = false, showsEffort = true)
    chipWithEffort + OPTIMIZE_COMPACT <= room -> ToolbarFit(compactOptimize = true, showsEffort = true)
    else -> ToolbarFit(compactOptimize = true, showsEffort = false)
}

/** Measures the toolbar's words for [toolbarFit]: a string's width in dp, in the style it is drawn in. */
@Composable
internal fun rememberToolbarMeasure(): (String, TextStyle) -> Float {
    val measurer = rememberTextMeasurer()
    val density = androidx.compose.ui.platform.LocalDensity.current
    return remember(measurer, density) {
        { text: String, style: TextStyle -> with(density) { measurer.measure(text, style, maxLines = 1).size.width.toDp().value } }
    }
}

/** The `+` at the toolbar's left end: a 40 dp cell whose target reaches 48 dp into the room beside it. */
@Composable
internal fun ToolbarPlus(enabled: Boolean, open: () -> Unit) {
    Box(Modifier.size(width = TOOLBAR_PLUS.dp, height = 48.dp).clip(CircleShape)
        .clickable(enabled = enabled, role = Role.Button, onClickLabel = "Add", onClick = open)
        .semantics { contentDescription = "Add a command, skill, shell command, or attachment" }.testTag("composer-plus"),
        contentAlignment = Alignment.Center) {
        Icon(painterResource(R.drawable.ic_plus), null, Modifier.size(24.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (enabled) 1f else 0.38f))
    }
}

/** The permission mode on the toolbar (iOS `modeMenu`): its name, which never truncates; pressed, the modes this engine offers. */
@Composable
internal fun ToolbarMode(label: String, enabled: Boolean, open: () -> Unit) {
    Box(Modifier.height(48.dp).clip(RoundedCornerShape(12.dp)).clickable(enabled = enabled, role = Role.Button, onClick = open)
        .semantics { contentDescription = "Permission mode $label" }.testTag("composer-mode")
        .padding(horizontal = (TOOLBAR_TEXT_PAD / 2).dp), contentAlignment = Alignment.Center) {
        Text(label, style = toolbarTextStyle(), fontWeight = FontWeight.Medium, maxLines = 1, softWrap = false,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (enabled) 1f else 0.38f))
    }
}

/** One mode in the toolbar's menu: ✓ on the one in use, and what the mode does there where the engine says ([note]). */
@Composable
internal fun ModeMenuItem(label: String, selected: Boolean, note: String?, enabled: Boolean, modifier: Modifier = Modifier, pick: () -> Unit) {
    DropdownMenuItem(text = {
        Column {
            Text(label)
            note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }, leadingIcon = { Box(Modifier.width(20.dp)) { if (selected) Text("✓", color = MaterialTheme.colorScheme.primary) } },
        enabled = enabled, modifier = modifier, onClick = pick)
}

/**
 * Send, or Stop with nothing typed where there is something to stop: a 40 dp filled circle in a 44 dp cell, its target 48 dp (iOS's
 * 32 pt `sendControls`, at Material's size). Greyed with nothing to send; a spinner while the message waits for its uploads or goes.
 * Said aloud by [label] ("Send", "Stop", "Uploading…", "Sending…").
 */
@Composable
internal fun RoundSend(stop: Boolean, waiting: Boolean, enabled: Boolean, label: String, modifier: Modifier, press: () -> Unit) {
    Box(Modifier.width(TOOLBAR_SEND.dp), contentAlignment = Alignment.Center) {
        FilledIconButton(onClick = press, enabled = enabled, modifier = modifier.size(40.dp).semantics { contentDescription = label }) {
            if (waiting) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
            else Icon(painterResource(if (stop) R.drawable.ic_stop else R.drawable.ic_arrow_up), null, Modifier.size(22.dp))
        }
    }
}

/** The context window's ring (iOS `UsageRing`): the share used, from the top; empty with no reading yet, dashed where the engine never
 * reports one. */
@Composable
internal fun UsageRingIcon(fraction: Float, unavailable: Boolean, size: Dp = 18.dp) {
    val track = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.30f)
    val ink = MaterialTheme.colorScheme.onSurfaceVariant
    Canvas(Modifier.size(size)) {
        val width = 2.2.dp.toPx()
        val inset = width / 2
        val arc = androidx.compose.ui.geometry.Size(this.size.width - width, this.size.height - width)
        val topLeft = androidx.compose.ui.geometry.Offset(inset, inset)
        drawArc(track, 0f, 360f, false, topLeft, arc, style = Stroke(width,
            pathEffect = if (unavailable) PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 2.dp.toPx())) else null))
        if (!unavailable && fraction > 0f) drawArc(ink, -90f, 360f * fraction.coerceIn(0f, 1f), false, topLeft, arc,
            style = Stroke(width, cap = StrokeCap.Round))
    }
}

/** A plan window as the gauge's capsule draws it (iOS `UsageBar`): 24 × 5 dp, red once spent, the needs-you colour near the limit. */
@Composable
internal fun UsageBarIcon(row: UsageRow) {
    val track = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.30f)
    val ink = when {
        row.spent -> Ink.red
        row.nearLimit && !row.remaining -> io.orbitd.android.ui.LocalOrbitColors.current.needsYou
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Box(Modifier.size(width = 24.dp, height = 5.dp).clip(RoundedCornerShape(3.dp)).background(track)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(row.gaugeFraction.coerceIn(0f, 1f)).clip(RoundedCornerShape(3.dp)).background(ink))
    }
}

/**
 * The staged attachments, inside the card above the text (iOS `ComposerAttachmentsView`): an image as a 58 dp thumbnail, any other
 * file as its name and size; × removes one. One uploading shows its progress along its foot. One whose upload failed is not here:
 * the model drops it and says why in the error line above the card, as iOS does.
 */
@Composable
internal fun AttachmentStrip(attachments: List<StagedAttachment>, uploads: Map<String, Float>,
    bytes: suspend (String) -> ByteArray, open: (StagedAttachment) -> Unit, remove: (StagedAttachment) -> Unit) {
    if (attachments.isEmpty()) return
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 12.dp).horizontalScroll(rememberScrollState())
        .testTag("composer-attachments"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        attachments.forEach { att -> AttachmentTile(att, uploads[att.id], bytes, open, remove) }
    }
}

@Composable
private fun AttachmentTile(att: StagedAttachment, progress: Float?, bytes: suspend (String) -> ByteArray,
    open: (StagedAttachment) -> Unit, remove: (StagedAttachment) -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    val image = att.mime.startsWith("image/")
    val bitmap by produceState<android.graphics.Bitmap?>(null, att.id, att.size) {
        if (!image || att.size <= 0) return@produceState
        value = try {
            val data = bytes(att.id)
            withContext(Dispatchers.Default) { decodeAttachmentImage({ data.inputStream() }, maxDimension = 240) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
    }
    val described = "${att.name} · ${att.size / 1024} KB"
    Box(Modifier.height(58.dp).then(if (image) Modifier.width(58.dp) else Modifier.widthIn(min = 96.dp, max = 180.dp))
        .clip(shape).background(MaterialTheme.colorScheme.surfaceVariant)
        .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.25f), shape)
        .clickable(enabled = att.size > 0, role = Role.Button, onClick = { open(att) })
        .semantics { contentDescription = described }.testTag("composer-attachment:${att.id}")) {
        if (image) bitmap?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
        else Column(Modifier.align(Alignment.CenterStart).padding(start = 12.dp, end = 28.dp)) {
            Text(att.name, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            Text(io.orbitd.android.tasks.TaskDetailLogic.humanSize(att.size.toLong()), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        progress?.let { done ->
            Box(Modifier.align(Alignment.BottomCenter).padding(horizontal = 6.dp, vertical = 6.dp).fillMaxWidth().height(3.dp)
                .clip(RoundedCornerShape(2.dp)).background(Color.White.copy(alpha = 0.3f))) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(done.coerceIn(0f, 1f)).background(MaterialTheme.colorScheme.primary))
            }
        }
        Box(Modifier.align(Alignment.TopEnd).padding(2.dp).size(24.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClick = { remove(att) }).semantics { contentDescription = "Remove ${att.name}" }
            .testTag("composer-attachment-remove:${att.id}"), contentAlignment = Alignment.Center) {
            Box(Modifier.size(18.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)).clearAndSetSemantics {},
                contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_close), null, Modifier.size(12.dp), tint = Color.White)
            }
        }
    }
}
