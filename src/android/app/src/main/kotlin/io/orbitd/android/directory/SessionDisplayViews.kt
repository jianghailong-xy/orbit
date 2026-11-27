package io.orbitd.android.directory

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.ui.LocalOrbitColors

/* How Android draws what [SessionDisplay] decides (the approved board, docs/mocks/session-display-three-states): the state icon, and the
 * marks as small labelled chips after the state word. Drawing only: neither decides anything about the session. */

/** A list row's facts. */
internal val DirectorySession.displayFacts: SessionDisplay.Facts get() = SessionDisplay.Facts(phase, released, lastTurnOutcome, waitingOn,
    endReason, workFinished, activity, pendingApprovals, runningBgCount ?: 0)

/** A search hit's facts. A hit carries no approval count: `waitingOn` says who it waits on. */
internal val SearchHit.displayFacts: SessionDisplay.Facts get() = SessionDisplay.Facts(phase, released, lastTurnOutcome, waitingOn,
    endReason, workFinished, activity, runningBgCount = runningBgCount ?: 0)

/** The state icon, in the quiet tone of the slot it sits in: a clock for Queued, the row's spinner for Running, an empty circle for Idle. */
@Composable
internal fun SessionStateGlyph(state: SessionDisplayState, modifier: Modifier = Modifier) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val tagged = modifier.testTag("session-state-icon:${state.name}")
    when (state.icon) {
        SessionDisplayState.Icon.SPINNER -> RowSpinner(tagged)
        SessionDisplayState.Icon.CLOCK -> Icon(painterResource(R.drawable.ic_clock), null, tagged.size(14.dp), tint = muted)
        SessionDisplayState.Icon.CIRCLE -> Icon(painterResource(R.drawable.ic_state_idle), null, tagged.size(14.dp), tint = muted)
    }
}

@Composable
internal fun SessionMark.color(): Color = when (tone) {
    SessionMark.Tone.AMBER -> LocalOrbitColors.current.needsYou
    SessionMark.Tone.RED -> MaterialTheme.colorScheme.error
    SessionMark.Tone.GREEN -> LocalOrbitColors.current.success
    SessionMark.Tone.GREY -> MaterialTheme.colorScheme.onSurfaceVariant
}

private val SessionMark.icon: Int get() = when (this) {
    SessionMark.NEEDS_YOU -> R.drawable.ic_mark_needs_you
    SessionMark.FAILED -> R.drawable.ic_mark_failed
    SessionMark.RETRYING -> R.drawable.ic_mark_retrying
    SessionMark.ON_HOLD -> R.drawable.ic_mark_on_hold
    SessionMark.INTERRUPTED -> R.drawable.ic_mark_interrupted
    SessionMark.BACKGROUND -> R.drawable.ic_mark_background
    SessionMark.WILL_RESUME -> R.drawable.ic_mark_will_resume
    SessionMark.FINISHED -> R.drawable.ic_mark_finished
    SessionMark.ENDED -> R.drawable.ic_mark_ended
}

/** The marks after the state word, in the order given. [max] (a phone row) draws the first ones and "+N" for the rest. The words are
 * the row's value already, so the chips say nothing themselves. */
@Composable
internal fun SessionMarkChips(marks: List<SessionMark>?, modifier: Modifier = Modifier, max: Int? = null) {
    if (marks.isNullOrEmpty()) return
    val shown = if (max != null) marks.take(max) else marks
    val more = if (max != null && marks.size > max) marks.size - max else 0
    Row(modifier.clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        shown.forEach { mark -> MarkChip(mark.word, mark.color(), mark.tone != SessionMark.Tone.GREY, mark.icon, Modifier.testTag("session-mark:${mark.name}")) }
        if (more > 0) MarkChip("+$more", MaterialTheme.colorScheme.onSurfaceVariant, false, null, Modifier.testTag("session-mark-more"))
    }
}

@Composable
private fun MarkChip(word: String, color: Color, filled: Boolean, icon: Int?, modifier: Modifier) {
    Row(modifier.background(if (filled) color.copy(alpha = 0.10f) else Color.Transparent, CircleShape)
        .border(BorderStroke(0.75.dp, color.copy(alpha = 0.45f)), CircleShape).padding(horizontal = 6.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        icon?.let { Icon(painterResource(it), null, Modifier.size(10.dp), tint = color) }
        Text(word, style = MaterialTheme.typography.labelSmall, color = color, maxLines = 1, softWrap = false)
    }
}
