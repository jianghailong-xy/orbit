package io.orbitd.android.directory

import io.orbitd.android.directory.SessionLine.Tone
import io.orbitd.android.directory.SessionProjectRow.Indicator
import io.orbitd.android.directory.SessionProjectRow.Target
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.watch.WatchFixture
import io.orbitd.android.watch.WatchSessionSummary
import io.orbitd.android.watch.watchKey
import java.time.Instant
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit's `SessionProjectGroupingTests`, `SessionProjectLandingLineTests`, `SessionProjectCopyTests` and
 * `SessionProjectMembersTests`, case for case (A05-6, A05-7). Folder rows are Android's own; what they count is [SessionProjectListing.assigned]. */
class SessionProjectsTest {
    private var now = Instant.parse("2026-10-04T10:00:00Z")
    private fun ago(minutes: Double): String = DateTimeFormatter.ISO_INSTANT.format(now.minusMillis((minutes * 60_000).toLong()))
    private fun ago(minutes: Int) = ago(minutes.toDouble())

    private fun session(id: String, role: String? = "TASK", projectId: String = "p1", projectStatus: String = "OPEN", title: String? = null,
        folder: String? = null, state: String = "AWAITING_INPUT", approvals: Int = 0, waitingKind: String? = null, since: List<String> = emptyList(),
        bg: Int = 0, jobs: Int = 0, subagents: Int = 0, pinnedAt: String? = null, lastTurnAt: String? = "2026-10-04T09:40:00Z",
        createdAt: String? = "2026-10-04T09:00:00Z", reply: String? = "Last reply", userText: String? = null, tool: String? = null,
        review: JsonObject? = null, workspace: String = "w1", lifecycle: String? = null) =
        DirectorySession(id, title ?: id, status = "AWAITING_INPUT", runState = state, lifecycleState = lifecycle, agentId = workspace,
            pendingApprovals = approvals, waitingKind = waitingKind,
            ownerItems = JsonArray(since.mapIndexed { index, at -> buildJsonObject { put("itemId", "$id-$index"); put("kind", "COORDINATOR_QUESTION"); put("title", "Question"); put("since", at) } }),
            lastAssistantText = reply, lastToolUse = tool, lastUserText = userText, runningBgCount = bg, runningBgJobCount = jobs,
            runningSubagentCount = subagents, pinnedAt = pinnedAt, createdAt = createdAt, lastTurnAt = lastTurnAt, folderId = folder,
            confirmationUnderReview = review, projectMembership = role?.let { SessionProjectMembership(projectId, "Project one", projectStatus, it) })

    private fun coordinator(folder: String? = null, approvals: Int = 0, pinnedAt: String? = null, lastTurnAt: String? = "2026-10-04T09:40:00Z") =
        session("coordinator", role = "COORDINATOR", folder = folder, approvals = approvals, pinnedAt = pinnedAt, lastTurnAt = lastTurnAt)

    private fun folder(id: String, name: String) = Folder(id, "w1", name)
    private fun held(kind: String, since: String) = buildJsonObject { put("count", 1); put("leadKind", kind); put("oldestWaitingSince", since) }

    private fun project(held: JsonObject? = null, integration: JsonObject? = null, title: String = "Project summary",
        counts: Triple<Int, Int, Int> = Triple(3, 1, 8)) = buildJsonObject {
        put("id", "p1"); put("title", title); put("status", "OPEN"); putJsonObject("buckets") { put("running", 2) }
        put("lastActivityAt", ago(1)); putJsonObject("attention") { held?.let { put("coordinatorItems", it) } }
        integration?.let { put("integration", it) }
        putJsonObject("taskCounts") { put("done", counts.first); put("failed", counts.second); put("total", counts.third) }
    }

    private fun listing(sessions: List<DirectorySession>, view: SessionView = SessionView.OPEN, byTag: Boolean = false, searching: Boolean = false,
        folderId: String? = null, offline: Boolean = false, projects: List<JsonObject>? = null, folders: List<Folder> = emptyList(),
        coordinators: List<DirectorySession> = emptyList(), content: List<DirectorySession>? = null,
        watching: Map<String, WatchSessionSummary> = emptyMap(), line: ((DirectorySession) -> SessionLine)? = null) =
        SessionProjectGrouping.listing(sessions, folders, projects ?: listOf(project()), view, byTag, searching, folderId, offline, now,
            coordinators, content, watching, line)
    private fun make(s: DirectorySession, watching: WatchSessionSummary? = null) = SessionLine.make(s, true, watching, now)
    private fun counted(listing: SessionProjectListing, folder: String) = listing.assigned.filter { it.folderId == folder }

    @Test fun allMembershipRolesMergeInOpenAndCompleted() {
        val members = listOf(coordinator()) + listOf("TASK", "CONTEXT", "JUDGMENT", "CHILD").map { session(it, role = it) }
        for (view in listOf(SessionView.OPEN, SessionView.COMPLETED)) {
            val out = listing(members + session("ordinary", role = null), view = view)
            assertEquals(1, out.projects.size)
            assertEquals(members, out.projects.first().members)
            assertEquals("Project summary", out.projects.first().title)
            assertEquals(listOf("ordinary"), out.sessions.map { it.id })
            assertEquals(listOf("ordinary", "p1"), out.entries.map { it.id })
        }
    }

    @Test fun trashTagsAndSearchKeepFiledMembersFlat() {
        val sessions = listOf(coordinator(folder = "f1"), session("worker"), session("ordinary", role = null))
        for ((view, byTag, searching) in listOf(Triple(SessionView.TRASH, false, false), Triple(SessionView.OPEN, true, false),
            Triple(SessionView.COMPLETED, true, false), Triple(SessionView.OPEN, false, true))) {
            val out = listing(sessions, view = view, byTag = byTag, searching = searching, folders = listOf(folder("f1", "Filed")))
            assertEquals(sessions, out.sessions)
            assertTrue(out.projects.isEmpty())
            assertEquals(sessions, out.assigned)
            assertEquals(sessions.map { SessionProjectEntry.Session(it) }, out.entries)
        }
        assertTrue(SessionProjectGrouping.listShowsProjects(SessionView.OPEN, byTag = false))
        assertTrue(SessionProjectGrouping.listShowsProjects(SessionView.COMPLETED, byTag = false))
    }

    /** An older server's coordinator relation (`projectId` alone) is not a membership: the list stays flat. */
    @Test fun legacyProjectRelationDoesNotInventMembership() {
        val legacy = io.orbitd.android.core.protocol.Wire.json.decodeFromString(DirectorySession.serializer(),
            """{"id":"legacy","status":"AWAITING_INPUT","projectId":"p1","projectTitle":"Project one"}""")
        val out = listing(listOf(legacy, session("ordinary", role = null)))
        assertTrue(out.projects.isEmpty())
        assertEquals(listOf("legacy", "ordinary"), out.sessions.map { it.id })
    }

    @Test fun ordinaryOnlyListingPreservesInputOrderIncludingFolderPages() {
        val sessions = listOf(session("older", role = null, folder = "f1", lastTurnAt = ago(60)), session("newer", role = null, folder = "f1", lastTurnAt = ago(1)),
            session("pinned", role = null, folder = "f1", pinnedAt = ago(30)))
        assertEquals(sessions.map { SessionProjectEntry.Session(it) }, listing(sessions).entries)
        assertEquals(sessions.map { SessionProjectEntry.Session(it) }, listing(sessions, folderId = "f1", folders = listOf(folder("f1", "Filed"))).entries)
    }

    @Test fun doneProjectMissingFromSidebarUsesMembershipWithoutProgress() {
        val row = listing(listOf(session("done", projectStatus = "DONE")), view = SessionView.COMPLETED, projects = emptyList()).projects.first()
        assertEquals("DONE", row.status)
        assertEquals("Project one", row.title)
        assertNull(row.taskCounts)
        assertEquals(SessionLine("No coordinator", Tone.PREVIEW), row.line)
        assertEquals(Target.Project("p1"), row.target)
    }

    @Test fun onlyCoordinatorPinsAndLatestLocalActivityOrdersRows() {
        val out = listing(listOf(coordinator(lastTurnAt = ago(10_000)), session("worker", pinnedAt = ago(30), lastTurnAt = ago(1)),
            session("ordinary", role = null, lastTurnAt = ago(5))))
        assertNull(out.projects.first().pinnedAt)
        assertEquals(ago(1), out.projects.first().lastTurnAt)
        assertEquals(listOf("p1", "ordinary"), out.entries.map { it.id })
        val pinned = listing(listOf(coordinator(pinnedAt = ago(40), lastTurnAt = ago(10_000)), session("worker", lastTurnAt = ago(10_000)),
            session("ordinary", role = null, lastTurnAt = ago(1))))
        assertEquals(listOf("p1", "ordinary"), pinned.entries.map { it.id })
        assertEquals(ago(40), pinned.entries.first().pinnedAt)
        val completed = listing(listOf(coordinator(pinnedAt = ago(40), lastTurnAt = ago(10_000)), session("ordinary", role = null, lastTurnAt = ago(1))),
            view = SessionView.COMPLETED)
        assertEquals(listOf("ordinary", "p1"), completed.entries.map { it.id })
    }

    @Test fun newMemberUsesCreatedAtIgnoringGlobalProjectActivity() {
        assertEquals(ago(2), listing(listOf(coordinator(), session("new", lastTurnAt = null, createdAt = ago(2)))).projects.first().lastTurnAt)
    }

    @Test fun coordinatorFolderOwnsAllMemberCountsAndActivityWithoutMutatingInputs() {
        val folders = listOf(folder("f1", "Release"), folder("f2", "Tasks"), folder("empty", "Empty"))
        val sessions = listOf(coordinator(folder = "f1"), session("worker", folder = "f2", state = "RUNNING"), session("waiting", approvals = 1),
            session("ordinary", role = null))
        val snapshot = sessions.toList()
        val out = listing(sessions, folders = folders)
        assertTrue(out.projects.isEmpty())
        assertEquals(listOf("ordinary"), out.sessions.map { it.id })
        assertEquals(listOf(3, 0, 0), listOf("f1", "f2", "empty").map { counted(out, it).size })
        assertEquals(listOf("coordinator", "worker", "waiting"), counted(out, "f1").map { it.id })
        val inside = listing(sessions, folderId = "f1", folders = folders)
        assertTrue(inside.sessions.isEmpty())
        assertEquals(sessions.dropLast(1), inside.projects.first().members)
        assertEquals(Indicator.NEEDS_YOU, inside.projects.first().indicator)
        assertTrue(listing(sessions, folderId = "f2", folders = folders).entries.isEmpty())
        assertEquals(snapshot, sessions)
        assertTrue(counted(listing(listOf(coordinator(folder = "f1"), session("worker", state = "RUNNING")), folders = folders), "f1").any { it.isRunning() })
    }

    @Test fun completedCountsOnlyWhereTheCoordinatorIsAndADeletedFolderKeepsTheProjectVisible() {
        val out = listing(listOf(coordinator(folder = "gone"), session("worker", folder = "f1")), view = SessionView.COMPLETED, folders = listOf(folder("f1", "Old task folder")))
        assertTrue(counted(out, "f1").isEmpty())
        assertEquals(1, out.projects.size)
        val filed = listing(listOf(coordinator(folder = "f1"), session("worker", folder = "f2")), view = SessionView.COMPLETED,
            folders = listOf(folder("f1", "Release"), folder("f2", "Tasks")))
        assertEquals(2, counted(filed, "f1").size)
        assertTrue(counted(filed, "f2").isEmpty())
    }

    @Test fun supplementalCoordinatorAffectsWordingAndPlacementOnly() {
        val coord = session("coordinator", role = "COORDINATOR", state = "RUNNING", pinnedAt = ago(5), lastTurnAt = ago(1), tool = "Bash")
        val worker = session("completed", lastTurnAt = ago(60))
        val row = listing(listOf(worker), view = SessionView.COMPLETED, coordinators = listOf(coord)).projects.first()
        assertEquals(coord, row.coordinator)
        assertEquals(ago(60), row.lastTurnAt)
        assertEquals(listOf(worker), row.members)
        assertEquals(1, row.sessionCount)
        assertNull(row.indicator)
        assertEquals(make(coord), row.line)
        assertEquals(Target.Session(coord.id), row.target)
        val filed = listing(listOf(worker), folders = listOf(folder("f1", "Release")), coordinators = listOf(coord.copy(folderId = "f1")))
        assertTrue(filed.projects.isEmpty())
        assertEquals(1, counted(filed, "f1").size)
        assertFalse(counted(filed, "f1").any { it.isRunning() })
    }

    @Test fun coordinatorWaitingWordsOutrankOlderWaitingMembers() {
        for (text in listOf("Approve merge to main", "Question from coordinator", "Escalated to you", "Paused", "Ready to start")) {
            val row = listing(listOf(coordinator(approvals = 1), session("older", approvals = 1, since = listOf(ago(90)))),
                line = { SessionLine(if (it.id == "coordinator") text else "Waiting", Tone.APPROVAL) }).projects.first()
            assertEquals(SessionLine(text, Tone.APPROVAL), row.line)
            assertEquals(Target.Session("coordinator"), row.target)
            assertEquals(Indicator.NEEDS_YOU, row.indicator)
        }
    }

    @Test fun longestWaitUsesOwnerItemSinceInsteadOfRecentActivity() {
        val old = session("old", title = "Quota retry", approvals = 1, waitingKind = "OWNER_CONFIRMATION", since = listOf(ago(10), "invalid", ago(90)), lastTurnAt = ago(1))
        val recent = session("recent", approvals = 1, since = listOf(ago(5)), lastTurnAt = ago(80))
        val row = listing(listOf(coordinator(), recent, old)).projects.first()
        assertEquals(SessionLine("Waiting for your confirmation · Quota retry", Tone.APPROVAL), row.line)
        assertEquals(Target.Session("old"), row.target)
    }

    @Test fun remoteWaitSuppliesContentWhileIndicatorAndTimeStayLocal() {
        val coord = coordinator()
        val local = session("local", state = "RUNNING", lastTurnAt = ago(20))
        val remote = session("remote", title = "Remote retry", approvals = 1, waitingKind = "OWNER_CONFIRMATION", since = listOf(ago(90)), lastTurnAt = ago(1))
        val unrelated = session("unrelated", projectId = "p2", approvals = 1, since = listOf(ago(120)))
        val content = listOf(coord, local, remote, unrelated)
        val row = listing(listOf(coord, local), content = content).projects.first()
        assertEquals(SessionLine("Waiting for your confirmation · Remote retry", Tone.APPROVAL), row.line)
        assertEquals(Target.Session("remote"), row.target)
        assertEquals(listOf(coord, local), row.members)
        assertEquals(3, row.sessionCount)
        assertEquals(Indicator.RUNNING, row.indicator)
        assertFalse(row.needsYou)
        assertEquals(ago(20), row.lastTurnAt)
        assertNull(listing(listOf(coord, session("local", lastTurnAt = ago(20))), content = content).projects.first().indicator)
        val both = listing(listOf(coord, session("local", approvals = 1, since = listOf(ago(5)))), content = content).projects.first()
        assertEquals(Target.Session("remote"), both.target)
        assertEquals(Indicator.NEEDS_YOU, both.indicator)
        assertEquals(2, listing(listOf(coord, local)).projects.first().sessionCount)
    }

    @Test fun legacyWaitUsesActivityAndInvalidInstantsSortLastWithIdTieBreak() {
        val row = listing(listOf(coordinator(), session("unknown", approvals = 1, lastTurnAt = "invalid", createdAt = null),
            session("z-known", approvals = 1, lastTurnAt = ago(30)), session("a-known", approvals = 1, lastTurnAt = ago(30)))).projects.first()
        assertEquals(Target.Session("a-known"), row.target)
    }

    @Test fun equalWaitUsesWebLocaleOrderingForMixedCasePublicIds() {
        val row = listing(listOf(coordinator(), session("Z", approvals = 1, since = listOf(ago(30))), session("a", approvals = 1, since = listOf(ago(30))))).projects.first()
        assertEquals(Target.Session("a"), row.target)
    }

    @Test fun everyCoordinatorExceptionUsesProjectWordsAndAge() {
        for ((kind, text) in listOf("INTEGRATION_CONFLICT" to "Resolving a merge conflict", "INTEGRATION_CHECK_FAILED" to "Checks failed",
            "INTEGRATION_ERROR" to "Handling an integration error", "TASK_FAILED" to "Handling a failed task", "DELIVERY_REVIEW" to "Reviewing a delivery")) {
            val row = listing(listOf(coordinator()), projects = listOf(project(held(kind, ago(18))))).projects.first()
            assertEquals(SessionLine("$text · 18m", Tone.RUNNING), row.line)
            assertEquals(Target.Session("coordinator"), row.target)
        }
    }

    @Test fun exceptionAgeMatchesWebBoundariesAndOmitsFutureOrInvalid() {
        for ((at, age) in listOf(ago(0.5) to " · <1m", ago(120) to " · 2h", ago(4_320) to " · 3d", ago(-1) to "", "invalid" to "")) {
            assertEquals("Resolving a merge conflict$age",
                listing(listOf(coordinator()), projects = listOf(project(held("INTEGRATION_CONFLICT", at)))).projects.first().line.text)
        }
    }

    @Test fun waitingOutranksCoordinatorException() {
        val row = listing(listOf(coordinator(), session("worker", approvals = 1)), projects = listOf(project(held("TASK_FAILED", ago(18))))).projects.first()
        assertEquals(Target.Session("worker"), row.target)
        assertEquals(Tone.APPROVAL, row.line.tone)
    }

    @Test fun ordinaryCoordinatorLineIsVerbatimAndTargetsCoordinator() {
        for (coord in listOf(session("coordinator", role = "COORDINATOR", state = "RUNNING", tool = "Bash"), session("coordinator", role = "COORDINATOR", userText = "Continue"),
            session("coordinator", role = "COORDINATOR", reply = "Finished the requested change."))) {
            val row = listing(listOf(coord)).projects.first()
            assertEquals(make(coord), row.line)
            assertEquals(Target.Session("coordinator"), row.target)
        }
    }

    @Test fun noCoordinatorTargetsProjectUnlessMemberWaits() {
        assertEquals(Target.Project("p1"), listing(listOf(session("worker"))).projects.first().target)
        assertEquals(SessionLine("No coordinator", Tone.PREVIEW), listing(listOf(session("worker")), projects = listOf(project(held("TASK_FAILED", ago(18))))).projects.first().line)
        assertEquals(Target.Session("worker"), listing(listOf(session("worker", approvals = 1))).projects.first().target)
    }

    @Test fun indicatorUsesSharedReadingsWaitingThenRunningThenJobs() {
        val coord = coordinator()
        val background = session("background", bg = 2, jobs = 1)
        val service = session("service", bg = 1)
        val running = session("running", state = "RUNNING")
        val waiting = session("waiting", approvals = 1)
        assertEquals(Indicator.NEEDS_YOU, listing(listOf(coord, background, running, waiting)).projects.first().indicator)
        assertEquals(Indicator.RUNNING, listing(listOf(coord, background, running)).projects.first().indicator)
        assertTrue(running.isRunning())
        assertEquals(Indicator.JOBS, listing(listOf(coord, background, service)).projects.first().indicator)
        assertTrue(background.isRunningJob())
        assertNull(listing(listOf(coord, service)).projects.first().indicator)
        assertNull(listing(listOf(coord)).projects.first().indicator)
        assertEquals(Indicator.RUNNING, listing(listOf(coord, session("subagent", subagents = 1))).projects.first().indicator)
    }

    @Test fun sidebarRunningCountsNeverCreateLocalMotionAndOfflineSuppressesMotionOnly() {
        val coord = coordinator()
        assertEquals(2, listing(listOf(coord)).projects.first().runningCount)
        assertEquals(ProjectTaskCounts(3, 1, 8), listing(listOf(coord)).projects.first().taskCounts)
        assertNull(listing(listOf(coord)).projects.first().indicator)
        val running = session("running", state = "RUNNING")
        val offline = listing(listOf(coord, running, session("background", bg = 1, jobs = 1)), offline = true).projects.first()
        assertFalse(offline.running); assertFalse(offline.jobs); assertNull(offline.indicator)
        assertEquals(1, listing(listOf(coord, running), projects = emptyList()).projects.first().runningCount)
        assertEquals(0, listing(listOf(coord, running), offline = true, projects = emptyList()).projects.first().runningCount)
        assertEquals(Indicator.NEEDS_YOU, listing(listOf(coord, running, session("waiting", approvals = 1)), offline = true).projects.first().indicator)
    }

    @Test fun readyToStartIsAmberOnTheRow() {
        val coord = session("coordinator", role = "COORDINATOR", folder = "f1", approvals = 1, waitingKind = "START_REQUEST")
        val inside = listing(listOf(coord), folderId = "f1", folders = listOf(folder("f1", "Filed"))).projects.first()
        assertEquals(Indicator.NEEDS_YOU, inside.indicator)
        assertEquals("Ready to start", inside.line.text)
    }

    @Test fun underReviewIsNeitherWaitingNorRunning() {
        val review = buildJsonObject { put("requestId", "r1"); put("taskId", "t1"); put("reviewerTitle", "Reviewer"); put("since", ago(18)); put("dueAt", ago(-60)) }
        val coord = session("coordinator", role = "COORDINATOR", review = review)
        val row = listing(listOf(coord)).projects.first()
        assertEquals(make(coord), row.line)
        assertEquals(Tone.REVIEW, row.line.tone)
        assertEquals(Target.Session("coordinator"), row.target)
        assertNull(row.indicator)
    }

    @Test fun watchSuppressesBackgroundJobMotionJustLikeTheSessionGlyph() {
        val coord = session("coordinator", role = "COORDINATOR", bg = 1, jobs = 1)
        val watch = WatchSessionSummary(listOf(WatchFixture.watch(observer = coord.id)))
        val watches = mapOf(watchKey(coord.id) to watch)
        assertFalse(coord.isRunningJob(watch))
        val row = listing(listOf(coord), watching = watches).projects.first()
        assertEquals(make(coord, watch), row.line)
        assertEquals(Tone.WATCHING, row.line.tone)
        assertNull(row.indicator)
        assertEquals(Indicator.RUNNING, listing(listOf(coord, session("worker", state = "RUNNING")), watching = watches).projects.first().indicator)
    }

    /** Both spellings of a project id are one project; the row keeps the members' spelling. */
    @Test fun eitherSpellingOfTheProjectIdIsOneProject() {
        val uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"
        val row = listing(listOf(session("coordinator", role = "COORDINATOR", projectId = ObjectId.toPublic(uuid)), session("worker", projectId = uuid)),
            projects = listOf(JsonObject(project() + ("id" to JsonPrimitive(uuid))))).projects.single()
        assertEquals(2, row.members.size)
        assertEquals("Project summary", row.title)
        assertEquals(ObjectId.toPublic(uuid), row.projectId)
    }

    // SessionProjectLandingLineTests

    private fun inFlight(state: String, startedAt: String, kind: String, taskTitle: String? = null, phase: String? = null, heartbeatAt: String? = null) =
        buildJsonObject { put("state", state); put("startedAt", startedAt); put("kind", kind); taskTitle?.let { put("taskTitle", it) }
            phase?.let { put("phase", it) }; heartbeatAt?.let { put("heartbeatAt", it) } }
    private fun integration(count: Int, job: JsonObject? = null) = buildJsonObject {
        put("line", "MAIN"); put("ref", "main"); put("activeJobCount", count); job?.let { put("inFlight", it) } }
    private fun queued(count: Int = 1) = integration(count, inFlight("QUEUED", ago(13), "LAND_PROMOTION"))
    private fun landingNow() { now = Instant.parse("2026-10-05T11:24:00Z") }
    private fun row(sessions: List<DirectorySession>, summary: JsonObject) = listing(sessions, projects = listOf(summary)).projects.firstOrNull()
    private fun landingProject(integration: JsonObject?, held: JsonObject? = null) = project(held, integration, "Project one", Triple(12, 0, 15))

    @Test fun theLineSaysTheJobItsStateAndItsWaitInMinutes() {
        landingNow()
        assertEquals(SessionLine("Merge to main · queued · 13m", Tone.QUEUED), SessionProjectCopy.landingLine(queued(), now))
        val landing = integration(1, inFlight("RUNNING", ago(4), "LAND_TASK", "P5：接通 Web、macOS 和 iOS", "CHECK", ago(0)))
        assertEquals(SessionLine("Landing · checking · 4m · P5：接通 Web、macOS 和 iOS", Tone.RUNNING), SessionProjectCopy.landingLine(landing, now))
    }

    @Test fun severalJobsAreCountedInsteadOfNamingOneTask() {
        landingNow()
        assertEquals(SessionLine("Landing 2 jobs · rebasing · 4m", Tone.RUNNING),
            SessionProjectCopy.landingLine(integration(2, inFlight("RUNNING", ago(4), "LAND_TASK", "P5", "REBASE", ago(1))), now))
    }

    @Test fun aStalledRunnerGoesQuietAndOlderServersFallBackToTheCount() {
        landingNow()
        val stalled = integration(1, inFlight("RUNNING", ago(30), "CHECK_PROMOTION", phase = "CHECK", heartbeatAt = ago(11)))
        assertEquals(SessionLine("Merge check · no report for 11m · 30m", Tone.QUEUED), SessionProjectCopy.landingLine(stalled, now))
        assertFalse(SessionProjectCopy.landingLine(stalled, now)!!.text.lowercase().contains("timed out"))
        assertEquals(SessionLine("Landing · no report yet · 4m · P5", Tone.QUEUED),
            SessionProjectCopy.landingLine(integration(1, inFlight("RUNNING", ago(4), "LAND_TASK", "P5", "FETCH")), now))
        assertEquals(SessionLine("Landing · 1 job", Tone.QUEUED), SessionProjectCopy.landingLine(integration(1), now))
        assertNull(SessionProjectCopy.landingLine(integration(0), now))
        assertNull(SessionProjectCopy.landingLine(null, now))
    }

    @Test fun aLandingReplacesAnIdleCoordinatorsLineAndKeepsItsTarget() {
        landingNow()
        val out = row(listOf(session("coordinator", role = "COORDINATOR", createdAt = ago(600), lastTurnAt = ago(1))), landingProject(queued()))
        assertEquals(SessionLine("Merge to main · queued · 13m", Tone.QUEUED), out?.line)
        assertEquals(Target.Session("coordinator"), out?.target)
    }

    @Test fun aLandingYieldsToACoordinatorMidTurnAHeldExceptionAndAnApproval() {
        landingNow()
        assertEquals("Running Edit…", row(listOf(session("coordinator", role = "COORDINATOR", state = "RUNNING", tool = "Edit")), landingProject(queued()))?.line?.text)
        assertEquals("Checks failed · 12m", row(listOf(session("coordinator", role = "COORDINATOR")), landingProject(queued(), held("INTEGRATION_CHECK_FAILED", ago(12))))?.line?.text)
        assertEquals(Tone.APPROVAL, row(listOf(session("coordinator", role = "COORDINATOR", approvals = 1)), landingProject(queued()))?.line?.tone)
    }

    @Test fun withoutACoordinatorTheLandingIsSaidAndTheRowOpensTheProject() {
        landingNow()
        val out = row(listOf(session("worker")), landingProject(queued()))
        assertEquals("Merge to main · queued · 13m", out?.line?.text)
        assertEquals(Target.Project("p1"), out?.target)
    }

    @Test fun nothingLandingLeavesTheCoordinatorsLineAlone() {
        landingNow()
        assertEquals("Last reply", row(listOf(session("coordinator", role = "COORDINATOR")), landingProject(integration(0)))?.line?.text)
    }

    // SessionProjectCopyTests

    @Test fun progressAndPageCountsUseTheDesignsWords() {
        assertEquals("Open Session", SessionProjectCopy.openSession)
        assertEquals("0/0", SessionProjectCopy.progress(0, 0))
        assertEquals("Project · 5 sessions", SessionProjectCopy.pageSubtitle(5))
        assertEquals("3/5 done · 2 running", SessionProjectCopy.pageProgress(3, 5, 2))
        assertEquals("Waiting for your confirmation · Retry", SessionProjectCopy.waitingSession("Waiting for your confirmation", "Retry"))
        assertNull(SessionProjectCopy.coordinatorLead("SOMETHING_NEW"))
        assertEquals("Not started · 1 task", SessionProjectCopy.pageNotStarted(1))
        assertEquals("Not started · 5 tasks", SessionProjectCopy.pageNotStarted(5))
        assertEquals("Project branch · Automatic on · 3 at a time", SessionProjectCopy.startSuggestion(buildJsonObject { put("line", "PROJECT_BRANCH"); put("automatic", true); put("maxConcurrentTasks", 3) }))
        assertEquals("Directly into main · Automatic off · 1 at a time", SessionProjectCopy.startSuggestion(buildJsonObject { put("line", "MAIN"); put("automatic", false); put("maxConcurrentTasks", 1) }))
    }

    // SessionProjectMembersTests

    private fun member(id: String, project: String? = "p1", role: String = "TASK", workspace: String = "w1", lifecycle: String = "OPEN",
        lastTurnAt: String? = null, title: String? = null) = DirectorySession(id, title ?: id, status = "AWAITING_INPUT", lifecycleState = lifecycle,
        agentId = workspace, createdAt = "2026-10-06T08:00:00Z", lastTurnAt = lastTurnAt,
        projectMembership = project?.let { SessionProjectMembership(it, "Project one", "OPEN", role) })

    @Test fun thePageOpensOnTheMembersTheAppAlreadyHolds() {
        val openList = listOf(member("coordinator", role = "COORDINATOR", lastTurnAt = "2026-10-06T09:00:00Z"),
            member("other-project", project = "p2", lastTurnAt = "2026-10-06T09:59:00Z"), member("loose", project = null, lastTurnAt = "2026-10-06T09:58:00Z"),
            member("worker", workspace = "w2", lastTurnAt = "2026-10-06T09:30:00Z"))
        val workspaceList = listOf(member("done", lifecycle = "COMPLETED", lastTurnAt = "2026-10-06T07:00:00Z"),
            member("trashed", lifecycle = "TRASH", lastTurnAt = "2026-10-06T09:50:00Z"))
        assertEquals(listOf("worker", "coordinator", "done"), SessionProjectMembers.members("p1", openList + workspaceList).map { it.id })
    }

    @Test fun thePageOpensOnAsManySessionsAsItsListRowCounts() {
        val account = listOf(member("coordinator", role = "COORDINATOR", lastTurnAt = "2026-10-06T09:00:00Z"),
            member("worker", workspace = "w2", lastTurnAt = "2026-10-06T09:30:00Z"), member("helper", lastTurnAt = "2026-10-06T09:10:00Z"), member("loose", project = null))
        val shown = account.filter { it.agentId == "w1" }
        val row = SessionProjectGrouping.listing(shown, emptyList(), emptyList(), SessionView.OPEN, false, contentSessions = account).projects.first()
        val members = SessionProjectMembers.members(row.projectId, account + shown)
        assertEquals(row.sessionCount, members.size)
        assertTrue(members.map { it.id }.containsAll(row.members.map { it.id }))
        assertEquals(row.coordinator?.id, members.first { it.projectMembership?.isCoordinator == true }.id)
    }

    @Test fun theFirstCopyOfASessionWins() {
        val fresh = member("worker", lastTurnAt = "2026-10-06T09:30:00Z", title = "fresh")
        val stale = member("worker", lifecycle = "COMPLETED", lastTurnAt = "2026-10-06T08:00:00Z", title = "stale")
        assertEquals(listOf("fresh"), SessionProjectMembers.members("p1", listOf(fresh, stale)).map { it.title })
    }

    @Test fun eitherSpellingOfTheProjectIdFindsItsMembers() {
        val uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"
        val publicId = ObjectId.toPublic(uuid)
        assertEquals(listOf("a"), SessionProjectMembers.members(uuid, listOf(member("a", project = publicId))).map { it.id })
        assertEquals(listOf("b"), SessionProjectMembers.members(publicId, listOf(member("b", project = uuid))).map { it.id })
    }

    @Test fun aPollTakesTheOpenMembersFromTheOpenListAndKeepsTheCompletedRead() {
        val done = member("done", lifecycle = "COMPLETED", lastTurnAt = "2026-10-06T07:00:00Z")
        val shown = listOf(member("worker", lastTurnAt = "2026-10-06T09:00:00Z"), done)
        val openList = listOf(member("worker", lastTurnAt = "2026-10-06T09:45:00Z", title = "worker, later"), member("new", lastTurnAt = "2026-10-06T09:50:00Z"),
            member("elsewhere", project = "p2"))
        val (members, moved) = SessionProjectMembers.poll(shown, "p1", openList, listOf(done))
        assertEquals(listOf("new", "worker, later", "done"), members.map { it.title })
        assertFalse(moved)
    }

    @Test fun aMemberThatLeftTheOpenListStaysUntilTheCompletedListIsRead() {
        val coordinator = member("coordinator", role = "COORDINATOR", lastTurnAt = "2026-10-06T08:00:00Z")
        val (members, moved) = SessionProjectMembers.poll(listOf(member("worker", lastTurnAt = "2026-10-06T09:00:00Z"), coordinator), "p1", listOf(coordinator), emptyList())
        assertEquals(listOf("worker", "coordinator"), members.map { it.id })
        assertTrue(moved)
    }

    @Test fun aCompletedMemberBackInTheOpenListIsShownOnceAsOpen() {
        val completed = member("worker", lifecycle = "COMPLETED")
        val (members, moved) = SessionProjectMembers.poll(listOf(completed), "p1", listOf(member("worker")), listOf(completed))
        assertEquals(listOf("worker"), members.map { it.id })
        assertEquals("OPEN", members.first().effectiveLifecycleState)
        assertFalse(moved)
    }
}
