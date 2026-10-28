package io.orbitd.android.increments

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A06 increments (and A01b's reader rows, and A04-1) on a device: one session per row, served by the test's own fixture, in the state
 * the row needs — the sticky question's hold (A01b I-STICKY-HOLD), a coordinator's worktree bar merging into its project's line
 * (A01b I-WT-MERGE-TARGET), thinking rows settled, timed and streaming (A06-10, A06-11), a pinned tail under growing rows (A06-13),
 * the worktree bar's turn gate (A06-14), an answered AskUserQuestion (A06-15), a running agent's live line (A06-17), a runner-restart
 * interrupt (A06-21), the merge recovery's repair loop (A06-22), and a dropped stream's gap closed over REST (A04-1). The shapes are the
 * reader's JVM tests' (StickyQuestionHoldTest, WorktreeBarTest, ReaderIncrementsTest, ReaderPiecesTest, TranscriptThinkingTest,
 * QuestionRecordCardTest, InterruptRowsTest, RealtimeStoreTest).
 */
@RunWith(AndroidJUnit4::class)
class ReaderIncrementsDeviceTest : IncrementDeviceTest() {
    private val sticky = "34A15cReaderSticky0001"
    private val coordinator = "34A15cReaderCoord00001"
    private val thinking = "34A15cReaderThinking01"
    private val live = "34A15cReaderLiveThink1"
    private val pinned = "34A15cReaderPinned0001"
    private val gate = "34A15cReaderGate000001"
    private val asked = "34A15cReaderAsked00001"
    private val agents = "34A15cReaderAgents0001"
    private val interrupts = "34A15cReaderInterrupt1"
    private val repair = "34A15cReaderRepair0001"
    private val gap = "34A15cReaderGap0000001"
    private val repairSession = "01a0cca7-8609-70ed-a0e2-d4b55b83a15c"
    override val ids get() = listOf(workspace, runner, sticky, coordinator, thinking, live, pinned, gate, asked, agents, interrupts, repair, gap)

    /** The session this test reads, its detail's fields, events, /background rows, and what its stream sends as it opens. */
    @Volatile private var session = ""
    @Volatile private var overlay: Map<String, String> = emptyMap()
    @Volatile private var events: List<String> = emptyList()
    @Volatile private var background = "[]"
    @Volatile private var opening = ""
    /** The worktree's merge as the fixture runs it: posted at (uptime ms), and what the next detail says. */
    @Volatile private var mergePostedAt = 0L
    @Volatile private var holdSendSeconds = 0L

    private fun detail(): String {
        val base = Json.parseToJsonElement("""{"id":"$session","title":"Reader increments","status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
            "lifecycleState":"OPEN","provider":"claude","engine":"claude","model":"claude-opus-5-5","assignedRunnerId":"$runner",
            "agent":{"id":"$workspace","name":"Alpha"},"agentId":"$workspace","createdAt":"${ago(600)}","lastTurnAt":"${ago(5)}",
            "capabilities":{"canSend":true,"canResume":false,"canComplete":true},"tags":[],"pendingApprovals":0}""").jsonObject
        val fields = overlay.toMutableMap()
        // The fixture's merge: pending for a second after the press, then merged into the target pressed.
        if (mergePostedAt > 0) {
            val target = bodies.lastOrNull { it.first == "POST sessions/$session/merge" }?.second?.let { Json.parseToJsonElement(it).jsonObject["targetBranch"] }
            fields["mergeStatus"] = if (android.os.SystemClock.uptimeMillis() - mergePostedAt < 1_000) "\"pending\"" else "\"merged\""
            target?.let { fields["mergeTarget"] = it.toString() }
        }
        return JsonObject(base + fields.mapValues { Json.parseToJsonElement(it.value) }).toString()
    }
    override fun sessions(view: String, project: String?) = if (view == "open" && session.isNotEmpty()) "[${detail()}]" else "[]"
    override fun streamOpening(session: String, sinceSeq: Long) = if (session == this.session) opening.also { opening = "" } else ""

    override fun answer(req: Req): MockResponse? = when {
        req.path == "sessions/$session" && req.method == "GET" -> json(detail())
        req.path == "sessions/$session/events/page" -> json(page(events))
        req.path == "sessions/$session/background" -> json(background)
        req.path == "sessions/$session/merge" && req.method == "POST" -> {
            val body = Json.parseToJsonElement(req.body).jsonObject
            if (body["recoveryAction"] == null) mergePostedAt = android.os.SystemClock.uptimeMillis()
            json("{}")
        }
        req.path == "sessions/$session/merge-repair" && req.method == "POST" -> json("{}")
        req.path == "sessions/$session/turns" && req.method == "POST" ->
            json("""{"turnId":"turn-new","kind":"message","status":"PENDING"}""").setHeadersDelay(holdSendSeconds, TimeUnit.SECONDS)
        req.path == "sessions/$repairSession" && req.method == "GET" -> json("""{"id":"$repairSession","title":"Resolve merge recovery for main",
            "status":"RUNNING","runState":"RUNNING","lifecycleState":"OPEN","agent":{"id":"$workspace","name":"Alpha"},"agentId":"$workspace",
            "createdAt":"${ago(30)}","lastTurnAt":"${ago(1)}","capabilities":{"canSend":true},"tags":[],"pendingApprovals":0}""")
        req.path == "sessions/$repairSession/events/page" -> json(page(listOf(event(1, "user", """{"text":"Resolve the conflict in src/AgentsModel.swift"}"""))))
        else -> null
    }

    private fun openSession(id: String) {
        session = id
        signIn()
        open("orbit-session:$id")
        await("the session's page, fresh") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
    }
    private fun bottom(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()?.boundsInRoot?.bottom
    private fun top(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()?.boundsInRoot?.top
    private fun capsule() = compose.onAllNodes(hasAnyAncestor(hasTestTag("question-capsule")), useUnmergedTree = true).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { t -> t.text } }.joinToString(" ").takeIf { exists(hasTestTag("question-capsule")) }
    private fun list() = compose.onNodeWithTag("transcript-list")
    private fun refreshed() { app.realtime.refreshSession(); await("a fresh snapshot") { app.realtime.state.value.session?.fresh == true } }

    /** A01b I-STICKY-HOLD: the bar's question keeps the state it came from while the question straddles the top line — shown when the
     * reader came up from its replies, hidden when it came down from above — so it cannot flip back and forth. (The 400/40 dp fallback
     * is read only before the list's first layout, which no reader sees: the JVM test pins it.) */
    @Test fun theStickyQuestionHoldsWhileItStraddlesTheTopLine() = journey {
        val question = "Why does the export fail at midnight?\n" + (2..30).joinToString("\n") { "Detail line $it of the question." }
        events = listOf(event(1, "assistant", """{"text":${quote("Before the question. " + "Earlier reading. ".repeat(60))}}""")) +
            event(2, "user", """{"text":${quote(question)}}""") +
            (3..14).map { event(it, "assistant", """{"text":${quote("Reply $it: " + "the export runs in UTC and the test does not. ".repeat(12))}}""") }
        openSession(sticky)
        await("the tail") { exists(hasTestTag("event:14")) }
        verify("at the tail the bar names no question", capsule() == null)
        // A touch unpins the reader; then the replies are under the top line.
        list().performTouchInput { swipeDown(startY = centerY, endY = centerY + 60f, durationMillis = 600) }
        list().performScrollToKey("event:6"); settle()
        await("a reply under the top line names the question") { capsule()?.contains("Why does the export fail at midnight?") == true }
        capture("01-named-from-the-replies")
        // Up to the question itself: it straddles the line, and stays named.
        list().performScrollToKey("event:3"); settle()
        list().performTouchInput { swipeDown(startY = centerY, endY = centerY + 40f, durationMillis = 800) }; settle()
        val straddling = top("event:2")!! < (compose.onNodeWithTag("transcript-list").fetchSemanticsNode().boundsInRoot.top) &&
            bottom("event:2")!! > compose.onNodeWithTag("transcript-list").fetchSemanticsNode().boundsInRoot.top
        note("event:2 straddles the top line: $straddling")
        repeat(4) { step ->
            list().performTouchInput { if (step % 2 == 0) swipeUp(startY = centerY, endY = centerY - 24f, durationMillis = 500) else swipeDown(startY = centerY, endY = centerY + 24f, durationMillis = 500) }
            settle()
            verify("nudge ${step + 1}: the straddling question stays named", capsule()?.contains("Why does the export fail at midnight?") == true)
        }
        capture("02-held-while-straddling")
        // Above it, nothing is named; coming back down onto the straddling question does not raise it again.
        list().performScrollToKey("event:1"); settle()
        await("above the question the bar names none") { capsule() == null }
        list().performScrollToKey("event:3"); settle()
        list().performTouchInput { swipeDown(startY = centerY, endY = centerY + 40f, durationMillis = 800) }; settle()
        repeat(3) { step ->
            list().performTouchInput { if (step % 2 == 0) swipeUp(startY = centerY, endY = centerY - 24f, durationMillis = 500) else swipeDown(startY = centerY, endY = centerY + 24f, durationMillis = 500) }
            settle()
            verify("nudge ${step + 1} from above: the bar stays empty while the question straddles", capsule() == null)
        }
        capture("03-hidden-while-straddling-from-above")
    }

    /** A01b I-WT-MERGE-TARGET: a coordinator's worktree bar names its project's line, and Merge goes where the server resolved. */
    @Test fun aCoordinatorsWorktreeBarMergesIntoItsProjectsLine() = journey {
        val line = "project/34ZZn8fmemArxvl2CsCFp"
        overlay = mapOf("isolationStatus" to "\"worktree\"", "branch" to "\"orbit/coord-abcdef\"", "worktreeDirty" to "false",
            "mergeTargets" to """["main","develop"]""", "projectIntegrationRef" to "\"$line\"", "mergeTarget" to "\"$line\"",
            "projectMembership" to """{"projectId":"p","role":"COORDINATOR"}""",
            "changedFiles" to """[{"path":"src/reader/Bar.kt","additions":12,"deletions":3,"status":"M"}]""")
        events = listOf(event(1, "user", """{"text":"Coordinate the release."}"""), event(2, "assistant", """{"text":"Committed the plan."}"""))
        openSession(coordinator)
        awaitTag("worktree-bar")
        await("the bar offers the project's line") { exists(hasText("Merge to $line")) }
        verify("the bar names the line as its branch", exists(hasText(line) and hasAnyAncestor(hasTestTag("worktree-bar")), unmerged = true))
        capture("01-coordinator-bar")
        compose.onNode(hasText("Merge to $line") and hasClickAction()).performClick()
        await("the merge is asked for the server's target") { bodies.any { it.first == "POST sessions/$coordinator/merge" &&
            Json.parseToJsonElement(it.second).jsonObject["targetBranch"]?.toString() == "\"$line\"" } }
        await("and lands there", 30_000) { exists(hasText("✓ Merged → $line", substring = true), unmerged = true) }
        capture("02-merged-into-the-line")
    }

    /** A06-10 and A06-11: settled reasoning folds into rows that state the runner's time summed over their blocks, and open and fold on
     * a tap; a block streamed then closed states its own time. */
    @Test fun thinkingRowsStateTheRunnersTimeAndFoldOnATap() = journey {
        val a = "a".repeat(6998); val b = "b".repeat(6999); val c = "c".repeat(6999)
        events = listOf(
            event(1, "user", """{"text":"Why is the reader slow?"}"""),
            event(2, "thinking", """{"text":"first","thinkingMs":60000}"""),
            event(3, "thinking", """{"text":"second","thinkingMs":47000}"""),
            event(4, "thinking", """{"text":"third"}"""),
            event(5, "tool_use", """{"id":"t5","name":"Bash","input":{"command":"top -b -n 1"}}"""),
            event(6, "tool_result", """{"toolUseId":"t5","content":"load 4.1"}"""),
            event(7, "thinking", """{"text":""}"""),
            event(8, "thinking", """{"text":"after the call"}"""),
            event(9, "assistant", """{"text":"Found it."}"""),
            event(10, "user", """{"text":"And the long one?"}"""),
            event(11, "thinking", """{"text":"$a","thinkingMs":60000}"""),
            event(12, "thinking", """{"text":"$b","thinkingMs":47000}"""),
            event(13, "thinking", """{"text":"$c"}"""),
            event(14, "assistant", """{"text":"That one was long."}"""),
            event(15, "user", """{"text":"go"}"""))
        // On the stream: words streamed, then the durable block that closes them with the runner's time and no words of its own.
        opening = frame("""{"type":"thinking_delta","seq":0,"payload":{"delta":"weighing whether "}}""") +
            frame("""{"type":"thinking_delta","seq":0,"payload":{"delta":"to go straight to L3"}}""") +
            frame("""{"type":"thinking","seq":16,"payload":{"text":"","thinkingMs":4200}}""")
        openSession(thinking)
        fun labels() = compose.onAllNodesWithTag("thinking-fold").fetchSemanticsNodes()
            .map { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { t -> t.text }.orEmpty() }
        await("the streamed block closed with its time") { labels().any { it == "Thought for 4s · 37 chars" } }
        capture("01-streamed-then-closed")
        scrollTranscriptTo(hasTestTag("event:11"))
        await("three timed blocks of 21k characters") { labels().any { it == "Thought for 1m 47s · 3 blocks · 21k chars" } }
        capture("02-21k-chars")
        scrollTranscriptTo(hasTestTag("event:2"))
        await("the first turn's reasoning") { labels().any { it == "Thought for 1m 47s · 3 blocks · 20 chars" } }
        verify("a block the runner did not time states its size alone", labels().any { it == "Thought · 14 chars" })
        val fold = hasTestTag("thinking-fold") and hasText("Thought for 1m 47s · 3 blocks · 20 chars")
        verify("it starts folded", compose.onAllNodes(fold).fetchSemanticsNodes().first().config.getOrNull(SemanticsProperties.StateDescription) == "Collapsed")
        verify("its words are not drawn folded", !exists(hasText("second"), unmerged = true))
        capture("03-folded")
        compose.onNode(fold).performClick()
        await("a tap opens it on its blocks") { listOf("first", "second", "third").all { exists(hasText(it), unmerged = true) } }
        capture("04-opened")
        compose.onNode(fold).performClick()
        await("a second tap folds it") { !exists(hasText("second"), unmerged = true) }
    }

    /** A06-10, while streaming: the reasoning being written is open, bounded at its newest line, and folds and opens on a tap. */
    @Test fun thinkingStillBeingWrittenFoldsOnATap() = journey {
        overlay = mapOf("status" to "\"RUNNING\"", "runState" to "\"RUNNING\"")
        events = listOf(event(1, "user", """{"text":"Plan the release"}"""))
        opening = (1..40).joinToString("") { frame("""{"type":"thinking_delta","seq":0,"payload":{"delta":"Step $it of weighing the options.\n\n"}}""") }
        openSession(live)
        val fold = hasTestTag("thinking-fold") and hasText("Thinking…")
        await("the reasoning being written") { exists(fold) && exists(hasTestTag("thinking-live"), unmerged = true) }
        verify("it starts open", compose.onAllNodes(fold).fetchSemanticsNodes().first().config.getOrNull(SemanticsProperties.StateDescription) == "Expanded")
        await("it shows its newest line") { exists(hasText("Step 40 of weighing the options.", substring = true), unmerged = true) }
        verify("its box is bounded at the newest line (Step 1 is scrolled away)", runCatching {
            compose.onNode(hasText("Step 1 of weighing the options.", substring = true) and hasAnyAncestor(hasTestTag("thinking-live")), useUnmergedTree = true).assertIsNotDisplayed()
        }.isSuccess)
        capture("01-streaming-open")
        compose.onNode(fold).performClick()
        await("a tap folds it while it streams") { !exists(hasTestTag("thinking-live"), unmerged = true) }
        verify("folded", compose.onAllNodes(fold).fetchSemanticsNodes().first().config.getOrNull(SemanticsProperties.StateDescription) == "Collapsed")
        capture("02-streaming-folded")
        compose.onNode(fold).performClick()
        await("another tap opens it again") { exists(hasTestTag("thinking-live"), unmerged = true) }
        capture("03-streaming-open-again")
    }

    /** A06-13: a pinned reader follows a card that grows under a still list; a reader who scrolled away stays put. */
    @Test fun aPinnedTailFollowsRowsThatGrowAndAScrolledReaderStaysPut() = journey {
        events = (1..24).map { event(it, if (it % 2 == 1) "user" else "assistant", """{"text":"Message $it"}""") } + listOf(
            event(25, "tool_use", """{"id":"toolu_first","name":"Agent","input":{"description":"First survey","subagent_type":"Explore","run_in_background":true}}"""),
            event(26, "tool_result", """{"toolUseId":"toolu_first","content":"Async agent launched successfully. agentId: a25 (internal ID - do not mention to user.)"}"""),
            event(27, "assistant", """{"text":"Waiting on the agents."}"""),
            event(28, "tool_use", """{"id":"toolu_second","name":"Agent","input":{"description":"Second survey","subagent_type":"Explore","run_in_background":true}}"""),
            event(29, "tool_result", """{"toolUseId":"toolu_second","content":"Async agent launched successfully. agentId: a28 (internal ID - do not mention to user.)"}"""))
        openSession(pinned)
        // How far the tail spacer's bottom sits above the list's: constant while the reader is pinned (the list's own padding).
        fun gap(): Float? { val tail = bottom("transcript-tail") ?: return null; return compose.onNodeWithTag("transcript-list").fetchSemanticsNode().boundsInRoot.bottom - tail }
        await("pinned at the tail") { gap() != null }
        settle()
        val pinnedGap = gap()!!
        note("pinned: the tail spacer ends $pinnedGap px above the list's bottom")
        val first = """{"toolUseId":"toolu_first","status":"running","progress":{"toolUseId":"toolu_first","lastToolName":"Read","usage":{"totalTokens":900,"toolUses":3,"durationMs":4000}}}"""
        background = "[$first]"
        refreshed()
        await("the first agent's card grows") { exists(hasText("Read · 3 tool calls"), unmerged = true) }
        await("and the pinned tail follows it") { gap()?.let { kotlin.math.abs(it - pinnedGap) <= 1f } == true }
        note("after the card grew: ${gap()} px")
        verify("no jump row while pinned", !exists(hasTestTag("transcript-jump")))
        capture("01-pinned-follows")
        list().performTouchInput { swipeDown(startY = centerY, endY = centerY + 40.dp.toPx(), durationMillis = 1_000) }
        await("the reader scrolled away") { exists(hasTestTag("transcript-jump")) }
        settle()
        val before = top("event:27")
        background = """[$first,{"toolUseId":"toolu_second","status":"running","progress":{"toolUseId":"toolu_second","lastToolName":"Grep","usage":{"totalTokens":900,"toolUses":3,"durationMs":4000}}}]"""
        refreshed()
        await("the second agent's card grows") { exists(hasText("Grep · 3 tool calls"), unmerged = true) }
        settle()
        val after = top("event:27")
        verify("a reader who scrolled stays put ($before → $after)", before != null && after != null && kotlin.math.abs(after - before) <= 1f)
        capture("02-scrolled-reader-stays")
    }

    /** A06-14: Merge waits while a turn is active — a send in flight, running sub-agents, a pending turn — and an ended session holds nothing. */
    @Test fun theWorktreeTurnGateHoldsMergeWhileWorkIsInFlight() = journey {
        val base = mapOf("isolationStatus" to "\"worktree\"", "branch" to "\"orbit/a06c-worktree-85cfd1\"", "worktreeDirty" to "false",
            "mergeTargets" to """["main","develop"]""", "changedFiles" to """[{"path":"src/reader/Bar.kt","additions":12,"deletions":3,"status":"M"}]""")
        overlay = base
        events = listOf(event(1, "user", """{"text":"Fix the bar"}"""), event(2, "assistant", """{"text":"Committed the fix."}"""))
        openSession(gate)
        val merge = hasText("Merge to main") and hasClickAction()
        await("an idle worktree offers Merge") { exists(merge) }
        capture("01-merge-offered")
        overlay = base + ("runningSubagents" to """["toolu_agent"]""")
        refreshed(); await("running sub-agents hold it") { !exists(merge) }
        capture("02-held-by-subagents")
        overlay = base + ("status" to "\"PENDING\"") + ("runState" to "\"PENDING\"")
        refreshed(); await("a pending turn holds it") { !exists(merge) }
        overlay = base + ("status" to "\"SUCCEEDED\"") + ("runState" to "\"SUCCEEDED\"") + ("runningSubagents" to """["toolu_agent"]""")
        refreshed(); await("an ended session holds nothing") { exists(merge) }
        capture("03-ended-offers-merge")
        overlay = base
        refreshed(); await("idle again") { exists(merge) }
        // A send in flight: the fixture holds the POST for six seconds.
        holdSendSeconds = 6
        compose.onNodeWithTag("composer-input").performTextReplacement("Run the checks before merging")
        dropFocus()
        await("the bar is back once the field lets go") { exists(hasTestTag("worktree-bar")) }
        compose.onNodeWithTag("composer-send").performSemanticsAction(SemanticsActions.OnClick)
        await("the send is in flight", 10_000) { calls.any { it == "POST sessions/$gate/turns" } }
        verify("while it is, Merge waits", !exists(merge))
        capture("04-held-by-a-send")
        await("once it lands, Merge is offered again", 30_000) { exists(merge) }
        holdSendSeconds = 0
    }

    /** A06-15: an answered AskUserQuestion is a question-and-answer record that replays its options. */
    @Test fun anAnsweredQuestionToolCardIsARecord() = journey {
        val q = "On iPad, what should a swipe right from the left edge do? Today there are two places on the iPad where the swipe does nothing: (1) the hidden sidebar only opens from the toolbar button; (2) the in-column pages with a Back button (a folder's page, a project's sessions page, a task opened over its project, a runner's engine or name page) only go back from that button. On the iPhone the same swipe opens the drawer on a list page and goes back on a pushed page."
        events = listOf(
            event(1, "user", """{"text":"Make the iPad swipe work"}"""),
            event(2, "tool_use", """{"id":"toolu_q2","name":"AskUserQuestion","input":{"questions":[{"question":${quote(q)},"header":"Swipe right","multiSelect":false,
                "options":[{"label":"Both, like the iPhone (Recommended)","description":"On a list page, swiping right from the screen's left edge opens the sidebar (swiping left on it closes it). On an in-column page with a Back button, swiping right from that column's left edge goes back one page."},
                {"label":"Open the sidebar only","description":"Swiping right from the screen's left edge opens the sidebar; going back still uses only the Back button."},
                {"label":"Swipe back only","description":"On an in-column page with a Back button, swiping right goes back; the sidebar still opens only from the toolbar button."}]}]}}"""),
            event(3, "tool_result", """{"toolUseId":"toolu_q2","content":${quote("The user answered: \"$q\"=\"Both, like the iPhone (Recommended)\". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.")},"isError":false}"""),
            event(4, "assistant", """{"text":"Both, then."}"""))
        openSession(asked)
        scrollTranscriptTo(hasTestTag("event:2"))
        val card = hasAnyAncestor(hasTestTag("event:2"))
        await("the record") { exists(hasTestTag("question-record") and card, unmerged = true) }
        verify("it says what was chosen", exists(card and hasText("Both, like the iPhone (Recommended)"), unmerged = true))
        verify("one picked circle", count(hasTestTag("circle-picked") and card, unmerged = true) == 1)
        verify("no tool-call words", listOf("Complete", "Failed", "Output").none { exists(card and hasText(it), unmerged = true) })
        capture("01-question-record")
        compose.onNode(hasTestTag("question-record") and card, useUnmergedTree = true).performClick()
        await("the replay of its options") { exists(hasTestTag("question-replay"), unmerged = true) }
        verify("every option, the chosen one picked", exists(hasText("Open the sidebar only"), unmerged = true) && exists(hasText("Swipe back only"), unmerged = true) &&
            count(hasTestTag("circle-picked") and card, unmerged = true) == 1 && count(hasTestTag("circle") and card, unmerged = true) == 2)
        capture("02-question-replay")
    }

    /** A06-17: a folded running agent card says what its sub-agent is on; once it is done, the line goes. */
    @Test fun aRunningAgentsFoldedCardShowsItsSubagentsLatestStep() = journey {
        events = listOf(
            event(1, "user", """{"text":"Survey the reader"}"""),
            event(2, "tool_use", """{"id":"toolu_busy","name":"Agent","input":{"description":"Survey","subagent_type":"Explore","run_in_background":true}}"""),
            event(3, "tool_result", """{"toolUseId":"toolu_busy","content":"Async agent launched successfully. agentId: a2 (internal ID - do not mention to user.)"}"""),
            event(4, "tool_use", """{"id":"toolu_read","name":"Read","parentToolUseId":"toolu_busy","input":{"file_path":"/repo/src/android/app/SessionReader.kt"}}"""),
            event(5, "tool_result", """{"toolUseId":"toolu_read","parentToolUseId":"toolu_busy","content":"package io.orbitd"}"""),
            event(6, "tool_use", """{"id":"toolu_quiet","name":"Agent","input":{"description":"Second survey","subagent_type":"Explore","run_in_background":true}}"""),
            event(7, "tool_result", """{"toolUseId":"toolu_quiet","content":"Async agent launched successfully. agentId: a6 (internal ID - do not mention to user.)"}"""),
            event(8, "assistant", """{"text":"Both agents are running."}"""))
        fun progress(id: String, tool: String) = """{"toolUseId":"$id","status":"running","progress":{"toolUseId":"$id","lastToolName":"$tool","usage":{"totalTokens":900,"toolUses":3,"durationMs":4000}}}"""
        background = "[${progress("toolu_busy", "Read")},${progress("toolu_quiet", "Grep")}]"
        openSession(agents)
        scrollTranscriptTo(hasTestTag("event:2"))
        await("the busy agent's live line") { textOf("subagent-live-line") == "Read SessionReader.kt" ||
            compose.onAllNodes(hasTestTag("subagent-live-line") and hasAnyAncestor(hasTestTag("event:2")), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        verify("it names the sub-agent's latest step", compose.onAllNodes(hasTestTag("subagent-live-line") and hasAnyAncestor(hasTestTag("event:2")), useUnmergedTree = true)
            .fetchSemanticsNodes().first().config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text } == "Read SessionReader.kt")
        capture("01-live-line")
        scrollTranscriptTo(hasTestTag("event:6"))
        verify("the quiet agent has no live line", !exists(hasTestTag("subagent-live-line") and hasAnyAncestor(hasTestTag("event:6")), unmerged = true))
        verify("it says its own progress", exists(hasText("Grep · 3 tool calls") and hasAnyAncestor(hasTestTag("event:6")), unmerged = true))
        capture("02-quiet-agent")
        background = "[]"
        refreshed()
        await("once done, no live line anywhere") { !exists(hasTestTag("subagent-live-line"), unmerged = true) }
        capture("03-done")
    }

    /** A06-21: an interrupt the runner's restart caused says so; one the reader asked for says Interrupted. */
    @Test fun anInterruptCausedByARunnerRestartSaysSo() = journey {
        events = listOf(
            event(1, "user", """{"text":"Why was it sent twice?"}"""),
            event(2, "assistant", """{"text":"Reading the delivery path."}"""),
            event(3, "interrupt", """{"requestId":"req-22-1"}"""),
            event(4, "turn_end", """{"subtype":"interrupted"}"""),
            event(5, "user", """{"text":"Carry on."}"""),
            event(6, "assistant", """{"text":"Back on the delivery path."}"""),
            event(7, "interrupt", """{"reason":"runner_restart"}"""))
        openSession(interrupts)
        await("the restart's interrupt") { exists(hasAnyAncestor(hasTestTag("event:7")) and hasText("Interrupted — the runner restarted"), unmerged = true) }
        scrollTranscriptTo(hasTestTag("event:3"))
        verify("the asked-for interrupt says Interrupted", exists(hasAnyAncestor(hasTestTag("event:3")) and hasText("Interrupted"), unmerged = true))
        verify("no payload is drawn", listOf("req-22-1", "runner_restart", "{\"reason\"", "{\"requestId\"").none { exists(hasText(it, substring = true), unmerged = true) })
        capture("01-interrupts")
    }

    /** A06-22: the merge recovery's review follows the repair session — running, checked, finished, failed — to an already-landed end. */
    @Test fun theMergeRecoveryReviewFollowsTheRepairLoop() = journey {
        val base = mapOf("isolationStatus" to "\"worktree\"", "branch" to "\"orbit/a06c-worktree-85cfd1\"", "worktreeDirty" to "false",
            "mergeTargets" to """["main","develop"]""", "changedFiles" to """[{"path":"src/AgentsModel.swift","additions":4,"deletions":1,"status":"M"}]""",
            "mergeRecoverySupported" to "true", "mergeRepairTurnEndedAt" to "null")
        val conflict = """{"code":"CONFLICT","targetBranch":"main","previewId":"5971aa","phase":"SOURCE_REPLAY","repairBranch":"orbit/recovery/5971aa",
            "repairWorktree":"/w/recovery-5971aa","conflicts":["src/AgentsModel.swift"],"checkedAt":"${ago(2)}"}"""
        fun repairRun(state: String, error: String? = null) = """{"id":"$repairSession","title":"Resolve merge recovery for main","runState":"$state",
            "lastTurnAt":"${ago(3)}","finishedAt":null,"lastAssistantText":null,"error":${error?.let(::quote) ?: "null"}}"""
        fun step(status: String, repair: String, recovery: String = conflict) = base + mapOf("mergeStatus" to "\"$status\"",
            "mergeRecoveryAction" to "\"preview\"", "mergeRecovery" to recovery, "mergeRepairSession" to repair)
        overlay = step("conflict", repairRun("RUNNING"))
        events = listOf(event(1, "user", """{"text":"Merge it"}"""), event(2, "assistant", """{"text":"The merge conflicts with main."}"""))
        openSession(repair)
        await("the bar's recovery row") { exists(hasText("Your changes conflict with the synchronized target", substring = true), unmerged = true) }
        compose.onNode(hasText("Your changes conflict with the synchronized target", substring = true) and hasClickAction()).performClick()
        await("step 1: the repair session runs") { exists(hasText("Repair session running"), unmerged = true) }
        verify("it can be opened, and nothing is checked yet", exists(hasText("Open repair session") and isEnabled()) && !exists(hasText("Check again")))
        capture("01-repair-running")
        overlay = step("pending", repairRun("AWAITING_INPUT")); refreshed()
        await("step 2: its result is checked") { exists(hasText("Checking the repair…"), unmerged = true) }
        verify("the check cannot be pressed again", exists(hasText("Checking…") and isNotEnabled()))
        capture("02-checking")
        overlay = step("conflict", repairRun("AWAITING_INPUT")); refreshed()
        // Step 2's checking row says "Repair session finished" too: wait for this step's buttons, drawn only once the refresh is (A15 F-47).
        await("step 3: the repair finished, the conflict is still there") { exists(hasText("Repair session finished"), unmerged = true) &&
            exists(hasText("Continue repair") and hasClickAction()) && exists(hasText("Prepare PR candidate")) }
        verify("it offers to continue the repair and to prepare a PR", exists(hasText("Continue repair") and hasClickAction()) && exists(hasText("Prepare PR candidate")))
        capture("03-repair-finished")
        compose.onNode(hasText("Continue repair") and hasClickAction()).performClick()
        await("continuing posts the repair") { bodies.any { it.first == "POST sessions/$repair/merge-repair" &&
            Json.parseToJsonElement(it.second).jsonObject["preparePR"]?.toString() == "false" } }
        overlay = step("pending", repairRun("FAILED", "The model provider rejected the request")); refreshed()
        await("step 4: the repair failed, and why") { exists(hasText("Repair session failed"), unmerged = true) &&
            exists(hasText("The model provider rejected the request", substring = true), unmerged = true) }
        capture("04-repair-failed")
        overlay = step("conflict", repairRun("AWAITING_INPUT"), """{"code":"ALREADY_LANDED","targetBranch":"main","previewId":"1c0ffee",
            "sourceSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","landedCommits":[{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "subject":"Explicit self in the session-list currency closure","author":"coordinator","date":"${ago(60)}",
            "sourceSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}"""); refreshed()
        await("step 5: the work is already on main") { exists(hasText("Already on origin/main") and isHeading(), unmerged = true) }
        verify("it names the commit that landed it", exists(hasText("Explicit self in the session-list currency closure", substring = true), unmerged = true))
        capture("05-already-landed")
        compose.onNode(hasText("Done") and hasClickAction() and isEnabled()).performClick()
        await("Done confirms it landed") { bodies.any { it.first == "POST sessions/$repair/merge" && Json.parseToJsonElement(it.second).jsonObject.let { b ->
            b["recoveryAction"]?.toString() == "\"confirm-landed\"" && b["previewId"]?.toString() == "\"1c0ffee\"" } } }
        overlay = base.filterKeys { it != "mergeRepairTurnEndedAt" } + ("mergeStatus" to "\"merged\"") + ("mergeTarget" to "\"main\""); refreshed()
        await("the review closes on the merge") { !exists(hasText("Done") and hasClickAction()) &&
            exists(hasText("✓ Merged", substring = true) and hasAnyAncestor(hasTestTag("worktree-bar")), unmerged = true) }
        capture("06-merged")
    }

    /** A04-1: a dropped stream closes its gap over REST `after=` pages before the stream opens again, and every missed event lands once. */
    @Test fun aReconnectFillsTheGapOverRestBeforeTheStream() = journey {
        events = listOf(event(1, "user", """{"text":"Start the export"}"""), event(2, "assistant", """{"text":"Exporting."}"""),
            event(3, "assistant", """{"text":"Half done."}"""))
        openSession(gap)
        await("the stream connected") { connected() }
        val mark = timed.size
        // What happened while the stream was down: three events the stream never sends.
        events = events + listOf(event(4, "assistant", """{"text":"Three quarters done."}"""),
            event(5, "assistant", """{"text":"Export finished."}"""), event(6, "turn_end", """{"subtype":"success"}"""))
        reconnect()
        await("the stream connected again") { connected() && timed.drop(mark).any { it.second.startsWith("GET sessions/$gap/events?sinceSeq=") } }
        val after = timed.drop(mark)
        val catchUp = after.indexOfFirst { it.second.startsWith("GET sessions/$gap/events/page?") && "after=3" in it.second }
        val stream = after.indexOfFirst { it.second.startsWith("GET sessions/$gap/events?sinceSeq=") }
        note("after the drop: ${after.joinToString(" | ") { it.second }}")
        verify("the gap is read over REST from seq 3 (${after.getOrNull(catchUp)?.second})", catchUp >= 0)
        verify("before the stream opens again", catchUp in 0 until stream)
        verify("and the stream resumes past it (${after[stream].second})", "sinceSeq=6" in after[stream].second)
        await("the missed events are drawn") { exists(hasText("Export finished."), unmerged = true) }
        verify("each once", listOf("Three quarters done.", "Export finished.").all { count(hasText(it) and hasAnyAncestor(hasTestTag("transcript-list")), unmerged = true) == 1 })
        capture("01-gap-filled")
    }
}
