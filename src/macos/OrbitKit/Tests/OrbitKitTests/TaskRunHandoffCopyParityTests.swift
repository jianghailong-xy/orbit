import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about the same refusal, and this is the tripwire that keeps
/// them saying them.
///
/// `TaskRunHandoff.swift` copied its visible strings out of `src/web/src/lib/taskRunHandoff.ts` by
/// hand, the way `CriteriaDecision` copies `CriteriaDecisionCard`'s. Nothing in a build catches a
/// sentence re-worded at one end only — the Swift client and the browser bundle share no compiler —
/// so the check has to be a test that reads the other end's source and compares the strings. The
/// web end declares them as named constants instead of writing them inline precisely so that this
/// can anchor on a declaration rather than on prose.
///
/// Shaped after `CriteriaDecisionCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
///
/// Two deliberate non-assertions, both plumbing rather than copy:
///  - the web builds `/sessions/<id>` hrefs and this client routes with `.session(id)`, so there is
///    no URL here to compare;
///  - the resend interval is milliseconds over there and a `TimeInterval` here. The INTERVAL is
///    asserted; its unit is each end's own.
final class TaskRunHandoffCopyParityTests: XCTestCase {

    private static let webFile = "src/web/src/lib/taskRunHandoff.ts"

    /// The repo root, found by walking up from this file until the web module is under foot.
    /// Not a fixed number of `..` hops: the depth of this file is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(
                atPath: dir.appendingPathComponent(Self.webFile).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case noLiteral(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(TaskRunHandoffCopyParityTests.webFile) was not found above this test "
                    + "file. OrbitKit's task-run refusals are one half of a pair; if the web half "
                    + "moved, move this check with it rather than deleting it."
            case .noLiteral(let anchor):
                return "no string literal in \(TaskRunHandoffCopyParityTests.webFile) contains "
                    + "\(anchor.debugDescription). The web end either re-worded that sentence or "
                    + "stopped writing it as one literal — either way the two clients are no "
                    + "longer known to agree."
            }
        }
    }

    /// The web module's source with its string literals put back together and its prose removed.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` — or as backtick templates joined the same
    /// way — across lines, and where that wrap falls is a formatting decision while the words are
    /// the contract. So adjacent literals are joined whichever quotes they use, and a value sitting
    /// on the line under its `=` or `:` is pulled up, which lets every assertion below name the
    /// declaration it is about rather than guess at the wrapping.
    ///
    /// Comments go first, and that is not tidiness: this file's own doc comments quote identifiers
    /// in backticks, and a scan for backtick literals that ran over them would match prose.
    private func flatWeb() throws -> String {
        let source = try String(contentsOf: try repoRoot().appendingPathComponent(Self.webFile),
                                encoding: .utf8)
        return source
            .replacingOccurrences(of: "/\\*[\\s\\S]*?\\*/", with: "", options: .regularExpression)
            .replacingOccurrences(of: "//[^\n]*", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[=:]\\s*\\n\\s*(?=['`\"])", with: "= ",
                                  options: .regularExpression)
            .replacingOccurrences(of: "['`\"]\\s*\\+\\s*['`\"]", with: "",
                                  options: .regularExpression)
    }

    /// The other end declares this constant with exactly these words.
    ///
    /// Anchored on the declaration and not on the sentence alone: a check that a passing mention in
    /// prose could satisfy is not a check. Both quote styles, because an apostrophe inside the
    /// words ("the task's pin") makes that one literal a double-quoted one over there.
    private func assertDeclares(_ web: String, _ name: String, _ value: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains("\(name) = '\(value)'") || web.contains("\(name) = \"\(value)\""),
                      "\(name) drifted: \(Self.webFile) no longer declares it as "
                          + value.debugDescription,
                      file: file, line: line)
    }

    /// One whole string literal out of the web source, found by a phrase inside it.
    ///
    /// The interpolated sentences have no constant to anchor on — they are built where they are
    /// used — so the anchor is a stretch of their own words, and what comes back is the entire
    /// literal, so a re-wording ANYWHERE in it shows up rather than only at the anchor.
    ///
    /// Found by growing outwards from the anchor to the nearest quote on each side, rather than by
    /// counting quotes from the top of the file. TypeScript wraps one sentence across literals of
    /// MIXED kinds — a backtick chunk then a plain one for the tail that interpolates nothing — so
    /// a scan that paired backticks off in order would lose its place at the first such sentence
    /// and read the rest of the file half a literal out of step.
    private func literal(_ web: String, containing anchor: String) throws -> String {
        let quotes: Set<Character> = ["`", "'", "\""]
        guard let found = web.range(of: anchor) else { throw ParityError.noLiteral(anchor) }
        guard let open = web[..<found.lowerBound].lastIndex(where: { quotes.contains($0) }),
              let close = web[found.upperBound...].firstIndex(where: { quotes.contains($0) })
        else { throw ParityError.noLiteral(anchor) }
        return String(web[web.index(after: open)..<close])
    }

    /// `${pinned}` filled in the way the Swift end fills `\(pinned)`, so two sentences built from
    /// the same values can be compared as sentences.
    private func filled(_ template: String, _ values: [String: String]) -> String {
        values.reduce(template) { text, pair in
            text.replacingOccurrences(of: "${\(pair.key)}", with: pair.value)
        }
    }

    private func conflict(_ fields: String) throws -> TaskRunHandoff.Conflict {
        try XCTUnwrap(TaskRunHandoff.readConflict(APIError.http(status: 409, body: "{\(fields)}")))
    }

    // MARK: the named constants

    func testTheDeclaredWordsAreTheSameAtBothEnds() throws {
        let web = try flatWeb()
        assertDeclares(web, "TASK_RUN_HANDED_OVER_TITLE", TaskRunHandoff.handedOverTitle)
        assertDeclares(web, "TASK_RUN_HANDED_OVER_BODY", TaskRunHandoff.handedOverBody)
        assertDeclares(web, "TASK_RUN_HELD_TITLE", TaskRunHandoff.heldTitle)
        assertDeclares(web, "TASK_RUN_HELD_BODY", TaskRunHandoff.heldBody)
        assertDeclares(web, "TASK_RUN_ENDING_TITLE", TaskRunHandoff.endingTitle)
        assertDeclares(web, "TASK_RUN_ENDING_BODY", TaskRunHandoff.endingBody)
        assertDeclares(web, "TASK_RUN_PIN_TITLE", TaskRunHandoff.pinTitle)
        assertDeclares(web, "TASK_RUN_SWITCH_TITLE", TaskRunHandoff.switchTitle)
        assertDeclares(web, "OPEN_THE_RUN", TaskRunHandoff.openTheRun)
        assertDeclares(web, "CLEAR_THE_PIN", TaskRunHandoff.clearThePin)
        assertDeclares(web, "STOP_AND_CONTINUE", TaskRunHandoff.stopAndContinue)
        assertDeclares(web, "KEEP_IT_RUNNING", TaskRunHandoff.keepItRunning)
        assertDeclares(web, "RUN_ENTRY_LABEL", TaskRunHandoff.runEntryLabel)
        assertDeclares(web, "RETRY_ENTRY_LABEL", TaskRunHandoff.retryEntryLabel)
        assertDeclares(web, "OPEN_RUN_ENTRY_HINT", TaskRunHandoff.openRunEntryHint)
    }

    /// How long to wait, and how many times waiting is a plan. A client that waited longer than the
    /// other would resend into a refusal it had already been told about; one that gave up sooner
    /// would call a run "still there" while the other was still clearing it.
    func testBothEndsWaitTheSameAmountAndGiveUpAtTheSamePoint() throws {
        let web = try flatWeb()
        XCTAssertTrue(web.contains("TASK_RUN_RESEND_AFTER_MS = 2000"),
                      "the interval drifted — this end waits "
                          + "\(Int(TaskRunHandoff.resendAfter * 1000))ms")
        XCTAssertEqual(TaskRunHandoff.resendAfter, 2)
        XCTAssertTrue(
            web.contains("TASK_RUN_RESEND_MAX_ATTEMPTS = \(TaskRunHandoff.resendMaxAttempts)"),
            "the number of resends drifted")
    }

    // MARK: the sentences that are built rather than declared

    /// The pin refusal's body, built at both ends out of the two provider names and compared as the
    /// finished sentence.
    func testThePinSentenceIsBuiltFromTheSameWords() throws {
        let template = try literal(try flatWeb(), containing: "This task is pinned to ${pinned}")
        let expected = filled(template, ["pinned": "deepseek", "running": "claude"])
        let built = try conflict("""
        "code":"TASK_RUN_PIN_CONFLICT","pinnedTo":"deepseek","runningOn":"claude",
        "taskId":"t","conflictingSessionId":"s"
        """)
        XCTAssertEqual(built.body, expected)
    }

    /// The confirmation's body — the one sentence in this whole file that authorises something
    /// destructive, so the promise it makes about the stopped run's branch has to be the same
    /// promise at both ends.
    func testTheStopAndContinueQuestionIsAskedInTheSameWords() throws {
        let template = try literal(try flatWeb(), containing: "This task is being worked on")
        let expected = filled(template, ["running": "claude", "requested": "deepseek"])
        let built = try conflict("""
        "code":"TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED",
        "runningProvider":"claude","requestedProvider":"deepseek",
        "confirm":{"field":"stopSessionId","value":"s"},
        "taskId":"t","conflictingSessionId":"s"
        """)
        XCTAssertEqual(built.body, expected)
        XCTAssertTrue(expected.contains("branch and worktree"))
    }

    /// The composer's note about when a provider pick takes hold, in both of its forms.
    func testTheComposerSaysTheSameThingAboutWhenAPickTakesHold() throws {
        let web = try flatWeb()

        let live = filled(try literal(web, containing: "The turn in flight finishes on"),
                          ["from": "claude", "to": "deepseek"])
        XCTAssertEqual(TaskRunHandoff.providerSwitchNote(from: "claude", to: "deepseek",
                                                         liveRun: true),
                       live)

        let idle = filled(try literal(web, containing: "Your next message runs on"),
                          ["to": "deepseek"])
        XCTAssertEqual(TaskRunHandoff.providerSwitchNote(from: "claude", to: "deepseek",
                                                         liveRun: false),
                       idle)
    }

    /// The codes themselves, which are the contract under all of the above: a client that branched
    /// on a code the other end does not send would show a card nobody else shows.
    func testBothEndsBranchOnTheSameCodes() throws {
        let web = try flatWeb()
        for code in ["TASK_ALREADY_RUNNING", "TASK_RUN_PIN_CONFLICT",
                     "TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED"] {
            XCTAssertTrue(web.contains("case '\(code)'"),
                          "\(Self.webFile) no longer branches on \(code)")
        }
        // The field that separates the two situations one code covers, and the field that says the
        // message was delivered elsewhere. Both are read by name at both ends.
        XCTAssertTrue(web.contains("conflictingSessionEnding"))
        XCTAssertTrue(web.contains("routedToSessionId"))
    }
}
