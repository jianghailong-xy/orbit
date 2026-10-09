package io.orbitd.android.cards

import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.SessionSnapshot
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectDoc
import io.orbitd.android.projects.ProjectDone
import kotlinx.serialization.json.JsonObject
import java.time.Instant

/** One of the four owner items a session row carries (OrbitKit `SessionOwnerItem`, §7.6 V13). */
data class OwnerItem(val itemId: String, val kind: String, val title: String, val since: String)

/** What the cross-session bar says, and where its press goes (OrbitKit `NeedsYouBanner`): the session that has
 * waited longest, or — when one of the four owner items is waiting — the card that item is. */
data class NeedsYouBanner(val count: Int, val target: JsonObject, val text: String, val ownerItem: OwnerItem? = null)

/** Which way the reader has to look for what the bar counts (OrbitKit `ReaderSide`). */
enum class ReaderSide { ABOVE, BELOW }

/** One card waiting in the conversation on screen, and whether the reader answers it by replying (a question) or by
 * pressing a door (an exception that became theirs, a pause only they can lift). */
data class BelowRow(val rowId: String, val isQuestion: Boolean)

/** What is waiting in THIS conversation: how many, the row a press goes to, and the bar's line (OrbitKit `WaitingBelow`). */
data class WaitingBelow(val count: Int, val rowId: String, val text: String, val side: ReaderSide? = null)

/** The needs-you bar's rules (OrbitKit `NeedsYouLogic`, `SessionGrouping`), read off the Open snapshot the directory
 * already holds and the cards this conversation draws — so the bar costs no request. */
object NeedsYouLogic {
    const val belowHint = "Shows what is waiting in this conversation"
    const val sessionHint = "Opens the session waiting on you"
    const val itemHint = "Opens the card waiting on you"

    /** The bar for what is waiting in this conversation, or null when nothing is. The press goes to the first row. */
    fun below(rows: List<BelowRow>, side: ReaderSide?): WaitingBelow? {
        val first = rows.firstOrNull() ?: return null
        return WaitingBelow(rows.size, first.rowId, belowText(rows.size, rows.all { it.isQuestion }, side), side)
    }

    /** "1 open question below" while every card counted is a question; "2 waiting below" otherwise. The direction word
     * is dropped rather than guessed when nothing has reported where the reader is. */
    fun belowText(count: Int, allQuestions: Boolean, side: ReaderSide?): String {
        val way = when (side) { ReaderSide.ABOVE -> " above"; ReaderSide.BELOW -> " below"; null -> "" }
        if (!allQuestions) return "$count waiting$way"
        return "$count open question${if (count == 1) "" else "s"}$way"
    }

    /** The cards this conversation's rail draws that are still waiting on the reader (iOS `ConsoleModel.openBelowRows`), in
     * the rail's order. Approvals are not among them: an approval stops the turn, so it is the conversation's tail. A
     * receipt is a record, not a question; a card under review is not asking the owner yet; a merge counts only while it
     * asks (`READY`); an item counts only when it is the owner's. [doneAsking] is the project-done card's address while
     * "Is this project done?" asks — drawn after the rail's cards. */
    fun belowRows(cards: List<InteractionCard>, doneAsking: String? = null): List<BelowRow> = buildList {
        cards.forEach { card ->
            if (card.key.startsWith("receipt:")) return@forEach
            val owned = card.source.text("assignee") == "OWNER"
            when (card.family) {
                CardFamily.CRITERIA_CHANGE, CardFamily.ACCEPTANCE, CardFamily.EVIDENCE ->
                    if (card.actions.isNotEmpty()) add(BelowRow(card.key, true))
                CardFamily.START -> add(BelowRow(card.key, true))
                CardFamily.OWNER_CONFIRMATION -> if (CardVerb.CONFIRM_OWNER in card.actions &&
                    card.source.obj("waiting")?.obj("review")?.text("state") != "UNDER_REVIEW") add(BelowRow(card.key, true))
                CardFamily.OWNER_QUESTION -> if (owned) add(BelowRow(card.key, true))
                CardFamily.EXCEPTION -> if (owned) add(BelowRow(card.key, false))
                CardFamily.PROMOTION -> if (card.source.text("state") == "READY" && card.actions.isNotEmpty()) add(BelowRow(card.key, true))
                else -> Unit
            }
        }
        doneAsking?.let { add(BelowRow(it, true)) }
    }

    /** The rows a conversation's needs-you bar counts, read off its session snapshot: the rail's cards, then the coordinator's
     * "Is this project done?" while it asks (iOS `doneCardAsking`: a request or `RECORD_AS_DONE`, not yet recorded). */
    fun belowRows(sessionId: String, snapshot: SessionSnapshot): List<BelowRow> {
        val project = snapshot.detail.text("projectId")
        val doc = snapshot.standing["project"] as? JsonObject
        val asking = if (project == null || doc == null) null else {
            val live = ProjectDone.live(snapshot.standing["openItems"] as? JsonObject, ProjectDoc.status(doc))
            val slot = ProjectDone.slot(doc, live, snapshot.detail.text("waitingKind"), null)
            if (slot is ProjectDone.Slot.Done && !ProjectDone.recorded(doc, null)) doneKey(project) else null
        }
        return belowRows(CardCatalog.session(sessionId, snapshot), asking)
    }

    /** The address the coordinator's done card is drawn under (`CardFocus`). */
    fun doneKey(projectId: String) = "done:$projectId"

    /** Whether one Open row needs you (OrbitKit `SessionGrouping.bucket`): approvals pending — unless all it counts is a
     * project waiting to be started — or one of the four owner items on it. */
    fun needsYou(row: JsonObject): Boolean =
        ((row.number("pendingApprovals") ?: 0) > 0 && row.text("waitingKind") != "START_REQUEST") || ownerItems(row).isNotEmpty()

    fun ownerItems(row: JsonObject): List<OwnerItem> = ownerItems(row.objects("ownerItems"))

    fun ownerItems(items: List<JsonObject>): List<OwnerItem> = items.mapNotNull { item ->
        OwnerItem(item.text("itemId") ?: return@mapNotNull null, item.text("kind") ?: "UNKNOWN",
            item.text("title").orEmpty(), item.text("since").orEmpty())
    }

    /** The cross-session bar for a screen showing [focused], or null when nothing elsewhere is waiting. An owner item wins
     * whatever else is waiting, the oldest by when the server says it has waited since; otherwise the session that has
     * waited longest, by the recency key Recents orders by. */
    fun banner(open: List<JsonObject>, focused: String? = null): NeedsYouBanner? {
        val elsewhere = open.filter { needsYou(it) && !(focused != null && ObjectId.same(it.text("id"), focused)) }
        oldestOwnerItem(elsewhere)?.let { (session, item) ->
            return NeedsYouBanner(elsewhere.size, session, ownerItemText(item, session.text("projectTitle")), item)
        }
        val target = elsewhere.minByOrNull(::recency) ?: return null
        return NeedsYouBanner(elsewhere.size, target, text(elsewhere.size, target))
    }

    /** The words the bar and a session row share for one of the four; null for a kind this build does not know. */
    fun kindWord(kind: String): String? = when (kind) {
        "PROMOTION_APPROVAL" -> "Approve merge to main"
        "COORDINATOR_QUESTION" -> "Question from coordinator"
        "ESCALATED" -> "Escalated to you"
        "FUSE_PAUSED" -> "Paused"
        else -> null
    }

    /** The word of the item that has waited longest, for a row the server says waits on one of the four (OrbitKit
     * `oldestItemWord`); null when none is a kind this build knows. An unparseable instant sorts last, as for the bar. */
    fun oldestItemWord(items: List<OwnerItem>): String? = items.mapNotNull { item -> kindWord(item.kind)?.let { it to (parse(item.since) ?: Instant.MAX) } }
        .fold(null as Pair<String, Instant>?) { oldest, next -> if (oldest == null || next.second < oldest.second) next else oldest }?.first

    /** "Approve merge to main · Integration line": which of the four, and which project. */
    fun ownerItemText(item: OwnerItem, project: String?): String {
        val what = kindWord(item.kind) ?: "Needs you"
        return if (project.isNullOrEmpty()) what else "$what · $project"
    }

    /** The card an owner item is drawn as in its coordinator conversation (`CardFocus` addresses). */
    fun cardKey(item: OwnerItem): String = if (item.kind == "PROMOTION_APPROVAL") "promotion:" else "item:${item.itemId}"

    private fun oldestOwnerItem(sessions: List<JsonObject>): Pair<JsonObject, OwnerItem>? {
        var oldest: Triple<JsonObject, OwnerItem, Instant>? = null
        sessions.forEach { session ->
            ownerItems(session).filter { kindWord(it.kind) != null }.forEach { item ->
                // An unparseable instant sorts last: it must not beat an item whose wait is known.
                val at = parse(item.since) ?: Instant.MAX
                if (oldest == null || at < oldest!!.third) oldest = Triple(session, item, at)
            }
        }
        return oldest?.let { it.first to it.second }
    }

    /** OrbitKit `RecentsLogic.recency`: seconds since 2001 of the last turn (or update, or creation); 0 when unreadable. */
    private fun recency(row: JsonObject): Double =
        parse(row.text("lastTurnAt") ?: row.text("updatedAt") ?: row.text("createdAt"))?.let { it.epochSecond - 978_307_200.0 + it.nano / 1e9 } ?: 0.0

    private fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    /** One session names its workspace; several collapse to a count. */
    private fun text(count: Int, target: JsonObject): String {
        if (count != 1) return "$count sessions need you"
        return "${target.obj("agent")?.text("name") ?: target.text("title") ?: "A session"} needs you"
    }
}
