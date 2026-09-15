import Foundation
import XCTest
@testable import OrbitKit

/// `EngineErrors` is a hand-copied mirror of three predicates in @orbit/shared, and this is the
/// tripwire that keeps the copy honest.
///
/// Both files have carried a "keep in sync" note since they were written and nothing enforced it:
/// this client and the browser bundle share no compiler, so a marker added to one end simply never
/// appears on the other. On 2026-09-15 that bill came due. The shared half had grown a second
/// status pattern for the runtime's rejection wrapper ("API Error: Request rejected (429) · …")
/// and this end had kept one, so a single 429 drew an auto-retry card in the browser and a dead red
/// line on iOS — while the server, which runs the shared predicate, had already armed the re-send.
/// The client was not merely styling it differently; it was reporting that nobody was handling it.
///
/// So this reads the other end's source and compares what the two ends were copied from: the status
/// set, both marker lists, how far in the quota sentence may begin, and the status patterns in the
/// order they are tried. One test per constant, so a rename reds exactly the half that moved and
/// the failure says which half that was.
///
/// It compares declarations, not behaviour — `EngineErrorsTests` covers what the predicates decide.
/// Deliberately not compared: the prose around them, which may be reworded freely, and
/// `apiErrorBackoff`, whose timings mirror `retry.ts` and belong to the server's sweeper.
final class EngineErrorsParityTests: XCTestCase {

    private static let sharedEvents = "src/shared/src/events.ts"

    /// The repo root, found by walking up from this file until `events.ts` is under foot. Not a
    /// fixed number of `..` hops: how deep this test file sits is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(
                atPath: dir.appendingPathComponent(Self.sharedEvents).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`: a check that quietly opts out is a check
        // that reports green on exactly the day the thing it watches went missing.
        throw ParityError.noSource
    }

    private enum ParityError: Error, CustomStringConvertible {
        case noSource
        case notDeclared(String)

        var description: String {
            let events = EngineErrorsParityTests.sharedEvents
            switch self {
            case .noSource:
                return "\(events) was not found above this test file. EngineErrors is one half of a "
                    + "pair and this is the only thing holding the halves together; if the shared "
                    + "half moved, move this check with it rather than deleting it."
            case .notDeclared(let what):
                return "\(what) was not found in \(events). Either it was renamed — then rename it "
                    + "here too, which is what this check is for — or it is gone, and EngineErrors "
                    + "is now mirroring something that no longer exists."
            }
        }
    }

    /// The shared source with its whole-line comments dropped and adjacent string literals joined.
    ///
    /// The comments have to go first because they quote the very markers being read ("You've hit
    /// your usage limit", apostrophe and all), so a literal scan that trusts them reads a sentence
    /// out of a comment as a marker. And TypeScript wraps a long literal as `'…' + '…'` across
    /// lines: where that wrap falls is a formatting decision, while the words are the contract.
    private func flatEvents() throws -> String {
        let source = try String(contentsOf: try repoRoot().appendingPathComponent(Self.sharedEvents),
                                encoding: .utf8)
        return source
            .replacingOccurrences(of: "(?m)^[ \\t]*//[^\\n]*\\n", with: "",
                                  options: .regularExpression)
            .replacingOccurrences(of: "['\"]\\s*\\+\\s*['\"]", with: "", options: .regularExpression)
    }

    /// The one capture of `pattern`, or a failure naming what went missing rather than a green run
    /// comparing this end against nothing.
    private func capture(_ source: String, _ pattern: String, _ what: String) throws -> String {
        let re = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        let range = NSRange(source.startIndex..., in: source)
        guard let m = re.firstMatch(in: source, range: range), m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: source) else { throw ParityError.notDeclared(what) }
        return String(source[r])
    }

    /// Every capture of `pattern`, in source order.
    private func captures(_ source: String, _ pattern: String) throws -> [String] {
        let re = try NSRegularExpression(pattern: pattern)
        let range = NSRange(source.startIndex..., in: source)
        return re.matches(in: source, range: range).compactMap { m in
            guard m.numberOfRanges > 1, let r = Range(m.range(at: 1), in: source) else { return nil }
            return String(source[r])
        }
    }

    /// The entries of a shared `const NAME = [ … ]` list of plain single-quoted substrings.
    private func sharedStrings(_ name: String) throws -> [String] {
        let entries = try captures(try capture(try flatEvents(), "\(name) = \\[(.*?)\\]", name),
                                   "'([^']*)'")
        guard !entries.isEmpty else { throw ParityError.notDeclared("any entry in \(name)") }
        return entries
    }

    // MARK: what the two ends were copied from

    /// Which statuses are the provider's fault rather than the request's. A status on one end only
    /// is one client re-sending on the user's behalf while the other calls it a dead end.
    func testRetryableStatusesAreTheSameOnBothEnds() throws {
        let list = try capture(try flatEvents(),
                               "const RETRYABLE_API_ERROR_STATUSES = new Set\\(\\[(.*?)\\]\\)",
                               "RETRYABLE_API_ERROR_STATUSES")
        let shared = Set(try captures(list, "(\\d+)").compactMap(Int.init))
        guard !shared.isEmpty else {
            throw ParityError.notDeclared("any status in RETRYABLE_API_ERROR_STATUSES")
        }
        XCTAssertEqual(EngineErrors.retryableStatuses, shared,
                       "the retryable statuses drifted — first is EngineErrors.retryableStatuses "
                           + "(this client), second is RETRYABLE_API_ERROR_STATUSES in events.ts "
                           + "(the server and the browser). A status belongs on both ends or "
                           + "neither.")
    }

    /// The codeless phrasings, for a call that never reached a response to have a status. Order is
    /// not compared — both ends ask whether any marker appears — but membership is.
    func testRetryableMarkersAreTheSameOnBothEnds() throws {
        XCTAssertEqual(EngineErrors.retryableMarkers.sorted(),
                       try sharedStrings("RETRYABLE_API_ERROR_MARKERS").sorted(),
                       "the retryable markers drifted — first is EngineErrors.retryableMarkers "
                           + "(this client), second is RETRYABLE_API_ERROR_MARKERS in events.ts. A "
                           + "wording only one end knows is a transport failure one end retries "
                           + "and the other hands back.")
    }

    /// The quota sentences. One end knowing a phrasing the other does not is a spent quota shown as
    /// a card here and as the agent apparently saying it there.
    func testUsageLimitMarkersAreTheSameOnBothEnds() throws {
        XCTAssertEqual(EngineErrors.usageLimitMarkers.sorted(),
                       try sharedStrings("USAGE_LIMIT_ERROR_MARKERS").sorted(),
                       "the usage-limit markers drifted — first is EngineErrors.usageLimitMarkers "
                           + "(this client), second is USAGE_LIMIT_ERROR_MARKERS in events.ts, "
                           + "which is also the SQL `contains` filter the server selects on.")
    }

    /// How far in the sentence may begin. The number is the whole difference between reading a
    /// spent quota and reading a reply that mentions one, so a client with a laxer allowance turns
    /// an ordinary answer into a card saying the opposite of what the answer says.
    func testTheUsageLimitOffsetIsTheSameOnBothEnds() throws {
        let declared = try capture(try flatEvents(),
                                   "const USAGE_LIMIT_MARKER_MAX_OFFSET = (\\d+)",
                                   "USAGE_LIMIT_MARKER_MAX_OFFSET")
        guard let shared = Int(declared) else {
            throw ParityError.notDeclared("a number for USAGE_LIMIT_MARKER_MAX_OFFSET")
        }
        XCTAssertEqual(EngineErrors.usageLimitMaxOffset, shared,
                       "the usage-limit offset drifted — first is EngineErrors.usageLimitMaxOffset "
                           + "(this client), second is USAGE_LIMIT_MARKER_MAX_OFFSET in events.ts.")
    }

    /// The status patterns, in the order they are tried. This is the pair that actually drifted:
    /// the shared half grew the rejection wrapper's pattern and this end kept only the raw dump's,
    /// so the commonest rejection of all — a 429 — matched no marker here and became a red line
    /// while the server was already re-sending it. Compared as source, count included: a pattern
    /// that stops compiling is dropped by `try?` and would otherwise vanish silently.
    func testTheStatusPatternsAreTheSameOnBothEnds() throws {
        let body = try capture(try flatEvents(),
                               "export function isRetryableApiErrorText[^\\n]*\\{(.*?)\\n\\}",
                               "isRetryableApiErrorText")
        let shared = try captures(body, "lower\\.match\\(/(.+?)/\\)")
        guard !shared.isEmpty else {
            throw ParityError.notDeclared("any lower.match(/…/) inside isRetryableApiErrorText")
        }
        let mine = EngineErrors.statusPatterns.map(\.pattern)
        XCTAssertEqual(mine, shared,
                       "the status patterns drifted (\(mine.count) here, \(shared.count) in "
                           + "events.ts) — first is EngineErrors.statusPatterns, second is the "
                           + "lower.match(/…/) calls in isRetryableApiErrorText, in the order each "
                           + "end tries them. A shape only the shared half reads is one this "
                           + "client reports as unhandled while the server retries it.")
    }
}
