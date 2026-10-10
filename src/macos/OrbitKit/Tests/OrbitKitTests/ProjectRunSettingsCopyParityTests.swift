import Foundation
import XCTest
@testable import OrbitKit

/// The project page says the same words on both clients about starting a project and about how a
/// started one runs — "Not started", the start's row in Open items, the line undecided until the
/// start, and every row of How it runs — and this is the tripwire that keeps it so.
///
/// The browser declares each sentence once, in `lib/projectStart.ts` (and the escalation window's
/// points in `ProjectRunSettings.tsx`, which draws the block); this client holds the same sentences
/// by hand (`StartProject`, `RunSettings`, in `ProjectRunSettings.swift`). Nothing in either build
/// notices a sentence re-worded at one end only, so this reads the other end's source.
///
/// A missing counterpart is a FAILURE, never an `XCTSkip`: a check that quietly opts out reports
/// green on exactly the day the thing it watches goes missing. The words of the settings the start
/// card and How it runs share — Tasks land on, Automatic, At most, Merge check — are
/// `StartProjectCardCopyParityTests`' to hold; this holds what the project page adds to them.
final class ProjectRunSettingsCopyParityTests: XCTestCase {

    private static let words = "src/web/src/lib/projectStart.ts"
    private static let block = "src/web/src/components/ProjectRunSettings.tsx"
    private static let line = "src/web/src/components/ProjectIntegrationLine.tsx"
    private static let openItems = "src/web/src/components/ProjectProgressStatus.tsx"
    private static let card = "src/web/src/components/StartProjectCard.tsx"

    /// A sentinel no sentence uses, put back as the web template's own interpolation.
    private static let since = "qqzzqq"

    /// One of this end's sentences about main, as the browser writes it for whichever branch is the
    /// project's main branch: each `main` put back as the template's `${main}`. A project on main then
    /// reads the same sentence at both ends.
    private static func onMainBranch(_ sentence: String) -> String {
        sentence.replacingOccurrences(of: "main", with: "${main}")
    }

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native project page is one half of a "
                + "pair; if the web half moved, move this check with it rather than deleting it."
        }
    }

    /// One web source with its string literals put back together — TypeScript wraps a long sentence
    /// as `'…' + '…'` across lines, and where that wrap falls is formatting while the words are the
    /// contract — and a value sitting on the line under its `=` pulled up.
    private func flat(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "=\\s*\\n\\s*(['`])", with: "= $1", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    private func assertDeclares(_ web: String, _ name: String, _ value: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains("export const \(name) = '\(value)';"),
                      "\(Self.words) no longer declares \(name) as \(value.debugDescription)",
                      file: file, line: line)
    }

    private func assertSays(_ web: String, _ literal: String, in source: String,
                            file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains(literal), "\(source) no longer says \(literal)", file: file, line: line)
    }

    // MARK: before the start

    func testTheNotStartedTagAndTheStartRowAreTheWebsWords() throws {
        let web = try flat(Self.words)
        assertDeclares(web, "NOT_STARTED", StartProject.notStarted)
        assertDeclares(web, "START_ROW_ASKED", StartProject.rowAsked)
        assertDeclares(web, "START_ROW_OWN", StartProject.rowOwn)
        assertDeclares(web, "START_ROW_NOT_ASKED", StartProject.rowNotAsked)
        assertDeclares(web, "START_PROJECT_TITLE", StartProject.title)

        // The request's row, rendered whole and held to the browser's own function part by part.
        let suggestion = ProjectStartSettings(line: .projectBranch, automatic: true, maxConcurrentTasks: 23)
        XCTAssertEqual(StartProject.requestSummary(suggestion),
                       "The coordinator asked · a project branch · Automatic on · at most 23 at a time")
        XCTAssertEqual(StartProject.requestSummary(ProjectStartSettings(line: .main, automatic: false,
                                                                        maxConcurrentTasks: 1)),
                       "The coordinator asked · directly into main · Automatic off · at most 1 at a time")
        for part in ["START_ROW_ASKED,", "runLineInSentence(settings.line),",
                     "`${RUN_AUTOMATIC} ${settings.automatic ? 'on' : 'off'}`,",
                     "`at most ${settings.maxConcurrentTasks} at a time`,", "].join(' · ');"] {
            assertSays(web, part, in: Self.words)
        }
        // Directly into the project's main branch: main, on a project on main.
        assertSays(web, "return line === 'MAIN' ? `\(Self.onMainBranch(RunSettings.lineInSentence(.main)))` : '\(RunSettings.lineInSentence(.projectBranch))';",
                   in: Self.words)

        // Where the page draws them: the request's row under the card's own question, and the owner's
        // own Start… beside the words that say nobody asked.
        let items = try flat(Self.openItems)
        assertSays(items, "const line = settings ? startRequestSummary(settings) : row.detailLine;", in: Self.openItems)
        assertSays(items, "{START_PROJECT_TITLE}", in: Self.openItems)
        assertSays(items, "{ACTION_LABEL.REVIEW}", in: Self.openItems)
        assertSays(items, "{START_ROW_OWN}", in: Self.openItems)
        assertSays(items, "{START_ROW_NOT_ASKED}", in: Self.openItems)
    }

    /// The line row of a project nobody has started: the start decides it, and once the coordinator
    /// has asked, which line it suggests.
    func testTheUndecidedLineIsTheWebsSentence() throws {
        let web = try flat(Self.words)
        assertDeclares(web, "RUN_LINE_DECIDED_AT_START", RunSettings.lineDecidedAtStart)
        assertDeclares(web, "RUN_LINE_SUGGESTED", RunSettings.lineSuggested)
        XCTAssertEqual(RunSettings.undecidedLine(suggested: nil), "Tasks land on: decided when you start")
        XCTAssertEqual(RunSettings.undecidedLine(suggested: .projectBranch),
                       "Tasks land on: decided when you start — the coordinator suggests a project branch")
        let row = try flat(Self.line)
        assertSays(row, "{`${RUN_TASKS_LAND_ON}: `}", in: Self.line)
        assertSays(row, "<b>{RUN_LINE_DECIDED_AT_START}</b>", in: Self.line)
        assertSays(row, "{` — ${RUN_LINE_SUGGESTED} `}", in: Self.line)
        // …directly into the main branch the start opens with: main, until the owner chooses another.
        assertSays(row, "<b>{runLineInSentence(suggested, startMainBranch(suggestion?.upstreamRef, view))}</b>", in: Self.line)
    }

    /// Start… opens the start card set by the default rule, the browser's `defaultStartSettings`,
    /// rule for rule — and the card it opens is one nobody asked for.
    func testTheOwnersStartIsSetByTheWebsDefaultRule() throws {
        let card = try flat(Self.card)
        for rule in ["const line = view.line ?? (graph && planHasDependencies(graph) ? 'PROJECT_BRANCH' : 'MAIN');",
                     "...(view.line === 'PROJECT_BRANCH' && view.ref ? { projectBranchName: `refs/heads/${view.ref}` } : {}),",
                     "automatic: true,", "maxConcurrentTasks: project.maxConcurrentTasks ?? 1,",
                     "mergeCheckCommand: view.mergeCheckCommand ?? null,",
                     "return graph.marks.some((mark) => mark.kind === 'RUN')",
                     "|| graph.edges.some((edge) => live.has(edge.sourceMarkId) && live.has(edge.targetMarkId));",
                     // Not asked: nobody quoted, no "the coordinator's suggestion", no Chat — and no
                     // request for the press to answer.
                     "askedAt={null}", "why: '',", "warnings: [],", "start.mutate(startBody(request, draft, null));",
                     "facts={startProjectFacts(document, false)}"] {
            assertSays(card, rule, in: Self.card)
        }
        assertSays(card, "{startHowItRunsNote(asked, asked && request.settings.automatic === false)}",
                   in: Self.card)
        assertSays(card, "{asked && request.why ? (", in: Self.card)
        assertSays(card, "{onChatAbout ? (", in: Self.card)
    }

    // MARK: How it runs

    func testHowItRunsSaysTheWebsWords() throws {
        let web = try flat(Self.words)
        assertDeclares(web, "START_HOW_IT_RUNS", StartProject.howItRuns)
        assertDeclares(web, "RUN_APPLIES_FROM_NEXT_TASK", RunSettings.appliesFromNextTask)
        assertDeclares(web, "RUN_ESCALATE_AFTER", RunSettings.escalateAfter)
        assertDeclares(web, "RUN_ESCALATE_HINT", RunSettings.escalateHint)
        assertDeclares(web, "RUN_SAVE", RunSettings.save)
        assertDeclares(web, "RUN_NOT_SAVED", RunSettings.notSaved)
        assertDeclares(web, "RUN_PAUSE", RunSettings.pause)
        assertDeclares(web, "RUN_PAUSE_HINT", RunSettings.pauseHint)
        assertDeclares(web, "RUN_RESUME", RunSettings.resume)
        assertDeclares(web, "RUN_NOT_PAUSED", RunSettings.notPaused)
        assertDeclares(web, "RUN_NOT_RESUMED", RunSettings.notResumed)

        let block = try flat(Self.block)
        assertSays(block, "title=\"\(RunSettings.notLoaded)\"", in: Self.block)
        assertSays(block, "{START_HOW_IT_RUNS}</span>", in: Self.block)
        assertSays(block, "{RUN_APPLIES_FROM_NEXT_TASK}</span>", in: Self.block)
        assertSays(block, "{paused ? RUN_RESUME : RUN_PAUSE}", in: Self.block)
        assertSays(block, "title={move.variables === 'resume' ? RUN_NOT_RESUMED : RUN_NOT_PAUSED}", in: Self.block)
        assertSays(block, "title={RUN_NOT_SAVED}", in: Self.block)
        // The Automatic sentence follows the line — the one chosen, or a project branch while none is —
        // and names the project's main branch, which is main on a project on main.
        assertSays(block, "{runAutomaticHint(draft.line ?? 'PROJECT_BRANCH', main)}", in: Self.block)
        assertSays(block, "const main = draft.upstream ?? DEFAULT_MAIN_BRANCH;", in: Self.block)
    }

    /// The two sentences with a time in them, rendered here with a sentinel and put back as the
    /// browser's own interpolation.
    func testTheLockedLineAndThePauseSayTheWebsSentences() throws {
        let web = try flat(Self.words)
        let locked = RunSettings.lineLocked(since: Self.since)
            .replacingOccurrences(of: " \(Self.since)", with: "${since ? ` ${since}` : ''}")
        assertSays(web, "return `\(locked)';", in: Self.words)
        XCTAssertEqual(RunSettings.lineLocked(since: nil),
                       "This project started integrating, so the line it lands on can no longer change. "
                           + "Merge it into main, or give up the branch, to start another.")
        let paused = RunSettings.pausedSince(Self.since).replacingOccurrences(of: Self.since, with: "${since}")
        assertSays(web, "return `\(paused)`;", in: Self.words)

        let block = try flat(Self.block)
        assertSays(block, "{runLineLocked(view.startedAt ? ago(view.startedAt, now) : null)}", in: Self.block)
        // What Pause stops, said of the main branch the project stands on: this end's sentence, on a
        // project on main.
        assertSays(web, "return `\(Self.onMainBranch(RunSettings.pauseHint))`;", in: Self.words)
        assertSays(block, "? `${runPausedSince(ago(project.pausedAt, now))} ${runPauseHint(stored.upstream ?? DEFAULT_MAIN_BRANCH)}`", in: Self.block)
        assertSays(block, ": runPauseHint(stored.upstream ?? DEFAULT_MAIN_BRANCH)}", in: Self.block)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let twentyMinutes = ISO8601DateFormatter().string(from: now.addingTimeInterval(-20 * 60))
        XCTAssertEqual(RunSettings.pauseFootnote(pausedAt: twentyMinutes, now: now),
                       "Paused 20m ago. \(RunSettings.pauseHint)")
        XCTAssertEqual(RunSettings.pauseFootnote(pausedAt: nil, now: now), RunSettings.pauseHint)
    }

    /// The escalation window's points and the words for one nobody offered.
    func testTheEscalationChoicesAreTheWebsOwn() throws {
        let block = try flat(Self.block)
        for choice in RunSettings.escalationChoices {
            assertSays(block, "{ seconds: \(choice.seconds), label: '\(choice.label)' },", in: Self.block)
        }
        let points = try NSRegularExpression(pattern: "\\{ seconds: \\d+, label: '")
        let offered = points.numberOfMatches(in: block, range: NSRange(block.startIndex..., in: block))
        XCTAssertEqual(offered, RunSettings.escalationChoices.count,
                       "the browser offers a point this client does not, or the other way round")
        assertSays(block, "return `${hours} hour${hours === 1 ? '' : 's'}`;", in: Self.block)
        assertSays(block, "return `${minutes} minute${minutes === 1 ? '' : 's'}`;", in: Self.block)
        XCTAssertEqual(RunSettings.escalationLabel(3 * 3600), "3 hours")
        XCTAssertEqual(RunSettings.escalationLabel(3600), "1 hour")
        XCTAssertEqual(RunSettings.escalationLabel(300), "5 minutes")
        XCTAssertEqual(RunSettings.escalationOptions(current: 7200), RunSettings.escalationChoices)
        XCTAssertEqual(RunSettings.escalationOptions(current: 300).last,
                       RunSettings.EscalationChoice(seconds: 300, label: "5 minutes"),
                       "a window nobody offered is shown as itself, not snapped to a point")
    }

    /// The block's rows, in the browser's order — the native block reads them in the same order
    /// (`ProjectsWiringTests`).
    func testTheWebBlockOrdersItsRowsTheWayTheNativeBlockDoes() throws {
        let block = try flat(Self.block)
        let order = ["{RUN_TASKS_LAND_ON}</div>", "{RUN_AUTOMATIC}</div>", "{RUN_AT_MOST}</div>",
                     "{RUN_MERGE_CHECK}</div>", "{RUN_ESCALATE_AFTER}</div>", "{paused ? RUN_RESUME : RUN_PAUSE}"]
        let positions = order.map { block.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "the web block lost one of \(order)")
        XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted())
    }
}
