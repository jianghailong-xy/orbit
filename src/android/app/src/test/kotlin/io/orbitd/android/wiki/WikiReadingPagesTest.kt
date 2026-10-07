package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The reading pages over the shared fixtures, as a reader presses them: an article's text and its footnote marks, a
 * topic with no article, a document opened at a section and its marks and footnotes, the document screen's 404 and
 * failed read, Browse and the A–Z index. Pages take recording actions; screens a store over a fake server and a
 * recording `WikiNav`. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(ExperimentalTestApi::class)
class WikiReadingPagesTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun show(content: @Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme { content() } } }
        compose.waitForIdle()
    }

    private fun link(tag: String): (AnnotatedString.Range<LinkAnnotation>) -> Boolean = { (it.item as? LinkAnnotation.Clickable)?.tag == tag }
    private fun inside(tag: String) = hasAnyAncestor(hasTestTag(tag))
    private fun absent(tag: String) = assertTrue("$tag is on screen", compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty())
    private fun press(tag: String) = compose.onNodeWithTag(tag).performSemanticsAction(SemanticsActions.OnClick)

    private fun docRead(): JsonObject = wikiDocsFixture().obj("docs").obj("doc").obj("read")
    private fun fixtureDoc(): WikiDoc = docRead().decodeAs(WikiDoc.serializer())

    // MARK: an article

    @Test fun anArticleReadsItsParagraphsAndItsFootnoteMarksOpenTheCitedEntry() {
        val article = WikiArticlesContractTest.ARTICLE.decodeAs(WikiArticle.serializer())
        val opened = mutableListOf<String>()
        val read = mutableListOf<String>()
        show { WikiArticlePage(article, emptyList(), actions = WikiArticleActions(openEntry = { opened += it }, readEntry = { read += it })) }
        compose.onNodeWithTag("wiki-article-title").assertTextEquals("数据库写入治理")
        compose.onNodeWithTag("wiki-article-crumb").assertTextEquals("Wiki · Data & backend · 数据库与 Prisma").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-article-block:0").assertTextContains("写入清单登记每一处 Prisma 写入。[1] 事务冲突时整段重跑。[1][2]", substring = true)
        compose.onNodeWithTag("wiki-article-block:1").assertTextContains("迁移按号排列。[2]", substring = true)
        compose.onNodeWithText("迁移").assertIsDisplayed()

        // A footnote mark in the text opens the entry's card, which reads the entry; Open entry opens it.
        compose.onNodeWithTag("wiki-article-block:0").performFirstLinkClick(link("note:1"))
        compose.onNode(hasText("会话写入前要登记写入清单") and inside("wiki-footnote-card")).assertExists()
        compose.onNode(hasText("要在 db-write-inventory 里登记。") and inside("wiki-footnote-card")).assertExists()
        compose.onNode(hasText(WikiArticleCopy.noteLabel(1)) and inside("wiki-footnote-card")).assertExists()
        assertEquals(listOf("34WEntryA"), read)
        press("wiki-footnote-card-open")
        compose.waitForIdle()
        assertEquals(listOf("34WEntryA"), opened)
        absent("wiki-footnote-card")

        // A footnote whose entry left the wiki says so, in the card and in the list, and opens nothing.
        compose.onNodeWithTag("wiki-article-block:1").performFirstLinkClick(link("note:2"))
        compose.onNode(hasText(WikiArticleCopy.footnoteGone) and inside("wiki-footnote-card")).assertExists()
        absent("wiki-footnote-card-open")
        assertEquals(listOf("34WEntryA"), read)

        compose.onNodeWithTag("wiki-article-list").performScrollToNode(hasTestTag("wiki-footnote:2"))
        compose.onNodeWithTag("wiki-footnote:2").assertIsNotEnabled()
        press("wiki-footnote:1")
        assertEquals(listOf("34WEntryA", "34WEntryA"), opened)
    }

    @Test fun anArticlesEntriesAreGroupedByKindAndOpen() {
        val article = WikiArticlesContractTest.ARTICLE.decodeAs(WikiArticle.serializer())
        val entries = (1..6).map { WikiEntry("p$it", kind = "pitfall", status = "active", trust = "auto", title = "Pitfall $it",
            summary = "Why $it", validFrom = "2026-09-2${it}T00:00:00.000Z") } +
            WikiEntry("r1", kind = "recipe", status = "retired", trust = "owner", title = "Retired recipe")
        val opened = mutableListOf<String>()
        show { WikiArticlePage(article, entries, actions = WikiArticleActions(openEntry = { opened += it })) }
        val list = compose.onNodeWithTag("wiki-article-list")
        list.performScrollToNode(hasText(WikiArticleCopy.groupPitfalls))
        // Four of a group, then Show 2 more.
        list.performScrollToNode(hasTestTag("wiki-article-group-more:0"))
        compose.onNodeWithTag("wiki-article-group-more:0").assertTextEquals(WikiArticleCopy.showMore(2))
        absent("wiki-article-entry:p1")
        press("wiki-article-group-more:0")
        list.performScrollToNode(hasTestTag("wiki-article-entry:p1"))
        press("wiki-article-entry:p1")
        assertEquals(listOf("p1"), opened)
        list.performScrollToNode(hasTestTag("wiki-article-group-more:0"))
        compose.onNodeWithTag("wiki-article-group-more:0").assertTextEquals(WikiArticleCopy.showLess)
        list.performScrollToNode(hasTestTag("wiki-article-entry:r1"))
        compose.onNodeWithTag("wiki-article-entry:r1").assertExists()
    }

    @Test fun aTopicWithoutAnArticleShowsItsEntriesAndWhyThereIsNoText() {
        val store = wikiTestStore { path ->
            when (path.drop(3)) {
                listOf("topics", "database") -> 200 to """{"slug":"database","entries":[
                    {"id":"e1","kind":"pitfall","status":"active","trust":"owner","title":"会话写入前要登记写入清单"},
                    {"id":"e2","kind":"decision","status":"active","trust":"auto","title":"迁移按号排列"}]}"""
                listOf("articles", "database") -> 404 to """{"message":"No such article"}"""
                listOf("articles") -> 200 to """{"categories":[{"key":"data","title":"Data & backend","topics":[
                    {"slug":"database","title":"数据库与 Prisma","article":null,"parts":[]}]}],"uncategorized":[]}"""
                else -> 404 to "{}"
            }
        }
        val record = WikiNavRecord()
        show { WikiArticleScreen(store, OrbitRoute(Destination.WIKI_ARTICLE, "database"), record.nav) }
        compose.onNodeWithText(WikiArticleCopy.noArticleYet).assertIsDisplayed()
        compose.onNodeWithTag("wiki-topic-title").assertTextEquals("数据库与 Prisma")
        compose.onNodeWithText(WikiArticleCopy.groupDecisions).assertIsDisplayed()
        compose.onNodeWithText(WikiArticleCopy.groupPitfalls).assertIsDisplayed()
        compose.onNodeWithTag("wiki-topic-entry:e1").performClick()
        assertEquals(listOf(OrbitRoute(Destination.WIKI_ENTRY, "e1")), record.pushed)
    }

    @Test fun anArticleThatCouldNotBeReadOffersRetry() {
        var status = 500
        val store = wikiTestStore { path ->
            when (path.drop(3)) {
                listOf("articles", "database") -> status to (if (status == 200) WikiArticlesContractTest.ARTICLE else """{"message":"Down"}""")
                else -> 404 to "{}"
            }
        }
        show { WikiArticleScreen(store, OrbitRoute(Destination.WIKI_ARTICLE, "database"), WikiNavRecord().nav) }
        compose.onNodeWithText("The article couldn't be loaded").assertIsDisplayed()
        status = 200
        compose.onNodeWithText("Retry").performClick()
        compose.onNodeWithTag("wiki-article-title").assertTextEquals("数据库写入治理")
    }

    // MARK: a document

    @Test fun aDocumentOpensAtItsSectionOnceAndKeepsTheReadersPlaceOnBack() {
        val doc = fixtureDoc()
        var shown by mutableStateOf(true)
        show {
            val holder = rememberSaveableStateHolder()
            if (shown) holder.SaveableStateProvider("doc") { WikiDocPage(doc, null, null, section = "s9") } else Text("elsewhere")
        }
        compose.onNodeWithTag("wiki-doc-section:s9").assertIsDisplayed()
        absent("wiki-doc-crumb")
        // The reader goes back up to the top, on to another page, and Back: the page is where they left it.
        compose.onNodeWithTag("wiki-doc-list").performScrollToIndex(0)
        compose.onNodeWithTag("wiki-doc-crumb").assertIsDisplayed()
        compose.runOnIdle { shown = false }
        compose.onNodeWithText("elsewhere").assertExists()
        compose.runOnIdle { shown = true }
        compose.onNodeWithTag("wiki-doc-crumb").assertIsDisplayed()
        compose.onNodeWithTag("wiki-doc-title").assertTextEquals(doc.title)
    }

    @Test fun aSourcedFootnotesOneButtonOpensTheSessionAtTheQuotedRecord() {
        val session = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
        val record = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"
        val read = docRead()
        val body = JsonObject(read + ("footnotes" to JsonArray(read.arr("footnotes").objects.map {
            if (it.num("n") == 44) JsonObject(it + mapOf("sessionId" to JsonPrimitive(session), "recordId" to JsonPrimitive(record))) else it
        }))).toString()
        val store = wikiTestStore { path -> if (path.drop(3) == listOf("docs", "session-runtime")) 200 to body else 404 to "{}" }
        val nav = WikiNavRecord()
        show { WikiDocScreen(store, OrbitRoute(Destination.WIKI_DOC, "session-runtime"), nav.nav) }
        compose.onNodeWithTag("wiki-doc-title").assertTextEquals(read.str("title")!!)
        compose.onNodeWithTag("wiki-doc-list").performScrollToNode(hasTestTag("wiki-doc-footnote:44"))
        compose.onNodeWithTag("wiki-doc-footnote:44").performClick()
        compose.onNode(hasText(WikiDocCopy.verdictCard("verified")) and inside("wiki-doc-footnote-sheet")).assertExists()
        compose.onNode(hasText(WikiDocCopy.viaEntry) and inside("wiki-doc-footnote-sheet")).assertExists()
        compose.onNodeWithTag("wiki-doc-source-open").assertTextEquals("Open at this turn")
        press("wiki-doc-source-open")
        compose.waitForIdle()
        val opened = nav.pushed.single()
        assertEquals(Destination.SESSION, opened.destination)
        assertTrue(opened.toString(), ObjectId.same(opened.id, session))
        assertTrue(opened.toString(), ObjectId.same(opened.recordId, record))
        absent("wiki-doc-footnote-sheet")
    }

    @Test fun markedSentencesWearTheirMarksAndSayWhy() {
        val doc = fixtureDoc()
        val github = WikiDocLogic.githubRepo("github.com/jianghailong-xy/orbit")
        val opened = mutableListOf<String>()
        val sources = mutableListOf<WikiDocLogic.OpenTarget>()
        show { WikiDocPage(doc, github, null, actions = WikiDocActions(openEntry = { opened += it }, openSource = { sources += it })) }
        fun said(section: String, block: Int, sentence: Int): String {
            val part = doc.sections!!.first { it.key == section }
            val note = WikiDocLogic.markNote(part.blocks!![block].sentences!![sentence], part, doc)!!
            return "${note.title} ${note.text}"
        }
        val list = compose.onNodeWithTag("wiki-doc-list")
        // The banner: how many sentences are marked, and why.
        compose.onNodeWithTag("wiki-doc-review").assertExists()
        compose.onNode(hasText(WikiDocCopy.nextMarked)).assertExists()

        // Not verified: why, and the footnote it failed on, whose one button opens the code on GitHub.
        list.performScrollToNode(hasTestTag("wiki-doc-block:s3.1"))
        compose.onNodeWithTag("wiki-doc-block:s3.1").assertTextContains(" ${WikiDocCopy.notVerified} ", substring = true)
        compose.onNodeWithTag("wiki-doc-block:s3.1").performFirstLinkClick(link("mark:s3.1.0"))
        compose.onNodeWithTag("wiki-doc-mark-note").assertTextEquals(said("s3", 1, 0))
        compose.onNodeWithTag("wiki-doc-mark-see").assertTextEquals(WikiDocCopy.seeFootnote(10))
        press("wiki-doc-mark-see")
        compose.waitForIdle()
        absent("wiki-doc-mark-bubble")
        compose.onNode(hasText(WikiDocCopy.verdictCard("no_quote")) and inside("wiki-doc-footnote-sheet")).assertExists()
        compose.onNode(hasText(WikiDocLogic.footnoteProblem(doc.footnotes!!.first { it.n == 10 })!!) and inside("wiki-doc-footnote-sheet")).assertExists()
        press("wiki-doc-source-open")
        compose.waitForIdle()
        assertEquals(listOf(WikiDocLogic.footnoteOpen(doc.footnotes!!.first { it.n == 10 }, github)!!.target), sources)
        absent("wiki-doc-footnote-sheet")

        // Withdrawn: why, and the entry it came through.
        list.performScrollToNode(hasTestTag("wiki-doc-block:s7.0"))
        compose.onNodeWithTag("wiki-doc-block:s7.0").assertTextContains(" ${WikiDocCopy.withdrawn} ", substring = true)
            .assertTextContains(" ${WikiDocCopy.noSource} ", substring = true)
        compose.onNodeWithTag("wiki-doc-block:s7.0").performFirstLinkClick(link("mark:s7.0.2"))
        compose.onNodeWithTag("wiki-doc-mark-note").assertTextEquals(said("s7", 0, 2))
        press("wiki-doc-mark-entry")
        compose.waitForIdle()
        assertEquals(listOf("e30"), opened)
        absent("wiki-doc-mark-bubble")

        // No source: why, and nothing more to open.
        compose.onNodeWithTag("wiki-doc-block:s7.0").performFirstLinkClick(link("mark:s7.0.3"))
        compose.onNodeWithTag("wiki-doc-mark-note").assertTextEquals(said("s7", 0, 3))
        absent("wiki-doc-mark-see")
        absent("wiki-doc-mark-entry")
    }

    @Test fun aDocumentsFootnotesAndEntriesListUnderItsText() {
        val doc = fixtureDoc()
        val opened = mutableListOf<String>()
        show { WikiDocPage(doc, null, null, summaries = mapOf(wikiKey("e44") to "Drain kills background jobs"),
            actions = WikiDocActions(openEntry = { opened += it })) }
        val list = compose.onNodeWithTag("wiki-doc-list")
        list.performScrollToNode(hasTestTag("wiki-doc-footnote:11"))
        compose.onNodeWithTag("wiki-doc-footnote:11").assertTextContains(WikiDocCopy.verdictList("not_found"), substring = true)
        // A rejected entry is struck through with what became of its sentences; the others carry their summaries.
        list.performScrollToNode(hasTestTag("wiki-doc-entry:e30"))
        compose.onNodeWithTag("wiki-doc-entry:e30").assertTextContains(WikiDocLogic.viaEntryNote(doc.entries!!.first { it.id == "e30" }, doc)!!)
        list.performScrollToNode(hasTestTag("wiki-doc-entry:e44"))
        compose.onNodeWithTag("wiki-doc-entry:e44").assertTextContains("Drain kills background jobs")
        press("wiki-doc-entry:e44")
        assertEquals(listOf("e44"), opened)
    }

    @Test fun aDocumentThePlanDoesNotHaveSaysSo() {
        val store = wikiTestStore { 404 to """{"message":"Not found"}""" }
        show { WikiDocScreen(store, OrbitRoute(Destination.WIKI_DOC, "gone"), WikiNavRecord().nav) }
        compose.onNodeWithText("That document is not in this space’s plan.").assertIsDisplayed()
        compose.onNodeWithText(WikiCopy.title).assertIsDisplayed()
        compose.onNodeWithText("Retry").assertDoesNotExist()
        absent("wiki-doc-list")
    }

    @Test fun aDocumentThatCouldNotBeReadOffersRetry() {
        var status = 500
        val body = docRead().toString()
        val store = wikiTestStore { path ->
            if (path.drop(3) == listOf("docs", "session-runtime")) status to (if (status == 200) body else """{"message":"Down"}""") else 404 to "{}"
        }
        show { WikiDocScreen(store, OrbitRoute(Destination.WIKI_DOC, "session-runtime"), WikiNavRecord().nav) }
        compose.onNodeWithText("The document couldn't be loaded").assertIsDisplayed()
        compose.onNodeWithText("Check the connection, then try again.").assertIsDisplayed()
        status = 200
        compose.onNodeWithText("Retry").performClick()
        compose.onNodeWithTag("wiki-doc-title").assertTextEquals(docRead().str("title")!!)
    }

    // MARK: Browse and the index

    @Test fun browseOpensATopicsSubtopicArticles() {
        val directory = wikiArticlesFixture().obj("directory").obj("read").decodeAs(WikiArticleDirectory.serializer())
        val opened = mutableListOf<Pair<String, Int>>()
        show { WikiBrowsePage(WikiArticleLogic.browseCategories(directory), WikiArticleActions(openArticle = { topic, part -> opened += topic to part })) }
        compose.onNodeWithText(wikiArticlesFixture().obj("browse").str("summary")!!).assertIsDisplayed()
        compose.onNodeWithTag("wiki-browse-topic:watches-wakeups").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-browse-topic-toggle:sessions").performClick()
        compose.onNodeWithTag("wiki-browse-part:sessions:5").assertExists()
        absent("wiki-browse-part:sessions:6")
        compose.onNodeWithTag("wiki-browse-more:sessions").assertTextEquals(WikiArticleCopy.moreArticles(5)).performClick()
        compose.onNodeWithTag("wiki-browse-list").performScrollToNode(hasTestTag("wiki-browse-part:sessions:10"))
        compose.onNodeWithTag("wiki-browse-part:sessions:10").performClick()
        compose.onNodeWithTag("wiki-browse-list").performScrollToNode(hasTestTag("wiki-browse-topic:tasks"))
        compose.onNodeWithTag("wiki-browse-topic:tasks").performClick()
        assertEquals(listOf("sessions" to 10, "tasks" to 0), opened)
    }

    @Test fun browseByDocumentOpensADocumentAtASection() {
        val directory = wikiDocsFixture().obj("docs").obj("directory").obj("read").decodeAs(WikiDocsDirectory.serializer())
        val docs = mutableListOf<String>()
        val sections = mutableListOf<Pair<String, String>>()
        show { WikiDocsBrowsePage(directory, WikiDocActions(openDoc = { docs += it }), openSection = { slug, key -> sections += slug to key }) }
        compose.onNodeWithText(WikiDocLogic.browseSummary(directory).joinToString(" · ")).assertIsDisplayed()
        compose.onNodeWithTag("wiki-browse-doc-toggle:session-runtime").performClick()
        compose.onNodeWithTag("wiki-browse-section:session-runtime:s7").performClick()
        compose.onNodeWithTag("wiki-browse-list").performScrollToNode(hasTestTag("wiki-browse-doc:session-state"))
        compose.onNodeWithTag("wiki-browse-doc:session-state").performClick()
        assertEquals(listOf("session-runtime" to "s7"), sections)
        assertEquals(listOf("session-state"), docs)
    }

    @Test fun theIndexsLettersJumpToTheirGroups() {
        val items = wikiArticlesFixture().obj("index").arr("items").decodeAs(ListSerializer(WikiArticleIndex.Item.serializer()))
        val groups = WikiArticleLogic.indexGroups(items)
        val opened = mutableListOf<Pair<String, Int>>()
        show { WikiIndexPage(groups, items.size, WikiArticleActions(openArticle = { topic, part -> opened += topic to part })) }
        compose.onNodeWithText(WikiArticleCopy.indexSummary(items.size)).assertIsDisplayed()
        absent("wiki-index-item:sessions:1")
        compose.onNodeWithTag("wiki-index-letter:W").performClick()
        compose.onNodeWithTag("wiki-index-item:sessions:1").assertIsDisplayed().performClick()
        assertEquals(listOf("sessions" to 1), opened)
    }

    @Test fun theIndexByDocumentOpensASectionWhereItIs() {
        val items = wikiDocsFixture().obj("docs").obj("index").arr("items").decodeAs(ListSerializer(WikiDocsIndex.Item.serializer()))
        val docs = mutableListOf<String>()
        val sections = mutableListOf<Pair<String, String>>()
        show { WikiDocsIndexPage(items, WikiDocActions(openDoc = { docs += it }), openSection = { slug, key -> sections += slug to key }) }
        compose.onNodeWithText(WikiDocLogic.indexSummary(items)).assertIsDisplayed()
        val list = compose.onNodeWithTag("wiki-index-list")
        list.performScrollToNode(hasTestTag("wiki-index-entry:session-runtime:s3"))
        compose.onNodeWithTag("wiki-index-entry:session-runtime:s3").performClick()
        list.performScrollToNode(hasTestTag("wiki-index-entry:session-runtime:"))
        compose.onNodeWithTag("wiki-index-entry:session-runtime:").performClick()
        assertEquals(listOf("session-runtime" to "s3"), sections)
        assertEquals(listOf("session-runtime"), docs)
    }
}
