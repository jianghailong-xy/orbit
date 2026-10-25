import Foundation
import XCTest
@testable import OrbitKit

/// The project's main branch says the same words, and follows the same rules, on both clients: the
/// Main branch row of the start card and How it runs, its picker, the order the start card opens on,
/// and every settings sentence that says where work goes — each one a function of the branch here as
/// it is in the browser's `lib/projectStart.ts`.
///
/// Shaped after `StartProjectCardCopyParityTests`: a missing counterpart is a FAILURE, never an
/// `XCTSkip`, and a sentence with a branch in it is rendered here with a sentinel branch that is put
/// back as the web template's own `${main}`, so the words either side of the name are held too. The
/// sentences' words at main are `StartProjectCardCopyParityTests`' and
/// `ProjectRunSettingsCopyParityTests`' to hold; `ProjectMainBranchTests` holds each function, at main,
/// to them.
final class ProjectMainBranchCopyParityTests: XCTestCase {

    private static let words = "src/web/src/lib/projectStart.ts"
    private static let select = "src/web/src/components/MainBranchSelect.tsx"
    private static let card = "src/web/src/components/StartProjectCard.tsx"
    private static let block = "src/web/src/components/ProjectRunSettings.tsx"

    /// A branch name, and a time, no sentence uses.
    private static let branch = "Qzbranch"
    private static let since = "Qzsince"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The native Main branch row is one half of a pair; "
                + "if the web half moved, move this check with it rather than deleting it."
        }
    }

    /// One web source with its string literals put back together — `'…' + '…'` and `` `…` + '…' ``
    /// across lines are one sentence to a reader — and a value on the line under its `=` pulled up.
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

    /// This end's sentence of the sentinel branch, as the web template writes it: the branch put back as
    /// `${main}`. The web wraps long sentences, so what is held is the words, whichever quote closes them.
    private func template(_ sentence: String) -> String {
        sentence.replacingOccurrences(of: Self.branch, with: "${main}")
    }

    // MARK: the row's own words

    func testTheMainBranchRowsWordsAreTheWebsOwn() throws {
        let web = try flat(Self.words)
        assertDeclares(web, "DEFAULT_MAIN_BRANCH", RunSettings.defaultMainBranch)
        assertDeclares(web, "RUN_MAIN_BRANCH", RunSettings.mainBranch)
        assertDeclares(web, "RUN_MAIN_BRANCH_HINT", RunSettings.mainBranchHint)
        assertDeclares(web, "RUN_LAST_CHOSEN", RunSettings.lastChosen)
        assertDeclares(web, "RUN_TYPE_A_BRANCH", RunSettings.typeABranch)
        let repository = "Qzrepo"
        for (swift, web_) in [
            (RunSettings.lastChoiceFor(repository), "`Your last choice for ${repository}`"),
            (RunSettings.mainBranchRemembers(repository), "`New projects in ${repository} start with your last choice.`"),
        ] {
            XCTAssertEqual("`\(swift.replacingOccurrences(of: repository, with: "${repository}"))`", web_)
            assertSays(web, web_, in: Self.words)
        }
        assertSays(web, "`\(RunSettings.branchesIn("Qzspace").replacingOccurrences(of: "Qzspace", with: "${workspace}"))`",
                   in: Self.words)
        assertSays(web, "`\(RunSettings.useBranch("Qzname").replacingOccurrences(of: "Qzname", with: "${name}"))`",
                   in: Self.words)
        // A main branch as the doors take it, and as a sentence names it.
        assertSays(web, "return `refs/heads/${name}`;", in: Self.words)
        XCTAssertEqual(RunSettings.mainBranchRef("Qz"), "refs/heads/Qz")
        assertSays(web, "return ref ? ref.replace(/^refs\\/heads\\//u, '') : DEFAULT_MAIN_BRANCH;", in: Self.words)
    }

    // MARK: the sentences that name the branch

    func testEverySentenceThatSaysWhereWorkGoesNamesTheBranchAsTheWebDoes() throws {
        let web = try flat(Self.words)
        let main = Self.branch
        let sentences: [(String, String)] = [
            ("runLineMain", RunSettings.lineMain(main)),
            ("runLineMainHint", RunSettings.lineMainHint(main)),
            ("automaticHintProjectBranch", RunSettings.automaticHint(.projectBranch, main: main)),
            ("automaticHintMain", RunSettings.automaticHint(.main, main: main)),
            ("runMergeCheckHint", RunSettings.mergeCheckHint(main)),
            ("runNoMergeCheckWarning", RunSettings.noMergeCheckWarning(main)),
            ("runAutomaticSays, on, checked",
             RunSettings.automaticSays(automatic: true, line: .projectBranch, hasMergeCheck: true, main: main)),
            ("runAutomaticSays, on, unchecked",
             RunSettings.automaticSays(automatic: true, line: .projectBranch, hasMergeCheck: false, main: main)),
            ("runAutomaticSays, on, directly", RunSettings.automaticSays(automatic: true, line: .main,
                                                                          hasMergeCheck: true, main: main)),
            ("runAutomaticSays, off", RunSettings.automaticSays(automatic: false, line: .projectBranch,
                                                                 hasMergeCheck: true, main: main)),
            ("runAutomaticSays, off, directly", RunSettings.automaticSays(automatic: false, line: .main,
                                                                          hasMergeCheck: false, main: main)),
            ("startMergingInto", StartProject.mergingInto(main)),
            ("startEachMergeInto", StartProject.eachMergeInto(main)),
            ("runLineInSentence", RunSettings.lineInSentence(.main, main: main)),
            ("runPauseHint", RunSettings.pauseHint(main)),
        ]
        for (what, sentence) in sentences {
            XCTAssertTrue(sentence.contains(main), "\(what) does not name the branch at this end")
            assertSays(web, template(sentence), in: "\(Self.words) (\(what))")
        }
        // The lock sentence under Main branch, with its time put back as the web's own interpolation.
        let locked = template(RunSettings.mainBranchLocked(since: Self.since, main: main))
            .replacingOccurrences(of: " \(Self.since)", with: "${since ? ` ${since}` : ''}")
        assertSays(web, "return `\(locked)`;", in: Self.words)
    }

    // MARK: what the card opens on, and what a press sends

    func testTheStartCardOpensOnTheMainBranchByTheWebsOrder() throws {
        let web = try flat(Self.words)
        // This project's own choice, the last choice for its repository, the suggestion, main.
        for part in ["(standing?.upstreamChosenAt ? standing.upstreamRef : null)",
                     "?? standing?.lastMainBranch?.branch", "?? suggested,"] {
            assertSays(web, part, in: Self.words)
        }
        let card = try flat(Self.card)
        // Offered only where the read says the project has a repository …
        assertSays(card, "upstream: standing?.repository ? startMainBranch(settings.upstreamRef, standing) : null,",
                   in: Self.card)
        // … sent as a full ref whenever the card offered one …
        assertSays(card, "...(draft.upstream ? { upstreamRef: mainBranchRef(draft.upstream) } : {}),", in: Self.card)
        // … and the owner's own Start… keeps the branch the project stands on.
        assertSays(card, "...(view.upstreamRef ? { upstreamRef: mainBranchRef(view.upstreamRef) } : {}),",
                   in: Self.card)
        // The row: drawn only with a branch to name, under Tasks land on and over Merge check, saying
        // where its branch came from while it is the last choice for the repository.
        assertSays(card, "{draft.upstream !== null ? (", in: Self.card)
        assertSays(card, "{lastMainBranch && draft.upstream === lastMainBranch.branch ? (", in: Self.card)
        assertSays(card, "{runLastChoiceFor(lastMainBranch.repository)}", in: Self.card)
        let order = ["<span>{RUN_TASKS_LAND_ON}</span>", "<span>{RUN_MAIN_BRANCH}</span>", "<span>{RUN_MERGE_CHECK}</span>"]
        let at = order.map { card.range(of: $0)?.lowerBound }
        XCTAssertFalse(at.contains(nil), "the web card lost one of \(order)")
        XCTAssertEqual(at.compactMap { $0 }, at.compactMap { $0 }.sorted(), "Main branch sits under Tasks land on")
        // Every sentence on the card names the branch on it, or main for a project with no repository.
        assertSays(card, "const main = draft.upstream ?? DEFAULT_MAIN_BRANCH;", in: Self.card)
    }

    // MARK: the picker

    func testThePickerListsAndTakesWhatTheWebsSelectDoes() throws {
        let select = try flat(Self.select)
        // Reported branches, the remembered one and the current one, each once, in that order …
        assertSays(select, "[...new Set([...(branches?.names ?? []), ...(remembered ? [remembered] : []), value])]",
                   in: Self.select)
        // … a typed name nobody reported offered as itself, when it looks like a branch name …
        assertSays(select, "typed && !names.includes(typed) && BRANCH_NAME.test(typed)", in: Self.select)
        assertSays(select, "label: runUseBranch(typed)", in: Self.select)
        // … by git's rule, near enough, which `RunSettings.takesBranchName` spells out.
        assertSays(select, "const BRANCH_NAME = /^(?![-/])(?!.*\\.\\.)(?!.*\\/$)(?!.*\\.lock$)[^\\s~^:?*[\\\\]+$/u;",
                   in: Self.select)
        // The head, the tag and the foot.
        assertSays(select, "{branches ? runBranchesIn(branches.workspaceName) : RUN_TYPE_A_BRANCH}", in: Self.select)
        assertSays(select, "{option.value === remembered ? <span className=\"main-branch-tag\">{RUN_LAST_CHOSEN}</span> : null}",
                   in: Self.select)
        assertSays(select, "{RUN_MAIN_BRANCH_HINT}", in: Self.select)
        XCTAssertEqual(RunSettings.branchesHead(nil), RunSettings.typeABranch)
    }

    // MARK: How it runs

    func testHowItRunsShowsWritesAndLocksTheMainBranchAsTheWebBlockDoes() throws {
        let block = try flat(Self.block)
        // The branch it stands on: before binding, the one binding gives it; none without a repository.
        assertSays(block, "return view.repository ? mainBranchName(view.upstreamRef ?? view.lastMainBranch?.branch) : null;",
                   in: Self.block)
        // Written only while it can move, and only when it moves, as a full ref.
        assertSays(block, "...(!view.locked && draft.upstream !== null && draft.upstream !== storedUpstream(view)",
                   in: Self.block)
        assertSays(block, "? { upstreamRef: mainBranchRef(draft.upstream) }", in: Self.block)
        // What it says under the row: what it decides and that it is the repository's next default, or
        // once locked, why — and the line's own lock sentence only where there is no such row.
        assertSays(block, "? runMainBranchLocked(view.startedAt ? ago(view.startedAt, now) : null, main)", in: Self.block)
        assertSays(block, ": `${RUN_MAIN_BRANCH_HINT} ${runMainBranchRemembers(repository)}`}", in: Self.block)
        XCTAssertEqual(
            RunSettings.mainBranchNote(ProjectIntegrationView(upstreamRef: "master", repository: "Qzrepo"), since: nil),
            "\(RunSettings.mainBranchHint) \(RunSettings.mainBranchRemembers("Qzrepo"))")
        assertSays(block, "{view.locked && repository === null ? (", in: Self.block)
        assertSays(block, "{repository !== null && draft.upstream !== null ? (", in: Self.block)
        // Under Tasks land on, over Automatic.
        let order = ["{RUN_TASKS_LAND_ON}</div>", "{RUN_MAIN_BRANCH}</div>", "{RUN_AUTOMATIC}</div>"]
        let at = order.map { block.range(of: $0)?.lowerBound }
        XCTAssertFalse(at.contains(nil), "the web block lost one of \(order)")
        XCTAssertEqual(at.compactMap { $0 }, at.compactMap { $0 }.sorted())
        // Every sentence of the block names the branch being chosen; Pause the one the project stands on.
        assertSays(block, "const main = draft.upstream ?? DEFAULT_MAIN_BRANCH;", in: Self.block)
        assertSays(block, "runPauseHint(stored.upstream ?? DEFAULT_MAIN_BRANCH)", in: Self.block)
        assertSays(block, "{runLineMain(main)}", in: Self.block)
        assertSays(block, "{runLineMainHint(main)}", in: Self.block)
        assertSays(block, "{runMergeCheckHint(main)}", in: Self.block)
        assertSays(block, "{runNoMergeCheckWarning(main)}", in: Self.block)
    }
}
