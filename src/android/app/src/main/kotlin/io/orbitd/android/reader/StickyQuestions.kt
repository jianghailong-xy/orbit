package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.InteractionCard
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * The part of the sticky "↑ Your question" header's decision that has to hold still while the header
 * itself moves the transcript (OrbitKit `StickyQuestionHold`, iOS 61cc028ec). The header is in flow:
 * showing it moves the list by its own height, so a reading taken with it shown and one taken with it
 * hidden can disagree, and a single threshold between them flips it on every frame. Each way out of a
 * state gets its own threshold, far enough apart that the header's own move cannot carry a reading
 * across both.
 */
internal object StickyQuestionHold {
    /** With no row claiming the top line, how far (dp) a hidden header's list must have scrolled before it shows… */
    const val FALLBACK_SHOW_AFTER = 400.0
    /** …and the offset at or under which a shown one hides: the list is back at its top. */
    const val FALLBACK_HIDE_AT = 40.0

    fun fallbackNames(contentOffset: Double, showing: Boolean): Boolean =
        contentOffset > if (showing) FALLBACK_HIDE_AT else FALLBACK_SHOW_AFTER

    /** The answer the row under the top line gave — except that a named question straddling the line itself stays named. */
    fun named(found: String?, anchor: String, showing: String?): String? =
        if (found == null && showing != null && anchor == showing) showing else found
}

/** The two words the sticky bar draws for one turn: what kind of turn it was, and what it said (OrbitKit `StickySummary`). */
internal object StickySummary {
    const val ARROW = "↑ "
    const val YOUR_QUESTION = "${ARROW}Your question"

    private fun RunEvent.card(cards: List<InteractionCard>, field: String) = cards.firstOrNull { it.key == "record:$seq:$field" }?.source

    /**
     * Whether the bar may point back at this turn at all: every user turn may, but a background job's news
     * or a wakeup coming due — a line inside the answer, not the head of one — unless somebody also typed words on it.
     */
    fun isAnchor(event: RunEvent, cards: List<InteractionCard> = transcriptCards(event)): Boolean {
        if (listOf("sessionMessage", "openItemDelivery", "taskStart", "projectStarted", "watch").any { event.card(cards, it) != null }) return true
        if (event.card(cards, "wake") == null) return true
        return event.personWords().isNotBlank()
    }

    /** The label and line for one turn, in the transcript's order: another session, an item, a task's run, a project's start, a watch, the person. */
    fun of(event: RunEvent, cards: List<InteractionCard> = transcriptCards(event)): Pair<String, String> {
        event.card(cards, "sessionMessage")?.let { from ->
            return "${ARROW}From ${from.text("fromTitle")?.trim()?.ifEmpty { null } ?: "Untitled session"}" to event.personWords()
        }
        event.card(cards, "openItemDelivery")?.let { item ->
            val label = itemKindLabel(item.text("kind"))
            val title = item.text("title").orEmpty()
            return "${ARROW}Exception item" to if (title.lowercase().startsWith(label.lowercase())) title else "$label: $title"
        }
        event.card(cards, "taskStart")?.let { return "${ARROW}Task started" to it.text("title").orEmpty() }
        event.card(cards, "projectStarted")?.let { started ->
            return ARROW + (if (started.text("by") == "CONFIRMATION") "Project started" else "Project switched on") to started.text("projectTitle").orEmpty()
        }
        event.card(cards, "watch")?.let { wake -> return ARROW + watchTitle(wake.text("state")) to watchWhy(wake.text("state"), wake.text("reason")) }
        return YOUR_QUESTION to event.personWords()
    }

    private fun itemKindLabel(kind: String?) = when (kind) {
        "INTEGRATION_CONFLICT" -> "Merge conflict"; "INTEGRATION_CHECK_FAILED" -> "Checks failed"
        "INTEGRATION_ERROR" -> "Integration error"; "TASK_FAILED" -> "Task failed"
        "PROMOTION_APPROVAL" -> "Merge approval"; "COORDINATOR_QUESTION" -> "Question"
        "FUSE_PAUSED" -> "Project paused"; else -> "Exception item"
    }

    private fun watchTitle(state: String?) = when (state) {
        "MATCHED" -> "Watch triggered"; "EXPIRED" -> "Watch expired"
        "REVOKED" -> "Watch stopped: access lost"; else -> "Watch stopped: every target is gone"
    }

    /** Why the watch queued this turn (OrbitKit `WatchWakeCard.why`). */
    private fun watchWhy(state: String?, reason: String?) = when (state) {
        "MATCHED" -> if (reason.isNullOrEmpty()) "Its condition held." else describeReason(reason)
        "EXPIRED" -> "Its deadline passed before its condition held. It will not wake this session again."
        "REVOKED" -> "This account can no longer read one of its targets, so it reports nothing about them."
        else -> "Every target it watched was deleted, so its condition can never be decided."
    }

    /** A Match's `ALL TASK_DONE 2/2` in words: "2 of 2 done". */
    internal fun describeReason(reason: String): String {
        val parts = mutableListOf<String>()
        for (match in Regex("\\b(?:ALL|ANY) ([A-Z_]+) (\\d+)/(\\d+)").findAll(reason)) {
            val word = when (match.groupValues[1]) {
                "SESSION_TURN_SETTLED" -> "finished their turn"; "SESSION_RUN_TERMINAL" -> "ended"
                "SESSION_LIFECYCLE_TERMINAL" -> "filed away"; "SESSION_NEEDS_ATTENTION" -> "asked for approval"
                "TASK_TERMINAL" -> "finished"; "TASK_DONE" -> "done"; "TASK_FAILED" -> "failed"
                else -> return reason
            }
            parts += "${match.groupValues[2]} of ${match.groupValues[3]} $word"
        }
        return if (parts.isEmpty()) reason else parts.joinToString(" · ")
    }
}

/**
 * Which turn the sticky bar names for each place the reader can be, read off the rows once per
 * projection (OrbitKit `StickyQuestions`), so a scroll is a lookup rather than a walk. The rows above the
 * transcript's first one (the earlier-messages and loading items) have nothing above them; anything
 * after its last (live drafts, cards, the tail) has every question above it.
 */
internal class StickyQuestions(rows: List<TranscriptRow>) {
    private val position = HashMap<String, Int>()
    private val above: List<TranscriptRow?>
    private val byKey = rows.associateBy { it.key }

    init {
        val list = ArrayList<TranscriptRow?>(rows.size + 1)
        var last: TranscriptRow? = null
        listOf(TOP_LINE, "loading", "older", "empty").forEach { position[it] = 0 }
        rows.forEachIndexed { index, row ->
            position.putIfAbsent(row.key, index)
            list += last
            if (row.event.type == "user" && StickySummary.isAnchor(row.event)) last = row
        }
        list += last
        above = list
    }

    fun above(anchor: String): TranscriptRow? = above[position[anchor] ?: above.lastIndex]
    val last: TranscriptRow? get() = above.last()
    fun row(key: String?): TranscriptRow? = key?.let(byKey::get)

    /**
     * The question the bar names now (OrbitKit `recomputeStuck`): the last one above the row that claimed
     * the top line, held by `StickyQuestionHold` — or, before any row has claimed it, the last question
     * once the list has scrolled far enough. Both answers go through the hold, never a bare threshold.
     */
    fun name(anchor: String?, contentOffset: Double, stuck: String?): String? = when {
        anchor != null -> StickyQuestionHold.named(above(anchor)?.key, anchor, stuck)
        StickyQuestionHold.fallbackNames(contentOffset, stuck != null) -> last?.key
        else -> null
    }
}

/** What `topLineItem` answers when every item starts below the top line: the transcript's very top. */
internal const val TOP_LINE = "top"

/**
 * The item under the transcript's top edge — the only scroll input the header reads. Items tile the list
 * the way iOS's rows do: the spacing after an item is still that item's, so the line always falls on one.
 * `top` is the viewport's start offset, which content padding makes negative. Null before any layout.
 */
internal fun topLineItem(items: List<LazyListItemInfo>, top: Int): String? =
    if (items.isEmpty()) null else items.lastOrNull { it.offset <= top }?.key?.toString() ?: TOP_LINE

/** Scroll state the header derives from, mutated per frame without recomposing; only the named question redraws. */
private class QuestionRuler { var anchor: String? = null }

/** Whether the header was last shown, whether it has shown yet, and its last measured height: what the list is scrolled by when it comes or goes. */
private class HeaderShift { var shown = false; var seen = false; var height = 0f }

/**
 * The sticky "↑ Your question" header (iOS `ConsoleView.stickyQuestion`, web's `.chat-sticky-question`):
 * the newest question above the fold, in flow above the transcript, stepping back through earlier
 * questions as the reader scrolls up and hidden only where none is above. A tap goes back to it.
 */
@Composable
internal fun StickyQuestion(rows: List<TranscriptRow>, list: LazyListState, hidden: Boolean, jump: (TranscriptRow) -> Unit) {
    val questions = remember(rows) { StickyQuestions(rows) }
    val ruler = remember(list) { QuestionRuler() }
    var stuck by remember(list) { mutableStateOf<String?>(null) }
    val density = LocalDensity.current.density
    LaunchedEffect(list, questions, density) {
        snapshotFlow {
            val layout = list.layoutInfo
            topLineItem(layout.visibleItemsInfo, layout.viewportStartOffset)?.let { ruler.anchor = it }
            // Only the first item's own scroll counts as distance before any row has claimed the line.
            val offset = if (list.firstVisibleItemIndex > 0) Double.MAX_VALUE else list.firstVisibleItemScrollOffset / density.toDouble()
            questions.name(ruler.anchor, offset, stuck)
        }.distinctUntilChanged().collect { stuck = it }
    }
    val row = questions.row(stuck)
    // In the list's flow, as on iOS, so a jump lands below the header rather than under it. Its coming and going
    // moves the list's top by its height, though, so the list is scrolled by as much before the frame is laid out:
    // the line being read stays where it was (A06's prepend guarantee) instead of jumping by a header. An effect
    // rather than a SideEffect: a scroll while the frame's compositions are still being applied measures list
    // items that are not applied yet, and the composition breaks.
    val shift = remember(list) { HeaderShift() }
    val shown = !hidden && row != null
    LaunchedEffect(shift, shown) {
        if (shown == shift.shown) return@LaunchedEffect
        shift.shown = shown
        // Its first showing is the reader settling where it opened: a place it restores was saved with the header up.
        if (shown && !shift.seen) { shift.seen = true; return@LaunchedEffect }
        if (shift.height > 0f) list.dispatchRawDelta(if (shown) shift.height else -shift.height)
    }
    if (hidden || row == null) return
    val (label, text) = remember(row) { StickySummary.of(row.event) }
    Column(Modifier.fillMaxWidth().onSizeChanged { shift.height = it.height.toFloat() }.testTag("sticky-question")) {
        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer)
            .clickable(role = Role.Button) { jump(row) }.semantics { contentDescription = "Jump to your last question" }
            .padding(horizontal = 16.dp, vertical = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelLarge,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty(), Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        HorizontalDivider()
    }
}
