import Foundation
import XCTest
@testable import OrbitKit

/// The two cards a project's ruler is moved from, tested where they actually decide anything: the
/// derivation of WHERE a delivered card stands, which is the only thing that says whether its
/// buttons may be pressed.
///
/// Every assertion here is about a conclusion drawn from the SERVER's read. The card holds an
/// address and nothing else, so "this card is stale" is never local state — it is what the read
/// says now, and these tests are the place that claim is checked without a phone.
final class CriteriaDecisionTests: XCTestCase {

    // MARK: fixtures

    private func row(_ intentID: String,
                     decidable: Bool = true,
                     baseline: String = "6b1d02ea11223344",
                     current: String? = nil,
                     supersedes: String? = nil,
                     proposed: [ProposedCriterion] = [],
                     diff: CriteriaProposalDiff = .unreadable) -> PendingCriteriaDecisionRow {
        PendingCriteriaDecisionRow(
            intentId: intentID,
            projectId: "proj-1",
            commitToken: "tok-\(intentID)",
            actionDigest: "digest-\(intentID)",
            filedAt: "2026-09-09T12:00:00.000Z",
            ageSeconds: 240,
            baselineSeal: baseline,
            currentSeal: current ?? baseline,
            proposed: proposed,
            diff: diff,
            supersededIntentId: supersedes,
            decidability: decidable
                ? CriteriaDecisionDecidability(decidable: true)
                : CriteriaDecisionDecidability(
                    decidable: false,
                    refusal: CriteriaDecisions.baseSealMovedRefusal,
                    requiredAction: "REFILE_AGAINST_THE_CURRENT_STANDARD_SET"))
    }

    private func queue(_ rows: [PendingCriteriaDecisionRow]) -> PendingCriteriaDecisionQueue {
        PendingCriteriaDecisionQueue(
            readAt: "2026-09-09T12:04:00.000Z",
            projectId: "proj-1",
            count: rows.count,
            oldestAgeSeconds: rows.first?.ageSeconds,
            decidableCount: rows.filter { $0.decidability.decidable }.count,
            pending: rows)
    }

    // MARK: the five standings

    func testARowThatIsPendingAndDecidableIsTheOnlyAnswerableCard() {
        let standing = CriteriaDecisions.standing(queue: queue([row("i-1")]), intentId: "i-1")
        XCTAssertTrue(standing.answerable)
        XCTAssertNotNil(standing.row)
        XCTAssertNil(CriteriaDecisions.staleExplanation(standing))
        XCTAssertEqual(CriteriaDecisions.badge(standing), CriteriaDecisions.liveBadge)
        XCTAssertEqual(CriteriaDecisions.heading(standing), CriteriaDecisions.liveHeading)
    }

    func testABaseSealThatMovedIsShownAndRefusedRatherThanHidden() {
        let moved = row("i-1", decidable: false, baseline: "6b1d02ea1122", current: "9c4f7a1bb001")
        let standing = CriteriaDecisions.standing(queue: queue([moved]), intentId: "i-1")
        XCTAssertFalse(standing.answerable)
        // The row IS still published — that is the whole reason this state exists — so the card
        // can explain itself instead of vanishing.
        XCTAssertNotNil(standing.row)
        let why = CriteriaDecisions.staleExplanation(standing) ?? ""
        XCTAssertTrue(why.contains(CriteriaDecisions.baseSealMovedRefusal), why)
        XCTAssertTrue(why.contains("REFILE_AGAINST_THE_CURRENT_STANDARD_SET"), why)
        XCTAssertTrue(why.contains("Nothing was applied"), why)
    }

    func testAProposalIsSupersededWhenAPendingOneNamesItRatherThanWhenItIsMerelyOlder() {
        let replacement = row("i-2", supersedes: "i-1")
        let standing = CriteriaDecisions.standing(queue: queue([replacement]), intentId: "i-1")
        XCTAssertFalse(standing.answerable)
        XCTAssertNil(standing.row, "a displaced proposal is not published, so the card shows no diff")
        XCTAssertEqual(CriteriaDecisions.badge(standing), "replaced")
        XCTAssertTrue((CriteriaDecisions.staleExplanation(standing) ?? "").contains("Superseded"))

        // The negative control for the same read: without the supersession link the identical
        // queue means "answered", which is a different sentence and a different badge.
        let settled = CriteriaDecisions.standing(queue: queue([row("i-2")]), intentId: "i-1")
        XCTAssertEqual(CriteriaDecisions.badge(settled), "settled")
        let why = CriteriaDecisions.staleExplanation(settled) ?? ""
        XCTAssertTrue(why.contains(CriteriaDecisions.alreadySettledRefusal), why)
    }

    func testAnEmptyQueueMeansAnsweredAndNoQueueAtAllMeansUnread() {
        let answered = CriteriaDecisions.standing(queue: queue([]), intentId: "i-1")
        if case .alreadySettled = answered.state {} else { XCTFail("expected alreadySettled") }

        // nil is this CLIENT's state, not the proposal's, and it must not be read as "nothing is
        // pending": a card that cannot re-derive itself has no idea what the door would accept.
        let unread = CriteriaDecisions.standing(queue: nil, intentId: "i-1")
        if case .unread = unread.state {} else { XCTFail("expected unread") }
        XCTAssertFalse(unread.answerable)
        XCTAssertEqual(CriteriaDecisions.heading(unread), CriteriaDecisions.unreadHeading)
    }

    func testNoStandingButTheDecidableOneOffersAnAnswer() {
        let standings: [CriteriaDecisionStanding] = [
            CriteriaDecisions.standing(queue: queue([row("i-1")]), intentId: "i-1"),
            CriteriaDecisions.standing(queue: queue([row("i-1", decidable: false)]), intentId: "i-1"),
            CriteriaDecisions.standing(queue: queue([row("i-2", supersedes: "i-1")]), intentId: "i-1"),
            CriteriaDecisions.standing(queue: queue([]), intentId: "i-1"),
            CriteriaDecisions.standing(queue: nil, intentId: "i-1"),
        ]
        XCTAssertEqual(standings.map(\.answerable), [true, false, false, false, false])
        // And every unanswerable one says why: a disabled button with no sentence beside it is the
        // bug this rule exists to prevent.
        for standing in standings.dropFirst() {
            XCTAssertNotNil(CriteriaDecisions.staleExplanation(standing))
        }
    }

    /// The bar counts questions; the buttons answer them. They part company in exactly one place.
    func testAStaleCardStopsBeingCountedAsAQuestionButAnUnreadableOneDoesNot() {
        let live = CriteriaDecisions.standing(queue: queue([row("i-1")]), intentId: "i-1")
        let moved = CriteriaDecisions.standing(queue: queue([row("i-1", decidable: false)]),
                                               intentId: "i-1")
        let replaced = CriteriaDecisions.standing(queue: queue([row("i-2", supersedes: "i-1")]),
                                                  intentId: "i-1")
        let settled = CriteriaDecisions.standing(queue: queue([]), intentId: "i-1")
        let unread = CriteriaDecisions.standing(queue: nil, intentId: "i-1")

        XCTAssertEqual([live, moved, replaced, settled, unread].map(CriteriaDecisions.isOpen),
                       [true, false, false, false, true])
        // The one that differs from `answerable`, and the reason: a failed read is this device's
        // problem, not an answer somebody gave.
        XCTAssertFalse(unread.answerable)
        XCTAssertTrue(CriteriaDecisions.isOpen(unread))
    }

    /// Dimmed whole exactly when the card stopped being a question — so, like the bar's count, it
    /// parts company with `answerable` at `unread`, which stays bright.
    func testAStaleCardIsDimmedAndALiveOrUnreadableOneIsNot() {
        let live = CriteriaDecisions.standing(queue: queue([row("i-1")]), intentId: "i-1")
        let moved = CriteriaDecisions.standing(queue: queue([row("i-1", decidable: false)]),
                                               intentId: "i-1")
        let replaced = CriteriaDecisions.standing(queue: queue([row("i-2", supersedes: "i-1")]),
                                                  intentId: "i-1")
        let settled = CriteriaDecisions.standing(queue: queue([]), intentId: "i-1")
        let unread = CriteriaDecisions.standing(queue: nil, intentId: "i-1")
        // The fixtures are the three dead states and not three copies of one.
        XCTAssertEqual([moved, replaced, settled].map(CriteriaDecisions.badge),
                       ["seal moved", "replaced", "settled"])

        XCTAssertEqual([live, moved, replaced, settled, unread].map(CriteriaDecisions.isDimmed),
                       [false, true, true, true, false])
    }

    // MARK: what the card shows

    func testTheMetaLineCarriesTheProvenanceAndWhichRulerThisWasDraftedAgainst() {
        let live = CriteriaDecisions.meta(
            CriteriaDecisions.standing(queue: queue([row("i-1", baseline: "6b1d02ea1122")]),
                                       intentId: "i-1"))
        XCTAssertTrue(live.hasPrefix(CriteriaDecisions.provenanceLabel), live)
        XCTAssertTrue(live.contains("not the requesting agent"), live)
        XCTAssertTrue(live.contains("6b1d02ea1122"), live)
        XCTAssertTrue(live.contains("unchanged since it was drafted"), live)

        let moved = CriteriaDecisions.meta(
            CriteriaDecisions.standing(
                queue: queue([row("i-1", decidable: false,
                                  baseline: "6b1d02ea1122", current: "9c4f7a1bb001")]),
                intentId: "i-1"))
        XCTAssertTrue(moved.contains("the set in force is now 9c4f7a1bb001"), moved)
    }

    func testASealIsShortenedForComparisonAndAnUnreadableOneSaysSo() {
        XCTAssertEqual(CriteriaDecisions.shortSeal("6b1d02ea112233445566"), "6b1d02ea1122")
        XCTAssertEqual(CriteriaDecisions.shortSeal(""), "(unreadable)")
    }

    // MARK: the card is a diff

    /// A restatement of eight criteria that rewords three, in the shape the server publishes it —
    /// the same fact `criteria-weakening-1GB4IZ4B.fixture.json` records and both other ends are
    /// pinned to. `change` and `changed` are the SERVER's conclusion here as everywhere: nothing on
    /// this client compares two sets of words.
    private func eightRewordingThree() -> PendingCriteriaDecisionRow {
        let moved = [1, 2, 4]
        let entries = (1...8).map { ordinal -> CriteriaProposalChangeEntry in
            let rewritten = moved.contains(ordinal)
            return CriteriaProposalChangeEntry(
                change: rewritten ? .changed : .same,
                definitionId: "c-\(ordinal)",
                ordinal: ordinal,
                proposed: CriterionWording(
                    text: rewritten ? "criterion \(ordinal), rewritten" : "criterion \(ordinal)",
                    verificationMethod: "a person reads it"),
                onRecord: CriterionWording(text: "criterion \(ordinal)",
                                           verificationMethod: "a person reads it"),
                changed: rewritten ? [.text] : [],
                // The server's cut, fed in as the server's: `criterion N` stood and `, rewritten`
                // arrived. Nothing on this client compares two strings.
                rewrites: rewritten
                    ? [CriterionFieldRewrite(field: .text, segments: [
                        CriterionSegment(side: .kept, text: "criterion \(ordinal)"),
                        CriterionSegment(side: .added, text: ", rewritten"),
                    ])]
                    : [])
        }
        return row("i-1", diff: CriteriaProposalDiff(entries: entries, sameCount: 5,
                                                     changedCount: 3, newCount: 0, removedCount: 0))
    }

    func testOnlyTheCriteriaThatMovedAreListed() {
        let proposal = eightRewordingThree()
        // The positive control: the whole collection really did arrive, so folding it is this
        // client's doing rather than the server having sent three rows.
        XCTAssertEqual(proposal.diff.entries.count, 8)

        let rows = CriteriaDecisions.changeRows(proposal)
        XCTAssertEqual(rows.count, 3)
        // And WHICH three, in the server's own ordinals — a list renumbered 1. 2. 3. would be
        // inventing a set nobody proposed.
        XCTAssertEqual(rows.map(\.ordinal), [1, 2, 4])
        for each in rows {
            XCTAssertEqual(each.badge, CriteriaDecisions.rewordedLabel)
            // The procedure did not move, so it is not drawn at all.
            XCTAssertNil(each.method)
        }
    }

    /// ONE LINE PER REWRITE, NOT TWO.
    ///
    /// Laid out as the proposal's words and then the record's, three rewrites of long Chinese
    /// criteria came to 483px of content in a 360px scroll box — and a reader still had to compare
    /// two paragraphs to find the clause. So the row carries ONE sequence, which is the server's
    /// cut of the two versions, and neither version appears in it whole.
    func testARewriteIsOneMergedSequenceAndNotBothVersionsInFull() {
        let rows = CriteriaDecisions.changeRows(eightRewordingThree())
        for each in rows {
            // The positive control: the cut fed in really is a cut, not one run.
            XCTAssertGreaterThan(each.words.count, 1, "row \(each.ordinal)")
            XCTAssertEqual(each.words.map(\.side), [.kept, .added], "row \(each.ordinal)")
            XCTAssertEqual(each.words.map(\.text).joined(), "criterion \(each.ordinal), rewritten")
            // The words ON RECORD are read out of the same sequence rather than sent beside it.
            XCTAssertEqual(each.words.filter { $0.side != .added }.map(\.text).joined(),
                           "criterion \(each.ordinal)")
        }
    }

    /// A criterion being ADDED or DROPPED has one version, so it is one plain run — a card that
    /// struck through every word of a dropped criterion would be saying something different from
    /// "this criterion goes".
    func testACriterionWithOnlyOneVersionIsOnePlainRun() {
        let proposal = row("i-1", diff: CriteriaProposalDiff(
            entries: [
                CriteriaProposalChangeEntry(
                    change: .new, definitionId: nil, ordinal: 1,
                    proposed: CriterionWording(text: "a looser ruler", verificationMethod: "run it")),
            ],
            sameCount: 0, changedCount: 0, newCount: 1))
        let rows = CriteriaDecisions.changeRows(proposal)
        XCTAssertEqual(rows[0].words, [CriterionSegment(side: .kept, text: "a looser ruler")])
    }

    /// A server OLDER than this build sends no cut, which is a shape that exists because an App
    /// Store release outlives a deployment. The row is then drawn at the coarsest resolution — one
    /// struck-through run and one added run — rather than blank.
    func testAnEntryWithNoCutIsDrawnAsBothVersionsWhole() {
        let entry = CriteriaProposalChangeEntry(
            change: .changed, definitionId: "c-1", ordinal: 1,
            proposed: CriterionWording(text: "a looser ruler", verificationMethod: "run it"),
            onRecord: CriterionWording(text: "a stricter ruler", verificationMethod: "run it"),
            changed: [.text])
        XCTAssertTrue(entry.rewrites.isEmpty, "the positive control: this entry carries no cut")
        XCTAssertEqual(CriteriaDecisions.rewriteRuns(entry, .text), [
            CriterionSegment(side: .removed, text: "a stricter ruler"),
            CriterionSegment(side: .added, text: "a looser ruler"),
        ])
    }

    /// And the decode that gets it there: a response with no `rewrites` key at all is an entry
    /// without a cut, never a queue this client fails to read.
    func testAnEntryDecodesWithoutTheCutField() throws {
        let json = Data(#"""
        {"change":"CHANGED","definitionId":"c-1","ordinal":1,
         "proposed":{"text":"a looser ruler","verificationMethod":"run it",
                     "completionCriterionOverrideReason":null},
         "onRecord":{"text":"a stricter ruler","verificationMethod":"run it",
                     "completionCriterionOverrideReason":null},
         "changed":["text"]}
        """#.utf8)
        let entry = try JSONDecoder().decode(CriteriaProposalChangeEntry.self, from: json)
        XCTAssertEqual(entry.change, .changed)
        XCTAssertEqual(entry.changed, [.text])
        XCTAssertTrue(entry.rewrites.isEmpty)
    }

    /// The legend is offered exactly where the marks are: a proposal that only adds and drops
    /// criteria has no struck-through words on it, and explaining a mark that is not there costs a
    /// line on the card that had none to spare.
    func testTheLegendIsOfferedOnlyWhereSomethingWasRewritten() {
        XCTAssertTrue(CriteriaDecisions.hasRewrite(eightRewordingThree().diff))
        let addedOnly = CriteriaProposalDiff(entries: [
            CriteriaProposalChangeEntry(
                change: .new, definitionId: nil, ordinal: 1,
                proposed: CriterionWording(text: "a looser ruler", verificationMethod: "run it")),
        ], newCount: 1)
        XCTAssertFalse(CriteriaDecisions.hasRewrite(addedOnly))
    }

    func testTheCountOfWhatDidNotMoveIsAlwaysSaidAndItsWordsAreBehindIt() {
        let proposal = eightRewordingThree()
        XCTAssertEqual(CriteriaDecisions.unchangedLine(proposal.diff.sameCount),
                       "5 criteria are unchanged by this proposal")
        XCTAssertEqual(CriteriaDecisions.unchangedLine(1),
                       "1 criterion is unchanged by this proposal")
        // Folded, not dropped: the five are still there to be opened.
        let folded = CriteriaDecisions.unchangedRows(proposal)
        XCTAssertEqual(folded.count, 5)
        XCTAssertEqual(folded.first, "3. criterion 3")
        XCTAssertEqual(CriteriaDecisions.changeSummary(proposal.diff), "3 reworded, 5 unchanged")
    }

    func testACriterionWhoseProcedureAloneMovedIsAChangeAndShowsBothProcedures() {
        // `text` byte for byte the same on both sides. An edit that leaves the assertion alone and
        // rewrites how a reader decides it holds has still changed what the project has to prove.
        let proposal = row("i-1", diff: CriteriaProposalDiff(
            entries: [
                CriteriaProposalChangeEntry(
                    change: .changed, definitionId: "c-1", ordinal: 1,
                    proposed: CriterionWording(text: "Full API is green",
                                               verificationMethod: "somebody says it looks fine"),
                    onRecord: CriterionWording(text: "Full API is green",
                                               verificationMethod: "the full API suite passes"),
                    changed: [.verificationMethod]),
                CriteriaProposalChangeEntry(
                    change: .same, definitionId: "c-2", ordinal: 2,
                    proposed: CriterionWording(text: "the nodes pass", verificationMethod: "run it"),
                    onRecord: CriterionWording(text: "the nodes pass", verificationMethod: "run it")),
            ],
            sameCount: 1, changedCount: 1))
        let rows = CriteriaDecisions.changeRows(proposal)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].badge, CriteriaDecisions.rewordedLabel)
        // The assertion is identical, so the words alone would look like the same criterion twice:
        // the PROCEDURE is what carries the cut, and the assertion is drawn plain.
        XCTAssertEqual(rows[0].words, [CriterionSegment(side: .kept, text: "Full API is green")])
        XCTAssertEqual(rows[0].method, [
            CriterionSegment(side: .removed, text: "the full API suite passes"),
            CriterionSegment(side: .added, text: "somebody says it looks fine"),
        ])
    }

    func testWhatIsDroppedAndWhatIsAddedAreBothSaid() {
        let proposal = row("i-1", diff: CriteriaProposalDiff(
            entries: [
                CriteriaProposalChangeEntry(
                    change: .new, definitionId: nil, ordinal: 1,
                    proposed: CriterionWording(text: "a looser ruler", verificationMethod: "run it")),
                CriteriaProposalChangeEntry(
                    change: .removed, definitionId: "c-2", ordinal: 2, proposed: nil,
                    onRecord: CriterionWording(text: "the migrations replay from empty",
                                               verificationMethod: "a pg spec")),
            ],
            sameCount: 0, changedCount: 0, newCount: 1, removedCount: 1))
        let rows = CriteriaDecisions.changeRows(proposal)
        XCTAssertEqual(rows.map(\.badge),
                       [CriteriaDecisions.addedLabel, CriteriaDecisions.droppedLabel])
        // A dropped criterion has no proposed side at all, so the row is drawn in the words that
        // would GO — the only place they are still written down.
        XCTAssertEqual(rows[1].ordinal, 2)
        XCTAssertEqual(rows[1].words.map(\.text).joined(), "the migrations replay from empty")
        XCTAssertEqual(CriteriaDecisions.changeSummary(proposal.diff),
                       "1 dropped, 1 added, 0 unchanged")
        XCTAssertTrue(CriteriaDecisions.unchangedRows(proposal).isEmpty)
    }

    func testAProposalNothingCouldBeReadOutOfDrawsNoDiffAtAll() {
        // The read publishes an EMPTY diff for a row whose stored action it cannot make sense of,
        // rather than one saying every criterion on record is being dropped.
        let proposal = row("i-1")
        XCTAssertTrue(CriteriaDecisions.changeRows(proposal).isEmpty)
        XCTAssertEqual(CriteriaDecisions.changeSummary(proposal.diff),
                       CriteriaDecisions.changeSummaryUnreadable)
    }

    // MARK: what one press sends

    func testThePressCarriesTheOneTimeKeyAndTheVersionItWasComposedAgainst() throws {
        let proposal = row("i-1", baseline: "6b1d02ea1122")
        let request = CriteriaDecisions.request(row: proposal, decision: .approve)
        XCTAssertEqual(request.commitToken, "tok-i-1")
        XCTAssertEqual(request.baseSeal, "6b1d02ea1122")
        // The door's spelling, not the client's: REJECT is the wire word behind "Refuse".
        let refusal = CriteriaDecisions.request(row: proposal, decision: .reject)
        let json = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(refusal)) as? [String: Any]
        XCTAssertEqual(json?["decision"] as? String, "REJECT")
    }

    func testTheLineLeftBehindNamesBothSealsForAnApprovalAndOneForARefusal() {
        let approved = CriteriaDecisionResult(intentId: "i-1", decision: .approve,
                                              decidedAt: "2026-09-09T12:05:00.000Z",
                                              baseSeal: "6b1d02ea1122", resultingSeal: "9c4f7a1bb001",
                                              applied: true)
        let line = CriteriaDecisions.decisionLine(approved)
        XCTAssertTrue(line.contains("6b1d02ea1122 → 9c4f7a1bb001"), line)

        let refused = CriteriaDecisionResult(intentId: "i-1", decision: .reject,
                                             decidedAt: "2026-09-09T12:05:00.000Z",
                                             baseSeal: "6b1d02ea1122", resultingSeal: "6b1d02ea1122",
                                             applied: false)
        XCTAssertTrue(CriteriaDecisions.decisionLine(refused).contains("nothing was applied"))
    }

    // MARK: the wire

    func testTheOwnerReadDecodesTheServersOwnShape() throws {
        // Field-for-field what `readPendingCriteriaDecisionsForOwner` publishes, so a rename on the
        // server is a red test here rather than a card that silently renders nothing.
        let json = """
        {"readAt":"2026-09-09T12:04:00.000Z","projectId":"p1","count":1,"oldestAgeSeconds":240,
         "decidableCount":0,
         "pending":[{"intentId":"i1","projectId":"p1","commitToken":"tok","actionDigest":"d",
           "filedAt":"2026-09-09T12:00:00.000Z","ageSeconds":240,"baselineSeal":"aaa",
           "currentSeal":"bbb",
           "proposed":[{"id":null,"ordinal":1,"text":"t","verificationMethod":"v",
                        "completionCriterionOverrideReason":null}],
           "diff":{"sameCount":1,"changedCount":1,"newCount":0,"removedCount":0,"entries":[
             {"change":"CHANGED","definitionId":"c1","ordinal":1,
              "proposed":{"text":"t","verificationMethod":"v",
                          "completionCriterionOverrideReason":null},
              "onRecord":{"text":"was t","verificationMethod":"v",
                          "completionCriterionOverrideReason":null},
              "changed":["text"]},
             {"change":"SAME","definitionId":"c2","ordinal":2,
              "proposed":{"text":"u","verificationMethod":"v",
                          "completionCriterionOverrideReason":null},
              "onRecord":{"text":"u","verificationMethod":"v",
                          "completionCriterionOverrideReason":null},
              "changed":[]}]},
           "supersededIntentId":null,
           "decidability":{"decidable":false,"refusal":"PROJECT_CRITERIA_DECISION_BASE_SEAL_MOVED",
                           "requiredAction":"REFILE_AGAINST_THE_CURRENT_STANDARD_SET"}}]}
        """
        let decoded = try JSONDecoder().decode(PendingCriteriaDecisionQueue.self,
                                               from: Data(json.utf8))
        XCTAssertEqual(decoded.pending.count, 1)
        XCTAssertEqual(decoded.pending[0].commitToken, "tok")
        XCTAssertNil(decoded.pending[0].proposed[0].id)
        XCTAssertFalse(decoded.pending[0].decidability.decidable)
        // The diff decodes field for field too, including the enums: a `change` this client did
        // not know would throw here rather than reaching a card that draws it as nothing.
        let diff = decoded.pending[0].diff
        XCTAssertEqual([diff.changedCount, diff.sameCount], [1, 1])
        XCTAssertEqual(diff.entries.map(\.change), [.changed, .same])
        XCTAssertEqual(diff.entries[0].changed, [.text])
        XCTAssertEqual(diff.entries[0].onRecord?.text, "was t")
        let standing = CriteriaDecisions.standing(queue: decoded, intentId: "i1")
        XCTAssertFalse(standing.answerable)
    }

    func testTheConfirmationStandingDecodesItsThreeStates() throws {
        let json = """
        {"state":"STALE","confirmed":false,
         "currentVersion":{"digest":"9c4f7a1bb001","material":[
            {"definitionId":"d1","revision":2,"contentHash":"h1"},
            {"definitionId":"d2","revision":1,"contentHash":"h2"}]},
         "confirmation":{"criteriaDigest":"6b1d02ea1122","criteriaMaterial":[],
                         "confirmedAt":"2026-09-08T10:00:00.000Z","confirmedById":"u1"}}
        """
        let standing = try JSONDecoder().decode(StandardSetConfirmationStanding.self,
                                                from: Data(json.utf8))
        XCTAssertEqual(standing.state, .stale)
        XCTAssertEqual(standing.currentVersion.material.count, 2)
        XCTAssertTrue(AcceptanceConfirmations.answerable(standing))
    }

    // MARK: the confirmation card

    private func confirmation(_ state: StandardSetConfirmationStanding.State,
                              criteria: Int = 10) -> StandardSetConfirmationStanding {
        let material = (0..<criteria).map {
            ConfirmedCriterionVersion(definitionId: "d\($0)", revision: 1, contentHash: "h\($0)")
        }
        let prior = RecordedStandardSetConfirmation(
            criteriaDigest: state == .confirmed ? "9c4f7a1bb001" : "6b1d02ea1122",
            criteriaMaterial: material,
            confirmedAt: "2026-09-08T10:00:00.000Z", confirmedById: "u1")
        return StandardSetConfirmationStanding(
            state: state,
            confirmed: state == .confirmed,
            currentVersion: StandardSetVersion(digest: "9c4f7a1bb001", material: material),
            confirmation: state == .unconfirmed ? nil : prior)
    }

    func testTheConfirmationCardNamesTheSetAndTheVersionSettlementIsHeldOn() {
        let meta = AcceptanceConfirmations.meta(confirmation(.unconfirmed))
        XCTAssertTrue(meta.hasPrefix(CriteriaDecisions.provenanceLabel), meta)
        XCTAssertTrue(meta.contains("the set of 10 at seal 9c4f7a1bb001"), meta)
        XCTAssertTrue(meta.contains("Settlement is held on this"), meta)
        XCTAssertEqual(AcceptanceConfirmations.readLabel(count: 10), "Read the 10 criteria")
        XCTAssertEqual(AcceptanceConfirmations.readLabel(count: 1), "Read the 1 criterion")
    }

    func testBothUnconfirmedStatesOfferTheButtonAndAConfirmedOneDoesNot() {
        XCTAssertTrue(AcceptanceConfirmations.answerable(confirmation(.unconfirmed)))
        XCTAssertTrue(AcceptanceConfirmations.answerable(confirmation(.stale)))
        XCTAssertFalse(AcceptanceConfirmations.answerable(confirmation(.confirmed)))
        // A standing that could not be read offers nothing, for the reason the other card's
        // `unread` does: nobody can say whether the door would take it.
        XCTAssertFalse(AcceptanceConfirmations.answerable(nil))
        XCTAssertNotNil(AcceptanceConfirmations.staleExplanation(nil))
        XCTAssertNil(AcceptanceConfirmations.staleExplanation(confirmation(.unconfirmed)))
        XCTAssertNotNil(AcceptanceConfirmations.staleExplanation(confirmation(.confirmed)))
    }

    func testTheOpenQuestionIsNeverDroppedFromTheBodyWhileItIsStillOpen() {
        for state in [StandardSetConfirmationStanding.State.unconfirmed, .stale] {
            let checks = AcceptanceConfirmations.checks(confirmation(state))
            XCTAssertEqual(checks.count, 2)
            XCTAssertTrue(checks.allSatisfy { !$0.ok }, "nothing holds while the set is unconfirmed")
            XCTAssertTrue(checks.last!.text.contains("will not derive DONE"), checks.last!.text)
            XCTAssertTrue(checks.last!.text.contains("this set of 10"), checks.last!.text)
        }
        // Confirmed: the same two lines, both holding, and the mechanism is now the warning that a
        // single edit ends it.
        let done = AcceptanceConfirmations.checks(confirmation(.confirmed))
        XCTAssertTrue(done.allSatisfy(\.ok))
        XCTAssertTrue(done.last!.text.contains("Editing any criterion ends this confirmation"))
    }

    func testAConfirmedSetIsNoLongerAQuestionAndAnUnreadableOneStillIs() {
        XCTAssertTrue(AcceptanceConfirmations.isOpen(confirmation(.unconfirmed)))
        XCTAssertTrue(AcceptanceConfirmations.isOpen(confirmation(.stale)))
        XCTAssertFalse(AcceptanceConfirmations.isOpen(confirmation(.confirmed)))
        XCTAssertTrue(AcceptanceConfirmations.isOpen(nil))
    }

    func testOnlyAConfirmedSetDimsItsCardAndAnUnreadableOneStaysBright() {
        XCTAssertFalse(AcceptanceConfirmations.isDimmed(confirmation(.unconfirmed)))
        XCTAssertFalse(AcceptanceConfirmations.isDimmed(confirmation(.stale)))
        XCTAssertTrue(AcceptanceConfirmations.isDimmed(confirmation(.confirmed)))
        XCTAssertFalse(AcceptanceConfirmations.isDimmed(nil),
                       "a standing this device could not read is not a card known to be dead")
    }

    func testAStaleConfirmationSaysWhichVersionWasConfirmedBefore() {
        let checks = AcceptanceConfirmations.checks(confirmation(.stale))
        XCTAssertTrue(checks[0].text.contains("no longer stands"), checks[0].text)
        XCTAssertTrue(checks[0].text.contains("6b1d02ea1122"), checks[0].text)
    }
}
