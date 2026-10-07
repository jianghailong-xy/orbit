package io.orbitd.android.wiki

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.NetworkException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit `WikiPlanCopyParityTests`, its fixture half: the `plan` cases of `src/shared/src/wiki-docs.fixture.json`, which
 * the web's `lib/wikiPlan.test.ts` and OrbitKit read too — every state of the plan with its banner, job card, head, gate
 * report and documents; the version menu; a document's and a section's pages; the changes proposed and what Accept will
 * do; an edit's request in the draft's shape; the words, the counts and the orders. The halves that read the web's and
 * the native pages' sources are OrbitKit's alone. */
class WikiPlanFixtureTest {
    private val shared get() = WikiPlanFixture.shared
    private val plan get() = WikiPlanFixture.plan
    private val zone get() = WikiPlanFixture.zone
    private val now get() = WikiPlanFixture.now
    private val proposals get() = WikiPlanFixture.proposals
    private fun version(key: String) = WikiPlanFixture.version(key)
    private fun state(spec: JsonObject) = WikiPlanFixture.state(spec)
    private fun JsonElement?.textOrDash() = this.text() ?: "-"

    // MARK: the words

    @Test fun theWordsAreTheFixtures() {
        val words = plan.obj("words")
        val pairs = listOf(
            WikiPlanCopy.title to "title", WikiPlanCopy.redraft to "redraft", WikiPlanCopy.confirm to "confirm", WikiPlanCopy.draft to "draft",
            WikiPlanCopy.open to "open", WikiPlanCopy.edit to "edit", WikiPlanCopy.accept to "accept", WikiPlanCopy.reject to "reject",
            WikiPlanCopy.cancel to "cancel", WikiPlanCopy.viewRun to "viewRun", WikiPlanCopy.setUp to "setUp",
            WikiPlanCopy.viewRunners to "viewRunners", WikiPlanCopy.none to "none", WikiPlanCopy.emptyTitle to "emptyTitle",
            WikiPlanCopy.documents to "documents", WikiPlanCopy.inForce to "inForce", WikiPlanCopy.queued to "queued",
            WikiPlanCopy.drafting to "drafting", WikiPlanCopy.held to "held", WikiPlanCopy.failed to "failed", WikiPlanCopy.passed to "passed",
            WikiPlanCopy.writing to "writing", WikiPlanCopy.writingNow to "writingNow", WikiPlanCopy.jobFailed to "jobFailed",
            WikiPlanCopy.buildFailed to "buildFailed", WikiPlanCopy.question to "question", WikiPlanCopy.writtenFor to "writtenFor",
            WikiPlanCopy.covers to "covers", WikiPlanCopy.notCovered to "notCovered", WikiPlanCopy.length to "length",
            WikiPlanCopy.protected to "protected", WikiPlanCopy.drawsOn to "drawsOn", WikiPlanCopy.sections to "sections",
            WikiPlanCopy.sourceDocs to "sourceDocs", WikiPlanCopy.sourceCode to "sourceCode", WikiPlanCopy.sourceContracts to "sourceContracts",
            WikiPlanCopy.sourceSessions to "sourceSessions", WikiPlanCopy.sessionProjects to "sessionProjects",
            WikiPlanCopy.sessionTime to "sessionTime", WikiPlanCopy.sessionKeywords to "sessionKeywords",
            WikiPlanCopy.sessionAnchors to "sessionAnchors", WikiPlanCopy.sessionKinds to "sessionKinds",
            WikiPlanCopy.sessionTopics to "sessionTopics", WikiPlanCopy.sessionEvidence to "sessionEvidence", WikiPlanCopy.found to "found",
            WikiPlanCopy.notFound to "notFound", WikiPlanCopy.changes to "changes", WikiPlanCopy.proposedBy to "proposedBy",
            WikiPlanCopy.why to "why", WikiPlanCopy.change to "change", WikiPlanCopy.sources to "sources", WikiPlanCopy.from to "from",
            WikiPlanCopy.check to "check", WikiPlanCopy.changeRejected to "changeRejected", WikiPlanCopy.redraftAsked to "redraftAsked",
            WikiPlanCopy.redraftAlready to "redraftAlready", WikiPlanCopy.acceptRefused to "acceptRefused",
            WikiPlanCopy.redraftTitle to "redraftTitle", WikiPlanCopy.redraftGo to "redraftGo",
            WikiPlanCopy.redraftPlaceholder to "redraftPlaceholder", WikiPlanCopy.editTitleField to "editTitleField",
            WikiPlanCopy.editKind to "editKind", WikiPlanCopy.protectedSwitch to "protectedSwitch", WikiPlanCopy.addSection to "addSection",
            WikiPlanCopy.saveDraft to "saveDraft", WikiPlanCopy.protectedNote to "protectedNote",
            WikiPlanCopy.notProtectedNote to "notProtectedNote",
        )
        pairs.forEach { (ours, key) -> assertEquals(key, words.str(key), ours) }
        // Every word the fixture names that is a plain sentence is one of ours.
        val named = pairs.map { it.second }.toSet()
        val missing = words.filter { (key, value) -> value is JsonPrimitive && value.isString && key !in named }.keys
        assertTrue("the fixture says words this port does not: $missing", missing.isEmpty())
        assertEquals(WikiPlanCopy.refsShownPhone, words.int("refsShownPhone"))
        assertEquals(WikiPlanCopy.factsShown, words.int("factsShown"))
        assertEquals(WikiPlanCopy.newSectionLength, words.int("newSectionLength"))
        val statuses = words.obj("statusLabels")
        WikiPlanLogic.ShownStatus.entries.forEach { assertEquals(it.name, statuses.str(it.name.lowercase()), it.label) }
        val ops = words.obj("opLabels")
        WikiPlanLogic.ChangeOp.entries.forEach { assertEquals(it.name, ops.str(camel(it.name)), it.label) }
        val titles = words.obj("gateTitles")
        listOf("schema", "docCount", "protected", "references").forEach { assertEquals(it, titles.str(it), WikiPlanLogic.gateTitle(it)) }
        assertEquals(words.strings("gateOrder"), WikiPlanLogic.gateOrder)
        val held = words.obj("heldText"); val buildHeld = words.obj("buildHeldText")
        assertEquals("the reasons a job is held are the web's three", held.keys, WikiPlanLogic.Held.entries.map { it.name.lowercase() }.toSet())
        WikiPlanLogic.Held.entries.forEach { reason ->
            assertEquals(reason.name, held.str(reason.name.lowercase()), WikiPlanLogic.heldText(reason))
            assertEquals(reason.name, buildHeld.str(reason.name.lowercase()), WikiPlanLogic.buildHeldText(reason))
        }
        // Owner's call 2026-09-29: a job is never held for the daily limit.
        val said = (held.values + buildHeld.values).joinToString(" ") { it.jsonPrimitive.content }.lowercase()
        assertFalse(said.contains("daily") || said.contains("limit"))
    }

    @Test fun theCountsAreTheFixtures() {
        val counts = plan.obj("counts")
        fun rows(key: String) = counts.arr(key).map { it.jsonObject }
        rows("chars").forEach { row -> val length = row.obj("length")
            assertEquals(row.str("says"), WikiPlanCopy.chars(WikiPlanRange(length.int("min"), length.int("max")))) }
        rows("sectionChars").forEach { assertEquals(it.str("says"), WikiPlanCopy.sectionChars(it.int("n"))) }
        rows("errors").forEach { assertEquals(it.str("says"), WikiPlanCopy.errorCount(it.int("n"))) }
        rows("changesCount").forEach { assertEquals(it.str("says"), WikiPlanCopy.changeCount(it.int("n"))) }
        rows("time").forEach { assertEquals(it.str("says"), WikiPlanCopy.time(it["since"].text(), it["until"].text())) }
        rows("redraftNotes").forEach { row ->
            val from = (row["from"] as? JsonObject)?.let { it.int("version") to (it["inForce"].bool() == true) }
            assertEquals(row.str("says"), WikiPlanCopy.redraftNote(row["provider"].text(), from))
        }
        rows("protectedKept").forEach { assertEquals(it.str("says"), WikiPlanCopy.protectedKept(it.strings("numbers"))) }
        rows("emptyText").forEach { assertEquals(it.str("says"), WikiPlanCopy.emptyText(it["provider"].text())) }
        rows("emptyNote").forEach { assertEquals(it.str("says"), WikiPlanCopy.emptyNote(it["where"].text(), it["provider"].text())) }
        rows("saveNote").forEach { assertEquals(it.str("says"), WikiPlanCopy.saveNote(it.int("n"))) }
        rows("editTitle").forEach { assertEquals(it.str("says"), WikiPlanCopy.editTitle(it.str("number"))) }
        rows("confirmed").forEach { assertEquals(it.str("says"), WikiPlanCopy.confirmed(it.int("n"))) }
        rows("changeAdded").forEach { assertEquals(it.str("says"), WikiPlanCopy.changeAdded(it.int("n"))) }
        rows("draftSaved").forEach { assertEquals(it.str("says"), WikiPlanCopy.draftSaved(it.int("n"))) }
        rows("andMore").forEach { assertEquals(it.str("says"), WikiPlanCopy.andMore(it.int("n"))) }
        rows("failedHint").forEach { assertEquals(it.str("says"), WikiPlanCopy.failedHint(it["inForce"].integer())) }
    }

    // MARK: the readings

    /** Every state: the home's look and banner, the page's version and head, its job, its gate, its documents. */
    @Test fun everyStateIsTheFixtures() {
        val states = plan.obj("states")
        val directory = WikiPlanFixture.directory
        assertEquals(13, states.size)
        states.keys.sorted().forEach { name ->
            val expected = states.obj(name)
            val spec = expected.obj("spec")
            val state = state(spec)
            val online = spec["runnerOnline"].bool()
            val look = WikiPlanLogic.look(state, online)
            assertEquals(name, expected["look"].text(), look?.let { camel(it.name) })
            assertEquals(name, expected.int("pending"), WikiPlanLogic.pending(state, online))
            assertEquals(name, expected["open"].text(), WikiPlanLogic.openJob(state)?.id)
            assertEquals(name, expected["build"].text(), WikiPlanLogic.buildJob(state)?.id)
            assertEquals(name, expected["failed"].text(), WikiPlanLogic.failedJob(state)?.id)
            assertEquals(name, expected.int("nextVersion"), WikiPlanLogic.nextVersion(state))
            assertEquals(name, expected["acceptConfirms"].bool(), WikiPlanLogic.acceptConfirms(state))

            val docs = if (state.confirmed != null) 3 to 5 else null
            val banner = look?.let { WikiPlanLogic.banner(it, state, now, docs, online) }
            assertEquals(name, (expected["banner"] as? JsonObject)?.let { "${it.str("text")} | ${it.str("tone")} | ${it.str("to")}" },
                banner?.let { "${it.text} | ${if (it.amber) "amber" else "blue"} | ${if (it.toSettings) "settings" else "plan"}" })

            val shown = WikiPlanLogic.defaultShown(state)
            assertEquals(name, (expected["shown"] as? JsonObject)?.let { "v${it.int("version")} ${it.str("status")} ${it.str("label")} ${it.str("statusLabel")}" },
                shown?.let { "v${it.version} ${it.status.name.lowercase()} ${WikiPlanCopy.versionLabel(it.version)} ${it.status.label}" })
            val open = WikiPlanLogic.openJob(state)
            val failed = WikiPlanLogic.failedJob(state)
            val inForce = shown?.status == WikiPlanLogic.ShownStatus.CONFIRMED && state.confirmed?.version == shown.version
            assertEquals(name, expected["head"].text(), if (shown == null) open?.let { WikiPlanLogic.jobHead(it, zone) } else null)
            assertEquals(name, (expected["meta"] as? JsonArray)?.map { it.jsonPrimitive.content },
                shown?.let { WikiPlanLogic.meta(it, if (it.status == WikiPlanLogic.ShownStatus.FAILED) failed else (open ?: state.job), if (inForce) docs else null, zone) })
            assertEquals(name, expected["hint"].text(),
                if (shown?.status == WikiPlanLogic.ShownStatus.FAILED) WikiPlanCopy.failedHint(state.confirmed?.version) else null)

            val card = WikiPlanLogic.jobCard(state.job, now, online, if (shown?.status == WikiPlanLogic.ShownStatus.FAILED) failed else null,
                inForce, if (state.confirmed != null) directory else null)
            val wantCard = expected["jobCard"] as? JsonObject
            assertEquals(name, wantCard?.let { "${it.str("look")} | ${it.str("title")} | ${it.str("text")}" },
                card?.let { "${it.look.name.lowercase()} | ${it.title} | ${it.text}" })
            assertEquals(name, (wantCard?.get("link") as? JsonObject)?.let { "${it.str("label")} ${it.str("to")} ${it["sessionId"].textOrDash()}" },
                card?.link?.let { "${it.label} ${it.to.name.lowercase()} ${it.sessionId ?: "-"}" })
            assertEquals(name, (wantCard?.get("progress") as? JsonObject)?.let { "${it.int("done")}/${it.int("total")} ${it["now"].textOrDash()}" },
                card?.progress?.let { "${it.done}/${it.total} ${it.now ?: "-"}" })

            if (shown != null && (shown.status == WikiPlanLogic.ShownStatus.DRAFT || shown.status == WikiPlanLogic.ShownStatus.FAILED)) {
                val gate = WikiPlanLogic.gate(shown, WikiPlanLogic.base(shown, state), if (shown.status == WikiPlanLogic.ShownStatus.FAILED) failed else state.job)
                val want = expected["gate"] as? JsonObject ?: throw AssertionError("$name has no gate")
                assertEquals(name, listOf(if (want["passed"].bool() == true) "passed" else "failed", want.str("title"), want.str("line"), want["aside"].textOrDash()),
                    listOf(if (gate.passed) "passed" else "failed", gate.title, gate.line, gate.aside ?: "-"))
                assertEquals(name, want.arr("rows").map { it.jsonObject }.map { "${it.str("check")} ${it["ok"].bool()} ${it.str("title")}: ${it.str("text")}" },
                    gate.rows.map { "${it.check} ${it.ok} ${it.title}: ${it.text}" })
                assertEquals(name, want.strings("refKinds"), gate.refKinds)
                assertEquals(name, want.arr("refs").map { it.jsonObject }.map { "${it.str("where")} | ${it.str("kind")} | ${it.str("ref")} | ${it.str("why")}" },
                    gate.refs.map { "${it.where} | ${it.kind} | ${it.ref} | ${it.why}" })
            } else assertTrue(name, expected["gate"] == null || expected["gate"] is JsonNull)

            val categories = shown?.categories.orEmpty()
            val wantCategories = expected.arr("categories").map { it.jsonObject }
            assertEquals(name, wantCategories.map { "${it.str("key")} ${it.int("number")} ${it.str("title")} ${it.str("line")}" },
                categories.map { "${it.key} ${it.number} ${it.title} ${WikiPlanLogic.categoryLine(it)}" })
            categories.zip(wantCategories).forEach { (category, want) ->
                assertEquals(name, want.arr("docs").map { it.jsonObject }.map {
                    "${it.str("slug")} ${it.str("number")} ${it.str("title")} ${it["protected"].bool()} ${it.int("errors")} ${it["errorLabel"].textOrDash()} ${it.str("line")}"
                }, category.docs.map { doc ->
                    val errors = WikiPlanLogic.docErrors(shown!!, doc).size
                    "${doc.slug} ${doc.number} ${doc.title} ${doc.protected} $errors ${if (errors > 0) WikiPlanCopy.errorCount(errors) else "-"} ${WikiPlanLogic.docLine(doc)}"
                })
            }
        }
    }

    @Test fun theVersionMenuIsTheFixtures() {
        val rows = plan.obj("versionRows")
        val failed = rows.obj("failed")
        val ours = WikiPlanLogic.versionRows(rows.arr("versions").decode(ListSerializer(WikiPlanVersionSummary.serializer())),
            failed.int("version") to failed["at"].text(), zone)
        assertEquals(rows.arr("rows").map { it.jsonObject }.map { "v${it.int("version")} ${it.str("status")} ${it.str("note")}" },
            ours.map { "v${it.version} ${it.status.name.lowercase()} ${it.note}" })
    }

    /** A document's and a section's pages of the failed draft and of the version in force. */
    @Test fun aDocumentsAndASectionsPagesAreTheFixtures() {
        plan.arr("docPages").map { it.jsonObject }.forEach { expected ->
            val state = state(plan.obj("states").obj(if (expected.int("version") == 1) "inForce" else "draftFailed").obj("spec"))
            val shown = WikiPlanLogic.defaultShown(state)!!
            val base = WikiPlanLogic.base(shown, state)
            val doc = shown.docs.first { it.slug == expected.str("slug") }
            val at = "v${expected.int("version")} ${expected.str("slug")}"
            val errors = WikiPlanLogic.docErrors(shown, doc).size
            assertEquals(at, listOf(expected.str("title"), expected.str("number"), "${expected["protected"].bool()}"), listOf(doc.title, doc.number, "${doc.protected}"))
            assertEquals(at, expected.strings("head"), listOf("${WikiPlanCopy.versionLabel(shown.version)} · ${shown.status.label}") +
                (if (errors > 0) listOf(WikiPlanCopy.errorCount(errors)) else emptyList()) + WikiPlanLogic.docLine(doc))
            assertEquals(at, expected.str("length"), WikiPlanCopy.chars(doc.length))
            assertEquals(at, expected.str("protectedNote"), if (doc.protected) WikiPlanCopy.protectedNote else WikiPlanCopy.notProtectedNote)
            assertEquals(at, expected.str("drawsOn"), WikiPlanLogic.drawsOn(doc))
            val numbers = LinkedHashMap<String, String>().apply { shown.docs.forEach { putIfAbsent(it.slug, it.number) } }
            assertEquals(at, expected.arr("scopeOut").map { it.jsonObject }.map { "${it.str("text")} ${it.strings("see")}" },
                doc.scopeOut.map { out -> "${out.text} ${out.docs.map { "→ ${numbers[it] ?: it}" }}" })
            val sections = expected.arr("sections").map { it.jsonObject }
            assertEquals(at, sections.size, doc.sections.size)
            doc.sections.zip(sections).forEachIndexed { index, (section, want) ->
                val where = "$at §${want.int("n")}"
                assertEquals(where, listOf(want.str("title"), want.str("line"), want.str("meta")),
                    listOf(section.title, WikiPlanLogic.sectionLine(section), WikiPlanLogic.sectionMeta(shown, section)))
                val sources = want.obj("sources")
                fun found(element: JsonElement?) = element.bool()?.toString() ?: "-"
                assertEquals(where, sources.arr("docs").map { it.jsonObject }.map { "${it.str("path")} ${it["section"].textOrDash()} ${found(it["found"])}" },
                    section.sources.docs.mapIndexed { k, s -> "${s.path} ${s.section ?: "-"} ${WikiPlanLogic.sourceFound(shown, doc, index, "docs", k)?.toString() ?: "-"}" })
                assertEquals(where, sources.arr("code").map { it.jsonObject }.map { "${it.str("path")} ${it.strings("symbols")} ${found(it["found"])}" },
                    section.sources.code.mapIndexed { k, s -> "${s.path} ${s.symbols} ${WikiPlanLogic.sourceFound(shown, doc, index, "code", k)?.toString() ?: "-"}" })
                assertEquals(where, sources.arr("contracts").map { it.jsonObject }.map { "${it.str("path")} ${found(it["found"])}" },
                    section.sources.contracts.mapIndexed { k, path -> "$path ${WikiPlanLogic.sourceFound(shown, doc, index, "contracts", k)?.toString() ?: "-"}" })
                val wantSessions = sources["sessions"] as? JsonObject
                assertEquals(where, wantSessions?.let { s -> listOf(s.arr("projects").joinToString(",") { it.text() ?: "" }, s.str("time"),
                    s.strings("keywords").joinToString(","), s.strings("anchorPaths").joinToString(","), s.str("entryKinds"), s.str("topics"), s.str("evidence")) },
                    section.sources.sessions?.let { s -> listOf(s.projects.joinToString(",") { it.title }, WikiPlanCopy.time(s.since, s.until),
                        s.keywords.joinToString(","), s.anchorPaths.joinToString(","), s.entryKinds.joinToString(" · "), s.topics.joinToString(" · "), s.evidence) })
            }
            assertEquals(at, expected.arr("lost").map { it.jsonObject }.map { "${it.int("number")} ${it.str("label")} | ${it.str("why")}" },
                WikiPlanLogic.lostSections(shown, base, doc.slug).map {
                    "${it.number} ${WikiPlanCopy.lostLabel(base?.version ?: 0, it.number, it.title)} | ${WikiPlanCopy.protectedMovePhone(it.movedTo, doc.number)}"
                })
        }
    }

    @Test fun theChangesProposedAreTheFixtures() {
        val base = WikiPlanLogic.fromVersion(version("v1"))
        val titles = mapOf("pr9" to "Codex 账号代管")
        val states = plan.obj("states")
        plan.arr("changes").map { it.jsonObject }.forEach { expected ->
            val id = expected.str("proposal")
            val proposal = proposals.first { it.id == id }
            val change = WikiPlanLogic.change(proposal, base)
            assertEquals(id, listOf(expected.str("op"), expected.str("opLabel"), expected.str("target"), expected.str("title"), expected["renumber"].textOrDash()),
                listOf(camel(change.op.name), change.op.label, change.target, change.title, change.renumber ?: "-"))
            assertEquals(id, expected.arr("rows").map { it.jsonObject }.map { "${it.str("mark")} ${it.str("n")} ${it.str("title")} ${it.str("note")}" },
                change.rows.map { "${it.mark.name.lowercase()} ${it.n} ${it.title} ${it.note}" })
            assertEquals(id, expected.strings("sources"), change.added.flatMap { WikiPlanLogic.sourceLines(it.sources) { p -> titles[p] } })
            val facts = proposal.facts.orEmpty()
            assertEquals(id, expected.strings("facts"), facts.take(WikiPlanCopy.factsShown).map { it.id })
            assertEquals(id, expected["more"].text(), if (facts.size > WikiPlanCopy.factsShown) WikiPlanCopy.andMore(facts.size - WikiPlanCopy.factsShown) else null)
            assertEquals(id, expected.str("acceptNote"), WikiPlanLogic.acceptNote(state(states.obj("changes").obj("spec")), change.op))
            assertEquals(id, expected.str("acceptNoteWithDraft"), WikiPlanLogic.acceptNote(state(states.obj("draftReady").obj("spec")), change.op))
        }
    }

    /** An edit goes in the draft's shape: no ids or positions, a session condition's projects by id — the same request
     * the web sends for the same form. */
    @Test fun anEditIsSentInTheDraftsShape() {
        val edit = plan.obj("edit")
        val stored = edit.obj("stored").decode(WikiPlanDoc.serializer())
        assertEquals(WikiPlanDocInput.read(edit.obj("input")), WikiPlanLogic.docInput(stored))
        val form = edit.obj("form")
        val length = form.obj("length")
        val docForm = WikiPlanLogic.DocForm(form.str("title"), form.str("question"), form.strings("audience"), form.strings("scopeIn"),
            WikiPlanRange(length.int("min"), length.int("max")), form["protected"].bool() == true,
            form.arr("sections").map { it.jsonObject }.map { WikiPlanLogic.DocForm.Section(it["key"].text(), it.str("title"), it.str("kind")) })
        val body = WikiPlanLogic.docEditBody(2, stored.slug, WikiPlanLogic.docEdit(stored, docForm))
        val want = edit.obj("body")
        assertEquals(want.int("baseVersion"), body.int("baseVersion"))
        assertEquals(want.str("docSlug"), body.str("docSlug"))
        assertEquals(WikiPlanDocInput.read(want.obj("doc")), WikiPlanDocInput.read(body.obj("doc")))
        val sectionEdit = edit.obj("section")
        val section = stored.sections!![sectionEdit.int("index")]
        val sectionForm = sectionEdit.obj("form")
        val sectionBody = WikiPlanLogic.sectionEditBody(2, stored.slug, section, sectionForm.str("title"), sectionForm.str("kind"),
            sectionForm.str("covers"), sectionForm.int("length"))
        val wantSection = sectionEdit.obj("body")
        assertEquals(listOf(wantSection.str("docSlug"), wantSection["sectionKey"].textOrDash()), listOf(sectionBody.str("docSlug"), sectionBody["sectionKey"].textOrDash()))
        assertEquals(WikiPlanSectionInput.read(wantSection.obj("section")), WikiPlanSectionInput.read(sectionBody.obj("section")))
        // What goes over the wire carries no read-back ids, and names projects by id.
        val wire = body.toString()
        assertFalse(wire, wire.contains("\"id\"") || wire.contains("\"position\""))
        assertTrue(wire, wire.contains("\"projects\":[\"pr3\"]"))
    }

    /** A refusal of the gate reads as its errors; any other failure as none. */
    @Test fun theGatesRefusalIsReadForItsErrors() {
        val body = """{"code":"WIKI_PLAN_GATE","message":"1 error","errors":[{"check":"references","path":"plan.docs[0]","message":"no such file"}]}"""
        assertEquals(listOf("no such file"), wikiGateErrors(ApiError.parse(422, body.encodeToByteArray()))?.map { it.message })
        assertNull(wikiGateErrors(ApiError.parse(409, """{"code":"WIKI_PLAN_STALE","message":"stale"}""".encodeToByteArray())))
        assertNull(wikiGateErrors(NetworkException()))
        // Any other refusal is the server's own sentence, or the web's fallback.
        assertEquals("stale", wikiRefusal(ApiError.parse(409, """{"code":"WIKI_PLAN_STALE","message":"stale"}""".encodeToByteArray())))
        assertEquals(WikiCopy.refused, wikiRefusal(NetworkException()))
    }

    /** A failed job's draft the model wrote in a shape this build cannot read is dropped, never the plan's read with it. */
    @Test fun aMalformedFailedDraftDoesNotFailTheRead() {
        val state = WikiPlanState.decode(Json.parseToJsonElement(
            """{"spaceId":"sp1","confirmed":null,"draft":null,"proposals":[],"job":{"id":"j","kind":"revise","state":"failed","draft":{"categories":"nope","docs":7}}}"""))
        assertEquals("failed", state.job?.state)
        assertNull(state.job?.draft)
        assertNull(WikiPlanLogic.defaultShown(state))
    }

    // MARK: the orders

    @Test fun theOrdersAreTheFixtures() {
        val orders = plan.obj("orders")
        assertEquals(orders.strings("page"), WikiPlanLogic.PageSection.entries.map { camel(it.name) })
        assertEquals(orders.strings("doc"), WikiPlanLogic.DocSection.entries.map { camel(it.name) })
        assertEquals(orders.strings("section"), WikiPlanLogic.SectionSection.entries.map { camel(it.name) })
        assertEquals(orders.strings("change"), WikiPlanLogic.ChangePart.entries.map { camel(it.name) })
        assertEquals(orders.strings("looks"), WikiPlanLogic.Look.entries.map { camel(it.name) })
    }
}
