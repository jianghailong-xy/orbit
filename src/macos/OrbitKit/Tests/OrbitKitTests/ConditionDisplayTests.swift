import Foundation
import XCTest
@testable import OrbitKit

/// Conditions on the Apple clients (docs/condition-triggers-design.md §9; board docs/mocks/condition-triggers/01-board.png
/// frames 2 to 6, iOS the reference): the wire shapes as the doors send them, and the board's words from them.
final class ConditionDisplayTests: XCTestCase {
    private let zone = "Asia/Shanghai"
    /// Tue Nov 17 2026, 11:40 in Shanghai.
    private let now = ISO8601DateFormatter().date(from: "2026-11-17T03:40:00Z")!

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private static let guardRule = """
    {"kind":"WHEN","conditionId":"c-guard","runsPerWeek":3,"condition":{"text":"Raw used above 90%",
     "command":"ceph df -f json | jq .stats.total_used_raw_ratio","compare":{"op":"GT","value":90},"holdSeconds":600,
     "rearm":{"op":"LT","value":85},"intervalSeconds":300,"unit":"%","timeoutSeconds":20,"repeatSeconds":null}}
    """

    private func guardSchedule(state: String = "ACTIVE", conditionState: String = "WAITING") throws -> ScheduleView {
        try decode(ScheduleView.self, """
        {"id":"s-guard","title":"Ceph capacity guard","rule":\(Self.guardRule),"timezone":"Asia/Shanghai",
         "workspaceId":"w-hpc","workspaceName":"HPC","accessLevel":"CHECK_ONLY","state":"\(state)","nextDueAt":null,
         "consecutiveFailures":0,"condition":{"id":"c-guard","text":"Raw used above 90%","unit":"%",
         "state":"\(conditionState)","lastValue":6.9,"lastSampleAt":"2026-11-17T03:39:00.000Z"}}
        """)
    }

    private func osdTask(state: String = "WAITING") -> ScheduleWaitingTask {
        ScheduleWaitingTask(id: "t-osd", title: "Set kubernetes pool to 3 copies", workspaceId: "w-hpc",
                            workspaceName: "HPC",
                            condition: ScheduleConditionReading(id: "c-osd", text: "3 or more OSDs are in", unit: "in",
                                                                state: state, lastValue: 2,
                                                                lastSampleAt: "2026-11-17T03:37:00.000Z"))
    }

    private func guardCondition() -> ConditionView {
        ConditionView(
            id: "c-guard", workspaceId: "w-hpc", text: "Raw used above 90%", unit: "%",
            command: "ceph df -f json | jq .stats.total_used_raw_ratio",
            compare: ConditionCompare(op: "GT", value: 90), holdSeconds: 600,
            rearm: ConditionCompare(op: "LT", value: 85), intervalSeconds: 300, state: "WAITING",
            lastSampleAt: "2026-11-17T03:39:00.000Z", lastValue: 6.9, lastReadAt: "2026-11-17T03:39:00.000Z",
            approvedAt: "2026-11-17T02:00:00.000Z", scheduleId: "s-guard", runnerName: "workstation-gpu",
            events: [
                ConditionEventView(at: "2026-11-22T01:40:00.000Z", kind: "READY_AGAIN", value: 82.9),
                ConditionEventView(at: "2026-11-20T19:12:00.000Z", kind: "FIRED", value: 90.4, runId: "r-21"),
            ])
    }

    // MARK: the wire

    func testAWhenRuleReadsAndWritesItsCondition() throws {
        let rule = try decode(ScheduleRule.self, Self.guardRule)
        guard case .when(let id, let runs, let condition) = rule else { return XCTFail("not a WHEN rule: \(rule)") }
        XCTAssertEqual(id, "c-guard")
        XCTAssertEqual(runs, 3)
        XCTAssertEqual(condition.compare, ConditionCompare(op: "GT", value: 90))
        XCTAssertEqual(condition.rearm?.value, 85)
        XCTAssertNil(rule.time)
        XCTAssertEqual(ScheduleRule(json: try decode(JSONValue.self, Self.guardRule)), rule, "a revision's rule reads too")
        let again = try JSONDecoder().decode(ScheduleRule.self, from: JSONEncoder().encode(rule))
        XCTAssertEqual(again, rule)
    }

    func testTheListCarriesTheReadingAndTheWaitingTasks() throws {
        let list = try decode(ScheduleListResponse.self, """
        {"schedules":[{"id":"s-guard","title":"Ceph capacity guard","rule":\(Self.guardRule),"workspaceId":"w-hpc",
          "condition":{"id":"c-guard","text":"Raw used above 90%","unit":"%","state":"WAITING","lastValue":6.9,
          "lastSampleAt":"2026-11-17T03:39:00.000Z"}}],
         "runs":[],
         "waitingTasks":[{"id":"t-osd","title":"Set kubernetes pool to 3 copies","workspaceId":"w-hpc",
          "workspaceName":"HPC","condition":{"id":"c-osd","text":"3 or more OSDs are in","unit":"in",
          "state":"WAITING","lastValue":2,"lastSampleAt":"2026-11-17T03:37:00.000Z"}}]}
        """)
        XCTAssertEqual(list.schedules.first?.condition?.lastValue, 6.9, "a WHEN schedule is no longer dropped")
        XCTAssertEqual(list.waitingTasks?.map(\.title), ["Set kubernetes pool to 3 copies"])
        XCTAssertNil(try decode(ScheduleListResponse.self, #"{"schedules":[]}"#).waitingTasks)
    }

    // MARK: the Scheduled page (board ④)

    func testTheConditionGroupSitsAboveTodayAndCantReadLeadsIt() throws {
        let daily = try decode(ScheduleView.self, """
        {"id":"s-codex","title":"Codex stable check","rule":{"kind":"DAILY","time":"10:00"},"workspaceId":"w-api",
         "workspaceName":"apiserver","nextDueAt":"2026-11-17T06:00:00.000Z"}
        """)
        let mon = try decode(ScheduleView.self, """
        {"id":"s-mon","title":"Mon disk guard","rule":{"kind":"WHEN","conditionId":"c-mon","runsPerWeek":3,
          "condition":{"text":"Root disk below 5%","command":"df","compare":{"op":"LT","value":5}}},
         "workspaceId":"w-hpc","workspaceName":"HPC","condition":{"id":"c-mon","text":"Root disk below 5%",
          "unit":"%","state":"UNKNOWN","lastValue":5}}
        """)
        let groups = ScheduleDisplay.timeline(schedules: [daily, try guardSchedule(), mon], waitingTasks: [osdTask()],
                                              now: now, timezone: zone)
        // No Needs you group (owner 2026-11-19): the one that cannot be read leads Waiting for a condition.
        XCTAssertEqual(groups.map(\.title), ["Waiting for a condition", "Today"])
        XCTAssertEqual(groups[0].subtitle, "3")
        XCTAssertEqual(groups[0].items.map(\.id), ["schedule-s-mon", "schedule-s-guard", "task-t-osd"],
                       "can't read first, then schedules, then tasks")
        XCTAssertEqual(ScheduleDisplay.needsYouCount([daily, try guardSchedule(), mon], waitingTasks: [osdTask()]), 1)

        let cantRead = ScheduleDisplay.scheduleCircle(mon)
        XCTAssertTrue(cantRead.gauge)
        XCTAssertEqual(cantRead.tag?.text, "Can't read")
        XCTAssertEqual(cantRead.tag?.tone, .held)
        XCTAssertTrue(ConditionDisplay.circle(cantRead: false).gauge, "a gauge in place of the circle")

        let taskCantRead = ScheduleDisplay.timeline(schedules: [try guardSchedule()],
                                                    waitingTasks: [osdTask(state: "UNKNOWN")], now: now, timezone: zone)
        XCTAssertEqual(taskCantRead.map(\.title), ["Waiting for a condition"])
        XCTAssertEqual(taskCantRead[0].items.map(\.id), ["task-t-osd", "schedule-s-guard"])
    }

    func testAFailingWhenScheduleStaysInItsGroup() throws {
        let failing = try decode(ScheduleView.self, """
        {"id":"s-guard","title":"Ceph capacity guard","rule":\(Self.guardRule),"workspaceId":"w-hpc","nextDueAt":null,
         "consecutiveFailures":2,"condition":{"id":"c-guard","text":"Raw used above 90%","state":"WAITING"}}
        """)
        let groups = ScheduleDisplay.timeline(schedules: [failing], now: now, timezone: zone)
        XCTAssertEqual(groups.map(\.title), ["Waiting for a condition"])
        XCTAssertEqual(groups[0].items.map(\.id), ["schedule-s-guard"])
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(failing).circle, .failed)
        let running = [ScheduleRunView(id: "r", scheduleId: "s-guard", plannedAt: "2026-11-17T03:30:00.000Z",
                                       state: "RUNNING")]
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(failing, runs: running).circle, .open)
        XCTAssertTrue(ScheduleDisplay.scheduleCircle(failing, runs: running).gauge)
        XCTAssertEqual(ScheduleDisplay.needsYouCount([failing], runs: running), 0)
    }

    func testARowShowsTheNewestReadingAndItsAge() throws {
        XCTAssertEqual(ConditionDisplay.rowReading(try guardSchedule().condition!, now: now)?.text, "6.9% · 1 min ago")
        XCTAssertEqual(ConditionDisplay.rowReading(osdTask().condition, now: now)?.text, "2 in · 3 min ago")
        XCTAssertNil(ConditionDisplay.rowReading(ScheduleConditionReading(id: "c", text: "x"), now: now))
        XCTAssertEqual(ConditionDisplay.ageText(now.addingTimeInterval(-20), now: now), "just now")
        XCTAssertEqual(ConditionDisplay.ageText(now.addingTimeInterval(-3 * 3600), now: now), "3 h ago")
        XCTAssertEqual(ConditionDisplay.ageText(now.addingTimeInterval(-3 * 86_400), now: now), "3 days ago")
        XCTAssertEqual(ConditionDisplay.readingText(90.4, unit: "%"), "90.4%")
        XCTAssertEqual(ConditionDisplay.readingText(0.0691234, unit: nil), "0.07")
        XCTAssertEqual(ConditionDisplay.readingText(412, unit: "GiB"), "412 GiB")
    }

    func testTheRowsSayTheirRuleAsTheBoardDoes() throws {
        XCTAssertEqual(ScheduleDisplay.ruleText(try guardSchedule().rule, form: .long), "When raw used above 90%")
        XCTAssertEqual(ScheduleDisplay.ruleText(try guardSchedule().rule, form: .short), "Raw used above 90%")
        XCTAssertTrue(ScheduleDisplay.ruleRepeats(try guardSchedule().rule), "↻ on a WHEN rule")
        XCTAssertEqual(ConditionDisplay.taskRowLine(osdTask()), "Task · once, when 3 or more OSDs are in · HPC")
    }

    // MARK: the inspector (board ⑥ ② ③)

    func testTheConditionBlock() {
        let block = ConditionDisplay.conditionBlock(guardCondition(), now: now)
        XCTAssertEqual(block.reading, "6.9%")
        XCTAssertEqual(block.checked, "checked 1 min ago")
        XCTAssertEqual(block.rule, "Fires above 90% for 10 min. Ready again below 85%.")
        XCTAssertNil(block.cantRead)
        XCTAssertNil(block.repeat)
        let bar = try? XCTUnwrap(block.bar)
        XCTAssertEqual(bar?.value ?? 0, 0.069, accuracy: 0.0001)
        XCTAssertEqual(bar?.fire, 0.9)
        XCTAssertEqual(bar?.rearm, 0.85)
        XCTAssertEqual(bar?.fireLabel, "90%")
        XCTAssertEqual(bar?.rearmLabel, "85%")
        XCTAssertEqual(ConditionDisplay.repeatText(7200), "And again every 2 hours while it stays that way.")
        XCTAssertEqual(ConditionDisplay.firingLine(compare: ConditionCompare(op: "GTE", value: 3), holdSeconds: 0, unit: "in"),
                       "Fires at 3 in or more.")
        XCTAssertNil(ConditionDisplay.bar(value: 0, compare: ConditionCompare(op: "EXIT_ZERO", value: nil),
                                          rearm: nil, unit: nil))
    }

    func testHowItChecks() {
        let checks = ConditionDisplay.checksBlock(guardCondition(), timezone: zone)
        XCTAssertEqual(checks.every, "Every 5 min on workstation-gpu, without a model.")
        XCTAssertEqual(checks.command, "ceph df -f json | jq .stats.total_used_raw_ratio")
        XCTAssertEqual(checks.approved, "Read-only. Approved by you on Nov 17.")
        XCTAssertNil(checks.awake)
        let cloud = ConditionView(id: "c", text: "x", command: "true", compare: ConditionCompare(op: "EXIT_ZERO", value: nil),
                                  keepsWorkspaceAwake: true)
        XCTAssertEqual(ConditionDisplay.checksBlock(cloud, timezone: zone).awake,
                       "Keeps this cloud workspace awake while it waits.")
        XCTAssertEqual(ConditionDisplay.checksBlock(cloud, timezone: zone).every, "Every 5 min, without a model.")
    }

    func testTheHistoryLines() {
        let c = guardCondition()
        let lines = c.events.compactMap { ConditionDisplay.historyLine($0, condition: c) }
        XCTAssertEqual(lines.map(\.text), ["Ready again · 82.9%", "Fired · 90.4% for 10 min"])
        XCTAssertEqual(lines.map(\.chip), ["Condition", "Run"])
        XCTAssertEqual(lines[1].runId, "r-21")
        let again = ConditionEventView(at: "2026-11-21T00:00:00.000Z", kind: "FIRED", value: 91, runId: "r-22", repeat: true)
        XCTAssertEqual(ConditionDisplay.historyLine(again, condition: c)?.text, "Fired again · 91%")
    }

    // MARK: a run's session (board ⑤ ②)

    func testARunItsConditionStartedNamesTheFiring() {
        let run = ScheduleRunView(id: "r-21", scheduleId: "s-guard", plannedAt: "2026-11-20T19:12:00.000Z",
                                  trigger: "CONDITION", state: "CHANGED")
        XCTAssertEqual(ConditionDisplay.runFiredText(run: run, condition: guardCondition(), accessLevel: "CHECK_ONLY",
                                                     timezone: zone),
                       "Fired 03:12 · 90.4% for 10 min · Check only")
        XCTAssertEqual(ConditionDisplay.runFiredText(run: run, condition: nil, accessLevel: "CHECK_ONLY", timezone: zone),
                       "Fired 03:12 · Check only", "before the condition's read, the time alone")
    }

    // MARK: the cards

    func testTheScheduleCreateCardsWhenLines() throws {
        let card = try decode(ScheduleCard.self, """
        {"id":"q1","kind":"CREATE","state":"PENDING","title":"Ceph capacity guard","createdAt":"2026-11-17T03:00:00Z",
         "when":{"rule":\(Self.guardRule),"timezone":null,"firstRunAt":null,"text":"Raw used above 90% for 10 min",
          "condition":{"text":"Raw used above 90% for 10 min",
           "detail":"Fires again only after it drops below 85%. Checked every 5 min on workstation-gpu, no model.",
           "command":"ceph df -f json | jq .stats.total_used_raw_ratio","repeat":null,"awake":null}},
         "today":{"key":"below-90","summary":"6.9%. Nothing to report."}}
        """)
        let lines = try XCTUnwrap(card.when?.condition)
        XCTAssertEqual(lines.command, "ceph df -f json | jq .stats.total_used_raw_ratio")
        let parts = ConditionDisplay.whenTextParts(lines, condition: card.when?.rule.condition)
        XCTAssertEqual(parts.bold, "Raw used above 90%")
        XCTAssertEqual(parts.rest, " for 10 min")
        // The client's own working of the lines says what the server's does.
        let own = ConditionDisplay.whenLines(try XCTUnwrap(card.when?.rule.condition), runner: "workstation-gpu")
        XCTAssertEqual(own, lines)
        XCTAssertEqual(ScheduleDisplay.createWhen(try XCTUnwrap(card.when), now: now, viewerTimezone: zone).text,
                       "Raw used above 90% for 10 min")
    }

    func testTheTaskCreateCardsStartsWhenTodayAndIfNever() throws {
        let input = try decode(JSONValue.self, """
        {"title":"Set kubernetes pool to 3 copies","description":"When a third OSD is in, I check again.",
         "startWhen":{"text":"3 or more OSDs are in","command":"ceph osd stat -f json | jq .num_in_osds"},
         "preview":{"taskCount":1,"tasks":[{"title":"Set kubernetes pool to 3 copies","startWhen":{
          "startsWhen":"3 or more OSDs are in","checked":"Once. Checked every 5 min on workstation-gpu, no model.",
          "command":"ceph osd stat -f json | jq .num_in_osds","today":"2 in. Not yet.",
          "ifNever":"Asks you after 30 days of waiting","awake":null}}]}}
        """)
        let create = try XCTUnwrap(Approvals.createPreview(toolName: "orbit_task_create", from: input))
        let lines = try XCTUnwrap(create.startWhen)
        XCTAssertEqual(lines.startsWhen, "3 or more OSDs are in")
        XCTAssertEqual(lines.checked, "Once. Checked every 5 min on workstation-gpu, no model.")
        XCTAssertEqual(lines.today, "2 in. Not yet.")
        XCTAssertEqual(lines.ifNever, "Asks you after 30 days of waiting")
        XCTAssertEqual(ConditionCopy.createTaskTitle, "Create task that starts on a condition?")
        XCTAssertEqual([ConditionCopy.startsWhen, ConditionCopy.today, ConditionCopy.ifNever],
                       ["Starts when", "Today", "If never"])
    }

    func testTheWidenCardForANewCommand() throws {
        let schedule = try guardSchedule()
        let newRule = Self.guardRule.replacingOccurrences(of: "jq .stats.total_used_raw_ratio", with: "jq .stats.total_used_ratio")
        let lines = """
        {"runsIn":{"workspaceId":"w-hpc","workspaceName":"HPC","engine":"claude"},"may":{"accessLevel":"CHECK_ONLY"},
         "costs":{"runsPerWeek":3,"runLimitMinutes":30}}
        """
        let card = try decode(ScheduleCard.self, """
        {"id":"q2","kind":"UPDATE","state":"PENDING","scheduleId":"s-guard","createdAt":"2026-11-17T03:00:00Z",
         "proposed":{"rule":\(newRule)},"envelope":{"widens":["PROBE_COMMAND"],"now":\(lines),"asked":\(lines)}}
        """)
        let text = try XCTUnwrap(ScheduleDisplay.envelopeCard(card, scheduleTitle: schedule.title, ruleNow: schedule.rule))
        XCTAssertEqual(text.title, "Let Ceph capacity guard check with a new command?")
        XCTAssertEqual(text.now?.text, "ceph df -f json | jq .stats.total_used_raw_ratio")
        XCTAssertEqual(text.asked.text, "ceph df -f json | jq .stats.total_used_ratio")
        XCTAssertEqual(text.keep, "Keep the approved command")
        XCTAssertEqual(text.note, ScheduleConditionCopy.commandNote)
        let before = ScheduleEnvelope(workspaceId: "w", accessLevel: "CHECK_ONLY", runsPerWeek: 3, runLimitMinutes: 30,
                                      commandHash: "a")
        let after = ScheduleEnvelope(workspaceId: "w", accessLevel: "CHECK_ONLY", runsPerWeek: 3, runLimitMinutes: 30,
                                     commandHash: "b")
        XCTAssertEqual(ScheduleDisplay.widenedParts(before: before, after: after), ["PROBE_COMMAND"])
    }

    // MARK: Waiting on you (board ⑥ ①) and Tasks

    func testTheConditionItemsAreReadBesideTheRequests() throws {
        let list = try decode(OwnerRequestList.self, """
        {"requests":[
          {"id":"o1","kind":"CONDITION_UNKNOWN","state":"PENDING","title":"Can't read: Root disk below 5%",
           "why":"The check timed out 3 times in a row.","conditionId":"c-mon","createdAt":"2026-11-17T03:40:00.000Z"},
          {"id":"o2","kind":"CONDITION_STILL_WAITING","state":"PENDING",
           "title":"Still waiting for 3 or more OSDs are in. Keep waiting?","why":"It has not held in 30 days.",
           "options":[{"label":"Keep waiting","description":"Ask again in 30 days."},
                      {"label":"Stop","description":"End the check. The task stays open."}],
           "conditionId":"c-osd","createdAt":"2026-11-17T03:40:00.000Z"}]}
        """)
        XCTAssertTrue(list.requests.isEmpty, "OwnerRequest does not read a condition's kinds")
        XCTAssertEqual(list.conditionItems.map(\.kind), ["CONDITION_UNKNOWN", "CONDITION_STILL_WAITING"])
        XCTAssertEqual(ConditionDisplay.waitingActions(list.conditionItems[0], scheduleId: "s-mon"), ["Pause", "Look into it"])
        XCTAssertEqual(ConditionDisplay.waitingActions(list.conditionItems[0], scheduleId: nil), ["Look into it"])
        XCTAssertEqual(ConditionDisplay.waitingActions(list.conditionItems[1], scheduleId: nil), ["Keep waiting", "Stop"])
    }

    func testATaskWaitingOnItsConditionSaysSo() throws {
        let task = try decode(TaskItem.self, """
        {"id":"t-osd","title":"Set kubernetes pool to 3 copies","status":"OPEN","projectId":null,"dependsOn":[],
         "startWhen":{"conditionId":"c-osd","text":"3 or more OSDs are in","unit":"in","state":"WAITING","lastValue":2,
          "lastSampleAt":"2026-11-17T03:37:00.000Z","firedAt":null,"waitingLine":"Waiting for: 3 or more OSDs are in"}}
        """)
        let waiting = try XCTUnwrap(ConditionDisplay.taskWaiting(task.startWhen, now: now))
        XCTAssertEqual(waiting.line, "Waiting for: 3 or more OSDs are in")
        XCTAssertEqual(waiting.reading, "2 in · 3 min ago")
        XCTAssertNil(TaskDetailLogic.runNowHint(task), "its condition starts it: Run is not its only start")
    }

    // MARK: the words

    /// `ScheduleConditionCopy` is the shared SCHEDULE_CONDITION_COPY, word for word.
    func testTheWhenWordsAreTheSharedOnes() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: String?
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/shared/src/schedule.ts")
            if let text = try? String(contentsOf: candidate, encoding: .utf8) { source = text; break }
            dir = dir.deletingLastPathComponent()
        }
        let text = try XCTUnwrap(source, "src/shared/src/schedule.ts was not found above this test")
        let start = try XCTUnwrap(text.range(of: "export const SCHEDULE_CONDITION_COPY = {"))
        let end = try XCTUnwrap(text.range(of: "} as const;", range: start.upperBound..<text.endIndex))
        var path: [String] = []
        var shared: [String: String] = [:]
        for raw in text[start.upperBound..<end.lowerBound].split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("//") || line.hasPrefix("/*") || line.hasPrefix("*") { continue }
            if line.hasSuffix("{"), let key = line.split(separator: ":").first {
                path.append(String(key)); continue
            }
            if line.hasPrefix("}") { _ = path.popLast(); continue }
            // `key: 'sentence',` pairs, one or several on a line; `key: { a: '…', b: '…' },` on one line too.
            var rest = Substring(line)
            var inline = false
            if let open = line.range(of: ": {") {
                path.append(String(line[..<open.lowerBound]))
                rest = line[open.upperBound...]
                inline = true
            }
            defer { if inline { _ = path.popLast() } }
            while let colon = rest.range(of: ": '") {
                let key = rest[..<colon.lowerBound].split(whereSeparator: { $0 == " " || $0 == "," || $0 == "{" }).last.map(String.init) ?? ""
                let after = rest[colon.upperBound...]
                guard let close = after.firstIndex(of: "'") else { break }
                shared[(path + [key]).joined(separator: ".")] = String(after[..<close])
                rest = after[after.index(after: close)...]
            }
        }
        XCTAssertGreaterThan(shared.count, 15, "the shared words were read")
        for (key, sentence) in shared.sorted(by: { $0.key < $1.key }) {
            XCTAssertEqual(ScheduleConditionCopy.contract[key], sentence, "SCHEDULE_CONDITION_COPY.\(key)")
        }
        for key in ScheduleConditionCopy.contract.keys where shared[key] == nil {
            XCTFail("ScheduleConditionCopy holds \(key), which SCHEDULE_CONDITION_COPY does not")
        }
        XCTAssertTrue(text.contains("keepsAwake: CONDITION_KEEPS_AWAKE_LINE"))
    }

    /// The words the web composes from a condition's read (src/web/src/lib/conditions.ts CONDITION_COPY) are the
    /// iPhone's, word for word: the two clients draw one board.
    func testTheComposedWordsAreTheWebs() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var source: String?
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/web/src/lib/conditions.ts")
            if let text = try? String(contentsOf: candidate, encoding: .utf8) { source = text; break }
            dir = dir.deletingLastPathComponent()
        }
        let text = try XCTUnwrap(source, "src/web/src/lib/conditions.ts was not found above this test")
        let start = try XCTUnwrap(text.range(of: "export const CONDITION_COPY = {"))
        let end = try XCTUnwrap(text.range(of: "} as const;", range: start.upperBound..<text.endIndex))
        let web = String(text[start.upperBound..<end.lowerBound])
        func says(_ sentence: String) -> Bool {
            web.contains("'\(sentence)'") || web.contains("\"\(sentence)\"")
        }
        let C = ConditionCopy.self
        var ours = [C.group, C.cantRead, C.checkedAgo, C.notReadYet, C.justNow, C.minutesAgo, C.hoursAgo, C.daysAgo,
                    C.conditionSection, C.howItChecks, C.holdFor, C.readyAgainWhenFalse, C.every, C.everyNoRunner,
                    C.approved, C.runFired, C.runFiredAgain, C.waitingKind, C.pause, C.lookIntoIt, C.startsWhen,
                    C.today, C.ifNever, C.chipRun, C.chipCondition, C.historyCantRead,
                    "\(C.taskRow) · \(C.taskOnce)"]
        ours += C.fires.values.sorted() + C.readyAgain.values.sorted()
        for sentence in ours {
            XCTAssertTrue(says(sentence), "the web's CONDITION_COPY does not say \(sentence)")
        }
    }

    /// Every label is English (CLAUDE.md §5).
    func testEveryLabelIsEnglish() {
        for sentence in ConditionCopy.all + Array(ScheduleConditionCopy.contract.values) {
            XCTAssertFalse(sentence.unicodeScalars.contains { (0x3000...0x9FFF).contains($0.value) }, sentence)
        }
    }
}
