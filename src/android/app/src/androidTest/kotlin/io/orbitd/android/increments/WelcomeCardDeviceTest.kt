package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.composer.WelcomeCopy
import io.orbitd.android.directory.SessionListCopy
import io.orbitd.android.management.RunnerCopy
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A new account's welcome card (docs/mocks/new-user-onboarding, web 40bd23aa2) on a device, in the scenes the board's after/ shots of
 * the web were taken in (capture/after.mjs, with the same runner, workspace and managed runner states from the shared fixture):
 * 1-managed (preparing), 2-model (up, no runtime signed in), 3-ready (signed in, an example picked), 4-machine (a bare machine's setup
 * card) and 5-register (no machine at all). 6-history-* are the same accounts with one Completed session: no welcome card anywhere.
 */
@RunWith(AndroidJUnit4::class)
class WelcomeCardDeviceTest : IncrementDeviceTest() {
    private val rid = "2zQeDGWFFAgN2112jNTf7"
    private val wid = "2zQeDGWFFAgN2112jNTf8"
    override val ids get() = listOf(rid, wid)

    private enum class Fleet { MANAGED_PREPARING, MANAGED_MODEL, MANAGED_READY, MACHINE, NONE }
    @Volatile private var fleet = Fleet.NONE
    @Volatile private var hadSession = false

    private val managedOn get() = fleet in setOf(Fleet.MANAGED_PREPARING, Fleet.MANAGED_MODEL, Fleet.MANAGED_READY)

    private fun eng(engine: String, version: String, auth: String) =
        """{"engine":"$engine","installed":true,"auth":"$auth","version":"$version","accounts":[{"id":"default","name":"Default","auth":"$auth"}]}"""

    private fun runnerRow(): String {
        val engines = when (fleet) {
            Fleet.MANAGED_PREPARING -> "null"
            Fleet.MANAGED_READY -> "[${eng("claude", "2.1.302", "yes")},${eng("codex", "0.164.0", "no")}]"
            else -> "[${eng("claude", "2.1.302", "no")},${eng("codex", "0.164.0", "no")}]"
        }
        val online = fleet != Fleet.MANAGED_PREPARING
        val name = if (fleet == Fleet.MACHINE) "mia-macbook" else "managed-mia"
        return """{"id":"$rid","name":"$name","displayName":null,"hostname":"$name","version":"0.1.250","online":$online,
            "status":"${if (online) "ONLINE" else "OFFLINE"}","activeSessions":0,"lastHeartbeatAt":${if (online) "\"${ago(0)}\"" else "null"},
            "runsAsRoot":false,"capabilities":["dir-probe/v1","create-workdir/v1"],"labels":[],
            "registerDir":${if (fleet == Fleet.MACHINE) "\"/Users/mia\"" else "null"},"maxConcurrent":4,"enrolledAt":"${ago(2)}",
            "reposRoot":"/var/lib/orbit/home/orbit-repos","selfUpdate":{"state":"enabled","installDir":"/usr/local/bin"},
            "commands":[],"skills":[],"engines":$engines}"""
    }

    private fun workspaceRow() = """{"id":"$wid","name":"default","runnerId":"$rid","runner":{"id":"$rid","name":"managed-mia"},
        "createdAt":"${ago(2)}","position":null,"lastProvider":${if (fleet == Fleet.MANAGED_READY) "\"claude\"" else "null"},"provider":null,
        "model":null,"workDir":"/var/lib/orbit/home/orbit-repos/default","enableWorktree":true,"enabled":true,"workDirExists":true,"workDirIsGit":true}"""

    /** The fixture's `preparing: starting`, `model unavailable: started without a signed-in runtime` and `available` bodies. */
    private fun managedStatus(): String = when (fleet) {
        Fleet.MANAGED_PREPARING -> """{"contractVersion":1,"enabled":true,"revision":5,"managementState":"STARTING","desiredState":"RUNNING",
            "runnerId":"$rid","workspaceId":"$wid","heartbeatStatus":"OFFLINE","lastHeartbeatAt":null,"usable":false,"reason":null,
            "retryAfter":null,"initialProvider":null,"firstSessionProvider":null,"actions":{"canEnsure":false,"canWake":false,"canSleep":false,
            "canRetry":false,"canDelete":false},"workspacePublicId":"$wid","runnerPublicId":"$rid"}"""
        Fleet.MANAGED_MODEL -> """{"contractVersion":1,"enabled":true,"revision":6,"managementState":"STARTING","desiredState":"RUNNING",
            "runnerId":"$rid","workspaceId":"$wid","heartbeatStatus":"ONLINE","lastHeartbeatAt":"${ago(0)}","usable":false,
            "reason":{"code":"MODEL_UNAVAILABLE","message":"The runner is up, but none of its runtimes is signed in and none of your model keys runs on it, so it cannot start a session. Sign one in, or add a model key, from the Machines & models page; a runner that has stopped waiting for it can then be retried.","retryable":true},
            "retryAfter":null,"initialProvider":null,"firstSessionProvider":null,"actions":{"canEnsure":false,"canWake":false,"canSleep":false,
            "canRetry":false,"canDelete":false},"workspacePublicId":"$wid","runnerPublicId":"$rid"}"""
        else -> """{"contractVersion":1,"enabled":true,"revision":8,"managementState":"READY","desiredState":"RUNNING","runnerId":"$rid",
            "workspaceId":"$wid","heartbeatStatus":"ONLINE","lastHeartbeatAt":"${ago(0)}","usable":true,"reason":null,"retryAfter":null,
            "initialProvider":"claude","firstSessionProvider":"claude","actions":{"canEnsure":false,"canWake":false,"canSleep":true,
            "canRetry":false,"canDelete":false},"workspacePublicId":"$wid","runnerPublicId":"$rid"}"""
    }

    private val old = "34WelcomeOldSession001"
    private fun oldSession() = """{"id":"$old","title":"An earlier session","status":"COMPLETED","runState":"COMPLETED","lifecycleState":"COMPLETED",
        "provider":"claude","engine":"claude","model":"claude-opus-5-5","agentId":"$wid","agent":{"id":"$wid","name":"default"},
        "createdAt":"${ago(900)}","lastTurnAt":"${ago(800)}","completedAt":"${ago(800)}","pendingApprovals":0,"tags":[]}"""

    override fun userJson() = """{"id":"u1","email":"mia@example.com","name":"Mia Chen","preferences":{"theme":"light"}}"""
    override fun sessions(view: String, project: String?) = if (hadSession && view == "completed") "[${oldSession()}]" else "[]"

    override fun answer(req: Req): MockResponse? = when {
        req.path == "auth/capabilities" -> if (managedOn) json("""{"managedRunners":{"enabled":true,"contractVersion":1}}""")
            else json("""{"message":"Cannot GET /api/auth/capabilities","statusCode":404}""", 404)
        req.path == "managed-runner" -> if (managedOn) json(managedStatus()) else json("{}", 404)
        req.path == "runners" -> json(if (fleet == Fleet.NONE) "[]" else "[${runnerRow()}]")
        req.path == "runners/$rid" -> json(runnerRow())
        req.path == "runners/$rid/login" -> json("""{"status":null,"engine":null,"url":null,"userCode":null,"message":null}""")
        req.path == "workspaces" -> json(if (managedOn) "[${workspaceRow()}]" else "[]")
        req.path == "workspaces/$wid" -> json(workspaceRow())
        else -> null
    }

    private fun says(text: String, substring: Boolean = false) = exists(hasText(text, substring = substring), unmerged = true)

    /** The managed runner's default workspace: the launch lands on its list, and New session opens its draft. */
    private fun openManagedDraft() {
        signIn()
        val start = hasContentDescription(SessionListCopy.startSession("default"))
        await("the default workspace") { exists(start) }
        compose.onNode(start).performClick()
        settle()
    }

    /** The two reads that decide whether the account is new have both been answered. */
    private fun awaitNewAccountRead() {
        await("the Open and Completed reads") { calls.any { it.startsWith("GET sessions?") && "view=open" in it && "limit=1" in it } &&
            calls.any { it.startsWith("GET sessions?") && "view=completed" in it && "limit=1" in it } }
        settle()
    }

    private fun verifyHead() {
        // The name comes with its own read (users/me): the head says "Welcome to Orbit" until it answers.
        await("the head greets Mia") { says(WelcomeCopy.welcomeTitle("Mia Chen")) }
        verify("the lead says what Orbit is", says(WelcomeCopy.WELCOME_LEAD))
    }

    private fun verifyPlaceholder() = verify("the composer asks for a task", says(WelcomeCopy.WELCOME_PLACEHOLDER))

    @Test fun managedPreparing() = journey {
        fleet = Fleet.MANAGED_PREPARING
        openManagedDraft()
        awaitTag("welcome-card")
        verifyHead()
        verify("step 1 says Orbit is starting one", says(WelcomeCopy.WELCOME_COMPUTER) && says(WelcomeCopy.WELCOME_COMPUTER_MANAGED))
        verify("step 1 holds the managed runner's own state", says("Preparing your managed runner"))
        verify("step 1 offers the user's own computer", says(WelcomeCopy.WELCOME_OWN_INSTEAD))
        verify("step 2 opens once the computer is up", says(WelcomeCopy.WELCOME_MODEL) && says(WelcomeCopy.WELCOME_AFTER_COMPUTER))
        verify("step 3 offers the three examples", WelcomeCopy.WELCOME_EXAMPLES.all { says(it) })
        verify("the foot waits for steps 1 and 2", says(WelcomeCopy.WELCOME_FOOT_WAIT))
        verify("no engine row stands beside the card", !exists(hasTestTag("new-session-engine"), unmerged = true))
        verifyPlaceholder()
        capture("1-managed")
    }

    @Test fun managedModel() = journey {
        fleet = Fleet.MANAGED_MODEL
        openManagedDraft()
        awaitTag("welcome-card")
        await("step 1 done") { says(WelcomeCopy.WELCOME_COMPUTER_DONE) && says(WelcomeCopy.welcomeComputerReady("managed-mia")) }
        verify("step 2 asks for a model", says(WelcomeCopy.WELCOME_MODEL) && says(WelcomeCopy.WELCOME_MODEL_HELP))
        // The runner's sign-in card, the setup card's own (RunnerSignInCard): its button says Sign In.
        await("the runner's sign-in card") { exists(hasText(RunnerCopy.SIGN_IN) and hasAnyAncestor(hasTestTag("welcome-card")), unmerged = true) && !says(WelcomeCopy.WELCOME_AFTER_COMPUTER) }
        verify("the foot waits for steps 1 and 2", says(WelcomeCopy.WELCOME_FOOT_WAIT))
        verifyPlaceholder()
        capture("2-model")
    }

    @Test fun managedReady() = journey {
        fleet = Fleet.MANAGED_READY
        openManagedDraft()
        awaitTag("welcome-card")
        await("step 2 done") { says(WelcomeCopy.WELCOME_MODEL_DONE) && says("Claude Code signed in on managed-mia") }
        compose.onAllNodesWithTag("welcome-example", useUnmergedTree = true).onFirst().performClick()
        settle()
        val first = WelcomeCopy.WELCOME_EXAMPLES.first()
        await("the example in the composer") { exists(hasTestTag("composer-input") and hasText(first), unmerged = true) }
        verify("the foot says all set", says(WelcomeCopy.WELCOME_FOOT_READY))
        verify("nothing was sent", bodies.none { it.first.startsWith("POST sessions") })
        dropFocus()
        capture("3-ready")
    }

    @Test fun bareMachine() = journey {
        fleet = Fleet.MACHINE
        signIn()
        awaitTag("machine-setup-card")
        await("the welcome head on the setup card") { says(WelcomeCopy.welcomeTitle("Mia Chen")) }
        verify("the setup title gives way to the greeting", !says("machine-setup-card", "Set up mia-macbook"))
        verifyPlaceholder()
        capture("4-machine")
        compose.onAllNodesWithTag("welcome-example", useUnmergedTree = true).onFirst().performScrollTo()
        verify("step 3 offers the three examples", WelcomeCopy.WELCOME_EXAMPLES.all { says(it) } && says(WelcomeCopy.WELCOME_FIRST))
        capture("4-machine-examples")
    }

    @Test fun noMachine() = journey {
        fleet = Fleet.NONE
        signIn()
        awaitTag("welcome-card")
        verifyHead()
        verify("step 1 says how to connect a computer", says(WelcomeCopy.WELCOME_COMPUTER_OWN) && says("install.sh | bash", substring = true))
        verify("step 1 waits for it", says(WelcomeCopy.WELCOME_WAITING_CONNECT) && says(WelcomeCopy.WELCOME_HAVING_TROUBLE))
        verify("steps 2 and 3 open after step 1", count(hasText(WelcomeCopy.WELCOME_AFTER_STEP_ONE), unmerged = true) == 2)
        capture("5-register")
    }

    @Test fun anAccountWithHistorySeesNoCard() = journey {
        hadSession = true
        fleet = Fleet.MANAGED_PREPARING
        openManagedDraft()
        awaitTag("new-session-engine")
        awaitNewAccountRead()
        verify("the managed draft keeps its engine row and no card",
            !exists(hasTestTag("welcome-card"), unmerged = true) && !says(WelcomeCopy.WELCOME_PLACEHOLDER))
        capture("6-history-managed")
    }

    @Test fun anAccountWithHistoryAndNoMachineSeesTodaysPage() = journey {
        hadSession = true
        fleet = Fleet.NONE
        signIn()
        awaitText("No workspaces yet")
        awaitNewAccountRead()
        verify("no welcome card", !exists(hasTestTag("welcome-card"), unmerged = true))
        capture("6-history-none")
    }

    @Test fun anAccountWithHistoryOnABareMachineSeesTheSetupCard() = journey {
        hadSession = true
        fleet = Fleet.MACHINE
        signIn()
        awaitTag("machine-setup-card")
        await("the setup title") { says("Set up mia-macbook") }
        awaitNewAccountRead()
        verify("no greeting and no examples", !says(WelcomeCopy.welcomeTitle("Mia Chen")) && !exists(hasTestTag("welcome-example"), unmerged = true))
        capture("6-history-machine")
    }
}
