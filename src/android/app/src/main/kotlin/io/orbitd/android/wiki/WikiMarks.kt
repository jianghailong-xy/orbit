package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.ui.LocalOrbitColors

// The Wiki's marks and row shapes (iOS `WikiView.swift` § marks). The type ramp follows iOS
// `Typography.swift`: prose/control = body, subtext/list subtitle = subheadline, label = footnote,
// meta = caption2 — the app theme's bodyLarge / bodyMedium / bodySmall / labelSmall.

internal object WikiType {
    val prose @Composable get() = MaterialTheme.typography.bodyLarge
    val subtext @Composable get() = MaterialTheme.typography.bodyMedium
    val label @Composable get() = MaterialTheme.typography.bodySmall
    val meta @Composable get() = MaterialTheme.typography.labelSmall
    val mono @Composable get() = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
}

internal object WikiPalette {
    @Composable fun color(tone: WikiTone): Color = when (tone) {
        WikiTone.OWNER -> MaterialTheme.colorScheme.onSurface
        WikiTone.BLUE -> MaterialTheme.colorScheme.primary
        WikiTone.MUTED -> MaterialTheme.colorScheme.onSurfaceVariant
        WikiTone.GREEN -> LocalOrbitColors.current.success
        WikiTone.AMBER -> amber
        WikiTone.RED -> MaterialTheme.colorScheme.error
    }
    val amber @Composable get() = if (isSystemInDarkTheme()) Color(0xFFFFB340) else Color(0xFFB35C00)
    /** The needs-you bar's wash — stronger in dark mode, where 12% all but disappears. */
    val amberWash @Composable get() = Color(0xFFFF9500).copy(alpha = if (isSystemInDarkTheme()) 0.20f else 0.12f)
    val secondary @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
}

/** A toned capsule: a trust, an anchor's check, pinned. The owner's badge is the dark one in either appearance. */
@Composable
internal fun WikiBadge(text: String, tone: WikiTone, check: Boolean = false) {
    val color = WikiPalette.color(tone)
    val owner = tone == WikiTone.OWNER
    Text((if (check) "✓ " else "") + text, maxLines = 1, style = WikiType.meta.copy(fontWeight = FontWeight.SemiBold),
        color = if (owner) MaterialTheme.colorScheme.surface else color,
        modifier = Modifier.background(if (owner) MaterialTheme.colorScheme.onSurface else color.copy(alpha = 0.14f), CircleShape)
            .padding(horizontal = 7.dp, vertical = 2.dp))
}

/** An anchor's state as a line of its own: the mark's word in its tone. */
@Composable
internal fun WikiMarkText(mark: WikiAnchorMark) {
    Text((if (mark.tone == WikiTone.GREEN) "✓ " else "") + mark.word, style = WikiType.meta.copy(fontWeight = FontWeight.SemiBold),
        color = WikiPalette.color(mark.tone))
}

/** A list row: a title (struck through once agents no longer get it) with a time on its right, then a line under it —
 * with Activity's [dot] before the title when it has one (blue: it came after the reader last looked). */
@Composable
internal fun WikiRowLabel(title: String, time: String? = null, detail: String? = null, note: String? = null,
    struck: Boolean = false, mark: String? = null, dot: Color? = null) {
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // The title takes the room the time leaves, and the mark follows it (iOS: title, mark, Spacer, time).
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // A glyph TalkBack would only spell out: the band's header says how many are new.
                if (dot != null) Text("●", Modifier.clearAndSetSemantics {}, style = WikiType.meta, color = dot)
                Text(title, Modifier.weight(1f, fill = false), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textDecoration = if (struck) TextDecoration.LineThrough else null,
                    color = if (struck) WikiPalette.secondary else MaterialTheme.colorScheme.onSurface)
                if (mark != null) WikiBadge(WikiCopy.trustLabel(mark), WikiLogic.trustTone(mark))
            }
            if (time != null) Text(time, style = WikiType.label, color = WikiPalette.secondary, maxLines = 1)
        }
        if (!detail.isNullOrEmpty()) Text(detail, style = WikiType.subtext, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (!note.isNullOrEmpty()) Text(note, style = WikiType.label, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A tappable row with Android's 48dp target; disabled rows stay readable. */
@Composable
internal fun WikiRowButton(tag: String, enabled: Boolean = true, onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .padding(horizontal = 16.dp, vertical = 6.dp).testTag(tag), contentAlignment = Alignment.CenterStart) { content() }
}

/** A band's heading, as the first row of its band: the title, its count, a badge, a hint — and [new], Activity's line
 * beside Recently changed (`4 new since you last looked`), in the blue of the dots it counts. */
@Composable
internal fun WikiBandHeader(title: String, count: Int? = null, badge: String? = null, hint: String? = null, new: String? = null) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = WikiType.subtext.copy(fontWeight = FontWeight.Bold))
        if (count != null) Text("$count", style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = WikiPalette.secondary)
        if (badge != null) WikiBadge(badge, WikiTone.OWNER)
        if (hint != null) Text(hint, style = WikiType.label, color = WikiPalette.secondary)
        if (new != null) Row(Modifier.testTag("wiki-activity-new"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("●", Modifier.clearAndSetSemantics {}, style = WikiType.meta, color = WikiPalette.color(WikiTone.BLUE))
            Text(new, style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = WikiPalette.color(WikiTone.BLUE))
        }
    }
}

@Composable
internal fun WikiEmptyLine(text: String) {
    Text(text, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = WikiType.label, color = WikiPalette.secondary)
}

/** A grouped card, the iOS inset-grouped list section's shape. */
@Composable
internal fun WikiCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)).padding(vertical = 4.dp), content = content)
}

/** The status line under the title: each part behind its `·`, amber while a run waits, red when it broke,
 * a green ✓ after a run that succeeded, and Set up and View run as links (iOS `wikiStatusText`). */
@Composable
internal fun wikiStatusText(parts: List<WikiStatusPart>, openSettings: () -> Unit, openRun: () -> Unit): AnnotatedString {
    val warn = WikiPalette.amber; val error = MaterialTheme.colorScheme.error; val green = LocalOrbitColors.current.success
    val link = MaterialTheme.colorScheme.primary
    return buildAnnotatedString {
        parts.forEachIndexed { index, part ->
            if (index > 0) append(" · ")
            val colour = when (part.tone) { WikiStatusPart.Tone.WARN -> warn; WikiStatusPart.Tone.ERROR -> error; else -> Color.Unspecified }
            // No-break spaces keep the dot on the line of the words it colours, and the ✓ on the line of its success.
            if (part.mark == WikiStatusPart.Mark.DOT) withStyle(SpanStyle(color = colour)) { append("● ") }
            val style = SpanStyle(color = if (part.link != WikiStatusPart.Link.NONE) link else colour,
                fontWeight = if (part.strong) FontWeight.SemiBold else null)
            when (part.link) {
                WikiStatusPart.Link.SETTINGS -> withLink(LinkAnnotation.Clickable("settings", TextLinkStyles(style)) { openSettings() }) { append(part.text) }
                WikiStatusPart.Link.RUN -> withLink(LinkAnnotation.Clickable("run", TextLinkStyles(style)) { openRun() }) { append(part.text) }
                WikiStatusPart.Link.NONE -> withStyle(style) { append(part.text) }
            }
            if (part.mark == WikiStatusPart.Mark.CHECK) withStyle(SpanStyle(color = green)) { append(" ✓") }
        }
    }
}

/** A decision's date as the day it was decided (`9/25`), the way the lists date things older than a week. */
internal object WikiDate {
    fun monthDay(iso: String?, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String? {
        val at = RelativeTime.parse(iso)?.atZone(zone) ?: return null
        return "${at.monthValue}/${at.dayOfMonth}"
    }
    /** OrbitKit `RelativeTime.format`: "just now", "4m ago" … "3w ago", then `M/d`. */
    fun relative(iso: String?, now: java.time.Instant, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String? {
        val date = RelativeTime.parse(iso) ?: return null
        val diff = RelativeTime.seconds(date, now)
        val min = 60.0; val hour = 3600.0; val day = 86_400.0; val week = 604_800.0
        return when {
            diff < min -> "just now"
            diff < hour -> "${(diff / min).toInt()}m ago"
            diff < day -> "${(diff / hour).toInt()}h ago"
            diff < week -> "${(diff / day).toInt()}d ago"
            diff < 4 * week -> "${(diff / week).toInt()}w ago"
            else -> monthDay(iso, zone)
        }
    }
}
