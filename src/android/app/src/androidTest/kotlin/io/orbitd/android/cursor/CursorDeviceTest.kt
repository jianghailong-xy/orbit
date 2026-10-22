package io.orbitd.android.cursor

import android.app.UiAutomation
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Cursor CLI's screens on the emulator, through the real product shell over controlled HTTP (MockWebServer inside the instrumentation),
 * in the light and the dark appearance: the frames of the owner's board docs/mocks/cursor-engine, iOS 1–6, which Android follows (P7c).
 * Every answer is a fixture in the shape the runner and the server give (docs/cursor-runtime-contract.md); no real Cursor account, key,
 * runner or prompt is claimed by this test. Its screenshots land in files/p7c-cursor, which scripts/cursor-device-test.sh pulls.
 */
@RunWith(AndroidJUnit4::class)
class CursorDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val automation: UiAutomation get() = instrumentation.uiAutomation
    private val calls = CopyOnWriteArrayList<String>()
    private val now get() = Instant.now()
    private fun at(minutes: Long) = now.plusSeconds(minutes * 60).toString()

    private val workspace = "01a0cca7-8609-70ed-a0e2-d4b55b832c01"
    private val hpc = "01a0cca7-8609-70ed-a0e2-d4b55b832c02"
    private val mac = "01a0cca7-8609-70ed-a0e2-d4b55b832c03"
    private val build = "01a0cca7-8609-70ed-a0e2-d4b55b832c04"
    private val session = "01a0cca7-8609-70ed-a0e2-d4b55b832c05"
    private val keyValid = "01a0cca7-8609-70ed-a0e2-d4b55b832c06"
    private val keyRejected = "01a0cca7-8609-70ed-a0e2-d4b55b832c07"
    /** A session of its own for the usage limit, so its transcript is that turn alone, as the board draws it. */
    private val quotaSession = "01a0cca7-8609-70ed-a0e2-d4b55b832c0a"

    @Volatile private var theme = "light"
    /** Cursor CLI on hpc, as its runner reports it: ready, not installed, signed out, a runner too old for it, a build it won't run. */
    @Volatile private var cursorState = "ready"
    /** The account's Cursor keys: none, for the board's runner that is signed out and has no key either. */
    @Volatile private var cursorKeys = true
    /** The Cursor CLI session: talked or not, or running with a message queued; [quota]: Default met Cursor's usage limit. */
    @Volatile private var talked = true
    @Volatile private var running = false
    @Volatile private var quota = false
    @Volatile private var model = "default"
    @Volatile private var effort = ""
    @Volatile private var mode = "acceptEdits"
    /** The sign-in relay as GET runners/:id/login reads it; POST login and DELETE move it on. */
    @Volatile private var loginRelay = """{"status":null}"""
    /** What POST login answers first: the relay the runner picks up on its next check-in, or the link it then relays. */
    @Volatile private var loginStarts = "link"
    /** The account Add Account added, once its sign-in landed. */
    @Volatile private var added = false
    @Volatile private var accountRemove = "null"

    @Test fun cursorScreensLight() = tour("light")
    @Test fun cursorScreensDark() = tour("dark")

    private fun tour(pass: String) {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Dedicated signed-out debug installation required", app.session.state.value is AuthState.SignedOut)
        theme = pass
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                signIn(server)
                newSession(pass)
                cursorSession(pass)
                infrastructure(pass)
            } catch (e: Throwable) {
                capture("$pass-failed"); throw e
            } finally {
                File(dir, "requests-$pass.txt").writeText(calls.joinToString("\n"))
                runBlocking { app.session.logout() }
            }
        }
    }

    // iOS 1 · the new session's Engine list and the four ways Cursor CLI can't run on a machine

    private fun newSession(pass: String) {
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("workspace:$workspace").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("workspace:$workspace").performClick()
        // The page's own New session, not the closed drawer's off to the left.
        val newSession = hasText("New session") and hasClickAction() and isEnabled()
        compose.waitUntil(15_000) { compose.onAllNodes(newSession).fetchSemanticsNodes().any { it.boundsInRoot.left >= 0 } }
        compose.onAllNodes(newSession)[compose.onAllNodes(newSession).fetchSemanticsNodes().indexOfFirst { it.boundsInRoot.left >= 0 }].performClick()
        await("Engine")
        engines()
        capture("ios1-engines-$pass")
        click(hasTestTag("engine:cursor"))
        compose.waitUntil(15_000) { compose.onAllNodes(hasContentDescription("Model Auto")).fetchSemanticsNodes().isNotEmpty() }
        capture("ios1-new-session-$pass")
        for (state in listOf("not-installed", "signed-out", "update-runner", "wrong-version")) {
            cursorState = state; cursorKeys = state != "signed-out"
            engines()
            compose.onNodeWithTag("engine:cursor").performScrollTo()
            capture("ios1-row-$state-$pass")
            click(hasText("Done") and hasAnyAncestor(isDialog()), scroll = false)
        }
        cursorState = "ready"; cursorKeys = true
        back()
    }

    /** The Engine list, its catalogue read afresh. */
    private fun engines() {
        click(hasTestTag("new-session-engine"))
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("engine:cursor").fetchSemanticsNodes().isNotEmpty() }
    }

    // iOS 5 and 6 · a Cursor CLI session

    private fun cursorSession(pass: String) {
        talked = true; running = false; quota = false; model = "default"; effort = ""
        open("orbit-session:$session")
        await("five runs in a row now pass")
        modelMenu()
        await("Auto picks a model for each request.")
        capture("ios5-model-auto-$pass")
        compose.onNodeWithTag("composer-mode:bypassPermissions").performScrollTo()
        capture("ios6-modes-$pass")
        compose.onNodeWithTag("composer-provider-move-blocked").performScrollTo()
        capture("ios6-switch-blocked-$pass")
        click(hasText("Claude Opus 5.5") and hasClickAction() and hasAnyAncestor(isDialog()))
        compose.waitUntil(15_000) { model == "claude-opus-5-5" }
        closeDialog()
        model = "claude-opus-5-5[context=1m,fast=true]"; effort = "high"
        reopen()
        modelMenu()
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("composer-cursor-speed:true").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer-cursor-speed:true").performScrollTo()
        capture("ios5-model-variant-$pass")
        closeDialog()
        val named = "Claude Opus 5.5 High · 1M · Fast"
        compose.waitUntil(15_000) { compose.onAllNodes(hasText(named)).fetchSemanticsNodes().isNotEmpty() }
        capture("ios5-chip-$pass")
        click(hasText("Context: Unavailable", substring = true) and hasClickAction())
        await("Context window")
        // The sheet reads the catalogue afresh: its model is named once that is in.
        compose.waitUntil(15_000) { compose.onAllNodes(hasText(named) and hasAnyAncestor(isDialog())).fetchSemanticsNodes().isNotEmpty() }
        capture("ios5-context-$pass")
        closeDialog()
        model = "default"; effort = ""; running = true
        reopen()
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("pending-tray-note").fetchSemanticsNodes().isNotEmpty() }
        capture("ios5-running-$pass")
        running = false; quota = true
        back()
        open("orbit-session:$quotaSession")
        await("Cursor answered “Upgrade your plan to continue”")
        compose.onNodeWithTag("auto-retry-card").performScrollTo()
        capture("ios5-quota-$pass")
        quota = false; talked = false
        reopen()
        modelMenu()
        compose.onNode(hasText("API keys") and hasAnyAncestor(isDialog())).performScrollTo()
        capture("ios6-switch-open-$pass")
        closeDialog()
        talked = true
    }

    private fun modelMenu() {
        click(hasTestTag("composer-model") and isEnabled())
        compose.waitUntil(15_000) { compose.onAllNodes(hasText("Provider") and hasAnyAncestor(isDialog())).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun closeDialog() = click(hasText("Close") and hasAnyAncestor(isDialog()), scroll = false)
    /** The session page again, read afresh. */
    private fun reopen() {
        back()
        open("orbit-session:$session")
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("composer-model") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
    }

    // iOS 2, 3 and 4 · Infrastructure, a machine, Cursor CLI's engine page, its accounts and a Cursor key

    /** hpc's row among the machines — not a "Needs you" line that names it. */
    private val hpcRow = hasText("hpc") and hasText(" running", substring = true) and hasClickAction()

    private fun infrastructure(pass: String) {
        back()
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        click(hasText("Settings") and hasClickAction())
        click(hasText("Infrastructure") and hasClickAction())
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("engine-sources:cursor").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("engine-sources:cursor").performScrollTo()
        capture("ios2-infrastructure-$pass")
        compose.onNodeWithTag("api-key:cursor-api-2").performScrollTo()
        capture("ios4-keys-$pass")
        click(hasTestTag("api-key:cursor-api"))
        await("Valid · ")
        capture("ios4-key-valid-$pass")
        back()
        click(hasTestTag("api-key:cursor-api-2"))
        await("Rejected · ")
        capture("ios4-key-rejected-$pass")
        back()
        // hpc: Cursor CLI last among its engines, then its engine page.
        click(hpcRow)
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("engine-row:cursor").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("engine-row:cursor").performScrollTo()
        capture("ios2-machine-$pass")
        click(hasTestTag("engine-row:cursor"))
        await("Free plan · ~/.orbit/cursor/default")
        capture("ios2-engine-page-$pass")
        accounts(pass)
        back()
        // The ways a machine can't run it: each on hpc's row, and the engine page of a missing build and of one it won't run.
        for (state in listOf("signed-out", "update-runner", "wrong-version", "not-installed")) {
            cursorState = state
            back()
            click(hpcRow)
            compose.waitUntil(15_000) { compose.onAllNodesWithTag("engine-row:cursor").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("engine-row:cursor").performScrollTo()
            capture("ios2-state-$state-$pass")
            if (state == "wrong-version" || state == "not-installed") {
                click(hasTestTag("engine-row:cursor"))
                await(if (state == "wrong-version") "Reinstall Cursor CLI" else "Install Cursor CLI")
                capture("ios2-state-$state-page-$pass")
                back()
            }
        }
        cursorState = "ready"
    }

    /** iOS 3: Add Account's start, its link and its expiry, an account's menu, Sign In Again, Remove with its refusal, and an added
     * account landing. */
    private fun accounts(pass: String) {
        loginRelay = """{"status":null}"""; loginStarts = "pending"
        click(hasText("Add Account") and hasClickAction())
        await("Starting sign-in on the runner…")
        capture("ios3-add-pending-$pass")
        loginRelay = link(null)
        await("Sign in on cursor.com with the account you are adding:")
        await("link expires in")
        capture("ios3-add-link-$pass")
        loginRelay = """{"status":"failed","engine":"cursor","reason":"expired","message":"The sign-in link expired before anyone signed in with it."}"""
        await("The sign-in link expired before anyone signed in with it.")
        capture("ios3-add-expired-$pass")
        // A new link, and this time somebody signs in with it: the runner reports the account (the page reads it every 10 s), and
        // the card folds back into its row.
        loginStarts = "link"
        click(hasText("Get a New Link") and hasClickAction())
        await("link expires in")
        added = true
        loginRelay = """{"status":"done","engine":"cursor","account":null}"""
        val row = "~/.orbit/cursor-accounts/9b1f42c7"
        compose.waitUntil(30_000) { compose.onAllNodesWithText(row, substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.waitUntil(30_000) { compose.onAllNodes(hasText("Add Account") and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(row, substring = true).performScrollTo()
        capture("ios3-add-done-$pass")
        loginRelay = """{"status":null}"""
        click(hasContentDescription("More for Team"))
        await("Sign In Again")
        capture("ios3-account-menu-$pass")
        click(hasText("Sign In Again") and hasClickAction(), scroll = false)
        await("Sign in on cursor.com with this account again:")
        capture("ios3-resign-link-$pass")
        click(hasText("Cancel") and hasClickAction())
        click(hasContentDescription("More for Team"))
        click(hasText("Remove…") and hasClickAction(), scroll = false)
        await("Remove “Team” from hpc?")
        capture("ios3-remove-confirm-$pass")
        click(hasText("Remove") and hasAnyAncestor(isDialog()), scroll = false)
        await("Team is in use: 2 sessions on hpc are running on it.")
        capture("ios3-remove-refused-$pass")
        accountRemove = "null"
    }

    // The shell

    private val dir get() = File(app.filesDir, "p7c-cursor").apply { mkdirs() }
    private fun signIn(server: MockWebServer) {
        runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "p7c@example.test", "controlled-fixture") }
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    /** A link as Android delivers one to the running Activity. */
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun await(text: String) {
        compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun click(matcher: SemanticsMatcher, scroll: Boolean = true) {
        compose.waitUntil(15_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        if (scroll) try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun back() { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); compose.waitForIdle() }
    private fun capture(label: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        // Semantics can be current a frame before the display is: let the frame reach the screen.
        SystemClock.sleep(900)
        // Under load UiAutomation can hand back no bitmap: try again before giving up on the frame.
        val bitmap = (1..4).firstNotNullOfOrNull { automation.takeScreenshot() ?: run { SystemClock.sleep(1_000); null } } ?: return
        File(dir, "$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    // The controlled server

    private val opus = """{"value":"claude-opus-5-5","label":"Claude Opus 5.5","reasoningLevels":["low","medium","high","xhigh","max"],"defaultReasoningLevel":"medium",
        "parameters":[{"id":"context","label":"Context","category":"model_config","default":"300k","values":[{"value":"300k","label":"300K"},{"value":"1m","label":"1M"}]},
          {"id":"effort","label":"Effort","category":"thought_level","default":"medium","values":[{"value":"low","label":"Low"},{"value":"medium","label":"Medium"},
            {"value":"high","label":"High"},{"value":"xhigh","label":"Extra High"},{"value":"max","label":"Max"}]},
          {"id":"fast","label":"Fast","category":"model_config","default":"false","values":[{"value":"false","label":"Off"},{"value":"true","label":"Fast"}]}]}"""
    private val cursorCatalog = """[{"value":"default","label":"Auto"},$opus,{"value":"claude-sonnet-5-5","label":"Claude Sonnet 5.5"},{"value":"gpt-5.5","label":"GPT-5.5"},
        {"value":"gemini-3.8-pro","label":"Gemini 3.8 Pro"},{"value":"grok-4.7","label":"Grok 4.7"},{"value":"composer-2.5","label":"Composer 2.5"}]"""
    private fun cursorAccounts() = """[{"id":"default","auth":"yes","home":"/root/.orbit/cursor/default"},
        {"id":"5c2e91a0","name":"Team","auth":"yes","home":"/root/.orbit/cursor-accounts/5c2e91a0"}${if (!added) "" else """,
        {"id":"9b1f42c7","name":"Account 3","auth":"yes","home":"/root/.orbit/cursor-accounts/9b1f42c7"}"""}]"""
    private fun cursorUsage() = """{"cursor":{"provider":"cursor","account":"default","planName":"Free",
        "includedUsage":{"startsAt":"${at(-25 * 24 * 60)}","resetsAt":"${at(5 * 24 * 60)}"${if (quota) ""","limitReachedAt":"${at(-30)}"""" else ""}},
        "accounts":{"5c2e91a0":{"provider":"cursor","account":"5c2e91a0","planName":"Pro",
          "includedUsage":{"period":"monthly","startsAt":"${at(-15 * 24 * 60)}","resetsAt":"${at(6 * 24 * 60)}","percentUsed":34}}${if (!added) "" else """,
          "9b1f42c7":{"provider":"cursor","account":"9b1f42c7","planName":"Pro",
            "includedUsage":{"period":"monthly","startsAt":"${at(-3 * 24 * 60)}","resetsAt":"${at(27 * 24 * 60)}","percentUsed":3}}"""}}}}"""
    /** hpc: every engine, and Cursor CLI in [cursorState]. */
    private fun hpcRunner(): String {
        val cursor = when (cursorState) {
            "not-installed" -> """{"engine":"cursor","installed":false,"installationError":"CURSOR_NOT_INSTALLED: Cursor CLI 2026.10.14-941492e is not installed in Orbit's version directory"}"""
            "signed-out" -> """{"engine":"cursor","installed":true,"version":"2026.10.14-941492e","auth":"no"}"""
            "update-runner" -> null
            "wrong-version" -> """{"engine":"cursor","installed":true,"version":"2026.10.16-e3cb207",
                "installationError":"CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly 2026.10.14-941492e"}"""
            else -> """{"engine":"cursor","installed":true,"version":"2026.10.14-941492e","auth":"yes",
                "update":{"status":"checked","at":"${at(-6)}","okAt":"${at(-6)}"},"accounts":${cursorAccounts()}}"""
        }
        val capabilities = listOfNotNull("\"provider:dsh\"", "\"provider:cursor\"".takeIf { cursorState in setOf("ready", "signed-out") },
            "\"cursor-account-login/v1\"".takeIf { cursorState != "update-runner" }).joinToString(",")
        val engines = listOfNotNull(
            """{"engine":"claude","installed":true,"version":"2.1.302 (Claude Code)","auth":"yes","update":{"status":"checked","at":"${at(-6)}","okAt":"${at(-6)}"}}""",
            """{"engine":"codex","installed":true,"version":"0.164.0","auth":"yes","update":{"status":"checked","at":"${at(-6)}","okAt":"${at(-6)}"}}""",
            """{"engine":"kimi","installed":true,"version":"2.1.4","auth":"yes","kimiRegion":"global","update":{"status":"checked","at":"${at(-6)}","okAt":"${at(-6)}"}}""",
            """{"engine":"opencode","installed":true,"version":"1.18.40","auth":"unknown","update":{"status":"checked","at":"${at(-6)}","okAt":"${at(-6)}"}}""",
            """{"engine":"dsh","installed":true,"version":"0.2.0","auth":"unknown","dsh":{"versionCompatible":true}}""",
            cursor).joinToString(",")
        return """{"id":"$hpc","name":"hpc","displayName":"hpc","hostname":"hpc","version":"0.1.262","online":true,"status":"ONLINE",
            "lastHeartbeatAt":"$now","maxConcurrent":4,"activeSessions":1,"runsAsRoot":false,"capabilities":[$capabilities],"engines":[$engines],
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],"codex":[{"value":"gpt-5.6-sol","label":"gpt-5.6-sol"}],
              "kimi":[{"value":"kimi-for-coding","label":"Kimi for Coding"}],"dsh":[{"value":"deepseek-v4","label":"DeepSeek V4 Pro"}],"cursor":$cursorCatalog},
            "planUsage":${cursorUsage()},"accountRemove":$accountRemove,"enrolledAt":"2026-09-01T00:00:00Z"}"""
    }
    /** mac-studio predates Cursor CLI; build-box knows it and doesn't have it. */
    private fun others() = """{"id":"$mac","name":"mac-studio","displayName":"mac-studio","version":"0.1.236","online":true,"status":"ONLINE","lastHeartbeatAt":"$now",
          "maxConcurrent":2,"activeSessions":0,"capabilities":[],"engines":[{"engine":"claude","installed":true,"version":"2.1.290","auth":"yes"}],"enrolledAt":"2026-09-01T00:00:00Z"},
        {"id":"$build","name":"build-box","displayName":"build-box","version":"0.1.262","online":true,"status":"ONLINE","lastHeartbeatAt":"$now",
          "maxConcurrent":2,"activeSessions":0,"capabilities":["cursor-account-login/v1"],
          "engines":[{"engine":"claude","installed":true,"version":"2.1.302","auth":"yes"},{"engine":"cursor","installed":false,
            "installationError":"CURSOR_NOT_INSTALLED: Cursor CLI 2026.10.14-941492e is not installed in Orbit's version directory"}],"enrolledAt":"2026-09-01T00:00:00Z"}"""
    private fun user() = """{"id":"fixture-user","name":"P7c fixture","email":"p7c@example.test","role":"ADMIN","avatarUpdatedAt":null,
        "preferences":{"theme":"$theme","defaultPermissionMode":"default"}}"""
    private fun workspaceJson() = """{"id":"$workspace","name":"orbit","runnerId":"$hpc","enabled":true,"workDir":"/root/orbit","provider":"claude",
        "model":"claude-opus-5-5","lastProvider":"claude","lastEngine":"claude","env":{},"position":0,"createdAt":"2026-09-01T00:00:00Z"}"""
    private fun sessionJson(id: String = session): String {
        val quota = id == quotaSession
        val running = running && !quota
        val status = if (running) "RUNNING" else "AWAITING_INPUT"
        return """{"id":"$id","title":"Fix the flaky export test","status":"$status","runState":"$status","runStatus":"$status","lifecycleState":"OPEN",
            "engine":"cursor","provider":"cursor","model":"$model","effort":"$effort","permissionMode":"$mode","numTurns":${if (talked) 1 else 0},
            ${if (talked) "\"runtimeSessionId\":\"0b4c11e2-3f1a-4c55-9d2e-6a1f0c7b9e21\"," else ""}
            "assignedRunnerId":"$hpc","assignedRunner":{"id":"$hpc","name":"hpc"},"agentId":"$workspace","agent":{"id":"$workspace","name":"orbit"},
            "workspace":{"id":"$workspace","name":"orbit"},"retryAttempts":${if (quota) 1 else 0},"createdAt":"${at(-60)}","lastTurnAt":"${at(-5)}",
            "capabilities":{"canSend":true,"canResume":false,"canComplete":true},"tags":[],"pendingApprovals":0}"""
    }
    private fun events(id: String): String {
        val quota = id == quotaSession
        fun event(seq: Int, type: String, text: String) = buildJsonObject {
            put("type", type); put("seq", seq); put("ts", at(-30L + seq)); putJsonObject("payload") { put("text", text) } }.toString()
        val list = if (quota) listOf(event(1, "user", "Add a regression test for the midnight case too."),
            event(2, "assistant", "You've hit your usage limit on Cursor. Cursor said: \"Upgrade your plan to continue.\""))
        else listOf(event(1, "user", "The nightly export test fails about once a week. Find out why and fix it."),
            event(2, "assistant", "The test builds “yesterday” in the machine’s local time zone, so it misses a row just after midnight UTC. " +
                "I pinned the test clock to UTC; five runs in a row now pass.")) +
            (if (running) listOf(event(3, "user", "Run the whole suite before you commit.")) else emptyList())
        return """{"events":${list.joinToString(",", "[", "]")},"hasMore":false}"""
    }
    /** Cursor CLI's sign-in link as the runner relays it, with when it stops working. */
    private fun link(account: String?) = """{"status":"awaiting_approval","engine":"cursor","account":${account?.let { "\"$it\"" } ?: "null"},
        "url":"https://cursor.com/loginDeepControl?challenge=Q2hhbGxlbmdlRm9yT3JiaXRQN2M&uuid=7d2e4f61&mode=login&redirectTarget=cli","expiresAt":"${at(26)}"}"""
    /** The account's own keys (GET providers/mine), and the keys a session can pick (GET providers): two Cursor keys, one of them
     * refused by Cursor, while [cursorKeys], and a DeepSeek key. */
    private fun keys() = (if (!cursorKeys) emptyList() else listOf(
        """{"id":"$keyValid","slug":"cursor-api","label":"Cursor","runtime":"cursor","presetSlug":"cursor-api","baseUrl":"https://api2.cursor.sh",
          "hasApiKey":true,"enabled":true,"models":[],"defaultModel":"","engines":["cursor"],"keyCheckState":"VALID","keyCheckedAt":"${at(-4)}"}""",
        """{"id":"$keyRejected","slug":"cursor-api-2","label":"Cursor 2","runtime":"cursor","presetSlug":"cursor-api","baseUrl":"https://api2.cursor.sh",
          "hasApiKey":true,"enabled":true,"models":[],"defaultModel":"","engines":["cursor"],"keyCheckState":"INVALID","keyCheckedAt":"${at(-4)}"}""")) +
        """{"id":"01a0cca7-8609-70ed-a0e2-d4b55b832c08","slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek",
          "baseUrl":"https://api.deepseek.com/anthropic","hasApiKey":true,"enabled":true,"defaultModel":"deepseek-v4-pro","models":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro"}],
          "engines":["claude","opencode","dsh"]}"""
    private fun providers() = (if (!cursorKeys) emptyList() else listOf(
        """{"slug":"cursor-api","label":"Cursor","runtime":"cursor","presetSlug":"cursor-api","engines":["cursor"],"modelsFromRuntime":true,"models":[]}""",
        """{"slug":"cursor-api-2","label":"Cursor 2","runtime":"cursor","presetSlug":"cursor-api","engines":["cursor"],"modelsFromRuntime":true,"models":[]}""")) +
        """{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","defaultModel":"deepseek-v4-pro","engines":["claude","opencode","dsh"],
          "models":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro"}]}"""

    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            // Each id as these fixtures spell it, whichever form the app sent it in.
            val ids = listOf(workspace, hpc, mac, build, session, quotaSession, keyValid, keyRejected)
            val path = request.requestUrl!!.encodedPath.split('/').joinToString("/") { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
            calls += "${request.method} $path"
            if (path == "/dl/version.json") return json("""{"version":"0.1.262"}""")
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            fun bodyOf() = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
            if (path == "/api/events" || path.startsWith("/api/sessions/") && path.endsWith("/events") && request.requestUrl!!.queryParameter("sinceSeq") != null)
                return MockResponse().setHeader("Content-Type", "text/event-stream").setChunkedBody(": connected\n\n".repeat(120), 13)
                    .throttleBody(13, 1, TimeUnit.SECONDS)
            val body = when (path) {
                "/api/auth/login" -> """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":${user()}}"""
                "/api/auth/logout" -> "{}"
                "/api/users/me" -> user()
                "/api/workspaces" -> "[${workspaceJson()}]"
                "/api/workspaces/$workspace" -> workspaceJson()
                "/api/runners" -> "[${hpcRunner()},${others()}]"
                "/api/runners/$hpc" -> hpcRunner()
                "/api/runners/$hpc/login" -> when (request.method) {
                    "POST" -> {
                        val account = bodyOf()["account"]?.jsonPrimitive?.content
                        loginRelay = if (loginStarts == "pending") """{"status":"pending","engine":"cursor","account":null}""" else link(account)
                        loginRelay
                    }
                    "DELETE" -> { loginRelay = """{"status":"cancelled"}"""; loginRelay }
                    else -> loginRelay
                }
                "/api/runners/$hpc/accounts/cursor/5c2e91a0" -> {
                    accountRemove = """{"engine":"cursor","account":"5c2e91a0","status":"failed",
                        "message":"Team is in use: 2 sessions on hpc are running on it. Remove it once they finish. Its sign-in is untouched."}"""
                    accountRemove
                }
                "/api/sessions" -> if (request.requestUrl!!.queryParameter("view") == "open") "[${sessionJson()}]" else "[]"
                "/api/sessions/counts" -> """[{"workspaceId":"$workspace","active":1,"running":${if (running) 1 else 0},"jobs":0,"needsYou":0}]"""
                "/api/sessions/$session" -> sessionJson()
                "/api/sessions/$quotaSession" -> sessionJson(quotaSession)
                "/api/sessions/$quotaSession/events/page" -> events(quotaSession)
                "/api/sessions/$quotaSession/retry-message" -> """{"text":"Add a regression test for the midnight case too."}"""
                "/api/sessions/$session/config" -> {
                    val patch = bodyOf()
                    patch["model"]?.let { model = it.jsonPrimitive.content }
                    patch["effort"]?.let { effort = it.jsonPrimitive.content }
                    patch["permissionMode"]?.let { mode = it.jsonPrimitive.content }
                    sessionJson()
                }
                "/api/sessions/$session/events/page" -> events(session)
                "/api/sessions/$session/turns" -> if (running) """[{"turnId":"01a0cca7-8609-70ed-a0e2-d4b55b832c09","kind":"message","placement":"queued",
                    "content":"Also add a line about the fix to CHANGELOG.md","attachments":[],"createdAt":"${at(-1)}"}]""" else "[]"
                "/api/providers" -> providers().joinToString(",", "[", "]")
                "/api/providers/mine" -> keys().joinToString(",", "[", "]")
                "/api/providers/pools", "/api/providers/shared-pools" -> "[]"
                else -> when {
                    path.startsWith("/api/providers/mine/") && path.endsWith("/balance") ->
                        """{"ok":true,"isAvailable":true,"fetchedAt":"$now","sharedWith":[],"balances":[{"currency":"CNY","totalBalance":"110.00","grantedBalance":"10.00","toppedUpBalance":"100.00"}]}"""
                    request.method == "GET" -> "[]"
                    else -> "{}"
                }
            }
            return json(body)
        }
        private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    }
}
