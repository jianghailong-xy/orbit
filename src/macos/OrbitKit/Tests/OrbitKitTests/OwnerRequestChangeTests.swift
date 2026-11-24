import Foundation
import XCTest
@testable import OrbitKit

/// The CHANGE kind on the Apple clients: the wire shape, the card's rules, and the same English as the web card.
final class OwnerRequestChangeTests: XCTestCase {
    private let pending = #"""
    {"id":"r1","kind":"CHANGE","state":"PENDING","title":"Raise HPC to 6","why":"Builds queue up",
     "askedBySessionId":"s1","createdAt":"2026-11-24T00:00:00Z",
     "changeSpec":{"runnerId":"run1","field":"maxConcurrent","requested":6,"before":4}}
    """#

    func testChangeSpecDecodes() throws {
        let request = try JSONDecoder().decode(OwnerRequest.self, from: Data(pending.utf8))
        XCTAssertEqual(request.kind, .change)
        XCTAssertEqual(request.changeSpec, OwnerRequestChangeSpec(runnerId: "run1", requested: 6, before: 4))
    }

    func testEndedAnswerDecodesAndReadsAsApplied() throws {
        let ended = pending.replacingOccurrences(of: #""state":"PENDING""#, with: #""state":"DONE""#)
            .replacingOccurrences(of: #""createdAt""#, with: #""answer":{"applied":5,"actualBefore":3},"createdAt""#)
        let request = try JSONDecoder().decode(OwnerRequest.self, from: Data(ended.utf8))
        XCTAssertEqual(OwnerRequests.outcomeLine(request, runner: "HPC"), "Applied: HPC Max Concurrent 3 → 5 (asked for 6)")
    }

    func testApplyBodyEncodes() throws {
        let data = try JSONEncoder().encode(OwnerRequestApplyBody(maxConcurrent: 6))
        XCTAssertEqual(String(data: data, encoding: .utf8), #"{"maxConcurrent":6}"#)
    }

    func testTheCardsRules() {
        XCTAssertEqual(OwnerRequests.kindTag(.change), "SETTING")
        XCTAssertEqual(OwnerRequests.primaryLabel(.change), "Apply")
        XCTAssertEqual(ChangeCopy.effect(value: 2, live: 4), "Nothing running stops. New sessions wait until fewer than 2 run.")
        XCTAssertEqual(ChangeCopy.effect(value: 6, live: 4), "Up to 6 sessions can run at once on this machine.")
        XCTAssertNil(ChangeCopy.effect(value: 4, live: 4))
        XCTAssertEqual(ChangeCopy.applied(runner: "HPC", from: 4, to: 6, requested: 6), "Applied: HPC Max Concurrent 4 → 6")
    }

    /// Every string the card says is looked up in the web card's source; a missing counterpart is a failure.
    func testTheCardSaysWhatTheWebCardSays() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var web: String?
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/web/src/lib/ownerRequests.ts")
            if let text = try? String(contentsOf: candidate, encoding: .utf8) { web = text; break }
            dir = dir.deletingLastPathComponent()
        }
        let source = try XCTUnwrap(web, "lib/ownerRequests.ts was not found above this test file")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let says = [
            "tag: '\(ChangeCopy.tag)'",
            "primary: '\(ChangeCopy.primary)'",
            "setting: (runner: string) => `${runner} · Max Concurrent`",
            "runningNow: (n: number) => `${n} running now`",
            "wasWhenAsked: (before: number) => `Was ${before} when asked.`",
            "lowering: (n: number) => `Nothing running stops. New sessions wait until fewer than ${n} run.`",
            "raising: (n: number) => `Up to ${n} sessions can run at once on this machine.`",
            "numberLabel: '\(ChangeCopy.numberLabel)'",
            "`Applied: ${runner} Max Concurrent ${from} → ${to}${to !== requested ? ` (asked for ${requested})` : ''}`",
            "CHANGE: 'SETTING'",
        ]
        for literal in says { XCTAssertTrue(source.contains(literal), "the web card no longer says \(literal)") }
        // And the Swift side renders those templates to the same words.
        XCTAssertEqual(ChangeCopy.setting("HPC"), "HPC · Max Concurrent")
        XCTAssertEqual(ChangeCopy.runningNow(2), "2 running now")
        XCTAssertEqual(ChangeCopy.wasWhenAsked(4), "Was 4 when asked.")
    }
}
