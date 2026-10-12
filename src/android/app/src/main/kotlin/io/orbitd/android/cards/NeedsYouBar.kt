package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.lazy.LazyListState
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/** Which way the bar's chevron points: where the words say the thing is. */
enum class NeedsYouChevron { UP, DOWN, FORWARD }

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
    val banner = if (below != null) null else remember(openRows, sessionId) { NeedsYouLogic.banner(openRows, sessionId) }
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
            NeedsYouLogic.belowHint, measured) { onBelow(below.rowId) }
        return
    }
    val waiting = banner ?: return
    NeedsYouBar(waiting.text, NeedsYouChevron.FORWARD, if (waiting.ownerItem == null) NeedsYouLogic.sessionHint else NeedsYouLogic.itemHint, measured) {
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
 * The needs-you bar (iOS `NeedsYouBannerView`): one amber line under the conversation's header saying something is
 * waiting on the reader, and taking them to it. Inside a conversation holding a question that stops no turn it points
 * into that conversation ("1 open question below"); otherwise at the session — or the owner item's card — that has
 * waited longest elsewhere. One style for both: they differ in their words and their chevron only. Deliberately
 * still — no pulse — since what it names can wait for hours above a transcript somebody is reading.
 */
@Composable
internal fun NeedsYouBar(text: String, chevron: NeedsYouChevron, hint: String, modifier: Modifier = Modifier, onPress: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val amber = LocalOrbitColors.current.needsYou
    val surface = MaterialTheme.colorScheme.surface
    // The wash rides on the bar's own surface — the transcript scrolls under it — and dark needs the stronger tint.
    val wash = amber.copy(alpha = if (surface.luminance() < 0.5f) 0.20f else 0.12f).compositeOver(surface)
    val press = { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); onPress() }
    Column(modifier.fillMaxWidth().testTag("needs-you-bar")) {
        // Read as its words, a button, and what the press does (iOS `accessibilityHint`).
        Row(Modifier.fillMaxWidth().background(wash)
            .clickable(onClickLabel = hint, role = Role.Button, onClick = press)
            .padding(horizontal = 16.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
            // The same amber dot the session lists use for "needs you".
            Box(Modifier.size(7.dp).background(amber, CircleShape))
            // Label-primary, not amber: amber text on the amber wash is the legibility trap.
            Text(text, Modifier.weight(1f).testTag("needs-you-bar-text"), color = MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(painterResource(if (chevron == NeedsYouChevron.FORWARD) R.drawable.ic_chevron_forward else R.drawable.ic_chevron_down), null,
                Modifier.size(14.dp).rotate(if (chevron == NeedsYouChevron.UP) 180f else 0f).testTag("needs-you-bar-chevron:${chevron.name}"),
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
        }
        HorizontalDivider()
    }
}
