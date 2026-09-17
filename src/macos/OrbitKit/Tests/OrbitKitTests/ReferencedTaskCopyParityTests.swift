import Foundation
import XCTest
@testable import OrbitKit

/// The two clients read one `<referenced-task>` block the same way and say the same words about it,
/// and this is the tripwire that keeps them doing it.
///
/// `ReferencedTask.swift` is a hand-copy of the browser's reading of the blocks delivery appends for
/// a person's `#`-references (`lib/referencedTask.ts`) and of the cards it draws
/// (`ReferencedTaskNote.tsx`). The Swift client and the browser bundle share no compiler, so a
/// wording reworded at one end simply never appears at the other — and the reading is where that
/// costs most: a field label only one end matches is a note that end draws as the plain-text table
/// this work replaced, id and all.
///
/// Shaped after `BackgroundJobsCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A check that quietly opts out reports green on
/// exactly the day the thing it watches goes missing.
final class ReferencedTaskCopyParityTests: XCTestCase {

    private static let webTasks = "src/web/src/lib/referencedTask.ts"
    private static let webNote = "src/web/src/components/ReferencedTaskNote.tsx"
    private static let webFixtures = "src/web/src/lib/referencedTask.fixtures.ts"
    private static let webTranscript = "src/web/src/components/Transcript.tsx"
    private static let webPill = "src/web/src/components/TaskStatusPill.tsx"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case notDeclared(what: String, file: String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(ReferencedTaskCopyParityTests.webTasks) was not found above this test "
                    + "file. OrbitKit's reading of the block is one half of a pair; if the web half "
                    + "moved, move this check with it rather than deleting it."
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
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webTasks).path) {
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
    /// wrong: a label only the browser matches is a note this client draws as the plain-text table
    /// this work replaced — which is the screenshot it started from. It is also the pair most likely
    /// to drift silently, since the blocks already in the record are read by these patterns alone.
    func testTheGrammarOfTheBlockIsTheSameOnBothEnds() throws {
        let web = try flat(Self.webTasks)
        let pairs = [
            ("BLOCK", ReferencedTaskText.blockPattern),
            ("FIELD", ReferencedTaskText.fieldPattern),
            ("PLACE", ReferencedTaskText.placePattern),
            ("RUNS", ReferencedTaskText.runsPattern),
        ]
        for (name, mine) in pairs {
            let theirs = try capture(web, "const \(name) =\\s*/(.+?)/g?;", name, Self.webTasks)
            XCTAssertEqual(mine, theirs,
                           "the \(name) pattern drifted — first is this client's, second is \(name) "
                               + "in \(Self.webTasks). A label only one end matches is a note that "
                               + "end draws as a plain-text table.")
        }
        // What the status line hangs its suffixes off, which is also what a card hangs them off.
        XCTAssertEqual(ReferencedTaskText.suffix,
                       try capture(web, "const SUFFIX = '(.+?)';", "SUFFIX", Self.webTasks),
                       "the separator the status line is split on drifted — a card would keep the "
                           + "whole of `DONE · 验收任务` as the status, or lose the suffix entirely.")
    }

    /// Every field of a card goes by the same name on both ends, in the same order. The cards are
    /// two readings of one block, and a field one end never learned to read is simply blank there.
    func testEveryFieldIsCalledWhatWebCallsIt() throws {
        let web = try flat(Self.webTasks)
        let mine: [(String, Any)] = [
            ("ReferencedTask", ReferencedTask(id: "", title: "", status: "", suffixes: [], list: "",
                                              assignee: "", runs: 0, executed: 0, lastRun: "")),
            ("ReferencedTasks", ReferencedTasks(tasks: [], rest: "")),
        ]
        for (name, value) in mine {
            let body = try section(web, from: "export interface \(name) {", to: "\n}", Self.webTasks)
            let theirs = try captures(body, "(?m)^  (\\w+):")
            guard !theirs.isEmpty else {
                throw ParityError.notDeclared(what: "any field of \(name)", file: Self.webTasks)
            }
            XCTAssertEqual(Mirror(reflecting: value).children.compactMap(\.label), theirs,
                           "\(name)'s fields drifted — first is this client's, second is the "
                               + "interface in \(Self.webTasks).")
        }
    }

    // MARK: the line that names the note folded

    /// The count on the shut line, word for word. It is the one sentence of this work a reader meets
    /// without opening anything, and the two clients disagreeing about it is the drift a reader can
    /// see from across the room.
    func testTheSummaryIsCountedInTheSameWords() throws {
        let web = try flat(Self.webTasks)
        let summarize = try section(web, from: "export function summarizeReferencedTasks(", to: "\n}",
                                    Self.webTasks)

        XCTAssertEqual(ReferencedTaskNote.summary([task(status: "DONE")]), "DONE")
        assertBuilt(summarize, "if (tasks.length === 1) return tasks[0].status;",
                    "a lone task saying its state outright", Self.webTasks)
        XCTAssertEqual(ReferencedTaskNote.summary([task(status: "DONE"), task(status: "OPEN"),
                                                   task(status: "DONE")]),
                       "2 DONE, 1 OPEN")
        assertBuilt(summarize, "`${n} ${status}`", "how several are counted", Self.webTasks)
        assertBuilt(summarize, ".join(', ')", "what parts the count", Self.webTasks)
    }

    /// The fold head the summary hangs off, which is the browser's `ControlPlaneNote`.
    func testTheFoldHeadIsBuiltTheSameWay() throws {
        let web = try flat(Self.webTranscript)
        let note = try section(web, from: "function ControlPlaneNote(", to: "\n}", Self.webTranscript)

        assertBuilt(note, "`⊕ Orbit attached: ${kind}`", "the line naming what was attached",
                    Self.webTranscript)
        assertBuilt(note, "` · ${summarizeReferencedTasks(tasks.tasks)}`",
                    "the count hung off that line", Self.webTranscript)
        // Read from what the inventory did not take, so a note carrying both draws each block once.
        assertBuilt(note, "parseReferencedTasks(jobs ? jobs.rest : text)",
                    "the references read out of what the inventory left", Self.webTranscript)
        assertBuilt(note, "<ReferencedTaskNote tasks={tasks.tasks} />", "the cards the fold opens to",
                    Self.webTranscript)
        assertBuilt(note, "rest !== ''", "another block the same note carried", Self.webTranscript)
    }

    // MARK: the cards the reading becomes

    func testTheCardsSayWhatTheWebCardsSay() throws {
        let web = try flat(Self.webNote)

        // The title is the link, and both ends name the same id in it: web routes to its own page,
        // this client to the scheme its shells route (`ReferenceLink`).
        assertBuilt(web, "`/tasks/${task.id}`", "where a card's title goes", Self.webNote)
        XCTAssertEqual(ReferencedTaskNote.link(task(id: "34OAsTIS8JuGm5H2j95qO"))?.absoluteString,
                       "orbit-task:34OAsTIS8JuGm5H2j95qO")
        assertBuilt(web, "{task.suffixes.map(", "what the status line said after the status",
                    Self.webNote)

        let meta = try section(web, from: "function meta(", to: "\n}", Self.webNote)
        XCTAssertEqual(ReferencedTaskNote.meta(task()), "34OAsTIS8JuGm5H2j95qO · (无列表) · orbit · 1 run")
        assertBuilt(meta, "`${task.id} · ${task.list} · ${task.assignee} · ${runs(task)}`",
                    "the ids under a card", Self.webNote)

        let outcome = try section(web, from: "function outcome(", to: "\n}", Self.webNote)
        XCTAssertEqual(ReferencedTaskNote.outcome(task()), "SUCCEEDED, 59 turns")
        XCTAssertEqual(ReferencedTaskNote.outcome(task(runs: 0, executed: 0)), "")
        assertBuilt(outcome, "task.runs === 0 ? '' : task.lastRun",
                    "how a card's last run is said, and a task nothing has run having none",
                    Self.webNote)

        let runs = try section(web, from: "function runs(", to: "\n}", Self.webNote)
        XCTAssertEqual(ReferencedTaskNote.runs(task(runs: 0, executed: 0)), "never run")
        assertBuilt(runs, "if (task.runs === 0) return 'never run';", "a task nothing has run",
                    Self.webNote)
        XCTAssertEqual(ReferencedTaskNote.runs(task()), "1 run")
        XCTAssertEqual(ReferencedTaskNote.runs(task(runs: 2, executed: 2)), "2 runs")
        assertBuilt(runs, "task.runs === 1 ? '1 run' : `${task.runs} runs`", "how runs are counted",
                    Self.webNote)
        // The one number a reader should be made to notice: a run that never took a turn.
        XCTAssertEqual(ReferencedTaskNote.runs(task(runs: 1, executed: 0)), "1 run, 0 with turns")
        assertBuilt(runs, "`${counted}, ${task.executed} with turns`",
                    "the runs that took no turn", Self.webNote)
    }

    /// The pill a card opens on. Both ends draw the task lifecycle with the same five words, and a
    /// status neither knows under its own name — a card that renamed a status would be describing a
    /// different task from the one the block named.
    func testTheStatusIsPilledInTheSameWords() throws {
        let web = try flat(Self.webPill)
        let declared = try section(web, from: "const STATUS_PILL", to: "\n}", Self.webPill)

        for status in ["DONE", "IN_PROGRESS", "OPEN", "FAILED", "CANCELLED"] {
            let theirs = try capture(declared, "\(status): \\{ cls: '[^']+', label: '([^']+)' \\}",
                                     status, Self.webPill)
            XCTAssertEqual(ReferencedTaskNote.pill(task(status: status)).label, theirs,
                           "the pill for \(status) drifted — first is this client's, second is "
                               + "STATUS_PILL in \(Self.webPill).")
        }
        // A status neither end knows keeps its own name rather than borrowing a wrong one.
        XCTAssertEqual(ReferencedTaskNote.pill(task(status: "ARCHIVED")).label, "ARCHIVED")
        assertBuilt(web, "?? { cls: 'todo', label: status }", "a status neither end knows",
                    Self.webPill)
    }

    // MARK: the notes both ends are proved against

    /// Every fixture this client reads is the browser's own, byte for byte.
    ///
    /// They were copied out of this deployment's `run_event` rows and are the only evidence either
    /// reading has that it reads what is actually sent. Two ends drifting to two sets of notes would
    /// leave both green while disagreeing about the same transcript.
    func testTheNotesBothEndsAreProvedAgainstAreTheSameNotes() throws {
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

        XCTAssertEqual(Set(ReferencedTaskFixtures.all.keys), Set(declared.keys),
                       "the fixtures drifted: \(Self.webFixtures) and this client no longer hold the "
                           + "same notes. Re-transcribe rather than retype — the notes are "
                           + "run_event rows, not prose.")
        for (name, mine) in ReferencedTaskFixtures.all {
            XCTAssertEqual(mine, declared[name],
                           "\(name) drifted from \(Self.webFixtures). Both ends have to be read "
                               + "against the same note or neither proves anything.")
        }
    }

    // MARK: fixtures

    private func task(id: String = "34OAsTIS8JuGm5H2j95qO", status: String = "DONE", runs: Int = 1,
                      executed: Int = 1) -> ReferencedTask {
        ReferencedTask(id: id, title: "合入闭包", status: status, suffixes: [], list: "(无列表)",
                       assignee: "orbit", runs: runs, executed: executed,
                       lastRun: runs == 0 ? "从未运行" : "SUCCEEDED, 59 turns")
    }
}
