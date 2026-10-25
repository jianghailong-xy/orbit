package io.orbitd.android.wiki

import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitNavigation
import io.orbitd.android.navigation.OrbitRoute
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit `WikiSpaceLogicTests`, case for case: what each space is called, which one the Wiki opens, what waits on the
 * owner across them — held to the web's rules by the one set of cases every client reads,
 * `src/shared/src/wiki-space.fixture.json`. A missing fixture is a failure, never a skip; so is one that lost its cases. */
class WikiSpaceLogicTest {
    private val fixture: JsonObject by lazy { WikiSharedFiles.json("src/shared/src/wiki-space.fixture.json") }

    /** A space as a case writes it: only the fields its rule reads. */
    private fun space(json: JsonElement): WikiSpace {
        val o = json.jsonObject
        fun text(key: String) = o[key].text()
        return WikiSpace(id = text("id") ?: text("slug") ?: "", slug = text("slug") ?: text("id") ?: "", title = text("title"),
            repoUrlNorm = text("repoUrlNorm"), pendingOps = o["pendingOps"].integer(), planWaiting = o["planWaiting"].integer(),
            workspaceIds = (o["workspaceIds"] as? JsonArray)?.map { it.jsonPrimitive.content },
            docs = (o["docs"] as? JsonObject)?.let { WikiDocsDirectory.Counts(it.fint("total"), it.fint("written")) })
    }
    private fun spaces(case: JsonObject) = case.farr("spaces").map(::space)
    private fun cases(key: String) = fixture.farr(key).map { it.jsonObject }

    /** The fixture still holds its cases, among them one where a plan waits too. */
    @Test fun theFixtureHoldsItsCases() {
        assertTrue(cases("names").size >= 6)
        assertTrue(cases("defaults").size >= 9)
        assertTrue(cases("waiting").size >= 10)
        assertTrue("a case with several spaces and a plan that waits",
            cases("waiting").any { case -> spaces(case).size > 1 && spaces(case).any { (it.planWaiting ?: 0) > 0 } })
    }

    // MARK: the name

    /** A space is called by its repository's last segment, its title without one, and more segments while two would be the same. */
    @Test fun everyNameIsTheFixtures() {
        cases("names").forEach { case ->
            assertEquals(case.fstr("name"), case.fobj("names").mapValues { it.value.jsonPrimitive.content }, WikiSpaceLogic.names(spaces(case)))
        }
    }

    // MARK: which space the Wiki opens

    /** The workspace's space, else the last one looked at, else the most written — the first on a tie. */
    @Test fun theSpaceTheWikiOpensIsTheFixtures() {
        cases("defaults").forEach { case ->
            val opens = WikiSpaceLogic.defaultSpace(spaces(case), case["workspaceId"].text(), case["lastSlug"].text())
            assertEquals(case.fstr("name"), case["opens"].text(), opens?.slug)
        }
    }

    /** Where the reader is when they open the Wiki: the workspace whose list is showing, a project's page (whose
     * coordinator's workspace the store reads), and nowhere on the Projects or Tasks list. */
    @Test fun whereTheReaderIs() {
        val workspace = OrbitNavigation().select("ws-list", OrbitRoute(Destination.WORKSPACE, "ws-list", "ws-list"))
        assertEquals("a workspace's session list", WikiFrom(workspaceId = "ws-list"), wikiFrom(workspace))
        assertEquals("one of its conversations", WikiFrom(workspaceId = "ws-list"),
            wikiFrom(workspace.push(OrbitRoute(Destination.SESSION, "s1", "ws-list"))))
        assertEquals("a project opened over it from the drawer", WikiFrom(projectId = "P1"),
            wikiFrom(workspace.push(OrbitRoute(Destination.PROJECT, "P1"))))
        val projects = OrbitNavigation().select("Projects", OrbitRoute(Destination.PROJECTS))
        assertEquals("the Projects list", WikiFrom(), wikiFrom(projects))
        assertEquals("a project's page", WikiFrom(projectId = "P1"), wikiFrom(projects.push(OrbitRoute(Destination.PROJECT, "P1"))))
        assertEquals("a task over its project's page", WikiFrom(projectId = "P1"),
            wikiFrom(projects.push(OrbitRoute(Destination.PROJECT, "P1")).push(OrbitRoute(Destination.TASK, "t1"))))
        assertEquals("the Tasks list", WikiFrom(), wikiFrom(OrbitNavigation().select("Tasks", OrbitRoute(Destination.TASKS))))
        assertEquals("the workspaces' own page", WikiFrom(), wikiFrom(OrbitNavigation()))
    }

    // MARK: what waits on the owner

    /** The number, the proposals alone, Activity's first banner and the picker's options, case by case — a plan that
     * waits counts in the number and not in the banner. */
    @Test fun whatWaitsIsTheFixtures() {
        cases("waiting").forEach { case ->
            val name = case.fstr("name")
            val spaces = spaces(case)
            assertEquals(name, case.fint("waiting"), WikiSpaceLogic.waiting(spaces))
            assertEquals(name, case.fint("proposals"), WikiSpaceLogic.proposalsWaiting(spaces))
            assertEquals(name, case["banner"].text(), WikiSpaceLogic.proposalsBanner(spaces, case.fstr("current")))
            val names = WikiSpaceLogic.names(spaces)
            assertEquals(name, case.fstrings("options"), spaces.map { WikiSpaceLogic.option(names[it.id] ?: "", it) })
            assertEquals(name, case.fint("waiting"), spaces.sumOf(WikiSpaceLogic::waitingIn))
        }
    }

    /** The drawer's number, the bar's Activity badge and Activity's amber banners are one number — every space's proposals
     * and what each plan waits on the owner for — and Activity's first banner is Review's head, the proposals alone. */
    @Test fun fourPlacesSayOneNumber() {
        fun plan(json: String) = WikiPlanState.decode(Json.parseToJsonElement(json))
        val spaces = listOf(
            WikiSpace("s1", "github-com-jianghailong-xy-orbit", "github-com-jianghailong-xy-orbit", "github.com/jianghailong-xy/orbit", pendingOps = 1, planWaiting = 1),
            WikiSpace("s2", "wikova", "wikova", "github.com/jianghailong-xy/wikova", pendingOps = 2, planWaiting = 2),
            WikiSpace("s3", "wikids", "wikids", "github.com/jianghailong-xy/wikids", pendingOps = 0, planWaiting = 0))
        val plans = mapOf(
            "s1" to plan("""{"spaceId":"s1","confirmed":null,"draft":{"id":"v1","version":1,"status":"draft"},"proposals":[],"job":null}"""),
            "s2" to plan("""{"spaceId":"s2","confirmed":null,"draft":null,"proposals":[{"id":"p1","status":"pending"},{"id":"p2","status":"pending"}],"job":null}"""),
            "s3" to plan("""{"spaceId":"s3","confirmed":null,"draft":null,"proposals":[],"job":null}"""))
        // Each plan read counts what the server's planWaiting counts.
        spaces.forEach { assertEquals(it.planWaiting, WikiPlanLogic.pending(plans.getValue(it.id), runnerOnline = true)) }
        val drawer = WikiSpaceLogic.waiting(spaces)
        assertEquals("1 + 1 in orbit, 2 + 2 in wikova", 6, drawer)

        val onOrbit = WikiSpaceLogic.activityBanners(spaces, spaces[0], plans, Instant.now(), null) { true }
        assertEquals(listOf("3 proposals to review · 2 in wikova", "Plan draft ready to confirm", "2 plan changes to review · in wikova"), onOrbit.map { it.text })
        assertEquals(listOf(WikiLogic.ActivityBand.REVIEW_BANNER, WikiLogic.ActivityBand.PLAN_BANNERS, WikiLogic.ActivityBand.OTHER_PLAN_BANNERS), onOrbit.map { it.band })
        assertEquals(listOf(WikiSpaceLogic.ActivityBanner.To.Review, WikiSpaceLogic.ActivityBanner.To.Plan("github-com-jianghailong-xy-orbit"),
            WikiSpaceLogic.ActivityBanner.To.Plan("wikova")), onOrbit.map { it.to })
        assertTrue(onOrbit.all { it.amber })
        assertEquals("Activity's amber banners add up to the drawer's number", drawer, onOrbit.sumOf { it.count })

        // On a space whose plan waits for nothing, its plan says what it is doing, in blue, counting nothing.
        val onWikids = WikiSpaceLogic.activityBanners(spaces, spaces[2], plans, Instant.now(), null) { true }
        assertEquals(listOf("3 proposals to review · 1 in orbit · 2 in wikova", "No plan yet — draft one",
            "Plan draft ready to confirm · in orbit", "2 plan changes to review · in wikova"), onWikids.map { it.text })
        assertEquals(listOf(true, false, true, true), onWikids.map { it.amber })
        assertEquals(drawer, onWikids.sumOf { it.count })

        // The first banner is the proposals alone — Review's head, over the same queue.
        val first = onOrbit.first()
        assertEquals(WikiSpaceLogic.proposalsWaiting(spaces), first.count)
        val queue = listOf(WikiChangeset("c1", "s1", sessionId = "a", ops = listOf(WikiChangesetOp("o1", seq = 1, op = "add", decision = "pending"))),
            WikiChangeset("c2", "s2", sessionId = "b", ops = listOf(WikiChangesetOp("o2", seq = 1, op = "add", decision = "pending"),
                WikiChangesetOp("o3", seq = 2, op = "amend", decision = "pending"))))
        val cards = WikiLogic.reviewCards(queue)
        assertEquals(first.count, cards.size)
        assertEquals("3 proposals from 2 sessions", WikiCopy.proposalsFrom(cards.size, WikiLogic.proposingSessions(cards)))
    }

    /** The picker's rows (mock 31 ④): the name, the repository and the documents under it, and the amber number — said at
     * the end of the line where a menu cannot draw it. */
    @Test fun thePickersRows() {
        val spaces = listOf(
            WikiSpace("s1", "github-com-jianghailong-xy-orbit", "github-com-jianghailong-xy-orbit", "github.com/jianghailong-xy/orbit",
                pendingOps = 1, planWaiting = 0, docs = WikiDocsDirectory.Counts(35, 5)),
            WikiSpace("s2", "wikova", "wikova", "github.com/jianghailong-xy/wikova", pendingOps = 2, planWaiting = 0, docs = WikiDocsDirectory.Counts(12, 12)),
            WikiSpace("s3", "wikids", "Kids", "github.com/jianghailong-xy/wikids", pendingOps = 0, planWaiting = 0),
            WikiSpace("s4", "notes", "Design notes", pendingOps = 51, planWaiting = 1, docs = WikiDocsDirectory.Counts(1, 1)))
        val rows = WikiSpaceLogic.menuRows(spaces)
        assertEquals(listOf("orbit", "wikova", "wikids", "Design notes"), rows.map { it.name })
        assertEquals("a row opens its space by slug", spaces.map { it.slug }, rows.map { it.slug })
        assertEquals(listOf("github.com/jianghailong-xy/orbit", "35 documents"), rows[0].lines)
        assertEquals(listOf("github.com/jianghailong-xy/wikids", "No documents yet"), rows[2].lines)
        assertEquals("no repository, no line for it", listOf("1 document"), rows[3].lines)
        assertEquals(listOf(1, 2, 0, 52), rows.map { it.waiting })
        assertEquals("github.com/jianghailong-xy/orbit\n35 documents", rows[0].subtitle(sayWaiting = false))
        assertEquals("the web option's own words", "github.com/jianghailong-xy/orbit\n35 documents · 1 waiting", rows[0].subtitle(sayWaiting = true))
        assertEquals("nothing waiting says nothing", "github.com/jianghailong-xy/wikids\nNo documents yet", rows[2].subtitle(sayWaiting = true))
        assertEquals("1,234 documents", WikiCopy.documentCount(1234))
    }

    // MARK: since the reader last looked

    /** The home moves the stamp as it opens and Activity reads what it said before; Activity moving it in its turn leaves
     * the next page the home's visit to compare against (the web's `wiki.test.ts` cases). */
    @Test fun thePageAfterTheHomeReadsTheStampFromBefore() {
        val store = mutableMapOf<String, Double>()
        val log = WikiSeenLog()
        val key = WikiSeenLog.key("stamp-test")
        assertEquals("orbit.wiki.seen.stamp-test.home", key)
        fun move(at: Double) { log.move(key, at, store[key] ?: 0.0); store[key] = at }
        store[key] = 1.0
        assertEquals("the stamp itself until this run moved it", 1.0, log.seenBefore(key, store[key] ?: 0.0), 0.0)
        move(5.0)
        assertEquals(5.0, store[key]!!, 0.0)
        assertEquals("the home's move keeps the visit before", 1.0, log.seenBefore(key, store[key] ?: 0.0), 0.0)
        move(9.0)
        assertEquals("Activity's move: the next page compares against the home", 5.0, log.seenBefore(key, store[key] ?: 0.0), 0.0)
        // One opening moving it twice keeps what it said before the first.
        val twice = WikiSeenLog.key("stamp-twice")
        val again = WikiSeenLog()
        again.move(twice, 50.0, 1.0)
        again.move(twice, 50.002, 50.0)
        assertEquals(1.0, again.seenBefore(twice, 50.002), 0.0)
    }

    /** What is new: everything when nothing was seen; after that, what happened after the stamp. */
    @Test fun whatIsNewSinceTheReaderLastLooked() {
        val seen = RelativeTime.parse("2026-10-06T10:00:00.000Z")!!.toEpochMilli() / 1000.0
        assertTrue("never looked: all of it is new", WikiSeenLog.isNew("2026-10-06T09:00:00.000Z", 0.0))
        assertTrue(WikiSeenLog.isNew("2026-10-06T10:00:01.000Z", seen))
        assertFalse("at the stamp is not after it", WikiSeenLog.isNew("2026-10-06T10:00:00.000Z", seen))
        assertFalse(WikiSeenLog.isNew("2026-10-06T09:59:59.000Z", seen))
        assertFalse("a row with no time is not new", WikiSeenLog.isNew(null, seen))
        assertFalse(WikiSeenLog.isNew("not a time", seen))
    }

    // MARK: the store's choice

    /** Coming into the Wiki from a workspace opens the space bound to it; from a project's page, the space bound to the
     * workspace its coordinator runs in, as the project's read names it; from nowhere, the space last looked at. */
    @Test fun theStoreOpensTheSpaceBoundToWhereTheReaderWas() = runBlocking {
        val spaces = """[{"id":"s1","slug":"orbit","title":"orbit","repoUrlNorm":"github.com/jianghailong-xy/orbit","workspaceIds":["ws-orbit"],"docs":{"written":5,"total":35}},
            {"id":"s2","slug":"wikova","title":"wikova","repoUrlNorm":"github.com/jianghailong-xy/wikova","workspaceIds":["ws-wikova"],"docs":{"written":12,"total":12}}]"""
        val rig = WikiTestRig { api ->
            when (api.path.joinToString("/")) {
                "wiki/spaces" -> 200 to spaces
                "projects/P1" -> 200 to """{"id":"P1","title":"Orbit","coordinatorWorkspaceId":"ws-orbit"}"""
                else -> null
            }
        }
        val store = rig.store()
        store.loadSpaces()
        assertEquals("the first time, nothing to go on: the most documents written", "wikova", store.state.value.currentSpace?.slug)
        store.open(WikiFrom(workspaceId = "ws-orbit"))
        assertEquals("orbit", store.state.value.currentSpace?.slug)
        store.open(WikiFrom())
        assertEquals("from nowhere: the space last looked at", "orbit", store.state.value.currentSpace?.slug)
        store.select("wikova")
        store.open(WikiFrom(projectId = "P1"))
        assertEquals("a project's page: its coordinator's workspace", "orbit", store.state.value.currentSpace?.slug)
        assertTrue(rig.requests.any { rig.line(it) == "GET /api/projects/P1" })
    }
}
