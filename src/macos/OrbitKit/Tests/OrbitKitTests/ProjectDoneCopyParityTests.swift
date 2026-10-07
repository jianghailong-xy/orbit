import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about closing a project — "Is this project done?", its
/// receipt, "Why is this project not done?" and the rows that point at them — and this is the
/// tripwire that keeps them saying them.
///
/// The browser declares every word once, in `lib/projectDone.ts`, as a literal constant ("the named
/// constants above are the parity API", that file's own note), and builds its sentences from them in
/// `ProjectSettlementCard.tsx`; this client holds the same words by hand (`ProjectDone`). Nothing in
/// a build catches a word re-worded at one end only, so this reads the other end's source.
///
/// Shaped after `StartProjectCardCopyParityTests`, including the part that matters most: a missing
/// counterpart is a FAILURE and never an `XCTSkip`. A sentence with a count in it is rendered here
/// with sentinels and compared whole against the web template's own interpolations.
///
/// The request's age beside "asked by the coordinator" and "the coordinator asked" is compared as
/// the words around it ("waiting" and `formatSpan`, which `RelativeTime.span` ports and
/// `BackgroundWakeCopyParityTests` holds); the clock reading itself is each end's own. What is NOT
/// compared is the card's look (`FROM ORBIT` is compared; colours are not).
final class ProjectDoneCopyParityTests: XCTestCase {

    private static let words = "src/web/src/lib/projectDone.ts"
    private static let card = "src/web/src/components/ProjectSettlementCard.tsx"
    private static let workspace = "src/web/src/components/WorkspaceView.tsx"
    private static let openItems = "src/web/src/components/ProjectProgressStatus.tsx"
    private static let page = "src/web/src/pages/ProjectsPage.tsx"
    private static let shared = "src/shared/src/project-done.ts"
    private static let progress = "src/shared/src/project-progress.ts"

    /// Sentinels that occur in no sentence: counts with digits the copy never uses together.
    private static let criteria = 23
    private static let met = 19
    private static let onMain = 17
    private static let gapCount = 7

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        var description: String {
            switch self {
            case .noRepo:
                return "\(ProjectDoneCopyParityTests.words) was not found above this test file. "
                    + "The native done cards are one half of a pair; if the web half moved, move "
                    + "this check with it rather than deleting it."
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

    /// One source with its string literals put back together (`'…' + '…'` wraps are formatting, the
    /// words are the contract) and a value sitting under its `=` pulled up.
    private func flat(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
    }

    /// Every web constant this client holds, by the web's own name. One table, so the test below can
    /// also ask the other question: does the web declare a word this client has not got?
    private static let declarations: [(String, String)] = [
        ("DONE_CARD_HEADING", ProjectDone.heading),
        ("DONE_CARD_COORDINATOR_CALL", ProjectDone.coordinatorCall),
        ("DONE_CARD_DONE_WHEN", ProjectDone.doneWhen),
        ("DONE_CARD_WHAT_ORBIT_CANT_PROVE", ProjectDone.whatOrbitCantProve),
        ("DONE_CARD_COORDINATOR_CHECKED", ProjectDone.coordinatorChecked),
        ("DONE_CARD_ORBIT_CHECKED", ProjectDone.orbitChecked),
        ("DONE_CARD_RECORD", ProjectDone.recordAsDone),
        ("DONE_CARD_RECORD_ANYWAY", ProjectDone.recordAsDoneAnyway),
        ("DONE_CARD_NOT_YET", ProjectDone.notYet),
        ("DONE_CARD_MISSING", ProjectDone.missingBeforeDone),
        ("DONE_CARD_RECEIPT", ProjectDone.receipt),
        ("DONE_CARD_GAPS_ACCEPTED", ProjectDone.gapsAccepted),
        ("DONE_CARD_SEE_ACCEPTED", ProjectDone.seeWhatAccepted),
        ("DONE_CARD_REOPEN", ProjectDone.reopenProject),
        ("DONE_CARD_EXPLANATION", ProjectDone.recordingExplanation),
        ("DONE_CARD_NOT_YET_HINT", ProjectDone.notYetHint),
        ("DONE_CARD_ASKED_BY_COORDINATOR", ProjectDone.askedByCoordinator),
        ("DONE_CARD_SHOW_ALL", ProjectDone.showAll),
        ("DONE_CARD_SHOW_LESS", ProjectDone.showLess),
        ("DONE_CARD_SEND_TO_COORDINATOR", ProjectDone.sendToCoordinator),
        ("DONE_CARD_BACK", ProjectDone.back),
        ("DONE_CARD_THIS_PROJECT_IS_DONE", ProjectDone.thisProjectIsDone),
        ("WHY_NOT_DONE_HEADING", ProjectDone.whyHeading),
        ("WHY_NOT_DONE_WAITING_ON_WORK", ProjectDone.waitingOnWork),
        ("WHY_NOT_DONE_NEEDS_YOUR_CALL", ProjectDone.needsYourCall),
        ("WHY_NOT_DONE_ON_MAIN", ProjectDone.onMain),
        ("WHY_NOT_DONE_REVIEW", ProjectDone.reviewDoneRequest),
        ("WHY_NOT_DONE_COORDINATOR_IS_ON_IT", ProjectDone.coordinatorIsOnIt),
        ("WHY_NOT_DONE_ON_PROJECT_BRANCH", ProjectDone.onProjectBranch),
        ("WHY_NOT_DONE_MERGED_OUTSIDE_ORBIT", ProjectDone.mergedOutsideOrbit),
        ("WHY_NOT_DONE_NOTHING_TO_LAND", ProjectDone.nothingToLand),
        ("WHY_NOT_DONE_THIS_PROJECT_IS_DONE", ProjectDone.thisProjectIsDone),
        ("WHY_NOT_DONE_ASK_COORDINATOR", ProjectDone.askCoordinator),
        ("WHY_NOT_DONE_WAITING_DETAIL", ProjectDone.waitingDetail),
        ("WHY_NOT_DONE_NEEDS_CALL_DETAIL", ProjectDone.needsCallDetail),
        ("WHY_NOT_DONE_NOT_MET_YET", ProjectDone.notMetYet),
        ("WHY_NOT_DONE_NOT_MET_DETAIL", ProjectDone.notMetDetail),
        ("WHY_NOT_DONE_NOT_MET", ProjectDone.notMet),
        ("PROJECT_DONE_RECORDED_BY_YOU", ProjectDone.recordedByYou),
        ("PROJECT_DONE_RECORDED_BY_ORBIT", ProjectDone.recordedByOrbit),
        ("READY_TO_CLOSE", ProjectDone.readyToClose),
        ("PROJECT_DONE_COORDINATOR_ASKED", ProjectDone.coordinatorAsked),
        ("PROJECT_DONE_GAPS_IT_COULDNT_PROVE", ProjectDone.gapsItCouldntProve),
        ("PROJECT_DONE_NOT_ASKED_YET", ProjectDone.notAskedYet),
        ("PROJECT_DONE_RECORD_AS_DONE_ROW", ProjectDone.recordAsDoneRow),
    ]

    // MARK: the words

    func testEveryWordTheWebDeclaresIsThisClientsWordForWord() throws {
        let web = try flat(Self.words)
        for (name, value) in Self.declarations {
            XCTAssertTrue(web.contains("export const \(name) = '\(value)';"),
                          "\(name) drifted: the web no longer declares it as \(value.debugDescription)")
        }
        // And the other way round: a word the web declared that this client has no counterpart for
        // is a sentence one end says and the other does not.
        let declared = try NSRegularExpression(pattern: "export const ([A-Z][A-Z_]*) = '")
            .matches(in: web, range: NSRange(web.startIndex..., in: web))
            .compactMap { Range($0.range(at: 1), in: web).map { String(web[$0]) } }
        XCTAssertFalse(declared.isEmpty, "no declarations were read from \(Self.words)")
        let held = Set(Self.declarations.map(\.0))
        for name in declared {
            XCTAssertTrue(held.contains(name),
                          "\(Self.words) declares \(name), which this client does not hold — add it to "
                              + "`ProjectDone` and to this table")
        }
    }

    func testTheWordsTheCopyObjectSpellsInlineAreThisClients() throws {
        let web = try flat(Self.words)
        XCTAssertTrue(web.contains("noRequestMeta: '\(ProjectDone.noRequestMeta)',"),
                      "the meta line of a card nobody asked for drifted")
        XCTAssertTrue(web.contains("landedOnMain: '\(ProjectDone.landedOnMain)',"),
                      "the tally's landed-on-main words drifted")
        XCTAssertTrue(web.contains("openItems: '\(ProjectPage.openItemsHeading)',"),
                      "the Open items heading the card's row sits under drifted")
        XCTAssertTrue(web.contains("notMetYet: WHY_NOT_DONE_NOT_MET_YET,"))
        XCTAssertTrue(web.contains("notMetDetail: WHY_NOT_DONE_NOT_MET_DETAIL,"))
        XCTAssertTrue(web.contains("notMet: WHY_NOT_DONE_NOT_MET,"))
        let card = try flat(Self.card)
        XCTAssertTrue(card.contains("className=\"criteria-provenance\">\(ProjectDone.provenance)</span>"),
                      "the done cards' provenance badge drifted from \(ProjectDone.provenance)")
        XCTAssertTrue(card.contains(">\(ProjectDone.noGaps)</p>"),
                      "the empty gaps sentence drifted from \(ProjectDone.noGaps.debugDescription)")
        XCTAssertTrue(card.contains("message=\"\(ProjectDone.notRecorded)\""),
                      "the refused press's title drifted from \(ProjectDone.notRecorded.debugDescription)")
    }

    // MARK: the counts, in words

    private func counts() -> ProjectDoneCounts {
        ProjectDoneCounts(criteria: Self.criteria, met: Self.met, landed: Self.onMain + 2,
                          onMain: Self.onMain, byReason: [.inFlight: 1, .noReceipt: 2, .codeless: 3])
    }

    /// The same 23 criteria as answers, which is what the Why-not-done tally counts: 19 met — 13 on
    /// main, 1 in flight, 2 merged outside Orbit, 3 with no code to land — and 4 not met, whose
    /// landing lanes it must not count.
    private func answers() -> ProjectDerivedDone {
        func rows(_ n: Int, _ satisfied: Bool, _ reason: CriterionLandingReason?) -> [ProjectDoneCriterion] {
            (0..<n).map { ProjectDoneCriterion(definitionId: "\(satisfied)-\(reason?.rawValue ?? "main")-\($0)",
                                               satisfied: satisfied, landingReason: reason) }
        }
        return ProjectDerivedDone(criteria: rows(13, true, nil) + rows(1, true, .inFlight) + rows(2, true, .noReceipt)
                                      + rows(3, true, .codeless) + rows(2, false, .noReceipt)
                                      + rows(1, false, .codeless) + rows(1, false, nil))
    }

    func testTheReasonsAreSaidInTheWebsOrderAndWords() throws {
        let web = try flat(Self.words)
        let order = ProjectDone.reasonOrder.map { "  '\($0.rawValue)',\n" }.joined()
        XCTAssertTrue(web.contains("const REASON_ORDER: readonly CriterionLandingReason[] = [\n\(order)];"),
                      "the order the tallies say the reasons in drifted")
        for reason in ProjectDone.reasonOrder where reason != .nothingToLand {
            XCTAssertTrue(web.contains("  \(reason.rawValue): '\(ProjectDone.reasonLabel(reason))',"),
                          "the tally's word for \(reason.rawValue) drifted")
        }
        XCTAssertTrue(web.contains("  NOTHING_TO_LAND: PROJECT_DONE_COPY.nothingToLand,"))
        // One row's reason, as `landingReasonLabel` says it.
        let rows: [(CriterionLandingReason?, String)] = [
            (.inFlight, "case 'IN_FLIGHT': return 'In flight';"),
            (.onProjectBranch, "case 'ON_PROJECT_BRANCH': return PROJECT_DONE_COPY.onProjectBranch;"),
            (.noReceipt, "case 'NO_RECEIPT': return PROJECT_DONE_COPY.mergedOutsideOrbit;"),
            (.nothingToLand, "case 'NOTHING_TO_LAND': return PROJECT_DONE_COPY.nothingToLand;"),
            (.codeless, "case 'CODELESS': return 'No code to land';"),
            (nil, "default: return 'Landed on main';"),
        ]
        for (reason, line) in rows {
            XCTAssertTrue(web.contains(line), "landingReasonLabel no longer says \(line)")
        }
        XCTAssertEqual(ProjectDone.landingReasonLabel(.inFlight), "In flight")
        XCTAssertEqual(ProjectDone.landingReasonLabel(.codeless), "No code to land")
        XCTAssertEqual(ProjectDone.landingReasonLabel(nil), "Landed on main")
        XCTAssertTrue(web.contains("return reason === 'IN_FLIGHT' || reason === 'ON_PROJECT_BRANCH';"),
                      "what counts as waiting on work drifted")
        XCTAssertTrue(web.contains("return reason === 'NO_RECEIPT';"),
                      "what counts as needing the owner's call drifted")
    }

    func testTheFourTalliesAreTheWebsSentences() throws {
        let web = try flat(Self.words)
        // Each is rendered with sentinels, then each part is found as the web template spells it.
        XCTAssertEqual(ProjectDone.tally(counts()),
                       "23 criteria · 19 met · 17 landed on main · 1 in flight · 2 merged outside Orbit"
                           + " · 3 no code to land")
        XCTAssertEqual(ProjectDone.cardTally(counts()), "19 met · 17 landed on main · 3 nothing to land")
        XCTAssertEqual(ProjectDone.receiptTally(counts(), acceptedGaps: Self.gapCount),
                       "23 criteria met · 17 landed on main · 3 nothing to land · 7 gaps accepted")
        XCTAssertEqual(ProjectDone.receiptTally(nil, acceptedGaps: Self.gapCount), "7 gaps accepted")
        XCTAssertEqual(ProjectDone.whyNotDoneTally(answers()),
                       "23 criteria · 13 on main · 1 in flight · 2 merged outside Orbit"
                           + " · 3 no code to land · 4 not met")
        for part in [
            "`${counts.criteria} criteria`,\n    `${counts.met} met`,\n    `${counts.onMain} ${PROJECT_DONE_COPY.landedOnMain}`,\n    ...reasonParts(counts),",
            "`${counts.met} met`,\n    `${counts.onMain} ${PROJECT_DONE_COPY.landedOnMain}`,\n    `${nothingToLandCount(counts)} ${PROJECT_DONE_COPY.nothingToLand}`,",
            "if (!counts) return `${acceptedGaps} ${PROJECT_DONE_COPY.gapsAccepted}`;",
            "`${counts.criteria} criteria met`,\n    `${counts.onMain} ${PROJECT_DONE_COPY.landedOnMain}`,\n    `${nothingToLandCount(counts)} ${PROJECT_DONE_COPY.nothingToLand}`,\n    `${acceptedGaps} ${PROJECT_DONE_COPY.gapsAccepted}`,",
            "const met = derivedDone.criteria.filter((criterion) => criterion.satisfied);\n  const notMet = derivedDone.criteria.length - met.length;",
            "met.filter((criterion) => criterion.landingReason === reason).length,",
            "`${derivedDone.criteria.length} criteria`,\n    `${met.filter((criterion) => criterion.landingReason == null).length} ${PROJECT_DONE_COPY.onMain}`,\n    ...reasonParts({ byReason }),\n    ...(notMet > 0 ? [`${notMet} ${PROJECT_DONE_COPY.notMet}`] : []),",
            "return count > 0 ? [`${count} ${REASON_LABELS[reason]}`] : [];",
            "return (counts.byReason?.NOTHING_TO_LAND ?? 0) + (counts.byReason?.CODELESS ?? 0);",
        ] {
            XCTAssertTrue(web.contains(part), "a tally drifted: the web no longer builds \(part.debugDescription)")
        }
    }

    func testWhoRecordedItIsTheWebsSentence() throws {
        let web = try flat(Self.words)
        XCTAssertEqual(ProjectDone.provenance(doneBy: .owner, acceptedGaps: Self.gapCount),
                       "recorded by you · 7 gaps accepted")
        XCTAssertEqual(ProjectDone.provenance(doneBy: .derived, acceptedGaps: Self.gapCount),
                       "recorded by Orbit")
        XCTAssertEqual(ProjectDone.provenance(doneBy: nil, acceptedGaps: 0), "recorded by Orbit")
        XCTAssertTrue(web.contains("if (project.doneBy === 'OWNER') {"))
        XCTAssertTrue(web.contains("return `${PROJECT_DONE_COPY.recordedByYou} · ${n} ${PROJECT_DONE_COPY.gapsAccepted}`;"),
                      "the owner's provenance drifted")
        XCTAssertTrue(web.contains("return PROJECT_DONE_COPY.recordedByOrbit;"),
                      "Orbit's provenance drifted")
        // The dates beside it, in the browser's two shapes.
        XCTAssertTrue(web.contains("toLocaleDateString('en-US', { month: 'short', day: 'numeric' })"))
        XCTAssertTrue(web.contains("month: 'short',\n    day: 'numeric',\n    hour: '2-digit',\n    minute: '2-digit',\n    hour12: false,"))
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(ProjectDone.date("2026-10-01T01:40:12.000Z", timeZone: utc), "Oct 1")
        XCTAssertEqual(ProjectDone.dateTime("2026-10-01T01:40:12.000Z", timeZone: utc), "Oct 1, 01:40")
    }

    // MARK: the owner card

    func testTheOwnerCardsSentencesAreTheWebs() throws {
        let card = try flat(Self.card)
        // Orbit checked, with sentinels for the two counts and a date for the confirmation.
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(ProjectDone.orbitCheckedLine(counts: counts(), confirmedAt: nil, openItems: 0,
                                                    running: 0, timeZone: utc),
                       "Orbit checked: 19 of 23 criteria are met by their work · nothing running · no open items")
        let all = ProjectDoneCounts(criteria: 4, met: 4, landed: 4, onMain: 4)
        XCTAssertEqual(ProjectDone.orbitCheckedLine(counts: all, confirmedAt: "2026-09-29T08:00:00Z",
                                                    openItems: 2, running: 1, timeZone: utc),
                       "Orbit checked: every criterion is met by its work · 1 item running · 2 open items"
                           + " · criteria confirmed by you on Sep 29")
        for part in [
            "? 'every criterion is met by its work'",
            ": `${counts?.met ?? 0} of ${counts?.criteria ?? 0} criteria are met by their work`;",
            "runningCount === 0 ? 'nothing running' : `${runningCount} item${runningCount === 1 ? '' : 's'} running`;",
            "openItemsCount === 0 ? 'no open items' : `${openItemsCount} open item${openItemsCount === 1 ? '' : 's'}`;",
            "return `${DONE_CARD_ORBIT_CHECKED}: ${lead} · ${running} · ${open}`",
            "(confirmedAt ? ` · criteria confirmed by you on ${confirmedAt}` : '');",
        ] {
            XCTAssertTrue(card.contains(part), "the Orbit checked line drifted: no \(part.debugDescription)")
        }
        // A card nobody asked for carries Orbit's own gaps, in these two sentences.
        XCTAssertTrue(card.contains("? `Orbit cannot prove this criterion is on main: ${reason}.`"))
        XCTAssertTrue(card.contains(": 'Orbit cannot prove this criterion is met by its work yet.',"))
        // The section heads, the toggle, the gap's checked line and the record press.
        XCTAssertEqual(ProjectDone.doneWhenHead(Self.criteria), "Done when · 23 criteria")
        XCTAssertTrue(card.contains("{PROJECT_DONE_COPY.doneWhen} · {criteriaCount} criteria"))
        XCTAssertEqual(ProjectDone.gapsHead(Self.gapCount), "What Orbit can’t prove · 7")
        XCTAssertTrue(card.contains("{PROJECT_DONE_COPY.whatOrbitCantProve} · {gaps.length}"))
        XCTAssertEqual(ProjectDone.showAll(Self.criteria), "Show all 23")
        XCTAssertTrue(card.contains("{DONE_CARD_SHOW_ALL} {gaps.length}"))
        XCTAssertTrue(card.contains("expanded ? DONE_CARD_SHOW_LESS : `${DONE_CARD_SHOW_ALL} ${criteriaCount}`"))
        XCTAssertTrue(card.contains("<b>✓ {PROJECT_DONE_COPY.coordinatorChecked}:</b>"))
        XCTAssertTrue(card.contains("` · evidence ${gap.evidenceRefs.join(', ')}`"))
        XCTAssertEqual(ProjectDone.checkedLine(AcceptedGap(criterionKey: "c", coordinatorChecked: "main has it",
                                                           evidenceRefs: ["a", "b"])),
                       "main has it · evidence a, b")
        XCTAssertTrue(card.contains("{criterion.satisfied ? 'met' : 'not met'} · {landingReasonLabel(criterion.landingReason)}"))
        XCTAssertTrue(card.contains(
            "counts && counts.met < counts.criteria ? PROJECT_DONE_COPY.recordAsDoneAnyway : DONE_CARD_RECORD"))
        XCTAssertEqual(ProjectDone.recordLabel(counts()), ProjectDone.recordAsDoneAnyway)
        XCTAssertEqual(ProjectDone.recordLabel(all), ProjectDone.recordAsDone)
        // The meta line: who asked and how long the request has waited — or nobody.
        XCTAssertTrue(card.contains("{project.title} · {doneRequest\n"), "the asked meta line drifted")
        XCTAssertTrue(card.contains(
            "? [PROJECT_DONE_COPY.askedByCoordinator, doneRequestWaiting(requestWaitingSince, now)].filter(Boolean).join(' · ')"),
                      "the asked meta line drifted")
        let words = try flat(Self.words)
        XCTAssertTrue(words.contains("return Number.isNaN(at) ? null : `waiting ${formatSpan(now - at)}`;"),
                      "the request's age is no longer `waiting` and formatSpan")
        let now = RelativeTime.parse("2026-10-05T21:00:00.000Z")!
        XCTAssertEqual(ProjectDone.meta(projectTitle: "Aurora", asked: true,
                                        waiting: ProjectDone.requestWaiting("2026-10-05T20:56:00.000Z", now: now)),
                       "Aurora · asked by the coordinator · waiting 4m")
        XCTAssertTrue(card.contains(": PROJECT_DONE_COPY.noRequestMeta}"), "the unasked meta line drifted")
        XCTAssertEqual(ProjectDone.meta(projectTitle: "Aurora", asked: true, waiting: "waiting 4m"),
                       "Aurora · asked by the coordinator · waiting 4m")
        XCTAssertEqual(ProjectDone.meta(projectTitle: "Aurora", asked: true, waiting: nil),
                       "Aurora · asked by the coordinator")
        XCTAssertEqual(ProjectDone.meta(projectTitle: "Aurora", asked: false, waiting: "waiting 4m"),
                       "Aurora · record as done anyway")
        // Not yet… is offered only on a card the coordinator asked for, and Send stays dark empty.
        XCTAssertTrue(card.contains("{doneRequest ? (\n            <button"), "Not yet… is not tied to a request")
        XCTAssertTrue(card.contains("disabled={notYetBusy || !note.trim()}"))
    }

    func testTheReceiptsSentencesAreTheWebs() throws {
        let card = try flat(Self.card)
        XCTAssertTrue(card.contains("{project.title} · {doneProvenance({ doneBy: receipt?.doneBy ?? project.doneBy, acceptedGaps: accepted })}"))
        XCTAssertTrue(card.contains("{receiptDate ? ` · ${receiptDate}` : ''}"))
        XCTAssertTrue(card.contains("? `${DONE_CARD_RECEIPT}${receiptDateTime ? ` · ${receiptDateTime}` : ''}`"),
                      "the owner's receipt line drifted")
        XCTAssertTrue(card.contains(": `${PROJECT_DONE_COPY.thisProjectIsDone} · ${PROJECT_DONE_COPY.recordedByOrbit}`}"),
                      "Orbit's receipt line drifted")
        XCTAssertTrue(card.contains("{projectDoneReceiptTally(counts, accepted.length)}"))
        XCTAssertTrue(card.contains("<summary>{DONE_CARD_SEE_ACCEPTED}</summary>"))
        XCTAssertTrue(card.contains("{DONE_CARD_REOPEN}"))

        let utc = TimeZone(identifier: "UTC")!
        let subject = ProjectDoneSubject(title: "Aurora", status: "DONE",
                                         derivedDone: ProjectDerivedDone(counts: counts()),
                                         doneBy: .owner, doneAt: "2026-10-01T01:40:00.000Z",
                                         acceptedGaps: [AcceptedGap(criterionKey: "a"),
                                                        AcceptedGap(criterionKey: "b")])
        XCTAssertEqual(ProjectDone.receiptMeta(subject, record: nil, timeZone: utc),
                       "Aurora · recorded by you · 2 gaps accepted · Oct 1")
        XCTAssertEqual(ProjectDone.receiptLine(subject, record: nil, timeZone: utc),
                       "You recorded this project done · Oct 1, 01:40")
        let derived = ProjectDoneSubject(title: "Aurora", status: "DONE",
                                         derivedDone: ProjectDerivedDone(done: true, counts: counts()),
                                         doneBy: .derived)
        XCTAssertEqual(ProjectDone.receiptLine(derived, record: nil, timeZone: utc),
                       "This project is done · recorded by Orbit")
    }

    // MARK: the Why-not-done card

    func testTheWhyNotDoneCardsGroupsAndButtonsAreTheWebs() throws {
        let card = try flat(Self.card)
        for part in [
            "!criterion.satisfied\n      || criterion.landingReason === 'IN_FLIGHT'\n      || criterion.landingReason === 'ON_PROJECT_BRANCH'",
            "criteria.filter((criterion) => criterion.satisfied && criterion.landingReason === 'NO_RECEIPT');",
            "waiting.length > 0 && waiting.every((criterion) => criterion.landingReason === 'IN_FLIGHT');",
            "const coordinatorOnIt = onlyInFlight || (openItems?.withCoordinator?.length ?? 0) > 0;",
            "if (project.status === 'DONE' || (!hasGaps && project.derivedDone?.done === true)) {",
            "{group(PROJECT_DONE_COPY.waitingOnWork, waiting, true)}",
            "{group(PROJECT_DONE_COPY.needsYourCall, needsCall, false)}",
            "<span className=\"project-why-who\">● {PROJECT_DONE_COPY.coordinatorIsOnIt}</span>",
            "{[PROJECT_DONE_COPY.openItemsDoneRequest.toLowerCase(), doneRequestWaiting(openItems.doneRequest.waitingSince, now)].filter(Boolean).join(' · ')}",
            "{criterion.satisfied ? landingReasonLabel(criterion.landingReason) : PROJECT_DONE_COPY.notMetYet}",
            "{!criterion.satisfied\n                    ? PROJECT_DONE_COPY.notMetDetail\n                    : waitingGroup ? PROJECT_DONE_COPY.waitingDetail : PROJECT_DONE_COPY.needsCallDetail}",
            "{item?.ordinal ?? '•'}",
            "{projectWhyNotDoneTally(project.derivedDone)}",
            "{PROJECT_DONE_COPY.reviewDoneRequest}",
            "waiting.length > 0 && !coordinatorOnIt && onAskCoordinator ?",
            "{PROJECT_DONE_COPY.askCoordinator}",
            "{waiting.length > 0 && coordinatorOnIt ? <span className=\"project-why-status\">{PROJECT_DONE_COPY.coordinatorIsOnIt}</span> : null}",
            "{project.doneBy === 'OWNER' ? PROJECT_DONE_COPY.recordedByYou : PROJECT_DONE_COPY.recordedByOrbit}",
        ] {
            XCTAssertTrue(card.contains(part), "the Why-not-done card drifted: no \(part.debugDescription)")
        }
        XCTAssertEqual(ProjectDone.askedAside(waiting: "waiting 4m"), "the coordinator asked · waiting 4m")
        let unmet = ProjectDoneCriterion(definitionId: "c", satisfied: false, landingReason: .noReceipt)
        let met = ProjectDoneCriterion(definitionId: "c", satisfied: true, landingReason: .noReceipt)
        XCTAssertEqual(ProjectDone.rowState(unmet), ProjectDone.notMetYet)
        XCTAssertEqual(ProjectDone.rowDetail(unmet, waitingOnWork: true), ProjectDone.notMetDetail)
        XCTAssertEqual(ProjectDone.rowState(met), ProjectDone.landingReasonLabel(.noReceipt))
        XCTAssertEqual(ProjectDone.rowDetail(met, waitingOnWork: false), ProjectDone.needsCallDetail)
        XCTAssertEqual(ProjectDone.askedAside(waiting: nil), "the coordinator asked")
        XCTAssertEqual(ProjectDone.settledBadge(.owner), ProjectDone.recordedByYou)
        XCTAssertEqual(ProjectDone.settledBadge(.derived), ProjectDone.recordedByOrbit)
    }

    /// Which card the conversation draws, state by state, is the browser's: the question for an
    /// OPEN, started project that looks finished — every criterion met by its work, no task
    /// IN_PROGRESS — and that the projection does not call done (the owner's ruling of 2026-10-06
    /// 09:29Z, which put back the condition the browser had before 0f47238c1); the owner's card
    /// while asked or just pressed; the owner's DONE as its receipt; and a DONE Orbit recorded itself
    /// as the Why-not-done card's terminal state — the coordinator's rulings of 2026-10-06, which the
    /// web carries since ccb406ad0.
    func testTheConversationDrawsTheWebsCardForEachState() throws {
        let card = try flat(Self.card)
        for part in [
            "if (!project || project.status !== 'OPEN' || projectStarted(project) !== true) return false;",
            "if (!projection || projection.done || projection.criteria.length === 0) return false;",
            "if (!projection.criteria.every((criterion) => criterion.satisfied)) return false;",
            "return (project.tasksByStatus?.IN_PROGRESS ?? 0) === 0;",
            "if (!projection || !('counts' in projection)) return false;\n  return settlementHeldOnProject(project);",
            // Asked of each read, never kept up past its condition (this client: `adoptDoneSlot`).
            "const shown = (delivered && !unified) || held;",
            "&& document?.status === 'DONE'\n    && document.doneBy !== 'OWNER'",
            "return <ProjectWhyNotDoneCard project={document as unknown as ProjectDoneDocument} />;",
            "const ownerRecordedDone = document?.status === 'DONE' && document.doneBy === 'OWNER';",
            "const ownerRecorded = receipt != null || (project.status === 'DONE' && project.doneBy === 'OWNER');",
            "const recorded = receipt != null || project.status === 'DONE';",
        ] {
            XCTAssertTrue(card.contains(part), "the conversation's card rule drifted: no \(part.debugDescription)")
        }
        // …and this client's slot answers the same, state by state.
        func subject(_ status: String, doneBy: ProjectDoneBy? = nil, done: Bool = false,
                     criteria: [ProjectDoneCriterion] = [ProjectDoneCriterion(definitionId: "c1", satisfied: true)],
                     tasksByStatus: [String: Int]? = nil)
            -> ProjectDoneSubject {
            ProjectDoneSubject(title: "t", status: status, derivedDone: ProjectDerivedDone(
                done: done, withheld: done ? [] : ["CRITERION_UNLANDED"], criteria: criteria,
                counts: ProjectDoneCounts(criteria: criteria.count, met: criteria.filter(\.satisfied).count,
                                          landed: 0, onMain: 0, byReason: [:])),
                doneBy: doneBy, tasksByStatus: tasksByStatus)
        }
        func slot(_ subject: ProjectDoneSubject, started: Bool? = true) -> ProjectDone.Slot {
            ProjectDone.slot(subject: subject, request: nil, waitingKind: nil, record: nil, started: started)
        }
        XCTAssertEqual(slot(subject("OPEN")), .notDone)
        XCTAssertEqual(slot(subject("OPEN", tasksByStatus: ["DONE": 3, "OPEN": 1])), .notDone,
                       "only IN_PROGRESS holds it back")
        XCTAssertEqual(slot(subject("OPEN", criteria: [ProjectDoneCriterion(definitionId: "c1", satisfied: true),
                                                       ProjectDoneCriterion(definitionId: "c2", satisfied: false)])),
                       .none, "a criterion still unmet: the project does not look finished")
        XCTAssertEqual(slot(subject("OPEN", tasksByStatus: ["IN_PROGRESS": 1, "DONE": 3])), .none,
                       "a task still IN_PROGRESS: the project has not stopped")
        XCTAssertEqual(slot(subject("OPEN"), started: false), .none, "not started: the start card asks")
        XCTAssertEqual(slot(subject("OPEN"), started: nil), .none, "a read that does not say it started")
        XCTAssertEqual(slot(subject("OPEN", criteria: [])), .none, "no criteria: nothing to explain")
        XCTAssertEqual(slot(subject("OPEN", done: true)), .none, "the projection already says done")
        XCTAssertEqual(slot(subject("DONE", doneBy: .owner)), .done(requestID: nil), "the owner's receipt")
        XCTAssertEqual(slot(subject("DONE", doneBy: .derived, done: true)), .notDone, "Orbit's DONE: the terminal state")
        let terminal = subject("DONE", doneBy: .derived, done: true)
        XCTAssertTrue(ProjectDone.WhyNotDone(subject: terminal, withCoordinator: 0, requested: false).settled(terminal))
        XCTAssertEqual(ProjectDone.settledBadge(terminal.doneBy), ProjectDone.recordedByOrbit)
        XCTAssertTrue(ProjectDone.recorded(subject("DONE"), record: nil))
        XCTAssertFalse(ProjectDone.recorded(subject("OPEN", doneBy: .owner, done: true), record: nil),
                       "an OPEN project is asked, whatever its projection or a leftover doneBy says")
    }

    /// Orbit checked counts what the browser's `orbitCheckedOpenItemCount` counts: every row of the
    /// open-items read, the START_REQUEST beside the groups included, except the DONE_REQUEST under
    /// review — and, unasked, nothing left out.
    func testOrbitCheckedCountsTheOpenItemsTheWebCounts() throws {
        let words = try flat(Self.words)
        for part in [
            "const reviewing = view?.doneRequest?.itemId ?? null;",
            "return [...(view?.needsYou ?? []), ...(view?.withCoordinator ?? []), ...(view?.startRequest ? [view.startRequest] : [])]",
            ".filter((row) => reviewing === null || row.itemId !== reviewing).length;",
        ] {
            XCTAssertTrue(words.contains(part), "orbitCheckedOpenItemCount drifted: no \(part.debugDescription)")
        }
        let card = try flat(Self.card)
        XCTAssertTrue(card.contains("openItemsCount={orbitCheckedOpenItemCount(openItemsRead.data)}"),
                      "the conversation's card no longer counts with orbitCheckedOpenItemCount")
        XCTAssertTrue(card.contains("const openItemsCount = orbitCheckedOpenItemCount(openItemsRead.data);"),
                      "the page's card no longer counts with orbitCheckedOpenItemCount")
        let row = { (id: String) in ProjectOpenItemRow(itemId: id, kind: .unknown, title: "", waitingSince: "") }
        XCTAssertEqual(ProjectDone.openItemsCount(ProjectOpenItemsView(doneRequest: row("r"))), 0)
        XCTAssertEqual(ProjectDone.openItemsCount(ProjectOpenItemsView(
            needsYou: [row("r"), row("a")], withCoordinator: [row("b")], startRequest: row("s"),
            doneRequest: row("r"))), 3)
        XCTAssertEqual(ProjectDone.openItemsCount(ProjectOpenItemsView(needsYou: [row("a")], startRequest: row("s"))), 2,
                       "unasked, nothing is left out")
    }

    /// "Ask the coordinator to handle it" sends the card's own facts as one turn — the same message,
    /// word for word, the browser's `projectSettlementContext` builds.
    func testTheMessageTheCoordinatorIsHandedIsTheWebs() throws {
        let card = try flat(Self.card)
        XCTAssertTrue(card.contains("export const SETTLEMENT_RULE = '\(ProjectDone.settlementRule)';"),
                      "SETTLEMENT_RULE drifted")
        for part in [
            "return `${SETTLEMENT_RULE} ${n === 1 ? 'One of those does not hold here.' : `${n} of those do not hold here.`}`;",
            "const settlement = criterion.satisfied ? 'Settled' : 'Not settled';",
            "? 'Landed'",
            "? 'On the integration line'\n        : 'No receipt';",
            "return `${settlement} · ${landing}`;",
            "return 'state what this project is for, as criteria the work can be measured against';",
            "return 'finish the work each criterion is measured by, and let it settle in its own session';",
            "return 'land the branch, or record the merge with merge_receipt where it happened outside Orbit';",
            // One literal once the wrap is put back together.
            "`- ${words ?? criterion.definitionId} — ${settlementCriterionFacts(criterion)} (blocked by ${criterion.withheld.join(', ')})`,",
            "`About “${project.title}” — Orbit has not recorded it done. ${settlementExplains(",
            ")}\\n\\nBlocked:\\n${blocked.join('\\n') || '(no criterion is individually blocked)'}\\n\\nWhat Orbit says would clear it:\\n`",
            "+ (clears.map((line) => `- ${line}`).join('\\n') || '(see the card)')",
            ".map((item) => `${item.ordinal}. ${item.text}`);",
        ] {
            XCTAssertTrue(card.contains(part), "the delegated facts drifted: no \(part.debugDescription)")
        }
        let subject = ProjectDoneSubject(
            title: "Aurora", status: "OPEN",
            criteria: [.init(id: "c1", ordinal: 1, text: "Ships"), .init(id: "c2", ordinal: 2, text: "Lands")],
            derivedDone: ProjectDerivedDone(
                withheld: ["CRITERION_UNLANDED"],
                criteria: [ProjectDoneCriterion(definitionId: "c1", satisfied: true),
                           ProjectDoneCriterion(definitionId: "c2", satisfied: true, landing: "UNKNOWN",
                                                landingReason: .noReceipt, withheld: ["CRITERION_UNLANDED"])],
                counts: ProjectDoneCounts(criteria: 2, met: 2, landed: 1, onMain: 1, byReason: [.noReceipt: 1])))
        XCTAssertEqual(ProjectDone.settlementContext(subject),
                       "About “Aurora” — Orbit has not recorded it done. \(ProjectDone.settlementRule) "
                           + "One of those does not hold here.\n\nBlocked:\n"
                           + "- 2. Lands — Settled · No receipt (blocked by CRITERION_UNLANDED)\n\n"
                           + "What Orbit says would clear it:\n"
                           + "- land the branch, or record the merge with merge_receipt where it happened "
                           + "outside Orbit")
    }

    // MARK: the rows that point at the card

    func testTheRowsSayTheWebsWords() throws {
        let workspace = try flat(Self.workspace)
        XCTAssertTrue(workspace.contains(
            "if (s.waitingKind === 'DONE_REQUEST') return PROJECT_DONE_COPY.readyToClose;"),
                      "the web session row no longer says Ready to close for a done request")
        XCTAssertTrue(workspace.contains(
            "if (s.waitingKind === 'RECORD_AS_DONE') return PROJECT_DONE_COPY.recordAsDoneRow;"),
                      "the web session row no longer says Record as done… for an unasked project")
        let session = { (kind: SessionWaitingKind) in
            Session(id: "s", title: "t", status: .awaitingInput, runStatus: nil, sessionState: nil,
                    runState: nil, lifecycleState: nil, agentId: nil, assignedRunnerId: nil,
                    pendingApprovals: 1, waitingKind: kind, ownerItems: nil, branch: nil, updatedAt: nil)
        }
        XCTAssertEqual(SessionHeader.waitingWord(for: session(.doneRequest)), ProjectDone.readyToClose)
        XCTAssertEqual(SessionHeader.waitingWord(for: session(.recordAsDone)), ProjectDone.recordAsDoneRow)
        XCTAssertEqual(SessionLine.make(for: session(.doneRequest), live: true),
                       SessionLine(text: "Ready to close", tone: .approval))

        let items = try flat(Self.openItems)
        XCTAssertTrue(items.contains(
            "`${PROJECT_DONE_COPY.openItemsDoneRequest} · ${row.doneRequest.gaps.length} ${PROJECT_DONE_COPY.gapsItCouldntProve}`"),
                      "the request's row on the project page drifted")
        for part in ["{PROJECT_DONE_COPY.readyToClose}</div>", "title={PROJECT_DONE_COPY.heading}>{PROJECT_DONE_COPY.heading}</div>",
                     "{PROJECT_DONE_COPY.recordAsDoneRow}", "{PROJECT_DONE_COPY.notAskedYet}</div>",
                     "{ACTION_LABEL.REVIEW}"] {
            XCTAssertTrue(items.contains(part), "the project page's done rows drifted: no \(part.debugDescription)")
        }
        let row = ProjectOpenItemRow(itemId: "i1", kind: .unknown, title: ProjectDone.heading,
                                     waitingSince: "2026-10-01T00:00:00Z",
                                     doneRequest: DoneRequest(criteriaDigest: "d", judgment: "j",
                                                              gaps: (0..<Self.gapCount).map {
                                                                  AcceptedGap(criterionKey: "c\($0)")
                                                              }))
        XCTAssertEqual(ProjectDone.requestRowDetail(row), "The coordinator asked · 7 gaps it couldn’t prove")
        XCTAssertEqual(ProjectPage.actionLabel(.review), "Review")

        let page = try flat(Self.page)
        XCTAssertTrue(page.contains("<span className=\"project-row-done-provenance\">{doneProvenance(p)}</span>"),
                      "the projects list no longer says who recorded a done project")
        XCTAssertTrue(page.contains("<span className=\"project-done-provenance\">{doneProvenance(p)}</span>"),
                      "the project page no longer says who recorded it done")
        XCTAssertTrue(page.contains("{PROJECT_DONE_COPY.readyToClose}</Tag>"),
                      "the project page no longer says Ready to close beside its status")
    }

    // MARK: the shapes on the wire

    /// The structures are `@orbit/shared`'s: the reasons, who recorded it, the request and the press
    /// — compared by the names on the wire, so a field renamed at one end is a red test here rather
    /// than a card that silently draws nothing.
    func testTheShapesOnTheWireAreTheSharedTypes() throws {
        let shared = try flat(Self.shared)
        let union = ProjectDone.reasonOrder.map(\.rawValue).sorted()
        let declared = try reasons(in: shared)
        XCTAssertEqual(declared.sorted(), union, "CriterionLandingReason drifted from @orbit/shared")
        XCTAssertTrue(shared.contains("export type ProjectDoneBy = '\(ProjectDoneBy.owner.rawValue)' | '\(ProjectDoneBy.derived.rawValue)';"))
        for field in ["criteriaDigest: string;", "judgment: string;", "gaps: AcceptedGap[];", "stateDigest?: string;"] {
            XCTAssertTrue(try block(shared, "export interface DoneRequest {").contains(field),
                          "DoneRequest no longer has \(field)")
        }
        for field in ["criterionKey: string;", "title?: string;", "whyNotProven?: string;",
                      "coordinatorChecked?: string;", "evidenceRefs?: string[];"] {
            XCTAssertTrue(try block(shared, "export interface AcceptedGap {").contains(field),
                          "AcceptedGap no longer has \(field)")
        }
        let body = try block(shared, "export interface ProjectDoneRequestBody {")
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            ProjectDoneRequestBody(requestId: nil, criteriaDigest: "d", acceptedGaps: []))) as? [String: Any]
        for key in try XCTUnwrap(encoded).keys {
            XCTAssertTrue(body.contains("\(key)"), "the press sends \(key), which ProjectDoneRequestBody does not name")
        }
        for field in ["projectId: string;", "doneBy: 'OWNER';", "doneAt: string;", "criteriaDigest: string;",
                      "acceptedGaps: AcceptedGap[];", "requestId: string | null;"] {
            XCTAssertTrue(try block(shared, "export interface ProjectDoneRecord {").contains(field),
                          "ProjectDoneRecord no longer has \(field)")
        }
        XCTAssertTrue(try block(shared, "export interface ProjectDoneRequestDeclineBody {").contains("note: string;"))

        let progress = try flat(Self.progress)
        let kinds = try block(progress, "export type SessionWaitingKind =")
        for kind in [SessionWaitingKind.doneRequest, .recordAsDone] {
            XCTAssertTrue(kinds.contains("'\(kind.rawValue)'"), "SessionWaitingKind no longer has \(kind.rawValue)")
        }
        XCTAssertTrue(progress.contains("  doneRequest?: DoneRequest | null;"), "an open item no longer carries its request")
        XCTAssertTrue(progress.contains("  doneRequest?: ProjectOpenItemRow<Instant> | null;"),
                      "the open-items read no longer serves the done request")

        let words = try flat(Self.words)
        for field in ["criteria: number;", "met: number;", "landed: number;", "onMain: number;",
                      "byReason: Record<CriterionLandingReason, number>;"] {
            XCTAssertTrue(try block(words, "export type ProjectDoneCounts = {").contains(field),
                          "ProjectDoneCounts no longer has \(field)")
        }
    }

    private func reasons(in source: String) throws -> [String] {
        let union = try block(source, "export type CriterionLandingReason =")
        return try NSRegularExpression(pattern: "\\| '([A-Z_]+)'")
            .matches(in: union, range: NSRange(union.startIndex..., in: union))
            .compactMap { Range($0.range(at: 1), in: union).map { String(union[$0]) } }
    }

    /// A declaration from its opening line to its end: the closing brace of a body that opens one,
    /// and the first semicolon of a union that does not.
    private func block(_ source: String, _ opening: String) throws -> String {
        guard let start = source.range(of: opening) else {
            XCTFail("\(opening) is gone from the web source")
            return ""
        }
        let rest = source[start.lowerBound...]
        let end = opening.hasSuffix("{") ? rest.range(of: "\n}") : rest.range(of: ";\n")
        return String(rest[..<(end?.upperBound ?? rest.endIndex)])
    }
}
