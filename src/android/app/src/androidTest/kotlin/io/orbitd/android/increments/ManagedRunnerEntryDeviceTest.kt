package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.composer.ManagedRunner
import java.time.Instant
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Setting up a managed runner from an existing account on Android (docs/managed-runner-existing-account-entry-design.md, board 3),
 * over the test's own fixture: Machines & models' Managed runner section, the question before Set up, the runner's page with its banner
 * after it, and its row's short label — Preparing, then Asleep (never Offline), in the list and in the drawer. With the feature off
 * there is no section and no GET managed-runner. Screenshots land beside board 3 (docs/mocks/managed-runner-existing-account-entry/android).
 */
@RunWith(AndroidJUnit4::class)
class ManagedRunnerEntryDeviceTest : IncrementDeviceTest() {
    private val laptop = "34MraRunnerLaptop00001"
    private val managed = "34MraRunnerManaged0001"
    private val managedWorkspace = "34MraWorkspaceManaged1"
    private val managedSession = "34MraSessionManaged001"
    private val project = "34MraProjectLaunch0001"
    private val coord = "34MraSessionCoord00001"
    override val ids get() = listOf(workspace, runner, laptop, managed, managedWorkspace, managedSession, project, coord)

    @Volatile private var featureOn = true
    @Volatile private var state = "NOT_PROVISIONED"
    private val mapped get() = state != "NOT_PROVISIONED"
    /** A managed runner that has come up once has reported its version and engines; one still being prepared has reported nothing. */
    private val reported get() = state == "READY" || state == "SLEEPING"

    private fun status() = """{"contractVersion":1,"enabled":true,"revision":4,"managementState":"$state",
        "desiredState":${if (state == "SLEEPING") "\"SLEEPING\"" else if (mapped) "\"RUNNING\"" else "null"},
        "runnerId":${if (mapped) "\"$managed\"" else "null"},"workspaceId":${if (mapped) "\"$managedWorkspace\"" else "null"},"usable":${state == "READY"},
        "reason":null,"initialProvider":${if (reported) "\"claude\"" else "null"},"firstSessionProvider":null,
        "actions":{"canEnsure":${!mapped},"canWake":true,"canRetry":false}}"""
    private fun machine(id: String, name: String, online: Boolean, version: String = "0.1.262") = """{"id":"$id","name":"$name","displayName":"$name",
        "hostname":"$name","version":"$version","online":$online,"status":"${if (online) "ONLINE" else "OFFLINE"}",
        "lastHeartbeatAt":"${if (online) Instant.now() else Instant.now().minusSeconds(7_200)}","maxConcurrent":2,"activeSessions":0,
        "runsAsRoot":false,"minFreeDiskMb":null,"selfUpdate":null,"engines":[{"engine":"claude","installed":true,"auth":"yes"}],
        "enrolledAt":"2026-09-01T00:00:00Z"}"""
    /** The managed runner as GET /runners lists it: before it first reports, no version, heartbeat or engines (as the server creates it). */
    private fun managedMachine() = if (reported) machine(managed, "managed-runner", online = state == "READY")
        else """{"id":"$managed","name":"managed-runner","displayName":"managed-runner","hostname":null,"version":null,"online":false,
        "status":"OFFLINE","lastHeartbeatAt":null,"maxConcurrent":2,"activeSessions":0,"runsAsRoot":false,"minFreeDiskMb":null,"selfUpdate":null,
        "engines":null,"enrolledAt":"2026-11-15T00:00:00Z"}"""
    private fun machines() = listOfNotNull(machine(runner, "workstation", true), machine(laptop, "laptop", false),
        managedMachine().takeIf { mapped }).joinToString(",", "[", "]")
    private fun sessionRow() = """{"id":"$managedSession","title":"Tidy the release notes","status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
        "lifecycleState":"OPEN","provider":"claude","engine":"claude","model":"claude-opus-5-5","assignedRunnerId":"$managed",
        "agent":{"id":"$managedWorkspace","name":"default"},"agentId":"$managedWorkspace","workspaceId":"$managedWorkspace","createdAt":"${ago(600)}",
        "lastTurnAt":"${ago(120)}","capabilities":{"canSend":true,"canResume":false,"canComplete":true},"tags":[],"pendingApprovals":0}"""
    override fun sessions(view: String, project: String?) = if (view == "open" && mapped && project == null) "[${sessionRow()}]" else "[]"
    private fun coordinatorStatus() = """{"projectId":"$project","readAt":"${Instant.now()}","state":"LIVE","coordination":{"sessionId":"$coord",
        "workspaceId":"$workspace","workspaceName":"Alpha","coordinatorGeneration":"0","session":{"id":"$coord","runState":"AWAITING_INPUT",
        "lifecycleState":"OPEN","engineTurnActive":false,"pendingApprovals":0}}}"""
    private fun projectDocument() = """{"id":"$project","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z",
        "_count":{"tasks":3},"startedAt":"2026-10-02T00:00:00Z","coordinatorSessionId":"$coord","coordinatorEnabled":true,"configRevision":"1",
        "maxConcurrentTasks":2,"exceptionEscalationSeconds":7200,"pausedAt":null,"tasksByStatus":{"OPEN":1,"DONE":2},
        "integration":{"line":"PROJECT_BRANCH","ref":"project/launch","upstreamRef":"main","escalationSeconds":7200},"acceptanceCriteriaItems":[]}"""
    override fun runnerJson() = machine(runner, "workstation", true)
    private fun workspaces() = listOfNotNull(workspaceJson(), """{"id":"$managedWorkspace","name":"default","runnerId":"$managed","enabled":true,
        "position":1,"provider":"claude","createdAt":"2026-11-14T01:00:00.000Z"}""".takeIf { mapped }).joinToString(",", "[", "]")

    override fun answer(req: Req): MockResponse? = when {
        req.path == "auth/capabilities" -> if (featureOn) json("""{"managedRunners":{"enabled":true,"contractVersion":1}}""")
            else json("""{"message":"Cannot GET /api/auth/capabilities","statusCode":404}""", 404)
        req.path == "managed-runner" -> json(status())
        req.path == "managed-runner/ensure" && req.method == "POST" -> { state = "REQUESTED"; json(status()) }
        req.path == "runners" -> json(machines())
        req.path == "runners/$laptop" -> json(machine(laptop, "laptop", false))
        req.path == "runners/$managed" -> json(managedMachine())
        req.path == "sessions/$managedSession" && req.method == "GET" -> json(sessionRow())
        req.path == "sessions/$managedSession/events/page" -> json(page(listOf(
            event(1, "user", """{"text":"Tidy the release notes"}""", turnId = "t-0"),
            event(2, "assistant", """{"text":"Done: three headings merged."}""", turnId = "t-0"),
            event(3, "turn_end", """{"subtype":"success"}""", turnId = "t-0"))))
        req.path == "sessions/$managedSession/turns" && req.method == "GET" -> json("[]")
        req.path == "projects/sidebar" || req.path == "projects" -> json("""[{"id":"$project","title":"Launch","status":"OPEN",
            "createdAt":"2026-10-01T00:00:00Z","buckets":{"running":0},"taskCounts":{"done":2,"failed":0,"total":3},"attention":{},
            "integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":0},"startedAt":"2026-10-02T00:00:00Z","mainBranch":"main"}]""")
        req.parts.size >= 2 && req.parts[0] == "projects" && req.parts[1] == project -> when (req.parts.drop(2).joinToString("/")) {
            "" -> if (req.method == "GET") json(projectDocument()) else json("{}")
            "coordinator/status" -> json(coordinatorStatus())
            "integration" -> json("""{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":0,"queuedCount":0,"inFlight":null}""")
            "open-items" -> json("""{"needsYou":[],"withCoordinator":[]}""")
            "promotions/current" -> empty200()
            "promotions/merged", "handoffs" -> json("[]")
            "dependency-graph" -> json("""{"marks":[],"edges":[],"taskCount":0,"folded":false,"truncated":false}""")
            "tasks/page" -> json("""{"items":[],"nextCursor":null}""")
            else -> json("{}")
        }
        req.path == "workspaces" -> json(workspaces())
        req.path == "providers/mine" -> json("""[{"id":"K1","slug":"anthropic","label":"Anthropic","runtime":"claude","presetSlug":"anthropic",
            "hasApiKey":true,"defaultModel":"claude-opus-5-5","engines":["claude"]}]""")
        req.path == "providers/pools" || req.path == "providers/shared-pools" -> json("[]")
        else -> null
    }

    private fun machinesAndModels() {
        signIn()
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        compose.onNode(hasText("Settings") and hasClickAction()).performClick()
        await("Settings") { exists(hasText("Machines & models") and hasClickAction()) }
        compose.onNode(hasText("Machines & models") and hasClickAction()).performScrollTo().performClick()
        await("Machines & models") { exists(hasText("laptop"), unmerged = true) }
    }
    private fun managedReads() = calls.count { it == "GET managed-runner" }
    private fun label(text: String) = exists(hasText(text) and hasTestTag("managed-runner-label"), unmerged = true)

    @Test fun setUpFromMachinesAndModels() = journey {
        machinesAndModels()
        awaitText(ManagedRunner.Entry.SUBTITLE)
        verify("the section says Set up a managed runner", says("managed-runner-entry", "Set up a managed runner"))
        verify("Managed runner stands above Machines",
            compose.onAllNodesWithText(ManagedRunner.Entry.TITLE)[0].fetchSemanticsNode().positionInRoot.y <
                compose.onAllNodesWithText("Machines")[0].fetchSemanticsNode().positionInRoot.y)
        capture("01-section")

        compose.onNode(hasText(ManagedRunner.Entry.ACTION) and hasClickAction() and hasAnyAncestor(hasTestTag("managed-runner-entry")))
            .performClick()
        awaitText(ManagedRunner.Confirm.BODY)
        verify("nothing is set up before the answer", calls.none { it.startsWith("POST managed-runner/ensure") })
        capture("02-confirmation")

        compose.onNode(hasText(ManagedRunner.Confirm.CONFIRM) and hasClickAction() and hasAnyAncestor(isDialog()))
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        // The runner's page opens, its banner at the top.
        awaitTag("managed-runner-notice")
        awaitText("Preparing your managed runner")
        verify("one ensure", calls.count { it.startsWith("POST managed-runner/ensure") } == 1)
        verify("its page says no Offline", !exists(hasText("Offline"), unmerged = true))
        // Not reported yet (the owner's ruling of 2026-11-14): one quiet line for Resources and Engines, no Update runner, no engine rows.
        verify("Resources and Engines say only that it is not ready",
            count(hasText("Available once the runner is ready."), unmerged = true) == 2)
        verify("no Update runner and no predates lines", !exists(hasText("Update runner", substring = true), unmerged = true) &&
            !exists(hasText("predates", substring = true), unmerged = true))
        verify("no engine rows", !exists(hasText("Claude Code"), unmerged = true) && !exists(hasText("Antigravity CLI"), unmerged = true))
        capture("03-runner-page")

        back()
        await("the managed runner's row says Preparing") { label("Preparing") }
        verify("the entry is gone", !exists(hasText(ManagedRunner.Entry.SUBTITLE), unmerged = true))
        capture("04-post-setup-row")

        state = "SLEEPING"
        await("the managed runner's row says Asleep", timeoutMs = 60_000) { label("Asleep") }
        verify("asleep says when it wakes", exists(hasText(ManagedRunner.Asleep.ROW), unmerged = true))
        verify("the managed runner is no Needs you line", !exists(hasText("managed-runner is offline", substring = true), unmerged = true))
        capture("05-asleep-row")
    }

    /** The drawer reads its workspaces at sign-in (a real server's event brings a new one in later; this fixture sends none), so this
     * journey starts with the managed runner already mapped and asleep: its workspace row says Asleep, never Offline. */
    @Test fun theDrawersManagedWorkspaceSaysAsleep() = journey {
        state = "SLEEPING"
        signIn()
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        await("the drawer's managed workspace row says Asleep", timeoutMs = 60_000) {
            exists(hasText("managed-runner · Asleep", substring = true), unmerged = true)
        }
        verify("no workspace row says Offline", !exists(hasText("Offline", substring = true), unmerged = true))
        capture("06-drawer-asleep")
    }

    /** Once it is ready (it has reported its version and engines), its page is the ordinary one, under the banner and its state. */
    @Test fun theManagedRunnersPageOnceReady() = journey {
        state = "READY"
        machinesAndModels()
        await("the managed runner's row says Ready") { label("Ready") }
        // The row's own press (its name sits in more than one clickable node: the row and its More menu's label).
        compose.onAllNodes(hasText("managed-runner") and hasClickAction()).onFirst().performClick()
        awaitText("Managed runner ready")
        await("its engines are listed") { exists(hasText("Claude Code"), unmerged = true) }
        verify("no not-ready lines", !exists(hasText("Available once the runner is ready."), unmerged = true))
        capture("08-runner-ready")
    }

    /** An existing session on the managed runner, asleep: the shared composer line, and sending stays open (a message wakes it). */
    @Test fun anExistingSessionsComposerWhenAsleep() = journey {
        state = "SLEEPING"
        signIn()
        open("orbit-session:$managedSession")
        await("the session's composer") { exists(hasTestTag("composer-input")) && app.realtime.state.value.session?.fresh == true }
        awaitTag("managed-runner-asleep-line")
        verify("the line is the shared one", exists(hasText(ManagedRunner.Asleep.COMPOSER), unmerged = true))
        verify("the composer can still be typed in", exists(hasTestTag("composer-input") and isEnabled()))
        verify("nothing says Offline", !exists(hasText("offline", substring = true, ignoreCase = true), unmerged = true))
        capture("09-session-composer-asleep")
    }

    /** The project page's coordinator Change workspace picker: the managed runner's workspace says Asleep, the laptop-less others as before. */
    @Test fun thePickerSaysAsleep() = journey {
        state = "SLEEPING"
        signIn()
        open("orbit-project:$project")
        await("the project page") { exists(hasTestTag("project-detail") and hasScrollAction()) }
        await("the coordinator card") { exists(hasTestTag("project-coordinator-more")) }
        // Let the page's reads land before scrolling: a scroll during its layout trips Compose's test harness.
        settle()
        compose.onNodeWithTag("project-coordinator-more").performScrollTo()
        settle()
        compose.onNodeWithTag("project-coordinator-more").performClick()
        awaitTag("project-coordinator-change")
        compose.onNodeWithTag("project-coordinator-change").performClick()
        awaitTag("coordinator-change-sheet")
        await("the managed workspace says Asleep") {
            exists(hasTestTag("coordinator-change-runner:$managedWorkspace") and hasText("Asleep"), unmerged = true)
        }
        verify("no row says Runner offline", !exists(hasText("Runner offline"), unmerged = true))
        verify("the managed workspace is still a press", exists(hasTestTag("coordinator-change:$managedWorkspace") and hasClickAction() and isEnabled()))
        capture("10-picker-asleep")
    }

    @Test fun featureOffShowsNoSectionAndNeverReadsTheStatus() = journey {
        featureOn = false
        machinesAndModels()
        awaitText("Anthropic")
        settle()
        verify("no Managed runner section", !exists(hasText(ManagedRunner.Entry.TITLE), unmerged = true))
        verify("the laptop reads Offline, as today", exists(hasText("Offline"), unmerged = true))
        verify("capabilities were asked", calls.any { it == "GET auth/capabilities" })
        verify("GET managed-runner was never read", managedReads() == 0)
        capture("07-feature-off")
    }
}
