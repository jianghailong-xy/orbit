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

    // MARK: server-shaped payloads (Tests/Fixtures/owner-request-change, see its README)

    private func fixture(_ name: String) throws -> Data {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("Fixtures/owner-request-change/\(name)")
            if let data = try? Data(contentsOf: candidate) { return data }
            dir = dir.deletingLastPathComponent()
        }
        XCTFail("fixture \(name) not found"); throw CocoaError(.fileNoSuchFile)
    }

    func testThePendingListFromTheServerDecodes() throws {
        let list = try JSONDecoder().decode(OwnerRequestList.self, from: try fixture("2-open-pending.json"))
        let request = try XCTUnwrap(list.requests.first)
        XCTAssertEqual(list.requests.count, 1)
        XCTAssertEqual(request.kind, .change)
        XCTAssertEqual(request.state, .pending)
        XCTAssertEqual(request.changeSpec?.field, "maxConcurrent")
        XCTAssertEqual(request.changeSpec?.requested, 4)
        XCTAssertEqual(request.changeSpec?.before, 6)
        XCTAssertEqual(request.changeSpec?.runnerId, "64k7HtPDIS1EnOM5W4p8ky")
        XCTAssertNil(request.answer)
        // The live value is above the request: the lowering line.
        XCTAssertEqual(ChangeCopy.effect(value: 4, live: 6), "Nothing running stops. New sessions wait until fewer than 4 run.")
    }

    func testTheRunnerRowFromTheServerCarriesTheLiveValue() throws {
        let runners = try JSONDecoder().decode([Runner].self, from: try fixture("3-runners.json"))
        XCTAssertEqual(runners.first?.name, "HPC")
        XCTAssertEqual(runners.first?.maxConcurrent, 6)
        XCTAssertEqual(runners.first?.activeSessions, 1)
        let patched = try JSONSerialization.jsonObject(with: try fixture("4-runner-patched-response.json")) as? [String: Any]
        XCTAssertEqual(patched?["maxConcurrent"] as? Int, 5)
    }

    func testTheApplyBodyIsTheOneTheServerTook() throws {
        let sent = try JSONEncoder().encode(OwnerRequestApplyBody(maxConcurrent: 3))
        XCTAssertEqual(String(data: sent, encoding: .utf8), String(data: try fixture("6-apply-request.json"), encoding: .utf8))
    }

    func testTheAppliedAnswerFromTheServerReadsAsApplied() throws {
        for name in ["6-applied-response.json"] {
            let request = try JSONDecoder().decode(OwnerRequest.self, from: try fixture(name))
            XCTAssertEqual(request.state, .done)
            XCTAssertEqual(request.answer?.applied, 3)
            XCTAssertEqual(request.answer?.actualBefore, 5)
            XCTAssertEqual(OwnerRequests.outcomeLine(request, runner: "HPC"), "Applied: HPC Max Concurrent 5 \u{2192} 3 (asked for 4)")
        }
        let list = try JSONDecoder().decode(OwnerRequestList.self, from: try fixture("7-list-done.json"))
        XCTAssertEqual(list.requests.first?.answer?.applied, 3)
        XCTAssertEqual(list.requests.first?.answer?.actualBefore, 5)
        XCTAssertEqual(list.requests.first?.changeSpec?.requested, 4)
    }
}
