package io.orbitd.android.increments

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The session page's Settings on a phone (docs/mocks/session-settings, Android ⑤-⑦), over the test's own fixture with the board's
 * data: the ⋮ menu's Settings (no Session details), the whole page's four groups, Variables, and Info's Worktree and background jobs —
 * what Session details showed. Writes go as they are made: the Mute switch is a PATCH, Restart after this turn a POST.
 */
@RunWith(AndroidJUnit4::class)
class SessionSettingsDeviceTest : IncrementDeviceTest() {
    private val session = "34DSessionSettings0001"
    private val task = "34DSessionSettingsTask1"
    override val ids get() = listOf(workspace, runner, session, task)
    @Volatile private var muted = false

    override fun runnerJson() = """{"id":"$runner","name":"hpc-01","displayName":"HPC","online":true,"status":"ONLINE","version":"0.1.262",
        "engines":[{"engine":"claude","installed":true,"auth":"yes","version":"2.4.1"}],"modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}]}}"""

    private fun settings() = """{"env":{"DEBUG":"orbit:*","LOG_LEVEL":"trace"},
        "workspaceEnv":{"NODE_OPTIONS":"--max-old-space-size=6144","GOCACHE":"/mnt/data/gocache"},
        "notifyTurnFinished":"inherit","notifyNeedsYou":"inherit","muted":$muted,"envPendingRestart":true}"""

    private fun row() = """{"id":"$session","title":"Session page settings","status":"RUNNING","runState":"RUNNING","lifecycleState":"OPEN",
        "provider":"claude","engine":"claude","engineVersion":"2.4.1","claudeAccount":"max-2","model":"claude-opus-5-5",
        "assignedRunnerId":"$runner","assignedRunner":{"id":"$runner","name":"hpc-01","displayName":"HPC",
        "engines":[{"engine":"claude","version":"2.4.1","accounts":[{"id":"default"},{"id":"max-2","name":"Max (account 2)"}]}]},
        "agent":{"id":"$workspace","name":"Alpha"},"agentId":"$workspace","workspace":{"id":"$workspace","name":"Alpha","workDir":"~/.orbit/worktrees/01a1c927"},
        "createdAt":"2026-09-28T12:00:00Z","lastTurnAt":"${ago(1)}","capabilities":{"canSend":true,"canComplete":true},"taskId":"$task",
        "tags":[{"id":"t-web","name":"web","color":"#3B82F6"},{"id":"t-review","name":"needs review","color":"#F59E0B"}],"pendingApprovals":0,
        "branch":"orbit/session-settings-d","worktreeBranch":"orbit/session-settings-d","isolationStatus":"worktree","worktreeDirty":false,
        "mergeTarget":"main","changedFiles":[{"path":"reader/SessionSettingsPage.kt","additions":412,"deletions":0,"status":"A"}],
        "settings":${settings()},
        "usage":{"inputTokens":190000,"outputTokens":108000,"cacheReadTokens":1520000,"cacheCreationTokens":0,"costUsd":4.37,"numTurns":23}}"""

    override fun sessions(view: String, project: String?) = if (view == "open") "[${row()}]" else "[]"

    override fun answer(req: Req): MockResponse? = when {
        req.path == "sessions/$session" && req.method == "GET" -> json(row())
        req.path == "sessions/$session/events/page" -> json(page(listOf(
            event(1, "user", """{"text":"Add a Settings page to the session's menu."}""", ago(14), "t-0"),
            event(2, "assistant", """{"text":"Here is the board: the ⋮ menu's Settings opens a page with Session, Environment, Notifications and Info."}""", ago(13), "t-0"))))
        req.path == "sessions/$session/share" && req.method == "GET" ->
            json("""{"link":{"token":"k3Rw9Tq2xYz","state":"ACTIVE","kind":"SESSION","root":{"id":"$session"}},"counts":null}""")
        req.path == "sessions/$session/settings" && req.method == "PATCH" -> {
            muted = req.body.contains("\"muted\":true") || (muted && !req.body.contains("\"muted\":false"))
            json(settings())
        }
        req.path == "sessions/$session/background" ->
            json("""[{"shellId":"bash_1","command":"./gradlew test","description":"Unit tests","status":"running","latestOutput":"BUILD SUCCESSFUL in 4m"}]""")
        req.path == "sessions/$session/restart" -> json("""{"queued":true,"afterTurn":true}""", 202)
        req.path == "session-tags" -> json("""[{"id":"t-web","name":"web","color":"#3B82F6"},{"id":"t-review","name":"needs review","color":"#F59E0B"},
            {"id":"t-ios","name":"ios","color":"#10B981"}]""")
        else -> null
    }

    private fun menuItems() = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }

    private fun scrollTo(text: String) { compose.onNodeWithTag("session-settings").performScrollToNode(hasText(text)); settle() }

    @Test fun settingsPageWithFourGroupsAndTheFormerDetailsUnderInfo() = journey {
        signIn()
        open("orbit-session:$session")
        await("the session's page, fresh") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
        compose.onNodeWithContentDescription("Session actions").performClick(); settle()
        val items = menuItems()
        note("menu: $items")
        verify("Settings follows Tags…", items.indexOf("Settings") == items.indexOf("Tags…") + 1)
        verify("no Session details", "Session details" !in items)
        capture("01-menu")
        compose.onNode(hasText("Settings") and hasAnyAncestor(isPopup())).performClick()
        awaitTag("session-settings")
        awaitText("Live · anyone with the link can read it")
        verify("the page is titled Session settings", exists(hasText("Session settings")))
        capture("02-settings-session")
        scrollTo("Restart after this turn")
        verify("a running turn: the restart waits for it", exists(hasText("Restart after this turn")))
        capture("03-settings-environment")
        scrollTo("Mute this session")
        verify("Notifications says where it applies", exists(hasText("iOS and Android")))
        capture("04-settings-notifications")
        scrollTo("Worktree and background jobs")
        listOf("Claude Code 2.4.1", "HPC · Claude Code · Max (account 2)", "1.82M", "in 1.71M · out 108K · cache 1.52M", "$4.37", "23 turns", "Session ID")
            .forEach { verify("Info: $it", exists(hasText(it, substring = true), unmerged = true)) }
        capture("05-settings-info")
        compose.onNodeWithText("Worktree and background jobs").performClick()
        awaitTag("session-work")
        verify("Worktree / Git", exists(hasText("Worktree / Git")))
        verify("the diff is a press away", exists(hasText("View changed files and diff")))
        compose.onNodeWithTag("session-work").performScrollToNode(hasText("Unit tests"))
        verify("background work", exists(hasText("Background work")))
        capture("06-worktree-and-background-jobs")
        compose.onNodeWithContentDescription("Back to settings").performClick(); settle()
        scrollTo("Variables")
        compose.onNodeWithText("Variables").performClick()
        awaitTag("session-variables")
        verify("the workspace's are listed read-only", exists(hasText("From the workspace")))
        capture("07-variables")
        compose.onNodeWithContentDescription("Back to settings").performClick(); settle()
        scrollTo("Compact at")
        compose.onNodeWithText("Compact at").performClick(); settle()
        awaitText("700K tokens")
        capture("08-compact-at")
        compose.onNodeWithText("Cancel").performClick(); settle()
        scrollTo("Mute this session")
        compose.onNodeWithText("Mute this session").performClick()
        await("Mute saved at once") { calls.any { it == "PATCH sessions/$session/settings" } }
        scrollTo("Restart after this turn")
        compose.onNode(hasText("Restart after this turn") and hasClickAction()).performClick()
        await("Restart sent") { calls.any { it == "POST sessions/$session/restart" } }
        compose.onNodeWithContentDescription("Close settings").performClick(); settle()
        await("the page closes") { !exists(hasTestTag("session-settings"), unmerged = true) }
    }
}
