import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read one `<background-jobs>` block the same way and say the same words about it,
/// and this is the tripwire that keeps them doing it.
///
/// `BackgroundJobs.swift` is a hand-copy of the browser's reading of the inventory a returning
/// engine is handed (`lib/backgroundJobs.ts`) and of the rows it draws (`BackgroundJobsNote.tsx`).
/// The Swift client and the browser bundle share no compiler, so a wording reworded at one end
/// simply never appears at the other — and the reading is where that costs most: a section heading
/// only one end matches is a block that end draws as the wall of `｜` this work replaced.
///
/// Shaped after `BackgroundWakeCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
final class BackgroundJobsCopyParityTests: XCTestCase {

    private static let webJobs = "src/web/src/lib/backgroundJobs.ts"
    private static let webNote = "src/web/src/components/BackgroundJobsNote.tsx"
    private static let webFixtures = "src/web/src/lib/backgroundJobs.fixtures.ts"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(BackgroundJobsCopyParityTests.webJobs) was not found above this test file. "
                    + "OrbitKit's reading of the block is one half of a pair; if the web half moved, "
                    + "move this check with it rather than deleting it."
            case .missing(let path):
                return "\(path) was not found. Either it moved — then point this check at its new "
                    + "home — or it is gone, and this client is now mirroring something that no "
                    + "longer exists."
            case .notDeclared(let what, let file):
                return "\(what) was not found in \(file). Either it was renamed — then rename it "
                    + "here too, which is what this check is for — or it is gone."
            }
        }
    }

    /// The repo root, found by walking up from this file until the web's reader is under foot. Not a
    /// fixed number of `..` hops: how deep this test file sits is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webJobs).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    private func read(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// A web source with its string literals put back together.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` across lines and lets a value — a string or a
    /// regular expression — sit on the line under its `=`; where those wraps fall is a formatting
    /// decision while the words are the contract.
    private func flat(_ relative: String) throws -> String {
        try read(relative)
            .replacingOccurrences(of: "['\"`]\\s*\\+\\s*['\"`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*(['\"`/])", with: "= $1", options: .regularExpression)
    }

    /// The one capture of `pattern`, or a failure naming what went missing rather than a green run
    /// comparing this end against nothing.
    private func capture(_ source: String, _ pattern: String, _ what: String,
                         _ file: String) throws -> String {
        let re = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        guard let match = re.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: source) else {
            throw ParityError.notDeclared(what: what, file: file)
        }
        return String(source[range])
    }

    /// Every capture of `pattern`, in source order.
    private func captures(_ source: String, _ pattern: String) throws -> [String] {
        let re = try NSRegularExpression(pattern: pattern)
        return re.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap {
            guard $0.numberOfRanges > 1, let range = Range($0.range(at: 1), in: source) else { return nil }
            return String(source[range])
        }
    }

    /// From one marker to the next occurrence of another, so a match elsewhere in the file cannot
    /// answer for the stretch being asserted about.
    private func section(_ source: String, from: String, to: String, _ file: String) throws -> String {
        guard let start = source.range(of: from),
              let end = source.range(of: to, range: start.upperBound..<source.endIndex) else {
            throw ParityError.notDeclared(what: "\(from) … \(to)", file: file)
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    /// The other end writes exactly these words, in any of the three quotes it writes strings in.
    private func assertWritten(_ source: String, _ value: String, _ what: String, _ file: String,
                               line: UInt = #line) {
        let written = ["'", "\"", "`"].contains { source.contains("\($0)\(value)\($0)") }
        XCTAssertTrue(written, "\(what) drifted: \(file) no longer writes \(value.debugDescription)",
                      file: #filePath, line: line)
    }

    /// The other end renders exactly these words as an element's own text.
    ///
    /// Half of what a reader sees is a JSX text node rather than a string literal —
    /// `<summary>The block, verbatim</summary>` — so there is neither a name nor a quote to anchor
    /// on. The anchor is the markup instead: the text has to sit between a tag's `>` and the next
    /// `<` or `{`, which a sentence quoted in a comment never does. A bare `contains` would let the
    /// file's own header prose satisfy the check, and a check a comment can satisfy is not a check.
    private func assertRendered(_ source: String, _ value: String, _ what: String, _ file: String,
                                line: UInt = #line) {
        let pattern = ">\\s*\(NSRegularExpression.escapedPattern(for: value))\\s*[<{]"
        let re = try? NSRegularExpression(pattern: pattern)
        let found = re?.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)) != nil
        XCTAssertTrue(found,
                      "\(what) drifted: \(file) no longer renders \(value.debugDescription) as an "
                          + "element's own text",
                      file: #filePath, line: line)
    }

    /// A sentence the other end builds around a value of its own, so there is no whole literal to
    /// compare — the words either side of the interpolation are.
    private func assertBuilt(_ source: String, _ value: String, _ what: String, _ file: String,
                             line: UInt = #line) {
        XCTAssertTrue(source.contains(value),
                      "\(what) drifted: \(file) no longer builds \(value.debugDescription)",
                      file: #filePath, line: line)
    }

    // MARK: reading the block

    /// The grammar of the block, character for character. This is the pair most expensive to get
    /// wrong: a heading only the browser matches is a block this client draws as one line four lines
    /// wide, divided by a `｜` the reader has to count — which is the screenshot this work started
    /// from. It is also the pair most likely to drift silently, since the 106 blocks already in the
    /// record are read by these patterns alone.
    func testTheGrammarOfTheBlockIsTheSameOnBothEnds() throws {
        let web = try flat(Self.webJobs)
        let pairs = [
            ("BLOCK", BackgroundJobsText.blockPattern),
            ("RUNNING", BackgroundJobsText.runningPattern),
            ("ENDED", BackgroundJobsText.endedPattern),
            ("NARRATION", BackgroundJobsText.narrationPattern),
            ("JOB_HEAD", BackgroundJobsText.jobHeadPattern),
            ("EXIT_CODE", BackgroundJobsText.exitCodePattern),
            ("REASON", BackgroundJobsText.reasonPattern),
            ("OUTPUT", BackgroundJobsText.outputPattern),
            ("NO_END", BackgroundJobsText.noEndPattern),
        ]
        for (name, mine) in pairs {
            let theirs = try capture(web, "const \(name) =\\s*/(.+?)/g?;", name, Self.webJobs)
            XCTAssertEqual(mine, theirs,
                           "the \(name) pattern drifted — first is this client's, second is \(name) "
                               + "in \(Self.webJobs). A wording only one end matches is a block that "
                               + "end draws as a wall of ｜.")
        }
    }

    /// The four outcomes a listed job can have ended with. One this end does not know is a status it
    /// reads as part of the command instead, which puts a shell fragment where the outcome goes.
    func testTheTerminalStatusesAreTheSameOnBothEnds() throws {
        let web = try flat(Self.webJobs)
        let declared = try capture(web, "const TERMINAL = new Set\\(\\[(.+?)\\]\\)", "TERMINAL",
                                   Self.webJobs)
        let theirs = try captures(declared, "'([^']+)'")
        XCTAssertEqual(BackgroundJobsText.terminal, Set(theirs),
                       "the statuses a job can end with drifted — first is this client's, second is "
                           + "TERMINAL in \(Self.webJobs).")
    }

    /// Every field of a row goes by the same name on both ends, in the same order. The rows are two
    /// readings of one block, and a field one end never learned to read is simply blank there.
    func testEveryFieldIsCalledWhatWebCallsIt() throws {
        let web = try flat(Self.webJobs)
        let mine: [(String, Any)] = [
            ("BackgroundJobRow", BackgroundJobRow(id: "", kind: "", command: "", status: "",
                                                  exitCode: nil, reason: nil, outputPath: nil)),
            ("BackgroundJobs", BackgroundJobs(running: [], ended: [], text: "", rest: "")),
        ]
        for (name, value) in mine {
            let body = try section(web, from: "export interface \(name) {", to: "\n}", Self.webJobs)
            let theirs = try captures(body, "(?m)^  (\\w+):")
            guard !theirs.isEmpty else {
                throw ParityError.notDeclared(what: "any field of \(name)", file: Self.webJobs)
            }
            XCTAssertEqual(Mirror(reflecting: value).children.compactMap(\.label), theirs,
                           "\(name)'s fields drifted — first is this client's, second is the "
                               + "interface in \(Self.webJobs).")
        }
    }

    // MARK: the line that names the block folded

    /// The count on the shut line, word for word. It is the one sentence of this work a reader meets
    /// without opening anything, and the two clients disagreeing about it is the drift a reader can
    /// see from across the room.
    func testTheSummaryIsCountedInTheSameWords() throws {
        let web = try flat(Self.webJobs)
        let summarize = try section(web, from: "export function summarizeBackgroundJobs(", to: "\n}",
                                    Self.webJobs)

        XCTAssertEqual(BackgroundJobsNote.summary(jobs(ended: [row(exitCode: 0)])), "1 ended, exit 0")
        assertBuilt(summarize, "`1 ended, exit ${job.exitCode}`", "how a lone job's exit code is said",
                    Self.webJobs)
        XCTAssertEqual(BackgroundJobsNote.summary(jobs(ended: [row(status: "killed", exitCode: nil)])),
                       "1 killed")
        assertBuilt(summarize, "`1 ${job.status || 'ended'}`",
                    "how a lone job that named no exit code is said", Self.webJobs)
        XCTAssertEqual(BackgroundJobsNote.summary(jobs(running: [row(status: "")],
                                                       ended: [row(exitCode: 0)])),
                       "1 running, 1 ended")
        assertBuilt(summarize, "`${running.length} running`", "how many are still running",
                    Self.webJobs)
        assertBuilt(summarize, "`${ended.length - failed.length} ended`", "how many ended cleanly",
                    Self.webJobs)
        XCTAssertEqual(BackgroundJobsNote.summary(jobs(running: [row(status: ""), row(status: "")],
                                                       ended: [row(status: "failed", exitCode: 1)])),
                       "2 running, 1 failed")
        assertBuilt(summarize, "`${failed.length} failed`", "how many failed", Self.webJobs)
        assertBuilt(summarize, ".join(', ')", "what parts the count", Self.webJobs)
        // A killed job is counted with the failed ones, not with the clean ends.
        assertBuilt(summarize, "job.status === 'failed' || job.status === 'killed'",
                    "which outcomes count as failed", Self.webJobs)
    }

    /// The fold head the summary hangs off, which is the browser's `ControlPlaneNote`.
    func testTheFoldHeadIsBuiltTheSameWay() throws {
        let web = try flat(Self.webTranscript)
        let note = try section(web, from: "function ControlPlaneNote(", to: "\n}", Self.webTranscript)

        assertBuilt(note, "`⊕ Orbit attached: ${kind}`", "the line naming what was attached",
                    Self.webTranscript)
        assertBuilt(note, "` · ${summarizeBackgroundJobs(jobs)}`",
                    "the count hung off that line", Self.webTranscript)
        // What the fold opens to: rows for the inventory, and whatever else the note held under them.
        assertBuilt(note, "<BackgroundJobsNote jobs={jobs} />", "the rows the fold opens to",
                    Self.webTranscript)
        // Since the `#`-references landed as cards, the leftover is what BOTH readings handed on
        // rather than this one's own `rest` — the inventory reads the note first and the references
        // read what it left (ReferencedTaskCopyParityTests holds the other half of that chain).
        assertBuilt(note, "rest !== ''", "another block the same note carried",
                    Self.webTranscript)
    }

    // MARK: the rows the reading becomes

    func testTheRowsSayWhatTheWebRowsSay() throws {
        let web = try flat(Self.webNote)

        assertWritten(web, BackgroundJobsNote.runningTitle, "the heading over what is still running",
                      Self.webNote)
        assertWritten(web, BackgroundJobsNote.endedTitle, "the heading over what ended", Self.webNote)
        assertBuilt(web, "{job.command || job.id}", "what a job's row is called", Self.webNote)
        assertBuilt(web, "{job.id} · {job.kind}", "the ids under a row", Self.webNote)

        let outcome = try section(web, from: "function outcome(", to: "\n}", Self.webNote)
        XCTAssertEqual(BackgroundJobsNote.outcome(row(exitCode: 0)), "exit 0")
        assertBuilt(outcome, "`exit ${job.exitCode}`", "how a row's exit code is said", Self.webNote)
        XCTAssertEqual(BackgroundJobsNote.outcome(row(status: "killed", exitCode: nil,
                                                      reason: "drain_cap")),
                       "killed · drain_cap")
        assertBuilt(outcome, "`${job.status} · ${job.reason}`", "how a row's outcome and why are said",
                    Self.webNote)
        // Still running: the mark has already said so, and there is no outcome to report.
        XCTAssertEqual(BackgroundJobsNote.outcome(row(status: "", exitCode: nil)), "")
        assertBuilt(outcome, "if (job.status === '') return '';",
                    "a running row having no outcome to report", Self.webNote)

        // The three marks a row can open on, and which status takes which.
        assertBuilt(web, "job.status === '' ? 'is-running' : job.status === 'completed' ? 'is-ok' : 'is-failed'",
                    "which mark a row opens on", Self.webNote)
        XCTAssertEqual(BackgroundJobsNote.mark(row(status: "")), .running)
        XCTAssertEqual(BackgroundJobsNote.mark(row(status: "completed")), .ok)
        XCTAssertEqual(BackgroundJobsNote.mark(row(status: "killed")), .failed)
    }

    /// The fold under the rows, and the one thing it must NOT be called.
    ///
    /// On a wake turn this entry is drawn inside the card, which keeps its own fold for the text the
    /// agent received. Two folds sitting one above the other under one name read as a bug, which is
    /// why the browser named this one separately — and why this end must not quietly drift back onto
    /// the other's name.
    func testTheVerbatimFoldIsNamedApartFromTheWakeCardsOwn() throws {
        let web = try flat(Self.webNote)

        assertRendered(web, BackgroundJobsNote.rawSummary, "the fold the block stays behind",
                       Self.webNote)
        XCTAssertNotEqual(BackgroundJobsNote.rawSummary, BackgroundWakeCard.rawSummary,
                          "the block's fold and the wake card's fold have come to share a name; on a "
                              + "wake turn they are drawn one above the other.")
    }

    // MARK: the turn nobody typed

    /// A wake turn carries no words of its own, so whatever else its note held belongs in the card
    /// and the bubble is drawn only where somebody actually typed something. Handing the leftover
    /// back to a bubble is what drew an empty one, signed with the reader's own name.
    func testAWakeTurnDrawsNoBubbleForABlockNobodyTyped() throws {
        let web = try flat(Self.webTranscript)
        let branch = try section(web, from: "const background = parseBackgroundWake(node.note);",
                                 to: "return <UserBubble node={node} />;", Self.webTranscript)

        assertBuilt(branch, "attached={", "the leftover block riding in the card", Self.webTranscript)
        assertBuilt(branch, "<ControlPlaneNote kind={describeNote(background.rest)} text={background.rest} />",
                    "the leftover block drawn as the card's own entry", Self.webTranscript)
        assertBuilt(branch, "{node.text.trim() !== '' && <UserBubble",
                    "the bubble drawn only for words somebody typed", Self.webTranscript)
        // The card's own slot for it.
        assertBuilt(try flat("src/web/src/components/BackgroundWakeCard.tsx"), "{attached}",
                    "the card's slot for the leftover block",
                    "src/web/src/components/BackgroundWakeCard.tsx")

        XCTAssertFalse(BackgroundWakeCard.drawsBubble(text: ""))
        XCTAssertFalse(BackgroundWakeCard.drawsBubble(text: "\n  \n"))
        XCTAssertTrue(BackgroundWakeCard.drawsBubble(text: "把它做完"))
    }

    // MARK: the blocks both ends are proved against

    /// Every fixture this client reads is the browser's own, byte for byte.
    ///
    /// They were copied out of this deployment's `run_event` rows and are the only evidence either
    /// reading has that it reads what is actually sent. Two ends drifting to two sets of blocks
    /// would leave both green while disagreeing about the same transcript.
    func testTheBlocksBothEndsAreProvedAgainstAreTheSameBlocks() throws {
        let web = try read(Self.webFixtures)
        let declared = try NSRegularExpression(pattern: "export const (\\w+) = `(.*?)`;",
                                               options: [.dotMatchesLineSeparators])
            .matches(in: web, range: NSRange(web.startIndex..., in: web))
            .reduce(into: [String: String]()) { found, match in
                guard let name = Range(match.range(at: 1), in: web),
                      let body = Range(match.range(at: 2), in: web) else { return }
                found[String(web[name])] = String(web[body])
            }
        guard !declared.isEmpty else {
            throw ParityError.notDeclared(what: "any fixture", file: Self.webFixtures)
        }

        XCTAssertEqual(Set(BackgroundJobsFixtures.all.keys), Set(declared.keys),
                       "the fixtures drifted: \(Self.webFixtures) and this client no longer hold the "
                           + "same blocks. Re-transcribe rather than retype — the blocks are "
                           + "run_event rows, not prose.")
        for (name, mine) in BackgroundJobsFixtures.all {
            XCTAssertEqual(mine, declared[name],
                           "\(name) drifted from \(Self.webFixtures). Both ends have to be read "
                               + "against the same block or neither proves anything.")
        }
    }

    // MARK: fixtures

    private func jobs(running: [BackgroundJobRow] = [],
                      ended: [BackgroundJobRow] = []) -> BackgroundJobs {
        BackgroundJobs(running: running, ended: ended, text: "", rest: "")
    }

    private func row(status: String = "completed", exitCode: Int? = 0,
                     reason: String? = nil) -> BackgroundJobRow {
        BackgroundJobRow(id: "bgj_1", kind: "job", command: "bash a.sh", status: status,
                         exitCode: exitCode, reason: reason, outputPath: nil)
    }
}
