package io.orbitd.android.increments

import androidx.compose.ui.test.*
import io.orbitd.android.core.schedule.ScheduleCopy
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import okhttp3.mockwebserver.MockResponse
import org.junit.Test

/**
 * Scheduled tasks on the phone (docs/mocks/scheduled-tasks/01-board.png ① ② ③ ④ ⑥, 02-agent-first.png ① ③), against a fixture shaped
 * like the boards' demo rows: the drawer's Scheduled row and its count, the timeline, a row's detail sheet, the create card in the
 * conversation that asked it (Create sends the device's zone), and Waiting on you's schedule cards. Each step leaves a screenshot under
 * files/a15c/ScheduledDeviceTest/<test>.
 */
class ScheduledDeviceTest : IncrementDeviceTest() {
    private val conversation = "34A1SchedConversation1"
    private val nightly = "34A1SchedNightlySweep1"
    private val audit = "34A1SchedWeeklyAudit01"
    private val docs = "34A1SchedDocsLinkChk01"
    private val notes = "34A1SchedReleaseNotes1"
    private val codex = "34A1SchedCodexStable01"
    private val claude = "34A1SchedClaudeCliChk1"
    private val cost = "34A1SchedWeeklyCost001"
    private val paused = "34A1SchedPausedRow0001"
    private val card = "34A1SchedCreateCard001"
    private val failedItem = "34A1SchedWaitFailed001"
    private val heldItem = "34A1SchedWaitHeld00001"
    private val changeChat = "34A1SchedChangeChat001"
    private val envelopeCard = "34A1SchedEnvelopeCard1"
    private val runSession = "34A1SchedRunSession001"
    override val ids get() = listOf(conversation, nightly, audit, docs, notes, codex, claude, cost, paused, card, failedItem, heldItem, changeChat, envelopeCard, runSession, workspace, runner)

    private val zone = ZoneId.systemDefault()
    private val today get() = ZonedDateTime.now(zone).truncatedTo(ChronoUnit.DAYS)
    /** A slot [days] from today at [hour]:[minute], in the device's zone: the timeline's days are the viewer's. */
    private fun at(days: Long, hour: Int, minute: Int = 0) = today.plusDays(days).withHour(hour).withMinute(minute).toInstant().toString()
    /** Today's slot if it is still to come, else tomorrow's, so the Today group has rows whatever time the test runs. */
    private fun laterToday(hour: Int) = if (ZonedDateTime.now(zone).hour < hour) at(0, hour) else at(0, 23, 50)

    private fun rule(kind: String, time: String, vararg days: String) = if (kind == "WEEKLY")
        """{"kind":"WEEKLY","time":"$time","weekdays":[${days.joinToString(",") { "\"$it\"" }}]}""" else """{"kind":"$kind","time":"$time"}"""

    private fun schedule(id: String, title: String, rule: String, ws: String, next: String?, state: String = "ACTIVE", failures: Int = 0,
        held: String? = null, access: String = "CHECK_ONLY", lastRun: String? = null, intent: String = "", note: String? = null,
        agent: String? = null, pausedAt: String? = null) = """{"id":"$id","title":"$title","intent":${quote(intent)},"prompt":"",
        "rule":$rule,"timezone":"Asia/Shanghai","workspaceId":"$workspace","workspaceName":"$ws","agentId":"a1",
        ${agent?.let { "\"agentName\":\"$it\"," } ?: ""}"engine":"codex","accessLevel":"$access","runLimitMinutes":30,"runsPerWeek":7,
        "envelope":{"workspaceId":"$workspace","accessLevel":"$access","runsPerWeek":7,"runLimitMinutes":30},"state":"$state",
        "heldReason":${held?.let { "\"$it\"" } ?: "null"},"endedReason":null,"note":${note?.let(::quote) ?: "null"},"revision":3,
        "nextDueAt":${next?.let { "\"$it\"" } ?: "null"},"consecutiveFailures":$failures,"createdAt":"${ago(6000)}",
        "lastRun":${lastRun ?: "null"}${pausedAt?.let { ",\"pausedAt\":\"$it\"" } ?: ""}}"""

    private fun run(id: String, schedule: String, planned: String, state: String, started: String? = null, ended: String? = null,
        summary: String? = null, failure: String? = null, session: String? = null, key: String? = null, newFinding: Boolean? = null,
        notified: Boolean? = null) = """{"id":"$id","scheduleId":"$schedule","scheduleRevision":3,"plannedAt":"$planned",
        "trigger":"SCHEDULED","state":"$state","attempt":1,"startedAt":${started?.let { "\"$it\"" } ?: "null"},
        "endedAt":${ended?.let { "\"$it\"" } ?: "null"},"sessionId":${session?.let { "\"$it\"" } ?: "null"},"key":${key?.let { "\"$it\"" } ?: "null"},
        "summary":${summary?.let(::quote) ?: "null"},"failureReason":${failure?.let { "\"$it\"" } ?: "null"},"heldReason":null,"reasonText":null
        ${newFinding?.let { ",\"newFinding\":$it" } ?: ""}${notified?.let { ",\"notified\":$it" } ?: ""}}"""

    private val nightlyLast get() = run("r-nightly", nightly, at(0, 2), "FAILED", at(0, 2), at(0, 2, 31), failure = "NO_REPORT")
    private val docsRunning get() = run("r-docs", docs, ZonedDateTime.now(zone).minusMinutes(21).toInstant().toString(), "RUNNING",
        ZonedDateTime.now(zone).minusMinutes(21).toInstant().toString())

    private fun schedules() = listOf(
        schedule(nightly, "Nightly pg spec sweep", rule("DAILY", "02:00"), "apiserver", at(1, 2), failures = 3, lastRun = nightlyLast),
        schedule(audit, "Weekly dependency audit", rule("WEEKLY", "09:00", "MON"), "apiserver", at(3, 9), state = "HELD", held = "AGENT_DISABLED",
            agent = "auditor"),
        schedule(docs, "Docs link check", rule("DAILY", "12:00"), "web", at(1, 12)),
        schedule(notes, "Release notes draft", rule("WEEKLY", "17:00", "FRI"), "Orbit baseline", laterToday(17)),
        schedule(codex, "Codex stable check", rule("DAILY", "09:00"), "apiserver", at(1, 9), access = "OPEN_PR",
            intent = "Every day at 10:00 Beijing time, check the latest stable Codex against the version the apiserver pins. Stay quiet if nothing changed; if there is a new version, tell me the number and the release notes.",
            note = "Release notes moved to github.com/openai/codex/releases. The old changelog URL is 404.",
            lastRun = run("r-codex", codex, at(0, 10), "CHANGED", at(0, 10), at(0, 10, 4), "0.49.0 again", key = "codex@0.49.0", newFinding = false)),
        schedule(claude, "Claude CLI version check", rule("DAILY", "10:30"), "apiserver", at(1, 10, 30)),
        schedule(cost, "Weekly cost report", rule("WEEKLY", "10:00", "MON"), "Orbit baseline", at(3, 10)),
        schedule(paused, "Staging smoke test", rule("DAILY", "08:00"), "web", null, state = "PAUSED", pausedAt = ago(60 * 24 * 2)),
    )

    private fun detail(id: String): String {
        if (id != codex) return """{"schedule":${schedules().first { it.contains("\"id\":\"$id\"") }},"recentRuns":[],"findings":[],"history":[],"pendingCards":[]}"""
        val s = schedules().first { it.contains("\"id\":\"$codex\"") }
        return """{"schedule":$s,"readBack":null,"lastRun":null,
            "recentRuns":[${run("r-codex", codex, at(0, 10), "CHANGED", at(0, 10), at(0, 10, 4), "0.49.0 again · linked PR #831", key = "codex@0.49.0", session = "34A1SchedRunSession001")},
              ${run("r-codex-0", codex, at(-1, 10), "CHANGED", at(-1, 10, 1), at(-1, 10, 6), "New 0.49.0 · notified", key = "codex@0.49.0", session = "34A1SchedRunSession002")}],
            "findings":[{"key":"codex@0.49.0","summary":"0.49.0","firstRunId":"r-codex-0","lastSeenRunId":"r-codex","notifiedAt":"${at(-1, 10, 6)}","baseline":false,"createdAt":"${at(-1, 10, 6)}"}],
            "usage":{"since":"${at(-13, 0)}","runs":14,"minutes":41},
            "history":[{"scheduleId":"$codex","title":"Codex stable check","revision":3,"changedBy":"SESSION","sessionId":"$conversation",
              "before":{"rule":${rule("DAILY", "10:00")}},"after":{"rule":${rule("DAILY", "09:00")}},"createdAt":"${at(0, 12, 19)}",
              "undo":{"path":"/schedules/$codex/undo","body":{"revision":3}}}],
            "pendingCards":[]}"""
    }

    private fun listJson() = """{"schedules":[${schedules().joinToString(",")}],"runs":[$nightlyLast,$docsRunning]}"""

    private var created = false
    private fun createCard() = """{"id":"$card","kind":"CREATE","state":"${if (created) "ALLOWED" else "PENDING"}","askedBy":"SESSION",
        "askedBySessionId":"$conversation","scheduleId":null,"createdAt":"${ago(2)}","title":"Codex stable check",
        "readBack":"Every day at 10:00 Beijing time I check the latest stable Codex against the version the apiserver pins, and tell you only when there is a new one.",
        "intent":"Check Codex stable against our pinned version every day at 10","when":{"rule":${rule("DAILY", "10:00")},"timezone":"Asia/Shanghai","firstRunAt":"${at(1, 2)}"},
        "runsIn":{"workspaceId":"$workspace","workspaceName":"apiserver","engine":"codex"},"may":{"accessLevel":"CHECK_ONLY"},
        "costs":{"runsPerWeek":7,"runLimitMinutes":30},"today":{"key":"codex@0.48.0","summary":"Codex 0.48.0, same as pinned. Nothing to report."},
        "notice":"You'll hear about new versions and failures only.","proposed":null,"envelope":null}"""

    private fun conversationDetail() = """{"id":"$conversation","title":"Codex release watch","status":"AWAITING_INPUT","runState":"AWAITING_INPUT",
        "lifecycleState":"OPEN","provider":"codex","engine":"codex","model":"gpt-5-codex","assignedRunnerId":"$runner","agentId":"$workspace",
        "agent":{"id":"$workspace","name":"Alpha"},"createdAt":"${ago(10)}","lastTurnAt":"${ago(2)}","pendingApprovals":0,
        "lastAssistantText":"I checked just now.","capabilities":{"canSend":true,"canComplete":true},"tags":[]}"""
    private fun events() = listOf(
        event(1, "user", """{"text":"Every day at 10:00 Beijing time, check the latest stable Codex against the version the apiserver pins. Stay quiet if nothing changed; if there is a new version, tell me the number and the release notes."}""", ago(4), "t-1"),
        event(2, "assistant", """{"text":"I checked just now: the latest stable Codex is 0.48.0 and the apiserver pins 0.48.0, so there is nothing to report today. I can do this every morning; closing this chat won't stop it."}""", ago(3), "t-1"),
        event(3, "turn_end", """{"subtype":"success"}""", ago(3), "t-1"),
    )

    private fun waitingItems() = """{"requests":[
        {"id":"$failedItem","kind":"SCHEDULE_FAILED","state":"PENDING","title":"Nightly pg spec sweep failed","why":"","scheduleId":"$nightly",
         "scheduleRunId":"r-nightly","createdAt":"${at(0, 2, 41)}"},
        {"id":"$heldItem","kind":"SCHEDULE_HELD","state":"PENDING","title":"Weekly dependency audit is held","why":"","scheduleId":"$audit",
         "createdAt":"${ago(60 * 24 * 4)}"}]}"""

    /** Board 01 ⑤: a conversation that moved the time (a change inside the envelope, with its Undo) and asked to open PRs (a card). */
    private fun changeDetail() = conversationDetail().replace(conversation, changeChat).replace("Codex release watch", "Codex release watch (change)")
    private fun changeEvents() = listOf(
        event(1, "user", """{"text":"Move it to 9 in the morning. Also, when there's a new version, open the upgrade PR directly."}""", ago(4), "t-1"),
        event(2, "assistant", """{"text":"Done: it now runs at 09:00. Opening a PR needs more access than it has, so that part waits for you."}""", ago(3), "t-1"),
        event(3, "turn_end", """{"subtype":"success"}""", ago(3), "t-1"),
    )
    private fun lines(access: String) = """{"runsIn":{"workspaceId":"$workspace","workspaceName":"apiserver","engine":"codex"},
        "may":{"accessLevel":"$access"},"costs":{"runsPerWeek":7,"runLimitMinutes":30}}"""
    private fun changeCards() = """{"run":null,"cards":[{"id":"$envelopeCard","kind":"UPDATE","state":"PENDING","askedBy":"SESSION",
        "askedBySessionId":"$changeChat","scheduleId":"$codex","createdAt":"${ago(2)}","title":"Codex stable check",
        "proposed":{"accessLevel":"OPEN_PR"},"envelope":{"widens":["ACCESS_LEVEL"],"now":${lines("CHECK_ONLY")},"asked":${lines("OPEN_PR")}}}],
        "records":[{"scheduleId":"$codex","title":"Codex stable check","revision":4,"changedBy":"SESSION","sessionId":"$changeChat",
          "before":{"rule":${rule("DAILY", "10:00")}},"after":{"rule":${rule("DAILY", "09:00")}},"createdAt":"${ago(3)}",
          "undo":{"path":"/schedules/$codex/undo","body":{"revision":4}}}]}"""

    /** A run's session shows its strip, what it said, and its report. */
    private val runPlanned get() = ago(12)
    private fun runDetail() = conversationDetail().replace(conversation, runSession).replace("Codex release watch", "Codex stable check")
        .replace("\"tags\":[]", "\"tags\":[],\"scheduleRunId\":\"r-run\",\"runSource\":\"SCHEDULE\"")
    private fun runEvents() = listOf(
        event(1, "assistant", """{"text":"The latest stable Codex is 0.49.0, released Nov 12. The apiserver pins 0.48.0.\n\n- Turn steering now covers tool calls\n- Fixes the sandbox path bug on macOS\n- No breaking flag changes"}""", ago(9), "t-run"),
        event(2, "turn_end", """{"subtype":"success"}""", ago(8), "t-run"),
    )
    private fun runCards() = """{"run":${run("r-run", codex, runPlanned, "CHANGED", ago(11), ago(7), "Codex 0.49.0 is out (pinned 0.48.0). You were notified.",
        session = runSession, key = "codex@0.49.0", newFinding = true, notified = true)},"cards":[],"records":[]}"""

    override fun sessions(view: String, project: String?) = if (view == "open") "[${conversationDetail()}]" else "[]"

    override fun answer(req: Req): MockResponse? = when {
        req.path == "schedules" && req.method == "GET" -> json(listJson())
        req.path == "schedules/drafts" && req.method == "GET" -> json("""{"drafts":[]}""")
        req.parts.size == 2 && req.parts[0] == "schedules" && req.method == "GET" -> json(detail(req.parts[1]))
        req.path == "schedule-requests/$card/allow" -> { created = true; json("""{"outcome":"ALLOWED","card":${createCard()}}""") }
        req.path == "schedule-requests/$card" -> json(createCard())
        req.path == "sessions/$conversation/schedule-cards" -> json("""{"run":null,"cards":[${createCard()}],"records":[]}""")
        req.path == "sessions/$conversation" && req.method == "GET" -> json(conversationDetail())
        req.path == "sessions/$conversation/events/page" -> json(page(events()))
        req.path == "owner-requests" && req.q("state") == "open" -> json(waitingItems())
        req.path == "owner-requests" -> json("""{"requests":[]}""")
        req.path == "sessions/$changeChat/schedule-cards" -> json(changeCards())
        req.path == "sessions/$changeChat" && req.method == "GET" -> json(changeDetail())
        req.path == "sessions/$changeChat/events/page" -> json(page(changeEvents()))
        req.path == "sessions/$runSession/schedule-cards" -> json(runCards())
        req.path == "sessions/$runSession" && req.method == "GET" -> json(runDetail())
        req.path == "sessions/$runSession/events/page" -> json(page(runEvents()))
        req.path.endsWith("/schedule-cards") -> json("""{"run":null,"cards":[],"records":[]}""")
        else -> null
    }

    private fun openScheduled() {
        signIn()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        awaitTag("drawer:scheduled")
        await("the drawer's count of schedules that need you") { textOf("scheduled-drawer-count") == "2" }
        capture("0-drawer")
        compose.onNodeWithTag("drawer:scheduled").performClick()
        await("the timeline") { exists(hasTestTag("scheduled-page")) && exists(hasText("Nightly pg spec sweep"), unmerged = true) }
    }

    /** Board 01 ② (+ ① in the drawer): Today, Tomorrow, the days, Paused (no Needs you group, owner 2026-11-19: a failing row is
     * tagged on its day, a held one leads Paused); the phone's one-line grammar; the line at the end. */
    @Test fun theTimeline() = journey {
        openScheduled()
        verify("there is no Needs you group", !exists(hasText("Needs you"), unmerged = true))
        verify("the failing row says Failed 3 in a row", exists(hasText("Failed 3 in a row"), unmerged = true))
        verify("the held row says why in a few words", exists(hasText("↻ Mondays 09:00 · agent disabled"), unmerged = true))
        verify("the running row says how long", exists(hasText("running 21 min", substring = true), unmerged = true) ||
            exists(hasText("running 20 min", substring = true), unmerged = true) || exists(hasText("running 22 min", substring = true), unmerged = true))
        verify("Open a PR is the only access a row names", exists(hasText("↻ Daily 09:00 · apiserver · Open a PR"), unmerged = true))
        verify("the title counts what is listed", textOf("scheduled-count") == "8")
        capture("1-timeline")
        compose.onNodeWithTag("scheduled-page").performScrollToNode(hasTestTag("schedule-quick-add"))
        verify("the page ends with the line that takes one sentence", exists(hasText(ScheduleCopy.QuickAdd.placeholder), unmerged = true))
        capture("1b-timeline-end")
    }

    /** Board 01 ③ / 02 ③: the detail sheet from the bottom. */
    @Test fun theDetailSheet() = journey {
        openScheduled()
        compose.onNodeWithTag("scheduled-page").performScrollToNode(hasText("Codex stable check"))
        compose.onAllNodes(hasText("Codex stable check"), useUnmergedTree = true).onFirst().performClick()
        await("the detail sheet") { exists(hasTestTag("schedule-detail-panel")) && exists(hasText("14 runs · 41 min"), unmerged = true) }
        verify("Run now, Pause and Change…", listOf(ScheduleCopy.Actions.runNow, ScheduleCopy.Actions.pause, ScheduleCopy.Actions.change)
            .all { exists(hasText(it), unmerged = true) })
        verify("the history's change has its Undo", exists(hasText("Time 10:00 → 09:00"), unmerged = true) && exists(hasText(ScheduleCopy.Actions.undo), unmerged = true))
        verify("Allowed under This month", exists(hasText("Allowed: up to 7 runs a week, 30 min each"), unmerged = true))
        capture("2-detail")
    }

    /** Board 01 ④ / 02 ①: the create card in the conversation that asked; Create sends the device's zone only when the card names none. */
    @Test fun theCreateCardInItsConversation() = journey {
        signIn()
        open("orbit-session:$conversation")
        await("the create card") { exists(hasTestTag("schedule-create-card"), unmerged = true) }
        // The card is the conversation's last thing: at the tail it stands whole above the composer, buttons included.
        atTail()
        verify("When says the rule and the zone", exists(hasText("Daily 10:00 · Asia/Shanghai"), unmerged = true))
        verify("Costs is the envelope's", exists(hasText("Up to 7 runs a week, 30 min each"), unmerged = true))
        verify("the notice is the server's", exists(hasText("You'll hear about new versions and failures only."), unmerged = true))
        capture("3-create-card")
        compose.onNodeWithText(ScheduleCopy.Actions.create, useUnmergedTree = true).performClick()
        await("the press recorded") { bodies.any { it.first.endsWith("schedule-requests/$card/allow") } }
        verify("a card that names its zone sends none", bodies.first { it.first.endsWith("/allow") }.second.let { !it.contains("timezone\":\"") })
        await("the buttons go") { !exists(hasText(ScheduleCopy.Actions.notNow), unmerged = true) }
        capture("3b-created")
    }

    /** The conversation followed to its tail, as a reader who just opened it is: no jump bar, nothing under the composer's fade. */
    private fun atTail() {
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("transcript-tail"))
        settle()
        await("the transcript at its tail") { !exists(hasContentDescription("Jump to latest"), unmerged = true) }
    }

    /** Board 01 ⑤ / 02 ②: the change line (with Undo) and the envelope card in the conversation that asked. */
    @Test fun theEnvelopeCardAndItsChangeLine() = journey {
        signIn()
        open("orbit-session:$changeChat")
        await("the envelope card and the change line") {
            exists(hasTestTag("schedule-envelope-card"), unmerged = true) && exists(hasTestTag("schedule-record-line"), unmerged = true)
        }
        atTail()
        verify("the card asks to open PRs", exists(hasText("Let Codex stable check open PRs?"), unmerged = true))
        verify("Now is the brief", exists(hasText("Check only — reads and reports"), unmerged = true))
        verify("its decline keeps check only", exists(hasText("Keep check only"), unmerged = true))
        verify("the change line says what changed", exists(hasText(": time 10:00 → 09:00", substring = true), unmerged = true))
        capture("5-envelope")
    }

    /** Board 01 ⑦: a run's page. */
    @Test fun aRunsPage() = journey {
        signIn()
        open("orbit-session:$runSession")
        await("the run's strip") { exists(hasTestTag("schedule-run-strip"), unmerged = true) }
        verify("the strip has no schedule breadcrumb", !exists(hasTestTag("schedule-run-crumb"), unmerged = true))
        verify("the session has no run-specific header line", !exists(hasText("Open · Codex agent · 4 min"), unmerged = true))
        await("the report") { exists(hasTestTag("schedule-run-report"), unmerged = true) }
        verify("the report says what it found", exists(hasText("Reported: Changed · codex@0.49.0 · you were notified"), unmerged = true))
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("schedule-run-strip"))
        settle()
        capture("6-run-page")
        atTail()
        capture("6b-run-report")
    }

    /** Board 01 ⑥: the failed and held cards head Waiting on you, whole. */
    @Test fun waitingOnYou() = journey {
        signIn()
        open("orbit://owner-request/${ObjectId.canonical(failedItem)}")
        await("the schedule cards") { exists(hasTestTag("schedule-waiting-SCHEDULE_FAILED")) && exists(hasTestTag("schedule-waiting-SCHEDULE_HELD")) }
        verify("the failure's title counts the runs", exists(hasText("Nightly pg spec sweep failed 3 runs in a row"), unmerged = true))
        verify("the held card names its agent and workspace", exists(hasText("the agent \"auditor\" in workspace apiserver is disabled", substring = true), unmerged = true))
        capture("4-waiting")
    }
}
