import Foundation
import XCTest
@testable import OrbitKit

/// The composer's Stop asks for more than an interrupt: the background work the session left
/// running goes with the turn (see `SessionStopRequest`). Two things hold that together, and
/// neither is checkable by the compiler on this host:
///
///   1. The request's shape — the flag is the whole ask, and it must not be sent by callers that
///      did not ask for it (a plain interrupt kills nothing; that is the difference from `end`).
///   2. The wiring — `ConsoleModel.interrupt` is the Stop button, and it is the one caller that
///      passes the flag. `ConsoleModel.swift` is compiled only by the macOS and iOS jobs, so it is
///      asserted over the source, the way `RetrySendWiringTests` does.
final class StopBackgroundWorkWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether "
                    + "Stop still asks the runner to end the session's background work."
            }
        }
    }

    private static let consolePath = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw WiringError.missing(relative)
    }

    func testTheStopRequestBodyIsTheExplicitFlag() throws {
        let json = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(SessionStopRequest())) as? [String: Any]

        // Exactly the browser's field (SessionInterruptDto.stopBackgroundWork), and nothing else:
        // a body like this is only ever sent by a caller that asked for the kill.
        XCTAssertEqual(json?["stopBackgroundWork"] as? Bool, true)
        XCTAssertEqual(json?.count, 1)
    }

    func testTheStopButtonAsksForTheBackgroundWork() throws {
        let text = try source(Self.consolePath)
        guard let start = text.range(of: "func interrupt() async {"),
              let end = text.range(of: "}", range: start.upperBound..<text.endIndex) else {
            throw WiringError.missing("ConsoleModel.interrupt")
        }
        let body = text[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(
            body.contains("stopBackgroundWork: true"),
            "the composer's Stop must ask the runner to end the session's background work too; "
                + "without the flag it is a plain interrupt, which kills nothing")
        XCTAssertTrue(
            body.contains("api.interrupt(sessionID:"),
            "Stop must still go through APIClient.interrupt")
    }

    /// The other direction, and the one that protects `interrupt ≠ end`: the caller that redirects
    /// a turn instead of stopping it must not inherit the kill.
    func testInterruptAndSendDoesNotAskForIt() throws {
        let text = try source(Self.consolePath)
        guard let start = text.range(of: "func interruptAndSend() async {"),
              let end = text.range(of: "\n    func ", range: start.upperBound..<text.endIndex) else {
            throw WiringError.missing("ConsoleModel.interruptAndSend")
        }
        let body = text[start.lowerBound..<end.lowerBound]

        XCTAssertFalse(
            body.contains("stopBackgroundWork"),
            "interrupt-and-send is a redirect, not a Stop: it must keep the follow-up's own shape")
    }
}
