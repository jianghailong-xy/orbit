import Foundation
import XCTest
@testable import OrbitKit

/// The wire between the runner's commit line and the toast the user reads.
///
/// `CommitResultMessageTests` proves the DTO reads `commitResultMessage`; it proves nothing about
/// whether anything shows it. `WorktreeModel` lives in the macOS-only OrbitApp target — SwiftUI
/// does not exist on Linux and no job here compiles that target — so the attachment is asserted
/// over the source, the way `CriteriaDecisionWiringTests` and `EvidenceDecisionWiringTests` do, and
/// each assertion is written so that DETACHING the wire is what turns it red.
///
/// What it cannot see is layout — that the detail line is legible, that the card is the right size.
/// That is what the beta and the screenshots are for.
final class WorktreeCommitToastWiringTests: XCTestCase {

    private enum WiringError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let what):
                return "\(what) was not found above this test. If it moved, move this check with it "
                    + "rather than deleting it: it is the only gate on Linux that sees whether a "
                    + "finished commit's card still carries the runner's line."
            }
        }
    }

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

    private static let modelPath = "src/macos/OrbitApp/Sources/OrbitApp/WorktreeModel.swift"

    /// One branch of `surfaceCompletedAction`'s commit ladder, so a match in a neighbouring branch
    /// cannot answer for it — a bare `contains` over the whole function is how a scan like this goes
    /// falsely green.
    private func branch(from: String, to: String) throws -> String {
        let file = try source(Self.modelPath)
        guard let start = file.range(of: from) else { throw WiringError.missing(from) }
        guard let end = file.range(of: to, range: start.upperBound..<file.endIndex) else {
            throw WiringError.missing("\(to) (after \(from))")
        }
        return String(file[start.lowerBound..<end.lowerBound])
    }

    /// Whitespace is formatting, not wiring: the assertion should survive the call being reflowed
    /// onto one line or three, and should still fail if the argument is dropped.
    private func flat(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private func committedBranch() throws -> String {
        try flat(branch(
            from: #"} else if old.commitStatus == "pending", new.commitStatus == "committed" {"#,
            to: #"} else if old.commitStatus == "pending", new.commitStatus == "nochange" {"#))
    }

    private func nochangeBranch() throws -> String {
        try flat(branch(
            from: #"} else if old.commitStatus == "pending", new.commitStatus == "nochange" {"#,
            to: "/// A failed action as a card"))
    }

    private func errorBranch() throws -> String {
        try flat(branch(
            from: #"} else if old.commitStatus == "pending", new.commitStatus == "error" {"#,
            to: #"} else if old.commitStatus == "pending", new.commitStatus == "committed" {"#))
    }

    func testASuccessfulCommitShowsTheRunnerLineUnderItsHeadline() throws {
        let branch = try committedBranch()
        XCTAssertTrue(
            branch.contains(#"message: "Changes committed", detail: Self.trimmed(new.commitResultMessage)"#),
            "the runner's own sentence about a commit that landed mid-write has to reach the card it "
                + "is about — attached to THIS headline, and trimmed so a blank line cannot draw an "
                + "empty row. Branch as written: \(branch)")
        XCTAssertFalse(branch.contains("commitError"),
                       "and it is the runner's line, not the git error: the two are different facts")
    }

    func testNoChangeShowsItTooAndStaysNeutral() throws {
        let branch = try nochangeBranch()
        XCTAssertTrue(
            branch.contains(#"message: "No changes to commit", detail: Self.trimmed(new.commitResultMessage)"#),
            "a commit that found nothing to commit still has something to say (which background jobs "
                + "were live while it looked), and the card is still neutral. Branch as written: \(branch)")
        XCTAssertTrue(branch.contains("tone: .neutral"),
                      "nothing failed here, so the card that says so must not change tone")
    }

    /// For an error, `commitResultMessage` is the runner's plain sentence about why and what to do
    /// (it is null for an error from an older runner), so the card leads with it and falls back to
    /// git's words — through the same `commitFailure` the bar renders, never a second reading of it.
    func testAFailedCommitLeadsWithTheRunnersPlainSentence() throws {
        let branch = try errorBranch()
        XCTAssertTrue(
            branch.contains("WorktreeBarLogic.commitFailure(commitStatus: new.commitStatus, "
                + "commitError: new.commitError, commitResultMessage: new.commitResultMessage)"),
            "the failure card has to read the failure the way the bar does. Branch as written: \(branch)")
        XCTAssertTrue(
            branch.contains(#"message: "Commit failed", detail: failure?.why, tone: .error"#),
            "and say it under THIS headline, in the error tone. Branch as written: \(branch)")
    }

    private static let barPath = "src/macos/OrbitApp/Sources/OrbitApp/Views/WorktreeBar.swift"

    /// The bar's failure panel is wired to the same reading, and its "Resolve in session" hands the
    /// failure to the session with the bar's own `why` — detaching either is what turns this red.
    func testTheBarsCommitFailurePanelIsWired() throws {
        let bar = flat(try source(Self.barPath))
        XCTAssertTrue(
            bar.contains("WorktreeBarLogic.commitFailure(commitStatus: d.commitStatus, "
                + "commitError: d.commitError, commitResultMessage: d.commitResultMessage)"),
            "the bar no longer reads a failed commit through WorktreeBarLogic.commitFailure")
        XCTAssertTrue(
            bar.contains("WorktreeCommitFailureView(console: console, failure: commitFailure, branch: branch)"),
            "the bar no longer renders the commit failure panel")
        XCTAssertTrue(
            bar.contains("console.worktree.resolveCommitInSession(branch: branch, why: failure.why)"),
            "\"Resolve in session\" no longer hands the failure to the session")
        let model = flat(try source(Self.modelPath))
        XCTAssertTrue(
            model.contains("WorktreeBarLogic.resolveCommitPrompt(branch: branch, why: why)"),
            "the hand-off no longer sends the prompt web sends")
    }
}
