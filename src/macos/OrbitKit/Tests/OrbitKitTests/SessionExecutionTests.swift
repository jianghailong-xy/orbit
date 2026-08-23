import XCTest
@testable import OrbitKit

/// Stage R of the Session State V2 contract on the client side: every session-shaped payload can
/// now carry a canonical `execution` atom, an atom is preferred whole or ignored whole, and a
/// status this build cannot decode stops being able to blank the payload it rides in.
///
/// Two things this suite is equally responsible for proving it did NOT do. The server does not send
/// `execution` yet, so every reading users actually see today must come out byte-identical — that
/// is the last section. And where the new `RunStatus.unknown` case does become reachable, it must
/// land closed (no send, no resume, no verdict) rather than on a convenient default.
final class SessionExecutionTests: XCTestCase {

    private func session(_ json: String) throws -> Session {
        try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    }
    private func detail(_ json: String) throws -> SessionDetail {
        try JSONDecoder().decode(SessionDetail.self, from: Data(json.utf8))
    }
    private func hit(_ json: String) throws -> SessionSearchHit {
        try JSONDecoder().decode(SessionSearchHit.self, from: Data(json.utf8))
    }
    private func ref(_ json: String) throws -> SessionRef {
        try JSONDecoder().decode(SessionRef.self, from: Data(json.utf8))
    }
    private func summary(_ json: String) throws -> ControlSessionSummary {
        try JSONDecoder().decode(ControlSessionSummary.self, from: Data(json.utf8))
    }
    private func ended(_ json: String) throws -> ControlSessionEnded {
        try JSONDecoder().decode(ControlSessionEnded.self, from: Data(json.utf8))
    }

    // MARK: - 1. The canonical atom, on every surface that carries a session

    func testListRowDecodesTheCanonicalAtom() throws {
        let s = try session("""
        {"id":"s1","status":"RUNNING","runState":"RUNNING",
         "execution":{"activity":"GENERATING","outcome":null}}
        """)
        XCTAssertEqual(s.execution, SessionExecution(activity: .generating))
        XCTAssertEqual(s.effectiveExecution.activity, .generating)
        XCTAssertNil(s.effectiveExecution.outcome)
    }

    func testDetailDecodesTheCanonicalAtom() throws {
        let d = try detail("""
        {"id":"s1","status":"SUCCEEDED","execution":{"activity":"TERMINATED","outcome":"SUCCEEDED"}}
        """)
        XCTAssertEqual(d.execution, SessionExecution(activity: .terminated, outcome: .succeeded))
        XCTAssertEqual(d.effectiveExecution, SessionExecution(activity: .terminated, outcome: .succeeded))
    }

    func testSearchHitDecodesTheCanonicalAtom() throws {
        let h = try hit("""
        {"id":"s1","title":"Fix bug","status":"CANCELLED","matchField":"title",
         "execution":{"activity":"TERMINATED","outcome":"ENDED"}}
        """)
        XCTAssertEqual(h.execution, SessionExecution(activity: .terminated, outcome: .ended))
        XCTAssertEqual(h.effectiveExecution.outcome, .ended)
    }

    func testSessionRefDecodesTheCanonicalAtom() throws {
        let r = try ref("""
        {"id":"s1","title":"run","status":"FAILED","runState":"FAILED",
         "agent":{"name":"builder"},"execution":{"activity":"TERMINATED","outcome":"FAILED"}}
        """)
        XCTAssertEqual(r.execution, SessionExecution(activity: .terminated, outcome: .failed))
        XCTAssertEqual(r.effectiveExecution, SessionExecution(activity: .terminated, outcome: .failed))
        // The hand-written decoder still has to decode everything the synthesized one did.
        XCTAssertEqual(r.title, "run")
        XCTAssertEqual(r.status, .failed)
        XCTAssertEqual(r.runState, .failed)
        XCTAssertEqual(r.agent?.name, "builder")
        XCTAssertEqual(r.resolvedRunState, .failed)
    }

    func testControlSummaryAndEndedDecodeTheCanonicalAtom() throws {
        let s = try summary("""
        {"id":"s1","status":"RUNNING","pendingApprovals":0,
         "execution":{"activity":"GENERATING"}}
        """)
        XCTAssertEqual(s.execution ?? nil, SessionExecution(activity: .generating))
        XCTAssertEqual(s.effectiveExecution.activity, .generating)

        let e = try ended("""
        {"status":"CANCELLED","endReason":"USER_ENDED","execution":{"activity":"TERMINATED","outcome":"ENDED"}}
        """)
        XCTAssertEqual(e.execution, SessionExecution(activity: .terminated, outcome: .ended))
        XCTAssertEqual(e.effectiveExecution.outcome, .ended)
    }

    func testAtomRoundTrips() throws {
        let atom = SessionExecution(activity: .stopping, outcome: nil)
        let data = try JSONEncoder().encode(atom)
        XCTAssertEqual(try JSONDecoder().decode(SessionExecution.self, from: data), atom)

        let settled = SessionExecution(activity: .terminated, outcome: .failed)
        let row = try JSONDecoder().decode(
            Session.self,
            from: try JSONEncoder().encode(
                Session(id: "s1", title: nil, status: .failed, agentId: nil, assignedRunnerId: nil,
                        pendingApprovals: nil, branch: nil, updatedAt: nil, execution: settled)))
        XCTAssertEqual(row.execution, settled)
    }

    // MARK: - 2. Unknown enum values: read as unknown, never guessed, never fatal

    func testUnknownActivityAndOutcomeStayUnknownWithoutFailingTheRow() throws {
        let s = try session("""
        {"id":"s1","status":"RUNNING",
         "execution":{"activity":"REHYDRATING","outcome":"ABANDONED"}}
        """)
        // The object IS complete — it just speaks a vocabulary this build postdates. It is kept,
        // and both halves report that they were not understood rather than picking a neighbour.
        XCTAssertEqual(s.execution, SessionExecution(activity: .unknown, outcome: .unknown))
        XCTAssertFalse(SessionActivity.unknown.isGenerating)
        XCTAssertFalse(SessionActivity.unknown.acceptsUserTurn)
    }

    func testUnknownRawStatusNoLongerBlanksTheWholePayload() throws {
        // `PARKED` is the retired label Postgres cannot drop from the physical enum, so it is the
        // real value this guards against. Before `RunStatus` had a forward-compat floor this
        // payload threw, and one unreadable row took the whole list with it.
        let s = try session(#"{"id":"s1","status":"PARKED","pendingApprovals":0}"#)
        XCTAssertEqual(s.status, .unknown)
        XCTAssertEqual(s.effectiveRunStatus, .unknown)
        // Contract D1: unknown settles as unknown, NOT as `.ended` — which, with a `completedAt`,
        // the legacy vocabulary would have gone on to read as a completed run.
        XCTAssertEqual(s.effectiveRunState, .unknown)
        XCTAssertEqual(s.effectiveExecution, SessionExecution(activity: .unknown, outcome: .unknown))
    }

    func testUnknownRunStatusStepsAsideForTheRawStatus() throws {
        // Preferred, not obeyed: the same rule `runState` has always followed. Reading the newer
        // field as authoritative-even-when-unreadable would make a rolling upgrade *lose*
        // information the older field was still carrying correctly.
        let s = try session(#"{"id":"s1","status":"RUNNING","runStatus":"REHYDRATING"}"#)
        XCTAssertEqual(s.effectiveRunStatus, .running)
        XCTAssertEqual(s.effectiveRunState, .running)

        let d = try detail(#"{"id":"s1","status":"AWAITING_INPUT","runStatus":"REHYDRATING"}"#)
        XCTAssertEqual(d.effectiveRunStatus, .awaitingInput)

        let h = try hit(#"{"id":"s1","title":"t","status":"FAILED","runStatus":"REHYDRATING","matchField":"title"}"#)
        XCTAssertEqual(h.effectiveRunStatus, .failed)

        let sum = try summary(#"{"id":"s1","status":"PENDING","runStatus":"REHYDRATING","pendingApprovals":0}"#)
        XCTAssertEqual(sum.effectiveRunStatus, .pending)

        let e = try ended(#"{"status":"SUCCEEDED","runStatus":"REHYDRATING"}"#)
        XCTAssertEqual(e.effectiveRunStatus, .succeeded)
    }

    func testUnknownStatusOnlyEverywhereItCanArriveDecodesRatherThanThrows() throws {
        XCTAssertEqual(try detail(#"{"id":"s1","status":"PARKED"}"#).effectiveRunStatus, .unknown)
        XCTAssertEqual(try hit(#"{"id":"s1","title":"t","status":"PARKED","matchField":"id"}"#).status, .unknown)
        XCTAssertEqual(try ref(#"{"id":"s1","status":"PARKED"}"#).status, .unknown)
        XCTAssertEqual(try summary(#"{"id":"s1","status":"PARKED","pendingApprovals":0}"#).status, .unknown)
        XCTAssertEqual(try ended(#"{"status":"PARKED"}"#).status, .unknown)
    }

    func testUnknownStatusFailsClosed() throws {
        // Contract §6: display may say "unknown"; authorization may not shrug. None of these is a
        // reading anything acts on — the composer refuses, the resume path refuses, and the
        // "session finished" notification never fires for a run we cannot say finished.
        XCTAssertFalse(RunStatus.unknown.isLive)
        XCTAssertFalse(RunStatus.unknown.isTerminal)
        XCTAssertEqual(ComposerLogic.availability(status: .unknown), .blocked)
        XCTAssertFalse(ComposerLogic.shouldResume(status: .unknown))
        XCTAssertFalse(ComposerLogic.isLive(status: .unknown))
        let s = try session(#"{"id":"s1","status":"PARKED"}"#)
        XCTAssertFalse(s.isGenerating)
        XCTAssertFalse(s.retryPending())
    }

    // MARK: - 3. Missing, malformed and conflicting fields

    func testAbsentAtomIsNotAnAtomAndTheRowStillReads() throws {
        let s = try session(#"{"id":"s1","status":"AWAITING_INPUT","runState":"AWAITING_INPUT"}"#)
        XCTAssertNil(s.execution)
        XCTAssertEqual(s.effectiveExecution, SessionExecution(activity: .idle))
    }

    func testAbsentOutcomeAndExplicitNullOutcomeBothMeanNoVerdictYet() throws {
        let absent = try session(#"{"id":"s1","status":"RUNNING","execution":{"activity":"GENERATING"}}"#)
        let null = try session(#"{"id":"s1","status":"RUNNING","execution":{"activity":"GENERATING","outcome":null}}"#)
        XCTAssertNil(absent.execution?.outcome)
        XCTAssertNil(null.execution?.outcome)
        XCTAssertEqual(absent.execution, null.execution)
    }

    /// A canonical object is believed whole or not at all. Every case here is a payload that is
    /// *not* a canonical atom, and each one has to land on the legacy reading rather than on a
    /// half-built atom — an activity with no verdict field decoded is indistinguishable from a run
    /// that has no verdict, which is exactly the confusion the atom exists to end.
    func testMalformedAtomFallsBackWholeAndNeverFailsTheRow() throws {
        let cases: [(String, String)] = [
            ("null", "explicit null"),
            ("{}", "no activity named"),
            ("{\"outcome\":\"SUCCEEDED\"}", "a verdict with no activity"),
            ("{\"activity\":5}", "activity is not a string"),
            ("{\"activity\":\"GENERATING\",\"outcome\":7}", "outcome is not a string"),
            ("{\"activity\":null}", "activity is null"),
            ("\"GENERATING\"", "a bare string, not an object"),
            ("[\"GENERATING\"]", "an array"),
        ]
        for (payload, why) in cases {
            let s = try session("""
            {"id":"s1","status":"RUNNING","runState":"RUNNING","execution":\(payload)}
            """)
            XCTAssertNil(s.execution, "should have discarded \(why)")
            // …and the row keeps working off the legacy fields.
            XCTAssertEqual(s.effectiveRunState, .running, "row survived \(why)")
            XCTAssertEqual(s.effectiveExecution, SessionExecution(activity: .generating),
                           "fell back to the derived atom after \(why)")
        }
    }

    func testMalformedAtomIsToleratedOnEverySurface() throws {
        XCTAssertNil(try detail(#"{"id":"s1","status":"RUNNING","execution":{}}"#).execution)
        XCTAssertNil(try hit(#"{"id":"s1","title":"t","status":"RUNNING","matchField":"id","execution":3}"#).execution)
        XCTAssertNil(try ref(#"{"id":"s1","status":"RUNNING","execution":"nope"}"#).execution)
        XCTAssertNil(try ended(#"{"status":"CANCELLED","execution":[]}"#).execution)
        XCTAssertEqual(try summary(#"{"id":"s1","status":"RUNNING","pendingApprovals":0,"execution":{}}"#)
                        .execution ?? nil, nil)
    }

    func testCanonicalAtomWinsOverEveryLegacyFieldItContradicts() throws {
        // A row whose legacy fields all say the run succeeded, and whose canonical atom says it is
        // generating. Stage R's precedence is that the atom is the answer — and, just as
        // deliberately, that nothing presentation reads has moved onto it yet (section 6).
        let s = try session("""
        {"id":"s1","status":"SUCCEEDED","runStatus":"SUCCEEDED","sessionState":"COMPLETED",
         "runState":"SUCCEEDED","execution":{"activity":"GENERATING"}}
        """)
        XCTAssertEqual(s.effectiveExecution, SessionExecution(activity: .generating))
        XCTAssertNil(s.effectiveExecution.outcome)
    }

    func testCanonicalAtomOutranksTheDerivedStoppingSignal() throws {
        // `resumeBlockedReason == ENDING` is how the fallback sees a pending end. When the server
        // states an atom, it is not consulted at all: the server knows whether the end landed.
        let s = try session("""
        {"id":"s1","status":"RUNNING","runState":"RUNNING",
         "capabilities":{"canSend":false,"canResume":false,"resumeBlockedReason":"ENDING","canComplete":true,"canRestore":false},
         "execution":{"activity":"GENERATING"}}
        """)
        XCTAssertEqual(s.effectiveExecution.activity, .generating)
    }

    // MARK: - 4. The derived fallback — what every payload gets today

    func testDerivedAtomReproducesTheTruthTable() throws {
        XCTAssertEqual(SessionExecution.derived(runState: .queued), SessionExecution(activity: .queued))
        XCTAssertEqual(SessionExecution.derived(runState: .running), SessionExecution(activity: .generating))
        XCTAssertEqual(SessionExecution.derived(runState: .awaitingInput), SessionExecution(activity: .idle))
        XCTAssertEqual(SessionExecution.derived(runState: .interrupted), SessionExecution(activity: .idle))
        XCTAssertEqual(SessionExecution.derived(runState: .succeeded),
                       SessionExecution(activity: .terminated, outcome: .succeeded))
        XCTAssertEqual(SessionExecution.derived(runState: .failed),
                       SessionExecution(activity: .terminated, outcome: .failed))
        XCTAssertEqual(SessionExecution.derived(runState: .ended),
                       SessionExecution(activity: .terminated, outcome: .ended))
        XCTAssertEqual(SessionExecution.derived(runState: .unknown),
                       SessionExecution(activity: .unknown, outcome: .unknown))
    }

    func testDerivedAtomReportsASelfDrivenTurnAsGenerating() throws {
        // The row the truth table marks in bold: parked by status, generating in fact. Contract D4
        // extends the same reading to a stale `INTERRUPTED` row.
        XCTAssertEqual(SessionExecution.derived(runState: .awaitingInput, engineTurnActive: true).activity,
                       .generating)
        XCTAssertEqual(SessionExecution.derived(runState: .interrupted, engineTurnActive: true).activity,
                       .generating)
        let s = try session("""
        {"id":"s1","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","engineTurnActive":true}
        """)
        XCTAssertEqual(s.effectiveExecution.activity, .generating)
    }

    func testDerivedAtomReportsAnAcceptedEndAsStopping() throws {
        // Contract D2, and the one row a client could not express before: the user pressed End, the
        // server took it, the runner has not finished tearing down. Priority 3 — it outranks
        // generating, because what streams during teardown is not an invitation to reply.
        for live in [SessionRunState.queued, .running, .awaitingInput, .interrupted] {
            XCTAssertEqual(SessionExecution.derived(runState: live, ending: true),
                           SessionExecution(activity: .stopping), "\(live) + pending end")
        }
        XCTAssertEqual(SessionExecution.derived(runState: .running, engineTurnActive: true, ending: true).activity,
                       .stopping)
        let s = try session("""
        {"id":"s1","status":"RUNNING","runState":"RUNNING",
         "capabilities":{"canSend":false,"canResume":false,"resumeBlockedReason":"ENDING","canComplete":true,"canRestore":false}}
        """)
        XCTAssertEqual(s.effectiveExecution, SessionExecution(activity: .stopping))
    }

    func testASettledRunOutranksAPendingEnd() throws {
        // Priority 1. A run that is already over cannot be talked back into stopping.
        for terminal in [SessionRunState.succeeded, .failed, .ended] {
            XCTAssertEqual(SessionExecution.derived(runState: terminal, ending: true).activity, .terminated)
        }
        XCTAssertEqual(SessionExecution.derived(runState: .unknown, ending: true).activity, .unknown)
    }

    func testSlimPayloadsThatStateNoExecutionAtAllDeriveNothing() throws {
        // Better than an invented atom: `creatorSession` and the deliberately thin detail DTO can
        // omit every execution field, and "we were not told" is the only honest answer.
        XCTAssertNil(try detail(#"{"id":"s1"}"#).effectiveExecution)
        XCTAssertNil(try ref(#"{"id":"s1"}"#).effectiveExecution)
        // But a legacy mixed state is still enough to derive from.
        XCTAssertEqual(try detail(#"{"id":"s1","sessionState":"RUNNING"}"#).effectiveExecution,
                       SessionExecution(activity: .generating))
        XCTAssertEqual(try ref(#"{"id":"s1","sessionState":"COMPLETED"}"#).effectiveExecution,
                       SessionExecution(activity: .terminated, outcome: .succeeded))
    }

    // MARK: - 5. The SSE upsert: the atom is replaced whole, or left alone

    private func loadedRow(_ execution: String) throws -> Session {
        try session("""
        {"id":"s1","title":"Fix bug","status":"SUCCEEDED","runStatus":"SUCCEEDED","runState":"SUCCEEDED",
         "lifecycleState":"OPEN","pendingApprovals":0,"lastAssistantText":"done","execution":\(execution)}
        """)
    }

    func testResumeClearsTheOutcomeTheRowWasStillShowing() throws {
        // The epoch reset. The row is a finished run; the resume's summary says the session is
        // generating again and states no verdict. Keeping the old SUCCEEDED because the new atom
        // "didn't carry one" is precisely the bug atomic replacement exists to prevent — the row
        // would claim a verdict belonging to a run that is no longer the current one.
        let row = try loadedRow(#"{"activity":"TERMINATED","outcome":"SUCCEEDED"}"#)
        XCTAssertEqual(row.execution?.outcome, .succeeded)

        let merged = row.applying(try summary("""
        {"id":"s1","status":"RUNNING","runStatus":"RUNNING","runState":"RUNNING","pendingApprovals":0,
         "execution":{"activity":"GENERATING"}}
        """))
        XCTAssertEqual(merged.execution, SessionExecution(activity: .generating))
        XCTAssertNil(merged.execution?.outcome)
        XCTAssertEqual(merged.effectiveExecution.activity, .generating)
        // Everything the slim summary does not carry still survives the merge.
        XCTAssertEqual(merged.lastAssistantText, "done")
    }

    func testAnOlderControlPlaneNeverClearsTheAtomItCannotSend() throws {
        let row = try loadedRow(#"{"activity":"TERMINATED","outcome":"FAILED"}"#)
        let merged = row.applying(try summary("""
        {"id":"s1","status":"SUCCEEDED","runState":"SUCCEEDED","pendingApprovals":0}
        """))
        XCTAssertEqual(merged.execution, SessionExecution(activity: .terminated, outcome: .failed))
    }

    func testAServerSayingItHasNoAtomDropsTheRowsStaleOne() throws {
        // Null, and unusable, are the same statement: this server is not telling us an atom. The
        // row must not go on quoting one from an earlier event — it falls back to legacy instead.
        for payload in ["null", "{}", "\"GENERATING\""] {
            let row = try loadedRow(#"{"activity":"TERMINATED","outcome":"SUCCEEDED"}"#)
            let merged = row.applying(try summary("""
            {"id":"s1","status":"RUNNING","runStatus":"RUNNING","runState":"RUNNING",
             "pendingApprovals":0,"execution":\(payload)}
            """))
            XCTAssertNil(merged.execution, "should have dropped the stale atom for \(payload)")
            XCTAssertEqual(merged.effectiveExecution, SessionExecution(activity: .generating))
        }
    }

    func testEventsThatCarryNoStatusLeaveTheAtomAlone() throws {
        let row = try loadedRow(#"{"activity":"IDLE"}"#)
        XCTAssertEqual(row.settingPendingApprovals(2).execution, SessionExecution(activity: .idle))
        XCTAssertEqual(row.settingTitle("Renamed").execution, SessionExecution(activity: .idle))
    }

    // MARK: - 6. Nothing users can see has moved yet

    /// The whole point of stage R being its own step: the atom is decoded, preferred and merged,
    /// and not one reading on screen consults it. A row whose canonical atom flatly contradicts its
    /// legacy fields must still draw exactly what it drew before this change — otherwise the
    /// cutover would have happened here, silently, on whatever the server started sending.
    func testCanonicalAtomDoesNotMoveAnyPresentationYet() throws {
        let legacyOnly = try session("""
        {"id":"s1","status":"SUCCEEDED","runStatus":"SUCCEEDED","runState":"SUCCEEDED","pendingApprovals":0}
        """)
        let withAtom = try session("""
        {"id":"s1","status":"SUCCEEDED","runStatus":"SUCCEEDED","runState":"SUCCEEDED","pendingApprovals":0,
         "execution":{"activity":"GENERATING"}}
        """)
        XCTAssertEqual(withAtom.effectiveRunState, legacyOnly.effectiveRunState)
        XCTAssertEqual(withAtom.isGenerating, legacyOnly.isGenerating)
        XCTAssertFalse(withAtom.isGenerating)
        XCTAssertEqual(withAtom.retryPending(), legacyOnly.retryPending())
        XCTAssertEqual(SessionStatusGlyph.make(for: withAtom), SessionStatusGlyph.make(for: legacyOnly))
        XCTAssertEqual(SessionStatusGlyph.make(for: withAtom).tone, .success)
    }

    func testStoppingIsDerivedButStillNotDrawn() throws {
        // The one everyday row the contract says a client will eventually draw differently. It
        // reads STOPPING in the atom already — and goes on rendering as the working session it has
        // always rendered as, until the cutover task moves the glyph.
        let s = try session("""
        {"id":"s1","status":"RUNNING","runState":"RUNNING","pendingApprovals":0,
         "capabilities":{"canSend":false,"canResume":false,"resumeBlockedReason":"ENDING","canComplete":true,"canRestore":false}}
        """)
        XCTAssertEqual(s.effectiveExecution.activity, .stopping)
        XCTAssertEqual(s.effectiveRunState, .running)
        XCTAssertTrue(s.isGenerating)
        XCTAssertEqual(SessionStatusGlyph.make(for: s).shape, .spinner)
    }
}
