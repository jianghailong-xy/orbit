package io.orbitd.android.increments

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A07 increments on a device: one Claude session of workspace Alpha, served by the test's own fixture, in the state each row needs —
 * a turn the runner accepted but has not echoed (A07-14), the engine's next-prompt guess in the empty composer and the Settings switch
 * for it (A07-16, A07-21), the runner read again a minute on and on a reconnect, after an opening read tried three times (A07-18),
 * Stop while the engine or its background work runs (A07-20), the tray's unread steer withdrawn and its delivery words (A07-22), and
 * Put back for a message that was never delivered (A07-24). The shapes are the composer shell tests' (ComposerShell, AcceptedHeadShellTest,
 * StopShellTest, PendingTrayShellTest, SteerOutcomeShellTest, RunnerRefreshShellTest).
 */
@RunWith(AndroidJUnit4::class)
class ComposerIncrementsDeviceTest : IncrementDeviceTest() {
    private val session = "34A15cSessionComposer1"
    override val ids get() = listOf(workspace, runner, session)

    /** Fields over the session's detail, as a test needs them. */
    @Volatile private var overlay: Map<String, String> = emptyMap()
    @Volatile private var events: List<String> = emptyList()
    @Volatile private var turns = "[]"
    @Volatile private var window = 200_000
    @Volatile private var preferences = "{}"
    /** How many of the next `GET providers` fail before one answers (A07-18's opening read). */
    private val providersFailing = AtomicInteger(0)
    /** The answer to a DELETE of a turn, by turn id; absent answers `{}`. */
    @Volatile private var deletes: Map<String, () -> MockResponse> = emptyMap()

    private fun detail(): String {
        val base = Json.parseToJsonElement("""{"id":"$session","title":"Composer increments","status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
            "lifecycleState":"OPEN","provider":"claude","engine":"claude","model":"claude-opus-5-5","assignedRunnerId":"$runner",
            "agent":{"id":"$workspace","name":"Alpha"},"agentId":"$workspace","createdAt":"${ago(600)}","lastTurnAt":"${ago(5)}",
            "capabilities":{"canSend":true,"canResume":false,"canComplete":true},"tags":[],"pendingApprovals":0}""").jsonObject
        return JsonObject(base + overlay.mapValues { Json.parseToJsonElement(it.value) }).toString()
    }
    override fun sessions(view: String, project: String?) = if (view == "open") "[${detail()}]" else "[]"
    override fun runnerJson() = """{"id":"$runner","name":"Fixture runner","online":true,"status":"ONLINE","version":"0.1.262",
        "engines":[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"yes"}],
        "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5","contextWindow":$window}],"codex":[{"value":"gpt-6","label":"GPT-6"}]}}"""
    override fun userJson() = """{"id":"u1","email":"a15c@example.test","name":"A15c fixture","preferences":$preferences}"""

    override fun answer(req: Req): MockResponse? {
        val p = req.parts
        return when {
            req.path == "sessions/$session" && req.method == "GET" -> json(detail())
            req.path == "sessions/$session/events/page" -> json(page(events))
            req.path == "sessions/$session/turns" && req.method == "GET" -> json(turns)
            req.path == "sessions/$session/turns" && req.method == "POST" -> json("""{"turnId":"turn-new","kind":"message","status":"PENDING"}""")
            req.path == "sessions/$session/interrupt" -> json("""{"ok":true}""")
            p.size == 4 && p[0] == "sessions" && p[2] == "turns" && req.method == "DELETE" -> deletes[p[3]]?.invoke() ?: json("{}")
            req.path == "sessions/$session/retry-message" -> json("""{"text":""}""")
            req.path == "providers" && req.method == "GET" ->
                if (providersFailing.getAndUpdate { if (it > 0) it - 1 else 0 } > 0) json("""{"message":"unavailable"}""", 503) else json("[]")
            req.path == "providers/pools" || req.path == "providers/shared-pools" -> json("[]")
            req.path == "users/me/preferences" && req.method == "PATCH" -> {
                val now = Json.parseToJsonElement(preferences).jsonObject + Json.parseToJsonElement(req.body).jsonObject
                preferences = JsonObject(now).toString()
                json(userJson())
            }
            else -> null
        }
    }

    private fun openSession() {
        signIn()
        open("orbit-session:$session")
        await("the session's composer") { exists(hasTestTag("composer-model") and isEnabled()) && app.realtime.state.value.session?.fresh == true }
    }
    private fun draft(): String = compose.onAllNodesWithTag("composer-input").fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()
    private fun turnEvents() = listOf(
        event(1, "user", """{"text":"Ship the build"}""", turnId = "t-0"),
        event(2, "assistant", """{"text":"Shipped."}""", turnId = "t-0"),
        event(3, "turn_end", """{"subtype":"success"}""", turnId = "t-0"))

    /** A07-14: the turn a runner accepted is drawn as the echo it will be, until its echo takes over. */
    @Test fun aTurnTheRunnerAcceptedIsAPlaceholderRowUntilItsEcho() = journey {
        val head = "01a0cca7-8609-70ed-a0e2-d4b55b832b71"
        events = turnEvents()
        turns = """[{"turnId":"$head","kind":"message","placement":"accepted","content":"Write the release notes","attachments":[],"createdAt":"${ago(1)}"},
            {"turnId":"34A15cTurnQueuedNext01","kind":"message","placement":"queued","content":"Then tag v2","attachments":[],"createdAt":"${ago(0)}"}]"""
        openSession()
        verify("the snapshot read the active view", calls.any { it == "GET sessions/$session/turns?view=active" })
        awaitTag("accepted:$head")
        verify("the head is the user's words", says("accepted:$head", "Write the release notes"))
        verify("the head offers no Cancel and says no Queued", !says("accepted:$head", "Cancel") && !says("accepted:$head", "Queued"))
        verify("the head is not one of the queued rows", !exists(hasTestTag("pending-tray:$head"), unmerged = true) && !exists(hasTestTag("queued:$head"), unmerged = true))
        verify("the queued turn waits in the tray", exists(hasTestTag("pending-tray:34A15cTurnQueuedNext01"), unmerged = true) ||
            exists(hasText("Then tag v2"), unmerged = true))
        capture("01-accepted-head")
        // The runner echoes the turn (its id in another spelling): the echo takes the head's place.
        events = turnEvents() + event(4, "user", """{"text":"Write the release notes"}""", turnId = head.uppercase())
        reconnect()
        await("the echo replaces the head") { !exists(hasTestTag("accepted:$head"), unmerged = true) && exists(hasTestTag("event:4"), unmerged = true) }
        verify("the words are drawn once", count(hasText("Write the release notes") and hasAnyAncestor(hasTestTag("transcript-list")), unmerged = true) == 1)
        capture("02-echo-took-over")
    }

    /** A07-16 and A07-21: the empty composer offers the engine's guess with "Double-tap to use" beside it; a double-tap takes it. */
    @Test fun theEmptyComposerOffersTheEnginesGuess() = journey {
        val longGuess = "run the whole instrumentation suite on every API level from 29 to 36 and attach the reports to the release notes"
        events = turnEvents() + event(4, "prompt_suggestion", """{"text":"  ${longGuess} ","source":"engine"}""", turnId = "t-0")
        preferences = """{"promptSuggestions":true}"""
        openSession()
        awaitTag("composer-suggestion-hint")
        val inComposer = hasAnyAncestor(hasTestTag("composer-input"))
        verify("the guess is the placeholder", exists(inComposer and hasText(longGuess), unmerged = true))
        compose.onNodeWithTag("composer-suggestion-hint", useUnmergedTree = true).assertIsDisplayed()
        val hint = compose.onNodeWithTag("composer-suggestion-hint", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val field = compose.onNodeWithTag("composer-input").fetchSemanticsNode().boundsInRoot
        verify("“Double-tap to use” stays inside the field beside a guess too long for it ($hint in $field)",
            hint.left >= field.left && hint.right <= field.right + 1 && hint.top >= field.top && hint.bottom <= field.bottom + 1 && hint.width > 0)
        verify("TalkBack does not read the hint's words", !exists(hasText("Double-tap to use"), unmerged = true))
        verify("the draft is empty", draft().isEmpty())
        capture("01-guess-offered")
        compose.onNodeWithTag("composer-input").performTouchInput { doubleClick() }
        await("a double-tap puts the guess in the field") { draft() == longGuess }
        verify("taking the guess sends nothing", bodies.none { it.first == "POST sessions/$session/turns" })
        capture("02-guess-taken")
    }

    /** A07-16: Settings → Sessions → Suggested replies is the account's own switch, written to the server and read back. */
    @Test fun theSuggestedRepliesSwitchIsKeptOnTheServer() = journey {
        preferences = """{"promptSuggestions":true}"""
        signIn()
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        compose.onNode(hasText("Settings") and hasClickAction()).performClick()
        val toggle = hasText("Suggested replies") and isToggleable()
        await("the Suggested replies switch") { exists(toggle) && compose.onAllNodes(toggle and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(toggle).performScrollTo().assertIsOn()
        capture("01-switch-on")
        compose.onNode(toggle).performClick()
        await("the switch is written off") { bodies.any { it.first == "PATCH users/me/preferences" && it.second.replace(" ", "") == """{"promptSuggestions":false}""" } }
        await("and reads back off") { compose.onAllNodes(toggle).fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(SemanticsProperties.ToggleableState)?.name == "Off" }
        capture("02-switch-off")
        compose.onNode(toggle).performClick()
        await("the switch is written on again") { bodies.count { it.first == "PATCH users/me/preferences" } >= 2 &&
            bodies.last { it.first == "PATCH users/me/preferences" }.second.replace(" ", "") == """{"promptSuggestions":true}""" }
        await("and reads back on") { compose.onAllNodes(toggle).fetchSemanticsNodes().firstOrNull()?.config?.getOrNull(SemanticsProperties.ToggleableState)?.name == "On" }
    }

    /** A07-18: the catalogue's opening read is tried three times (300 then 600 ms apart); the runner is read again a minute on (page
     * time) and at once on a reconnect, and what it says is what the page draws. */
    @Test fun thePageReadsItsRunnerAgainEveryMinuteAndOnReconnect() = journey {
        events = turnEvents()
        providersFailing.set(2)
        openSession()
        await("the stream connected") { connected() }
        compose.onNode(hasText("Context: 0 tokens · Usage") and hasClickAction()).performClick()
        await("the catalogue read three times") { calls.count { it == "GET providers" } >= 3 }
        val tries = timed.filter { it.second == "GET providers" }.map { it.first }
        note("catalogue tries at uptime ${tries.joinToString()}")
        verify("the second try waited about 300 ms (${tries[1] - tries[0]} ms)", tries[1] - tries[0] in 250..5_000)
        verify("the third try waited about 600 ms (${tries[2] - tries[1]} ms)", tries[2] - tries[1] in 550..5_000)
        compose.onNode(hasText("Close") and hasClickAction()).performClick()
        awaitText("Context: 0 / 200000 tokens · Usage")
        capture("01-catalogue-after-three-tries")
        // A minute of page time on: the runner is read again, and its new window drawn.
        window = 400_000
        val before = calls.count { it == "GET runners" }
        compose.mainClock.advanceTimeBy(61_000)
        await("a minute on, the runner is read again") { calls.count { it == "GET runners" } > before }
        awaitText("Context: 0 / 400000 tokens · Usage")
        capture("02-minute-re-read")
        // A reconnect reads it again at once.
        window = 300_000
        val beforeReconnect = calls.count { it == "GET runners" }
        reconnect()
        await("the stream reconnected") { connected() }
        await("the reconnect reads the runner") { calls.count { it == "GET runners" } > beforeReconnect }
        awaitText("Context: 0 / 300000 tokens · Usage")
        capture("03-reconnect-re-read")
    }

    /** A07-20: Stop stands in for Send while the engine or its background work runs, and it ends that work too. */
    @Test fun stopIsOfferedWhileWorkRunsAndEndsTheBackgroundWork() = journey {
        events = turnEvents()
        openSession()
        val send = hasTestTag("composer-send")
        fun shows(label: String, enabled: Boolean) = exists(send and hasText(label) and if (enabled) isEnabled() else isNotEnabled())
        await("an idle session's empty composer offers a disabled Send") { shows("Send", enabled = false) }
        capture("01-send-idle")
        overlay = mapOf("runningBgShells" to """["bg-1"]""")
        app.realtime.refreshSession()
        await("background shells running: Stop") { shows("Stop", enabled = true) }
        capture("02-stop-background-work")
        compose.onNode(send).performClick()
        await("the interrupt asks to stop the background work") {
            bodies.any { it.first == "POST sessions/$session/interrupt" && Json.parseToJsonElement(it.second).jsonObject["stopBackgroundWork"] == JsonPrimitive(true) }
        }
        awaitText("Stop requested.")
        verify("exactly one interrupt", bodies.count { it.first == "POST sessions/$session/interrupt" } == 1)
        for ((fields, what) in listOf(mapOf("runningSubagents" to """["agent-1"]""") to "sub-agents running",
                mapOf("engineTurnActive" to "true") to "an engine-started turn",
                mapOf("status" to "\"RUNNING\"", "runState" to "\"RUNNING\"") to "a running turn")) {
            overlay = fields
            app.realtime.refreshSession()
            await("$what: Stop") { shows("Stop", enabled = true) }
        }
        capture("03-stop-running")
        overlay = mapOf("runningBgShells" to "[]")
        app.realtime.refreshSession()
        await("nothing running: Send again") { shows("Send", enabled = false) }
        capture("04-send-again")
    }

    /** A07-22: an unread steer is withdrawn from the tray (Withdrawing… while it goes, its words back in the composer); one the engine
     * already read is too late; a read one leaves the tray saying so. */
    @Test fun anUnreadSteerIsWithdrawnAndItsDeliveryIsWorded() = journey {
        val steerA = "01a0cca7-8609-70ed-a0e2-d4b55b832b81"
        val steerB = "01a0cca7-8609-70ed-a0e2-d4b55b832b83"
        val queued = "01a0cca7-8609-70ed-a0e2-d4b55b832b82"
        overlay = mapOf("status" to "\"RUNNING\"", "runState" to "\"RUNNING\"")
        val opening = listOf(
            event(1, "user", """{"text":"Fix the export"}""", turnId = "t-0"),
            event(2, "assistant", """{"text":"Running the suite"}""", turnId = "t-0"),
            event(3, "user", """{"text":"then push it to main","steer":true,"delivery":"written","withdrawable":true}""", turnId = steerA),
            event(4, "user", """{"text":"and keep the old flag","steer":true,"delivery":"written","withdrawable":true}""", turnId = steerB))
        events = opening
        turns = """[{"turnId":"$queued","kind":"message","placement":"queued","content":"and update the changelog","attachments":[],"createdAt":"${ago(0)}"}]"""
        deletes = mapOf(
            steerA to { json("{}").setHeadersDelay(3, TimeUnit.SECONDS) },
            steerB to { json("""{"statusCode":409,"code":"STEER_ALREADY_READ","message":"The engine has already read this message."}""", 409) })
        openSession()
        awaitTag("pending-tray:$steerA")
        verify("the unread steer is waiting to be read", says("pending-tray:$steerA", "Waiting to be read"))
        verify("it can be withdrawn, not steered again", exists(hasTestTag("pending-tray-withdraw") and hasAnyAncestor(hasTestTag("pending-tray:$steerA"))) &&
            !exists(hasTestTag("pending-tray-steer") and hasAnyAncestor(hasTestTag("pending-tray:$steerA"))))
        verify("the queued message waits for the next turn", says("pending-tray:$queued", "Queued for next turn"))
        capture("01-tray")
        compose.onNode(hasTestTag("pending-tray-withdraw") and hasAnyAncestor(hasTestTag("pending-tray:$steerA"))).performClick()
        await("the row says Withdrawing… while the request is out") { says("pending-tray:$steerA", "Withdrawing…") }
        capture("02-withdrawing")
        await("the withdrawn steer leaves the tray") { !exists(hasTestTag("pending-tray:$steerA"), unmerged = true) }
        await("its words come back to the composer") { draft().contains("then push it to main") }
        verify("the withdraw was a DELETE of that turn", calls.any { it == "DELETE sessions/$session/turns/$steerA" })
        capture("03-withdrawn")
        compose.onNodeWithTag("composer-input").performTextClearance()
        compose.onNode(hasTestTag("pending-tray-withdraw") and hasAnyAncestor(hasTestTag("pending-tray:$steerB"))).performClick()
        await("too late: the engine already read it") { exists(hasText("Too late to withdraw"), unmerged = true) }
        verify("and says who read it", exists(hasText("Claude has already read it."), unmerged = true))
        verify("the steer stays where it was", exists(hasTestTag("pending-tray:$steerB"), unmerged = true))
        capture("04-too-late")
        // The engine's receipt arrives: the steer leaves the tray and its bubble says it was read in this turn.
        events = opening + event(5, "user_delivery", """{"turnId":"$steerB","delivery":"acknowledged"}""", turnId = "t-0")
        reconnect()
        await("the read steer leaves the tray") { !exists(hasTestTag("pending-tray:$steerB"), unmerged = true) }
        scrollTranscriptTo(hasTestTag("event:4"))
        await("its bubble says it was read") {
            exists(hasTestTag("steer-state") and hasAnyAncestor(hasTestTag("event:4")) and hasText("Read in this turn", substring = true), unmerged = true) ||
                exists(hasAnyAncestor(hasTestTag("steer-state")) and hasAnyAncestor(hasTestTag("event:4")) and hasText("Read in this turn"), unmerged = true)
        }
        capture("05-read-in-this-turn")
    }

    /** A07-24: a steer that was never delivered offers Put back in the composer, and says why; one known only from its receipt goes
     * from the queue when put back. */
    @Test fun anUndeliveredMessageIsPutBackInTheComposerWithWhy() = journey {
        val receipt = "01a0cca7-8609-70ed-a0e2-d4b55b832b85"
        events = listOf(
            event(1, "user", """{"text":"Fix the export"}""", turnId = "t-0"),
            event(2, "user", """{"text":"then push it to main","steer":true,"delivery":"written","withdrawable":true}""", turnId = "t-1"),
            event(3, "user_delivery", """{"turnId":"t-1","delivery":"acknowledged"}""", turnId = "t-0"),
            event(4, "user", """{"text":"and tag the release","steer":true,"delivery":"written","withdrawable":true}""", turnId = "t-2"),
            event(5, "user_delivery", """{"turnId":"t-2","delivery":"failed","reason":"the engine exited before reading it"}""", turnId = "t-0"),
            event(6, "assistant", """{"text":"Exported"}""", turnId = "t-0"))
        turns = """[{"turnId":"$receipt","kind":"steer","placement":"steer","content":"and write the notes","attachments":[],"delivery":"failed",
            "deliveryCode":"CURRENT_WORK_TARGET_COMPLETED","deliveryReason":"the target turn completed before CURRENT_WORK could be delivered",
            "createdAt":"${ago(0)}"}]"""
        openSession()
        scrollTranscriptTo(hasTestTag("event:4"))
        await("the undelivered steer says so") { exists(hasAnyAncestor(hasTestTag("event:4")) and hasText("Not delivered", substring = true), unmerged = true) }
        verify("it offers Put back", exists(hasTestTag("steer-state:put-back") and hasAnyAncestor(hasTestTag("event:4")), unmerged = true))
        verify("the read one offers nothing", !exists(hasTestTag("steer-state:put-back") and hasAnyAncestor(hasTestTag("event:2")), unmerged = true))
        capture("01-not-delivered")
        compose.onNode(hasTestTag("steer-state:put-back") and hasAnyAncestor(hasTestTag("event:4")), useUnmergedTree = true).performClick()
        await("its words come back to the composer") { draft().contains("and tag the release") }
        verify("putting it back sends nothing", bodies.none { it.first.startsWith("POST sessions/$session/turns") } &&
            calls.none { it == "DELETE sessions/$session/turns/t-2" })
        verify("the bubble stays as the record", exists(hasTestTag("event:4"), unmerged = true))
        capture("02-put-back-from-transcript")
        compose.onNodeWithTag("composer-input").performTextClearance()
        val row = "queued:$receipt"
        scrollTranscriptTo(hasTestTag(row))
        verify("the receipt's row says why it did not land", says(row, "The turn finished before it was read."))
        verify("and that it was not delivered", says(row, "Not delivered", substring = true))
        capture("03-receipt-row")
        compose.onNode(hasText("Put back in the composer") and hasAnyAncestor(hasTestTag(row)), useUnmergedTree = true).performClick()
        await("the receipt's words come back") { draft().contains("and write the notes") }
        await("the receipt is taken off the queue") { calls.any { it == "DELETE sessions/$session/turns/$receipt" } }
        verify("nothing is sent", bodies.none { it.first == "POST sessions/$session/turns" })
        capture("04-put-back-from-receipt")
    }
}
