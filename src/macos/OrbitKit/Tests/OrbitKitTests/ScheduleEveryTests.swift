import Foundation
import XCTest
@testable import OrbitKit

/// Sub-daily schedules (design §9.2, §9.3): an EVERY rule decodes here, still decodes in the builds shipped before
/// it (as a weekly rule, never a list they cannot read), and its sentence, planned end and collapsed missed row
/// read as the web's do.
final class ScheduleEveryTests: XCTestCase {
    private static let everyJSON = """
    {"kind":"EVERY","minutes":30,"time":"09:00","until":"18:00","weekdays":["MON","TUE","WED","THU","FRI"]}
    """

    /// The rule decoder the shipped macOS and iOS builds carry: an unknown kind is read as WEEKLY, and a rule
    /// without `time` throws, which fails the whole schedule list. Kept word for word as it shipped.
    private enum ShippedRule: Decodable, Equatable {
        case once(at: String)
        case daily(time: String)
        case weekly(time: String, weekdays: [String])
        case when

        private enum CodingKeys: String, CodingKey { case kind, at, time, weekdays }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            switch try c.decode(String.self, forKey: .kind) {
            case "ONCE": self = .once(at: try c.decode(String.self, forKey: .at))
            case "DAILY": self = .daily(time: try c.decode(String.self, forKey: .time))
            case "WHEN": self = .when
            default:
                self = .weekly(time: try c.decode(String.self, forKey: .time),
                               weekdays: (try? c.decode([String].self, forKey: .weekdays)) ?? [])
            }
        }
    }

    func testAnEveryRuleDecodesToEvery() throws {
        let rule = try JSONDecoder().decode(ScheduleRule.self, from: Data(Self.everyJSON.utf8))
        XCTAssertEqual(rule, .every(minutes: 30, time: "09:00", until: "18:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"]))
        let again = try JSONDecoder().decode(ScheduleRule.self, from: JSONEncoder().encode(rule))
        XCTAssertEqual(again, rule)
        XCTAssertEqual(rule.time, "09:00")
    }

    func testTheSameJSONDecodesThroughTheShippedWeeklyFallback() throws {
        let old = try JSONDecoder().decode(ShippedRule.self, from: Data(Self.everyJSON.utf8))
        XCTAssertEqual(old, .weekly(time: "09:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"]))
    }

    func testAScheduleListWithAnEveryRuleStillDecodes() throws {
        let json = """
        {"schedules":[{"id":"s1","title":"Poll","workspaceId":"w1","rule":\(Self.everyJSON),
         "endAt":"2026-11-27T10:00:00.000Z","maxRuns":20,"runsLeft":3,"createdAt":"2026-11-20T00:00:00.000Z"},
        {"id":"s2","title":"Daily","workspaceId":"w1","rule":{"kind":"DAILY","time":"10:00"}}]}
        """
        let list = try JSONDecoder().decode(ScheduleListResponse.self, from: Data(json.utf8))
        XCTAssertEqual(list.schedules.count, 2)
        XCTAssertEqual(list.schedules[0].maxRuns, 20)
        XCTAssertEqual(list.schedules[0].runsLeft, 3)
    }

    func testTheEverySentence() {
        func text(_ minutes: Int, _ time: String, _ until: String?, _ days: [String]) -> String {
            ScheduleDisplay.ruleText(.every(minutes: minutes, time: time, until: until, weekdays: days))
        }
        let all = ScheduleDisplay.weekdayOrder
        XCTAssertEqual(text(30, "09:00", "18:00", ["MON", "TUE", "WED", "THU", "FRI"]), "Every 30 min, 09:00–18:00, Mon–Fri")
        XCTAssertEqual(text(60, "00:00", nil, all), "Every hour")
        XCTAssertEqual(text(120, "08:00", nil, ["SAT", "SUN"]), "Every 2 hours from 08:00, weekends")
        XCTAssertEqual(text(240, "00:00", nil, ["MON", "THU"]), "Every 4 hours, Mon, Thu")
    }

    func testThePlannedEndLine() {
        let now = ScheduleDisplay.parse("2025-11-14T04:19:00.000Z")!
        let tz = "Asia/Shanghai"
        func end(_ at: String?, _ max: Int? = nil, _ left: Int? = nil) -> String? {
            ScheduleDisplay.endText(endAt: at, maxRuns: max, runsLeft: left, now: now, timezone: tz)
        }
        XCTAssertEqual(end("2025-11-14T10:00:00.000Z"), "until 18:00 today")
        XCTAssertEqual(end("2025-11-15T02:00:00.000Z"), "until 10:00 tomorrow")
        XCTAssertEqual(end("2025-11-25T02:00:00.000Z"), "until Nov 25")
        XCTAssertEqual(end(nil, 20, 3), "3 runs left")
        XCTAssertEqual(end(nil, 20, 1), "1 run left")
        XCTAssertEqual(end("2025-11-25T02:00:00.000Z", 20, 3), "until Nov 25 · 3 runs left")
        XCTAssertNil(end(nil))
    }

    func testMissedRangeSpanningDaysCarriesDates() {
        func run(_ id: String, _ at: String) -> ScheduleRunView { ScheduleRunView(id: id, scheduleId: "s", plannedAt: at, state: "MISSED") }
        XCTAssertEqual(ScheduleDisplay.missedText([run("a", "2025-11-19T22:00:00Z"), run("b", "2025-11-20T06:30:00Z")], timezone: "UTC"),
                       "2 slots missed, Nov 19, 22:00–Nov 20, 06:30")
        XCTAssertEqual(ScheduleDisplay.missedText([run("a", "2025-11-20T01:00:00Z"), run("b", "2025-11-20T08:30:00Z")], timezone: "UTC"),
                       "2 slots missed, 01:00–08:30")
    }

    func testMissedSlotsCollapseIntoOneRow() {
        func run(_ id: String, _ local: String, _ state: String) -> ScheduleRunView {
            ScheduleRunView(id: id, scheduleId: "s1", plannedAt: ScheduleDisplayTests.sh(local), state: state)
        }
        // Newest first, as a run list reads.
        let runs = [run("r5", "2025-11-14T09:00", "NO_CHANGE"),
                    run("r4", "2025-11-14T08:30", "MISSED"), run("r3", "2025-11-14T04:00", "MISSED"),
                    run("r2", "2025-11-14T01:00", "MISSED"),
                    run("r1", "2025-11-13T22:00", "NO_CHANGE"), run("r0", "2025-11-13T21:00", "MISSED")]
        let collapsed = ScheduleDisplay.collapseMissed(runs)
        XCTAssertEqual(collapsed.count, 4)
        guard case .missed(let streak) = collapsed[1] else { return XCTFail("the streak is one row") }
        XCTAssertEqual(streak.map(\.id), ["r4", "r3", "r2"])
        XCTAssertEqual(ScheduleDisplay.missedText(streak, timezone: ScheduleDisplayTests.tz), "3 slots missed, 01:00–08:30")
        XCTAssertEqual(collapsed[3], .run(runs[5]), "a single missed run stays a run")
    }

    func testTimelineShowsAMissedStreakAsOneRow() {
        func run(_ id: String, _ local: String) -> ScheduleRunView {
            ScheduleRunView(id: id, scheduleId: "s1", plannedAt: ScheduleDisplayTests.sh(local), state: "MISSED")
        }
        let schedule = ScheduleView(id: "s1", title: "Check disk", rule: .daily(time: "01:00"), timezone: ScheduleDisplayTests.tz,
                                  workspaceId: "w1", workspaceName: "apiserver", accessLevel: "CHECK_ONLY", state: "ACTIVE",
                                  heldReason: nil, nextDueAt: nil, consecutiveFailures: 0)
        let runs = [run("r1", "2025-11-14T01:00"), run("r2", "2025-11-14T02:00"),
                    run("r3", "2025-11-14T03:00"), run("r4", "2025-11-14T04:00")]
        let items = runs.map { ScheduleDisplay.TimelineItem.run(schedule, $0, at: $0.plannedAt) }
        let rows = ScheduleDisplay.collapseMissedItems(items)
        XCTAssertEqual(rows.count, 1)
        guard case .missed(_, let streak, let at) = rows[0] else { return XCTFail("the streak is one row") }
        XCTAssertEqual(streak.map(\.id), ["r1", "r2", "r3", "r4"])
        XCTAssertEqual(at, runs[3].plannedAt)
        XCTAssertEqual(ScheduleDisplay.missedText(streak, timezone: ScheduleDisplayTests.tz), "4 slots missed, 01:00–04:00")
        XCTAssertEqual(ScheduleDisplay.collapseMissedItems([items[0]]), [.item(items[0])], "one missed run stays a run")
    }
}
