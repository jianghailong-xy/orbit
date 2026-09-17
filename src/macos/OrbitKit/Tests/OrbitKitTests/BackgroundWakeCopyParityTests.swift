import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about one wake, and this is the tripwire that keeps them
/// saying them.
///
/// `BackgroundWake.swift` is a hand-copy of the browser's reading of the blocks the control plane
/// opens a turn with (`lib/backgroundWake.ts`'s `parseBackgroundWake`) and of the card it draws
/// (`BackgroundWakeCard.tsx`). The Swift client and the browser bundle share no compiler, so a
/// sentence reworded at one end simply never appears at the other — and the one that matters most
/// here is the reading itself: a wording only one end recognises turns the whole turn back into an
/// empty bubble with a block of text under it, under a strip that calls it "context". That was the
/// bug being fixed, so it is the one this check exists to stop coming back.
///
/// Shaped after `WatchWakeCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
///
/// Deliberately NOT compared:
///  - `NO_OUTPUT`, which the browser declares and never uses. Mirroring dead code would only make
///    this end harder to read, and there is no behaviour on either side to hold together.
///  - The span in a wakeup's row. The browser formats it with `formatSpan` and this client with
///    `WatchProjection.duration`, which is that same function value for value — and the one that
///    holds the two together is `WatchWakeCopyParityTests`, where the span is read off the
///    browser's declaration. `BackgroundWakeTests` still pins both ends of the clamp the control
///    plane puts a delay in ([60, 3600] seconds), which is all of that range this row reaches.
final class BackgroundWakeCopyParityTests: XCTestCase {

    private static let webWake = "src/web/src/lib/backgroundWake.ts"
    private static let webCard = "src/web/src/components/BackgroundWakeCard.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(BackgroundWakeCopyParityTests.webWake) was not found above this test file. "
                    + "OrbitKit's wake card is one half of a pair; if the web half moved, move this "
                    + "check with it rather than deleting it."
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
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webWake).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    /// A web source with its string literals put back together.
    ///
    /// TypeScript wraps a long sentence as `'…' + '…'` across lines and lets a value — a string or a
    /// regular expression — sit on the line under its `=`; where those wraps fall is a formatting
    /// decision while the words are the contract.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else { throw ParityError.missing(relative) }
        return try String(contentsOf: url, encoding: .utf8)
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
    /// Half the card's sentences are JSX text nodes rather than string literals — `<summary>What the
    /// agent received</summary>` — so there is neither a name nor a quote to anchor on. The anchor is
    /// the markup instead: the text has to sit between a tag's `>` and the next `<` or `{`, which a
    /// sentence quoted in a comment never does. A bare `contains` would let the file's own header
    /// prose satisfy the check, and a check a comment can satisfy is not a check.
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

    // MARK: reading the turn the control plane opened

    /// The grammar of both blocks, character for character. This is the pair most expensive to get
    /// wrong: a wording only the browser matches is a wake this client draws as an empty message the
    /// account owner typed, with the block underneath — which is the screenshot this work started
    /// from. It is also the pair most likely to drift silently, since the 73 turns already in the
    /// record are read by these patterns alone.
    func testTheGrammarOfBothBlocksIsTheSameOnBothEnds() throws {
        let web = try flat(Self.webWake)
        let pairs = [
            ("BLOCK", BackgroundWakeText.blockPattern),
            ("JOB_HEAD", BackgroundWakeText.jobHeadPattern),
            ("TRIGGER", BackgroundWakeText.triggerPattern),
            ("EXIT_CODE", BackgroundWakeText.exitCodePattern),
            ("KILL_REASON", BackgroundWakeText.killReasonPattern),
            ("REASON_GLOSS", BackgroundWakeText.reasonGlossPattern),
            ("OUTPUT_LINE", BackgroundWakeText.outputLinePattern),
            ("OUTPUT_TAIL", BackgroundWakeText.outputTailPattern),
            ("WAKEUP_TIMING", BackgroundWakeText.wakeupTimingPattern),
            ("WAKEUP_REASON", BackgroundWakeText.wakeupReasonPattern),
            ("WAKEUP_PROMPT", BackgroundWakeText.wakeupPromptPattern),
        ]
        for (name, mine) in pairs {
            let theirs = try capture(web, "const \(name) =\\s*/(.+?)/g?;", name, Self.webWake)
            XCTAssertEqual(mine, theirs,
                           "the \(name) pattern drifted — first is this client's, second is \(name) "
                               + "in \(Self.webWake). A wording only one end matches is a turn that "
                               + "end draws as a message somebody typed.")
        }
    }

    /// Every field of a wake goes by the same name on both ends, in the same order. The card is
    /// two readings of one block, and a field one end never learned to read is a row that is simply
    /// blank there.
    func testEveryFieldIsCalledWhatWebCallsIt() throws {
        let web = try flat(Self.webWake)
        let mine: [(String, Any)] = [
            ("BackgroundWakeJob", BackgroundWakeJob(id: "", kind: "", command: "", description: nil,
                                                    status: "", ended: false, exitCode: nil,
                                                    killReason: nil, outputPath: nil, outputFrom: nil,
                                                    outputTo: nil, outputTail: "")),
            ("ScheduledWakeup", ScheduledWakeup(askedAt: nil, delaySeconds: nil, dueAt: nil,
                                                reason: nil, prompt: "")),
            ("BackgroundWake", BackgroundWake(jobs: [], wakeups: [], text: "", rest: "")),
        ]
        for (name, value) in mine {
            let body = try section(web, from: "export interface \(name) {", to: "\n}", Self.webWake)
            let theirs = try captures(body, "(?m)^  (\\w+):")
            guard !theirs.isEmpty else {
                throw ParityError.notDeclared(what: "any field of \(name)", file: Self.webWake)
            }
            XCTAssertEqual(Mirror(reflecting: value).children.compactMap(\.label), theirs,
                           "\(name)'s fields drifted — first is this client's, second is the "
                               + "interface in \(Self.webWake).")
        }
    }

    // MARK: the card the reading becomes

    func testTheCardsTitlesMatchTheWebCard() throws {
        let web = try flat(Self.webCard)
        let titles = try section(web, from: "function title(", to: "\n}", Self.webCard)

        assertWritten(titles, BackgroundWakeCard.title(wake(jobs: [])),
                      "the title of a turn a wakeup opened", Self.webCard)
        assertWritten(titles, BackgroundWakeCard.title(wake(jobs: [job()])),
                      "the title of a job that finished", Self.webCard)
        assertWritten(titles, BackgroundWakeCard.title(wake(jobs: [job(status: "failed", exitCode: 1)])),
                      "the title of a job that failed", Self.webCard)
        assertWritten(titles, BackgroundWakeCard.title(wake(jobs: [job(status: "running", ended: false,
                                                                      exitCode: nil)])),
                      "the title of a job that has only written something", Self.webCard)
        // The one title built around a count, so there is no whole literal to compare.
        XCTAssertEqual(BackgroundWakeCard.title(wake(jobs: [job(), job()])), "2 background jobs finished")
        assertBuilt(titles, "${jobs.length} background jobs finished",
                    "the title several jobs share", Self.webCard)
    }

    func testWhatBecameOfAJobIsSaidInTheSameWords() throws {
        let web = try flat(Self.webCard)
        let outcome = try section(web, from: "function outcome(", to: "\n}", Self.webCard)

        assertWritten(outcome, BackgroundWakeCard.outcome(job(status: "running", ended: false,
                                                              exitCode: nil)),
                      "what a job that is still running is said to have done", Self.webCard)
        assertWritten(outcome, BackgroundWakeCard.outcome(job(status: "killed", exitCode: nil)),
                      "what a killed job with no reason recorded is said to have done", Self.webCard)
        XCTAssertEqual(BackgroundWakeCard.outcome(job(status: "killed", exitCode: nil,
                                                      killReason: "runner_shutdown")),
                       "was killed: runner_shutdown")
        assertBuilt(outcome, "was killed: ${job.killReason}", "what a killed job names", Self.webCard)
        XCTAssertEqual(BackgroundWakeCard.outcome(job(exitCode: nil)), "ended completed")
        assertBuilt(outcome, "ended ${job.status}", "what a job that named no exit code ended as",
                    Self.webCard)
        XCTAssertEqual(BackgroundWakeCard.outcome(job(exitCode: 0)), "exited 0")
        assertBuilt(outcome, "exited ${job.exitCode}", "how a job's exit code is said", Self.webCard)
    }

    func testHowTheJobsCameOutIsSummarisedInTheSameWords() throws {
        let web = try flat(Self.webCard)
        // The browser writes the line twice over: once in words, which is what this client returns
        // and what the sticky bar at the top of the transcript names the turn with, and once as the
        // card draws it, with the lone job's name in bold. The words are the contract, so they are
        // asserted against the first; only the bolding is asserted against the second.
        let summary = try section(web, from: "function summaryText(", to: "\n}", Self.webCard)
        let bolded = try section(web, from: "function summary(", to: "\n}", Self.webCard)

        assertWritten(summary, BackgroundWakeCard.summary(wake(jobs: [])),
                      "what a wakeup carrying no reason says", Self.webCard)
        // One job's line is its name and what became of it, full stop.
        XCTAssertEqual(BackgroundWakeCard.summary(wake(jobs: [job(description: "upgrade")])),
                       "upgrade exited 0.")
        assertBuilt(bolded, "</strong> {outcome(jobs[0])}.", "one job's own line", Self.webCard)
        assertBuilt(summary, "${jobs[0].description || jobs[0].command} ${outcome(jobs[0])}.",
                    "what one job's line calls it", Self.webCard)
        XCTAssertEqual(BackgroundWakeCard.summary(wake(jobs: [job(), job(status: "failed", exitCode: 1)])),
                       "1 of 2 failed.")
        assertBuilt(summary, "${failed.length} of ${jobs.length} failed.",
                    "how many of several jobs failed", Self.webCard)
        XCTAssertEqual(BackgroundWakeCard.summary(wake(jobs: [job(), job()])), "All 2 exited 0.")
        assertBuilt(summary, "All ${jobs.length} exited 0.", "several jobs that all came out clean",
                    Self.webCard)
        XCTAssertEqual(BackgroundWakeCard.summary(wake(jobs: [job(exitCode: nil), job(exitCode: nil)])),
                       "All 2 finished.")
        assertBuilt(summary, "All ${jobs.length} finished.",
                    "several jobs that finished without all naming an exit code", Self.webCard)
    }

    /// What the bar pinned to the top of the transcript calls this turn. Same rule as a watch's
    /// wake, for the same reason — nobody typed this one either — so the bar takes this card's own
    /// title and line (`StickySummary`), and the browser's half of that is the pair of attributes
    /// the card stamps on its root for `WorkspaceView`'s scanner to read.
    func testTheStickyBarNamesTheTurnInThisCardsOwnWords() throws {
        let web = try flat(Self.webCard)
        let root = try section(web, from: "className={`bgwake ", to: "\n      >", Self.webCard)

        assertBuilt(root, "data-sticky-label={title(wake)}", "the label the bar takes from this card",
                    Self.webCard)
        assertBuilt(root, "data-sticky-text={summaryText(wake)}", "the line the bar takes from this card",
                    Self.webCard)
        // The card's own line falls back to that same function, so the bar and the card under it
        // cannot come out saying two different things.
        assertBuilt(try section(web, from: "function summary(", to: "\n}", Self.webCard),
                    "return summaryText(wake);", "the card's line reading the words the bar reads",
                    Self.webCard)
    }

    func testTheCardsOwnLinesMatchTheWebCard() throws {
        let web = try flat(Self.webCard)

        // The provenance line, which is why the card exists: nobody typed this.
        let meta = try section(web, from: "className=\"bgwake-meta\"", to: "</div>", Self.webCard)
        assertWritten(meta, BackgroundWakeCard.meta(wake(jobs: [job()])),
                      "the line saying a background job queued the turn", Self.webCard)
        assertWritten(meta, BackgroundWakeCard.meta(wake(jobs: [])),
                      "the line saying a wakeup queued the turn", Self.webCard)
        assertBuilt(meta, "` · ${relTime(ts)}`", "how the card dates itself", Self.webCard)

        assertRendered(web, BackgroundWakeCard.undelivered, "the undelivered line", Self.webCard)
        assertRendered(web, BackgroundWakeCard.rawSummary,
                       "the fold the original text stays behind", Self.webCard)

        // How much of a failed job's output is shown before the rest is folded away.
        let shown = try capture(web, "const TAIL_LINES = (\\d+)", "TAIL_LINES", Self.webCard)
        XCTAssertEqual(String(BackgroundWakeCard.tailLines), shown)
    }

    func testTheRowsUnderTheCardMatchTheWebCard() throws {
        let web = try flat(Self.webCard)

        // A job's row: what it was called, what it exited, and how much it wrote.
        assertBuilt(web, "job.description || job.command", "what a job's row is called", Self.webCard)
        assertBuilt(web, "exit {job.exitCode}", "the exit code beside a job's name", Self.webCard)
        let jobMeta = try section(web, from: "className=\"bgwake-job-meta\"", to: "</div>", Self.webCard)
        assertWritten(jobMeta, "no output", "what a job that wrote nothing says", Self.webCard)
        assertBuilt(jobMeta, "${formatBytes(job.outputTo)} of output",
                    "how much a job wrote", Self.webCard)
        let bytes = try section(web, from: "function formatBytes(", to: "\n}", Self.webCard)
        for unit in ["${n} B", "toFixed(1)} KB", "toFixed(1)} MB"] {
            assertBuilt(bytes, unit, "the size a job's output is given in", Self.webCard)
        }

        // A wakeup's row: how far out it was asked for, and when it came due.
        let wakeupMeta = try section(web, from: "className=\"bgwake-wakeup-meta\"", to: "</div>",
                                     Self.webCard)
        assertBuilt(wakeupMeta, "`Asked for ${formatSpan(wakeup.delaySeconds * 1000)} out`",
                    "how far out a wakeup was asked for", Self.webCard)
        assertBuilt(wakeupMeta, "`came due ${relTime(wakeup.dueAt)}`",
                    "when a wakeup came due", Self.webCard)
        assertWritten(wakeupMeta, " · ", "what parts the wakeup's row apart", Self.webCard)
    }

    // MARK: fixtures

    private func wake(jobs: [BackgroundWakeJob], wakeups: [ScheduledWakeup] = []) -> BackgroundWake {
        BackgroundWake(jobs: jobs, wakeups: wakeups, text: "", rest: "")
    }

    private func job(status: String = "completed", ended: Bool = true, exitCode: Int? = 0,
                     killReason: String? = nil, description: String? = nil) -> BackgroundWakeJob {
        BackgroundWakeJob(id: "bgj_1", kind: "job", command: "bash a.sh", description: description,
                          status: status, ended: ended, exitCode: exitCode, killReason: killReason,
                          outputPath: nil, outputFrom: nil, outputTo: nil, outputTail: "")
    }
}
