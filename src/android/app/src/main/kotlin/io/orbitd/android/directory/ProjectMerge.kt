package io.orbitd.android.directory

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.orbitd.android.core.cards.*
import io.orbitd.android.projects.LandingLine
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.ProjectDoc
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.failureReason
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonObject

// A11-9 (iOS 6b4bef713, 39adc7561): the merge into main lives on the project's sessions page — its card under the progress card, the
// merges already made on the page's timeline — and the coordinator conversation keeps one line per moment.

/** What the project's sessions page draws under its progress card about main (OrbitKit `ProjectMergeCard`): the candidate's own card
 * while it asks, merges or is blocked, and the merge check's live line before any of that. Nothing at all when none applies. */
object ProjectMergeCard {
    enum class Shape {
        /** The merge check is running on the combined tree; nobody is being asked anything yet. */
        CHECKING, ASKING, MERGING, BLOCKED
    }

    /** The two job kinds that are about main. Their live line belongs to the merge card; a task landing on the project branch keeps
     * the progress card's line. */
    val mergeJobKinds = setOf("CHECK_PROMOTION", "LAND_PROMOTION")

    fun isMergeJob(inFlight: JsonObject?) = inFlight?.text("kind") in mergeJobKinds

    fun shape(promotion: JsonObject?, integration: JsonObject?): Shape? = when (PromotionCards.stage(promotion)) {
        PromotionStage.ASKING_YOU -> Shape.ASKING
        PromotionStage.MERGING -> Shape.MERGING
        PromotionStage.BLOCKED -> Shape.BLOCKED
        PromotionStage.MERGED, null -> if (isMergeJob(integration?.obj("inFlight"))) Shape.CHECKING else null
    }

    /** The progress card's landing line, minus a merge job: that one is drawn in the merge card. */
    fun progressLandingLine(view: JsonObject, now: Instant, updatedAt: Instant?, refreshFailed: Boolean): LandingLine? =
        if (isMergeJob(view.obj("inFlight"))) null else ProjectPage.landingLine(view, now, updatedAt, refreshFailed)

    /** The merge job's live line, for the merge card — null when the job in flight is not one. */
    fun mergeLandingLine(view: JsonObject, now: Instant, updatedAt: Instant?, refreshFailed: Boolean): LandingLine? =
        if (isMergeJob(view.obj("inFlight"))) ProjectPage.landingLine(view, now, updatedAt, refreshFailed) else null
}

/** One recency section of a project's sessions page: its member sessions, with the merges into main made in the same bucket drawn
 * among them at their own instant (OrbitKit `ProjectTimelineSection`). A merge is a row of its own kind — never a session. */
data class ProjectTimelineSection(val id: String, val title: String, val items: List<Item>) {
    sealed interface Item {
        val key: String
        data class Session(val session: DirectorySession) : Item { override val key get() = session.id }
        data class Merge(val receipt: PromotionReceipt) : Item { override val key get() = receipt.id }
    }
}

object ProjectTimeline {
    /** The sessions keep the order they are given in (newest activity first) and each merge goes in front of the first session older
     * than it, so within a bucket the newest thing leads whichever kind it is. The buckets and their titles are the list's own,
     * without Pinned: the project's page has none. */
    fun sections(sessions: List<DirectorySession>, merges: List<PromotionReceipt>, now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault()): List<ProjectTimelineSection> {
        val today = now.atZone(zone).toLocalDate()
        val buckets = List(recencyTitles.size) { mutableListOf<ProjectTimelineSection.Item>() }
        fun bucket(at: String?) = recencyBucket(at?.let { runCatching { Instant.parse(it) }.getOrNull() }, today, zone)
        val pending = ArrayDeque(merges.sortedByDescending { instant(it.moment) })
        for (session in sessions) {
            val at = session.lastTurnAt ?: session.createdAt
            while (pending.isNotEmpty() && instant(pending.first().moment) >= instant(at)) {
                val merge = pending.removeFirst()
                buckets[bucket(merge.moment)] += ProjectTimelineSection.Item.Merge(merge)
            }
            buckets[bucket(at)] += ProjectTimelineSection.Item.Session(session)
        }
        pending.forEach { buckets[bucket(it.moment)] += ProjectTimelineSection.Item.Merge(it) }
        return buckets.mapIndexedNotNull { i, items -> if (items.isEmpty()) null else ProjectTimelineSection("time:$i", recencyTitles[i], items) }
    }

    /** An instant this clock cannot read sorts after every one it can, as the list files it under Older. */
    private fun instant(iso: String?): Long = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: Long.MIN_VALUE
}

/** Which of the merge's side reads one poll makes (iOS `ProjectMergeModel.load`): the candidate every time, since it is what the card
 * is; then the merges when the candidate moved and otherwise once a minute; the open items every 20 seconds while one is blocked,
 * because its holder is on the card; the criteria once a minute while one is asking. */
object ProjectMergePolls {
    data class Due(val merged: Boolean, val items: Boolean, val criteria: Boolean)

    fun due(force: Boolean, moved: Boolean, stage: PromotionStage?, now: Instant, mergedReadAt: Instant?, itemsReadAt: Instant?,
        criteriaReadAt: Instant?): Due {
        fun older(at: Instant?, seconds: Long) = at == null || now.toEpochMilli() - at.toEpochMilli() > seconds * 1_000
        return Due(merged = force || moved || older(mergedReadAt, 60),
            items = force || (stage == PromotionStage.BLOCKED && (moved || older(itemsReadAt, 20))),
            criteria = stage == PromotionStage.ASKING_YOU && (force || older(criteriaReadAt, 60)))
    }
}

/**
 * The merge into main as the project's sessions page shows it (iOS `ProjectMergeModel`): the candidate on offer, for the card under
 * the progress card; the merges already made, for the timeline; and the three presses. The page polls it beside its sessions every
 * 4 s, and the review the card's Details opens reads it. A read that fails leaves what it last read: the card says what it last read,
 * not that the merge vanished.
 */
@Stable
class ProjectMergeModel(private val api: ProjectApi, val projectId: String, private val clock: () -> Instant = Instant::now) {
    /** The candidate on offer, or null while the project is asking nothing. */
    var current by mutableStateOf<JsonObject?>(null); private set
    /** The merges already made, newest first — the timeline's rows. */
    var merged by mutableStateOf<List<JsonObject>>(emptyList()); private set
    /** The project's open items, or null until read: a blocked candidate's holder is one of them. */
    var openItems by mutableStateOf<JsonObject?>(null); private set
    private var criteria by mutableStateOf<List<JsonObject>>(emptyList())
    private var mergedReadAt: Instant? = null
    private var itemsReadAt: Instant? = null
    private var criteriaReadAt: Instant? = null
    /** Bumped by every read and press, so an older poll that lands after a press cannot put back the state the press moved the
     * candidate out of. */
    private var generation = 0

    val receipts: List<PromotionReceipt> get() = PromotionCards.receipts(merged)
    /** Null until the criteria have been read — "0 of 0 met" would be a claim nobody checked. */
    val criteriaMet: Pair<Int, Int>? get() = criteria.takeIf { it.isNotEmpty() }?.let { items -> items.count { ProjectDoc.satisfied(it) == true } to items.size }
    /** The candidate a review was opened on, while it is still the one on offer. */
    fun standing(promotionId: String): JsonObject? = current?.takeIf { it.text("promotionId") == promotionId }

    suspend fun load(force: Boolean = false) {
        val mine = ++generation
        val before = current
        try {
            val read = api.currentPromotion(projectId)
            if (mine != generation) return
            current = read
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { if (mine != generation) return }
        val moved = before?.text("promotionId") != current?.text("promotionId") || before?.text("state") != current?.text("state")
        val due = ProjectMergePolls.due(force, moved, PromotionCards.stage(current), clock(), mergedReadAt, itemsReadAt, criteriaReadAt)
        suspend fun <T> attempt(read: suspend () -> T): T? = try { read() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        coroutineScope {
            val mergedRead = if (due.merged) async { attempt { api.mergedPromotions(projectId) } } else null
            val itemsRead = if (due.items) async { attempt { api.openItems(projectId) } } else null
            val criteriaRead = if (due.criteria) async { attempt { api.document(projectId) } } else null
            mergedRead?.await()?.let { if (mine == generation) { merged = it; mergedReadAt = clock() } }
            itemsRead?.await()?.let { if (mine == generation) { openItems = it; itemsReadAt = clock() } }
            criteriaRead?.await()?.let { if (mine == generation) { criteria = it.objects("acceptanceCriteriaItems"); criteriaReadAt = clock() } }
        }
    }

    /** M-T4: merge it, with the candidate's own source SHA. */
    suspend fun confirm(view: JsonObject): String? = press("That merge was not confirmed") {
        api.confirmPromotion(projectId, view.text("promotionId").orEmpty(), checkNotNull(view.text("sourceSha")) { "The card is incomplete. Refresh it" })
    }
    /** M-T5: not now. */
    suspend fun decline(view: JsonObject): String? = press("That was not recorded") { api.declinePromotion(projectId, view.text("promotionId").orEmpty()) }
    /** M-T10: call it back, while its job has not reached the push. */
    suspend fun cancel(view: JsonObject): String? = press("That merge was not called back") { api.cancelPromotion(projectId, view.text("promotionId").orEmpty()) }

    /** The door's answer is the candidate's new state, drawn at once; then everything the card is drawn from is read again. The failure
     * is returned for the card or the review to show where the press was made. */
    private suspend fun press(failure: String, door: suspend () -> JsonObject?): String? {
        generation++
        var refused: String? = null
        try { door()?.let { current = it } }
        catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { refused = "$failure — ${failureReason(error).trimEnd('.')}." }
        load(force = true)
        return refused
    }
}
