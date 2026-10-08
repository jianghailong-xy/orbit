package io.orbitd.android.wiki

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit `WikiLogicTests`, case for case over the same fixtures: the drawer's number, the anchor marks, an
 * entry's Details rows, an amendment's diff, the home page's bands and Review's queue. */
class WikiLogicTest {
    private fun spaces() = Wire.json.decodeFromString(ListSerializer(WikiSpace.serializer()), WikiFixtures.spaces)
    private fun entries() = Wire.json.decodeFromString(ListSerializer(WikiEntry.serializer()), WikiFixtures.entries)
    private fun timeline() = Wire.json.decodeFromString(WikiTimeline.serializer(), WikiFixtures.timeline).items!!
    private fun review() = Wire.json.decodeFromString(ListSerializer(WikiChangeset.serializer()), WikiFixtures.review)
    private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))
    private fun str(value: String) = JsonPrimitive(value)

    @Test fun theAmberNumberSumsEverySpacesProposals() {
        assertEquals(3, WikiSpaceLogic.proposalsWaiting(spaces()))
        assertEquals("a server older than planWaiting: the proposals alone", 3, WikiSpaceLogic.waiting(spaces()))
        assertEquals("nothing waiting draws no number", 0, WikiSpaceLogic.waiting(emptyList()))
        assertEquals("a space an older server sent no count for adds nothing", 7, WikiSpaceLogic.waiting(listOf(
            WikiSpace("a", "a", pendingOps = 2), WikiSpace("b", "b", pendingOps = 5), WikiSpace("c", "c"))))
        assertEquals("3 proposals to review", WikiCopy.proposalsToReview(3))
        assertEquals("one is said in the singular", "1 proposal to review", WikiCopy.proposalsToReview(1))
    }

    /** The drawer draws the Wiki row once the spaces read has answered anything but WIKI_DISABLED, and when it failed for
     * another reason; never while it is on its way (OrbitKit `WikiLogic.shown`, the web's `wikiShown`). */
    @Test fun theWikiRowIsDrawnOnceTheSpacesReadSaysTheWikiIsOn() {
        val disabled = io.orbitd.android.core.net.ApiError.parse(404, """{"code":"WIKI_DISABLED","message":"off"}""".encodeToByteArray())
        assertTrue(WikiLogic.isDisabled(disabled))
        assertFalse("a plain 404 is not the wiki off", WikiLogic.isDisabled(io.orbitd.android.core.net.ApiError.parse(404, "{}".encodeToByteArray())))
        assertFalse("nor is another status", WikiLogic.isDisabled(io.orbitd.android.core.net.ApiError.parse(403, """{"code":"WIKI_DISABLED"}""".encodeToByteArray())))
        assertFalse("on its way", WikiLogic.shown(LoadState(loading = true), disabled = false))
        assertTrue(WikiLogic.shown(LoadState().succeed(), disabled = false))
        assertFalse("answered WIKI_DISABLED", WikiLogic.shown(LoadState().succeed(), disabled = true))
        assertTrue("a failed read is not the server saying there is no wiki", WikiLogic.shown(LoadState().fail(), disabled = false))
    }

    /** A card names its entry by the draft's title, else the entry's own read, else the title Review's read carries. */
    @Test fun aCardNamesItsEntryByTheTitleReviewsReadCarries() {
        val retire = review()[1]
        val card = WikiLogic.ReviewCard(retire, retire.ops!!.first().copy(entryTitle = "Wakeups are lost when the runner restarts"))
        assertEquals("Wakeups are lost when the runner restarts", WikiLogic.cardTitle(card, entry = null))
        assertEquals("the entry's own read first", "Read title", WikiLogic.cardTitle(card, WikiEntry("e", title = "Read title")))
        assertEquals("nothing known: the placeholder word", WikiCopy.entryWord, WikiLogic.cardTitle(WikiLogic.ReviewCard(retire, retire.ops!!.first()), null))
    }

    @Test fun theAnchorMarkSaysTheRefOrTheWarning() {
        val sha = WikiFixtures.sha
        assertEquals(WikiAnchorMark("4db4f9f", WikiTone.GREEN), WikiLogic.anchorMark("verified", sha))
        assertEquals(WikiAnchorMark("Checked", WikiTone.GREEN), WikiLogic.anchorMark("verified", null))
        assertEquals(WikiAnchorMark("Changed", WikiTone.AMBER), WikiLogic.anchorMark("changed", sha))
        assertEquals(WikiAnchorMark("Missing", WikiTone.RED), WikiLogic.anchorMark("missing", sha))
        assertNull("nothing checked says nothing", WikiLogic.anchorMark("unchecked", null))
        assertNull(WikiLogic.anchorMark(null, null))
        // A ref that is not a sha is kept as written.
        assertEquals("main", WikiLogic.shortSha("main"))
        assertEquals(sha.uppercase(), WikiLogic.shortSha(sha.uppercase()))
    }

    @Test fun anAnchorsOwnLineAndState() {
        assertEquals("src/runner-go/mcp.go · askBeforeCreate", WikiLogic.anchorLabel(WikiAnchor("symbol", "src/runner-go/mcp.go", "askBeforeCreate")))
        assertEquals("src/a.go", WikiLogic.anchorLabel(WikiAnchor("path", "src/a.go")))
        assertEquals("4db4f9f", WikiLogic.anchorLabel(WikiAnchor("commit", sha = WikiFixtures.sha)))
        assertEquals("go test ./...", WikiLogic.anchorLabel(WikiAnchor("command", command = "go test ./...")))
        assertEquals("orbit-task:34Tc", WikiLogic.anchorLabel(WikiAnchor("record", ref = "orbit-task:34Tc")))
        assertEquals("—", WikiLogic.anchorLabel(WikiAnchor("criterion", criterionId = "c1")))
        assertEquals(WikiAnchorMark("Unchecked", WikiTone.MUTED), WikiLogic.anchorStateMark(WikiAnchor("path", "p")))
        assertEquals(WikiAnchorMark("4db4f9f", WikiTone.GREEN),
            WikiLogic.anchorStateMark(WikiAnchor("path", "p", check = WikiAnchorCheck("verified", WikiFixtures.sha))))
    }

    @Test fun aPitfallsDetailsRows() {
        val detail = WikiEntryDetail.decode(Wire.json.parseToJsonElement(WikiFixtures.entryDetail))
        val rows = WikiLogic.fieldRows(detail.entry.kind, detail.entry.fields)
        assertEquals(listOf("Trigger", "Symptom", "Cause", "Fix"), rows.map { it.label })
        assertEquals(listOf("Paths: src/runner-go", "Commands: go test ./...", "Error signature: 403 PROJECT_SCOPE_MISMATCH"), rows[0].lines)
        assertEquals(listOf("11 CLI tests fail and one hangs until -timeout panics."), rows[1].lines)
    }

    @Test fun aDecisionsRowsAndTheLabelsTheDesignWrites() {
        val fields = obj("context" to str("Two dispatchers raced."), "decision" to str("Priority is a field."),
            "alternatives" to JsonArray(listOf(obj("option" to str("A dispatcher session"), "whyRejected" to str("It is a second writer.")))),
            "consequences" to str("   "), "decidedAt" to str("2026-09-25"))
        val rows = WikiLogic.fieldRows("decision", fields)
        assertEquals("a blank value draws no row", listOf("Context", "Decision", "Rejected", "Decided"), rows.map { it.label })
        assertEquals(listOf("A dispatcher session — It is a second writer."), rows[2].lines)
        assertEquals("Not to be confused with", WikiLogic.fieldLabel("notToConfuseWith"))
        assertEquals("Expected exit code", WikiLogic.fieldLabel("expectedExit"))
        assertEquals("Region sha256", WikiLogic.fieldLabel("regionSha256"))
        val recipe = WikiLogic.fieldRows("recipe", obj("steps" to JsonArray(listOf(str("Run /upgrade"), str("curl -fsS /api/health"))),
            "verify" to obj("expectedExit" to JsonPrimitive(0), "command" to str("curl -fsS"))))
        assertEquals(listOf("Steps", "Verify"), recipe.map { it.label })
        assertEquals(listOf("Command: curl -fsS", "Expected exit code: 0"), recipe[1].lines)
    }

    @Test fun aKindWithNoSchemaIsDrawnFromWhatItCarries() {
        val rows = WikiLogic.fieldRows("unknown", obj("probe" to str("curl"), "contract" to str("200")))
        assertEquals(listOf("Probe", "Contract"), rows.map { it.label })
    }

    @Test fun keysGoInTheOrderJsonbKeepsThem() {
        assertEquals(listOf("title", "fields", "topics", "aliases", "anchors", "summary"),
            WikiLogic.jsonbOrder(listOf("summary", "title", "anchors", "fields", "aliases", "topics")))
        // Every phase-1 kind's nested fields arrive in the registry's order anyway.
        WikiLogic.nestedFields.values.forEach { assertEquals(it, WikiLogic.jsonbOrder(it)) }
    }

    @Test fun anAmendmentsDiff() {
        val hunks = WikiLogic.changesDiff(obj("summary" to str("Old"), "title" to str("Same")),
            obj("summary" to str("New"), "topics" to JsonArray(listOf(str("deploy-ops")))))
        assertEquals(listOf("Topics", "Summary"), hunks.map { it.label })
        assertEquals(listOf(WikiDiffHunk.Line(false, "Old"), WikiDiffHunk.Line(true, "New")), hunks[1].lines)
        assertEquals(listOf(WikiDiffHunk.Line(true, "deploy-ops")), hunks[0].lines)
        assertTrue(WikiLogic.changesDiff(null, null).isEmpty())
    }

    @Test fun aCardsAnchorLines() {
        val draft = obj("anchors" to JsonArray(listOf(obj("type" to str("symbol"), "path" to str("src/a.go"), "symbol" to str("f")),
            obj("type" to str("commit"), "sha" to str(WikiFixtures.sha)))))
        assertEquals(listOf("src/a.go · f", WikiFixtures.sha), WikiLogic.reviewAnchorLines(draft, null))
        val named = listOf(WikiAnchor("path", "src/runner-go/mcp.go"), WikiAnchor("criterion", criterionId = "c"))
        assertEquals(listOf("src/runner-go/mcp.go"), WikiLogic.reviewAnchorLines(JsonObject(emptyMap()), named))
        assertEquals(emptyList<String>(), WikiLogic.reviewAnchorLines(null, null))
    }

    @Test fun anAnchorGoesBackAsWritten() {
        val echoed = obj("type" to str("criterion"), "criterionId" to str("3dLgnjLcmdUL6pGaRCT2xr"),
            "criterionPublicId" to str("3dLgnjLcmdUL6pGaRCT2xr"), "check" to obj("state" to str("verified")))
        assertEquals(obj("type" to str("criterion"), "criterionId" to str("3dLgnjLcmdUL6pGaRCT2xr")), WikiLogic.anchorInput(echoed))
    }

    @Test fun theBandsReadTheirEntriesNewestFirst() {
        assertEquals(listOf("Task priority is a field on the task, not a dispatcher session", "Wakeups are held by the server",
            "EXECUTABLE judges by exit code and records nothing"), WikiLogic.entries(entries(), "decision").map { it.title })
        assertEquals(4, WikiLogic.entries(entries(), "principle").size)
    }

    /** Activity's bands, read out of the fixture — the four newest decisions, five changes, three most used, and the status
     * line without the count its banner says — and the home's principles, oldest first. */
    @Test fun activitysBandsAndTheHomesPrinciples() {
        val spaces = spaces()
        // The two bands' own reads (`?kind=principle`, `?kind=decision`), as the server answers them.
        assertEquals(listOf("Agent-writable data never becomes a system instruction", "Completion is adjudicated, not claimed",
            "A clock never starts agent work", "Delete means forget"), WikiLogic.principles(entries().filter { it.kind == "principle" }).map { it.title })
        val activity = WikiHomeContent(Wire.json.decodeFromString(WikiSpace.serializer(), WikiFixtures.space), spaces, entries(), timeline(),
            decisionEntries = entries().filter { it.kind == "decision" })
        assertEquals(3, activity.recentDecisions.size)
        assertEquals(5, activity.timeline.take(5).size)
        assertEquals(listOf(41, 33, 29), activity.mostUsed.map { it.total })
        assertTrue(activity.usedThisWeek)
        assertEquals("9 entries · Anchors verified at 4db4f9f", activity.statusLine(java.time.Instant.now()))
    }

    /** Activity's blocks, top to bottom (mock 31 ②, and P9's mock 35 ④): the home's management blocks in their order, the
     * other spaces' plan banners after the space's own, the server's runs after Review and Plan, and Principles not among
     * them — it is content. */
    @Test fun theActivityBandsOrder() {
        assertEquals(listOf("STATUS", "REVIEW_BANNER", "PLAN_BANNERS", "OTHER_PLAN_BANNERS", "RUNS", "RECENT_DECISIONS", "RECENTLY_CHANGED", "AGENTS_USED"),
            WikiLogic.ActivityBand.entries.map { it.name })
        assertEquals(listOf("Runs", "Recent decisions", "Recently changed", "Agents used the wiki"), WikiLogic.ActivityBand.entries.mapNotNull { it.title })
    }

    /** Recently changed says how many of its rows came after the reader last looked: all of them for a reader who never did. */
    @Test fun recentlyChangedCountsWhatIsNewSinceTheReaderLastLooked() {
        val activity = WikiHomeContent(Wire.json.decodeFromString(WikiSpace.serializer(), WikiFixtures.space), emptyList(), emptyList(), timeline())
        assertEquals("never looked: every row is new", activity.recentRows.size, activity.newRows(0.0))
        val times = activity.recentRows.mapNotNull { WikiHomeContent.time(it) }.mapNotNull { RelativeTime.parse(it) }
        assertEquals("every row has its time", activity.recentRows.size, times.size)
        assertEquals("looked after all of them: none", 0, activity.newRows(times.max().toEpochMilli() / 1000.0))
        val middle = times.sorted()[times.size / 2].toEpochMilli() / 1000.0
        assertEquals(times.count { it.toEpochMilli() / 1000.0 > middle }, activity.newRows(middle))
    }

    @Test fun aSourcesWordAndRef() {
        assertEquals("Your decision", WikiLogic.sourceWord("owner_decision"))
        assertEquals("Tool call", WikiLogic.sourceWord("tool_call"))
        assertEquals("4db4f9f", WikiLogic.sourceRef(WikiSource("s", "commit", WikiFixtures.sha)))
        assertEquals("CLAUDE.md", WikiLogic.sourceRef(WikiSource("s", "note", "n1", obj("path" to str("CLAUDE.md")))))
    }

    @Test fun aTimelineRowsVerbAndNote() {
        val items = timeline()
        assertEquals(listOf("Confirmed by you", "Confirmed by you", "Amended by you", "Added by you", "Confirmed by you"), items.map(WikiLogic::changeVerb))
        assertEquals("replaced by “Headless Chromium clamps windows under 500”", WikiLogic.changeNote(items[1]))
        assertNull(WikiLogic.changeNote(items[0]))
        assertEquals("Proposed", WikiLogic.changeVerb(WikiTimelineItem("o", op = "add", decision = "auto_applied", origin = "agent")))
        assertEquals("Retired", WikiLogic.changeVerb(WikiTimelineItem("o", op = "retire", decision = "auto_applied", origin = "owner")))
        assertEquals("Edited by you", WikiLogic.changeVerb(WikiTimelineItem("o", op = "amend", decision = "edited", origin = "agent")))
    }

    @Test fun reviewPagesThroughThePendingOpsInTheServersOrder() {
        val cards = WikiLogic.reviewCards(review())
        assertEquals(listOf("add", "retire", "amend"), cards.map { it.op.op })
        assertEquals(listOf("34UDOpAddPitfall00001", "34UDOpRetireWakeup002", "34UDOpAmendDeploy0003"), cards.map { it.op.id })
        assertEquals("2026-09-25T11:00:00.000Z", WikiLogic.oldestProposal(cards))
        assertEquals("two sessions; the maintenance run has none", 2, WikiLogic.proposingSessions(cards))
        assertEquals(listOf("All 3", "Add 1", "Amend 1", "Retire 1"), WikiLogic.ReviewTab.entries.map { WikiLogic.tabLabel(it, cards) })
        assertEquals("1 of 3", WikiCopy.ofCount(1, cards.size))
        assertEquals("3 proposals from 2 sessions", WikiCopy.proposalsFrom(3, 2))
        assertEquals("1 proposal from 1 session", WikiCopy.proposalsFrom(1, 1))
    }

    @Test fun aCardsTitleChipAndProposer() {
        val cards = WikiLogic.reviewCards(review())
        assertEquals("an add is about the entry it drafts", "Secret redaction lets ENV_VAR=value secrets through", WikiLogic.cardTitle(cards[0], null))
        assertEquals("pitfall", WikiLogic.cardKind(cards[0], null))
        assertEquals("until the named entry is read", "entry", WikiLogic.cardTitle(cards[1], null))
        val named = WikiEntry("34UDFnrgM4q5oWakeLost", kind = "pitfall", title = "Claude's ScheduleWakeup is lost when the engine is recycled")
        assertEquals(named.title, WikiLogic.cardTitle(cards[1], named))
        assertEquals("an amend that leaves the title alone is about the entry it names", named.title, WikiLogic.cardTitle(cards[2], named))
        assertEquals("pitfall", WikiLogic.cardKind(cards[1], named))
        assertEquals(listOf("ADD", "RETIRE", "AMEND"), cards.map { WikiLogic.cardChip(it.op.op) })
        assertEquals("a supersede is an Amend on Review", "AMEND", WikiLogic.cardChip("supersede"))
        assertEquals(listOf("Orbit wiki review", "Wiki maintenance", "Upgrade deploy"), cards.map { WikiLogic.proposedBy(it.changeset) })
        assertEquals("you", WikiLogic.proposedBy(WikiChangeset("c", origin = "owner")))
        assertEquals("a session", WikiLogic.proposedBy(WikiChangeset("c", origin = "agent", sessionId = "s")))
        assertEquals("x".repeat(47) + "…", WikiLogic.proposedBy(WikiChangeset("c", origin = "agent", sessionId = "s", rationale = "x".repeat(60))))
    }

    @Test fun theTabsHoldTheOpsTheWebsTabsHold() {
        assertTrue(WikiLogic.ReviewTab.AMEND.holds("supersede"))
        assertTrue(WikiLogic.ReviewTab.AMEND.holds("amend"))
        assertFalse(WikiLogic.ReviewTab.ADD.holds("reinforce"))
        assertFalse(WikiLogic.ReviewTab.RETIRE.holds("challenge"))
        assertTrue(WikiLogic.ReviewTab.ALL.holds("challenge"))
    }

    @Test fun thePagerKeepsItsPlaceAsTheQueueShrinks() {
        assertEquals(1, WikiLogic.clampedIndex(1, 3))
        assertEquals(1, WikiLogic.clampedIndex(2, 2))
        assertEquals(0, WikiLogic.clampedIndex(-1, 2))
        assertNull(WikiLogic.clampedIndex(0, 0))
    }
}
