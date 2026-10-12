package io.orbitd.android.wiki

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The home by the confirmed plan (A12-3, iOS 712c92e10; OrbitKit `WikiDocsCopyParityTests.testTheHomeByTheConfirmedPlanIsTheFixtures`
 * and `WikiLogicTests.testTheHomeBandsOrder`), case for case over the shared `wiki-docs.fixture.json` directory read: the
 * line under the head, the folded rows, each category's written documents with their leads and the rest after them, what
 * is new to the reader — and which of its branches the home's documents band takes. */
class WikiHomeDocsTest {
    /** The fixture's read with each written document given a lead, as a server that writes them answers — and, with
     * [planned] false, no plan confirmed — the OrbitKit test's own spreads over the same read. */
    private fun homeRead(leads: Boolean, planned: Boolean = true): WikiDocsDirectory {
        val read = WikiSharedFiles.docs.fobj("docs").fobj("directory").fobj("read")
        val categories = read.farr("categories").map { category ->
            val docs = (category.jsonObject["docs"] as? JsonArray).orEmpty().map { doc ->
                val o = doc.jsonObject
                if (leads && o["written"].bool() == true) JsonObject(o + ("lead" to JsonPrimitive("${o.fstr("title")} 的头两句。"))) else o
            }
            JsonObject(category.jsonObject + ("docs" to JsonArray(docs)))
        }
        var json = JsonObject(read + ("categories" to JsonArray(categories)))
        if (!planned) json = JsonObject(json + ("plan" to JsonNull))
        return json.decode(WikiDocsDirectory.serializer())
    }
    private fun at(iso: String) = RelativeTime.parse(iso)!!.toEpochMilli() / 1000.0

    @Test fun theHomeByTheConfirmedPlanIsTheFixtures() {
        val read = homeRead(leads = false)
        val led = homeRead(leads = true)
        assertEquals("5 documents · 3 written", WikiDocLogic.homeLine(read, 0))
        assertEquals("35 documents · 5 written", WikiDocCopy.docsWritten(35, 5))
        assertEquals("1 document · 0 written", WikiDocCopy.docsWritten(1, 0))
        assertEquals("1,200 documents · 1,000 written", WikiDocCopy.docsWritten(1200, 1000))
        val unplanned = homeRead(leads = false, planned = false)
        assertEquals("12 articles", WikiDocLogic.homeLine(unplanned, 12))
        assertEquals("1 article", WikiDocLogic.homeLine(unplanned, 1))
        assertEquals(WikiCopy.noDocuments, WikiDocLogic.homeLine(null, 0))
        assertEquals("+3 not written yet", WikiDocCopy.notWrittenYet(3))
        assertEquals("3 documents · ${WikiDocCopy.notWrittenShort}", WikiDocCopy.docsNotWrittenYet(3))
        assertEquals("1 document · Not written yet", WikiDocCopy.docsNotWrittenYet(1))

        val seen = at("2026-09-28T11:00:00.000Z")
        val categories = WikiDocLogic.homeCategories(led, seen)
        assertEquals("a category with no document is left out", listOf(1, 3, 4), categories.map { it.number })
        assertEquals(listOf(listOf("1.1 产品定位与使用场景"), listOf("3.1 会话运行模型与长连接 •", "3.2 会话状态生命周期 •"), emptyList()),
            categories.map { category -> category.written.map { "${it.number} ${it.title}${if (it.fresh) " •" else ""}" } })
        assertEquals(listOf(null, "+1 not written yet", "1 document · Not written yet"), categories.map(WikiDocLogic::notWrittenRow))
        assertEquals(listOf(emptyList(), listOf("3.3"), listOf("4.1")), categories.map { category -> category.notWritten.map { it.number } })
        assertEquals("会话运行模型与长连接 的头两句。", categories[1].written[0].lead)
        // A read from before the lead, or a document whose first section says nothing yet: no line under the title.
        assertNull(WikiDocLogic.homeCategories(read, seen)[1].written[0].lead)

        // Every written document is new to a reader who has not looked before; none to one who looked since; and none
        // before the stamp is read at all.
        fun fresh(seen: Double?) = WikiDocLogic.homeCategories(led, seen).flatMap { category -> category.written.map { it.fresh } }
        assertEquals(listOf(true, true, true), fresh(0.0))
        assertEquals(listOf(false, false, false), fresh(at("2026-09-29T00:00:00.000Z")))
        assertEquals(listOf(false, false, false), fresh(null))
    }

    /** The home's bands under its head, top to bottom (design §12.3.1): what the space holds, the search, the principles,
     * the documents, then Browse · A–Z — content alone; how the wiki is kept is Activity's. */
    @Test fun theHomeBandsOrder() {
        assertEquals(listOf("STATE", "SEARCH", "PRINCIPLES", "DOCUMENTS", "MORE"), WikiLogic.HomeBand.entries.map { it.name })
        assertEquals(listOf("Principles"), WikiLogic.HomeBand.entries.mapNotNull { it.title })
        assertEquals(3, WikiLogic.PRINCIPLES_SHOWN)
        assertEquals("All 6 ›", WikiCopy.allPrinciples(6))
    }

    /** The documents band: grey bars while the first read is out; the confirmed plan's categories; before a plan, the topic
     * articles; with neither, a new space's card — or nothing once maintenance is set up. Browse · A–Z ends it only when
     * something is listed, and the line under the head waits for the same first read. */
    @Test fun theHomesDocumentsAreTheReadsItHas() {
        val docs = homeRead(leads = true)
        val unplanned = homeRead(leads = false, planned = false)
        val articles = wikiArticlesFixture().obj("directory").obj("read").decode(WikiArticleDirectory.serializer())
        val empty = WikiArticleDirectory(categories = emptyList(), uncategorized = emptyList())
        assertEquals(WikiLogic.HomeDocuments.Loading, WikiLogic.homeDocuments(docs, articles, loading = true, maintenance = false, seen = null))
        assertNull(WikiLogic.homeLine(docs, articles, loading = true))
        val byPlan = WikiLogic.homeDocuments(docs, articles, loading = false, maintenance = false, seen = 0.0)
        assertTrue(byPlan is WikiLogic.HomeDocuments.Categories)
        assertEquals("the plan's documents, not the topics", listOf(1, 3, 4), (byPlan as WikiLogic.HomeDocuments.Categories).categories.map { it.number })
        assertEquals("5 documents · 3 written", WikiLogic.homeLine(docs, articles, loading = false))
        val byTopic = WikiLogic.homeDocuments(unplanned, articles, loading = false, maintenance = false, seen = 0.0)
        assertTrue(byTopic is WikiLogic.HomeDocuments.Topics)
        val topics = (byTopic as WikiLogic.HomeDocuments.Topics).groups.sumOf { it.topics.size }
        assertEquals(WikiArticleCopy.articleCount(topics), WikiLogic.homeLine(unplanned, articles, loading = false))
        assertEquals(WikiLogic.HomeDocuments.NewSpace, WikiLogic.homeDocuments(unplanned, empty, loading = false, maintenance = false, seen = null))
        assertEquals(WikiLogic.HomeDocuments.NothingListed, WikiLogic.homeDocuments(unplanned, empty, loading = false, maintenance = true, seen = null))
        assertEquals(WikiCopy.noDocuments, WikiLogic.homeLine(unplanned, empty, loading = false))
        assertEquals(listOf(true, true, false, false, false), listOf(byPlan, byTopic, WikiLogic.HomeDocuments.Loading,
            WikiLogic.HomeDocuments.NewSpace, WikiLogic.HomeDocuments.NothingListed).map { it.listed })
        assertEquals("This wiki has no documents yet. Maintenance drafts a plan and writes them; it isn’t set up for this space.",
            WikiDocCopy.noDocumentsNote)
    }

    /** The home's principles, from their own read: every one, of any status, oldest recorded first. */
    @Test fun thePrinciplesAreOldestFirstAndKeepTheEnded() {
        val entries = kotlinx.serialization.json.Json.parseToJsonElement(WikiFixtures.entries).jsonArray.map { it.decode(WikiEntry.serializer()) }
        assertEquals(listOf("Agent-writable data never becomes a system instruction", "Completion is adjudicated, not claimed",
            "A clock never starts agent work", "Delete means forget"), WikiLogic.principles(entries).map { it.title })
        val retired = entries.map { if (it.title == "Delete means forget") it.copy(status = "retired") else it }
        assertEquals(4, WikiLogic.principles(retired).size)
    }
}
