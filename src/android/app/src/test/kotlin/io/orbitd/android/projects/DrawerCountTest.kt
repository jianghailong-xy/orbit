package io.orbitd.android.projects

import io.orbitd.android.core.cards.text
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.SessionProjectGrouping
import io.orbitd.android.directory.SessionProjectMembership
import io.orbitd.android.navigation.DrawerCopy
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A11-2's rest: a drawer project row's amber count, counted as M2's iOS counts it (OrbitKit `ProjectAttention.needsYouItemCount`,
 * the cases of `ProjectAttentionTests`' drawer tests; web's `projectNeedsYouCount`) — the four owner items by their counts, and a
 * coordinator asking to start the project or to record it done as one each; nothing for a closed project or a kind this build
 * does not name. A05f: the rest of the drawer as M2's iOS has it, case for case with `ProjectAttentionTests`' "the drawer" and "the
 * drawer, beside the live session list" — the rows' order (`drawerProjects`), their running mark (`drawerMark`), the coordinator
 * pulses read off the Open list (`coordinatorPulses`) and the Projects row's count (`needsYouCount`). */
class DrawerCountTest {
    private val now = Instant.parse("2026-10-05T00:00:00Z")
    private fun at(secondsAgo: Long) = now.minusSeconds(secondsAgo).toString()
    private fun item(kind: String, count: Int, waited: Long = 3600) = """{"kind":"$kind","count":$count,"oldestWaitingSince":"${at(waited)}"}"""
    private fun project(attention: String, status: String = "OPEN") =
        Json.parseToJsonElement("""{"id":"p","title":"P","status":"$status","buckets":{"running":1},"attention":$attention}""").jsonObject
    private fun asking(waited: Long, vararg items: String) = """{"ownerItems":[${items.joinToString()}],"startRequest":{"waitingSince":"${at(waited)}"}}"""
    private fun closing(waited: Long, vararg items: String) = """{"ownerItems":[${items.joinToString()}],"doneRequest":{"waitingSince":"${at(waited)}"}}"""
    private fun count(attention: String, status: String = "OPEN") = ProjectAttention.needsYouItemCount(project(attention, status))

    @Test fun aStartRequestIsOneMoreThingWaitingOnYou() {
        assertEquals(1, count(asking(7200)))
        assertEquals(2, count(asking(60, item("COORDINATOR_QUESTION", 1, 60))))
        assertEquals("a closed project asks nothing, whatever it still carries", 0, count(asking(3600), "DONE"))
    }

    @Test fun aDoneRequestIsOneMoreThingWaitingOnYou() {
        assertEquals(1, count(closing(7200)))
        assertEquals(3, count(closing(60, item("ESCALATED", 2, 60))))
        assertEquals(0, count(closing(3600), "DONE"))
        assertEquals("both requests at once are two", 2, count("""{"ownerItems":[],"startRequest":{"waitingSince":"${at(60)}"},"doneRequest":{"waitingSince":"${at(60)}"}}"""))
    }

    @Test fun theCountIsTheItemsWaitingOnYouNotTheirKinds() {
        assertEquals(3, count("""{"ownerItems":[${item("PROMOTION_APPROVAL", 1)},${item("COORDINATOR_QUESTION", 2, 60)},${item("SOMETHING_NEW", 4)}]}"""))
        assertEquals(1, count("""{"ownerItems":[${item("FUSE_PAUSED", 1)},${item("ESCALATED", 0)}]}"""))
    }

    @Test fun quietProjectsUnknownKindsAndUnreadableRequestsCountNothing() {
        assertEquals(0, count("""{"ownerItems":[],"userBlockers":2,"coordinatorBlockers":1}"""))
        assertEquals(0, count("""{"ownerItems":[${item("SOMETHING_NEW", 1)}]}"""))
        assertEquals("a request this build cannot read names none", 0, count("""{"ownerItems":[],"doneRequest":{"since":1},"startRequest":null}"""))
        assertEquals(0, ProjectAttention.needsYouItemCount(Json.parseToJsonElement("""{"id":"p","status":"OPEN"}""").jsonObject))
    }

    /** Revision 29's fifth owner item (owner 2026-10-28): work that reached main without the owner's confirmation waits on them by its
     * count, leads the row's chip in the owner tier in its kind word, and on a tie with the other four comes last — the web's
     * `projectAttention.test.ts`, case for case. */
    @Test fun workThatLandedWithoutYourConfirmationIsWaitingOnYou() {
        assertEquals(2, count("""{"ownerItems":[${item("LANDED_WITHOUT_CONFIRMATION", 2, 4 * 3600)}]}"""))
        val landed = project("""{"ownerItems":[${item("LANDED_WITHOUT_CONFIRMATION", 1, 2 * 3600)}]}""")
        assertEquals(AttentionReason.LANDED_WITHOUT_CONFIRMATION, ProjectAttention.reason(landed, now))
        assertEquals(ProjectLane.ATTENTION, ProjectAttention.lane(landed, now))
        assertEquals(AttentionChip(true, "Needs you · Landed without your confirmation · 2h"), ProjectAttention.chip(landed, now))
        assertEquals(DrawerMark.NeedsYou(1), ProjectAttention.drawerMark(landed))
        val older = project("""{"ownerItems":[${item("COORDINATOR_QUESTION", 1, 35 * 60)},${item("LANDED_WITHOUT_CONFIRMATION", 1, 3 * 3600)}]}""")
        assertEquals("the longest wait leads among the five", "Needs you · Landed without your confirmation · 3h", ProjectAttention.chip(older, now)?.text)
        val tied = project("""{"ownerItems":[${item("LANDED_WITHOUT_CONFIRMATION", 1, 3600)},${item("FUSE_PAUSED", 1, 3600)}]}""")
        assertEquals("a tie goes to the contract's order, where it is last", AttentionReason.FUSE_PAUSED, ProjectAttention.reason(tied, now))
        assertEquals("a closed project asks nothing", 0, count("""{"ownerItems":[${item("LANDED_WITHOUT_CONFIRMATION", 1)}]}""", "DONE"))
    }

    /** The rule and the row as M2's Swift states them, so a change there fails here rather than drifting. */
    @Test fun theSwiftCountsAndSaysItTheSameWay() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
        val attention = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/ProjectAttention.swift").readText()
        assertTrue(attention.contains("waitingOwnerItems(project).reduce(0) { \$0 + \$1.count } + (waitingStartRequest(project) != nil ? 1 : 0)\n" +
            "            + (waitingDoneRequest(project) != nil ? 1 : 0)"))
        assertTrue(attention.contains("(project.attention?.ownerItems ?? []).filter { \$0.kind != .unknown && \$0.count > 0 }"))
        assertTrue(attention.contains("if waiting > 0 { return .needsYou(waiting) }"))
        val shell = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/CompactShell.swift").readText()
        assertTrue(shell.contains("case .needsYou(let count):\n                        NeedsYouCountCapsule(count: count)"))
        val capsule = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift").readText()
        assertTrue(capsule.contains(".accessibilityLabel(\"\\(count) waiting for you\")"))
        assertEquals("3 waiting for you", DrawerCopy.waitingForYou(3))
    }

    // A05f · the rows' order, their running mark and the Projects row's count (`ProjectAttentionTests`, `MARK: the drawer`).

    private val minute = 60L
    private val hour = 3_600L
    /** `ProjectAttention.quietInterval`: one full day. */
    private val quiet = 86_400L
    private var nextId = 0

    /** A row as `ProjectAttentionTests.project` builds one: the buckets it names and, unless told otherwise, activity an hour ago when
     * it has any task at all. */
    private fun row(title: String, status: String = "OPEN", running: Int = 0, ready: Int = 0, blocked: Int = 0, done: Int = 0,
        active: String? = null, attention: String? = null, integration: String? = null, coordinatorActivity: String? = null,
        id: String? = null, createdAt: String = "2026-01-01T00:00:00.000Z"): JsonObject {
        nextId++
        val tasks = running + ready + blocked + done
        val activity = active ?: if (tasks > 0) at(hour) else null
        return Json.parseToJsonElement(buildString {
            append("""{"id":"${id ?: "0195c0de-0000-7000-8000-%012d".format(nextId)}","title":"$title","status":"$status","createdAt":"$createdAt",""")
            append(""""_count":{"tasks":$tasks},"buckets":{"running":$running,"ready":$ready,"blocked":$blocked,"done":$done,"cancelled":0}""")
            activity?.let { append(""","lastActivityAt":"$it"""") }
            attention?.let { append(""","attention":$it""") }
            integration?.let { append(""","integration":$it""") }
            coordinatorActivity?.let { append(""","coordinatorActivity":$it""") }
            append("}")
        }).jsonObject
    }
    private fun waitingOn(vararg items: String) = """{"ownerItems":[${items.joinToString()}]}"""
    private fun titles(rows: List<JsonObject>) = rows.map { it.text("title") }
    private fun drawer(vararg rows: JsonObject, coordinators: Map<String, CoordinatorPulse> = emptyMap()) =
        titles(ProjectAttention.drawerProjects(rows.toList(), coordinators))

    @Test fun theDrawerListsOpenProjectsWaitingOnYouFirstThenByActivity() {
        val quietNeedsYou = row("Question", active = at(9 * quiet), attention = waitingOn(item("COORDINATOR_QUESTION", 1, hour)))
        val olderNeedsYou = row("Merge", attention = waitingOn(item("PROMOTION_APPROVAL", 1, 3 * hour)))
        val recent = row("Recent", running = 1, active = at(minute))
        val stale = row("Stale", ready = 1, active = at(5 * quiet))
        val closed = row("Closed", status = "DONE", done = 1, active = at(minute))

        assertEquals(listOf("Merge", "Question", "Recent", "Stale"), drawer(stale, closed, recent, quietNeedsYou, olderNeedsYou))
        assertEquals(2, ProjectAttention.needsYouCount(listOf(stale, closed, recent, quietNeedsYou, olderNeedsYou)))
        assertEquals(DrawerMark.NeedsYou(1), ProjectAttention.drawerMark(olderNeedsYou))
        assertEquals(DrawerMark.Running, ProjectAttention.drawerMark(recent))
        assertEquals(DrawerMark.Idle, ProjectAttention.drawerMark(stale))
    }

    /** `testTheDrawerCountsAStartRequestAsOneMoreThingWaitingOnYou` and its done-request twin: each request waits in line with the
     * four, by its own wait. */
    @Test fun aStartOrADoneRequestWaitsInLineByItsWait() {
        val start = row("Start", attention = asking(2 * hour))
        val merge = row("Merge", attention = waitingOn(item("PROMOTION_APPROVAL", 1, hour)))
        val both = row("Both", attention = asking(minute, item("COORDINATOR_QUESTION", 1, minute)))
        val recent = row("Recent", running = 1, active = at(minute))
        assertEquals(DrawerMark.NeedsYou(1), ProjectAttention.drawerMark(start))
        assertEquals(DrawerMark.NeedsYou(2), ProjectAttention.drawerMark(both))
        assertEquals("longest wait first, the start request's wait counted as the four's are", listOf("Start", "Merge", "Both", "Recent"),
            drawer(recent, both, merge, start))
        assertEquals(3, ProjectAttention.needsYouCount(listOf(recent, both, merge, start)))

        val close = row("Close", attention = closing(2 * hour))
        assertEquals(DrawerMark.NeedsYou(1), ProjectAttention.drawerMark(close))
        assertEquals(DrawerMark.NeedsYou(3), ProjectAttention.drawerMark(row("Escalated", attention = closing(minute, item("ESCALATED", 2, minute)))))
        assertEquals(listOf("Close", "Merge", "Recent"), drawer(recent, merge, close))
        assertEquals(2, ProjectAttention.needsYouCount(listOf(recent, merge, close)))
    }

    @Test fun theMarkIsTheItemsWaitingOnYouAndOutranksRunning() {
        val busy = row("Busy", running = 2, attention = waitingOn(item("PROMOTION_APPROVAL", 1, hour), item("COORDINATOR_QUESTION", 2, minute),
            item("SOMETHING_NEW", 4, hour)))
        assertEquals("the count is the items waiting on you, not their kinds, and it outranks running", DrawerMark.NeedsYou(3),
            ProjectAttention.drawerMark(busy))
    }

    @Test fun theProjectsCountIgnoresQuietProjectsAndUnknownKinds() {
        val stale = row("Stale", ready = 1, active = at(5 * quiet))
        val unknown = row("Unknown", attention = waitingOn(item("SOMETHING_NEW", 1, hour)))
        assertEquals(0, ProjectAttention.needsYouCount(listOf(stale, unknown)))
    }

    /** `testAWorkingCoordinatorKeepsTheIndexAndDrawerActive`, `testLandingAndMergingKeepTheProjectActiveAfterTaskWorkFinishes`,
     * `testAnIntegrationExceptionAndAnOlderServerDoNotCountAsActivity`, `testLandingExceptionOutranksAllTasksDoneAndWaitsUntilARetryStarts`:
     * what makes a project with nothing waiting read as running — tasks running, its coordinator working, a landing in flight. */
    @Test fun aWorkingCoordinatorOrALandingInFlightMarksTheProjectRunning() {
        val coordinating = row("Coordinating", done = 1, active = at(2 * quiet), coordinatorActivity = """{"working":true,"lastTurnAt":"${at(minute)}"}""")
        assertEquals(DrawerMark.Running, ProjectAttention.drawerMark(coordinating))
        assertEquals("the live session pulse outranks the fetched snapshot", DrawerMark.Idle,
            ProjectAttention.drawerMark(coordinating, CoordinatorPulse(working = false, lastTurnAt = at(0))))
        for (blocked in listOf(0, 17)) {
            val landing = row("Landing", blocked = blocked, done = 1, active = at(2 * quiet), integration = """{"line":"PROJECT_BRANCH","ref":"project/x","activeJobCount":1}""")
            assertEquals(DrawerMark.Running, ProjectAttention.drawerMark(landing))
        }
        for (jobs in listOf(""","activeJobCount":0""", "")) {
            val held = row("Held", blocked = 1, done = 1, integration = """{"line":"PROJECT_BRANCH","ref":"project/x"$jobs}""")
            assertEquals("an integration exception and an older server are not activity", DrawerMark.Idle, ProjectAttention.drawerMark(held))
        }
        for (jobs in listOf(0, 1)) {
            val failedCheck = row("Check failed", done = 4, integration = """{"line":"PROJECT_BRANCH","ref":"project/x","activeJobCount":$jobs}""",
                attention = """{"coordinatorItems":{"count":1,"leadKind":"INTEGRATION_CHECK_FAILED","oldestWaitingSince":"${at(3 * hour)}"}}""")
            assertEquals(if (jobs == 0) DrawerMark.Idle else DrawerMark.Running, ProjectAttention.drawerMark(failedCheck))
        }
    }

    // `MARK: the drawer, beside the live session list`.

    /** A project's coordinator conversation as the Open list carries it: its membership in the public spelling the list serves,
     * whatever spelling the project row came in. */
    private fun coordinator(of: JsonObject, runState: String, lastTurn: Long, engineTurnActive: Boolean = false) =
        DirectorySession("s-${of.text("id")}", status = "CANCELLED", runState = runState, agentId = "a", lastTurnAt = at(lastTurn),
            engineTurnActive = engineTurnActive, projectMembership = SessionProjectMembership(ObjectId.toPublic(of.text("id")!!), "", "OPEN", "COORDINATOR"))
    private fun pulse(pulses: Map<String, CoordinatorPulse>, of: JsonObject) = pulses[SessionProjectGrouping.key(of.text("id")!!)]

    @Test fun aWorkingCoordinatorMarksItsProjectRunningAndSortsItByItsTurn() {
        val busyTasks = row("FineWeb", running = 2, active = at(20 * minute))
        val coordinated = row("Account pool", ready = 2, active = at(10 * quiet))
        val idle = row("Quiet", ready = 1, active = at(hour))
        val pulses = ProjectAttention.coordinatorPulses(listOf(
            coordinator(coordinated, "RUNNING", minute),
            coordinator(idle, "AWAITING_INPUT", 30 * quiet)))

        assertEquals("a coordinator's turn a minute ago is newer than any task write", listOf("Account pool", "FineWeb", "Quiet"),
            drawer(busyTasks, coordinated, idle, coordinators = pulses))
        assertEquals("without the session list: task activity alone", listOf("FineWeb", "Quiet", "Account pool"), drawer(busyTasks, coordinated, idle))
        assertEquals(DrawerMark.Running, ProjectAttention.drawerMark(coordinated, pulse(pulses, coordinated)))
        assertEquals(DrawerMark.Idle, ProjectAttention.drawerMark(coordinated))
        assertEquals("a coordinator waiting for a reply is not working", DrawerMark.Idle, ProjectAttention.drawerMark(idle, pulse(pulses, idle)))
    }

    @Test fun aCoordinatorIsWorkingExactlyWhenTheSessionListDrawsItsSpinner() {
        val p = row("P")
        assertEquals(true, pulse(ProjectAttention.coordinatorPulses(listOf(coordinator(p, "AWAITING_INPUT", minute, engineTurnActive = true))), p)?.working)
        assertEquals(false, pulse(ProjectAttention.coordinatorPulses(listOf(coordinator(p, "QUEUED", minute))), p)?.working)
        val ordinary = DirectorySession("x", status = "CANCELLED", runState = "RUNNING", agentId = "a")
        assertTrue("a session that coordinates nothing is nobody's coordinator", ProjectAttention.coordinatorPulses(listOf(ordinary)).isEmpty())
        // Android reads the coordinator off the membership, where iOS reads `Session.projectId` (set on coordinators alone): the
        // server derives both from `project.coordinator_session_id`. A member in any other role is not the coordinator.
        val member = coordinator(p, "RUNNING", minute).copy(projectMembership = SessionProjectMembership(p.text("id")!!, "P", "OPEN", "TASK"))
        assertTrue(ProjectAttention.coordinatorPulses(listOf(member)).isEmpty())
    }

    /** The Swift's last two keys, which no iOS case reaches: the newest created first, then by id. A wait that cannot be read is
     * unknown, and goes after every wait that can. */
    @Test fun rowsTheEarlierKeysTieGoNewestCreatedFirstThenById() {
        val older = row("Older", id = "p-a", createdAt = "2026-01-01T00:00:00.000Z")
        val newer = row("Newer", id = "p-c", createdAt = "2026-01-02T00:00:00.000Z")
        val sameAge = row("Same age", id = "p-b", createdAt = "2026-01-01T00:00:00.000Z")
        assertEquals(listOf("Newer", "Older", "Same age"), drawer(sameAge, older, newer))
        val unreadable = row("Unreadable", attention = """{"ownerItems":[{"kind":"ESCALATED","count":1,"oldestWaitingSince":"soon"}]}""")
        val asked = row("Asked", attention = waitingOn(item("ESCALATED", 1, minute)))
        assertEquals(listOf("Asked", "Unreadable", "Newer"), drawer(newer, unreadable, asked))
    }

    /** The order, the running mark, the rows' label and the Projects row's count as M2's Swift states them, so a change there fails
     * here rather than drifting. */
    @Test fun theSwiftOrdersMarksAndHeadsTheRowsTheSameWay() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
        val attention = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/ProjectAttention.swift").readText()
        assertTrue(attention.contains("if project.buckets.running > 0 || (coordinator ?? project.coordinatorActivity)?.working == true\n" +
            "            || (project.integration?.activeJobCount ?? 0) > 0 { return .running }"))
        assertTrue(attention.contains("all.filter { \$0.status == .open }.sorted { a, b in\n" +
            "            let aNeeds = needsYou(a), bNeeds = needsYou(b)\n" +
            "            if aNeeds != bNeeds { return aNeeds }\n" +
            "            if aNeeds {\n" +
            "                let byWait = byInstantAsc(oldestWait(a), oldestWait(b))\n" +
            "                if byWait != 0 { return byWait < 0 }\n" +
            "            }\n" +
            "            let byActivity = byInstantDesc(latestActivity(a, coordinators), latestActivity(b, coordinators))\n" +
            "            if byActivity != 0 { return byActivity < 0 }\n" +
            "            let byCreated = byInstantDesc(a.createdAt, b.createdAt)\n" +
            "            if byCreated != 0 { return byCreated < 0 }\n" +
            "            return a.id < b.id"))
        assertTrue(attention.contains("let turn = (coordinators[PublicID.storageKey(project.id)] ?? project.coordinatorActivity)?.lastTurnAt\n" +
            "        return rank(turn) > rank(project.lastActivityAt) ? turn : project.lastActivityAt"))
        assertTrue(attention.contains("if case .spinner = SessionStatusGlyph.make(for: session).shape { working = true }"))
        assertTrue(attention.contains("all.filter(needsYou).count"))
        val model = File(root, "src/macos/OrbitApp/Sources/OrbitApp/ProjectsModel.swift").readText()
        assertTrue(model.contains("var needsYouCount: Int { ProjectAttention.needsYouCount(projects) }"))
        val shell = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/CompactShell.swift").readText()
        assertTrue(shell.contains("let open = model.projects?.drawerProjects(coordinators: model.projectCoordinators) ?? []\n" +
            "        if !open.isEmpty {\n" +
            "            drawerGroupLabel(AppSection.projects.title, count: open.count)"))
        assertTrue(shell.contains("case .running:\n" +
            "                        if live {\n" +
            "                            SpinnerGlyph(color: .secondary)\n" +
            "                                .accessibilityLabel(\"Running\")"))
        assertTrue(shell.contains("let waiting = model.projects?.needsYouCount ?? 0"))
        assertTrue(shell.contains(".accessibilityLabel(\"\\(waiting) waiting on you\")"))
        assertTrue(shell.contains("NavigationDrawer(close: closeDrawer, live: progress > 0)"))
        val section = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/AppSection.swift").readText()
        assertTrue(section.contains("case .projects: return \"Projects\""))
        assertEquals("Projects", DrawerCopy.projects)
        assertEquals("Running", DrawerCopy.running)
        assertEquals("2 waiting on you", DrawerCopy.waitingOnYou(2))
    }
}
