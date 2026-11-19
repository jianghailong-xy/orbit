package io.orbitd.android.core.schedule

import java.io.File
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * Conditions on Android (docs/condition-triggers-design.md §9; board docs/mocks/condition-triggers/01-board.png frames 2 to 6, iOS
 * the reference): the wire shapes as the doors send them, and the board's words from them — the same cases as OrbitKit's
 * ConditionDisplayTests, so the two clients draw one board.
 */
class ConditionDisplayTest {
    private val zone = "Asia/Shanghai"
    /** Tue Nov 17 2026, 11:40 in Shanghai. */
    private val now = Instant.parse("2026-11-17T03:40:00Z")

    private fun json(text: String) = Json.parseToJsonElement(text)

    private val guardRule = """
        {"kind":"WHEN","conditionId":"c-guard","runsPerWeek":3,"condition":{"text":"Raw used above 90%",
         "command":"ceph df -f json | jq .stats.total_used_raw_ratio","compare":{"op":"GT","value":90},"holdSeconds":600,
         "rearm":{"op":"LT","value":85},"intervalSeconds":300,"unit":"%","timeoutSeconds":20,"repeatSeconds":null}}
    """

    private fun guardSchedule(state: String = "ACTIVE", conditionState: String = "WAITING"): ScheduleView = ScheduleView.parse(json("""
        {"id":"s-guard","title":"Ceph capacity guard","rule":$guardRule,"timezone":"Asia/Shanghai",
         "workspaceId":"w-hpc","workspaceName":"HPC","accessLevel":"CHECK_ONLY","state":"$state","nextDueAt":null,
         "consecutiveFailures":0,"condition":{"id":"c-guard","text":"Raw used above 90%","unit":"%",
         "state":"$conditionState","lastValue":6.9,"lastSampleAt":"2026-11-17T03:39:00.000Z"}}
    """))!!

    private fun osdTask(state: String = "WAITING") = ScheduleWaitingTask("t-osd", "Set kubernetes pool to 3 copies", "w-hpc", "HPC",
        ScheduleConditionReading("c-osd", "3 or more OSDs are in", "in", state, 2.0, "2026-11-17T03:37:00.000Z"))

    private fun guardCondition() = ConditionView(
        id = "c-guard", workspaceId = "w-hpc", text = "Raw used above 90%", unit = "%",
        command = "ceph df -f json | jq .stats.total_used_raw_ratio",
        compare = ConditionCompare("GT", 90.0), holdSeconds = 600, rearm = ConditionCompare("LT", 85.0), intervalSeconds = 300,
        lastSampleAt = "2026-11-17T03:39:00.000Z", lastValue = 6.9, lastReadAt = "2026-11-17T03:39:00.000Z",
        approvedAt = "2026-11-17T02:00:00.000Z", scheduleId = "s-guard", runnerName = "workstation-gpu",
        events = listOf(
            ConditionEventView("2026-11-22T01:40:00.000Z", "READY_AGAIN", 82.9),
            ConditionEventView("2026-11-20T19:12:00.000Z", "FIRED", 90.4, "r-21"),
        ))

    // The wire

    @Test fun aWhenRuleReadsAndWritesItsCondition() {
        val rule = ScheduleRule.parse(json(guardRule)) as? ScheduleRule.When ?: throw AssertionError("not a WHEN rule")
        assertEquals("c-guard", rule.conditionId)
        assertEquals(3, rule.runsPerWeek)
        assertEquals(ConditionCompare("GT", 90.0), rule.condition.compare)
        assertEquals(85.0, rule.condition.rearm?.value)
        assertNull(rule.time)
        assertEquals(rule, ScheduleRule.parse(rule.toJson()))
    }

    @Test fun theListCarriesTheReadingAndTheWaitingTasks() {
        val list = ScheduleListResponse.parse(json("""
            {"schedules":[{"id":"s-guard","title":"Ceph capacity guard","rule":$guardRule,"workspaceId":"w-hpc",
              "condition":{"id":"c-guard","text":"Raw used above 90%","unit":"%","state":"WAITING","lastValue":6.9,
              "lastSampleAt":"2026-11-17T03:39:00.000Z"}}],
             "runs":[],
             "waitingTasks":[{"id":"t-osd","title":"Set kubernetes pool to 3 copies","workspaceId":"w-hpc",
              "workspaceName":"HPC","condition":{"id":"c-osd","text":"3 or more OSDs are in","unit":"in",
              "state":"WAITING","lastValue":2,"lastSampleAt":"2026-11-17T03:37:00.000Z"}}]}
        """))!!
        assertEquals("a WHEN schedule is no longer dropped", 6.9, list.schedules.first().condition?.lastValue)
        assertEquals(listOf("Set kubernetes pool to 3 copies"), list.waitingTasks?.map { it.title })
        assertNull(ScheduleListResponse.parse(json("""{"schedules":[]}"""))!!.waitingTasks)
    }

    // The Scheduled page (board ④)

    @Test fun theConditionGroupSitsAboveTodayAndCantReadLeadsIt() {
        val daily = ScheduleView.parse(json("""
            {"id":"s-codex","title":"Codex stable check","rule":{"kind":"DAILY","time":"10:00"},"workspaceId":"w-api",
             "workspaceName":"apiserver","nextDueAt":"2026-11-17T06:00:00.000Z"}
        """))!!
        val mon = ScheduleView.parse(json("""
            {"id":"s-mon","title":"Mon disk guard","rule":{"kind":"WHEN","conditionId":"c-mon","runsPerWeek":3,
              "condition":{"text":"Root disk below 5%","command":"df","compare":{"op":"LT","value":5}}},
             "workspaceId":"w-hpc","workspaceName":"HPC","condition":{"id":"c-mon","text":"Root disk below 5%",
              "unit":"%","state":"UNKNOWN","lastValue":5}}
        """))!!
        val groups = ScheduleDisplay.timeline(listOf(daily, guardSchedule(), mon), now = now, timezone = zone, waitingTasks = listOf(osdTask()))
        // No Needs you group (owner 2026-11-19): a condition that cannot be read leads Waiting for a condition.
        assertEquals(listOf("Waiting for a condition", "Today"), groups.map { it.title })
        assertEquals("3", groups[0].subtitle)
        assertEquals("can't read first, then schedules, then tasks", listOf("schedule-s-mon", "schedule-s-guard", "task-t-osd"),
            groups[0].items.map { it.id })
        assertEquals(1, ScheduleDisplay.needsYouCount(listOf(daily, guardSchedule(), mon), listOf(osdTask())))

        val cantRead = ScheduleDisplay.scheduleCircle(mon)
        assertTrue(cantRead.gauge)
        assertEquals("Can't read", cantRead.tag?.text)
        assertEquals(ScheduleDisplay.TagTone.held, cantRead.tag?.tone)
        assertTrue("a gauge in place of the circle", ConditionDisplay.circle(cantRead = false).gauge)

        val taskCantRead = ScheduleDisplay.timeline(emptyList(), now = now, timezone = zone, waitingTasks = listOf(osdTask("UNKNOWN")))
        assertEquals(listOf("Waiting for a condition"), taskCantRead.map { it.title })
        val both = ScheduleDisplay.timeline(listOf(guardSchedule()), now = now, timezone = zone,
            waitingTasks = listOf(osdTask(), osdTask("UNKNOWN").copy(id = "t-unknown", title = "Zz unreadable task")))
        assertEquals("a task that cannot be read leads the readable schedule", listOf("task-t-unknown", "schedule-s-guard", "task-t-osd"),
            both[0].items.map { it.id })
    }

    @Test fun aFailingWhenScheduleStaysInTheConditionGroup() {
        val failing = guardSchedule().copy(consecutiveFailures = 2)
        val groups = ScheduleDisplay.timeline(listOf(failing), now = now, timezone = zone)
        assertEquals(listOf("Waiting for a condition"), groups.map { it.title })
        assertEquals(listOf("schedule-s-guard"), groups[0].items.map { it.id })
        assertEquals(ScheduleDisplay.Circle.failed, ScheduleDisplay.rowCircle(failing, emptyList()).circle)
        assertEquals(1, ScheduleDisplay.needsYouCount(listOf(failing)))
        // A run under way: the plain gauge, and not counted.
        val runs = listOf(ScheduleRunView(id = "r-1", scheduleId = "s-guard", plannedAt = "2026-11-17T03:40:00.000Z", state = "RUNNING"))
        val circle = ScheduleDisplay.rowCircle(failing, runs)
        assertEquals(ScheduleDisplay.Circle.open, circle.circle)
        assertNull(circle.tag)
        assertTrue(circle.gauge)
        assertEquals(0, ScheduleDisplay.needsYouCount(listOf(failing), runs = runs))
    }

    @Test fun aRowShowsTheNewestReadingAndItsAge() {
        assertEquals("6.9% · 1 min ago", ConditionDisplay.rowReading(guardSchedule().condition!!, now)?.text)
        assertEquals("2 in · 3 min ago", ConditionDisplay.rowReading(osdTask().condition, now)?.text)
        assertNull(ConditionDisplay.rowReading(ScheduleConditionReading("c", "x"), now))
        assertEquals("just now", ConditionDisplay.ageText(now.minusSeconds(20), now))
        assertEquals("3 h ago", ConditionDisplay.ageText(now.minusSeconds(3 * 3600), now))
        assertEquals("3 days ago", ConditionDisplay.ageText(now.minusSeconds(3 * 86_400), now))
        assertEquals("90.4%", ConditionDisplay.readingText(90.4, "%"))
        assertEquals("0.07", ConditionDisplay.readingText(0.0691234, null))
        assertEquals("412 GiB", ConditionDisplay.readingText(412.0, "GiB"))
    }

    @Test fun theRowsSayTheirRuleAsTheBoardDoes() {
        assertEquals("When raw used above 90%", ScheduleDisplay.ruleText(guardSchedule().rule, ScheduleDisplay.RuleForm.long))
        assertEquals("Raw used above 90%", ScheduleDisplay.ruleText(guardSchedule().rule, ScheduleDisplay.RuleForm.short))
        assertTrue("↻ on a WHEN rule", ScheduleDisplay.ruleRepeats(guardSchedule().rule))
        assertEquals("Task · once, when 3 or more OSDs are in · HPC", ConditionDisplay.taskRowLine(osdTask()))
    }

    // The inspector (board ⑥ ② ③)

    @Test fun theConditionBlock() {
        val block = ConditionDisplay.conditionBlock(guardCondition(), now)
        assertEquals("6.9%", block.reading)
        assertEquals("checked 1 min ago", block.checked)
        assertEquals("Fires above 90% for 10 min. Ready again below 85%.", block.rule)
        assertNull(block.cantRead)
        assertNull(block.repeat)
        val bar = block.bar!!
        assertEquals(0.069, bar.value, 0.0001)
        assertEquals(0.9, bar.fire, 0.0)
        assertEquals(0.85, bar.rearm!!, 0.0)
        assertEquals("90%", bar.fireLabel)
        assertEquals("85%", bar.rearmLabel)
        assertEquals("And again every 2 hours while it stays that way.", ConditionDisplay.repeatText(7200))
        assertEquals("Fires at 3 in or more.", ConditionDisplay.firingLine(ConditionCompare("GTE", 3.0), 0, "in"))
        assertNull(ConditionDisplay.bar(0.0, ConditionCompare("EXIT_ZERO", null), null, null))
    }

    @Test fun howItChecks() {
        val checks = ConditionDisplay.checksBlock(guardCondition(), zone)
        assertEquals("Every 5 min on workstation-gpu, without a model.", checks.every)
        assertEquals("ceph df -f json | jq .stats.total_used_raw_ratio", checks.command)
        assertEquals("Read-only. Approved by you on Nov 17.", checks.approved)
        assertNull(checks.awake)
        val cloud = ConditionView(id = "c", text = "x", command = "true", compare = ConditionCompare("EXIT_ZERO", null), keepsWorkspaceAwake = true)
        assertEquals("Keeps this cloud workspace awake while it waits.", ConditionDisplay.checksBlock(cloud, zone).awake)
        assertEquals("Every 5 min, without a model.", ConditionDisplay.checksBlock(cloud, zone).every)
    }

    @Test fun theConditionReadIsReadOffItsDoor() {
        val c = ConditionView.parse(json("""
            {"id":"c-guard","workspaceId":"w-hpc","text":"Raw used above 90%","unit":"%",
             "probe":{"command":"ceph df -f json | jq .stats.total_used_raw_ratio","timeoutSeconds":20},
             "compare":{"op":"GT","value":90},"holdSeconds":600,"rearm":{"op":"LT","value":85},"intervalSeconds":300,
             "repeatSeconds":null,"state":"WAITING","lastValue":6.9,"approvedAt":"2026-11-17T02:00:00.000Z","failedChecks":0,
             "scheduleId":"s-guard","taskId":null,"keepsWorkspaceAwake":false,"runnerName":"workstation-gpu",
             "samples":[{"at":"2026-11-17T03:39:00.000Z","outcome":"VALUE","value":6.9}],
             "events":[{"at":"2026-11-20T19:12:00.000Z","kind":"FIRED","value":90.4,"runId":"r-21","repeat":false},{"kind":"FIRED"}]}
        """))!!
        assertEquals("ceph df -f json | jq .stats.total_used_raw_ratio", c.command)
        assertEquals("workstation-gpu", c.runnerName)
        assertEquals("an event this build cannot read is dropped, not the read", 1, c.events.size)
        assertEquals(1, c.samples.size)
    }

    @Test fun theHistoryLines() {
        val c = guardCondition()
        val lines = c.events.mapNotNull { ConditionDisplay.historyLine(it, c) }
        assertEquals(listOf("Ready again · 82.9%", "Fired · 90.4% for 10 min"), lines.map { it.text })
        assertEquals(listOf("Condition", "Run"), lines.map { it.chip })
        assertEquals("r-21", lines[1].runId)
        val again = ConditionEventView("2026-11-21T00:00:00.000Z", "FIRED", 91.0, "r-22", repeat = true)
        assertEquals("Fired again · 91%", ConditionDisplay.historyLine(again, c)?.text)
    }

    // A run's session (board ⑤ ②)

    @Test fun aRunItsConditionStartedNamesTheFiring() {
        val run = ScheduleRunView(id = "r-21", scheduleId = "s-guard", plannedAt = "2026-11-20T19:12:00.000Z", trigger = "CONDITION", state = "CHANGED")
        assertEquals("Fired 03:12 · 90.4% for 10 min · Check only", ConditionDisplay.runFiredText(run, guardCondition(), "CHECK_ONLY", zone))
        assertEquals("before the condition's read, the time alone", "Fired 03:12 · Check only",
            ConditionDisplay.runFiredText(run, null, "CHECK_ONLY", zone))
    }

    // The cards

    @Test fun theScheduleCreateCardsWhenLines() {
        val card = ScheduleCard.parse(json("""
            {"id":"q1","kind":"CREATE","state":"PENDING","title":"Ceph capacity guard","createdAt":"2026-11-17T03:00:00Z",
             "when":{"rule":$guardRule,"timezone":null,"firstRunAt":null,"text":"Raw used above 90% for 10 min",
              "condition":{"text":"Raw used above 90% for 10 min",
               "detail":"Fires again only after it drops below 85%. Checked every 5 min on workstation-gpu, no model.",
               "command":"ceph df -f json | jq .stats.total_used_raw_ratio","repeat":null,"awake":null}},
             "today":{"key":"below-90","summary":"6.9%. Nothing to report."}}
        """))!!
        val lines = card.`when`!!.condition!!
        assertEquals("ceph df -f json | jq .stats.total_used_raw_ratio", lines.command)
        val (bold, rest) = ConditionDisplay.whenTextParts(lines, card.`when`!!.rule.condition)
        assertEquals("Raw used above 90%", bold)
        assertEquals(" for 10 min", rest)
        // The client's own working of the lines says what the server's does.
        assertEquals(lines, ConditionDisplay.whenLines(card.`when`!!.rule.condition!!, runner = "workstation-gpu"))
        assertEquals("Raw used above 90% for 10 min", ScheduleDisplay.createWhen(card.`when`!!, now, zone).text)
    }

    @Test fun theTaskCreateCardsStartsWhenTodayAndIfNever() {
        val input = json("""
            {"title":"Set kubernetes pool to 3 copies","description":"When a third OSD is in, I check again.",
             "startWhen":{"text":"3 or more OSDs are in","command":"ceph osd stat -f json | jq .num_in_osds"},
             "preview":{"taskCount":1,"tasks":[{"title":"Set kubernetes pool to 3 copies","startWhen":{
              "startsWhen":"3 or more OSDs are in","checked":"Once. Checked every 5 min on workstation-gpu, no model.",
              "command":"ceph osd stat -f json | jq .num_in_osds","today":"2 in. Not yet.",
              "ifNever":"Asks you after 30 days of waiting","awake":null}}]}}
        """).jsonObject
        val lines = StartWhenCardLines.ofCreateInput(input)!!
        assertEquals("3 or more OSDs are in", lines.startsWhen)
        assertEquals("Once. Checked every 5 min on workstation-gpu, no model.", lines.checked)
        assertEquals("2 in. Not yet.", lines.today)
        assertEquals("Asks you after 30 days of waiting", lines.ifNever)
        assertNull(StartWhenCardLines.ofCreateInput(JsonObject(emptyMap())))
        assertEquals("Create task that starts on a condition?", ConditionCopy.createTaskTitle)
        assertEquals(listOf("Starts when", "Today", "If never"), listOf(ConditionCopy.startsWhen, ConditionCopy.today, ConditionCopy.ifNever))
    }

    @Test fun theWidenCardForANewCommand() {
        val schedule = guardSchedule()
        val newRule = guardRule.replace("jq .stats.total_used_raw_ratio", "jq .stats.total_used_ratio")
        val lines = """
            {"runsIn":{"workspaceId":"w-hpc","workspaceName":"HPC","engine":"claude"},"may":{"accessLevel":"CHECK_ONLY"},
             "costs":{"runsPerWeek":3,"runLimitMinutes":30}}
        """
        val card = ScheduleCard.parse(json("""
            {"id":"q2","kind":"UPDATE","state":"PENDING","scheduleId":"s-guard","createdAt":"2026-11-17T03:00:00Z",
             "proposed":{"rule":$newRule},"envelope":{"widens":["PROBE_COMMAND"],"now":$lines,"asked":$lines}}
        """))!!
        val text = ScheduleDisplay.envelopeCard(card, schedule.title, schedule.rule)!!
        assertEquals("Let Ceph capacity guard check with a new command?", text.title)
        assertEquals("ceph df -f json | jq .stats.total_used_raw_ratio", text.now?.text)
        assertEquals("ceph df -f json | jq .stats.total_used_ratio", text.asked.text)
        assertEquals("Keep the approved command", text.keep)
        assertEquals(ScheduleConditionCopy.commandNote, text.note)
        val before = ScheduleEnvelope("w", "CHECK_ONLY", 3, 30, commandHash = "a")
        assertEquals(listOf("PROBE_COMMAND"), ScheduleDisplay.widenedParts(before, before.copy(commandHash = "b")))
    }

    // Waiting on you (board ⑥ ①) and Tasks

    @Test fun theConditionItemsAreReadBesideTheRequests() {
        val items = ConditionWaitingItem.fromRequestList(json("""
            {"requests":[
              {"id":"o1","kind":"CONDITION_UNKNOWN","state":"PENDING","title":"Can't read: Root disk below 5%",
               "why":"The check timed out 3 times in a row.","conditionId":"c-mon","createdAt":"2026-11-17T03:40:00.000Z"},
              {"id":"o2","kind":"CONDITION_STILL_WAITING","state":"PENDING",
               "title":"Still waiting for 3 or more OSDs are in. Keep waiting?","why":"It has not held in 30 days.",
               "options":[{"label":"Keep waiting","description":"Ask again in 30 days."},
                          {"label":"Stop","description":"End the check. The task stays open."}],
               "conditionId":"c-osd","createdAt":"2026-11-17T03:40:00.000Z"},
              {"id":"o3","kind":"DECISION","state":"PENDING","title":"Pick one"}]}
        """))
        assertEquals(listOf("CONDITION_UNKNOWN", "CONDITION_STILL_WAITING"), items.map { it.kind })
        assertEquals(listOf("Pause", "Look into it"), ConditionDisplay.waitingActions(items[0], "s-mon"))
        assertEquals(listOf("Look into it"), ConditionDisplay.waitingActions(items[0], null))
        assertEquals(listOf("Keep waiting", "Stop"), ConditionDisplay.waitingActions(items[1], null))
    }

    @Test fun aTaskWaitingOnItsConditionSaysSo() {
        val startWhen = TaskStartWhenView.parse(json("""
            {"conditionId":"c-osd","text":"3 or more OSDs are in","unit":"in","state":"WAITING","lastValue":2,
             "lastSampleAt":"2026-11-17T03:37:00.000Z","firedAt":null,"waitingLine":"Waiting for: 3 or more OSDs are in"}
        """))
        val waiting = ConditionDisplay.taskWaiting(startWhen, now)!!
        assertEquals("Waiting for: 3 or more OSDs are in", waiting.line)
        assertEquals("2 in · 3 min ago", waiting.reading)
        assertEquals("Can't read", ConditionDisplay.taskWaiting(startWhen!!.copy(state = "UNKNOWN"), now)?.reading)
        assertNull("fired: no waiting line", ConditionDisplay.taskWaiting(startWhen.copy(waitingLine = null), now))
    }

    // The words

    private fun source(path: String): String {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, path) }.firstOrNull { it.isFile }
            ?: throw AssertionError("$path was not found above ${File("").absolutePath}")
        return file.readText()
    }

    /** `ScheduleConditionCopy` is the shared SCHEDULE_CONDITION_COPY, word for word (OrbitKit reads the same block the same way). */
    @Test fun theWhenWordsAreTheSharedOnes() {
        val text = source("src/shared/src/schedule.ts")
        val start = text.indexOf("export const SCHEDULE_CONDITION_COPY = {").also { assertTrue(it >= 0) } + "export const SCHEDULE_CONDITION_COPY = {".length
        val end = text.indexOf("} as const;", start)
        val path = mutableListOf<String>()
        val shared = mutableMapOf<String, String>()
        for (raw in text.substring(start, end).lines()) {
            val line = raw.trim()
            if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue
            if (line.endsWith("{")) { path += line.substringBefore(":"); continue }
            if (line.startsWith("}")) { path.removeLastOrNull(); continue }
            var rest = line
            var inline = false
            val open = line.indexOf(": {")
            if (open >= 0) { path += line.substring(0, open); rest = line.substring(open + 3); inline = true }
            while (true) {
                val colon = rest.indexOf(": '")
                if (colon < 0) break
                val key = rest.substring(0, colon).split(' ', ',', '{').last()
                val after = rest.substring(colon + 3)
                val close = after.indexOf('\'')
                if (close < 0) break
                shared[(path + key).joinToString(".")] = after.substring(0, close)
                rest = after.substring(close + 1)
            }
            if (inline) path.removeLastOrNull()
        }
        assertTrue("the shared words were read", shared.size > 15)
        for ((key, sentence) in shared.toSortedMap()) assertEquals("SCHEDULE_CONDITION_COPY.$key", sentence, ScheduleConditionCopy.contract[key])
        for (key in ScheduleConditionCopy.contract.keys) if (key !in shared) fail("ScheduleConditionCopy holds $key, which SCHEDULE_CONDITION_COPY does not")
        assertTrue(text.contains("keepsAwake: CONDITION_KEEPS_AWAKE_LINE"))
    }

    /** The words the web composes from a condition's read (src/web/src/lib/conditions.ts CONDITION_COPY) are Android's, word for
     * word: the clients draw one board. */
    @Test fun theComposedWordsAreTheWebs() {
        val text = source("src/web/src/lib/conditions.ts")
        val start = text.indexOf("export const CONDITION_COPY = {").also { assertTrue(it >= 0) }
        val web = text.substring(start, text.indexOf("} as const;", start))
        fun says(sentence: String) = web.contains("'$sentence'") || web.contains("\"$sentence\"")
        val c = ConditionCopy
        val ours = listOf(c.group, c.cantRead, c.checkedAgo, c.notReadYet, c.justNow, c.minutesAgo, c.hoursAgo, c.daysAgo,
            c.conditionSection, c.howItChecks, c.holdFor, c.readyAgainWhenFalse, c.every, c.everyNoRunner, c.approved, c.runFired,
            c.runFiredAgain, c.waitingKind, c.pause, c.lookIntoIt, c.startsWhen, c.today, c.ifNever, c.chipRun, c.chipCondition,
            c.historyCantRead, "${c.taskRow} · ${c.taskOnce}") + c.fires.values.sorted() + c.readyAgain.values.sorted()
        for (sentence in ours) assertTrue("the web's CONDITION_COPY does not say $sentence", says(sentence))
    }

    /** Every label is English (CLAUDE.md §5). */
    @Test fun everyLabelIsEnglish() {
        for (sentence in ConditionCopy.all + ScheduleConditionCopy.contract.values) {
            assertFalse(sentence, sentence.any { it.code in 0x3000..0x9FFF })
        }
    }
}
