import Foundation
import XCTest
@testable import OrbitKit

/// The runner's line about a finished commit, as the macOS client reads it.
///
/// A commit can land while background jobs are still writing in the checkout; the runner says so in
/// `commitResultMessage` beside the terminal `commitStatus`, and the app shows it under the toast
/// headline ("Changes committed" / "No changes to commit"). Two things have to hold for that, and
/// both are pinned here: the DTO must READ the field, and it must not REQUIRE it — the field is
/// newer than the control planes in the wild, and a client that failed to decode a session detail
/// without it would lose the whole console, not one line.
///
/// Whether anything actually SHOWS the value is a separate question, asked in
/// `WorktreeCommitToastWiringTests`: `WorktreeModel` is compiled only by the macOS and iOS jobs.
final class CommitResultMessageTests: XCTestCase {

    /// A stand-in for whatever the runner sends — deliberately not one of the wordings in flight, so
    /// this cannot pass by matching copy that happens to live in either client.
    private static let runnerLine =
        "committed while a background job was still writing in the checkout (bgj_01a02fe3)"

    /// One field of the REAL decoded DTO, read back through the wire rather than through
    /// `detail.commitResultMessage`.
    ///
    /// A spec that names the property cannot compile on a tree where the property does not exist
    /// yet, and a build error is not a negative control: it proves the code is missing, not that
    /// this test can see it missing. Decode-then-encode keeps this file compiling on both trees, so
    /// a DTO that drops the field lands as an assertion failure instead.
    private func wireField(_ detail: SessionDetail, _ name: String) throws -> Any? {
        let data = try JSONEncoder().encode(detail)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return object?[name]
    }

    func testSessionDetailReadsTheRunnerLine() throws {
        let json = #"{"id":"s1","commitStatus":"committed","commitResultMessage":"\#(Self.runnerLine)"}"#
        let detail = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))

        XCTAssertEqual(detail.commitStatus, "committed")
        XCTAssertEqual(try wireField(detail, "commitResultMessage") as? String, Self.runnerLine,
                       "the app cannot show a line the DTO dropped on the floor")
    }

    func testSessionDetailDecodesWithoutTheKey() throws {
        // An older control plane omits the field entirely. Decoding must SUCCEED and read as "the
        // runner said nothing" — throwing here would take the whole session detail with it, worktree
        // bar included, for a line that was only ever decoration.
        let json = #"{"id":"s2","commitStatus":"nochange","changedFiles":[]}"#
        let detail = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))

        XCTAssertEqual(detail.commitStatus, "nochange")
        XCTAssertNil(try wireField(detail, "commitResultMessage"))
    }

    func testSessionDetailDecodesExplicitNull() throws {
        let json = #"{"id":"s3","commitStatus":"committed","commitResultMessage":null}"#
        let detail = try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))

        XCTAssertNil(try wireField(detail, "commitResultMessage"))
    }
}
