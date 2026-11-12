package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * G4b, session guests on Android (docs/session-guests-design.md §3), over the test's own fixture and with G4a's iPhone frames' data: a
 * guest's turn headed `From Alice Chen` in the transcript, the session row `From Alice Chen: …` beside rows that keep `You: …`, and the
 * Share sheet's People who can reply — two guests in Accept edits, and a Bypass session before its first invite (amber line and the
 * tick Invite waits for). The shapes are the JVM tests' (ExternalSenderTest, ExternalSenderShellTest, SessionGuestsTest).
 */
@RunWith(AndroidJUnit4::class)
class SessionGuestsDeviceTest : IncrementDeviceTest() {
    private val guested = "34G4bSessionGuested001"
    private val settings = "34G4bSessionSettings01"
    private val receipts = "34G4bSessionReceipts01"
    override val ids get() = listOf(workspace, runner, guested, settings, receipts)

    @Volatile private var mode = "acceptEdits"
    @Volatile private var guests = "[]"
    private val alice = """{"userId":"u-alice","name":"Alice Chen","email":"alice@example.com","addedAt":"2026-11-12T02:00:00.000Z","messagesToday":12,"opened":true}"""
    private val ravi = """{"userId":"u-ravi","name":"Ravi Kumar","email":"ravi@example.com","addedAt":"2026-11-12T03:00:00.000Z","messagesToday":0,"opened":false}"""

    override fun runnerJson() = """{"id":"$runner","name":"build-box","displayName":"build-box","online":true,"status":"ONLINE","version":"0.1.262",
        "engines":[{"engine":"claude","installed":true,"auth":"yes"}],"modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}]}}"""

    private fun row(id: String, title: String, text: String, minutes: Long, from: String? = null, status: String = "AWAITING_INPUT") =
        """{"id":"$id","title":"$title","status":"$status","runState":"$status","lifecycleState":"OPEN","provider":"claude","engine":"claude",
        "model":"claude-opus-5-5","permissionMode":"$mode","assignedRunnerId":"$runner","agent":{"id":"$workspace","name":"Alpha"},
        "agentId":"$workspace","createdAt":"${ago(600)}","lastTurnAt":"${ago(minutes)}","capabilities":{"canSend":true,"canComplete":true},
        "tags":[],"pendingApprovals":0,"lastUserText":${quote(text)}${from?.let { ",\"lastUserFromExternal\":$it" } ?: ""}}"""
    private val guestFrom = """{"source":"ORBIT_GUEST","name":"Alice Chen"}"""
    private fun guestedRow() = row(guested, "Retry budget for flaky pg specs",
        "Twice is fine, but CI should fail if the same test needed a retry three runs in a row.", 2, guestFrom, status = "RUNNING")

    override fun sessions(view: String, project: String?) = if (view != "open") "[]" else listOf(guestedRow(),
        row(settings, "Settings sheet reorder", "Ship it after the iOS shot", 60),
        row(receipts, "Landing receipts wording", "Make the receipts say what landed", 180)).joinToString(",", "[", "]")

    override fun answer(req: Req): MockResponse? = when {
        req.path == "sessions/$guested" && req.method == "GET" -> json(guestedRow())
        req.path == "sessions/$guested/events/page" -> json(page(listOf(
            event(1, "user", """{"text":"Can we give pg specs a retry budget instead of skipping link-heartbeat?"}""", ago(14), "t-0"),
            event(2, "assistant", """{"text":"I’d retry only tests tagged `@flaky`, at most twice, and list every retry in the summary."}""", ago(13), "t-0"),
            event(3, "turn_end", """{"subtype":"success"}""", ago(13), "t-0"),
            event(4, "user", """{"text":"Twice is fine, but CI should fail if the same test needed a retry three runs in a row.",
                "externalSender":$guestFrom}""", ago(2), "t-1"),
            event(5, "assistant", """{"text":"Good call. I’ll keep a per-test retry count in `.vitest-retries.json` and fail when a test needed a retry in three consecutive runs."}""", ago(1), "t-1"),
            event(6, "turn_end", """{"subtype":"success"}""", ago(1), "t-1"))))
        req.path == "sessions/$guested/share" && req.method == "GET" -> json("""{"link":null,"counts":null}""")
        req.path == "sessions/$guested/guests" && req.method == "GET" -> json("""{"guests":$guests}""")
        else -> null
    }

    private fun openSession() {
        signIn()
        open("orbit-session:$guested")
        await("the session's page, fresh") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
    }

    private fun openShare() {
        openSession()
        compose.onNodeWithContentDescription("Session actions").performClick()
        compose.onNode(hasText("Share…") and hasAnyAncestor(isPopup())).performClick()
        await("Share session") { exists(hasText("Share session")) }
        awaitText("People who can reply")
    }

    @Test fun aGuestsTurnIsHeadedWithTheirName() = journey {
        openSession()
        await("the guest's turn") { exists(hasTestTag("event:4")) }
        verify("the guest's turn says From Alice Chen", says("event:4", "From Alice Chen"))
        verify("the guest's turn does not say You", !says("event:4", "You"))
        verify("the owner's own turn still says You", says("event:1", "You"))
        capture("transcript")
    }

    @Test fun theRowNamesTheGuestInsteadOfYou() = journey {
        signIn()
        awaitText("From Alice Chen: Twice is fine, but CI should fail if the same test needed a retry three runs in a row.")
        verify("the other rows keep You", exists(hasText("You: Ship it after the iOS shot"), unmerged = true))
        verify("the guest's row does not say You", !exists(hasText("You: Twice is fine", substring = true), unmerged = true))
        capture("row")
    }

    @Test fun theShareSheetListsTwoGuestsInAcceptEdits() = journey {
        mode = "acceptEdits"; guests = "[$alice,$ravi]"
        openShare()
        awaitText("Alice Chen")
        verify("Access says the invited can still reply", exists(hasText("No public link. People you invite below can still open and reply.")))
        verify("Alice's today", exists(hasText("12 messages today")))
        verify("Ravi has not opened it", exists(hasText("Not opened yet")))
        verify("one Remove per guest", count(hasText("Remove")) == 2)
        verify("the consequence names the machine and the mode", exists(hasText("They can send messages to this session. The agent runs them on " +
            "build-box as Accept edits, using your accounts. Approvals and the agent’s questions still come only to you.")))
        verify("no tick asked", !exists(hasText("I understand the agent won’t ask before acting on their messages")))
        capture("share-two-guests")
    }

    @Test fun bypassAsksForTheTickBeforeTheFirstInvite() = journey {
        mode = "bypassPermissions"; guests = "[]"
        openShare()
        awaitText("I understand the agent won’t ask before acting on their messages")
        verify("the amber line says it won't ask", exists(hasText("They can send messages to this session. The agent runs them on " +
            "build-box as Bypass permissions, using your accounts — it won’t ask before acting.")))
        compose.onNodeWithTag("share-people-email").performTextInput("alice@example.com")
        settle()
        verify("Invite waits for the tick", runCatching { compose.onNode(hasText("Invite") and hasClickAction()).assertIsNotEnabled() }.isSuccess)
        // The dialog is a window of its own, so dropFocus() cannot reach its field: Back takes the keyboard down, as a person would.
        instrumentation.uiAutomation.executeShellCommand("input keyevent KEYCODE_BACK").close()
        settle()
        awaitText("People who can reply")
        capture("share-bypass-first")
        compose.onNode(hasText("I understand the agent won’t ask before acting on their messages")).performClick()
        settle()
        verify("ticked, Invite can be pressed", runCatching { compose.onNode(hasText("Invite") and hasClickAction()).assertIsEnabled() }.isSuccess)
    }
}
