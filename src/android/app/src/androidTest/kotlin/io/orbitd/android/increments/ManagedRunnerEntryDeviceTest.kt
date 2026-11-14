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
    override val ids get() = listOf(workspace, runner, laptop, managed, managedWorkspace)

    @Volatile private var featureOn = true
    @Volatile private var state = "NOT_PROVISIONED"
    private val mapped get() = state != "NOT_PROVISIONED"

    private fun status() = """{"contractVersion":1,"enabled":true,"revision":4,"managementState":"$state",
        "desiredState":${if (state == "SLEEPING") "\"SLEEPING\"" else if (mapped) "\"RUNNING\"" else "null"},
        "runnerId":${if (mapped) "\"$managed\"" else "null"},"workspaceId":${if (mapped) "\"$managedWorkspace\"" else "null"},"usable":false,
        "reason":null,"initialProvider":${if (state == "SLEEPING") "\"claude\"" else "null"},"firstSessionProvider":null,
        "actions":{"canEnsure":${!mapped},"canWake":true,"canRetry":false}}"""
    private fun machine(id: String, name: String, online: Boolean, version: String = "0.1.262") = """{"id":"$id","name":"$name","displayName":"$name",
        "hostname":"$name","version":"$version","online":$online,"status":"${if (online) "ONLINE" else "OFFLINE"}",
        "lastHeartbeatAt":"${if (online) Instant.now() else Instant.now().minusSeconds(7_200)}","maxConcurrent":2,"activeSessions":0,
        "runsAsRoot":false,"minFreeDiskMb":null,"selfUpdate":null,"engines":[{"engine":"claude","installed":true,"auth":"yes"}],
        "enrolledAt":"2026-09-01T00:00:00Z"}"""
    private fun machines() = listOfNotNull(machine(runner, "workstation", true), machine(laptop, "laptop", false),
        machine(managed, "managed-runner", false).takeIf { mapped }).joinToString(",", "[", "]")
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
        req.path == "runners/$managed" -> json(machine(managed, "managed-runner", false))
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

        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        await("the drawer's managed workspace row says Asleep", timeoutMs = 60_000) {
            exists(hasText("managed-runner · Asleep", substring = true), unmerged = true)
        }
        capture("06-drawer-asleep")
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
