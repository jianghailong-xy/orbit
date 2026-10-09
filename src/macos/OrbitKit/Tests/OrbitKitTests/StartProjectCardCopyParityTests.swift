import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words on "Start this project?", and this is the tripwire that keeps
/// them saying them.
///
/// The browser declares every sentence of the start card, of How it runs and of the settings line
/// once, in `lib/projectStart.ts` — a constant, or a function for a sentence with a number in it —
/// and this client holds the same sentences by hand (`StartProject`, `RunSettings`). Nothing in a
/// build catches a sentence re-worded at one end only, so this reads the other end's source.
///
/// Shaped after `AcceptanceConfirmationCopyParityTests`, including the part that matters most: a
/// missing counterpart is a FAILURE and never an `XCTSkip`. Every sentence is compared whole — one
/// with a count, a title or a seal in it is rendered here with sentinels, which are then put back as
/// the web template's own interpolations — so the words either side of a number are held too.
///
/// What is NOT compared, deliberately: the provenance badge (`FROM ORBIT`), which this client does
/// not draw on this card any more than on the confirmation card beside it, and the `ago` words,
/// which each end takes from its own clock (`RelativeTime.format` here, `ago` there).
final class StartProjectCardCopyParityTests: XCTestCase {

    private static let words = "src/web/src/lib/projectStart.ts"
    private static let card = "src/web/src/components/StartProjectCard.tsx"
    private static let workspace = "src/web/src/components/WorkspaceView.tsx"
    private static let console = "src/macos/OrbitApp/Sources/OrbitApp/ConsoleModel.swift"

    /// Sentinels that occur in no sentence: a count with no digit the copy uses, and a title and a
    /// seal made of letters the copy never puts together.
    private static let count = 23
    private static let title = "Aurora"
    private static let seal = "qqqqzzzzqqqq"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(StartProjectCardCopyParityTests.words) was not found above this test file. "
                    + "The native start card is one half of a pair; if the web half moved, move this "
                    + "check with it rather than deleting it."
            case .missing(let relative):
                return "\(relative) was not found. If it moved, move this check with it rather than "
                    + "deleting it."
            }
        }
    }

    /// The repo root, found by walking up from this file until the web module is under foot.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.words).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    /// One web source with its string literals put back together: TypeScript wraps a long sentence
    /// as `'…' + '…'` (or a template followed by a quoted string) across lines, and where that wrap
    /// falls is formatting while the words are the contract. A value sitting on the line under its
    /// `=` is pulled up.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
    }

    /// The other end declares this constant with exactly these words.
    private func assertDeclares(_ web: String, _ name: String, _ value: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(web.contains("export const \(name) = '\(value)'"),
                      "\(name) drifted: the web no longer declares it as \(value.debugDescription)",
                      file: file, line: line)
    }

    /// The other end writes this sentence as one literal, interpolations and all. The literal may
    /// close on either quote: a template wrapped onto a quoted string reads back as one literal that
    /// opens on a backtick and ends on `'`.
    private func assertSentence(_ web: String, _ rendered: String, _ values: [(String, String)],
                                _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let template = values.reduce(rendered) { text, pair in
            text.replacingOccurrences(of: pair.0, with: pair.1)
        }
        XCTAssertTrue(web.contains("`\(template)`") || web.contains("`\(template)'"),
                      "\(what) drifted: the web no longer contains `\(template)`",
                      file: file, line: line)
    }

    private var n: String { "\(Self.count)" }

    // MARK: the card

    func testTheCardsFixedWordsMatchTheWeb() throws {
        let web = try flat(Self.words)
        assertDeclares(web, "START_PROJECT_TITLE", StartProject.title)
        assertDeclares(web, "READY_TO_START", StartProject.readyToStart)
        assertDeclares(web, "START_DONE_WHEN", StartProject.doneWhen)
        assertDeclares(web, "START_PLAN", StartProject.plan)
        assertDeclares(web, "START_HOW_IT_RUNS", StartProject.howItRuns)
        assertDeclares(web, "START_VIEW_TASKS", StartProject.viewTasks)
        assertDeclares(web, "START_TASK_GRAPH", StartProject.taskGraph)
        assertDeclares(web, "START_PROJECT_ACTION", StartProject.action)
        assertDeclares(web, "START_CHAT_PLACEHOLDER", StartProject.chatPlaceholder)
        assertDeclares(web, "START_NOBODY_ASKED", StartProject.nobodyAsked)
        assertDeclares(web, "START_NO_COORDINATOR_YET", StartProject.noCoordinatorYet)
        assertDeclares(web, "START_COORDINATOR", StartProject.coordinator)
        assertDeclares(web, "START_MORE", StartProject.more)
        assertDeclares(web, "START_LESS", StartProject.less)
        assertDeclares(web, "START_NOT_RECORDED", StartProject.notRecorded)
        assertDeclares(web, "START_REQUEST_GONE", StartProject.requestGone)
        assertDeclares(web, "START_OPENS_COORDINATOR", StartProject.opensCoordinator)
        assertDeclares(web, "START_NOW", StartProject.now)
        assertDeclares(web, "START_YOU", StartProject.you)
        // What still comes to the owner, and whose settings these are.
        assertDeclares(web, "START_COMES_TO_YOU", StartProject.comesToYou)
        assertDeclares(web, "START_DECIDE_DONE", StartProject.decideDone)
        assertDeclares(web, "START_YOU_CONFIRM", StartProject.youConfirm)
        assertDeclares(web, "START_PROBLEMS", StartProject.problems)
        assertDeclares(web, "START_PROBLEMS_DETAIL", StartProject.problemsDetail)
        assertDeclares(web, "START_MERGING_INTO_MAIN", StartProject.mergingIntoMain)
        assertDeclares(web, "START_EACH_MERGE_INTO_MAIN", StartProject.eachMergeIntoMain)
        assertDeclares(web, "START_CRITERIA_CHANGES", StartProject.criteriaChanges)
        assertDeclares(web, "START_AUTOMATIC_BY_DEFAULT", StartProject.automaticByDefault)
        assertDeclares(web, "START_COORDINATOR_SUGGESTED_OFF", StartProject.coordinatorSuggestedOff)
        assertDeclares(web, "START_REST_SUGGESTED", StartProject.restSuggested)
        assertDeclares(web, "START_CHANGE_LATER", StartProject.changeLater)
    }

    func testTheSectionHeadsAndTheHeaderLineMatchTheWebWhole() throws {
        let web = try flat(Self.words)
        let criteria = "${count === 1 ? 'criterion' : 'criteria'}"
        assertSentence(web, StartProject.doneWhenHead(Self.count),
                       [(StartProject.doneWhen, "${START_DONE_WHEN}"), (n, "${count}"),
                        ("criteria", criteria)], "the Done when head")
        XCTAssertEqual(StartProject.doneWhenHead(1), "\(StartProject.doneWhen) · 1 criterion")
        assertSentence(web, StartProject.planHead(Self.count),
                       [(StartProject.plan, "${START_PLAN}"), (n, "${count}"),
                        ("tasks", "${count === 1 ? 'task' : 'tasks'}")], "the Plan head")
        XCTAssertEqual(StartProject.planHead(1), "\(StartProject.plan) · 1 task")
        XCTAssertTrue(web.contains("`${head} in ${levels} levels`"),
                      "the web no longer says how many levels the way this end does")
        XCTAssertEqual(StartProject.planHead(Self.count, levels: 4),
                       "\(StartProject.planHead(Self.count)) in 4 levels")
        // Who asked, under the project's name; and the line of a card nobody asked for.
        assertDeclares(web, "START_COORDINATOR_ASKED", StartProject.coordinatorAsked)
        assertSentence(web, StartProject.askedLine("AGO"),
                       [(StartProject.coordinatorAsked, "${START_COORDINATOR_ASKED}"), ("AGO", "${ago}")],
                       "who asked, and when")
        XCTAssertEqual(StartProject.askedLine(nil), StartProject.coordinatorAsked)
        assertSentence(web, StartProject.nobodyAskedLine(hasCoordinator: false),
                       [(StartProject.nobodyAsked, "${START_NOBODY_ASKED}"),
                        (StartProject.noCoordinatorYet, "${START_NO_COORDINATOR_YET}")],
                       "a card nobody asked for, on a project with no coordinator")
        XCTAssertEqual(StartProject.nobodyAskedLine(hasCoordinator: true), StartProject.nobodyAsked)
    }

    func testTheParagraphsAndTheLineUnderStartMatchTheWebWhole() throws {
        let web = try flat(Self.words)
        assertSentence(web, StartProject.explanation(Self.count), [(n, "${count}")],
                       "what starting binds the project to")
        // Whose settings these are: the owner's default Automatic, and the coordinator's suggestion.
        XCTAssertTrue(web.contains("`${START_AUTOMATIC_BY_DEFAULT} (${START_COORDINATOR_SUGGESTED_OFF}).`"))
        XCTAssertTrue(web.contains("`${START_AUTOMATIC_BY_DEFAULT}.`"))
        XCTAssertEqual(StartProject.howItRunsNote(asked: true, suggestedOff: true),
                       "\(StartProject.automaticByDefault) (\(StartProject.coordinatorSuggestedOff)). "
                           + "\(StartProject.restSuggested) \(StartProject.changeLater)")
        XCTAssertEqual(StartProject.howItRunsNote(asked: false, suggestedOff: false),
                       "\(StartProject.automaticByDefault). \(StartProject.changeLater)")
        // What pressing Start does, part by part.
        XCTAssertTrue(web.contains("['opens a coordinator']"))
        XCTAssertTrue(web.contains("`starts ${joinAnd(input.startsNow)} now`"))
        XCTAssertTrue(web.contains("'confirms this criterion'"))
        XCTAssertTrue(web.contains("`confirms these ${input.criteria} criteria`"))
        XCTAssertTrue(web.contains("`seal ${input.seal}`"))
        XCTAssertEqual(StartProject.barCaption(opensCoordinator: false, startsNow: ["X", "Y"],
                                               criteria: Self.count, seal: Self.seal),
                       "Starts X and Y now · confirms these \(n) criteria · seal \(Self.seal)")
        XCTAssertEqual(StartProject.barCaption(opensCoordinator: true, startsNow: [], criteria: 1,
                                               seal: Self.seal),
                       "Opens a coordinator · confirms this criterion")
    }

    /// What still comes to the owner, in the words both ends build each line from.
    func testWhatComesToTheOwnerIsSaidInTheWebsWords() throws {
        let web = try flat(Self.words)
        assertSentence(web, StartProject.reviews(Self.count),
                       [(n, "${count}"), ("reviews", "${count === 1 ? 'review' : 'reviews'}")], "the reviews")
        assertSentence(web, StartProject.tasksYouConfirm(Self.count), [(n, "${count}")],
                       "the tasks the owner confirms, counted")
        assertSentence(web, StartProject.problemsUnresolved(within: "WITHIN"), [("WITHIN", "${within}")],
                       "what reaches the owner after the escalation window")
        XCTAssertTrue(web.contains("`${task.label} · ${task.title}`"),
                      "the web no longer names a task the owner confirms the way this end does")
        XCTAssertTrue(web.contains("`${Math.max(1, Math.round(seconds / 60))} min`"))
        XCTAssertTrue(web.contains("`${Math.round(seconds / 3600)} h`"))
        XCTAssertEqual(StartProject.within(seconds: 7_200), "2 h")
    }

    /// The plan's own words: a level of several tasks, the names a list is joined with, and the rule
    /// that reads a task's label off its title.
    func testThePlansWordsMatchTheWebWhole() throws {
        let web = try flat(Self.words)
        assertSentence(web, StartProject.inParallel(Self.count), [(n, "${count}")], "a level of several tasks")
        XCTAssertTrue(web.contains("`${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`"),
                      "the web no longer lists names as `A, B and C`")
        XCTAssertEqual(StartProject.joinAnd(["A", "B", "C"]), "A, B and C")
        XCTAssertTrue(web.contains("/^([A-Z]\\d{1,2}[a-z]?)(?:[.):：]|\\s)/u"),
                      "the web no longer reads P1a as a label the way this end does")
        XCTAssertEqual(StartProject.planTaskLabel("P1a · wiki-worker"), "P1a")
    }

    // MARK: How it runs

    func testHowItRunsSaysWhatTheWebSays() throws {
        let web = try flat(Self.words)
        assertDeclares(web, "RUN_TASKS_LAND_ON", RunSettings.tasksLandOn)
        assertDeclares(web, "RUN_LINE_PROJECT_BRANCH", RunSettings.lineProjectBranch)
        assertDeclares(web, "RUN_LINE_PROJECT_BRANCH_HINT", RunSettings.lineProjectBranchHint)
        assertDeclares(web, "RUN_LINE_MAIN", RunSettings.lineMain)
        assertDeclares(web, "RUN_LINE_MAIN_HINT", RunSettings.lineMainHint)
        assertDeclares(web, "RUN_AUTOMATIC", RunSettings.automatic)
        assertDeclares(web, "RUN_AUTOMATIC_HINT_PROJECT_BRANCH", RunSettings.automaticHintProjectBranch)
        assertDeclares(web, "RUN_AUTOMATIC_HINT_MAIN", RunSettings.automaticHintMain)
        assertDeclares(web, "RUN_SWITCH_ON", RunSettings.switchOn)
        assertDeclares(web, "RUN_SWITCH_OFF", RunSettings.switchOff)
        assertDeclares(web, "RUN_AT_MOST", RunSettings.atMost)
        assertDeclares(web, "RUN_MERGE_CHECK", RunSettings.mergeCheck)
        assertDeclares(web, "RUN_MERGE_CHECK_HINT", RunSettings.mergeCheckHint)
        assertDeclares(web, "RUN_MERGE_CHECK_PLACEHOLDER", RunSettings.mergeCheckPlaceholder)
        assertDeclares(web, "RUN_NO_MERGE_CHECK_WARNING", RunSettings.noMergeCheckWarning)
        // The start card's own Automatic sentences, and its merge check's values.
        assertDeclares(web, "RUN_AUTOMATIC_ON_CHECKED", RunSettings.automaticOnChecked)
        assertDeclares(web, "RUN_AUTOMATIC_ON_UNCHECKED", RunSettings.automaticOnUnchecked)
        assertDeclares(web, "RUN_AUTOMATIC_ON_MAIN", RunSettings.automaticOnMain)
        assertDeclares(web, "RUN_AUTOMATIC_OFF", RunSettings.automaticOff)
        assertDeclares(web, "RUN_AUTOMATIC_OFF_MAIN", RunSettings.automaticOffMain)
        assertDeclares(web, "RUN_MERGE_CHECK_SET", RunSettings.mergeCheckSet)
        assertDeclares(web, "RUN_MERGE_CHECK_NONE", RunSettings.mergeCheckNone)
        assertDeclares(web, "RUN_MERGE_CHECK_NONE_SAYS", RunSettings.mergeCheckNoneSays)
        assertSentence(web, RunSettings.tasksAtATime(Self.count),
                       [("tasks", "${count === 1 ? 'task' : 'tasks'}")], "the words after the number")
        XCTAssertEqual(RunSettings.tasksAtATime(1), "task at a time")
        // The Automatic sentence follows the line, and the merge half is the half that changes.
        XCTAssertTrue(web.contains("return line === 'MAIN' ? RUN_AUTOMATIC_HINT_MAIN : RUN_AUTOMATIC_HINT_PROJECT_BRANCH;"),
                      "the web no longer picks the Automatic sentence by the line")
        // The most tasks the number accepts is the door's bound at both ends.
        XCTAssertTrue(try flat(Self.card).contains(
            "export const START_MAX_CONCURRENT_TASKS = \(StartProject.maxConcurrentTasks);"),
                      "the web card no longer bounds the count where this end does")
    }

    /// The one line a start's settings are said in afterwards, on its receipt and on the Project
    /// started card — every part of it in the web's words.
    func testTheSettingsLineIsBuiltFromTheWebsWords() throws {
        let web = try flat(Self.words)
        assertDeclares(web, "RUN_SUMMARY_MERGE_CHECK_SET", RunSettings.summaryMergeCheckSet)
        assertDeclares(web, "RUN_SUMMARY_NO_MERGE_CHECK", RunSettings.summaryNoMergeCheck)
        assertDeclares(web, "RUN_SETTING_DIFFERS", RunSettings.settingDiffers)
        XCTAssertTrue(web.contains("text: `${RUN_AUTOMATIC} ${settings.automatic ? 'on' : 'off'}`"),
                      "the web no longer says Automatic on/off the way this end does")
        XCTAssertTrue(web.contains("text: `${tasks} ${runTasksAtATime(tasks)}`"),
                      "the web no longer says the count the way this end does")
        XCTAssertTrue(web.contains("`project/${project[1]!.slice(0, 5)}…`"),
                      "the web no longer shortens a project branch the way this end does")
        let settings = ProjectStartSettings(line: .projectBranch,
                                            projectBranchName: "refs/heads/project/34WvwUS8YMXf",
                                            automatic: false, maxConcurrentTasks: Self.count,
                                            mergeCheckCommand: nil)
        XCTAssertEqual(RunSettings.parts(settings).map(\.text),
                       ["project/34Wvw…", "\(RunSettings.automatic) off",
                        "\(n) \(RunSettings.tasksAtATime(Self.count))", RunSettings.summaryNoMergeCheck])
        XCTAssertEqual(RunSettings.parts(settings).map(\.key), ProjectStartSettingKey.allCases,
                       "the parts are in card order, the order `PROJECT_START_SETTING_KEYS` lists")
    }

    // MARK: the card's actions, and where else its words are said

    func testTheSecondActionAndTheSessionRowSayTheSharedWords() throws {
        // The second action, at both ends, is the word three other controls already use.
        XCTAssertTrue(try flat(Self.card).contains("{OWNER_SEND_BACK_ACTION}"),
                      "the web start card no longer takes its second action's word from the "
                          + "shared constant (`Approvals.chatAction` at this end)")
        XCTAssertEqual(OwnerConfirmations.sendBackAction, Approvals.chatAction)
        // The session row over a project waiting to be started says what the card asks.
        XCTAssertTrue(try flat(Self.workspace).contains(
            "if (s.waitingKind === 'START_REQUEST') return READY_TO_START;"),
                      "the web session row no longer says Ready to start for a start request")
        XCTAssertEqual(SessionWaitingKind(rawValue: "START_REQUEST"), .startRequest)
    }

    /// What a press the door did not take says: written into the console, over its own reason.
    func testTheRefusalTheConsoleSaysIsTheWebsSentence() throws {
        let url = try repoRoot().appendingPathComponent(Self.console)
        let console = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(console.contains("\"\\(StartProject.notRecorded) — "),
                      "the native console no longer says StartProject.notRecorded over a refused "
                          + "start")
    }
}
