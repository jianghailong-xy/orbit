package io.orbitd.android.management

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Point
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.view.Display
import android.view.KeyEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.semantics.SemanticsActions
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
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith

/**
 * The A13 pages driven through the real product shell over controlled HTTP on the emulator: MEMBER and ADMIN,
 * a remote Runner going from offline to online, its deep link, the workspace form, providers, sharing and
 * notifications. No deployed account, real Runner, FCM or iOS result is claimed by this test.
 */
@RunWith(AndroidJUnit4::class)
class ManagementDeviceTest {
    /** On a failure, every thread's stack: an error raised on the main thread names another thread only by number. */
    @get:Rule(order = 0) val threads = object : TestWatcher() {
        override fun failed(e: Throwable, description: Description) {
            val dump = Thread.getAllStackTraces().entries.sortedBy { it.key.id }.joinToString("\n\n") { (thread, stack) ->
                "#${thread.id} ${thread.name} ${thread.state}\n" + stack.joinToString("\n") { "    at $it" }
            }
            File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("threads-${description.methodName}.txt").writeText(dump)
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val calls = CopyOnWriteArrayList<String>()
    @Volatile private var role = "MEMBER"
    @Volatile private var secondRole = "MEMBER"
    @Volatile private var name = "A13 fixture"
    @Volatile private var theme = "system"
    @Volatile private var permission = "auto"
    @Volatile private var forbidden = false
    @Volatile private var runnerOnline = false
    /** The runner's selfUpdate report (JSON); null is a runner too old to report one. */
    @Volatile private var runnerSelfUpdate: String? = null
    /** Runners served instead of the one controlled remote, for the list case; DELETE and reorder change it. */
    @Volatile private var fleet: List<String>? = null
    /** The remote reports Antigravity's Google accounts and more accounts of Claude Code (A13c). */
    @Volatile private var accountsPass = false
    /** Default's Claude login lapses in two days until it is signed in again, then in a month. */
    @Volatile private var claudeRenewed = false
    /** The remote reports Kimi Code's accounts: Default alone on kimi.ai, or with Work on kimi.com ([kimiTwo]); [kimiOld] is a
     * runner too old for Kimi's accounts and sites, its one login signed out. */
    @Volatile private var kimiPass = false
    @Volatile private var kimiTwo = false
    @Volatile private var kimiOld = false
    /** The sign-in relay as GET runners/:id/login reads it; POST login and POST login/code move it on. */
    @Volatile private var loginRelay = """{"status":null,"engine":null,"userCode":null,"url":null,"message":null,"account":null}"""
    @Volatile private var workspaceName = "Fixture workspace"
    @Volatile private var sharingActive = true
    @Volatile private var shareTools = false
    @Volatile private var bearerOnPublicManifest: String? = "unread"
    /** A13d: the account's switch for smart model selection as users/me carries it (absent until written); the access tokens
     * GET access-tokens answers (DELETE revokes one); and the DeepSeek key's balance, too low once [deepSeekLow]. */
    @Volatile private var modelRouting: Boolean? = null
    @Volatile private var revoked = emptySet<String>()
    @Volatile private var deepSeekLow = false
    /** A13g: the Infrastructure pass — Codex signed out on the remote and OpenCode missing there, a second machine offline, a pool no
     * session can start on, and no keys, so OpenCode is Not set up. POST runners/:id/install starts [installRelay] for its engine. */
    @Volatile private var infraPass = false
    @Volatile private var installRelay = "null"
    private val installs = CopyOnWriteArrayList<String>()
    /** When each GET /api/runners came, by the device's clock, and each directory snapshot (the shell's own read of the runners,
     * known by the session folders it reads beside them). */
    private val runnerReads = CopyOnWriteArrayList<Long>()
    private val snapshots = CopyOnWriteArrayList<Long>()
    /** The runners read by a page, not by the shell's directory snapshot. */
    private fun pageReads() = runnerReads.filter { read -> snapshots.none { Math.abs(it - read) < 3_000 } }
    private val workspaceId = "34Tcl0kralZrY8opuLJU4"
    private val runnerId = "34TcwNgAIo6tGUiIKjqnQ"
    private val sessionId = "34TcwNgAIo6tGUiIKjqnS"
    private val thinkPadId = "34TcwNgAIo6tGUiIKjqnT"
    private val now get() = Instant.now()

    @Test fun settingsProfileSharingNotificationsAndRolesUseTheRealRoutes() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            val fontScale = shell("settings get system font_scale").trim().ifEmpty { "1.0" }
            try {
                signIn(server)
                settings()
                assertTrue(compose.onAllNodes(hasText("Admin") and hasClickAction()).fetchSemanticsNodes().isEmpty())
                // The runner is offline here: a line of Infrastructure's Needs you, which the row counts (A13g, iOS 5e75edbde).
                await("1 needs you"); await("1 active")
                capture("settings-home")
                // Default permission and Appearance are menus on their rows — the first on Sessions' page (docs/mocks/ios-settings-order);
                // each write is one preference key.
                click(hasText("Sessions") and hasClickAction()); await("Default permission")
                click(hasText("Default permission") and hasClickAction()); click(hasText("Plan") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { permission == "plan" }
                capture("settings-sessions")
                back(); await("Appearance")
                click(hasText("Appearance") and hasClickAction()); click(hasText("Dark") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { theme == "dark" }
                await("Dark")
                capture("settings-home-dark")
                click(hasText("Appearance") and hasClickAction()); click(hasText("System") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { theme == "system" }
                // The header opens the profile card; Save writes the name and comes back.
                compose.onNodeWithContentDescription("Edit profile").performScrollTo().performClick()
                await("Save profile")
                compose.onNode(hasSetTextAction() and hasText("Name")).performTextReplacement("Updated fixture")
                capture("edit-profile")
                click(hasText("Save profile") and hasClickAction())
                compose.waitUntil(10_000) { name == "Updated fixture" }
                await("Appearance")
                click(hasText("Change password") and hasClickAction())
                await("At least 6 characters")
                capture("change-password")
                back()
                click(hasText("Notifications") and hasClickAction())
                await("When a session finishes")
                compose.onNodeWithText("Push is unavailable in this build. You can still check sessions and decisions in Orbit.").assertExists()
                compose.onNodeWithText("Notifications are on. Manage categories in Android settings.").assertDoesNotExist()
                capture("notifications")
                back()
                click(hasText("Shared links") and hasClickAction())
                await("Fixture shared session")
                capture("shared-links")
                click(hasText("Turn off") and hasClickAction())
                compose.onNode(hasText("Turn off") and hasAnyAncestor(isDialog())).performClick()
                compose.waitUntil(10_000) { !sharingActive }
                await("Nothing is shared right now. Share a session from its ⋯ menu.")
                back()
                // A live role or account revocation clears what was shown; a later read recovers it.
                forbidden = true
                compose.activityRule.scenario.recreate()
                await("Refresh")
                capture("permission-revoked")
                forbidden = false
                click(hasText("Refresh") and hasClickAction())
                await("Updated fixture")
                click(hasText("Sign out") and hasClickAction())
                // iOS 6969f7840 (A13-15): "Sign out?", no server name, Cancel beside it.
                await("Sign out?")
                compose.onNode(hasText("Cancel") and hasAnyAncestor(isDialog())).assertExists()
                capture("sign-out-confirm")
                compose.onNode(hasText("Sign out") and hasAnyAncestor(isDialog())).performClick()
                compose.waitUntil(10_000) { app.session.state.value is AuthState.SignedOut }
                // The same account as ADMIN sees Admin; a demotion elsewhere takes it away on the next read.
                role = "ADMIN"
                signIn(server)
                settings()
                click(hasText("Admin") and hasClickAction())
                await("New user"); await("Second user")
                capture("admin-users")
                click(hasText("Second user") and hasClickAction())
                await("Delete user")
                capture("admin-user")
                click(hasText("Admin") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { secondRole == "ADMIN" }
                role = "MEMBER"
                compose.activityRule.scenario.recreate()
                await("Administrator access is required.")
                capture("admin-demoted")
                back(); back()
                await("Appearance")
                shell("settings put system font_scale 2.0")
                compose.activityRule.scenario.recreate()
                await("Updated fixture")
                // The page reads the account again after the recreate; capture it settled, from the top.
                compose.waitUntil(15_000) { compose.onAllNodes(hasText("Appearance") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithContentDescription("Edit profile").performScrollTo()
                capture("settings-home-font200")
                assertEquals(1, calls.count { it == "PATCH /api/users/me" })
                assertTrue(calls.contains("PATCH /api/admin/users/u2/role"))
                assertTrue(calls.contains("POST /api/share-links/turn-off"))
                assertTrue(calls.none { it.startsWith("DELETE /api/admin") || it.startsWith("POST /api/auth/change-password") })
            } finally {
                shell("settings put system font_scale $fontScale")
                forbidden = false
                runBlocking { app.session.logout() }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("settings-requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    @Test fun workspaceRunnerProvidersAndSessionShareUseTheRealRoutes() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                signIn(server)
                compose.onNodeWithTag("workspace:$workspaceId").performClick()
                await("Fixture session")
                // The session's own Share is the one share panel.
                compose.onNodeWithContentDescription("Options for Fixture session").performClick()
                click(hasText("Share…") and hasClickAction())
                await("Tool calls and output")
                capture("session-share")
                click(hasText("Tool calls and output") and isToggleable())
                compose.waitUntil(10_000) { shareTools }
                compose.onNode(hasText("Close") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
                // The workspace list's gear opens the form; Done writes only what changed.
                compose.onNodeWithContentDescription("Workspace settings").performClick()
                await("Working directory")
                compose.onNode(hasSetTextAction() and hasText("Name")).performTextReplacement("Configured workspace")
                capture("workspace-settings")
                click(hasText("Done") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { workspaceName == "Configured workspace" }
                settings()
                click(hasText("Machines & models") and hasClickAction())
                await("Controlled remote")
                capture("infrastructure")
                click(hasText("Controlled remote") and hasClickAction())
                await("Max Concurrent")
                compose.onAllNodes(hasText("Refresh Model Lists")).assertCountEquals(0)
                capture("runner-offline")
                runnerOnline = true
                compose.activityRule.scenario.recreate()
                await("Refresh Model Lists")
                await("Can’t update itself")
                capture("runner-online")
                click(hasText("Refresh Model Lists") and hasClickAction())
                compose.waitUntil(10_000) { calls.contains("POST /api/runners/$runnerId/refresh-models") }
                // A runner that reports its updates: a failed one says so in its own words and offers Update Runner Now.
                runnerSelfUpdate = """{"state":"failed","reason":"installing 0.1.200: sha256 mismatch for orbit-linux-amd64.gz",""" +
                    """"lastUpdatedAt":"2026-09-20T08:00:00Z","lastUpdatedFrom":"0.1.198","lastUpdatedTo":"0.1.199"}"""
                compose.activityRule.scenario.recreate()
                await("Runner update failed")
                await("Installing 0.1.200: sha256 mismatch")
                capture("runner-update-failed")
                click(hasText("Update Runner Now") and hasClickAction())
                compose.waitUntil(10_000) { calls.contains("POST /api/runners/$runnerId/self-update") }
                await("Checking for a runner release now")
                click(hasText("Claude Code") and hasClickAction())
                await("Add Account")
                capture("runner-engine")
                back(); back(); back()
                compose.activityRule.scenario.onActivity { activity ->
                    val original = activity.intent
                    MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                        .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse("orbit://runner/${ObjectId.canonical(runnerId)}")).setClass(activity, MainActivity::class.java))
                    activity.intent = original
                }
                await("Rotate Token…")
                capture("runner-deep-link")
                back()
                await("Machines & models")
                click(hasText("Machines & models") and hasClickAction())
                await("Team Codex")
                compose.onNodeWithText("Account pools").performScrollTo()
                capture("infrastructure-pools")
                click(hasText("Team Codex") and hasClickAction())
                await("Who can use it")
                capture("codex-pool")
                assertTrue(calls.contains("PATCH /api/workspaces/$workspaceId"))
                assertTrue(calls.contains("PUT /api/sessions/$sessionId/share"))
                assertNull("The release manifest must be read without the account's bearer", bearerOnPublicManifest)
            } finally {
                runBlocking { app.session.logout() }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("runner-requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    /**
     * A13c: Antigravity's Google sign-in and accounts, one quota window per Engines row, an account's row and menu, and the
     * sign-in card (A13-3/4/5/9), through the real shell over controlled HTTP. The card's Paste reads the clipboard, which
     * Android says it did ("pasted from your clipboard"): the platform's own notice, kept.
     */
    @Test fun antigravityAccountsOneWindowAndTheSignInCard() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                role = "ADMIN"; runnerOnline = true; accountsPass = true; claudeRenewed = false
                signIn(server); settings()
                click(hasText("Machines & models") and hasClickAction()); await("Controlled remote")
                click(hasText("Controlled remote") and hasClickAction()); await("Max Concurrent")
                // One window per Engines row; Antigravity's names the account a new session starts on above its own.
                await("Next: Default"); await("2 accounts signed in"); await("98% remaining")
                compose.onAllNodesWithText("98% remaining", substring = true).onFirst().performScrollTo()
                capture("agy-runner-engines")
                click(hasText("Antigravity CLI") and hasClickAction()); await("Accounts"); await("4% remaining")
                capture("agy-engine")
                compose.onAllNodesWithText("Google terms", substring = true).onLast().performScrollTo()
                compose.onNode(hasText("Add Account") and hasClickAction()).assertExists()
                capture("agy-engine-terms")
                back()
                click(hasText("Claude Code") and hasClickAction()); await("Login expires in 2 days")
                await("Sessions can’t use this account until you sign in again.")
                capture("accounts-state")
                compose.onNodeWithContentDescription("More for Work").performScrollTo().performClick()
                await("Resume Now"); await("Change Duration…")
                capture("account-menu")
                click(hasText("Resume Now"), scroll = false)
                compose.waitUntil(10_000) { calls.contains("POST /api/runners/$runnerId/accounts/claude/1fda3f43/pause") }
                // Sign In Again from Default's menu starts at once; the card offers one way out, and Paste sends the code.
                compose.onNodeWithContentDescription("More for Default").performScrollTo().performClick()
                click(hasText("Sign In Again"), scroll = false)
                await("Approve it there, then paste the code the page gives you:")
                assertTrue("one way out while it runs", compose.onAllNodes(hasText("Close") and hasClickAction()).fetchSemanticsNodes().isEmpty())
                compose.onNode(hasText("Paste") and hasClickAction()).performScrollTo()
                capture("sign-in-paste")
                compose.runOnUiThread {
                    (app.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager)
                        .setPrimaryClip(android.content.ClipData.newPlainText("code", "a13c-pasted-code"))
                }
                // Only the focused app reads the clipboard. Android 13+ answers this test's own copy with its clipboard bubble,
                // which can hold the focus for a moment; a user taps Paste back in the app, which has it. So the tap waits for
                // the focus, and is tried again if a read was refused meanwhile. The attempts are kept with the requests.
                var pasteAttempts = 0
                while (!calls.contains("POST /api/runners/$runnerId/login/code") && pasteAttempts < 3) {
                    val focusBy = SystemClock.uptimeMillis() + 10_000
                    while (!compose.activity.hasWindowFocus() && SystemClock.uptimeMillis() < focusBy) SystemClock.sleep(250)
                    pasteAttempts++
                    click(hasText("Paste") and hasClickAction())
                    val sentBy = SystemClock.uptimeMillis() + 5_000
                    while (!calls.contains("POST /api/runners/$runnerId/login/code") && SystemClock.uptimeMillis() < sentBy) {
                        compose.waitForIdle(); SystemClock.sleep(250)
                    }
                }
                calls += "paste attempts=$pasteAttempts"
                assertTrue("Paste sent the code", calls.contains("POST /api/runners/$runnerId/login/code"))
                await("Signed in — this runner is ready.")
                capture("sign-in-pasted")
                // The runner reports Default signed in again, its login a month off: the card folds back into the row.
                // The page's timers run on the test's clock, which a plain sleep never moves: move it with real time.
                val foldBy = System.currentTimeMillis() + 30_000
                while (compose.onAllNodesWithText("Signed in — this runner is ready.", substring = true).fetchSemanticsNodes().isNotEmpty() ||
                    compose.onAllNodesWithText("Login expires", substring = true).fetchSemanticsNodes().isNotEmpty()) {
                    assertTrue("the card folds back once the runner reports the account", System.currentTimeMillis() < foldBy)
                    compose.mainClock.advanceTimeBy(500); compose.waitForIdle(); SystemClock.sleep(200)
                }
                capture("sign-in-folded")
                back()
                // A device code comes first, under one press that copies it and opens its page.
                click(hasText("Codex") and hasClickAction()); await("Sessions on this runner can’t use Codex until you sign in again.")
                click(hasText("Sign In") and hasClickAction())
                await("Enter this one-time code on the sign-in page:"); await("WXYZ-1234"); await("Copy Code & Open Sign-In Page")
                capture("sign-in-device-code")
                click(hasText("Cancel") and hasClickAction())
                compose.waitUntil(10_000) { calls.contains("DELETE /api/runners/$runnerId/login") }
                back()
                assertTrue(calls.contains("POST /api/runners/$runnerId/login"))
            } finally {
                accountsPass = false
                runBlocking { app.session.logout() }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("accounts-requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    /**
     * Kimi Code's accounts (docs/mocks/kimi-accounts/02-ios and its Android notes) through the real shell over controlled HTTP:
     * one login with its site and Add Account; Sign In Again and Add Account asking the site first — the name first on an add —
     * and the device step naming the site of the account being added, the other site one press away; two accounts each on
     * its own site with its own three windows; NEXT on every engine page; and a runner too old for any of it.
     */
    @Test fun kimiAccountsSiteFirstTwoAccountsAndNext() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                role = "ADMIN"; runnerOnline = true; kimiPass = true; kimiTwo = false; kimiOld = false
                signIn(server); settings()
                click(hasText("Machines & models") and hasClickAction()); await("Controlled remote")
                click(hasText("Controlled remote") and hasClickAction()); await("Max Concurrent")
                // One login: its site after its version, and its window nearest the limit.
                await("2.1.1 · kimi.ai · Signed in")
                compose.onAllNodesWithText("2.1.1 · kimi.ai", substring = true).onFirst().performScrollTo()
                capture("kimi-runner-one")
                click(hasText("Kimi Code") and hasClickAction()); await("Accounts"); await("Monthly limit")
                capture("kimi-engine-one")
                // Signing the one login in again asks the site first, its own marked Current.
                compose.onNodeWithContentDescription("More for Default").performScrollTo().performClick()
                click(hasText("Sign In Again"), scroll = false)
                await("Which Kimi account are you signing in with?"); await("Current")
                compose.onNode(hasText("Close") and hasClickAction()).performScrollTo()
                capture("kimi-sign-in-again-default")
                click(hasText("Close") and hasClickAction())
                // Add Account: a name first — the one picked, Account 2 — then the site; nothing is marked Current on an
                // account not signed in yet. The name is not typed: a focused field raises the emulator keyboard's stylus
                // onboarding over the page (RunnerEnginePageTest types one).
                click(hasText("Add Account") and hasClickAction())
                await("Which Kimi account are you signing in with?")
                compose.onNode(hasSetTextAction()).assertTextContains("Account 2")
                compose.onAllNodesWithText("The two sites keep separate accounts", substring = true).onFirst().performScrollTo()
                capture("kimi-add-account")
                click(hasText("kimi.com") and hasClickAction())
                await("Sign in with the kimi.com account you are adding"); await("7K06-QP86")
                compose.onAllNodesWithText("Use kimi.ai instead", substring = true).onFirst().performScrollTo()
                capture("kimi-add-device-code")
                click(hasText("Use kimi.ai instead") and hasClickAction())
                await("Sign in with the kimi.ai account you are adding"); await("Use kimi.com instead")
                capture("kimi-add-use-instead")
                click(hasText("Cancel") and hasClickAction())
                compose.waitUntil(10_000) { calls.contains("DELETE /api/runners/$runnerId/login") }
                // Work added on kimi.com: each account on its own site with its own three windows, NEXT on Default.
                kimiTwo = true
                compose.activityRule.scenario.recreate()
                await("Work"); await("NEXT"); await("kimi.com · ~/.orbit/kimi-accounts/5c2e91a0")
                capture("kimi-engine-two")
                compose.onNodeWithContentDescription("More for Work").performScrollTo().performClick()
                click(hasText("Sign In Again"), scroll = false)
                await("Which Kimi account are you signing in with?"); await("Current")
                compose.onNode(hasText("Close") and hasClickAction()).performScrollTo()
                capture("kimi-sign-in-again-work")
                click(hasText("Close") and hasClickAction())
                back()
                await("2.1.1 · 2 accounts signed in"); await("Next: Default")
                compose.onAllNodesWithText("Next: Default", substring = true).onFirst().performScrollTo()
                capture("kimi-runner-two")
                // NEXT on every engine page, by the same rule.
                for ((engine, shot) in listOf("Claude Code" to "next-claude", "Codex" to "next-codex", "Antigravity CLI" to "next-antigravity")) {
                    click(hasText(engine) and hasClickAction()); await("NEXT")
                    capture(shot)
                    back()
                }
                // A runner too old for Kimi's accounts and sites: its one login under Sign-In, no Add Account, kimi.ai refused.
                kimiOld = true
                click(hasText("Kimi Code") and hasClickAction()); await("Sign-In")
                assertTrue("no Add Account", compose.onAllNodesWithText("Add Account").fetchSemanticsNodes().isEmpty())
                click(hasText("Sign In") and hasClickAction())
                await("Which Kimi account are you signing in with?")
                click(hasText("kimi.ai") and hasClickAction())
                val refusal = "This runner is too old to choose a Kimi site — update it, then try again."
                // The relay is read again every 2 s on the page's clock, which a plain sleep never moves.
                val refusedBy = System.currentTimeMillis() + 30_000
                while (compose.onAllNodesWithText(refusal, substring = true).fetchSemanticsNodes().isEmpty()) {
                    assertTrue("the older runner's refusal is shown", System.currentTimeMillis() < refusedBy)
                    compose.mainClock.advanceTimeBy(500); compose.waitForIdle(); SystemClock.sleep(200)
                }
                capture("kimi-old-runner")
                back()
            } finally {
                kimiPass = false; kimiTwo = false; kimiOld = false
                runBlocking { app.session.logout() }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("kimi-requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    /**
     * A13d's pages (A01b A13-7/13/14/16): Settings' Smart model selection switch — written alone — and Access tokens row; the
     * tokens page's two tabs and a revoke asked first; Providers' new footers and a DeepSeek key's balance at the end of its row,
     * its page — Refresh reading it again, too low this time — and a key DeepSeek refused.
     */
    @Test fun accessTokensSmartSelectionAndDeepSeekBalance() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                role = "ADMIN"; modelRouting = null; revoked = emptySet(); deepSeekLow = false
                signIn(server); settings()
                await("2 active")
                // Smart model selection is on Sessions' page (docs/mocks/ios-settings-order).
                click(hasText("Sessions") and hasClickAction()); await("Smart model selection")
                capture("a13d-settings-sessions")
                click(hasText("Smart model selection") and isToggleable())
                compose.waitUntil(10_000) { modelRouting == true }
                compose.waitUntil(10_000) { runCatching { compose.onNode(hasText("Smart model selection") and isToggleable()).assertIsOn() }.isSuccess }
                capture("a13d-smart-selection-on")
                back(); await("Appearance")
                compose.onAllNodesWithText("Access tokens").onFirst().performScrollTo()
                capture("a13d-settings-account")
                click(hasText("Access tokens") and hasClickAction())
                await("Active 2"); await("orbit_pat_…k3Fq"); await("Never expires")
                capture("a13d-access-tokens")
                click(hasContentDescription("More for laptop"), scroll = false)
                click(hasText("Revoke") and hasClickAction(), scroll = false)
                await("Revoke “laptop”?")
                compose.onNode(hasText("Cancel") and hasAnyAncestor(isDialog())).assertExists()
                capture("a13d-revoke-confirm")
                click(hasText("Revoke") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
                compose.waitUntil(10_000) { calls.contains("DELETE /api/access-tokens/t1") }
                await("Active 1")
                capture("a13d-access-tokens-revoked")
                click(hasText("Revoked & expired 3") and hasClickAction(), scroll = false)
                await("Revoked by an administrator")
                capture("a13d-access-tokens-ended")
                back(); await("Appearance")
                // The keys end the page, below the machines: wait for those (their count heads them once they are read), bring the
                // keys up, then read their balances.
                click(hasText("Machines & models") and hasClickAction()); await(" slots busy")
                compose.onAllNodesWithText("API keys").onFirst().performScrollTo()
                await("¥110.00 · $5.00"); await("Unavailable")
                capture("a13d-infrastructure-keys")
                click(hasText("DeepSeek") and hasClickAction()); await("DeepSeek account balance"); await("Total")
                capture("a13d-deepseek-key")
                deepSeekLow = true
                click(hasText("Refresh", substring = true) and hasClickAction())
                compose.waitUntil(10_000) { calls.count { it == "GET /api/providers/mine/K1/balance" } >= 3 }
                await("Balance too low — DeepSeek calls will fail")
                capture("a13d-deepseek-key-low")
                compose.onAllNodesWithText("Endpoint").onFirst().performScrollTo()
                capture("a13d-deepseek-key-provider")
                back(); await("API keys")
                click(hasText("DeepSeek Harness") and hasClickAction()); await("Couldn't get the balance")
                capture("a13d-deepseek-key-rejected")
                back()
            } finally {
                modelRouting = null; revoked = emptySet(); deepSeekLow = false
                runBlocking { app.session.logout() }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("a13d-requests.txt").writeText(calls.joinToString("\n"))
            }
        }
    }

    /** The module's main pages in the account's dark appearance. Each pass starts from its own fresh activity. */
    @Test fun mainPagesInTheAccountsDarkAppearance() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                role = "ADMIN"; runnerOnline = true; theme = "dark"
                signIn(server)
                tour("dark")
            } finally {
                theme = "system"
                runBlocking { app.session.logout() }
            }
        }
    }

    /** The same pages at twice the system font size, in the light appearance. */
    @Test fun mainPagesAtTwiceTheFontSize() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            val fontScale = shell("settings get system font_scale").trim().takeIf { it.toFloatOrNull() != null } ?: "1.0"
            try {
                role = "ADMIN"; runnerOnline = true; theme = "light"
                fontScale("2.0")
                signIn(server)
                tour("font200")
            } finally {
                fontScale(fontScale)
                theme = "system"
                runBlocking { app.session.logout() }
            }
        }
    }

    /** The system relaunches the activity for a new font scale: go on once the relaunched one has it. */
    private fun fontScale(value: String) {
        shell("settings put system font_scale $value")
        compose.waitUntil(15_000) { compose.activity.resources.configuration.fontScale == value.toFloat() }
        compose.waitForIdle()
    }

    private fun tour(pass: String) = try { visit(pass) } catch (e: Throwable) { capture("$pass-failed"); throw e }

    private fun visit(pass: String) {
        compose.waitUntil(15_000) { compose.onAllNodesWithTag("workspace:$workspaceId").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("workspace:$workspaceId").performClick()
        await("Fixture session")
        compose.onNodeWithContentDescription("Options for Fixture session").performClick()
        click(hasText("Share…") and hasClickAction())
        await("Tool calls and output"); capture("$pass-session-share")
        compose.onNode(hasText("Close") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithContentDescription("Workspace settings").performClick()
        await("Working directory"); capture("$pass-workspace-settings")
        click(hasText("Cancel") and hasClickAction(), scroll = false)
        settings(); capture("$pass-settings-home")
        compose.onNodeWithContentDescription("Edit profile").performScrollTo().performClick(); await("Save profile"); capture("$pass-edit-profile"); back()
        click(hasText("Notifications") and hasClickAction()); await("When a session finishes"); capture("$pass-notifications"); back()
        click(hasText("Shared links") and hasClickAction()); await("Fixture shared session"); capture("$pass-shared-links"); back()
        click(hasText("Admin") and hasClickAction()); await("Second user"); capture("$pass-admin-users"); back()
        click(hasText("Machines & models") and hasClickAction()); await("Controlled remote"); capture("$pass-infrastructure")
        click(hasText("Controlled remote") and hasClickAction()); await("Max Concurrent"); capture("$pass-runner")
        click(hasText("Claude Code") and hasClickAction()); await("Add Account"); capture("$pass-runner-engine")
        back(); back(); back()
        click(hasText("Machines & models") and hasClickAction()); await("Team Codex")
        compose.onNodeWithText("Account pools").performScrollTo(); capture("$pass-infrastructure-pools")
        click(hasText("Team Codex") and hasClickAction()); await("Who can use it"); capture("$pass-codex-pool")
        back(); back()
    }

    /**
     * The runners list with three runners and no Edit mode (iOS 91316c246, A13-11): the first row (not the last) is removed from
     * its ⋯ menu, asked first; the row that moved into its place is dragged by its handle below the next one. One order goes
     * out and the rows stand in it. Before the handles were dropped with their rows, the removed row's handle lay over this one
     * and the drag could start on the removed id and crash.
     */
    @Test fun runnersListRemovesARowThenReordersTheNextByDragging() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            val (alpha, bravo, charlie) = fleetNames.keys.toList()
            try {
                role = "ADMIN"; runnerOnline = true; fleet = listOf(alpha, bravo, charlie)
                signIn(server); settings()
                click(hasText("Machines & models") and hasClickAction()); await("Charlie box")
                compose.onAllNodes(hasText("Edit") and hasClickAction()).assertCountEquals(0)
                // The machines sit under what needs you and what each engine runs on: bring them on screen.
                compose.onNode(hasText("Add Runner") and hasClickAction()).performScrollTo()
                capture("runners-handles")
                click(hasContentDescription("More for Alpha box"), scroll = false)
                capture("runners-row-menu")
                click(hasText("Remove…") and hasClickAction(), scroll = false)
                await("Remove “Alpha box”?")
                compose.onNode(hasText("Cancel") and hasAnyAncestor(isDialog())).assertExists()
                capture("runners-remove-confirm")
                click(hasText("Remove Runner") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
                compose.waitUntil(10_000) { calls.contains("DELETE /api/runners/$alpha") && compose.onAllNodesWithText("Alpha box", substring = true).fetchSemanticsNodes().isEmpty() }
                compose.waitForIdle()
                capture("runners-removed")
                compose.onNode(hasText("Add Runner") and hasClickAction()).performScrollTo()
                compose.onNodeWithTag("runner-handle:$bravo").performTouchInput {
                    down(center)
                    repeat(30) { moveBy(androidx.compose.ui.geometry.Offset(0f, height / 10f)) }
                    up()
                }
                compose.waitUntil(10_000) { calls.contains("POST /api/runners/reorder") }
                compose.waitForIdle()
                capture("runners-dragged")
                assertEquals(listOf(charlie, bravo), fleet)
                assertEquals("One order per drag", 1, calls.count { it == "POST /api/runners/reorder" })
                fun top(name: String) = compose.onAllNodesWithText(name, substring = true).onFirst().fetchSemanticsNode().positionInRoot.y
                assertTrue("The rows stand in the new order", top("Charlie box") < top("Bravo box"))
            } finally {
                fleet = null
                runBlocking { app.session.logout() }
            }
        }
    }

    /**
     * A13g (A13-17 with A07-15 ②, iOS 5e75edbde): Settings' one Infrastructure row says how many things need you; the page says each —
     * a machine offline, a pool no session can start on, and no engine signed out (as on the web's card) — with its way out in the app, then
     * the machines, Add Runner, the pools and the keys, top to bottom; it installs OpenCode from the page of the machine that lacks it,
     * and reads the machines again every 15 s while it is up (on the compose rule's clock, which a test's effects run on) and not while
     * the app is in the background.
     */
    @Test fun infrastructureSaysWhatNeedsYouAndInstallsOpenCode() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            try {
                role = "ADMIN"; runnerOnline = true; infraPass = true; installRelay = "null"
                signIn(server); settings()
                await("2 need you")
                compose.onNodeWithText("Where your agents run, and whose model quota they spend.").assertExists()
                listOf("Runners", "Providers").forEach { compose.onAllNodesWithText(it).assertCountEquals(0) }
                capture("infrastructure-settings-row")
                click(hasText("Machines & models") and hasClickAction())
                await("ThinkPad is offline"); await("Old keys is unavailable")
                compose.onAllNodesWithText("is signed out on", substring = true).assertCountEquals(0)
                capture("infrastructure-needs-you")
                val sections = listOf("Needs you", "Machines", "Add Runner", "Account pools", "API keys")
                // Down the page, on screen or scrolled out of it (boundsInRoot clips to what is on screen).
                val tops = sections.map { compose.onNodeWithText(it).fetchSemanticsNode().positionInRoot.y }
                assertEquals("top to bottom: $sections", tops.sorted(), tops)
                compose.onNodeWithText("2 machines · 1 / 4 slots busy").performScrollTo()
                await("1 / 4 running · 1 of 3 signed in"); capture("infrastructure-machines")
                compose.onNodeWithText("API keys").performScrollTo(); await("No keys yet"); capture("infrastructure-pools-keys")
                // Every line's way out stays in the app: the machine's record, the pool's page.
                click(hasText("Details") and hasClickAction() and hasAnyAncestor(hasTestTag("needs-you:offline:$thinkPadId")))
                await("Max Concurrent"); await("Offline"); capture("infrastructure-details-thinkpad")
                back(); await("Needs you")
                click(hasText("Manage") and hasClickAction() and hasAnyAncestor(hasTestTag("needs-you:pool:P3")))
                await("Account pool"); capture("infrastructure-manage-pool")
                back(); await("Needs you")
                // OpenCode, which the machine lacks: its row on the machine's page opens OpenCode's page, where Install is.
                click(hasText("Controlled remote") and hasText(" running", substring = true) and hasClickAction())
                compose.waitUntil(15_000) { compose.onAllNodesWithTag("engine-row:opencode").fetchSemanticsNodes().isNotEmpty() }
                compose.onNodeWithTag("engine-row:opencode").performScrollTo()
                click(hasTestTag("engine-row:opencode"))
                await("Install OpenCode"); capture("infrastructure-opencode-page")
                click(hasText("Install OpenCode") and hasClickAction())
                compose.waitUntil(10_000) { installs.contains("opencode") }
                await("Installing…"); capture("infrastructure-opencode-installing")
                back(); back(); await("Needs you")
                // The machines, read again every 15 s while the page is up — and not while the app is in the background.
                compose.waitForIdle(); SystemClock.sleep(1_000)
                val before = pageReads().size
                compose.mainClock.advanceTimeBy(15_500); compose.waitUntil(10_000) { pageReads().size >= before + 1 }
                compose.mainClock.advanceTimeBy(15_500); compose.waitUntil(10_000) { pageReads().size >= before + 2 }
                compose.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.STARTED)
                compose.waitForIdle(); SystemClock.sleep(1_000)
                val paused = pageReads().size
                compose.mainClock.advanceTimeBy(46_000); compose.waitForIdle(); SystemClock.sleep(2_000)
                val inBackground = pageReads().size - paused
                compose.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                compose.waitUntil(10_000) { pageReads().size >= paused + inBackground + 1 }
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("infrastructure-reads.txt")
                    .writeText("GET /api/runners at (elapsed ms): $runnerReads\ndirectory snapshots at: $snapshots\n" +
                        "after 2 × 15.5 s on the page: ${paused - before}\nin the background for 46 s: $inBackground\n" +
                        "back in front: ${pageReads().size - paused - inBackground}\n")
                assertEquals("no reads while the app is in the background", 0, inBackground)
            } finally {
                infraPass = false
                runBlocking { app.session.logout() }
            }
        }
    }

    /**
     * TalkBack itself, driven by its own gestures. The instrumentation's UiAutomation is taken with
     * FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES: the default one turns every accessibility service off while it is
     * connected, which kept TalkBack from ever starting. On each main page TalkBack's swipe-right order is walked from
     * the page's first item, recording what it stops on and the words it reads (a row's words are on its children, as
     * TalkBack reads them), besides the whole tree it can reach; a press without words fails. The page's key control then
     * gets TalkBack's focus by a touch on it (explore by touch), is photographed with TalkBack's focus box, and is
     * activated by TalkBack's double tap, whose effect is checked: nothing else presses it. The touches come from the
     * emulator's touchscreen (its console), so they reach TalkBack as a finger's do. TalkBack's settings are put back after.
     */
    @Test fun talkBackReachesReadsAndActivatesTheMainPages() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            val savedServices = shell("settings get secure enabled_accessibility_services").trim()
            val savedEnabled = shell("settings get secure accessibility_enabled").trim()
            val report = StringBuilder(); val problems = mutableListOf<String>()
            val manager = app.getSystemService(AccessibilityManager::class.java)
            // TalkBack asks to post notifications the first time it starts, in a system dialog over the app. It is
            // granted here for the run and put back after, so the dialog neither covers the pages nor is answered.
            val talkBackPackage = talkBack.substringBefore('/')
            val notifying = "android.permission.POST_NOTIFICATIONS: granted=true" in shell("dumpsys package $talkBackPackage")
            try {
                report.appendLine("talkback_package=${shell("pm path $talkBackPackage").trim().ifEmpty { "not installed" }} notifications_granted_before=$notifying")
                if (!notifying) shell("pm grant $talkBackPackage android.permission.POST_NOTIFICATIONS")
                role = "ADMIN"; runnerOnline = true
                signIn(server)
                shell("settings put secure enabled_accessibility_services $talkBack")
                shell("settings put secure accessibility_enabled 1")
                val deadline = SystemClock.uptimeMillis() + 30_000
                while (!manager.isTouchExplorationEnabled && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
                report.appendLine("talkback_enabled=${manager.isEnabled} touch_exploration=${manager.isTouchExplorationEnabled} " +
                    "services=${manager.getEnabledAccessibilityServiceList(android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK).map { it.id }}")
                assertTrue("TalkBack must be running for this check", manager.isTouchExplorationEnabled)
                val front = SystemClock.uptimeMillis() + 10_000
                while (automation.rootInActiveWindow?.packageName?.toString() != app.packageName && SystemClock.uptimeMillis() < front) SystemClock.sleep(250)
                val active = automation.rootInActiveWindow
                report.appendLine("active window: ${active?.packageName}")
                if (active?.packageName?.toString() != app.packageName) {
                    capture("talkback-covered")
                    fun texts(node: AccessibilityNodeInfo): List<String> = words(node) + (0 until node.childCount).mapNotNull(node::getChild).flatMap(::texts)
                    fail("TalkBack's start left ${active?.packageName} over the app: ${active?.let(::texts)}")
                }
                // Between pages: semantics actions and the back key. On each page: TalkBack's gestures only.
                compose.onAllNodesWithContentDescription("Open navigation").onFirst().performSemanticsAction(SemanticsActions.OnClick)
                compose.onNode(hasText("Settings") and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick)
                await("Appearance")
                page("settings-home", report, problems)
                activate("Machines & models", "talkback-settings-infrastructure", report, problems); await("Controlled remote")
                report.appendLine("double tap Infrastructure -> the Infrastructure page opened")
                page("infrastructure", report, problems)
                // The row's own words: its ⋯ button is "More for Controlled remote", and the engines' lines name the machine too.
                activate("1 / 4 running", "talkback-infrastructure-row", report, problems); await("Max Concurrent")
                report.appendLine("double tap the Controlled remote row (1 / 4 running) -> the runner page opened")
                page("runner", report, problems)
                activate("Increase Max Concurrent", "talkback-runner-capacity", report, problems)
                compose.waitUntil(10_000) { calls.any { it == "PATCH /api/runners/$runnerId" } }
                report.appendLine("double tap Increase Max Concurrent -> PATCH /api/runners/$runnerId sent")
                back(); back(); await("Appearance")
                activate("Machines & models", "talkback-settings-infrastructure-pools", report, problems); await("Team Codex")
                report.appendLine("double tap Infrastructure -> the Infrastructure page opened again")
                // The pool's row by its SHARED mark: "Team Codex" is also the Codex engine's pool line, which opens nothing.
                activate("SHARED", "talkback-infrastructure-pool", report, problems); await("Who can use it")
                report.appendLine("double tap Team Codex (SHARED) -> the pool page opened")
                page("codex-pool", report, problems)
                back(); back(); await("Appearance")
                activate("Shared links", "talkback-settings-shared-links", report, problems); await("Fixture shared session")
                report.appendLine("double tap Shared links -> the shared links page opened")
                page("shared-links", report, problems)
                activate("Turn off", "talkback-shared-links-turn-off", report, problems); await("Turn off this link")
                report.appendLine("double tap Turn off -> the confirmation opened")
                compose.onNode(hasText("Cancel") and hasClickAction() and hasAnyAncestor(isDialog())).performSemanticsAction(SemanticsActions.OnClick)
                // The key goes to the window in front: let the dialog go first.
                compose.waitUntil(5_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
                back(); await("Appearance")
                activate("Edit profile", "talkback-settings-profile", report, problems); await("Save profile")
                report.appendLine("double tap Edit profile -> the profile card opened")
                page("edit-profile", report, problems)
                activate("Choose photo", "talkback-profile-photo", report, problems); await("Photo library")
                report.appendLine("double tap Choose photo -> the photo menu opened")
                // The menu is a window of its own, and a key goes to the window in front: the second Back waits until the menu has
                // gone and the page's window is in front again (sent at once, on A15b's first 360×640 dp round, the two Backs left
                // the profile page open).
                back(); compose.waitUntil(5_000) { compose.onAllNodesWithText("Photo library").fetchSemanticsNodes().isEmpty() && compose.activity.hasWindowFocus() }
                back(); await("Appearance")
                activate("Admin", "talkback-settings-admin", report, problems); await("Second user")
                report.appendLine("double tap Admin -> the users list opened")
                page("admin-users", report, problems)
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("talkback-problems.txt").writeText(problems.joinToString("\n"))
                assertTrue("TalkBack problems: $problems", problems.isEmpty())
            } finally {
                console?.close(); console = null
                if (!notifying) shell("pm revoke $talkBackPackage android.permission.POST_NOTIFICATIONS")
                if (savedServices == "null" || savedServices.isBlank()) shell("settings delete secure enabled_accessibility_services")
                else shell("settings put secure enabled_accessibility_services $savedServices")
                if (savedEnabled == "null" || savedEnabled.isBlank()) shell("settings delete secure accessibility_enabled")
                else shell("settings put secure accessibility_enabled $savedEnabled")
                // TalkBack stops a moment after its setting goes: the next holder of the emulator gets plain touch back.
                val off = SystemClock.uptimeMillis() + 15_000
                while (manager.isTouchExplorationEnabled && SystemClock.uptimeMillis() < off) SystemClock.sleep(250)
                report.appendLine("restored services=${shell("settings get secure enabled_accessibility_services").trim()} enabled=${shell("settings get secure accessibility_enabled").trim()} " +
                    "touch_exploration=${manager.isTouchExplorationEnabled}")
                File(app.filesDir, "a13-management").apply { mkdirs() }.resolve("talkback-report.txt").writeText(report.toString())
                runBlocking { app.session.logout() }
            }
        }
    }

    private val talkBack = "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService"

    /** The UiAutomation every call here uses: the default one would switch TalkBack off while it is connected. */
    private val automation: UiAutomation get() = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES).also {
        val info = it.serviceInfo
        if (info.flags and AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS == 0)
            it.serviceInfo = info.apply { flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS }
    }
    /**
     * The app's top window (a dialog over the page, else the page), read afresh: TalkBack's focus can be in another
     * window, and a page that changed under a cached tree would be read as it was. UiAutomation.clearCache() came in API 34
     * (on API 33 it threw NoSuchMethodError, A15 F-45). Below it, setServiceInfo() empties the same cache before it applies
     * the info, so the info is set again as it is. A read without that came back on API 33 with only the top bar of a page
     * (A15g: Machines & models, the pool and shared links).
     */
    private fun appRoot(): AccessibilityNodeInfo? {
        if (Build.VERSION.SDK_INT >= 34) automation.clearCache()
        else automation.apply { serviceInfo = serviceInfo }
        return automation.windows.mapNotNull { it.root }.firstOrNull { it.packageName?.toString() == app.packageName } ?: automation.rootInActiveWindow
    }

    private fun words(node: AccessibilityNodeInfo) = listOfNotNull(node.contentDescription, node.text, node.stateDescription)
        .map { it.toString().trim() }.filter { it.isNotEmpty() }
    /**
     * What TalkBack says on a node it stops on, part by part: its content description in place of its text when it has
     * one, its state, then the words of the children it does not stop on itself.
     */
    private fun spokenParts(node: AccessibilityNodeInfo): List<String> {
        val label = node.contentDescription?.toString()?.trim().orEmpty()
        val own = listOf(label.ifEmpty { node.text?.toString()?.trim().orEmpty() }, node.stateDescription?.toString()?.trim().orEmpty())
        val children = if (label.isNotEmpty()) emptyList()
            else (0 until node.childCount).mapNotNull(node::getChild).filterNot { it.isClickable || it.isCheckable }.flatMap(::spokenParts)
        return (own + children).filter { it.isNotEmpty() }
    }
    private fun spoken(node: AccessibilityNodeInfo) = spokenParts(node).joinToString(", ")
    /** A part TalkBack would read out as a bare symbol ("single right-pointing angle quotation mark"). */
    private fun symbols(node: AccessibilityNodeInfo) = spokenParts(node).filter { part -> part.none(Char::isLetterOrDigit) }
    private fun nodes(root: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> =
        sequenceOf(root) + (0 until root.childCount).asSequence().mapNotNull(root::getChild).flatMap(::nodes)

    /** One page: the whole tree TalkBack can reach, then the order its swipes walk. */
    private fun page(page: String, report: StringBuilder, problems: MutableList<String>) {
        audit(page, report, problems)
        traverse(page, report, problems)
    }

    /** What TalkBack can reach on the active window, with the words it speaks for each. */
    private fun audit(page: String, report: StringBuilder, problems: MutableList<String>) {
        compose.waitForIdle(); SystemClock.sleep(600)
        val root = appRoot() ?: run { problems += "$page: no window of the app"; return }
        val window = Rect().also(root::getBoundsInScreen)
        report.appendLine("## $page — the tree")
        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            val reachable = node.isVisibleToUser && (node.isClickable || node.isFocusable || node.isCheckable)
            val said = if (node.isClickable || node.isCheckable) spoken(node) else words(node).joinToString(" | ")
            val wordless = reachable && node.isClickable && said.isEmpty()
            // A row the window's edge cuts has its words below the edge, out of the tree until TalkBack scrolls to it; so has a row
            // its scrolling list's edge cuts ([rowCut]).
            val cut = wordless && (Rect().also(node::getBoundsInScreen).let { it.bottom >= window.bottom || it.top <= window.top } || rowCut(node) != null)
            if (reachable || said.isNotEmpty()) {
                val actions = node.actionList.mapNotNull { it.label?.toString() }.joinToString(",")
                report.appendLine("${"  ".repeat(depth)}${node.className?.toString()?.substringAfterLast('.')} clickable=${node.isClickable} " +
                    "enabled=${node.isEnabled} says=\"$said\"" + (if (node.isClickable) " (description=\"${node.contentDescription}\" text=\"${node.text}\")" else "") +
                    (if (actions.isNotEmpty()) " actions=[$actions]" else "") + if (cut) " — cut by the window's or its list's edge, not counted" else "")
                if (wordless && !cut)
                    problem(report, problems, "$page: a press without words (${node.className}) at ${Rect().also(node::getBoundsInScreen)}")
                if (reachable && (node.isClickable || node.isCheckable)) symbols(node).forEach { problem(report, problems, "$page: TalkBack reads the bare symbol \"$it\" in \"$said\"") }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
    }

    /**
     * TalkBack's own order: a finger on the page's first item (below the top bar, which TalkBack reaches after the
     * page), then swipe right after swipe right, with what it reads at each stop and when each swipe went out.
     */
    private fun traverse(page: String, report: StringBuilder, problems: MutableList<String>) {
        val root = appRoot() ?: return
        val screen = Rect().also(root::getBoundsInScreen)
        val first = nodes(root).firstOrNull {
            it.isVisibleToUser && (it.isClickable || words(it).isNotEmpty()) && Rect().also(it::getBoundsInScreen).top > screen.height() / 10
        }
        report.appendLine("## $page — TalkBack, swipe right from \"${first?.let(::spoken)}\"")
        val walk = SystemClock.uptimeMillis()
        fun since(time: Long) = "+%.1f s".format(Locale.ROOT, (time - walk) / 1000.0)
        fun inApp() = focused()?.takeIf { it.packageName?.toString() == app.packageName }
        fun key(node: AccessibilityNodeInfo) = "${Rect().also(node::getBoundsInScreen)} ${spoken(node)}"
        first?.let { val at = Rect().also(it::getBoundsInScreen); tap(at.exactCenterX(), at.exactCenterY()); SystemClock.sleep(1_000) }
        // Where TalkBack's focus was before each swipe, as it was read then.
        var last = inApp()?.also { report.appendLine("  ${it.className?.toString()?.substringAfterLast('.')} \"${spoken(it)}\" (touched)") }?.let(::key)
        val photograph = page == "settings-home"
        if (photograph) capture("talkback-walk-$page-0")
        val stops = mutableListOf<String>()
        var unmoved = 0
        var swipes = 0
        while (stops.size < 20 && swipes < 30) {
            val before = last
            val sent = SystemClock.uptimeMillis()
            swipeRight(screen); swipes++
            val took = SystemClock.uptimeMillis() - sent
            SystemClock.sleep(1_000)
            if (photograph && swipes <= 8) capture("talkback-walk-$page-$swipes")
            var node = inApp() ?: run { report.appendLine("  (TalkBack's focus left the app)"); null } ?: break
            // TalkBack 14 (API 33) sometimes moves its focus a second late: looked at again before the swipe counts as let go by.
            if (key(node) == before) {
                SystemClock.sleep(1_000)
                node = inApp() ?: run { report.appendLine("  (TalkBack's focus left the app)"); null } ?: break
            }
            // A swipe past the last item on screen makes TalkBack 14 (API 33) scroll and stop on a row the window's edge cuts, which
            // it then brings on screen: until it has, the row's words are past the edge, out of the tree. Read the row once it is there
            // (A15g, 360×640 dp: 1 s after the swipe, Admin lay cut at the bottom with no words; 0.8 s later it was on screen, "Admin").
            val settled = SystemClock.uptimeMillis() + 3_000
            while (node.isClickable && spoken(node).isEmpty() && SystemClock.uptimeMillis() < settled) {
                SystemClock.sleep(250)
                node = inApp() ?: break
            }
            val said = spoken(node)
            val stop = "${Rect().also(node::getBoundsInScreen)} $said"
            last = stop
            if (stop == before) {
                // TalkBack 14 lets swipes go by: the one after a page's last item, up to six in a row after a touch on a page it has
                // just opened (it then often goes on to the top bar), and one the console sent too slowly to be a swipe (A15g follow-up:
                // each still made a touch interaction). Each is swiped again; after two in a row TalkBack's focus is touched again,
                // as a person would; the list has ended only when six in a row and two touches have not moved it.
                unmoved++
                report.appendLine("  (swipe $swipes at ${since(sent)}, sent in $took ms, left TalkBack's focus on \"$said\")")
                if (unmoved >= 6) { report.appendLine("  (the last item: $unmoved swipes in a row left TalkBack's focus here)"); break }
                if (unmoved % 2 == 0) {
                    val at = Rect().also(node::getBoundsInScreen)
                    // Of a row a list's edge cuts, the part inside the list: its middle may lie under the top bar.
                    scroller(node)?.let { list -> at.intersect(Rect().also(list::getBoundsInScreen)) }
                    val touched = SystemClock.uptimeMillis()
                    tap(at.exactCenterX(), at.exactCenterY()); SystemClock.sleep(1_000)
                    val again = inApp()
                    last = again?.let(::key) ?: last
                    report.appendLine("  (touched \"$said\" again at ${since(touched)} -> TalkBack's focus on \"${again?.let(::spoken)}\")")
                }
                continue
            }
            unmoved = 0
            if (stop in stops) { report.appendLine("  (back to an earlier item)"); break }
            stops += stop
            report.appendLine("  ${node.className?.toString()?.substringAfterLast('.')} \"$said\"" + (if (node.isClickable) " — double tap to activate" else "") +
                " (swipe $swipes at ${since(sent)})")
            if (node.isClickable && said.isEmpty()) {
                // TalkBack 14 also stops on a row its list's edge cuts — wrapping past the top bar onto one under the navigation bar or
                // under the top bar — and says nothing there (TalkBack 16 skips such rows): recorded, not counted, as the tree's are.
                val list = rowCut(node)
                if (list != null) report.appendLine("    (a row its list's edge cuts: at ${Rect().also(node::getBoundsInScreen)}, the list at $list; " +
                    "its words are past the edge, out of the tree: not counted)")
                else problem(report, problems, "$page: TalkBack stops on a press it has no words for")
            }
            if (!node.isClickable && !node.isCheckable) symbols(node).forEach { problem(report, problems, "$page: TalkBack stops on the bare symbol \"$it\"") }
        }
        if (stops.size < 3) problem(report, problems, "$page: TalkBack's swipes reached ${stops.size} item(s)")
    }

    /** The nearest ancestor of [node] that scrolls. */
    private fun scroller(node: AccessibilityNodeInfo): AccessibilityNodeInfo? = generateSequence(node.parent) { it.parent }.firstOrNull { it.isScrollable }

    /**
     * Where [node]'s scrolling list is, when the list's top or bottom edge cuts it: Compose keeps such a row in the tree, under
     * the top bar or below the list under the navigation bar, without the words of the children the edge cuts away (A15g
     * follow-up, 360×640 dp: "Change password" at 1262–1280 px, its list at 176–1232).
     */
    private fun rowCut(node: AccessibilityNodeInfo): Rect? {
        val list = scroller(node)?.let { Rect().also(it::getBoundsInScreen) } ?: return null
        return list.takeIf { Rect().also(node::getBoundsInScreen).let { at -> at.top <= list.top || at.bottom >= list.bottom } }
    }

    /**
     * The control named [words]: on screen (scrolled to by its semantics, as a finger would scroll), TalkBack's focus put
     * on it by a touch and photographed, then TalkBack's double tap. The caller checks what the press did.
     */
    private fun activate(words: String, shot: String, report: StringBuilder, problems: MutableList<String>) {
        val named = hasText(words, substring = true) or hasContentDescription(words, substring = true)
        var target: AccessibilityNodeInfo? = null
        var focus: AccessibilityNodeInfo? = null
        var said = ""
        // A touch aimed from a page still moving (a scroll settling, a page coming back) lands on whatever is there by then, and on
        // a loaded host that is another row (A15 F-23: TalkBack's focus on "Back" for "Edit profile"). TalkBack's focus says where
        // it landed: the control is measured and touched again, up to three times, each touch in the report.
        for (attempt in 1..3) {
            try { compose.onAllNodes(named).onFirst().performScrollTo() } catch (_: AssertionError) { }
            // On screen is not enough: near the bottom the system's gesture bar takes the touch. Bring it to the middle.
            try {
                val y = compose.onAllNodes(named).onFirst().fetchSemanticsNode().boundsInRoot.center.y
                val middle = (appRoot()?.let { Rect().also(it::getBoundsInScreen).height() } ?: 0) / 2f
                compose.onAllNodes(hasScrollAction() and hasAnyDescendant(named)).onFirst()
                    .performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, y - middle) }
            } catch (_: AssertionError) { } catch (_: IllegalStateException) { }
            compose.waitForIdle(); SystemClock.sleep(500)
            // The words as drawn, and the control a finger on them presses (Compose keeps a row's words on its children).
            val label = appRoot()?.let(::nodes)?.firstOrNull { node -> node.isVisibleToUser && words(node).any { it.contains(words) } }
            target = label
            while (target != null && !target.isClickable) target = target.parent
            target = target ?: label
            if (target == null) { capture("$shot-missing"); problem(report, problems, "$shot: nothing on screen is named \"$words\""); return }
            val at = Rect().also(target::getBoundsInScreen)
            report.appendLine("touch \"$words\" at $at" + if (attempt > 1) " (touch $attempt)" else "")
            tap(at.exactCenterX(), at.exactCenterY())
            // TalkBack moves its focus a moment after the touch ends (it first waits to see whether a second tap follows).
            val until = SystemClock.uptimeMillis() + 3_000
            focus = focused()
            while (focus?.let(::spoken)?.contains(words, ignoreCase = true) != true && SystemClock.uptimeMillis() < until) { SystemClock.sleep(200); focus = focused() }
            said = focus?.let(::spoken).orEmpty()
            report.appendLine("touch \"$words\" -> TalkBack's focus on ${focus?.className?.toString()?.substringAfterLast('.')} \"$said\"")
            if (focus != null && said.contains(words, ignoreCase = true)) break
        }
        if (focus == null || !said.contains(words, ignoreCase = true)) problem(report, problems, "$shot: TalkBack's focus is on \"$said\", not \"$words\"")
        capture(shot)
        val on = Rect().also { (focus ?: target!!).getBoundsInScreen(it) }
        doubleTap(on.exactCenterX(), on.exactCenterY())
    }

    /** Where TalkBack's focus is, in whichever window. */
    private fun focused(): AccessibilityNodeInfo? = automation.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY)
    private fun problem(report: StringBuilder, problems: MutableList<String>, what: String) { problems += what; report.appendLine("PROBLEM $what") }

    /**
     * Fingers come from the emulator's console (`event mouse <x> <y> 0 <buttons>` is the emulated touchscreen itself; from
     * inside the emulator the host's loopback is 10.0.2.2), so TalkBack takes them as a finger's. Events injected by
     * UiAutomation or by `input` skip the accessibility input filter and press what is under them, and the shell may not
     * write to the touchscreen's device node. The host script passes the console's port and token for this check only.
     */
    private class Console(port: Int, token: String) {
        private val socket = java.net.Socket("10.0.2.2", port).apply { soTimeout = 5_000; tcpNoDelay = true }
        private val reader = socket.getInputStream().bufferedReader()
        private val writer = socket.getOutputStream().bufferedWriter()
        init { answer(); send("auth $token") }
        fun send(command: String) { writer.write("$command\n"); writer.flush(); answer() }
        private fun answer() {
            while (true) {
                val line = reader.readLine() ?: error("the emulator console closed")
                if (line.startsWith("OK")) return
                if (line.startsWith("KO")) error("the emulator console refused: $line")
            }
        }
        fun close() { runCatching { writer.write("quit\n"); writer.flush() }; runCatching { socket.close() } }
    }
    private var console: Console? = null
    /**
     * Where the screen lies on the console's touchscreen, which is the panel itself: a screen resized by `wm size` (the
     * 360×640 dp rounds) is drawn scaled onto the panel and letterboxed, as Android's LogicalDisplay places it. A touch sent
     * at the screen's own coordinates lands elsewhere: aimed at "Machines & models", on "Session recaps" (A15 F-23, 360×640).
     */
    private val panel: Pair<Rect, Point> by lazy {
        val display = app.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        val screen = Point().also { @Suppress("DEPRECATION") display.getRealSize(it) }
        val pw = display.mode.physicalWidth; val ph = display.mode.physicalHeight
        val (w, h) = if (pw.toLong() * screen.y < ph.toLong() * screen.x) pw to screen.y * pw / screen.x else screen.x * ph / screen.y to ph
        val left = (pw - w) / 2; val top = (ph - h) / 2
        Rect(left, top, left + w, top + h) to screen
    }
    private fun finger(x: Int, y: Int, down: Boolean) {
        val open = console ?: InstrumentationRegistry.getArguments().let { args ->
            Console(args.getString("a13ConsolePort")?.toIntOrNull() ?: error("TalkBack takes touches from the screen only: needs a13ConsolePort"),
                args.getString("a13ConsoleToken") ?: error("needs a13ConsoleToken"))
        }.also { console = it }
        val (frame, screen) = panel
        open.send("event mouse ${frame.left + x * frame.width() / screen.x} ${frame.top + y * frame.height() / screen.y} 0 ${if (down) 1 else 0}")
    }
    /** One finger on [x], [y] (explore by touch): TalkBack's focus goes to what is there, which it reads. */
    private fun tap(x: Float, y: Float) { finger(x.toInt(), y.toInt(), true); SystemClock.sleep(40); finger(x.toInt(), y.toInt(), false) }
    /** Two taps inside the double-tap timeout: TalkBack activates the item its focus is on. */
    private fun doubleTap(x: Float, y: Float) { tap(x, y); SystemClock.sleep(80); tap(x, y); SystemClock.sleep(600) }
    /** One quick finger across the middle of the screen: TalkBack's "next item". */
    private fun swipeRight(screen: Rect) {
        val y = screen.centerY(); val from = screen.width() / 5; val to = screen.width() * 4 / 5
        finger(from, y, true)
        for (i in 1..10) { SystemClock.sleep(15); finger(from + (to - from) * i / 10, y, true) }
        finger(to, y, false)
    }

    private fun start() {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Dedicated signed-out debug installation required", app.session.state.value is AuthState.SignedOut)
    }
    private fun signIn(server: MockWebServer) {
        runBlocking { app.session.login(ServerAddress.parse(server.url("/").toString(), true), "a13@example.test", "controlled-fixture") }
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun settings() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        click(hasText("Settings") and hasClickAction())
        await("Appearance")
    }
    private fun await(text: String) {
        compose.waitUntil(15_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    }
    private fun click(matcher: SemanticsMatcher, scroll: Boolean = true) {
        compose.waitUntil(10_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        if (scroll) try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun back() { instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); compose.waitForIdle() }
    private fun shell(command: String): String = automation.executeShellCommand(command).let { fd ->
        android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().readText()
    }
    private fun capture(label: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync()
        // Semantics can be current a frame before the display is: let the frame reach the screen.
        android.os.SystemClock.sleep(700)
        val dir = File(app.filesDir, "a13-management").apply { mkdirs() }
        automation.takeScreenshot().let { bitmap ->
            File(dir, "$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    private fun user() = """{"id":"fixture-user","name":"$name","email":"a13@example.test","role":"$role","avatarUpdatedAt":null,"preferences":{"theme":"$theme","defaultPermissionMode":"$permission","notifySessionFinished":false,"notifyAgentMessage":true${modelRouting?.let { ",\"modelRouting\":$it" }.orEmpty()}}}"""
    private fun token(id: String, name: String, hint: String, scopes: String, extra: String) =
        """{"id":"$id","name":"$name","tokenHint":"$hint","scopes":$scopes,"createdVia":"WEB","createdAt":"${now.minusSeconds(30 * 86_400)}",""" +
            (if (id in revoked) """"state":"REVOKED","revokedAt":"$now","revokedReason":"USER",""" else "") + extra + "}"
    private val everything = """["tasks:read","tasks:write","projects:read","projects:write","sessions:read","sessions:write","workspaces:read","workspaces:write","runners:read","wiki:read","wiki:write","events:read"]"""
    private fun tokens() = """{"tokens":[""" + listOf(
        token("t1", "laptop", "k3Fq", everything, """"workspaceIds":[],"workspaces":[],"expiresAt":null,"lastUsedAt":"${now.minusSeconds(12_000)}","lastUsedIp":"203.0.113.7"""" +
            if ("t1" in revoked) "" else ""","state":"ACTIVE""""),
        token("t2", "ci", "Zz90", """["tasks:read","tasks:write","sessions:read"]""", """"workspaceIds":["w1","w2"],"workspaces":[{"id":"w1","name":"orbit"}],"expiresAt":"${now.plusSeconds(90 * 86_400)}","lastUsedAt":null,"state":"ACTIVE""""),
        token("t3", "old phone", "Ab12", everything, """"workspaceIds":[],"workspaces":[],"expiresAt":null,"revokedAt":"${now.minusSeconds(2 * 86_400)}","revokedReason":"ADMIN","state":"REVOKED""""),
        token("t4", "spike", "Cd34", """["tasks:read","projects:read","sessions:read","workspaces:read","runners:read","wiki:read","events:read"]""",
            """"workspaceIds":[],"workspaces":[],"expiresAt":"${now.minusSeconds(3 * 86_400)}","state":"EXPIRED""""),
    ).joinToString(",") + "]}"
    /** The account's own keys as GET providers/mine lists them, each with the engines the server says it runs on. */
    private fun mine() = if (infraPass) "[]" else """[{"id":"K1","slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","baseUrl":"https://api.deepseek.com/anthropic","hasApiKey":true,"defaultModel":"deepseek-chat",
          "engines":["claude","opencode","dsh"]},
        {"id":"K2","slug":"dsh","label":"DeepSeek Harness","runtime":"dsh","presetSlug":"deepseek-harness","baseUrl":"https://api.deepseek.com/anthropic","hasApiKey":true,"engines":["dsh","claude","opencode"]},
        {"id":"K3","slug":"openai-work","label":"OpenAI (work)","runtime":"codex","presetSlug":"openai","baseUrl":"https://api.openai.com/v1","hasApiKey":true,"defaultModel":"gpt-5",
          "engines":["codex","opencode"]}]"""
    private fun balance(id: String) = when {
        id == "K2" -> """{"ok":false,"reason":"KEY_REJECTED","message":"DeepSeek rejected this API key (401 Authentication Fails).","fetchedAt":"$now","sharedWith":[]}"""
        deepSeekLow -> """{"ok":true,"isAvailable":false,"fetchedAt":"$now","sharedWith":[],"balances":[{"currency":"CNY","totalBalance":"0.42","grantedBalance":"0.00","toppedUpBalance":"0.42"}]}"""
        else -> """{"ok":true,"isAvailable":true,"fetchedAt":"$now","sharedWith":[],"balances":[{"currency":"CNY","totalBalance":"110.00","grantedBalance":"10.00","toppedUpBalance":"100.00"},{"currency":"USD","totalBalance":"5.00","grantedBalance":"0.00","toppedUpBalance":"5.00"}]}"""
    }
    private fun heartbeat() = if (runnerOnline) now.toString() else now.minusSeconds(5 * 3600).toString()
    private val fleetNames = mapOf("0198f3a2-aaaa-7000-8000-00000000000a" to "Alpha box", "0198f3a2-bbbb-7000-8000-00000000000b" to "Bravo box",
        "0198f3a2-cccc-7000-8000-00000000000c" to "Charlie box")
    private fun fleetList(ids: List<String>) = ids.joinToString(",", "[", "]") { id ->
        """{"id":"$id","name":"${fleetNames[id]!!.lowercase().replace(' ', '-')}","displayName":"${fleetNames[id]}","hostname":"host-${id.takeLast(1)}",
        "version":"0.1.200","online":true,"status":"ONLINE","lastHeartbeatAt":"$now","maxConcurrent":2,"activeSessions":0,"runsAsRoot":false,
        "minFreeDiskMb":null,"engines":[],"enrolledAt":"2026-09-01T00:00:00Z"}"""
    }
    private fun at(seconds: Long) = now.plusSeconds(seconds).toString()
    private fun buckets(vararg left: Double) = listOf("gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h").zip(left.toList()).joinToString(",", "[", "]") { (id, rest) ->
        """{"id":"$id","window":"${if (id.endsWith("5h")) "5h" else "weekly"}","remainingFraction":$rest,"resetTime":"${at(if (id.endsWith("5h")) 3 * 3600 else 4 * 86400)}"}"""
    }
    /** The remote in the A13c pass: Claude Code with three accounts (a login about to lapse, one paused, one signed out),
     * Codex signed out, and Antigravity signed in to two Google accounts, each with its own buckets. */
    private fun accountsRunner() = """{"id":"$runnerId","name":"controlled-remote","displayName":"Controlled remote","hostname":"ci-runner-01","version":"0.1.199",
        "online":true,"status":"ONLINE","lastHeartbeatAt":"${heartbeat()}","maxConcurrent":4,"activeSessions":1,"runsAsRoot":false,"selfUpdate":null,
        "minFreeDiskMb":null,"reposRoot":"/home/ci/orbit-repos","enrolledAt":"2026-09-01T10:00:00Z",
        "capabilities":["claude-account-remove/v1","antigravity-google-login/v1","antigravity-account-login/v1","antigravity-account-remove/v1","os:linux"],
        "antigravity":{"supported":true,"installed":true,"version":"1.3.0","envKeyAvailable":true,"authSource":"google","googleLogin":"available"},
        "engines":[{"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes",
            "accounts":[{"id":"default","home":"/home/ci/.claude","auth":"yes","loginExpiresAt":"${at(if (claudeRenewed) 30 * 86400 else 47 * 3600)}"},
              {"id":"1fda3f43","name":"Work","home":"/home/ci/.orbit/claude-accounts/1fda3f43","auth":"yes","pausedUntil":"${at(2 * 3600)}"},
              {"id":"7d3e0c11","name":"Old","home":"/home/ci/.orbit/claude-accounts/7d3e0c11","auth":"no"}]},
          {"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"no"},{"engine":"kimi","installed":false},
          {"engine":"antigravity","installed":true,"version":"1.3.0","auth":"yes","authSource":"google",
            "accounts":[{"id":"default","home":"/home/ci/.orbit/antigravity/google","auth":"yes"},
              {"id":"5c2e91a0","name":"Work","home":"/home/ci/.orbit/antigravity-accounts/5c2e91a0","auth":"yes"}],
            "planUsage":{"provider":"antigravity","buckets":${buckets(1.0, 1.0, 0.98, 1.0)},
              "accounts":{"5c2e91a0":{"provider":"antigravity","buckets":${buckets(0.61, 0.04, 1.0, 1.0)}}}}}],
        "planUsage":{"claude":{"fiveHour":{"utilization":42,"resetsAt":"${at(7200)}"},"sevenDay":{"utilization":61,"resetsAt":"${at(3 * 86400)}"},
          "accounts":{"1fda3f43":{"fiveHour":{"utilization":12,"resetsAt":"${at(3600)}"},"sevenDay":{"utilization":30,"resetsAt":"${at(5 * 86400)}"}}}}},"install":null}"""
    /** Kimi Code's three windows and the coding share of its month, which no page draws. */
    private fun kimiWindows(five: Int, week: Int, month: Int, fiveIn: Long, weekIn: Long, monthIn: Long) =
        """"provider":"kimi","fiveHour":{"utilization":$five,"resetsAt":"${at(fiveIn)}"},"sevenDay":{"utilization":$week,"resetsAt":"${at(weekIn)}"},""" +
            """"month":{"utilization":$month,"resetsAt":"${at(monthIn)}"},"monthCode":{"utilization":${month / 2},"resetsAt":"${at(monthIn)}"}"""
    /** The remote in the Kimi pass, as the board draws HPC: Default on kimi.ai, and once added Work on kimi.com, its five hours
     * 91% used. Claude Code, Codex and Antigravity keep two accounts each, so every engine page has one marked NEXT. A runner
     * too old for Kimi's accounts reads no Kimi quota either. */
    private fun kimiRunner(): String {
        val kimi = if (kimiOld) """{"engine":"kimi","installed":true,"version":"2.1.1","auth":"no","kimiRegion":"mainland-cn"}"""
            else """{"engine":"kimi","installed":true,"version":"2.1.1","auth":"yes","kimiRegion":"global",
              "accounts":[{"id":"default","home":"/home/ci/.kimi-code","auth":"yes","kimiRegion":"global"}${if (!kimiTwo) "" else """,
                {"id":"5c2e91a0","name":"Work","home":"/home/ci/.orbit/kimi-accounts/5c2e91a0","auth":"yes","kimiRegion":"mainland-cn"}"""}]}"""
        val kimiCapabilities = if (kimiOld) "" else """"kimi-account-login/v1","kimi-account-remove/v1","kimi-account-move/v1","kimi-login-region/v1","""
        return """{"id":"$runnerId","name":"controlled-remote","displayName":"Controlled remote","hostname":"ci-runner-01","version":"0.1.200",
        "online":true,"status":"ONLINE","lastHeartbeatAt":"${heartbeat()}","maxConcurrent":4,"activeSessions":1,"runsAsRoot":false,"selfUpdate":null,
        "minFreeDiskMb":null,"reposRoot":"/home/ci/orbit-repos","enrolledAt":"2026-09-01T10:00:00Z",
        "capabilities":[$kimiCapabilities"claude-account-remove/v1","antigravity-google-login/v1","antigravity-account-login/v1","antigravity-account-remove/v1","os:linux"],
        "antigravity":{"supported":true,"installed":true,"version":"1.3.0","envKeyAvailable":true,"authSource":"google","googleLogin":"available"},
        "engines":[{"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes",
            "accounts":[{"id":"default","home":"/home/ci/.claude","auth":"yes"},{"id":"1fda3f43","name":"Work","home":"/home/ci/.orbit/claude-accounts/1fda3f43","auth":"yes"}]},
          {"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes",
            "accounts":[{"id":"default","home":"/home/ci/.codex","auth":"yes"},{"id":"1a2b3c4d","name":"Second","home":"/home/ci/.orbit/codex-accounts/1a2b3c4d","auth":"yes"}]},
          $kimi,
          {"engine":"antigravity","installed":true,"version":"1.3.0","auth":"yes","authSource":"google",
            "accounts":[{"id":"default","home":"/home/ci/.orbit/antigravity/google","auth":"yes"},
              {"id":"5c2e91a0","name":"Work","home":"/home/ci/.orbit/antigravity-accounts/5c2e91a0","auth":"yes"}],
            "planUsage":{"provider":"antigravity","buckets":${buckets(1.0, 1.0, 0.98, 1.0)},
              "accounts":{"5c2e91a0":{"provider":"antigravity","buckets":${buckets(0.61, 0.04, 1.0, 1.0)}}}}}],
        "planUsage":{"claude":{"fiveHour":{"utilization":42,"resetsAt":"${at(7200)}"},"sevenDay":{"utilization":61,"resetsAt":"${at(5 * 86400)}"},
            "accounts":{"1fda3f43":{"fiveHour":{"utilization":12,"resetsAt":"${at(3600)}"},"sevenDay":{"utilization":30,"resetsAt":"${at(3 * 86400)}"}}}},
          "codex":{"provider":"codex","primary":{"utilization":85,"windowDurationMins":300,"resetsAt":"${at(5400)}"},
            "secondary":{"utilization":40,"windowDurationMins":10080,"resetsAt":"${at(4 * 86400)}"},
            "accounts":{"1a2b3c4d":{"provider":"codex","primary":{"utilization":30,"windowDurationMins":300,"resetsAt":"${at(9000)}"},
              "secondary":{"utilization":20,"windowDurationMins":10080,"resetsAt":"${at(6 * 86400)}"}}}},
          "kimi":${if (kimiOld) "null" else """{${kimiWindows(12, 34, 8, 2 * 3600, 4 * 86400, 23 * 86400)},
            "accounts":{"5c2e91a0":{${kimiWindows(91, 61, 22, 3600, 86400, 20 * 86400)}}}}"""}},"install":null}"""
    }
    /** The remote in the Infrastructure pass: Claude Code signed in, Codex signed out, Kimi Code and OpenCode not installed. */
    private fun infraRunner() = """{"id":"$runnerId","name":"controlled-remote","displayName":"Controlled remote","hostname":"ci-runner-01","version":"0.1.200",
        "online":true,"status":"ONLINE","lastHeartbeatAt":"$now","maxConcurrent":4,"activeSessions":1,"runsAsRoot":false,"selfUpdate":null,
        "minFreeDiskMb":null,"reposRoot":"/home/ci/orbit-repos","enrolledAt":"2026-09-01T10:00:00Z","capabilities":["claude-account-remove/v1","os:linux"],
        "engines":[{"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes"},
          {"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"no"},{"engine":"kimi","installed":false},
          {"engine":"opencode","installed":false,"auth":"unknown"}],"install":$installRelay}"""
    /** A machine gone since yesterday. */
    private fun thinkPad() = """{"id":"$thinkPadId","name":"thinkpad","displayName":"ThinkPad","hostname":"thinkpad-01","version":"0.1.200",
        "online":false,"status":"OFFLINE","lastHeartbeatAt":"${now.minusSeconds(86_400)}","maxConcurrent":4,"activeSessions":0,"runsAsRoot":false,
        "selfUpdate":null,"minFreeDiskMb":null,"enrolledAt":"2026-09-01T10:00:00Z",
        "engines":[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"no"}],"install":null}"""
    private fun runner() = if (kimiPass) kimiRunner() else if (accountsPass) accountsRunner() else """{"id":"$runnerId","name":"controlled-remote","displayName":"Controlled remote","hostname":"ci-runner-01","version":"0.1.199",
        "online":$runnerOnline,"status":"${if (runnerOnline) "ONLINE" else "OFFLINE"}","lastHeartbeatAt":"${heartbeat()}","maxConcurrent":4,"activeSessions":1,
        "runsAsRoot":false,"selfUpdate":${runnerSelfUpdate ?: "null"},"minFreeDiskMb":null,"reposRoot":"/home/ci/orbit-repos","enrolledAt":"2026-09-01T10:00:00Z","capabilities":["claude-account-remove/v1"],
        "engines":[{"engine":"claude","installed":true,"version":"2.1.284 (Claude Code)","auth":"yes","update":{"status":"checked","at":"${now.minusSeconds(360)}","okAt":"${now.minusSeconds(360)}","latest":"2.1.284"},
          "accounts":[{"id":"default","home":"/home/ci/.claude","auth":"yes"},{"id":"1fda3f43","home":"/home/ci/.orbit/claude-accounts/1fda3f43","auth":"no","name":"Work"}]},
          {"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"yes"},{"engine":"kimi","installed":false}],
        "planUsage":{"claude":{"fiveHour":{"utilization":42,"resetsAt":"${now.plusSeconds(7200)}"},"sevenDay":{"utilization":91,"resetsAt":"${now.plusSeconds(3 * 86400)}"}}},"install":null}"""
    private fun workspace() = """{"id":"$workspaceId","name":"$workspaceName","runnerId":"$runnerId","enabled":true,"workDir":"/home/ci/fixture","lastProvider":"claude",
        "effort":"","modelRouting":false,"env":{"NODE_ENV":"test"},"workDirFreeBytes":"5368709120","workDirTotalBytes":"107374182400",
        "repoHealth":{"root":"/home/ci/fixture","state":"rebase","branch":"feature/x"},"position":0,"createdAt":"2026-09-01T10:00:00Z"}"""
    private fun session() = """{"id":"$sessionId","title":"Fixture session","status":"SUCCEEDED","lifecycleState":"OPEN","workspaceId":"$workspaceId","agentId":"$workspaceId",
        "createdAt":"${now.minusSeconds(600)}","lastTurnAt":"${now.minusSeconds(300)}","pendingApprovals":0}"""
    private fun shareLink(id: String, title: String, kind: String = "SESSION") = """{"id":"$id","token":"fixture-public-token","kind":"$kind","state":"${if (sharingActive) "ACTIVE" else "ENDED"}",
        "stateReason":${if (sharingActive) "null" else "\"TURNED_OFF\""},"revokedAt":${if (sharingActive) "null" else "\"$now\""},
        "root":{"id":"$sessionId","title":"$title","lifecycleState":"OPEN"},"include":{"toolOutput":$shareTools},"viewCount":3,"lastViewedAt":"${now.minusSeconds(4000)}"}"""
    private fun login() = """{"state":"ACTIVE","email":"me@example.test","plan":"plus","fingerprint":"…AB12","userId":"fixture-user","next":true,
        "usage":{"provider":"codex","primary":{"utilization":36,"windowDurationMins":300,"resetsAt":"${now.plusSeconds(5000)}"},"secondary":{"utilization":58,"windowDurationMins":10080,"resetsAt":"${now.plusSeconds(400000)}"}}}"""
    private fun access() = """{"id":"P1","slug":"team-codex","label":"Team Codex","engine":"codex","shared":false,"logins":[${login()}],"membersCanAdd":false,
        "membersCanAddAccounts":false,"ownKeyFirst":false,"viewerRole":"ADMIN","window":{"start":"2026-10-01T00:00:00Z","end":"2026-11-01T00:00:00Z"},
        "people":[{"userId":"fixture-user","name":"$name","role":"ADMIN","creator":true,"you":true,"keys":1,"sessions":3,"usage":{"inputTokens":0,"outputTokens":0,"costUsd":4.2}},
          {"userId":"u2","name":"Second user","role":"MEMBER","creator":false,"you":false,"keys":0,"sessions":1,"usage":{"inputTokens":0,"outputTokens":0,"costUsd":1.1}}],
        "keys":[{"id":"K1","label":"Team key","fingerprint":"sk-…9XYZ","state":"ACTIVE","enabled":true,"shareCap":50,"contributor":{"userId":"fixture-user","name":"$name","you":true},
          "usage":{"inputTokens":0,"outputTokens":0,"costUsd":4.2,"othersCostUsd":1.1},"running":false,"next":false}]}"""
    private fun pools() = """[{"id":"P1","slug":"team-codex","label":"Team Codex","engine":"codex","logins":[${login()}]},
        {"id":"P2","slug":"claude-pool","label":"Claude pool","engine":"claude","members":[{"id":"m1","slug":"anthropic-a","label":"Anthropic A","state":"AVAILABLE","next":true,"enabled":true,
          "planUsage":{"fiveHour":{"utilization":20}}},{"id":"m2","slug":"anthropic-b","label":"Anthropic B","state":"SPENT","next":false,"enabled":true,"resetsAt":"${now.plusSeconds(3600)}"}]}${if (!infraPass) "" else """,
        {"id":"P3","slug":"old-keys","label":"Old keys","engine":"claude","unavailable":"No account can run",
          "members":[{"id":"m3","slug":"anthropic-c","label":"Anthropic C","state":"REFUSED","next":false,"enabled":true}]}"""}]"""
    private fun admins() = """[{"id":"fixture-user","email":"a13@example.test","name":"$name","role":"$role","createdAt":"2026-09-01T00:00:00Z"},
        {"id":"u2","email":"second@example.test","name":"Second user","role":"$secondRole","createdAt":"2026-09-02T00:00:00Z"}]"""

    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} $path"
            if (path == "/api/session-folders") snapshots += SystemClock.elapsedRealtime()
            if (path == "/dl/version.json") {
                bearerOnPublicManifest = request.getHeader("Authorization")
                return MockResponse().setHeader("Content-Type", "application/json").setBody("""{"version":"0.1.200"}""")
            }
            // The login page asks the typed instance what it offers, signed out; this one predates Google sign-in.
            if (path == "/api/auth/methods") return MockResponse().setResponseCode(404)
            if (path !in listOf("/api/auth/login", "/api/auth/logout")) assertEquals("Bearer fixture-access", request.getHeader("Authorization"))
            if (path == "/api/users/me" && forbidden) return MockResponse().setResponseCode(403).setBody("{}")
            fun bodyOf() = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
            fleet?.let { ids ->
                fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                val one = path.removePrefix("/api/runners/")
                when {
                    path == "/api/runners" -> return json(fleetList(ids))
                    path == "/api/runners/reorder" -> { fleet = bodyOf()["ids"]!!.jsonArray.map { it.jsonPrimitive.content }; return json(fleetList(fleet!!)) }
                    request.method == "DELETE" && one in ids -> { fleet = ids - one; return json("{}") }
                    else -> Unit
                }
            }
            val body = when (path) {
                "/api/auth/login" -> """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":${user()}}"""
                "/api/auth/logout" -> "{}"
                "/api/users/me" -> { if (request.method == "PATCH") name = bodyOf()["name"]!!.jsonPrimitive.content; user() }
                "/api/users/me/preferences" -> {
                    val patch = bodyOf()
                    patch["theme"]?.let { theme = it.jsonPrimitive.content }
                    patch["defaultPermissionMode"]?.let { permission = it.jsonPrimitive.content }
                    patch["modelRouting"]?.let { modelRouting = it.jsonPrimitive.boolean }
                    user()
                }
                "/api/admin/users" -> if (role == "ADMIN") admins() else return MockResponse().setResponseCode(403).setBody("""{"message":"Admin role required"}""")
                "/api/admin/users/u2/role" -> { secondRole = bodyOf()["role"]!!.jsonPrimitive.content; admins() }
                "/api/share-links" -> """{"links":[${shareLink("share-link", "Fixture shared session")}]}"""
                "/api/share-links/turn-off" -> { sharingActive = false; """{"count":1}""" }
                "/api/sessions/$sessionId/share" -> {
                    if (request.method == "PUT") bodyOf()["include"]?.jsonObject?.get("toolOutput")?.let { shareTools = it.jsonPrimitive.boolean; sharingActive = true }
                    if (request.method == "DELETE") sharingActive = false
                    if (request.method == "PUT") shareLink("session-link", "Fixture session")
                    else """{"link":${if (sharingActive) shareLink("session-link", "Fixture session") else "null"},"counts":{"messages":12,"toolCalls":5}}"""
                }
                "/api/workspaces" -> "[${workspace()}]"
                "/api/workspaces/$workspaceId" -> { if (request.method == "PATCH") workspaceName = bodyOf()["name"]!!.jsonPrimitive.content; workspace() }
                "/api/runners" -> { runnerReads += SystemClock.elapsedRealtime(); if (infraPass) "[${infraRunner()},${thinkPad()}]" else "[${runner()}]" }
                "/api/runners/$runnerId/install" -> {
                    val engine = bodyOf()["engine"]!!.jsonPrimitive.content
                    installs += engine
                    installRelay = """{"status":"installing","engine":"$engine","mode":"install","message":"Installing $engine on this machine…"}"""
                    installRelay
                }
                "/api/runners/$runnerId/login" -> when (request.method) {
                    "POST" -> {
                        val start = bodyOf()
                        val region = start["region"]?.jsonPrimitive?.content
                        val account = start["account"]?.jsonPrimitive?.content?.let { "\"$it\"" } ?: "null"
                        when {
                            // An older runner's next check-in refuses a site it can't be told (RunnerApiController).
                            start["engine"]?.jsonPrimitive?.content == "kimi" && kimiOld && region != null -> {
                                loginRelay = """{"status":"failed","engine":"kimi","userCode":null,"url":null,"message":"This runner is too old to choose a Kimi site — update it, then try again.","account":null}"""
                                """{"status":"pending","engine":"kimi","userCode":null,"url":null,"message":null,"account":null}"""
                            }
                            start["engine"]?.jsonPrimitive?.content == "kimi" -> {
                                val (site, code) = if (region == "global") "kimi.ai" to "Q2PF-8XWA" else "kimi.com" to "7K06-QP86"
                                loginRelay = """{"status":"awaiting_approval","engine":"kimi","userCode":"$code","url":"https://www.$site/code/authorize_device?user_code=$code","message":null,"account":$account}"""
                                loginRelay
                            }
                            else -> {
                                loginRelay = if (start["engine"]?.jsonPrimitive?.content == "codex")
                                    """{"status":"awaiting_approval","engine":"codex","userCode":"WXYZ-1234","url":"https://auth.openai.com/codex/device","message":null,"account":null}"""
                                else """{"status":"awaiting_code","engine":"claude","userCode":null,"url":"https://claude.ai/oauth/authorize?code=true","message":null,"account":"default"}"""
                                loginRelay
                            }
                        }
                    }
                    "DELETE" -> { loginRelay = """{"status":"cancelled","engine":null,"userCode":null,"url":null,"message":null,"account":null}"""; loginRelay }
                    else -> loginRelay
                }
                "/api/runners/$runnerId/login/code" -> {
                    claudeRenewed = true
                    loginRelay = """{"status":"done","engine":"claude","userCode":null,"url":null,"message":null,"account":"default"}"""
                    loginRelay
                }
                "/api/sessions" -> if (request.requestUrl!!.queryParameter("view") == "open") "[${session()}]" else "[]"
                "/api/sessions/counts" -> """[{"workspaceId":"$workspaceId","active":1,"running":1,"jobs":0,"needsYou":0}]"""
                "/api/providers" -> """[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","defaultModel":"deepseek-chat"},{"slug":"dsh","label":"DeepSeek Harness","runtime":"dsh"},
                    {"slug":"openai-work","label":"OpenAI (work)","defaultModel":"gpt-5"}]"""
                "/api/providers/mine" -> mine()
                "/api/access-tokens" -> tokens()
                "/api/providers/pools" -> pools()
                "/api/providers/shared-pools" -> "[]"
                "/api/providers/shared-pools/P1" -> access()
                // The rejected key's balance answers a second after the other's. Under the test rule a page's effects resume on the
                // threads that answer them: two balances answered at once were written side by side and one was lost, its row never
                // getting a value (A15 F-50); in the app both are written on the main thread, one after the other.
                "/api/providers/mine/K2/balance" -> return MockResponse().setHeader("Content-Type", "application/json")
                    .setBody(balance("K2")).setHeadersDelay(1, TimeUnit.SECONDS)
                "/api/events" -> return MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody(": connected\n\n".repeat(120), 13).throttleBody(13, 1, TimeUnit.SECONDS)
                else -> when {
                    path.startsWith("/api/access-tokens/") && request.method == "DELETE" -> {
                        val id = path.removePrefix("/api/access-tokens/")
                        revoked = revoked + id
                        """{"id":"$id","revokedAt":"$now","revokedReason":"USER"}"""
                    }
                    path.startsWith("/api/providers/mine/") && path.endsWith("/balance") -> balance(path.removePrefix("/api/providers/mine/").removeSuffix("/balance"))
                    request.method == "GET" -> "[]"
                    else -> "{}"
                }
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }
}
