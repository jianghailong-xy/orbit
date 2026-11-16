package io.orbitd.android.increments

import androidx.compose.ui.test.*
import io.orbitd.android.composer.ManagedRunner
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.composer.MachineSetupCopy
import io.orbitd.android.composer.WelcomeCopy
import io.orbitd.android.composer.WelcomeSignInCopy
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

    private enum class Fleet { MANAGED_PREPARING, MANAGED_KEY, MANAGED_ASLEEP, MANAGED_MODEL, MANAGED_READY, MACHINE, NONE }
    @Volatile private var fleet = Fleet.NONE
    @Volatile private var hadSession = false

    private val managedOn get() = fleet in setOf(Fleet.MANAGED_PREPARING, Fleet.MANAGED_KEY, Fleet.MANAGED_ASLEEP, Fleet.MANAGED_MODEL, Fleet.MANAGED_READY)

    private fun eng(engine: String, version: String, auth: String) =
        """{"engine":"$engine","installed":true,"auth":"$auth","version":"$version","accounts":[{"id":"default","name":"Default","auth":"$auth"}]}"""

    private fun runnerRow(): String {
        val engines = when (fleet) {
            Fleet.MANAGED_PREPARING -> "null"
            Fleet.MANAGED_READY -> "[${eng("claude", "2.1.302", "yes")},${eng("codex", "0.164.0", "no")}]"
            else -> "[${eng("claude", "2.1.302", "no")},${eng("codex", "0.164.0", "no")}]"
        }
        val online = fleet !in setOf(Fleet.MANAGED_PREPARING, Fleet.MANAGED_KEY, Fleet.MANAGED_ASLEEP)
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
        Fleet.MANAGED_PREPARING, Fleet.MANAGED_KEY -> """{"contractVersion":1,"enabled":true,"revision":5,"managementState":"STARTING","desiredState":"RUNNING",
            "runnerId":"$rid","workspaceId":null,"heartbeatStatus":"OFFLINE","lastHeartbeatAt":null,"usable":false,"reason":null,
            "retryAfter":null,"initialProvider":null,"firstSessionProvider":${if (fleet == Fleet.MANAGED_KEY) "\"deepseek\"" else "null"},"actions":{"canEnsure":false,"canWake":false,"canSleep":false,
            "canRetry":false,"canDelete":false},"runnerPublicId":"$rid"}"""
        Fleet.MANAGED_ASLEEP -> """{"contractVersion":1,"enabled":true,"revision":9,"managementState":"SLEEPING","desiredState":"SLEEPING",
            "runnerId":"$rid","workspaceId":null,"usable":false,"initialProvider":"claude","firstSessionProvider":"claude",
            "actions":{"canWake":true}}"""
        Fleet.MANAGED_MODEL -> """{"contractVersion":1,"enabled":true,"revision":6,"managementState":"STARTING","desiredState":"RUNNING",
            "runnerId":"$rid","workspaceId":null,"heartbeatStatus":"ONLINE","lastHeartbeatAt":"${ago(0)}","usable":false,
            "reason":{"code":"MODEL_UNAVAILABLE","message":"The runner is up, but none of its runtimes is signed in and none of your model keys runs on it, so it cannot start a session. Sign one in, or add a model key, from the Machines & models page; it waits for one and becomes ready by itself.","retryable":true},
            "retryAfter":null,"initialProvider":null,"firstSessionProvider":null,"actions":{"canEnsure":false,"canWake":false,"canSleep":false,
            "canRetry":false,"canDelete":false},"runnerPublicId":"$rid"}"""
        else -> """{"contractVersion":1,"enabled":true,"revision":8,"managementState":"READY","desiredState":"RUNNING","runnerId":"$rid",
            "workspaceId":null,"heartbeatStatus":"ONLINE","lastHeartbeatAt":"${ago(0)}","usable":true,"reason":null,"retryAfter":null,
            "initialProvider":"claude","firstSessionProvider":"claude","actions":{"canEnsure":false,"canWake":false,"canSleep":true,
            "canRetry":false,"canDelete":false},"runnerPublicId":"$rid"}"""
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
        req.path == "workspaces" && req.method == "POST" -> json(workspaceRow())
        req.path == "workspaces" -> json(if (managedOn && hadSession) "[${workspaceRow()}]" else "[]")
        req.path == "workspaces/$wid" -> json(workspaceRow())
        else -> null
    }

    private fun says(text: String, substring: Boolean = false) = exists(hasText(text, substring = substring), unmerged = true)

    private val startSession get() = hasContentDescription(SessionListCopy.startSession("default"))

    /** A new account whose only workspace is the managed runner's default: signed in from a cold, cleared app, the launch lands on that
     *  workspace's draft with the welcome card, with no tap at all (the web's DefaultLanding + WorkspaceView). */
    private fun landOnManagedDraft() {
        signIn()
        awaitTag("machine-setup-card")
        verify("the launch landed on machine setup", !exists(startSession))
    }

    /** An account that has had a session: the launch lands on the default workspace's list, as today; New session opens its draft. */
    private fun openManagedDraftByHand() {
        signIn()
        await("the default workspace's list") { exists(startSession) }
        awaitNewAccountRead()
        verify("the launch stays on the session list", exists(startSession) && !exists(hasTestTag("welcome-card"), unmerged = true))
        capture("6-history-managed-landing")
        compose.onNode(startSession).performClick()
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

    private fun verifyWorkspaceOnlyCard() {
        verify("no composer, sign-in or examples", !exists(hasTestTag("composer-input"), unmerged = true) &&
            !exists(hasTestTag("welcome-example"), unmerged = true) && !says("Sign in to Claude Code"))
        verify("name field", exists(hasTestTag("setup-workspace-name") and isEnabled(), unmerged = true))
    }

    private fun typeManagedFolder(state: String) {
        compose.onNodeWithTag("setup-new-folder-name").performTextInput("my-project")
        awaitText(ManagedRunner.Setup.FOLDER_UNCHECKED.getValue(state))
        verify("the name follows the folder", exists(hasTestTag("setup-workspace-name") and hasText("my-project"), unmerged = true))
        verify("Create is enabled", exists(hasTestTag("setup-create") and isEnabled(), unmerged = true))
        verify("no probe is sent", calls.none { "dir-probe" in it })
    }

    @Test fun managedPreparing() = journey {
        fleet = Fleet.MANAGED_PREPARING
        landOnManagedDraft()
        verifyHead()
        awaitText(ManagedRunner.Setup.NOTICE.getValue("preparing"))
        verifyWorkspaceOnlyCard()
        typeManagedFolder("preparing")
        capture("1-managed")
    }

    @Test fun managedPreparingWithKey() = journey {
        fleet = Fleet.MANAGED_KEY
        landOnManagedDraft()
        verifyWorkspaceOnlyCard()
        typeManagedFolder("preparing")
    }

    @Test fun managedAsleep() = journey {
        fleet = Fleet.MANAGED_ASLEEP
        landOnManagedDraft()
        awaitText(ManagedRunner.Setup.NOTICE.getValue("asleep"))
        verifyWorkspaceOnlyCard()
        typeManagedFolder("asleep")
        compose.onNodeWithTag("setup-workspace-name").performTextReplacement("My project")
        compose.onNodeWithTag("setup-create").performClick()
        awaitTag("new-session-engine")
        val posted = bodies.single { it.first.startsWith("POST workspaces") }.second
        val body = kotlinx.serialization.json.Json.parseToJsonElement(posted) as kotlinx.serialization.json.JsonObject
        verify("only a new folder is sent", body["newFolder"].toString() == "\"my-project\"" && body["workDir"] == null)
        verify("the edited name is sent", body["name"].toString() == "\"My project\"")
        verify("creating did not start a session", bodies.none { it.first.startsWith("POST sessions") })
    }

    @Test fun managedModel() = journey {
        fleet = Fleet.MANAGED_MODEL
        landOnManagedDraft()
        verifyHead()
        verifyWorkspaceOnlyCard()
        typeManagedFolder("preparing")
        capture("2-model")
    }

    @Test fun managedReady() = journey {
        fleet = Fleet.MANAGED_READY
        landOnManagedDraft()
        verifyWorkspaceOnlyCard()
        verify("nothing was sent", bodies.none { it.first.startsWith("POST sessions") })
        capture("3-ready")
    }

    @Test fun bareMachine() = journey {
        fleet = Fleet.MACHINE
        signIn()
        awaitTag("machine-setup-card")
        await("the welcome head on the setup card") { says(WelcomeCopy.welcomeTitle("Mia Chen")) }
        verify("the card's title gives way to the greeting", !says(MachineSetupCopy.setupNewWorkspaceTitle("mia-macbook")))
        // The card makes the workspace from a folder and a name: no sign-in, no examples, no composer.
        verify("the folder and the name", says(MachineSetupCopy.SETUP_FOLDER_HINT) && says(MachineSetupCopy.SETUP_NAME_HINT))
        verify("no sign-in and no examples", !says(WelcomeSignInCopy.USE_API_KEY_INSTEAD) && !exists(hasTestTag("welcome-example"), unmerged = true))
        capture("4-machine")
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
        openManagedDraftByHand()
        awaitTag("new-session-engine")
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
        await("the card's title") { says(MachineSetupCopy.setupNewWorkspaceTitle("mia-macbook")) }
        awaitNewAccountRead()
        verify("no greeting and no examples", !says(WelcomeCopy.welcomeTitle("Mia Chen")) && !exists(hasTestTag("welcome-example"), unmerged = true))
        verify("no sign-in on the card", !says(RunnerCopy.SIGN_IN) && !says(WelcomeSignInCopy.USE_API_KEY_INSTEAD))
        capture("6-history-machine")
    }
}
