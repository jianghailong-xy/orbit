package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The merge-to-main card while it merges, as OrbitKit's `OwnerItemCardsTests` holds `PromotionCards` since dbab6fc5b: a
 * confirmation does not invent a running merge, the card follows its own job, and Cancel goes dead once that job pushes. */
class PromotionCardsTest {
    /** Mock 4's own candidate. */
    private fun candidate(state: String, execution: String? = null) = Json.parseToJsonElement("""{"promotionId":"pr-1","state":"$state",
        "sourceRef":"refs/heads/project/bg-jobs","sourceSha":"58f3a4711d0c","upstreamRef":"main"${execution?.let { ",\"execution\":$it" } ?: ""}}""").jsonObject
    private fun running(phase: String) = """{"state":"RUNNING","phase":"$phase","startedAt":"2026-09-13T12:00:00Z"}"""

    @Test fun confirmationDoesNotInventARunningMerge() {
        val unknown = candidate("CONFIRMED")
        assertEquals("Merge confirmed: project/bg-jobs into main", PromotionCards.mergingTitle(unknown))
        assertEquals("confirmed — waiting for merge execution", PromotionCards.mergingStatusLine(unknown))
        assertEquals("Confirmed", PromotionCards.mergingActionLabel(unknown))
        for (state in listOf("CONFIRMED", "RECHECKING")) {
            val queued = candidate(state, """{"state":"QUEUED","startedAt":"2026-09-13T12:00:00Z"}""")
            assertEquals("Merge queued: project/bg-jobs into main", PromotionCards.mergingTitle(queued))
            assertEquals("confirmed — queued to merge into main", PromotionCards.mergingStatusLine(queued))
            assertEquals("Queued", PromotionCards.mergingActionLabel(queued))
        }
        val pushing = candidate("RECHECKING", running("PUSH"))
        assertEquals("confirmed — publishing the tested tree to main", PromotionCards.mergingStatusLine(pushing))
        assertEquals("Merging…", PromotionCards.mergingActionLabel(pushing))
        assertEquals("Merging project/bg-jobs into main…", PromotionCards.mergingTitle(pushing))
    }

    @Test fun aRecheckSaysWhyAndEveryStepIsNamed() {
        val recheck = candidate("RECHECKING", running("CHECK"))
        assertEquals("Re-checking project/bg-jobs before merging into main…", PromotionCards.mergingTitle(recheck))
        assertEquals("main moved since the check — re-checking the combined tree", PromotionCards.mergingStatusLine(recheck))
        assertEquals("Re-checking…", PromotionCards.mergingActionLabel(recheck))
        assertEquals("re-checking the combined tree", PromotionCards.mergingStatusLine(candidate("CONFIRMED", running("CHECK"))))
        mapOf("FETCH" to "confirmed — fetching the branches", "MAIN_SYNC" to "confirmed — syncing the branches", "REBASE" to "confirmed — rebasing the branch",
            "MERGE" to "confirmed — preparing the combined tree", "VERIFY" to "confirmed — verifying the tested tree", "SOMETHING_NEW" to "confirmed — starting the merge",
        ).forEach { (phase, line) -> assertEquals(phase, line, PromotionCards.mergingStatusLine(candidate("CONFIRMED", running(phase)))) }
    }

    /** The conversation's card: its heading and status row while it merges, and a Cancel the server would refuse is dead. */
    @Test fun theCardSaysWhereItsJobIsAndCancelDiesOnceItPushes() {
        fun card(execution: String?) = CardCatalog.project("s1", "p1", mapOf(
            "project" to buildJsonObject { put("id", "p1") },
            "promotion" to candidate("CONFIRMED", execution),
        )).single { it.family == CardFamily.PROMOTION }
        val queued = card("""{"state":"QUEUED","startedAt":"2026-09-13T12:00:00Z"}""")
        assertEquals("Merge queued: project/bg-jobs into main", queued.title)
        assertEquals("confirmed — queued to merge into main", queued.status)
        assertEquals(listOf("projects", "p1", "promotions", "pr-1", "cancel"), CardRequests.build(queued, CardVerb.CANCEL_MERGE).path)
        val pushing = card(running("PUSH"))
        assertEquals(listOf(CardVerb.CANCEL_MERGE), pushing.actions)
        assertTrue("the server refuses to call a pushing merge back", runCatching { CardRequests.build(pushing, CardVerb.CANCEL_MERGE) }.isFailure)
        val asking = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") }, "promotion" to candidate("READY")))
            .single { it.family == CardFamily.PROMOTION }
        assertEquals("a candidate asking the owner keeps its card", "Merge to main", asking.title)
        assertEquals("READY", asking.status)
    }
}
