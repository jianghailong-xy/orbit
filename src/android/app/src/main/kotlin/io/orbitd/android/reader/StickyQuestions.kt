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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import io.orbitd.android.R
import io.orbitd.android.composer.CoordinatorHandoffCopy
import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.cards.ReaderSide
import io.orbitd.android.cards.WaitingBelow
import io.orbitd.android.cards.drawable
import io.orbitd.android.core.cards.InteractionCard
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.core.translation.Translation
import io.orbitd.android.translation.TranslationShown
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

/** Which turns the sticky bar points at (OrbitKit `StickySummary`). It only ever names the reader's own words. */
internal object StickySummary {
    /** What the capsule labels the reader's words by: the arrow alone — it has no room to say whose they are, and needs none. */
    const val ARROW = "↑"

    private fun RunEvent.card(cards: List<InteractionCard>, field: String) = cards.firstOrNull { it.key == "record:$seq:$field" }?.source

    /**
     * Whether the bar may point back at this turn at all: every user turn may, but a watch's wake, a background job's news or a
     * wakeup coming due — each a line inside the answer, not the head of one (A08-14) — unless somebody also typed words on a
     * background wake. A watch's wake is the whole of its turn's words, so nobody's are there. Never the owner's answer handed
     * to the coordinator, which is such a line too (OrbitKit `StickySummary.isAnchor`). Always a fact told to this session
     * (`coordinatorDelivery`): its line is one too, but the reply under it answers it, so it heads what follows (web
     * `CoordinatorDeliveryLine`'s `data-orbit-round`) — and the bar hides over it ([isOrbits]).
     */
    fun isAnchor(event: RunEvent, cards: List<InteractionCard> = transcriptCards(event)): Boolean {
        if (listOf("sessionMessage", "openItemDelivery", "coordinatorDelivery", "taskStart", "projectStarted")
                .any { event.card(cards, it) != null }) return true
        if (event.card(cards, "watch") != null) return false
        if (event.card(cards, "ownerAnswer") != null) return false
        // A turn carrying only Orbit's blocks is a line in the answer too (OrbitEvent), whatever block.
        if (cards.isEmpty() && SteerDelivery.orbitOnly(event)) return false
        // A SubAgent's end is inside the answer too (it draws nothing; its card is the end), as a background job's news is.
        if (event.card(cards, "wake") == null && event.card(cards, "subagent") == null) {
            // A turn that is only a note this reader cannot read draws no row of the reader's, so it heads no round (OrbitKit).
            return cards.isNotEmpty() || !io.orbitd.android.core.cards.BackgroundWakeCard.drawsNoteAlone(event.personWords(),
                (event.fields["attachments"] as? kotlinx.serialization.json.JsonArray).orEmpty().isNotEmpty(),
                event.fields.string("controlPlaneNote"), queued = false)
        }
        return event.personWords().isNotBlank()
    }

    /** The turns that are lines inside an answer rather than Orbit opening a round of its own (`isAnchor`). */
    private val linesInAnAnswer = setOf("watch", "wake", "subagent", "ownerAnswer")

    /**
     * Whether Orbit, not a person, opened this turn: one of the control plane's cards stands in for the bubble (OrbitKit
     * `StickySummary.isOrbits`). It still heads the round under it, so the question above no longer names what is on screen — but
     * the bar never names a machine's message either (the owner, 2026-11-14), so over it the bar is hidden ([StickyQuestions]).
     */
    fun isOrbits(cards: List<InteractionCard>): Boolean =
        cards.any { it.key.split(":").getOrNull(2) !in linesInAnAnswer }

    /** The owner's own words, as the bubble under the bar shows them: what they typed, not the English the engine got. */
    fun words(event: RunEvent): String =
        TranslationShown.userWords(event.personWords(), Translation.turn(event.fields["translation"]), flipped = false)
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
            if (row.event.type == "user") {
                // A round Orbit opened ends the question's reach without taking the bar (`isOrbits`).
                val cards = transcriptCards(row.event)
                if (StickySummary.isAnchor(row.event, cards)) last = row.takeUnless { StickySummary.isOrbits(cards) }
            }
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
 * between back and the page's buttons, one line — the arrow ([StickySummary.ARROW]), served first, and the question's first
 * line, which gives way. At most 260 dp wide, as on iOS, so a wide bar keeps a
 * capsule rather than a second content row. Up there it moves nothing in the transcript, so the band's in-flow shift is gone
 * with it. A tap goes back to the turn.
 */
@Composable
internal fun QuestionCapsule(row: TranscriptRow, jump: (TranscriptRow) -> Unit) {
    val text = remember(row) { StickySummary.words(row.event) }
    Row(Modifier.widthIn(max = 260.dp).heightIn(min = 40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)
        .clickable(role = Role.Button) { jump(row) }.semantics { contentDescription = "Jump to your last question" }
        .padding(horizontal = 12.dp, vertical = 4.dp).testTag("question-capsule"),
        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(StickySummary.ARROW, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text.lineSequence().firstOrNull { it.isNotBlank() }.orEmpty(), Modifier.weight(1f, fill = false),
            style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** "Handing over" in the header's capsule while the handoff locks the composer (board 04; iOS `handingOverCapsule`): the web and Mac
 * headers' word, in the question capsule's shape. Nothing to press: the transcript's row carries the handoff's actions and its clock. */
@Composable
internal fun HandingOverCapsule() {
    Box(Modifier.heightIn(min = 40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)
        .padding(horizontal = 14.dp, vertical = 4.dp).testTag("handing-over-capsule"), contentAlignment = Alignment.Center) {
        Text(CoordinatorHandoffCopy.BADGE_HANDING_OVER, color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * What waits on the reader in this conversation, in the header's capsule where the question goes (iOS `waitingCapsule`; the owner,
 * 2026-11-15, `docs/mocks/needs-you-capsule/07-console-one-capsule`): the needs-you mark, the bar's own words ("1 waiting below",
 * "1 open question above") and the way the card lies, drawn as the "Changes committed" pill is: a bare glyph, no ring. A press shows the card.
 */
@Composable
internal fun WaitingCapsule(here: WaitingBelow, show: () -> Unit) {
    val amber = LocalOrbitColors.current.needsYou
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.widthIn(max = 260.dp).heightIn(min = 40.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)
        .clickable(onClickLabel = NeedsYouLogic.belowHint, role = Role.Button, onClick = show)
        .padding(start = 10.dp, end = 16.dp, top = 4.dp, bottom = 4.dp).testTag("waiting-capsule"),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(here.glyph.drawable), null, Modifier.size(20.dp), tint = amber)
        Text(here.text, Modifier.weight(1f, fill = false).testTag("waiting-capsule-text"), style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(painterResource(R.drawable.ic_chevron_down), null,
            Modifier.size(12.dp).rotate(if (here.side == ReaderSide.ABOVE) 180f else 0f).testTag("waiting-capsule-chevron:${here.side ?: "NONE"}"), tint = muted)
    }
}

