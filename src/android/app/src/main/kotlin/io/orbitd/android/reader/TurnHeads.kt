package io.orbitd.android.reader

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.projects.ProjectTime
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonPrimitive

/** A turn's head: the stamps of the message that opened it ([start]) and of its `turn_end` ([end], null while the window holds none). */
@Immutable
internal data class TurnHead(val start: String?, val end: String?, val closed: Boolean)

/**
 * The head row of every turn (web `TurnHead`, d2e295917): how long the turn worked, under the message that opened it and over everything
 * the turn writes — "Worked for 1m 12s", or "Working for 12s" counting up while it runs. The span is the two stored stamps, so history
 * reads what the turn read on screen. Only the window's newest head may count up: an older one whose `turn_end` the window does not reach
 * (across a page boundary) says nothing rather than a wrong running clock.
 */
internal object TurnHeads {
    /** Each turn's head by the `seq` of the message that opened it: a top-level message that is not a steer. Its end is the first
     *  `turn_end` before the next such message — read off the whole window each time, so a prepended page joins a head to its end. */
    fun of(events: List<RunEvent>): Map<Long, TurnHead> {
        val heads = LinkedHashMap<Long, TurnHead>()
        var open: Long? = null
        events.forEach { event ->
            when (event.type) {
                "user" -> if (event.parent().isNullOrEmpty() && event.fields["steer"] != JsonPrimitive(true)) {
                    heads[event.seq] = TurnHead(event.ts, null, closed = false); open = event.seq
                }
                // A failed turn still ends here: it was working until now.
                "turn_end" -> open?.let { seq -> heads[seq] = heads.getValue(seq).copy(end = event.ts, closed = true); open = null }
            }
        }
        return heads
    }

    /** What the row says, or null for nothing. [ticking]: the session is live and this is the window's newest head. */
    fun label(head: TurnHead, ticking: Boolean, nowMs: Long): String? {
        val start = ProjectTime.parse(head.start)?.toEpochMilli()
        if (head.closed) {
            val end = ProjectTime.parse(head.end)?.toEpochMilli()
            return if (start != null && end != null && end >= start) "Worked for ${span(end - start)}" else null
        }
        if (!ticking) return null
        return if (start != null) "Working for ${span(nowMs - start)}" else "Working…"
    }

    /** Web `checkDuration`, never under a second: "Worked for 0s" reads as a bug, not as a measurement. `45s`, `1m 12s`, `2m`, `1h 5m`. */
    fun span(ms: Long): String {
        val seconds = Math.round(maxOf(1_000L, ms) / 1000.0)
        val h = seconds / 3600
        val m = (seconds % 3600) / 60
        val s = seconds % 60
        if (h > 0) return if (m > 0) "${h}h ${m}m" else "${h}h"
        if (m > 0) return if (s > 0) "${m}m ${s}s" else "${m}m"
        return "${s}s"
    }
}

/** The head row itself: 12 sp, in the secondary text colour, counting up once a second while it [ticking]. */
@Composable
internal fun TurnHeadLine(head: TurnHead, ticking: Boolean) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    if (ticking && !head.closed) LaunchedEffect(head) { while (true) { now = System.currentTimeMillis(); delay(1_000) } }
    val text = TurnHeads.label(head, ticking, now) ?: return
    Text(text, Modifier.padding(horizontal = 10.dp).testTag("turn-head"),
        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp, fontFeatureSettings = "tnum"),
        color = MaterialTheme.colorScheme.onSurfaceVariant)
}
