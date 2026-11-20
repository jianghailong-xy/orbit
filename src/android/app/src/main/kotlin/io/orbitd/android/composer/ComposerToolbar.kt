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

/** The card's fill: in light #FBFBFB, a hair off the white page as iOS's card reads, and in dark the near-black #1A1A1A iOS 26's glass card reads as over its black page. */
@Composable
internal fun composerCardColor(): Color = MaterialTheme.colorScheme.let { if (it.surface.luminance() > 0.5f) Color(0xFFFBFBFB) else Color(0xFF1A1A1A) }

/** The card's lift in light (iOS 26's glass card over a white page: a soft shadow round it, measured on an iPhone 17 Pro); none in
 *  dark, where iOS shows none on black. */
@Composable
internal fun Modifier.composerCardLift(): Modifier =
    if (MaterialTheme.colorScheme.surface.luminance() > 0.5f) glow(Color.Black.copy(alpha = 0.05f), blur = 20.dp, dy = 2.dp, corner = 24.dp) else this

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

/** The context window's ring (iOS `UsageRing`): the share used, from the top, in the accent until 75%, amber from there and red from
 * 90%; a solid empty ring while no reading has come yet, a dashed one where the engine never reports one. */
@Composable
internal fun UsageRingIcon(percent: Int, unavailable: Boolean, size: Dp = 16.dp) {
    val track = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.18f)
    val ink = when {
        percent >= 90 -> MaterialTheme.colorScheme.error
        percent >= 75 -> io.orbitd.android.ui.LocalOrbitColors.current.needsYou
        else -> MaterialTheme.colorScheme.primary
    }
    val dashed = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
    Canvas(Modifier.size(size).padding(1.25.dp)) {
        val width = (if (unavailable) 1.5.dp else 2.5.dp).toPx()
        val inset = width / 2
        val arc = androidx.compose.ui.geometry.Size(this.size.width - width, this.size.height - width)
        val topLeft = androidx.compose.ui.geometry.Offset(inset, inset)
        if (unavailable) {
            drawArc(dashed, 0f, 360f, false, topLeft, arc, style = Stroke(width, pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.2.dp.toPx(), 2.2.dp.toPx()))))
            return@Canvas
        }
        drawArc(track, 0f, 360f, false, topLeft, arc, style = Stroke(width))
        if (percent > 0) drawArc(ink, -90f, 360f * percent.coerceIn(0, 100) / 100f, false, topLeft, arc, style = Stroke(width, cap = StrokeCap.Round))
    }
}

/** A plan window as the gauge's capsule draws it (iOS `UsageBar`): 24 × 5 dp, in the accent; amber near its limit — from 90% used,
 * or, for a reading of what is left, where the row says so — and red once spent. */
@Composable
internal fun UsageBarIcon(row: UsageRow) {
    val track = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.18f)
    val ink = when {
        row.spent -> MaterialTheme.colorScheme.error
        (if (row.remaining) row.nearLimit else row.percent >= 90) -> io.orbitd.android.ui.LocalOrbitColors.current.needsYou
        else -> MaterialTheme.colorScheme.primary
    }
    Box(Modifier.size(width = 24.dp, height = 5.dp).clip(RoundedCornerShape(3.dp)).background(track)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(row.gaugeFraction.coerceIn(0f, 1f)).clip(RoundedCornerShape(3.dp)).background(ink))
    }
}

/**
 * The staged attachments, inside the card above the text, as iOS's `ComposerAttachmentsView` draws them: an image as a 48 dp thumbnail
 * (8 dp corners) with its × out on the corner, dimmed with a spinner while it uploads; any other file as a one-line chip — paperclip,
 * name, size, × — whose paperclip is the spinner while it uploads. One whose upload failed is not here: the model drops it and says why
 * in the error line above the card.
 */
@Composable
internal fun AttachmentStrip(attachments: List<StagedAttachment>, uploads: Map<String, Float>,
    bytes: suspend (String) -> ByteArray, open: (StagedAttachment) -> Unit, remove: (StagedAttachment) -> Unit) {
    if (attachments.isEmpty()) return
    // The padding is inside the scroller, so an image's × that sits out past its corner is not cut off by the strip's edge.
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, top = 12.dp)
        .testTag("composer-attachments"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        attachments.forEach { att ->
            val uploading = att.id in uploads
            if (att.mime.startsWith("image/")) ImageChip(att, uploading, bytes, open, remove) else FileChip(att, uploading, open, remove)
        }
    }
}

@Composable
private fun ImageChip(att: StagedAttachment, uploading: Boolean, bytes: suspend (String) -> ByteArray,
    open: (StagedAttachment) -> Unit, remove: (StagedAttachment) -> Unit) {
    val shape = RoundedCornerShape(8.dp)
    val bitmap by produceState<android.graphics.Bitmap?>(null, att.id, att.size) {
        if (att.size <= 0) return@produceState
        value = try {
            val data = bytes(att.id)
            withContext(Dispatchers.Default) { decodeAttachmentImage({ data.inputStream() }, maxDimension = 192) }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
    }
    Box(Modifier.size(48.dp)) {
        Box(Modifier.fillMaxSize().clip(shape).background(MaterialTheme.colorScheme.surfaceVariant)
            .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f), shape)
            .clickable(enabled = att.size > 0, role = Role.Button, onClick = { open(att) })
            .semantics { contentDescription = attachmentLabel(att) }.testTag("composer-attachment:${att.id}"), contentAlignment = Alignment.Center) {
            bitmap?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
            if (uploading) {
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)))
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White)
            }
        }
        // iOS's 30 pt target round a small ✕ badge, nudged up and out so it reaches past the thumbnail rather than over it.
        Box(Modifier.align(Alignment.TopEnd).offset(x = 8.dp, y = (-8).dp).size(30.dp).clip(CircleShape)
            .clickable(role = Role.Button, onClick = { remove(att) }).semantics { contentDescription = "Remove ${att.name}" }
            .testTag("composer-attachment-remove:${att.id}"), contentAlignment = Alignment.Center) {
            Box(Modifier.size(16.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.55f)).clearAndSetSemantics {},
                contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_close), null, Modifier.size(9.dp), tint = Color.White)
            }
        }
    }
}

@Composable
private fun FileChip(att: StagedAttachment, uploading: Boolean, open: (StagedAttachment) -> Unit, remove: (StagedAttachment) -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val style = MaterialTheme.typography.bodySmall
    Row(Modifier.widthIn(max = 220.dp).clip(RoundedCornerShape(8.dp)).background(Color.Gray.copy(alpha = 0.12f))
        .clickable(enabled = att.size > 0, role = Role.Button, onClick = { open(att) })
        .semantics { contentDescription = attachmentLabel(att) }.testTag("composer-attachment:${att.id}")
        .padding(start = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (uploading) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = secondary)
        else Icon(painterResource(R.drawable.ic_paperclip), null, Modifier.size(14.dp), tint = secondary)
        Text(att.name, Modifier.weight(1f, fill = false), style = style, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
        Text(fileSize(att.size.toLong()), style = style, color = secondary, maxLines = 1, softWrap = false)
        Box(Modifier.size(26.dp).clip(CircleShape).clickable(role = Role.Button, onClick = { remove(att) })
            .semantics { contentDescription = "Remove ${att.name}" }.testTag("composer-attachment-remove:${att.id}"), contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_x_circle), null, Modifier.size(16.dp), tint = secondary)
        }
    }
}

/** What an attachment is called aloud, and what the composer's tests find it by: its name and size, as the old rows read. */
private fun attachmentLabel(att: StagedAttachment) = "${att.name} · ${att.size / 1024} KB"

/** A file's size as iOS's ByteCountFormatter writes it in the file count style: decimal units, "212 KB", "1.5 MB". */
internal fun fileSize(bytes: Long): String = when {
    bytes <= 0 -> "Zero KB"
    bytes < 1_000 -> "$bytes bytes"
    bytes < 1_000_000 -> "${Math.round(bytes / 1_000.0)} KB"
    bytes < 1_000_000_000 -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1_000_000.0)
    else -> String.format(java.util.Locale.US, "%.2f GB", bytes / 1_000_000_000.0)
}
