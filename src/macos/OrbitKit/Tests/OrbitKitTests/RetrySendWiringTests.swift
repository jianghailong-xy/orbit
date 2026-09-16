import Foundation
import XCTest
@testable import OrbitKit

/// The wire between a retry and the send path it goes through.
///
/// The retry of the last user turn rides `ConsoleModel.send` for that path's gating, queueing and
/// failure handling — but it has to reach it as the message itself, never by being typed into the
/// composer first: on the native clients the composer sits on screen in front of the reader, so a
/// retry that goes through it is the message flashing through the input field on its way out (and
/// any draft already in there having to be moved aside and put back). Web has no such step — its
/// card calls the send mutation with the text directly.
///
/// No compiler here checks any of that: SwiftUI does not exist on Linux, and `ConsoleModel.swift`
/// is compiled only by the macOS and iOS jobs. So it is asserted over the source, the way
/// `EvidenceDecisionWiringTests` does, and each assertion is written so that PUTTING THE TEXT BACK
/// INTO THE COMPOSER is what turns it red.
final class RetrySendWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with "
                    + "it rather than deleting it: it is the only gate on Linux that sees whether a "
                    + "retry still reaches the send path without going through the composer."
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

    /// One stretch of a file — from a marker to the next occurrence of another — so a match
    /// somewhere else cannot answer for the part being asserted about. (A bare `contains` over a
    /// whole file is how a scan like this goes falsely green.)
    private func section(_ source: String, from: String, to: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw WiringError.missing("\(from) … \(to)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The retry hands its message over instead of typing it in.
    func testTheRetryHandsItsMessageToTheSendPath() throws {
        let retry = try section(try source(Self.consolePath),
                                from: "func retryLastMessage() async {",
                                to: "// MARK: auto-retry")
        XCTAssertTrue(retry.contains("await send(overrideText: text)"),
                      "the last user message goes to the send path as the message")
        XCTAssertFalse(retry.contains("composerText ="),
                       "and never into the composer: text landing in the input field before it is "
                           + "sent is the bug this test exists for")
    }

    /// …and the send path leaves the composer alone for a message it was handed that way.
    func testAnOverrideSendNeitherReadsNorClearsTheComposer() throws {
        let send = try section(try source(Self.consolePath),
                               from: "func send(authoritative: RunStatus? = nil, overrideText: String? = nil) async {",
                               to: "var lastUserMessageText")
        XCTAssertTrue(send.contains("ComposerLogic.parseShell(overrideText ?? composerText)"),
                      "an override send parses what it was handed, not what the composer holds")
        for line in send.split(separator: "\n") where line.contains("composerText = \"\"") {
            XCTAssertTrue(line.contains("fromComposer"),
                          "unguarded clear in send() — a retry would take the reader's draft with "
                              + "it: \(line.trimmingCharacters(in: .whitespaces))")
        }
        XCTAssertTrue(send.contains("let draft = overrideText ?? composerText"),
                      "a send that fails hands back what it consumed, which for a retry is the "
                          + "retried text rather than whatever the composer was holding")
    }
}
