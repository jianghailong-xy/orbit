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
        val words = plan.fobj("words")
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
        pairs.forEach { (ours, key) -> assertEquals(key, words.fstr(key), ours) }
        // Every word the fixture names that is a plain sentence is one of ours.
        val named = pairs.map { it.second }.toSet()
        val missing = words.filter { (key, value) -> value is JsonPrimitive && value.isString && key !in named }.keys
        assertTrue("the fixture says words this port does not: $missing", missing.isEmpty())
        assertEquals(WikiPlanCopy.refsShownPhone, words.fint("refsShownPhone"))
        assertEquals(WikiPlanCopy.factsShown, words.fint("factsShown"))
        assertEquals(WikiPlanCopy.newSectionLength, words.fint("newSectionLength"))
        val statuses = words.fobj("statusLabels")
        WikiPlanLogic.ShownStatus.entries.forEach { assertEquals(it.name, statuses.fstr(it.name.lowercase()), it.label) }
        val ops = words.fobj("opLabels")
        WikiPlanLogic.ChangeOp.entries.forEach { assertEquals(it.name, ops.fstr(camel(it.name)), it.label) }
        val titles = words.fobj("gateTitles")
        listOf("schema", "docCount", "protected", "references").forEach { assertEquals(it, titles.fstr(it), WikiPlanLogic.gateTitle(it)) }
        assertEquals(words.fstrings("gateOrder"), WikiPlanLogic.gateOrder)
        val held = words.fobj("heldText"); val buildHeld = words.fobj("buildHeldText")
        assertEquals("the reasons a job is held are the web's three", held.keys, WikiPlanLogic.Held.entries.map { it.name.lowercase() }.toSet())
        WikiPlanLogic.Held.entries.forEach { reason ->
            assertEquals(reason.name, held.fstr(reason.name.lowercase()), WikiPlanLogic.heldText(reason))
            assertEquals(reason.name, buildHeld.fstr(reason.name.lowercase()), WikiPlanLogic.buildHeldText(reason))
        }
        // Owner's call 2026-09-29: a job is never held for the daily limit.
        val said = (held.values + buildHeld.values).joinToString(" ") { it.jsonPrimitive.content }.lowercase()
        assertFalse(said.contains("daily") || said.contains("limit"))
    }

    @Test fun theCountsAreTheFixtures() {
        val counts = plan.fobj("counts")
        fun rows(key: String) = counts.farr(key).map { it.jsonObject }
        rows("chars").forEach { row -> val length = row.fobj("length")
            assertEquals(row.fstr("says"), WikiPlanCopy.chars(WikiPlanRange(length.fint("min"), length.fint("max")))) }
        rows("sectionChars").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.sectionChars(it.fint("n"))) }
        rows("errors").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.errorCount(it.fint("n"))) }
        rows("changesCount").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.changeCount(it.fint("n"))) }
        rows("time").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.time(it["since"].text(), it["until"].text())) }
        rows("redraftNotes").forEach { row ->
            val from = (row["from"] as? JsonObject)?.let { it.fint("version") to (it["inForce"].bool() == true) }
            assertEquals(row.fstr("says"), WikiPlanCopy.redraftNote(row["provider"].text(), from))
        }
        rows("protectedKept").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.protectedKept(it.fstrings("numbers"))) }
        rows("emptyText").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.emptyText(it["provider"].text())) }
        rows("emptyNote").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.emptyNote(it["where"].text(), it["provider"].text())) }
        rows("saveNote").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.saveNote(it.fint("n"))) }
        rows("editTitle").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.editTitle(it.fstr("number"))) }
        rows("confirmed").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.confirmed(it.fint("n"))) }
        rows("changeAdded").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.changeAdded(it.fint("n"))) }
        rows("draftSaved").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.draftSaved(it.fint("n"))) }
        rows("andMore").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.andMore(it.fint("n"))) }
        rows("failedHint").forEach { assertEquals(it.fstr("says"), WikiPlanCopy.failedHint(it["inForce"].integer())) }
    }

    // MARK: the readings

    /** Every state: the home's look and banner, the page's version and head, its job, its gate, its documents. */
    @Test fun everyStateIsTheFixtures() {
        val states = plan.fobj("states")
        val directory = WikiPlanFixture.directory
        assertEquals(13, states.size)
        states.keys.sorted().forEach { name ->
            val expected = states.fobj(name)
            val spec = expected.fobj("spec")
            val state = state(spec)
            val online = spec["runnerOnline"].bool()
            val look = WikiPlanLogic.look(state, online)
            assertEquals(name, expected["look"].text(), look?.let { camel(it.name) })
            assertEquals(name, expected.fint("pending"), WikiPlanLogic.pending(state, online))
            assertEquals(name, expected["open"].text(), WikiPlanLogic.openJob(state)?.id)
            assertEquals(name, expected["build"].text(), WikiPlanLogic.buildJob(state)?.id)
            assertEquals(name, expected["failed"].text(), WikiPlanLogic.failedJob(state)?.id)
            assertEquals(name, expected.fint("nextVersion"), WikiPlanLogic.nextVersion(state))
            assertEquals(name, expected["acceptConfirms"].bool(), WikiPlanLogic.acceptConfirms(state))

            val docs = if (state.confirmed != null) 3 to 5 else null
            val banner = look?.let { WikiPlanLogic.banner(it, state, now, docs, online) }
            assertEquals(name, (expected["banner"] as? JsonObject)?.let { "${it.fstr("text")} | ${it.fstr("tone")} | ${it.fstr("to")}" },
                banner?.let { "${it.text} | ${if (it.amber) "amber" else "blue"} | ${if (it.toSettings) "settings" else "plan"}" })

            val shown = WikiPlanLogic.defaultShown(state)
            assertEquals(name, (expected["shown"] as? JsonObject)?.let { "v${it.fint("version")} ${it.fstr("status")} ${it.fstr("label")} ${it.fstr("statusLabel")}" },
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
            assertEquals(name, wantCard?.let { "${it.fstr("look")} | ${it.fstr("title")} | ${it.fstr("text")}" },
                card?.let { "${it.look.name.lowercase()} | ${it.title} | ${it.text}" })
            assertEquals(name, (wantCard?.get("link") as? JsonObject)?.let { "${it.fstr("label")} ${it.fstr("to")} ${it["sessionId"].textOrDash()}" },
                card?.link?.let { "${it.label} ${it.to.name.lowercase()} ${it.sessionId ?: "-"}" })
            assertEquals(name, (wantCard?.get("progress") as? JsonObject)?.let { "${it.fint("done")}/${it.fint("total")} ${it["now"].textOrDash()}" },
                card?.progress?.let { "${it.done}/${it.total} ${it.now ?: "-"}" })

            if (shown != null && (shown.status == WikiPlanLogic.ShownStatus.DRAFT || shown.status == WikiPlanLogic.ShownStatus.FAILED)) {
                val gate = WikiPlanLogic.gate(shown, WikiPlanLogic.base(shown, state), if (shown.status == WikiPlanLogic.ShownStatus.FAILED) failed else state.job)
                val want = expected["gate"] as? JsonObject ?: throw AssertionError("$name has no gate")
                assertEquals(name, listOf(if (want["passed"].bool() == true) "passed" else "failed", want.fstr("title"), want.fstr("line"), want["aside"].textOrDash()),
                    listOf(if (gate.passed) "passed" else "failed", gate.title, gate.line, gate.aside ?: "-"))
                assertEquals(name, want.farr("rows").map { it.jsonObject }.map { "${it.fstr("check")} ${it["ok"].bool()} ${it.fstr("title")}: ${it.fstr("text")}" },
                    gate.rows.map { "${it.check} ${it.ok} ${it.title}: ${it.text}" })
                assertEquals(name, want.fstrings("refKinds"), gate.refKinds)
                assertEquals(name, want.farr("refs").map { it.jsonObject }.map { "${it.fstr("where")} | ${it.fstr("kind")} | ${it.fstr("ref")} | ${it.fstr("why")}" },
                    gate.refs.map { "${it.where} | ${it.kind} | ${it.ref} | ${it.why}" })
            } else assertTrue(name, expected["gate"] == null || expected["gate"] is JsonNull)

            val categories = shown?.categories.orEmpty()
            val wantCategories = expected.farr("categories").map { it.jsonObject }
            assertEquals(name, wantCategories.map { "${it.fstr("key")} ${it.fint("number")} ${it.fstr("title")} ${it.fstr("line")}" },
                categories.map { "${it.key} ${it.number} ${it.title} ${WikiPlanLogic.categoryLine(it)}" })
            categories.zip(wantCategories).forEach { (category, want) ->
                assertEquals(name, want.farr("docs").map { it.jsonObject }.map {
                    "${it.fstr("slug")} ${it.fstr("number")} ${it.fstr("title")} ${it["protected"].bool()} ${it.fint("errors")} ${it["errorLabel"].textOrDash()} ${it.fstr("line")}"
                }, category.docs.map { doc ->
                    val errors = WikiPlanLogic.docErrors(shown!!, doc).size
                    "${doc.slug} ${doc.number} ${doc.title} ${doc.protected} $errors ${if (errors > 0) WikiPlanCopy.errorCount(errors) else "-"} ${WikiPlanLogic.docLine(doc)}"
                })
            }
        }
    }

    @Test fun theVersionMenuIsTheFixtures() {
        val rows = plan.fobj("versionRows")
        val failed = rows.fobj("failed")
        val ours = WikiPlanLogic.versionRows(rows.farr("versions").decode(ListSerializer(WikiPlanVersionSummary.serializer())),
            failed.fint("version") to failed["at"].text(), zone)
        assertEquals(rows.farr("rows").map { it.jsonObject }.map { "v${it.fint("version")} ${it.fstr("status")} ${it.fstr("note")}" },
            ours.map { "v${it.version} ${it.status.name.lowercase()} ${it.note}" })
    }

    /** A document's and a section's pages of the failed draft and of the version in force. */
    @Test fun aDocumentsAndASectionsPagesAreTheFixtures() {
        plan.farr("docPages").map { it.jsonObject }.forEach { expected ->
            val state = state(plan.fobj("states").fobj(if (expected.fint("version") == 1) "inForce" else "draftFailed").fobj("spec"))
            val shown = WikiPlanLogic.defaultShown(state)!!
            val base = WikiPlanLogic.base(shown, state)
            val doc = shown.docs.first { it.slug == expected.fstr("slug") }
            val at = "v${expected.fint("version")} ${expected.fstr("slug")}"
            val errors = WikiPlanLogic.docErrors(shown, doc).size
            assertEquals(at, listOf(expected.fstr("title"), expected.fstr("number"), "${expected["protected"].bool()}"), listOf(doc.title, doc.number, "${doc.protected}"))
            assertEquals(at, expected.fstrings("head"), listOf("${WikiPlanCopy.versionLabel(shown.version)} · ${shown.status.label}") +
                (if (errors > 0) listOf(WikiPlanCopy.errorCount(errors)) else emptyList()) + WikiPlanLogic.docLine(doc))
            assertEquals(at, expected.fstr("length"), WikiPlanCopy.chars(doc.length))
            assertEquals(at, expected.fstr("protectedNote"), if (doc.protected) WikiPlanCopy.protectedNote else WikiPlanCopy.notProtectedNote)
            assertEquals(at, expected.fstr("drawsOn"), WikiPlanLogic.drawsOn(doc))
            val numbers = LinkedHashMap<String, String>().apply { shown.docs.forEach { putIfAbsent(it.slug, it.number) } }
            assertEquals(at, expected.farr("scopeOut").map { it.jsonObject }.map { "${it.fstr("text")} ${it.fstrings("see")}" },
                doc.scopeOut.map { out -> "${out.text} ${out.docs.map { "→ ${numbers[it] ?: it}" }}" })
            val sections = expected.farr("sections").map { it.jsonObject }
            assertEquals(at, sections.size, doc.sections.size)
            doc.sections.zip(sections).forEachIndexed { index, (section, want) ->
                val where = "$at §${want.fint("n")}"
                assertEquals(where, listOf(want.fstr("title"), want.fstr("line"), want.fstr("meta")),
                    listOf(section.title, WikiPlanLogic.sectionLine(section), WikiPlanLogic.sectionMeta(shown, section)))
                val sources = want.fobj("sources")
                fun found(element: JsonElement?) = element.bool()?.toString() ?: "-"
                assertEquals(where, sources.farr("docs").map { it.jsonObject }.map { "${it.fstr("path")} ${it["section"].textOrDash()} ${found(it["found"])}" },
                    section.sources.docs.mapIndexed { k, s -> "${s.path} ${s.section ?: "-"} ${WikiPlanLogic.sourceFound(shown, doc, index, "docs", k)?.toString() ?: "-"}" })
                assertEquals(where, sources.farr("code").map { it.jsonObject }.map { "${it.fstr("path")} ${it.fstrings("symbols")} ${found(it["found"])}" },
                    section.sources.code.mapIndexed { k, s -> "${s.path} ${s.symbols} ${WikiPlanLogic.sourceFound(shown, doc, index, "code", k)?.toString() ?: "-"}" })
                assertEquals(where, sources.farr("contracts").map { it.jsonObject }.map { "${it.fstr("path")} ${found(it["found"])}" },
                    section.sources.contracts.mapIndexed { k, path -> "$path ${WikiPlanLogic.sourceFound(shown, doc, index, "contracts", k)?.toString() ?: "-"}" })
                val wantSessions = sources["sessions"] as? JsonObject
                assertEquals(where, wantSessions?.let { s -> listOf(s.farr("projects").joinToString(",") { it.text() ?: "" }, s.fstr("time"),
                    s.fstrings("keywords").joinToString(","), s.fstrings("anchorPaths").joinToString(","), s.fstr("entryKinds"), s.fstr("topics"), s.fstr("evidence")) },
                    section.sources.sessions?.let { s -> listOf(s.projects.joinToString(",") { it.title }, WikiPlanCopy.time(s.since, s.until),
                        s.keywords.joinToString(","), s.anchorPaths.joinToString(","), s.entryKinds.joinToString(" · "), s.topics.joinToString(" · "), s.evidence) })
            }
            assertEquals(at, expected.farr("lost").map { it.jsonObject }.map { "${it.fint("number")} ${it.fstr("label")} | ${it.fstr("why")}" },
                WikiPlanLogic.lostSections(shown, base, doc.slug).map {
                    "${it.number} ${WikiPlanCopy.lostLabel(base?.version ?: 0, it.number, it.title)} | ${WikiPlanCopy.protectedMovePhone(it.movedTo, doc.number)}"
                })
        }
    }

    @Test fun theChangesProposedAreTheFixtures() {
        val base = WikiPlanLogic.fromVersion(version("v1"))
        val titles = mapOf("pr9" to "Codex 账号代管")
        val states = plan.fobj("states")
        plan.farr("changes").map { it.jsonObject }.forEach { expected ->
            val id = expected.fstr("proposal")
            val proposal = proposals.first { it.id == id }
            val change = WikiPlanLogic.change(proposal, base)
            assertEquals(id, listOf(expected.fstr("op"), expected.fstr("opLabel"), expected.fstr("target"), expected.fstr("title"), expected["renumber"].textOrDash()),
                listOf(camel(change.op.name), change.op.label, change.target, change.title, change.renumber ?: "-"))
            assertEquals(id, expected.farr("rows").map { it.jsonObject }.map { "${it.fstr("mark")} ${it.fstr("n")} ${it.fstr("title")} ${it.fstr("note")}" },
                change.rows.map { "${it.mark.name.lowercase()} ${it.n} ${it.title} ${it.note}" })
            assertEquals(id, expected.fstrings("sources"), change.added.flatMap { WikiPlanLogic.sourceLines(it.sources) { p -> titles[p] } })
            val facts = proposal.facts.orEmpty()
            assertEquals(id, expected.fstrings("facts"), facts.take(WikiPlanCopy.factsShown).map { it.id })
            assertEquals(id, expected["more"].text(), if (facts.size > WikiPlanCopy.factsShown) WikiPlanCopy.andMore(facts.size - WikiPlanCopy.factsShown) else null)
            assertEquals(id, expected.fstr("acceptNote"), WikiPlanLogic.acceptNote(state(states.fobj("changes").fobj("spec")), change.op))
            assertEquals(id, expected.fstr("acceptNoteWithDraft"), WikiPlanLogic.acceptNote(state(states.fobj("draftReady").fobj("spec")), change.op))
        }
    }

    /** An edit goes in the draft's shape: no ids or positions, a session condition's projects by id — the same request
     * the web sends for the same form. */
    @Test fun anEditIsSentInTheDraftsShape() {
        val edit = plan.fobj("edit")
        val stored = edit.fobj("stored").decode(WikiPlanDoc.serializer())
        assertEquals(WikiPlanDocInput.read(edit.fobj("input")), WikiPlanLogic.docInput(stored))
        val form = edit.fobj("form")
        val length = form.fobj("length")
        val docForm = WikiPlanLogic.DocForm(form.fstr("title"), form.fstr("question"), form.fstrings("audience"), form.fstrings("scopeIn"),
            WikiPlanRange(length.fint("min"), length.fint("max")), form["protected"].bool() == true,
            form.farr("sections").map { it.jsonObject }.map { WikiPlanLogic.DocForm.Section(it["key"].text(), it.fstr("title"), it.fstr("kind")) })
        val body = WikiPlanLogic.docEditBody(2, stored.slug, WikiPlanLogic.docEdit(stored, docForm))
        val want = edit.fobj("body")
        assertEquals(want.fint("baseVersion"), body.fint("baseVersion"))
        assertEquals(want.fstr("docSlug"), body.fstr("docSlug"))
        assertEquals(WikiPlanDocInput.read(want.fobj("doc")), WikiPlanDocInput.read(body.fobj("doc")))
        val sectionEdit = edit.fobj("section")
        val section = stored.sections!![sectionEdit.fint("index")]
        val sectionForm = sectionEdit.fobj("form")
        val sectionBody = WikiPlanLogic.sectionEditBody(2, stored.slug, section, sectionForm.fstr("title"), sectionForm.fstr("kind"),
            sectionForm.fstr("covers"), sectionForm.fint("length"))
        val wantSection = sectionEdit.fobj("body")
        assertEquals(listOf(wantSection.fstr("docSlug"), wantSection["sectionKey"].textOrDash()), listOf(sectionBody.fstr("docSlug"), sectionBody["sectionKey"].textOrDash()))
        assertEquals(WikiPlanSectionInput.read(wantSection.fobj("section")), WikiPlanSectionInput.read(sectionBody.fobj("section")))
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
        val orders = plan.fobj("orders")
        assertEquals(orders.fstrings("page"), WikiPlanLogic.PageSection.entries.map { camel(it.name) })
        assertEquals(orders.fstrings("doc"), WikiPlanLogic.DocSection.entries.map { camel(it.name) })
        assertEquals(orders.fstrings("section"), WikiPlanLogic.SectionSection.entries.map { camel(it.name) })
        assertEquals(orders.fstrings("change"), WikiPlanLogic.ChangePart.entries.map { camel(it.name) })
        assertEquals(orders.fstrings("looks"), WikiPlanLogic.Look.entries.map { camel(it.name) })
    }
}
