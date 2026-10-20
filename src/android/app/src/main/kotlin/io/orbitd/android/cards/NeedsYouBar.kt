package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.lazy.LazyListState
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.directory.TrashingSessions
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.tasks.TaskTime
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import java.time.Instant

/** Which way the bar's chevron points: where the words say the card is. Only the bar pointing into this conversation has one —
 * the cross-session bar's press goes elsewhere, which its words already say, and the whole capsule is the press. */
enum class NeedsYouChevron { UP, DOWN }

/** Whether the bar was last shown, whether it has shown yet, and its last measured height: what the list is scrolled
 * by when the bar comes or goes, so the line being read stays where it was (the sticky header's `HeaderShift`). */
private class BarShift { var shown = false; var seen = false; var height = 0f }

/**
 * The bar above a conversation's transcript (iOS `ConsoleView`'s top inset): a card waiting in THIS conversation wins —
 * its destination is already here, and leaving to find the other would lose the reader's place — and otherwise what
 * waits elsewhere, the session on screen left out of it. [below] is this conversation's answer; a press on it is
 * [onBelow] with the row to show. Folded away ([hidden]) with the rest of the chrome while a phone's composer types.
 */
@Composable
internal fun SessionNeedsYouBar(app: OrbitApplication, handle: SessionHandle, sessionId: String, list: LazyListState,
    hidden: Boolean, below: WaitingBelow?, onBelow: (String) -> Unit, open: (OrbitRoute) -> Unit) {
    val openRows by remember(app, handle) {
        app.realtime.state.map { live -> if (live.handle === handle) live.directory?.sessions?.get("open").orEmpty() else emptyList() }
            .distinctUntilChanged()
    }.collectAsState(emptyList())
    // A session on its way to Trash is waiting on nobody (A05-9), as it is in none of the lists.
    val trashing by app.trashing.ids.collectAsState()
    val banner = if (below != null) null else remember(openRows, sessionId, trashing) {
        NeedsYouLogic.banner(TrashingSessions.without(openRows, trashing) { it.text("id") }, sessionId)
    }
    val shift = remember(list) { BarShift() }
    val shown = !hidden && (below != null || banner != null)
    LaunchedEffect(shift, shown) {
        if (shown == shift.shown) return@LaunchedEffect
        shift.shown = shown
        // Its first showing is the conversation opening: the place it restores was not read under a bar.
        if (shown && !shift.seen) { shift.seen = true; return@LaunchedEffect }
        if (shift.height > 0f) list.dispatchRawDelta(if (shown) shift.height else -shift.height)
    }
    if (!shown) return
    val measured = Modifier.onSizeChanged { shift.height = it.height.toFloat() }
    if (below != null) {
        NeedsYouBar(below.text, if (below.side == ReaderSide.ABOVE) NeedsYouChevron.UP else NeedsYouChevron.DOWN,
            NeedsYouLogic.belowHint, measured, glyph = below.glyph) { onBelow(below.rowId) }
        return
    }
    val waiting = banner ?: return
    NeedsYouBar(waiting.text, null, if (waiting.ownerItem == null) NeedsYouLogic.sessionHint else NeedsYouLogic.itemHint, measured,
        detail = waiting.detail, since = waiting.since, more = waiting.more, glyph = waiting.glyph) {
        val target = waiting.target.text("id") ?: return@NeedsYouBar
        val workspace = waiting.target.obj("agent")?.text("id") ?: waiting.target.text("agentId") ?: waiting.target.text("workspaceId")
        // A merge into main waiting on the reader is answered on its project's sessions page, where its card is (iOS 6b4bef713).
        val project = waiting.target.obj("projectMembership")?.text("projectId")
        if (waiting.ownerItem?.kind == "PROMOTION_APPROVAL" && project != null) {
            open(OrbitRoute(Destination.PROJECT_SESSIONS, project, workspace, origin = Origin.LIST)); return@NeedsYouBar
        }
        // One of the other owner items opens the CARD it names in its coordinator conversation; anything else the session.
        waiting.ownerItem?.let { CardFocus.request(target, NeedsYouLogic.cardKey(it)) }
        open(OrbitRoute(Destination.SESSION, target, workspace))
    }
}

/**
 * The needs-you bar (iOS `NeedsYouBannerView`): a capsule under the conversation's header saying something is waiting on the
 * reader, and taking them to it. Inside a conversation holding a question that stops no turn it points into that conversation
 * ("1 open question below"); otherwise at the session — or the owner item's card — that has waited longest elsewhere. One style
 * for both: they differ in their words, their mark and their chevron only. Deliberately still — no pulse — since what it names
 * can wait for hours above a transcript somebody is reading.
 *
 * A capsule, not a band (the owner, 2026-10-21, `docs/mocks/needs-you-capsule`): the amber is one 30 dp circle — the landing
 * head's (`ProjectLandingHead`) — whose mark says which kind is waiting, never a wash under the words; the words are two lines,
 * [text] what and [detail] where, with how long it has waited ([since]) and how many wait behind it ([more]). Material has no
 * glass, so the capsule is the raised surface the reader's cards use, on the page's own surface: the transcript scrolls under
 * the bar, and the gap around the capsule must not show it.
 */
@Composable
internal fun NeedsYouBar(text: String, chevron: NeedsYouChevron?, hint: String, modifier: Modifier = Modifier, detail: String? = null,
    since: String? = null, more: Int = 0, glyph: NeedsYouGlyph = NeedsYouGlyph.QUESTION, onPress: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val amber = LocalOrbitColors.current.needsYou
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val press = { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); onPress() }
    Box(modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface).padding(start = 16.dp, end = 16.dp, bottom = 6.dp)
        .testTag("needs-you-bar")) {
        // Read as its words, a button, and what the press does (iOS `accessibilityHint`).
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClickLabel = hint, role = Role.Button, onClick = press)
            .padding(start = 7.dp, end = 16.dp, top = 5.dp, bottom = 5.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            // The one place the amber is; the words stay the surface's own — amber words on amber were the band's trap.
            Box(Modifier.size(30.dp).background(amber.copy(alpha = 0.15f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(painterResource(glyph.drawable), null, Modifier.size(16.dp).testTag("needs-you-bar-glyph:${glyph.name}"), tint = amber)
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(text, Modifier.weight(1f).testTag("needs-you-bar-text"), color = MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (more > 0) Text("+$more", Modifier.testTag("needs-you-bar-more").background(muted.copy(alpha = 0.14f), CircleShape)
                        .padding(horizontal = 6.dp), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = muted)
                    since?.let { NeedsYouAge(it) }
                }
                detail?.let {
                    Text(it, Modifier.testTag("needs-you-bar-detail"), style = MaterialTheme.typography.bodySmall, color = muted,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            chevron?.let {
                Icon(painterResource(R.drawable.ic_chevron_down), null,
                    Modifier.size(14.dp).rotate(if (it == NeedsYouChevron.UP) 180f else 0f).testTag("needs-you-bar-chevron:${it.name}"), tint = muted)
            }
        }
    }
}

/** How long the thing the bar names has waited — "12m", "2h" — kept current while it sits there: the words of a duration still
 * running (`TaskTime.elapsed`, iOS `RelativeTime.elapsed`), not of an event. */
@Composable
private fun NeedsYouAge(since: String) {
    val now by produceState(Instant.now(), since) { while (true) { delay(30_000); value = Instant.now() } }
    TaskTime.elapsed(since, now)?.let {
        Text(it, Modifier.testTag("needs-you-bar-age"), style = MaterialTheme.typography.bodySmall.copy(fontFeatureSettings = "tnum"),
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, softWrap = false)
    }
}

/** The drawable for each mark (iOS `NeedsYouGlyph.symbol`). */
private val NeedsYouGlyph.drawable: Int get() = when (this) {
    NeedsYouGlyph.MERGE -> R.drawable.ic_merge
    NeedsYouGlyph.QUESTION -> R.drawable.ic_question_bubble
    NeedsYouGlyph.WARNING -> R.drawable.ic_warning
    NeedsYouGlyph.PAUSE -> R.drawable.ic_pause
    NeedsYouGlyph.HAND -> R.drawable.ic_permission
}
