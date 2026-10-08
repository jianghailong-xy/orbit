package io.orbitd.android.management

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.SystemClock
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
    /** Runners served instead of the one controlled remote, for the Edit case; DELETE and reorder change it. */
    @Volatile private var fleet: List<String>? = null
    /** The remote reports Antigravity's Google accounts and more accounts of Claude Code (A13c). */
    @Volatile private var accountsPass = false
    /** Default's Claude login lapses in two days until it is signed in again, then in a month. */
    @Volatile private var claudeRenewed = false
    /** The sign-in relay as GET runners/:id/login reads it; POST login and POST login/code move it on. */
    @Volatile private var loginRelay = """{"status":null,"engine":null,"userCode":null,"url":null,"message":null,"account":null}"""
    @Volatile private var workspaceName = "Fixture workspace"
    @Volatile private var sharingActive = true
    @Volatile private var shareTools = false
    @Volatile private var bearerOnPublicManifest: String? = "unread"
    private val workspaceId = "34Tcl0kralZrY8opuLJU4"
    private val runnerId = "34TcwNgAIo6tGUiIKjqnQ"
    private val sessionId = "34TcwNgAIo6tGUiIKjqnS"
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
                await("0 of 1 online"); await("1 active")
                capture("settings-home")
                // Default permission and Appearance are menus on their rows; each write is one preference key.
                click(hasText("Default permission") and hasClickAction()); click(hasText("Plan") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { permission == "plan" }
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
                await("Default permission")
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
                await("Sign out of ${server.url("/").host}:${server.port}?")
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
                await("Default permission")
                shell("settings put system font_scale 2.0")
                compose.activityRule.scenario.recreate()
                await("Updated fixture")
                // The page reads the account again after the recreate; capture it settled, from the top.
                compose.waitUntil(15_000) { compose.onAllNodes(hasText("Session orchestration") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
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
                await("Smart model selection for tasks")
                compose.onNode(hasSetTextAction() and hasText("Name")).performTextReplacement("Configured workspace")
                capture("workspace-settings")
                click(hasText("Done") and hasClickAction(), scroll = false)
                compose.waitUntil(10_000) { workspaceName == "Configured workspace" }
                settings()
                click(hasText("Runners") and hasClickAction())
                await("Controlled remote")
                capture("runners-list")
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
                await("Providers")
                click(hasText("Providers") and hasClickAction())
                await("Team Codex")
                capture("providers")
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
                click(hasText("Runners") and hasClickAction()); await("Controlled remote")
                click(hasText("Controlled remote") and hasClickAction()); await("Max Concurrent")
                // One window per Engines row; Antigravity's names the account a new session starts on above its own.
                await("Next: Default")
                compose.onAllNodesWithText("Next: Default", substring = true).onFirst().performScrollTo()
                await("2 accounts signed in"); await("98% remaining")
                capture("agy-runner-engines")
                click(hasText("Antigravity") and hasClickAction()); await("Accounts"); await("4% remaining")
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
                click(hasText("Paste") and hasClickAction())
                compose.waitUntil(10_000) { calls.contains("POST /api/runners/$runnerId/login/code") }
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
        await("Smart model selection for tasks"); capture("$pass-workspace-settings")
        click(hasText("Cancel") and hasClickAction(), scroll = false)
        settings(); capture("$pass-settings-home")
        compose.onNodeWithContentDescription("Edit profile").performScrollTo().performClick(); await("Save profile"); capture("$pass-edit-profile"); back()
        click(hasText("Notifications") and hasClickAction()); await("When a session finishes"); capture("$pass-notifications"); back()
        click(hasText("Shared links") and hasClickAction()); await("Fixture shared session"); capture("$pass-shared-links"); back()
        click(hasText("Admin") and hasClickAction()); await("Second user"); capture("$pass-admin-users"); back()
        click(hasText("Runners") and hasClickAction()); await("Controlled remote"); capture("$pass-runners-list")
        click(hasText("Controlled remote") and hasClickAction()); await("Max Concurrent"); capture("$pass-runner")
        click(hasText("Claude Code") and hasClickAction()); await("Add Account"); capture("$pass-runner-engine")
        back(); back(); back()
        click(hasText("Providers") and hasClickAction()); await("Team Codex"); capture("$pass-providers")
        click(hasText("Team Codex") and hasClickAction()); await("Who can use it"); capture("$pass-codex-pool")
        back(); back()
    }

    /**
     * Edit on the runners list with three runners: the first row (not the last) is removed and Edit stays on; the row
     * that moved into its place is dragged by its handle below the next one. One order goes out and the rows stand in
     * it. Before the handles were dropped with their rows, the removed row's handle lay over this one and the drag
     * could start on the removed id and crash.
     */
    @Test fun runnersListRemovesARowThenReordersTheNextByDragging() {
        start()
        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            val (alpha, bravo, charlie) = fleetNames.keys.toList()
            try {
                role = "ADMIN"; runnerOnline = true; fleet = listOf(alpha, bravo, charlie)
                signIn(server); settings()
                click(hasText("Runners") and hasClickAction()); await("Charlie box")
                click(hasText("Edit") and hasClickAction())
                capture("runners-edit")
                compose.onAllNodes(hasText("Remove") and hasClickAction()).onFirst().performClick()
                click(hasText("Remove Runner") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
                compose.waitUntil(10_000) { calls.contains("DELETE /api/runners/$alpha") && compose.onAllNodesWithText("Alpha box", substring = true).fetchSemanticsNodes().isEmpty() }
                compose.waitForIdle()
                capture("runners-edit-removed")
                compose.onNodeWithContentDescription("Reorder Bravo box").performTouchInput {
                    down(centerRight - androidx.compose.ui.geometry.Offset(8f, 0f))
                    repeat(30) { moveBy(androidx.compose.ui.geometry.Offset(0f, height / 10f)) }
                    up()
                }
                compose.waitUntil(10_000) { calls.contains("POST /api/runners/reorder") }
                compose.waitForIdle()
                capture("runners-edit-dragged")
                assertEquals(listOf(charlie, bravo), fleet)
                assertEquals("One order per drag", 1, calls.count { it == "POST /api/runners/reorder" })
                fun top(name: String) = compose.onAllNodesWithText(name, substring = true).onFirst().fetchSemanticsNode().boundsInRoot.top
                assertTrue("The rows stand in the new order", top("Charlie box") < top("Bravo box"))
            } finally {
                fleet = null
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
                await("Default permission")
                page("settings-home", report, problems)
                activate("Runners", "talkback-settings-runners", report, problems); await("Controlled remote")
                report.appendLine("double tap Runners -> the runners list opened")
                page("runners-list", report, problems)
                activate("Controlled remote", "talkback-runners-row", report, problems); await("Max Concurrent")
                report.appendLine("double tap Controlled remote -> the runner page opened")
                page("runner", report, problems)
                activate("Increase Max Concurrent", "talkback-runner-capacity", report, problems)
                compose.waitUntil(10_000) { calls.any { it == "PATCH /api/runners/$runnerId" } }
                report.appendLine("double tap Increase Max Concurrent -> PATCH /api/runners/$runnerId sent")
                back(); back(); await("Default permission")
                activate("Providers", "talkback-settings-providers", report, problems); await("Team Codex")
                report.appendLine("double tap Providers -> the providers page opened")
                page("providers", report, problems)
                activate("Team Codex", "talkback-providers-pool", report, problems); await("Who can use it")
                report.appendLine("double tap Team Codex -> the pool page opened")
                page("codex-pool", report, problems)
                back(); back(); await("Default permission")
                activate("Shared links", "talkback-settings-shared-links", report, problems); await("Fixture shared session")
                report.appendLine("double tap Shared links -> the shared links page opened")
                page("shared-links", report, problems)
                activate("Turn off", "talkback-shared-links-turn-off", report, problems); await("Turn off this link")
                report.appendLine("double tap Turn off -> the confirmation opened")
                compose.onNode(hasText("Cancel") and hasClickAction() and hasAnyAncestor(isDialog())).performSemanticsAction(SemanticsActions.OnClick)
                // The key goes to the window in front: let the dialog go first.
                compose.waitUntil(5_000) { compose.onAllNodes(isDialog()).fetchSemanticsNodes().isEmpty() }
                back(); await("Default permission")
                activate("Edit profile", "talkback-settings-profile", report, problems); await("Save profile")
                report.appendLine("double tap Edit profile -> the profile card opened")
                page("edit-profile", report, problems)
                activate("Choose photo", "talkback-profile-photo", report, problems); await("Photo library")
                report.appendLine("double tap Choose photo -> the photo menu opened")
                back(); back(); await("Default permission")
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
     * window, and a page that changed under a cached tree would be read as it was.
     */
    private fun appRoot(): AccessibilityNodeInfo? {
        automation.clearCache()
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
            // A row the window's edge cuts has its words below the edge, out of the tree until TalkBack scrolls to it.
            val cut = Rect().also(node::getBoundsInScreen).let { it.bottom >= window.bottom || it.top <= window.top }
            val said = if (node.isClickable || node.isCheckable) spoken(node) else words(node).joinToString(" | ")
            if (reachable || said.isNotEmpty()) {
                val actions = node.actionList.mapNotNull { it.label?.toString() }.joinToString(",")
                report.appendLine("${"  ".repeat(depth)}${node.className?.toString()?.substringAfterLast('.')} clickable=${node.isClickable} " +
                    "enabled=${node.isEnabled} says=\"$said\"" + (if (node.isClickable) " (description=\"${node.contentDescription}\" text=\"${node.text}\")" else "") +
                    if (actions.isNotEmpty()) " actions=[$actions]" else "")
                if (reachable && node.isClickable && said.isEmpty() && !cut)
                    problem(report, problems, "$page: a press without words (${node.className}) at ${Rect().also(node::getBoundsInScreen)}")
                if (reachable && (node.isClickable || node.isCheckable)) symbols(node).forEach { problem(report, problems, "$page: TalkBack reads the bare symbol \"$it\" in \"$said\"") }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
    }

    /**
     * TalkBack's own order: a finger on the page's first item (below the top bar, which TalkBack reaches after the
     * page), then swipe right after swipe right, with what it reads at each stop.
     */
    private fun traverse(page: String, report: StringBuilder, problems: MutableList<String>) {
        val root = appRoot() ?: return
        val screen = Rect().also(root::getBoundsInScreen)
        val first = nodes(root).firstOrNull {
            it.isVisibleToUser && (it.isClickable || words(it).isNotEmpty()) && Rect().also(it::getBoundsInScreen).top > screen.height() / 10
        }
        report.appendLine("## $page — TalkBack, swipe right from \"${first?.let(::spoken)}\"")
        first?.let { val at = Rect().also(it::getBoundsInScreen); tap(at.exactCenterX(), at.exactCenterY()); SystemClock.sleep(1_000) }
        focused()?.let { report.appendLine("  ${it.className?.toString()?.substringAfterLast('.')} \"${spoken(it)}\" (touched)") }
        val photograph = page == "settings-home"
        if (photograph) capture("talkback-walk-$page-0")
        val stops = mutableListOf<String>()
        var unmoved = 0
        for (step in 1..20) {
            swipeRight(screen); SystemClock.sleep(1_000)
            if (photograph && step <= 8) capture("talkback-walk-$page-$step")
            val node = focused()?.takeIf { it.packageName?.toString() == app.packageName } ?: run { report.appendLine("  (TalkBack's focus left the app)"); null } ?: break
            val said = spoken(node)
            val stop = "${Rect().also(node::getBoundsInScreen)} $said"
            if (stop == stops.lastOrNull()) { if (++unmoved >= 2) { report.appendLine("  (the last item)"); break } else continue }
            if (stop in stops) { report.appendLine("  (back to an earlier item)"); break }
            stops += stop; unmoved = 0
            report.appendLine("  ${node.className?.toString()?.substringAfterLast('.')} \"$said\"" + if (node.isClickable) " — double tap to activate" else "")
            if (node.isClickable && said.isEmpty()) problem(report, problems, "$page: TalkBack stops on a press it has no words for")
            if (!node.isClickable && !node.isCheckable) symbols(node).forEach { problem(report, problems, "$page: TalkBack stops on the bare symbol \"$it\"") }
        }
        if (stops.size < 3) problem(report, problems, "$page: TalkBack's swipes reached ${stops.size} item(s)")
    }

    /**
     * The control named [words]: on screen (scrolled to by its semantics, as a finger would scroll), TalkBack's focus put
     * on it by a touch and photographed, then TalkBack's double tap. The caller checks what the press did.
     */
    private fun activate(words: String, shot: String, report: StringBuilder, problems: MutableList<String>) {
        val named = hasText(words, substring = true) or hasContentDescription(words, substring = true)
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
        var target = label
        while (target != null && !target.isClickable) target = target.parent
        target = target ?: label
        if (target == null) { capture("$shot-missing"); problem(report, problems, "$shot: nothing on screen is named \"$words\""); return }
        val at = Rect().also(target::getBoundsInScreen)
        report.appendLine("touch \"$words\" at $at")
        tap(at.exactCenterX(), at.exactCenterY())
        // TalkBack moves its focus a moment after the touch ends (it first waits to see whether a second tap follows).
        val until = SystemClock.uptimeMillis() + 3_000
        var focus = focused()
        while (focus?.let(::spoken)?.contains(words, ignoreCase = true) != true && SystemClock.uptimeMillis() < until) { SystemClock.sleep(200); focus = focused() }
        val said = focus?.let(::spoken).orEmpty()
        report.appendLine("touch \"$words\" -> TalkBack's focus on ${focus?.className?.toString()?.substringAfterLast('.')} \"$said\"")
        if (focus == null || !said.contains(words, ignoreCase = true)) problem(report, problems, "$shot: TalkBack's focus is on \"$said\", not \"$words\"")
        capture(shot)
        val on = Rect().also { (focus ?: target).getBoundsInScreen(it) }
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
    private fun finger(x: Int, y: Int, down: Boolean) {
        val open = console ?: InstrumentationRegistry.getArguments().let { args ->
            Console(args.getString("a13ConsolePort")?.toIntOrNull() ?: error("TalkBack takes touches from the screen only: needs a13ConsolePort"),
                args.getString("a13ConsoleToken") ?: error("needs a13ConsoleToken"))
        }.also { console = it }
        open.send("event mouse $x $y 0 ${if (down) 1 else 0}")
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
        await("Default permission")
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

    private fun user() = """{"id":"fixture-user","name":"$name","email":"a13@example.test","role":"$role","avatarUpdatedAt":null,"preferences":{"theme":"$theme","defaultPermissionMode":"$permission","notifySessionFinished":false,"notifyAgentMessage":true}}"""
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
    private fun runner() = if (accountsPass) accountsRunner() else """{"id":"$runnerId","name":"controlled-remote","displayName":"Controlled remote","hostname":"ci-runner-01","version":"0.1.199",
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
          "planUsage":{"fiveHour":{"utilization":20}}},{"id":"m2","slug":"anthropic-b","label":"Anthropic B","state":"SPENT","next":false,"enabled":true,"resetsAt":"${now.plusSeconds(3600)}"}]}]"""
    private fun admins() = """[{"id":"fixture-user","email":"a13@example.test","name":"$name","role":"$role","createdAt":"2026-09-01T00:00:00Z"},
        {"id":"u2","email":"second@example.test","name":"Second user","role":"$secondRole","createdAt":"2026-09-02T00:00:00Z"}]"""

    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath
            calls += "${request.method} $path"
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
                "/api/runners" -> "[${runner()}]"
                "/api/runners/$runnerId/login" -> when (request.method) {
                    "POST" -> {
                        val start = bodyOf()
                        loginRelay = if (start["engine"]?.jsonPrimitive?.content == "codex")
                            """{"status":"awaiting_approval","engine":"codex","userCode":"WXYZ-1234","url":"https://auth.openai.com/codex/device","message":null,"account":null}"""
                        else """{"status":"awaiting_code","engine":"claude","userCode":null,"url":"https://claude.ai/oauth/authorize?code=true","message":null,"account":"default"}"""
                        loginRelay
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
                "/api/providers" -> """[{"slug":"openai-work","label":"OpenAI (work)","defaultModel":"gpt-5"}]"""
                "/api/providers/pools" -> pools()
                "/api/providers/shared-pools" -> "[]"
                "/api/providers/shared-pools/P1" -> access()
                "/api/events" -> return MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody(": connected\n\n".repeat(120), 13).throttleBody(13, 1, TimeUnit.SECONDS)
                else -> if (request.method == "GET") "[]" else "{}"
            }
            return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
        }
    }
}
