package io.orbitd.android.wiki

import android.app.Application
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.ZoneId

/** OrbitKit `WikiArticlesContractTests`, and the `src/shared/src/wiki-articles.fixture.json` half of
 * `WikiArticlesCopyParityTests`: the article vocabulary is `contracts/wiki.contract.json` `articles` — the six categories
 * in the directory's order and in the words every client shows, the three kinds, the user door's routes the reads are on
 * — what the server answers decodes, a value this build has never heard of keeps its word and reads as unknown, and every
 * word, count, letter and order the article pages draw is the fixture's, which the web and iOS read too. Robolectric for
 * `android.icu`, which files Chinese titles by pinyin. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class WikiArticlesContractTest {
    private val contract by lazy { wikiContract() }
    private val articles get() = contract.obj("articles")
    private val fixture by lazy { wikiArticlesFixture() }
    private val zone get() = ZoneId.of(fixture.str("timeZone"))

    /** OrbitKit `WikiArticleCategory`'s cases, in the directory's order; the Kotlin port reads them as raw words. */
    private val categories = listOf("platform", "runner", "clients", "data", "engineering", "collaboration")
    /** OrbitKit `WikiArticleKind`'s cases. */
    private val kinds = setOf("article", "overview", "subtopic")

    private fun userRoutes(): Set<String> = contract.obj("agentSurface").obj("doors").obj("user").arr("routes").texts.toSet()

    // MARK: the contract

    /** The six categories, in order, named as the contract names them. */
    @Test fun categoriesAreTheContractsInItsOrderAndWords() {
        val declared = articles.arr("categories").objects
        assertEquals(categories, declared.map { it.str("key") })
        declared.forEach { assertEquals(it.str("key"), it.str("title"), WikiArticleLogic.categoryTitle(it.str("key"))) }
        // A category a later server adds is filed under Other, as OrbitKit's `.unknown` is.
        assertEquals(WikiArticleCopy.other, WikiArticleLogic.categoryTitle("economics"))
    }

    @Test fun kindsAreTheContracts() {
        assertEquals(kinds, articles.obj("kinds").keys)
    }

    /** The reads are the user door's routes, the door has no route that writes an article, and the client reads them. */
    @Test fun theReadsAreOnTheUserDoor() {
        val routes = articles.obj("routes")
        val user = userRoutes()
        for (name in listOf("directory", "article", "part", "index")) {
            val route = requireNotNull(routes.str(name)) { name }
            assertTrue(route, route.startsWith("GET /api/wiki/spaces/:id/"))
            assertTrue("$route is not a route the user door declares", route in user)
        }
        assertFalse(user.any { it.startsWith("POST") && it.contains("/articles") })
        val asked = mutableListOf<List<String>>()
        val (auth, handle) = wikiSignedIn { path ->
            asked += path
            200 to when (path.last()) {
                "articles" -> """{"categories":[]}"""
                "article-index" -> """{"items":[]}"""
                else -> """{"topic":{"slug":"database"},"part":0,"blocks":[],"footnotes":[]}"""
            }
        }
        val client = WikiClient(auth, handle)
        runBlocking { client.articleDirectory("sp1"); client.article("sp1", "database", 0); client.article("sp1", "database", 2); client.articleIndex("sp1") }
        fun route(path: List<String>) = "GET /api/" + path.mapIndexed { i, part -> when (i) { 2 -> ":id"; 4 -> ":slug"; 5 -> ":part"; else -> part } }.joinToString("/")
        assertEquals(listOf("directory", "article", "part", "index").map { routes.str(it) }, asked.map(::route))
    }

    /** An article as the server answers it: blocks of footnoted sentences, and footnotes resolved. */
    @Test fun anArticleDecodes() {
        val article = ARTICLE.decodeAs(WikiArticle.serializer())
        assertEquals("article", article.kind)
        assertEquals("data", article.topic.category)
        assertEquals(2, article.blocks.size)
        assertEquals(listOf(1, 2), article.blocks[0].sentences[1].notes)
        assertEquals("迁移", article.blocks[1].heading)
        assertEquals(listOf(1, 2), article.footnotes.map { it.n })
        assertEquals("pitfall", article.footnotes[0].entry?.kind)
        assertNull("an entry that no longer exists is a footnote with no entry", article.footnotes[1].entry)
        // A kind and a category a later server adds keep their words, read as unknown, and the page still decodes.
        val later = ARTICLE.replace(""""kind":"article"""", """"kind":"digest"""").replace(""""category":"data"""", """"category":"economics"""")
            .decodeAs(WikiArticle.serializer())
        assertEquals("digest", later.kind)
        assertFalse(later.kind in kinds)
        assertEquals(WikiArticleCopy.other, WikiArticleLogic.categoryTitle(later.topic.category))
    }

    /** The article read names the entries it was written from (`entryIds`) and carries them as they stand (`entries`, the
     * cited ones first, at most `reads.entriesListed`); a server that predates them sends neither, and it still decodes. */
    @Test fun anArticleNamesTheEntriesItIsWrittenFrom() {
        val reads = articles.obj("reads")
        assertEquals(200, reads.num("entriesListed"))
        val article = requireNotNull(reads.str("article"))
        assertTrue(article, article.contains("(entryIds"))
        assertTrue(article, article.contains("(entries)"))
        val decoded = """{"topic":{"slug":"wiki"},"part":1,"blocks":[],"footnotes":[{"n":1,"entryId":"34WEntryB","revision":1,"entry":null}],
            "entryCount":3,"entryIds":["34WEntryB","34WEntryA","34WEntryC"],
            "entries":[{"id":"34WEntryB","kind":"pitfall","status":"active","trust":"auto","title":"Cited first"},
                       {"id":"34WEntryA","kind":"concept","status":"active","trust":"owner","title":"Of another topic"},
                       {"id":"34WEntryC","kind":"recipe","status":"retired","trust":"auto","title":"Retired since"}]}""".decodeAs(WikiArticle.serializer())
        assertEquals(listOf("34WEntryB", "34WEntryA", "34WEntryC"), decoded.entryIds)
        assertEquals(listOf("34WEntryB", "34WEntryA", "34WEntryC"), decoded.entries?.map { it.id })
        assertEquals("retired", decoded.entries?.last()?.status)
        assertEquals("the 3 this article is written from, by kind", WikiArticleCopy.entriesHint(decoded.entryIds?.size ?: 0))
        val older = """{"topic":{"slug":"wiki"},"part":0,"blocks":[],"footnotes":[]}""".decodeAs(WikiArticle.serializer())
        assertNull(older.entryIds)
        assertNull(older.entries)
    }

    @Test fun theDirectoryAndTheIndexDecode() {
        val decoded = """{"spaceId":"34WSpace","categories":[{"key":"platform","title":"Platform core","topics":[
          {"slug":"wiki","title":"Wiki","description":"The Orbit wiki itself.","category":"platform",
           "article":{"part":0,"kind":"overview","title":"Wiki 模块","entryCount":3,"generatedAt":"2026-09-28T02:00:00.000Z"},
           "parts":[{"part":1,"kind":"subtopic","title":"Articles and dossiers","entryCount":2}]},
          {"slug":"sessions","title":"会话","description":null,"category":"platform","article":null,"parts":[]}]}],
         "uncategorized":[]}""".decodeAs(WikiArticleDirectory.serializer())
        val platform = requireNotNull(decoded.categories?.first())
        assertEquals("platform", platform.key)
        assertEquals("overview", platform.topics?.first()?.article?.kind)
        assertEquals(1, platform.topics?.first()?.parts?.first()?.part)
        assertNull(platform.topics?.last()?.article)
        val items = """{"spaceId":"34WSpace","items":[
          {"part":1,"kind":"subtopic","title":"Articles and dossiers","entryCount":2,"initial":"A","topic":{"slug":"wiki","title":"Wiki"}},
          {"part":0,"kind":"article","title":"数据库写入治理","entryCount":2,"initial":"#","topic":{"slug":"database","title":"数据库与 Prisma"}}]}"""
            .decodeAs(WikiArticleIndex.serializer()).items
        assertEquals(listOf("A", "#"), items.map { it.initial })
        assertEquals(listOf("wiki", "database"), items.map { it.topic.slug })
    }

    // MARK: the fixture's words

    @Test fun theWordsAreTheFixtures() {
        val words = fixture.obj("words")
        assertEquals(listOf("contents", "home", "browse", "azIndex", "other", "footnotes", "entries", "footnoteGone", "openEntry", "topicOverview",
            "noArticleYet", "noArticles").map { words.str(it) },
            listOf(WikiArticleCopy.contents, WikiArticleCopy.home, WikiArticleCopy.browse, WikiArticleCopy.azIndex, WikiArticleCopy.other,
                WikiArticleCopy.footnotes, WikiArticleCopy.entries, WikiArticleCopy.footnoteGone, WikiArticleCopy.openEntry,
                WikiArticleCopy.topicOverview, WikiArticleCopy.noArticleYet, WikiArticleCopy.noArticles))
        words.arr("moreArticles").objects.forEach { assertEquals(it.str("says"), WikiArticleCopy.moreArticles(it.num("n")!!)) }
        fixture.arr("counts").objects.forEach { assertEquals(it.str("says"), WikiArticleCopy.count(it.num("n")!!)) }
        fixture.arr("entriesCited").objects.forEach { assertEquals(it.str("says"), WikiArticleCopy.entriesCited(it.num("n")!!)) }
        fixture.arr("entriesHints").objects.forEach { assertEquals(it.str("says"), WikiArticleCopy.entriesHint(it.num("n")!!)) }
        fixture.arr("sourcesLines").objects.forEach { assertEquals(it.str("says"), WikiArticleCopy.sourcesLine(it.num("sources")!!, it.num("sessions")!!)) }
        fixture.arr("noteLabels").objects.forEach { assertEquals(it.str("says"), WikiArticleCopy.noteLabel(it.num("n")!!)) }
        fixture.arr("updated").objects.forEach { row ->
            val article = row.obj("article")
            assertEquals(row.str("says"), WikiArticleCopy.updated(article.str("generatedAt"), article.str("ref"), article.num("entryCount")!!, zone))
        }
        // The topic page's kind groups, in their order and with their kinds, and the one sentence built around a count.
        assertEquals(listOf(listOf("principle", "convention"), listOf("decision"), listOf("pitfall"), listOf("recipe"), listOf("concept")),
            WikiArticleLogic.entryGroupKinds.map { it.kinds })
        assertEquals("Show 16 more", WikiArticleCopy.showMore(16))
    }

    // MARK: the fixture's readings

    @Test fun theDirectoryAndBrowseAreTheFixtures() {
        val directory = fixture.obj("directory")
        val read = directory.obj("read").decodeAs(WikiArticleDirectory.serializer())
        val groups = WikiArticleLogic.directoryGroups(read)
        val expected = directory.arr("groups").objects
        assertEquals(expected.map { it.str("title") }, groups.map { it.title })
        groups.zip(expected).forEach { (group, want) ->
            val topics = want.arr("topics").objects
            assertEquals(topics.map { it.str("slug") }, group.topics.map { it.slug })
            assertEquals(topics.map { it.str("title") }, group.topics.map { it.title })
            assertEquals(topics.map { it.num("count") }, group.topics.map { it.count })
            assertEquals(topics.map { it.arr("parts").texts }, group.topics.map { topic -> topic.parts.map { it.title } })
        }

        val categories = WikiArticleLogic.browseCategories(read)
        val totals = WikiArticleLogic.browseTotals(categories)
        val browse = fixture.obj("browse")
        assertEquals(browse.str("summary"), WikiArticleCopy.browseSummary(totals.articles, totals.topics, totals.entries))
        val wanted = browse.arr("categories").objects
        assertEquals(wanted.map { it.str("title") }, categories.map { it.title })
        categories.zip(wanted).forEach { (category, want) ->
            assertEquals(want.str("summary"), WikiArticleCopy.categorySummary(category.topics, category.articles, category.entries))
            val topics = want.arr("topics").objects
            assertEquals(topics.map { it.str("slug") }, category.rows.map { it.slug })
            assertEquals(topics.map { it.str("title") }, category.rows.map { it.title })
            assertEquals(topics.map { it.str("line") }, category.rows.map { if (it.hasArticle) WikiArticleCopy.browseTopicLine(it.entries, it.articles) else null })
            assertEquals(topics.map { it.num("parts") }, category.rows.map { it.parts.size })
        }
        assertEquals(browse.num("shownPhone"), WikiArticleLogic.browseShown)
    }

    /** The index files every title under the web's letter — Chinese by pinyin — in the web's order. */
    @Test fun theIndexIsTheFixtures() {
        fixture.arr("initials").objects.forEach { assertEquals(it.str("title"), it.str("says"), WikiArticleLogic.indexInitial(it.str("title")!!)) }
        val index = fixture.obj("index")
        val items = index.arr("items").decodeAs(ListSerializer(WikiArticleIndex.Item.serializer()))
        assertEquals(index.str("summary"), WikiArticleCopy.indexSummary(items.size))
        val groups = WikiArticleLogic.indexGroups(items)
        val wanted = index.arr("groups").objects
        assertEquals(wanted.map { it.str("letter") }, groups.map { it.letter })
        groups.zip(wanted).forEach { (group, want) ->
            val rows = want.arr("rows").objects
            assertEquals(group.letter, rows.map { it.str("title") }, group.items.map { it.title ?: "" })
            assertEquals(group.letter, rows.map { it.str("meta") }, group.items.map(WikiArticleLogic::indexMeta))
        }
        assertEquals(fixture.obj("orders").arr("indexLetters").texts, WikiArticleLogic.indexLetters)
    }

    /** The web derives a Chinese title's letter from where it falls in the pinyin collation; each of its boundary
     * characters reads as its own letter here too. */
    @Test fun theWebsPinyinBoundariesAreTheNativeInitials() {
        "ABCDEFGHJKLMNOPQRSTWXYZ".zip("阿丷嚓咑妸发旮哈丌咔垃呣拏喔妑七呥仨他屲夕丫帀").forEach { (letter, boundary) ->
            assertEquals("$boundary", "$letter", WikiArticleLogic.indexInitial("$boundary"))
        }
        assertTrue(WikiArticleLogic.isHan("会".codePointAt(0)))
        assertFalse(WikiArticleLogic.isHan("「".codePointAt(0)))
        assertFalse(WikiArticleLogic.isHan('A'.code))
    }

    @Test fun anArticlesReadingsAreTheFixtures() {
        fixture.arr("segments").objects.forEach { row ->
            assertEquals(row.str("text"), row.arr("says").objects.map { "${it.str("kind")}:${it.str("text")}" },
                WikiArticleLogic.segments(row.str("text")!!).map { "${it.kind.name.lowercase()}:${it.text}" })
        }
        fixture.arr("kindTags").objects.forEach { row -> assertEquals(row.arr("says").texts, WikiArticleLogic.kindTags(row.arr("kinds").texts)) }
        val articleGroups = fixture.obj("articleGroups")
        val entries = articleGroups.arr("entries").objects.map {
            WikiEntry(it.str("id")!!, kind = it.str("kind"), status = "active", trust = "auto", title = it.str("id"), validFrom = it.str("validFrom"))
        }
        val groups = WikiArticleLogic.entryGroups(entries, articleGroups.arr("cited").texts)
        val wanted = articleGroups.arr("groups").objects
        assertEquals(wanted.map { it.str("title") }, groups.map { it.title })
        assertEquals(wanted.map { it.arr("ids").texts }, groups.map { group -> group.entries.map { it.id } })
        val sources = listOf(
            WikiSource("a", kind = "turn", ref = "s1", locator = buildJsonObject { put("turnId", "t1") }, state = "live"),
            WikiSource("b", kind = "turn", ref = "s1", locator = buildJsonObject { put("turnId", "t2") }, state = "live"),
            WikiSource("c", kind = "turn", ref = "t9", state = "live"),
            WikiSource("d", kind = "commit", ref = "abc", state = "live"))
        assertEquals(4 to 1, WikiArticleLogic.sourceCounts(sources))
    }

    // MARK: the orders

    /** An article's page: crumb, title, tags, when it was written, the text, the footnotes, the entries; the directory's
     * first rows; Browse's and the index's blocks — the fixture's orders, and the ones the Kotlin pages draw in. */
    @Test fun theOrdersAreTheFixtures() {
        val orders = fixture.obj("orders")
        assertEquals(orders.arr("articleSections").texts, WikiArticleLogic.Section.entries.map { it.raw })
        assertEquals(orders.arr("directoryHead").texts, listOf(WikiArticleCopy.home, WikiArticleCopy.browse, WikiArticleCopy.azIndex))
        assertEquals(listOf("crumb", "title", "summary", "categories"), orders.arr("browseSections").texts)
        assertEquals(listOf("crumb", "title", "summary", "letters", "groups"), orders.arr("indexSections").texts)
    }

    companion object {
        internal const val ARTICLE = """{"spaceId":"34WSpace","topic":{"slug":"database","title":"数据库与 Prisma","category":"data","categoryTitle":"Data & backend"},
         "part":0,"kind":"article","title":"数据库写入治理",
         "blocks":[{"heading":null,"sentences":[{"text":"写入清单登记每一处 Prisma 写入。","notes":[1]},{"text":"事务冲突时整段重跑。","notes":[1,2]}]},
                   {"heading":"迁移","sentences":[{"text":"迁移按号排列。","notes":[2]}]}],
         "footnotes":[{"n":1,"entryId":"34WEntryA","revision":1,"entry":{"id":"34WEntryA","kind":"pitfall","title":"会话写入前要登记写入清单","summary":"要在 db-write-inventory 里登记。","status":"active","trust":"owner","currentRevision":1}},
                      {"n":2,"entryId":"34WEntryB","revision":2,"entry":null}],
         "entryCount":2,"chars":34,"generatedAt":"2026-09-28T02:00:00.000Z","ref":"0123456789abcdef0123456789abcdef01234567",
         "model":"qwen3.8-27b-fp8","overview":null,"parts":[]}"""
    }
}
