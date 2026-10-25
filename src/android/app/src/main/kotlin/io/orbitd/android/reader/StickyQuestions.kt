package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
 * across both. On Android the question now sits in the bar (iOS d87e5fa67) and moves nothing; the hold
 * stays, as OrbitKit keeps it, and still keeps a question straddling the top line named.
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

    /**
     * The label as the bar's capsule draws it (OrbitKit `StickySummary.compactLabel`, iOS d87e5fa67): the arrow alone over the
     * reader's own words — the capsule has no room to say whose they are, and needs none — and a card's label as it stands over
     * anything else, so the capsule can't pass a card off as something the reader typed.
     */
    fun compactLabel(label: String): String = if (label == YOUR_QUESTION) ARROW.trim() else label

    private fun RunEvent.card(cards: List<InteractionCard>, field: String) = cards.firstOrNull { it.key == "record:$seq:$field" }?.source

    /**
     * Whether the bar may point back at this turn at all: every user turn may, but a watch's wake, a background job's news or a
     * wakeup coming due — each a line inside the answer, not the head of one (A08-14) — unless somebody also typed words on a
     * background wake. A watch's wake is the whole of its turn's words, so nobody's are there. Never the owner's answer handed
     * to the coordinator, which is such a line too (OrbitKit `StickySummary.isAnchor`).
     */
    fun isAnchor(event: RunEvent, cards: List<InteractionCard> = transcriptCards(event)): Boolean {
        if (listOf("sessionMessage", "openItemDelivery", "taskStart", "projectStarted").any { event.card(cards, it) != null }) return true
        if (event.card(cards, "watch") != null) return false
        if (event.card(cards, "ownerAnswer") != null) return false
        if (event.card(cards, "wake") == null) return true
        return event.personWords().isNotBlank()
    }

    /** The label and line for one turn, in the transcript's order: another session, an item, a task's run, a project's start, the person. */
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
        return YOUR_QUESTION to event.personWords()
    }

    private fun itemKindLabel(kind: String?) = when (kind) {
        "INTEGRATION_CONFLICT" -> "Merge conflict"; "INTEGRATION_CHECK_FAILED" -> "Checks failed"
        "INTEGRATION_ERROR" -> "Integration error"; "TASK_FAILED" -> "Task failed"
        "PROMOTION_APPROVAL" -> "Merge approval"; "COORDINATOR_QUESTION" -> "Question"
        "FUSE_PAUSED" -> "Project paused"; else -> "Exception item"
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

/** Scroll state the question derives from, mutated per frame without recomposing; only what reads the named question redraws. */
private class QuestionRuler { var anchor: String? = null }

/**
 * The turn the sticky question names for where the reader is (iOS `TranscriptView.stuckBubble`, web's `.chat-sticky-question`):
 * the newest question above the fold, stepping back through earlier questions as the reader scrolls up, and none where no
 * question is above. Read off the list's scroll as it moves; the page reading it does not recompose with it — only what reads
 * the returned state does, the bar's capsule ([QuestionCapsule]). One state for the list's life, whatever the rows become:
 * the bar keeps the content it was first handed, so what changes has to be read through it.
 */
@Composable
internal fun rememberStuckQuestion(rows: List<TranscriptRow>, list: LazyListState): State<TranscriptRow?> {
    val questions = remember(rows) { StickyQuestions(rows) }
    val ruler = remember(list) { QuestionRuler() }
    val stuck = remember(list) { mutableStateOf<TranscriptRow?>(null) }
    val density = LocalDensity.current.density
    LaunchedEffect(list, questions, density) {
        snapshotFlow {
            val layout = list.layoutInfo
            topLineItem(layout.visibleItemsInfo, layout.viewportStartOffset)?.let { ruler.anchor = it }
            // Only the first item's own scroll counts as distance before any row has claimed the line.
            val offset = if (list.firstVisibleItemIndex > 0) Double.MAX_VALUE else list.firstVisibleItemScrollOffset / density.toDouble()
            questions.name(ruler.anchor, offset, stuck.value?.key)
        }.distinctUntilChanged().collect { stuck.value = questions.row(it) }
    }
    return stuck
}

/**
 * The sticky question in the bar's middle (iOS `TranscriptView.questionCapsule`, d87e5fa67): the turn's words in a capsule
 * between back and the page's buttons, one line — its label, served first (the arrow alone over the reader's own words,
 * [StickySummary.compactLabel]), and its first line, which gives way. At most 260 dp wide, as on iOS, so a wide bar keeps a
 * capsule rather than a second content row. Up there it moves nothing in the transcript, so the band's in-flow shift is gone
 * with it. A tap goes back to the turn.
 */
@Composable
internal fun QuestionCapsule(row: TranscriptRow, jump: (TranscriptRow) -> Unit) {
    val (label, text) = remember(row) { StickySummary.of(row.event) }
    Row(Modifier.widthIn(max = 260.dp).heightIn(min = 40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)
        .clickable(role = Role.Button) { jump(row) }.semantics { contentDescription = "Jump to your last question" }
        .padding(horizontal = 12.dp, vertical = 4.dp).testTag("question-capsule"),
        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(StickySummary.compactLabel(label), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty(), Modifier.weight(1f, fill = false),
            style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
