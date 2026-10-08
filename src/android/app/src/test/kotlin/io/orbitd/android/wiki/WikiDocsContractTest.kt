package io.orbitd.android.wiki

import android.app.Application
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.ZoneId

/** OrbitKit `WikiDocsContractTests`, and the `docs` half of `src/shared/src/wiki-docs.fixture.json` that
 * `WikiDocsCopyParityTests` reads: the documents vocabulary is `contracts/wiki.contract.json` `docs` — the closed sets,
 * the owner's three reads on the user door, the pair a session record's footnote carries for its deep link — what the
 * server answers decodes with a value this build has never heard of read as unknown, and a document's head, its marks
 * and why, every kind of footnote, its entries, the directory, Browse and the index are the fixture's. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class WikiDocsContractTest {
    private val contract by lazy { wikiContract() }
    private val docs get() = contract.obj("docs")
    private val fixture by lazy { wikiDocsFixture().obj("docs") }
    private val zone get() = ZoneId.of(wikiDocsFixture().str("timeZone"))

    // OrbitKit's closed sets (`Models/WikiDocs.swift`), which the Kotlin port keeps as the server's raw words.
    private val statuses = setOf("ok", "needs_review")
    private val sentenceStatuses = setOf("sourced", "transition", "unsourced", "unverified", "withdrawn")
    private val footnoteKinds = listOf("design_doc", "code", "contract", "turn", "event", "tool_call", "task", "task_comment", "approval",
        "owner_decision", "merge_receipt", "note")
    private val verdicts = listOf("verified", "not_found", "no_quote", "unresolved")
    private val checkers = setOf("server", "runner")
    private val withdrawReasons = setOf("rejected", "retired", "superseded", "anchor_changed", "anchor_missing")
    private val blockKinds = setOf("paragraph", "item", "heading", "code")
    /** OrbitKit `WikiPlanSectionKind`'s cases. */
    private val sectionKinds = setOf("overview", "concepts", "flow", "interface", "data", "ops", "pitfalls", "decisions", "conventions", "other")

    // MARK: the contract

    @Test fun closedSetsAreTheContracts() {
        assertEquals(statuses, docs.obj("statuses").keys)
        assertEquals(sentenceStatuses, docs.obj("sentenceStatuses").keys)
        assertEquals(footnoteKinds.toSet(), docs.obj("footnoteKinds").keys)
        assertEquals(verdicts.toSet(), docs.obj("verdicts").keys)
        assertEquals(checkers, docs.obj("checkers").keys)
        assertEquals(withdrawReasons, docs.arr("withdrawReasons").texts.toSet())
        assertEquals(blockKinds, docs.obj("blockKinds").keys)
        // The kinds a session's transcript opens at are the records the deep link reads around.
        val records = docs.arr("recordKinds").texts.toSet()
        val opening = footnoteKinds.filter { WikiDocFootnote(1, it, "verified", sessionId = "s", recordId = "r").sessionRecord != null }
        assertEquals(listOf("turn", "event", "tool_call"), opening)
        assertTrue(records.containsAll(opening))
        // Each closed value has its words here; one a later release adds reads as unknown.
        footnoteKinds.forEach { assertNotEquals(it, "Source", WikiDocCopy.footnoteKind(it)) }
        assertEquals("Source", WikiDocCopy.footnoteKind("figure"))
        assertEquals(listOf(WikiDocLogic.Mark.UNSOURCED, WikiDocLogic.Mark.UNVERIFIED, WikiDocLogic.Mark.WITHDRAWN, null, null, null),
            listOf("unsourced", "unverified", "withdrawn", "sourced", "transition", "disputed").map { WikiDocLogic.mark(WikiDocSentence("x", it)) })
    }

    /** The owner reads on the user door; a maintenance run reads what is written and writes on the runner door, and
     * nothing on the user door writes a document. The client reads those three routes. */
    @Test fun theOwnersReadsAreOnTheUserDoor() {
        val routes = docs.obj("routes")
        val doors = contract.obj("agentSurface").obj("doors")
        val user = doors.obj("user").arr("routes").texts
        val maintenance = doors.obj("runner").arr("maintenanceRoutes").texts.toSet()
        for (name in listOf("directory", "doc", "index")) {
            val route = requireNotNull(routes.str(name)) { name }
            assertTrue("$route is not a route the user door declares", route in user)
            assertTrue(route, route.startsWith("GET "))
        }
        for (name in listOf("writerState", "write")) assertTrue(name, routes.str(name) in maintenance)
        assertFalse(user.any { it.startsWith("POST") && it.contains("/docs") })
        val asked = mutableListOf<List<String>>()
        val (auth, handle) = wikiSignedIn { path ->
            asked += path
            200 to when (path.last()) {
                "docs" -> """{"categories":[]}"""
                "doc-index" -> """{"items":[]}"""
                else -> """{"slug":"session-runtime","title":"会话运行模型与长连接","written":false}"""
            }
        }
        val client = WikiClient(auth, handle)
        runBlocking { client.docs("sp1"); client.doc("sp1", "session-runtime"); client.docIndex("sp1") }
        fun route(path: List<String>) = "GET /api/" + path.mapIndexed { i, part -> when (i) { 2 -> ":id"; 4 -> ":slug"; else -> part } }.joinToString("/")
        assertEquals(listOf("directory", "doc", "index").map { routes.str(it) }, asked.map(::route))
    }

    /** A turn's, an event's or a tool call's footnote carries its session beside its record, and the pair opens the
     * transcript at it (iOS `SessionRecordLink`); the contract says so in those words. */
    @Test fun aSessionRecordsFootnoteOpensTheTranscriptAtIt() {
        val links = requireNotNull(docs.obj("links").str("sessionRecord"))
        for (name in listOf("recordId", "sessionId", "SessionRecordLink.url(session:record:)", "around=<recordId>")) {
            assertTrue("docs.links.sessionRecord does not name $name", links.contains(name))
        }
        val footnotes = requireNotNull(DOC.decodeAs(WikiDoc.serializer()).footnotes)
        assertEquals("34WSession" to "34WTurn", footnotes[0].sessionRecord)
        assertEquals(WikiDocLogic.OpenTarget.SessionRecord("34WSession", "34WTurn"), WikiDocLogic.footnoteOpen(footnotes[0], null)?.target)
        assertEquals("a tool call opens the transcript too", "34WToolCall", footnotes[1].sessionRecord?.second)
        // A repository original, and a comment, open no transcript; a record the server could not place links nowhere.
        assertNull(footnotes[2].sessionRecord)
        assertNull(footnotes[3].sessionRecord)
        assertNull(footnotes[4].sessionRecord)
        // The page opens the pair as `orbit://session/<id>?at=<record>`: the session, at that record.
        val session = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
        val record = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"
        val nav = WikiNavRecord()
        wikiDocOpen(WikiDocLogic.OpenTarget.SessionRecord(session, record), nav.nav)
        val opened = nav.pushed.single()
        assertEquals(Destination.SESSION, opened.destination)
        assertTrue(ObjectId.same(opened.id, session))
        assertTrue(ObjectId.same(opened.recordId, record))
        // The other originals: the task, the session, the project, and the repository's host in the browser.
        wikiDocOpen(WikiDocLogic.OpenTarget.Task("t1"), nav.nav)
        wikiDocOpen(WikiDocLogic.OpenTarget.Session("s1"), nav.nav)
        wikiDocOpen(WikiDocLogic.OpenTarget.Project("p1"), nav.nav)
        wikiDocOpen(WikiDocLogic.OpenTarget.External("https://github.com/a/b/blob/c/d.go#L1"), nav.nav)
        assertEquals(listOf(OrbitRoute(Destination.TASK, "t1", origin = Origin.LINK), OrbitRoute(Destination.SESSION, "s1", origin = Origin.LINK),
            OrbitRoute(Destination.PROJECT, "p1", origin = Origin.LINK)), nav.pushed.drop(1))
        assertEquals(listOf("https://github.com/a/b/blob/c/d.go#L1"), nav.urls)
    }

    /** A document as the server answers it: its sections, sentences and their statuses, footnotes and via entries;
     * values a later server adds keep their words and read as unknown. */
    @Test fun theDocumentDecodes() {
        val doc = DOC.decodeAs(WikiDoc.serializer())
        assertEquals("1.1", doc.number)
        assertEquals("needs_review", doc.status)
        assertTrue(doc.written)
        assertEquals("c".repeat(40), doc.repoSha)
        assertEquals("1.2", doc.scopeOut?.first()?.docs?.first()?.number)
        val section = requireNotNull(doc.sections?.first())
        assertEquals(true, section.stale)
        assertEquals("flow", section.kind)
        val sentences = requireNotNull(section.blocks?.first()?.sentences)
        assertEquals(listOf("sourced", "withdrawn", "unsourced"), sentences.map { it.status })
        assertEquals("rejected", sentences[1].withdrawn?.reason)
        assertNull("an entry withdrew it, not a file", sentences[1].withdrawn?.path)
        // A sentence citing a repository file gone from origin/main names the file, and no entry.
        val byPath = """{"text":"见设计文档。","status":"withdrawn","notes":[1],"newTokens":[],"withdrawn":{"reason":"anchor_missing","entryId":null,"path":"docs/old.md","at":"2026-09-30T03:00:00.000Z"}}"""
            .decodeAs(WikiDocSentence.serializer())
        assertEquals("anchor_missing", byPath.withdrawn?.reason)
        assertEquals("docs/old.md", byPath.withdrawn?.path)
        assertNull(byPath.withdrawn?.entryId)
        assertEquals(listOf("rollbackclaim"), sentences[2].newTokens)
        assertEquals("code", section.blocks?.last()?.kind)
        val footnotes = requireNotNull(doc.footnotes)
        assertEquals(listOf("verified", "no_quote", "verified", "verified", "unresolved"), footnotes.map { it.verdict })
        assertEquals("code", footnotes[2].kind)
        assertEquals("runner", footnotes[2].checkedBy)
        assertEquals("src/runner-go/runloop.go@${"b".repeat(40)}#L398-409", footnotes[2].location)
        assertEquals("rejected", doc.entries?.first()?.status)
        assertEquals(listOf(1), doc.entries?.first()?.notes)

        val later = DOC.replace(""""status":"needs_review"""", """"status":"archived"""")
            .replace(""""kind":"code","verdict"""", """"kind":"figure","verdict"""")
            .replace(""""status":"unsourced"""", """"status":"disputed"""").decodeAs(WikiDoc.serializer())
        assertEquals("archived", later.status)
        assertFalse(later.status in statuses)
        assertEquals("figure", later.footnotes?.get(2)?.kind)
        assertEquals("Source", WikiDocCopy.footnoteKind(later.footnotes?.get(2)?.kind))
        val disputed = requireNotNull(later.sections?.first()?.blocks?.first()?.sentences?.last())
        assertEquals("disputed", disputed.status)
        assertNull(WikiDocLogic.mark(disputed))
    }

    @Test fun theDirectoryAndTheIndexDecode() {
        val directory = """{"spaceId":"34WSpace","plan":{"version":1,"confirmedAt":"2026-09-29T01:00:00.000Z"},"docs":{"total":3,"written":1},
         "categories":[{"key":"product","number":1,"title":"Product","question":"What Orbit is","forAgents":false,
           "docs":[{"slug":"session-runtime","number":"1.1","title":"会话运行模型与长连接","question":"怎么运转？","written":true,
                    "status":"ok","updatedAt":"2026-09-29T02:00:00.000Z","planVersion":1,
                    "sections":[{"key":"s1","number":1,"title":"总览","kind":"overview","written":false,"stale":false},
                                {"key":"s2","number":2,"title":"turn 投递","kind":"flow","written":true,"stale":true}]},
                   {"slug":"task-dispatch","number":"1.2","title":"任务派发","question":"怎么派发？","written":false,
                    "status":null,"updatedAt":null,"planVersion":null,"sections":[]}]},
          {"key":"dev","number":2,"title":"Development conventions","question":"How agents work here","forAgents":true,"docs":[]}]}"""
            .decodeAs(WikiDocsDirectory.serializer())
        assertEquals(1, directory.plan?.version)
        assertEquals(1, directory.docs?.written)
        val listed = requireNotNull(directory.categories.first().docs)
        assertEquals(listOf("1.1", "1.2"), listed.map { it.number })
        assertEquals(true, listed.first().sections?.last()?.stale)
        assertNull(listed.last().status)
        assertEquals(true, directory.categories.last().forAgents)
        val empty = """{"spaceId":"34WSpace","plan":null,"docs":{"total":0,"written":0},"categories":[]}""".decodeAs(WikiDocsDirectory.serializer())
        assertNull(empty.plan)
        assertFalse(WikiDocLogic.readsByDocs(empty))

        val index = """{"spaceId":"34WSpace","plan":{"version":1,"confirmedAt":null},"items":[
          {"kind":"doc","title":"会话运行模型与长连接","docSlug":"session-runtime","docNumber":"1.1","docTitle":"会话运行模型与长连接",
           "sectionKey":null,"sectionNumber":null,"category":{"key":"product","title":"Product"},"written":true},
          {"kind":"section","title":"turn 投递","docSlug":"session-runtime","docNumber":"1.1","docTitle":"会话运行模型与长连接",
           "sectionKey":"s2","sectionNumber":2,"category":{"key":"product","title":"Product"},"written":true}]}""".decodeAs(WikiDocsIndex.serializer())
        assertEquals(listOf("doc", "section"), index.items.map { it.kind })
        assertEquals(2, index.items.last().sectionNumber)
    }

    // MARK: the fixture's words

    @Test fun theWordsAreTheFixtures() {
        val words = fixture.obj("words")
        assertEquals(listOf("plan", "question", "writtenFor", "covers", "notCovered", "scopeFolded", "noSource", "notVerified", "withdrawn",
            "rewritePending", "needsReview", "nextMarked", "notWritten", "sectionNotWritten", "footnotes", "viaEntry", "noQuoteGiven", "entries",
            "openTheEntry", "notWrittenShort").map { words.str(it) },
            listOf(WikiDocCopy.plan, WikiDocCopy.question, WikiDocCopy.writtenFor, WikiDocCopy.covers, WikiDocCopy.notCovered, WikiDocCopy.scopeFolded,
                WikiDocCopy.noSource, WikiDocCopy.notVerified, WikiDocCopy.withdrawn, WikiDocCopy.rewritePending, WikiDocCopy.needsReview,
                WikiDocCopy.nextMarked, WikiDocCopy.notWritten, WikiDocCopy.sectionNotWritten, WikiDocCopy.footnotes, WikiDocCopy.viaEntry,
                WikiDocCopy.noQuoteGiven, WikiDocCopy.entries, WikiDocCopy.openTheEntry, WikiDocCopy.notWrittenShort))
        assertEquals(sectionKinds, words.obj("sectionKinds").keys)
        sectionKinds.forEach { assertEquals(it, words.obj("sectionKinds").str(it), WikiDocCopy.sectionKind(it)) }
        footnoteKinds.forEach { assertEquals(it, words.obj("footnoteKinds").str(it), WikiDocCopy.footnoteKind(it)) }
        verdicts.forEach {
            assertEquals(it, words.obj("verdictCard").str(it), WikiDocCopy.verdictCard(it))
            assertEquals(it, words.obj("verdictList").str(it), WikiDocCopy.verdictList(it))
        }
        assertEquals(listOf("excerptLinesPhone", "footnotesShown", "groupShownPhone", "browseSectionsShownPhone").map { words.num(it) },
            listOf(WikiDocCopy.excerptLinesPhone, WikiDocCopy.footnotesShown, WikiDocCopy.groupShownPhone, WikiDocCopy.browseSectionsShownPhone))
    }

    @Test fun theCountsAreTheFixtures() {
        val counts = fixture.obj("counts")
        counts.arr("moreLines").objects.forEach { assertEquals(it.str("says"), WikiDocCopy.moreLines(it.num("n")!!)) }
        counts.arr("moreSections").objects.forEach { assertEquals(it.str("says"), WikiDocCopy.moreSections(it.num("n")!!)) }
        counts.arr("entriesHint").objects.forEach { assertEquals(it.str("says"), WikiDocCopy.entriesHint(it.num("n")!!)) }
        counts.arr("seeFootnote").objects.forEach { assertEquals(it.str("says"), WikiDocCopy.seeFootnote(it.num("n")!!)) }
        counts.arr("sectionLists").objects.forEach { assertEquals(it.str("says"), WikiDocCopy.sectionList(it.arr("numbers").map { n -> n.jsonPrimitive.int })) }
        counts.arr("lineRanges").objects.forEach { assertEquals(it.str("says"), WikiDocLogic.lineRange(it.num("start"), it.num("end"))) }
        counts.arr("github").objects.forEach { assertEquals(it.str("repo") ?: "nil", it.str("says"), WikiDocLogic.githubRepo(it.str("repo"))) }
        counts.arr("monthDayTime").objects.forEach { assertEquals(it.str("says"), WikiDocCopy.monthDayTime(it.str("iso"), zone)) }
    }

    // MARK: the fixture's readings

    @Test fun aDocumentsHeadIsTheFixtures() {
        val expected = fixture.obj("doc")
        val doc = expected.obj("read").decodeAs(WikiDoc.serializer())
        assertEquals(expected.arr("tags").texts, WikiDocLogic.tags(doc))
        assertEquals(expected.arr("updated").texts, WikiDocLogic.updatedParts(doc, zone))
        assertEquals(expected.str("warn"), WikiDocLogic.updatedWarn(doc))
        assertEquals(expected.str("needsReview"), WikiDocLogic.needsReviewText(doc))
        assertEquals(expected.arr("legend").objects.map { "${it.str("mark")}:${it.str("label")}:${it.num("count")}" },
            WikiDocLogic.legend(doc).map { "${it.mark.name.lowercase()}:${it.label}:${it.count}" })
        assertEquals(expected.str("rewrite"), WikiDocLogic.rewriteNote(doc.sections.orEmpty()))
        assertEquals(expected.str("scopeCounts"), WikiDocLogic.scopeCounts(doc))
        assertEquals(expected.arr("scopeTargets").texts, doc.scopeOut.orEmpty().flatMap { line -> line.docs.orEmpty().map(WikiDocLogic::scopeTarget) })
        assertEquals(expected.str("summary"), WikiDocLogic.footnotesSummary(doc.footnotes.orEmpty()))
        assertEquals(expected.str("entriesHint"), WikiDocCopy.entriesHint(doc.entries.orEmpty().size))

        // A document under the threshold, and one no run has written.
        val fine = JsonObject(expected.obj("read") + mapOf("written" to JsonPrimitive(true), "status" to JsonPrimitive("ok"),
            "counts" to buildJsonObject { put("sentences", 40); put("sourced", 36); put("transition", 2); put("unsourced", 1); put("unverified", 1); put("withdrawn", 0) }))
            .decodeAs(WikiDoc.serializer())
        assertEquals(fixture.obj("fine").str("warn"), WikiDocLogic.updatedWarn(fine))
        assertEquals(fixture.obj("fine").arr("updated").texts, WikiDocLogic.updatedParts(fine, zone))
        val notWritten = fixture.obj("notWritten")
        assertEquals(notWritten.arr("updated").texts, WikiDocLogic.updatedParts(notWritten.obj("read").decodeAs(WikiDoc.serializer()), zone))
        notWritten.arr("notes").objects.forEach { row ->
            val counts = row["docs"] as? JsonObject
            assertEquals(row.str("says"), WikiDocLogic.notWrittenNote(counts?.num("written"), counts?.num("total")))
        }
    }

    @Test fun everyMarkedSentenceSaysWhyInTheWebsWords() {
        val doc = fixture.obj("doc").obj("read").decodeAs(WikiDoc.serializer())
        val marked = mutableListOf<String>()
        doc.sections.orEmpty().forEach { section ->
            section.blocks.orEmpty().forEachIndexed { b, block ->
                block.sentences.orEmpty().forEachIndexed { s, sentence ->
                    val mark = WikiDocLogic.mark(sentence) ?: return@forEachIndexed
                    val note = requireNotNull(WikiDocLogic.markNote(sentence, section, doc, zone))
                    marked += "${section.key}.$b.$s ${mark.name.lowercase()} ${mark.label} | ${note.title} ${note.text} | ${note.see ?: "-"} | ${note.entryId ?: "-"}"
                }
            }
        }
        assertEquals(fixture.obj("doc").arr("marks").objects.map {
            val note = it.obj("note")
            "${it.str("section")}.${it.num("block")}.${it.num("sentence")} ${it.str("mark")} ${it.str("label")} | ${note.str("title")} ${note.str("text")} | " +
                "${note.num("see") ?: "-"} | ${note.str("entryId") ?: "-"}"
        }, marked)
    }

    @Test fun everyFootnoteReadsAsTheFixtureReadsIt() {
        val expected = fixture.obj("doc")
        val doc = expected.obj("read").decodeAs(WikiDoc.serializer())
        val github = WikiDocLogic.githubRepo("github.com/jianghailong-xy/orbit")
        val entries = doc.entries.orEmpty()
        expected.arr("footnotes").objects.forEach { want ->
            val note = doc.footnotes.orEmpty().first { it.n == want.num("n") }
            val at = "[${note.n}]"
            assertEquals(at, want.str("kindLabel"), WikiDocCopy.footnoteKind(note.kind))
            assertEquals(at, want.str("sub"), WikiDocLogic.subLabel(note))
            assertEquals(at, want.getValue("isRepo").jsonPrimitive.boolean, WikiDocLogic.isRepo(note))
            assertEquals(at, want.str("verdictCard"), WikiDocCopy.verdictCard(note.verdict))
            assertEquals(at, want.str("verdictList"), WikiDocCopy.verdictList(note.verdict))
            assertEquals(at, want.str("where"), WikiDocLogic.footnoteWhere(note, zone))
            assertEquals(at, want.str("place"), WikiDocLogic.footnotePlace(note, zone))
            assertEquals(at, want.str("problem"), WikiDocLogic.footnoteProblem(note))
            assertEquals(at, want.str("quote"), note.quote?.let(WikiDocLogic::quoted))
            assertEquals(at, want.str("listQuote"), note.quote?.let(WikiDocLogic::quoted) ?: WikiDocCopy.noQuoteGiven)
            val entry = note.viaEntryId?.let { id -> entries.firstOrNull { it.id == id } }
            assertEquals(at, want.str("via"), entry?.title)
            assertEquals(at, want.str("viaStatus"), entry?.let(WikiDocLogic::viaEntryStatus))

            val open = WikiDocLogic.footnoteOpen(note, github)
            val wantOpen = want["open"] as? JsonObject
            assertEquals(at, wantOpen?.str("label"), open?.label)
            assertEquals(at, wantOpen?.obj("to")?.let(::described), open?.target?.let(::described))

            val excerpt = if (note.kind != "design_doc" && WikiDocLogic.isRepo(note) && note.excerpt != null)
                WikiDocLogic.excerptLines(note, WikiDocCopy.excerptLinesPhone) else null
            val wantExcerpt = want["excerpt"] as? JsonObject
            assertEquals(at, wantExcerpt?.arr("lines")?.objects?.map { "${it.num("n")} ${it.getValue("quoted").jsonPrimitive.boolean} ${it.str("text")}" },
                excerpt?.first?.map { "${it.n} ${it.quoted} ${it.text}" })
            assertEquals(at, wantExcerpt?.num("more"), excerpt?.second)
        }
        // Every footnote the fixture reads is one of the document's.
        assertEquals(expected.arr("footnotes").objects.map { it.num("n") }, doc.footnotes.orEmpty().map { it.n })
    }

    private fun described(to: JsonObject): List<String?> = when (to.str("kind")) {
        "sessionRecord" -> listOf("sessionRecord", to.str("session"), to.str("record"))
        "external" -> listOf("external", to.str("url"))
        else -> listOf(to.str("kind"), to.str("id"))
    }

    private fun described(target: WikiDocLogic.OpenTarget): List<String?> = when (target) {
        is WikiDocLogic.OpenTarget.SessionRecord -> listOf("sessionRecord", target.session, target.record)
        is WikiDocLogic.OpenTarget.External -> listOf("external", target.url)
        is WikiDocLogic.OpenTarget.Task -> listOf("task", target.id)
        is WikiDocLogic.OpenTarget.Session -> listOf("session", target.id)
        is WikiDocLogic.OpenTarget.Project -> listOf("project", target.id)
    }

    @Test fun theEntriesUnderTheDocumentAreTheFixtures() {
        val expected = fixture.obj("doc")
        val doc = expected.obj("read").decodeAs(WikiDoc.serializer())
        val groups = WikiDocLogic.entryGroups(doc.entries.orEmpty())
        val wanted = expected.arr("entryGroups").objects
        assertEquals(wanted.map { it.str("title") }, groups.map { it.title })
        assertEquals(wanted.map { it.str("note") }, groups.map { it.note })
        assertEquals(wanted.map { it.arr("ids").texts }, groups.map { group -> group.entries.map { it.id } })
        expected.arr("viaNotes").objects.forEach { want ->
            val entry = doc.entries.orEmpty().first { it.id == want.str("id") }
            assertEquals(entry.id, want.str("note"), WikiDocLogic.viaEntryNote(entry, doc))
            assertEquals(entry.id, want.str("status"), WikiDocLogic.viaEntryStatus(entry))
        }
    }

    @Test fun theDirectoryBrowseAndIndexAreTheFixtures() {
        val directory = fixture.obj("directory")
        val read = directory.obj("read").decodeAs(WikiDocsDirectory.serializer())
        assertEquals(directory.getValue("readsByDocs").jsonPrimitive.boolean, WikiDocLogic.readsByDocs(read))
        assertFalse(WikiDocLogic.readsByDocs(null))
        val groups = WikiDocLogic.directoryGroups(read)
        val wanted = directory.arr("groups").objects
        assertEquals(wanted.map { it.str("key") }, groups.map { it.key })
        assertEquals(wanted.map { it.num("number") }, groups.map { it.number })
        assertEquals(wanted.map { it.str("title") }, groups.map { it.title })
        groups.zip(wanted).forEach { (group, want) ->
            val docs = want.arr("docs").objects
            assertEquals(docs.map { "${it.str("slug")} ${it.str("number")} ${it.str("title")} ${it.bool("written")} ${it.bool("needsReview")}" },
                group.docs.map { "${it.slug} ${it.number} ${it.title} ${it.written} ${it.needsReview}" })
            assertEquals(docs.map { doc -> doc.arr("sections").objects.map { "${it.str("key")} ${it.num("number")} ${it.str("title")} ${it.bool("written")} ${it.bool("stale")}" } },
                group.docs.map { doc -> doc.sections.map { "${it.key} ${it.number} ${it.title} ${it.written} ${it.stale}" } })
        }

        val browse = fixture.obj("browse")
        assertEquals(browse.arr("summary").texts, WikiDocLogic.browseSummary(read))
        val categories = read.categories.filter { it.docs.orEmpty().isNotEmpty() }
        val wantedCategories = browse.arr("categories").objects
        assertEquals(wantedCategories.map { it.str("key") }, categories.map { it.key })
        categories.zip(wantedCategories).forEach { (category, want) ->
            assertEquals(want.str("line"), WikiDocLogic.categoryLine(category))
            assertEquals(want.arr("docs").objects.map { doc ->
                val state = doc["state"] as? JsonObject
                "${doc.str("slug")} ${doc.str("sections")} ${state?.let { "${it.str("text")}/${it.str("tone")}" } ?: "-"}"
            }, category.docs.orEmpty().map { doc ->
                val line = WikiDocLogic.docLine(doc)
                "${doc.slug} ${line.first} ${line.second?.let { "${it.text}/${it.tone}" } ?: "-"}"
            })
        }
        assertEquals(browse.num("shownPhone"), WikiDocCopy.browseSectionsShownPhone)

        val index = fixture.obj("index")
        val items = index.arr("items").decodeAs(ListSerializer(WikiDocsIndex.Item.serializer()))
        assertEquals(index.str("summary"), WikiDocLogic.indexSummary(items))
        val letters = WikiDocLogic.indexGroups(items)
        val wantedLetters = index.arr("groups").objects
        assertEquals(wantedLetters.map { it.str("letter") }, letters.map { it.letter })
        letters.zip(wantedLetters).forEach { (group, want) ->
            assertEquals(group.letter, want.arr("rows").objects.map { "${it.str("title")} | ${it.str("kind")} | ${it.str("meta")}" },
                group.items.map { "${it.title} | ${it.kind} | ${WikiDocLogic.indexMeta(it)}" })
        }
    }

    // MARK: the orders

    @Test fun theOrdersAreTheFixtures() {
        val orders = fixture.obj("orders")
        assertEquals(orders.arr("docSections").texts, WikiDocLogic.Section.entries.map { it.raw })
        assertEquals(orders.arr("footnoteCard").texts, WikiDocLogic.CardPart.entries.map { it.raw })
    }

    private fun JsonObject.bool(key: String): Boolean? = (get(key) as? JsonPrimitive)?.booleanOrNull

    companion object {
        internal const val DOC = """{"spaceId":"34WSpace","slug":"session-runtime","number":"1.1","title":"会话运行模型与长连接","question":"怎么运转？",
     "audience":["A new developer"],"scopeIn":["Delivery"],
     "scopeOut":[{"text":"任务怎么派发","docs":[{"slug":"task-dispatch","number":"1.2","title":"任务派发"}]}],
     "category":{"key":"product","number":1,"title":"Product"},"length":{"min":800,"max":4000},
     "planVersion":2,"written":true,"status":"needs_review","writtenFromPlanVersion":1,
     "repoSha":"cccccccccccccccccccccccccccccccccccccccc","updatedAt":"2026-09-29T02:00:00.000Z",
     "counts":{"sentences":3,"sourced":1,"transition":0,"unsourced":1,"unverified":0,"withdrawn":1},"unsourcedShare":0.3333,
     "sections":[{"key":"s2","number":2,"title":"turn 投递","kind":"flow","written":true,"stale":true,
                  "staleAt":"2026-09-29T03:00:00.000Z","generatedAt":"2026-09-29T02:00:00.000Z",
                  "repoSha":"cccccccccccccccccccccccccccccccccccccccc","model":"qwen3.8-27b-fp8",
                  "blocks":[{"kind":"paragraph","text":null,"sentences":[
                              {"text":"Runner 从 inbox 领取 turn。","status":"sourced","notes":[1,3],"newTokens":[],"withdrawn":null},
                              {"text":"长命令交给 bg_run。","status":"withdrawn","notes":[2],"newTokens":[],
                               "withdrawn":{"reason":"rejected","entryId":"34WEntry","at":"2026-09-29T03:00:00.000Z"}},
                              {"text":"失败时由 `rollbackClaim` 回滚。","status":"unsourced","notes":[],"newTokens":["rollbackclaim"],"withdrawn":null}]},
                            {"kind":"code","text":"orbit wiki docs build","sentences":[]}]}],
     "footnotes":[
       {"n":1,"kind":"turn","verdict":"verified","checkedBy":"server","quote":"先存后投","location":"turn:0190-turn#c0-4",
        "recordId":"34WTurn","charStart":0,"charEnd":4,"sessionId":"34WSession","sessionTitle":"执行任务","seq":4,
        "at":"2026-09-15T07:37:00.000Z","label":"message","viaEntryId":"34WEntry"},
       {"n":2,"kind":"tool_call","verdict":"no_quote","checkedBy":"server","quote":null,"location":"tool_call:0190-call",
        "recordId":"34WToolCall","sessionId":"34WSession","label":"Bash"},
       {"n":3,"kind":"code","verdict":"verified","checkedBy":"runner","quote":"func claimRetryDelayAfter(",
        "location":"src/runner-go/runloop.go@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb#L398-409",
        "path":"src/runner-go/runloop.go","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","lineStart":398,"lineEnd":409,
        "symbol":"claimRetryDelayAfter()","excerpt":"func claimRetryDelayAfter(failures int) time.Duration {","recordId":null,"sessionId":null},
       {"n":4,"kind":"task_comment","verdict":"verified","checkedBy":"server","quote":"6 个新文件","location":"task_comment:0190-c",
        "recordId":"34WComment","sessionId":null,"taskId":"34WTask","taskTitle":"阶段 2 runner 托管"},
       {"n":5,"kind":"event","verdict":"unresolved","checkedBy":"server","quote":"nobody has it","location":"event:0190-x",
        "recordId":"34WMissing","sessionId":null}],
     "entries":[{"id":"34WEntry","kind":"concept","title":"先存后投","status":"rejected","trust":"unreviewed","anchorState":"unchecked","notes":[1]}]}"""
    }
}
