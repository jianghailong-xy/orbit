import Foundation
import XCTest
@testable import OrbitKit

/// The scheduled tasks say on iOS and macOS what they say on the web (CLAUDE.md §5). The words are defined once,
/// in the shared `SCHEDULE_COPY` (src/shared/src/schedule.ts), which `scheduleContract.spec.ts` holds to
/// contracts/schedule.contract.json; this holds `ScheduleCopy` to the same contract, both ways, and the display
/// rules to the contract's `boardPhrases` — the boards' words with the inputs that must produce them.
///
/// Each half is a failure, never an `XCTSkip`, when its counterpart goes missing.
final class ScheduleCopyParityTests: XCTestCase {
    private static let contractPath = "contracts/schedule.contract.json"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The schedule's words are one half of a pair; if the other "
                + "half moved, move this check with it rather than deleting it."
        }
    }

    private func contract() throws -> JSONValue {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(Self.contractPath)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: candidate))
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: Self.contractPath)
    }

    /// `copy`, flattened to `group.key[.key…]`, arrays by index.
    private func flatten(_ value: JSONValue, _ path: String, into out: inout [String: String]) {
        switch value {
        case .string(let s): out[path] = s
        case .object(let o): for (k, v) in o { flatten(v, path.isEmpty ? k : "\(path).\(k)", into: &out) }
        case .array(let a): for (i, v) in a.enumerated() { flatten(v, "\(path).\(i)", into: &out) }
        default: XCTFail("\(path) is not a sentence")
        }
    }

    func testEverySentenceOfTheContractIsHereWordForWord() throws {
        guard let copy = try contract()["copy"] else { return XCTFail("the contract has no copy") }
        var flat: [String: String] = [:]
        flatten(copy, "", into: &flat)
        XCTAssertGreaterThan(flat.count, 200, "the contract's copy was read")
        for (path, sentence) in flat.sorted(by: { $0.key < $1.key }) {
            XCTAssertEqual(ScheduleCopy.contract[path], sentence, "copy.\(path)")
        }
        for path in ScheduleCopy.contract.keys.sorted() where flat[path] == nil {
            XCTFail("ScheduleCopy holds \(path), which the contract no longer has")
        }
    }

    /// The closed sets the clients switch on: every state, reason and kind has its words, and the Swift lists are
    /// the contract's.
    func testEveryClosedSetMemberHasItsWords() throws {
        let sets = try XCTUnwrap(try contract()["closedSets"])
        func list(_ name: String) -> [String] {
            guard case .array(let a)? = sets[name] else { XCTFail("closedSets.\(name)"); return [] }
            return a.compactMap(\.stringValue)
        }
        XCTAssertEqual(Set(list("runStates")), Set(ScheduleCopy.runStates.keys))
        XCTAssertEqual(Set(list("failureReasons")), Set(ScheduleCopy.failureReasons.keys))
        XCTAssertEqual(Set(list("heldReasons")), Set(ScheduleCopy.heldReasons.keys))
        XCTAssertEqual(Set(list("heldReasons")), Set(ScheduleCopy.heldShort.keys))
        XCTAssertEqual(Set(list("endedReasons")), Set(ScheduleCopy.endedReasons.keys))
        XCTAssertEqual(Set(list("accessLevels")), Set(ScheduleCopy.access.keys))
        XCTAssertEqual(Set(list("envelopeParts")), Set(ScheduleCopy.EnvelopeCard.titles.keys))
        XCTAssertEqual(Set(list("changedBy")), Set(ScheduleCopy.History.who.keys).subtracting(["ALLOWED"]))
        XCTAssertEqual(list("weekdays"), ScheduleDisplay.weekdayOrder)
        XCTAssertEqual(Set(list("weekdays")), Set(ScheduleCopy.weekdays.keys))
        XCTAssertEqual(list("waitingKinds"), ScheduleWaitingItem.kinds)
        XCTAssertEqual(list("circles"), ScheduleDisplay.Circle.allCases.map(\.rawValue))
    }
}

/// The contract was not found: a failure naming it, never a skip (CrossClientChecksNeverSkipTests).
private struct ScheduleContractMissing: Error, CustomStringConvertible {
    var description: String { "contracts/schedule.contract.json was not found above this test file" }
}

/// The contract's `boardPhrases`: each phrase as a board shows it, with the input that must produce it. The web's
/// rules are held to the same list by `scheduleContract.spec.ts`, so the two clients say one thing.
final class ScheduleBoardPhraseTests: XCTestCase {
    private func phrases() throws -> JSONValue {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("contracts/schedule.contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                let contract = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: candidate))
                return try XCTUnwrap(contract["boardPhrases"])
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ScheduleContractMissing()
    }

    private func rows(_ name: String) throws -> [JSONValue] {
        guard case .array(let a)? = try phrases()[name] else {
            XCTFail("boardPhrases.\(name) is missing")
            return []
        }
        XCTAssertFalse(a.isEmpty, "boardPhrases.\(name) is empty")
        return a
    }

    private func object(_ v: JSONValue?) -> [String: JSONValue]? {
        if case .object(let o)? = v { return o }
        return nil
    }

    private func strings(_ v: JSONValue?) -> [String] {
        if case .array(let a)? = v { return a.compactMap(\.stringValue) }
        return []
    }

    func testRules() throws {
        for row in try rows("rules") {
            let rule = try XCTUnwrap(ScheduleRule(json: row["rule"]))
            let form: ScheduleDisplay.RuleForm = row["form"]?.stringValue == "long" ? .long : .short
            XCTAssertEqual(ScheduleDisplay.ruleText(rule, form: form), row["text"]?.stringValue,
                           row["board"]?.stringValue ?? "")
        }
    }

    func testCostsAllowedUsageAndMay() throws {
        for row in try rows("costs") {
            let parts = ScheduleDisplay.costsParts(runsPerWeek: row["runsPerWeek"]!.intValue!,
                                                   runLimitMinutes: row["runLimitMinutes"]!.intValue!)
            XCTAssertEqual(parts.text, row["text"]?.stringValue)
            XCTAssertEqual(parts.emphasis, row["emphasis"]?.stringValue)
            XCTAssertEqual(parts.before + parts.emphasis + parts.after, parts.text)
        }
        for row in try rows("allowed") {
            XCTAssertEqual(ScheduleDisplay.allowedText(runsPerWeek: row["runsPerWeek"]!.intValue!,
                                                       runLimitMinutes: row["runLimitMinutes"]!.intValue!),
                           row["text"]?.stringValue)
        }
        for row in try rows("usage") {
            XCTAssertEqual(ScheduleDisplay.usageText(runs: row["runs"]!.intValue!, minutes: row["minutes"]!.intValue!),
                           row["text"]?.stringValue)
        }
        for row in try rows("may") {
            XCTAssertEqual(ScheduleDisplay.mayText(row["accessLevel"]!.stringValue!), row["text"]?.stringValue)
        }
    }

    func testEnvelopeCards() throws {
        for row in try rows("envelope") {
            let board = row["board"]?.stringValue ?? ""
            let widens = strings(row["widens"])
            let now = ScheduleEnvelope(json: row["now"])
            let asked = try XCTUnwrap(ScheduleEnvelope(json: row["asked"]))
            let ruleNow = ScheduleRule(json: row["ruleNow"])
            let ruleAsked = ScheduleRule(json: row["ruleAsked"])
            let sides = ScheduleDisplay.envelopeSides(widens: widens, now: now, asked: asked, ruleNow: ruleNow,
                                                      ruleAsked: ruleAsked)
            XCTAssertEqual(ScheduleDisplay.envelopeTitle("Codex stable check", widens: widens), row["title"]?.stringValue, board)
            XCTAssertEqual(sides.now?.text, row["nowText"]?.stringValue, board)
            XCTAssertEqual(sides.asked.text, row["askedText"]?.stringValue, board)
            XCTAssertEqual(sides.asked.lead, row["askedLead"]?.stringValue, board)
            XCTAssertEqual(ScheduleDisplay.keepLabel(widens: widens, now: now), row["keep"]?.stringValue, board)
            XCTAssertEqual(ScheduleDisplay.envelopeNote(widens: widens), row["note"]?.stringValue, board)
            if let reason = row["waitingReason"]?.stringValue {
                XCTAssertEqual(ScheduleDisplay.widenWaitingText(reason: reason, widens: widens, now: now, asked: asked,
                                                                ruleNow: ruleNow, ruleAsked: ruleAsked),
                               row["waitingBody"]?.stringValue, board)
            }
        }
    }

    /// The phone's timeline rows (iOS board 01 ② ⑧): `schedulePhoneRowLine`'s phrases.
    func testPhoneRows() throws {
        for row in try rows("phoneRows") {
            let s = try XCTUnwrap(object(row["schedule"]))
            let opts = object(row["opts"]) ?? [:]
            XCTAssertEqual(ScheduleDisplay.phoneRowLine(rule: try XCTUnwrap(ScheduleRule(json: s["rule"])),
                                                        workspaceName: s["workspaceName"]?.stringValue,
                                                        accessLevel: s["accessLevel"]?.stringValue ?? "CHECK_ONLY",
                                                        state: s["state"]?.stringValue ?? "ACTIVE",
                                                        heldReason: s["heldReason"]?.stringValue,
                                                        runningMinutes: opts["runningMinutes"]?.intValue,
                                                        draft: opts["draft"]?.boolValue ?? false),
                           row["text"]?.stringValue, row["board"]?.stringValue ?? "")
        }
    }

    func testHistoryAndTheChangeLine() throws {
        for row in try rows("history") {
            let board = row["board"]?.stringValue ?? ""
            let before = object(row["before"])
            let after = try XCTUnwrap(object(row["after"]))
            let revision = row["revision"]?.intValue ?? 2
            let changedBy = row["changedBy"]!.stringValue!
            XCTAssertEqual(ScheduleDisplay.recordParts(revision: revision, before: before, after: after).text,
                           row["text"]?.stringValue, board)
            XCTAssertEqual(ScheduleDisplay.historyWho(changedBy: changedBy, before: before, after: after).text,
                           row["who"]?.stringValue, board)
            if let line = row["line"]?.stringValue {
                let title = row["title"]?.stringValue ?? "Codex stable check"
                XCTAssertEqual(ScheduleDisplay.changeLineText(title: title, revision: revision, changedBy: changedBy,
                                                              before: before, after: after), line, board)
            }
        }
    }
}
