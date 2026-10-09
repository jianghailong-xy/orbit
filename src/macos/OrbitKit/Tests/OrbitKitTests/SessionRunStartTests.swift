import XCTest
@testable import OrbitKit

/// The card a session page draws when no engine ever ran: the refused SOURCE (task tier) and the
/// machine-side reasons (ordinary tier). Both tiers are asserted on the words the page prints —
/// title, why, body, the machine lines and the presses — because that is the whole of what the
/// card is: OrbitKit holds no view, and the view prints exactly this.
final class SessionRunStartTests: XCTestCase {

    private func session(_ status: RunStatus = .failed, taskId: String? = nil,
                         error: String? = nil, sourceState: String? = nil,
                         sourceRefusalCode: String? = nil,
                         sourceRefusalDetail: SourceRefusalDetail? = nil) -> Session {
        Session(id: "s", title: "t", status: status, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: nil, taskId: taskId, branch: nil, updatedAt: nil,
                error: error, sourceState: sourceState, sourceRefusalCode: sourceRefusalCode,
                sourceRefusalDetail: sourceRefusalDetail)
    }

    // MARK: - the refused SOURCE (task tier)

    /// The incident this card exists for: a downstream task's baseline was the project's
    /// integration line, that line had never been created, and the runner's `git fetch` said so
    /// while the session sat on its claim showing `Starting`.
    private func refusedBaselineSession() -> Session {
        session(.failed, taskId: "task-1", sourceState: "REFUSED",
                sourceRefusalCode: "BASE_REF_NOT_FOUND",
                sourceRefusalDetail: SourceRefusalDetail(
                    fixAction: "FIX_REF",
                    ref: "refs/heads/project/34bZ3i4AvgJaaow5E9tH",
                    stderr: "git: fatal: couldn't find remote ref refs/heads/project/34bZ3i4AvgJaaow5E9tH"))
    }

    func testARefusedRunDrawsTheNeverStartedCard() throws {
        let card = try XCTUnwrap(SessionRunStart.card(for: refusedBaselineSession()))
        XCTAssertEqual(SessionRunStart.title, "This run never started")
        XCTAssertEqual(card.why, "Its baseline is a branch that doesn't exist yet")
        XCTAssertEqual(card.body, "This project's integration line has not been created.")
    }

    /// What the card was asked to carry beyond its prose: the refusal's own code, the ref it could
    /// not resolve, and the runner's words — then the step that follows from the server's action.
    func testTheCardCarriesTheCodeTheRefAndTheRunnersWords() throws {
        let card = try XCTUnwrap(SessionRunStart.card(for: refusedBaselineSession()))
        XCTAssertEqual(card.lines, [
            "BASE_REF_NOT_FOUND",
            "refs/heads/project/34bZ3i4AvgJaaow5E9tH",
            "git: fatal: couldn't find remote ref refs/heads/project/34bZ3i4AvgJaaow5E9tH",
        ])
        let step = card.actions.map(\.label)
        XCTAssertEqual(step, ["Start it again", "Chat about this"])
        XCTAssertEqual(card.actions.first?.kind, .startItAgain)
        XCTAssertTrue(card.actions.first?.primary == true)
        XCTAssertFalse(card.actions.last?.primary == true)
        XCTAssertEqual(card.footer, "No engine ran — the task is still open.")
    }

    /// §10.1's action is the server's, and the advice is the server's own sentence for it: the one
    /// the task's comment and the coordinator's message already give.
    func testTheNextStepIsTheServersSentenceForThatAction() {
        let step = SessionRunStart.nextStep(fixAction: "FIX_REF",
                                            ref: "refs/heads/project/34bZ3i4AvgJaaow5E9tH")
        XCTAssertTrue(step.hasPrefix("解析的时候仓库里没有 `refs/heads/project/34bZ3i4AvgJaaow5E9tH`："))
        XCTAssertTrue(step.hasSuffix("在那之前重新开工只会得到同一个拒绝。"))
    }

    /// The ref is quoted the way a branch is spelled, and a refusal about no ref says so instead of
    /// leaving a hole where one would be.
    func testTheNextStepNamesTheLineWhenThereIsOne() {
        XCTAssertTrue(SessionRunStart.nextStep(fixAction: "SYNC_INTEGRATION_LINE", ref: "refs/heads/project/x")
            .contains("缺的是它落地的提交不在集成线 project/x上"))
        XCTAssertTrue(SessionRunStart.nextStep(fixAction: "SYNC_INTEGRATION_LINE", ref: nil)
            .contains("缺的是它落地的提交不在这次起跑的线上"))
        XCTAssertTrue(SessionRunStart.nextStep(fixAction: "FIX_REF", ref: nil)
            .contains("仓库里没有 这次起跑要用的 ref："))
        XCTAssertEqual(SessionRunStart.nextStep(fixAction: "SOMETHING_NEW", ref: nil),
                       "按处置 SOMETHING_NEW 修好之后再开工。在那之前重新开工只会得到同一个拒绝。")
    }

    /// The prose and the step are keyed on the same field, so a card cannot pair one action's
    /// explanation with another's advice.
    func testTheProseFollowsTheActionTheServerSent() throws {
        let sync = session(.failed, sourceState: "REFUSED", sourceRefusalCode: "DEPENDENCY_BASE_NOT_LANDED",
                           sourceRefusalDetail: SourceRefusalDetail(fixAction: "SYNC_INTEGRATION_LINE",
                                                                    ref: "refs/heads/project/x"))
        let card = try XCTUnwrap(SessionRunStart.card(for: sync))
        XCTAssertEqual(card.why, "The line hasn't absorbed what the prerequisite landed")
        XCTAssertTrue(card.footer?.isEmpty == false)
        // An action this client has never heard of still draws the card, in the server's words.
        let unknown = session(.failed, sourceState: "REFUSED", sourceRefusalCode: "BASE_SHA_UNAVAILABLE",
                              sourceRefusalDetail: SourceRefusalDetail(fixAction: "INVENTED_LATER"))
        let fallback = try XCTUnwrap(SessionRunStart.card(for: unknown))
        XCTAssertEqual(fallback.why, "This run's baseline couldn't be resolved")
        XCTAssertEqual(fallback.lines, ["BASE_SHA_UNAVAILABLE"])
    }

    /// A state is not a sentence: a refusal with nothing written down still gets its card, because
    /// the state alone is the fact.
    func testARefusalWithNoDetailStillDraws() throws {
        let card = try XCTUnwrap(SessionRunStart.card(for: session(.failed, sourceState: "REFUSED")))
        XCTAssertEqual(card.why, "This run's baseline couldn't be resolved")
        XCTAssertEqual(card.lines, [])
    }

    /// `UNBOUND`, `SELECTED` and `PINNED` are not refusals, and no other session has this card.
    func testOnlyARefusedSessionGetsTheRefusalCard() {
        for state in ["UNBOUND", "SELECTED", "PINNED", nil] {
            XCTAssertNil(SessionRunStart.card(for: session(.running, sourceState: state)))
        }
    }

    // MARK: - the ordinary tier

    /// The reaper's own sentence: the server writes a bare `runner offline`, and both clients read
    /// it into the same word (`SessionStatusGlyph`, web's `WorkspaceView`).
    func testARunnerThatWentOfflineSaysSoAndOffersAResend() throws {
        let card = try XCTUnwrap(SessionRunStart.card(
            for: session(.failed, error: "runner offline"), runnerName: "longdeMac-mini.local"))
        XCTAssertEqual(card.why, "The runner holding this session went offline")
        XCTAssertEqual(card.body, "longdeMac-mini.local stopped reporting while this run was starting. "
            + "Nothing was produced, and nothing was sent anywhere.")
        XCTAssertEqual(card.lines, ["Disconnected — runner went offline"])
        XCTAssertEqual(card.actions.map(\.kind), [.sendItAgain, .chatAboutThis])
        XCTAssertEqual(card.actions.first?.label, "Send it again")
    }

    /// An engine too old for the run: the why is the app's existing word for it, and the body names
    /// the release the SERVER's sentence names rather than a number of this file's own.
    func testAnEngineThatNeedsANewerRunnerWaitsForTheRunnersOwnUpdate() throws {
        let card = try XCTUnwrap(SessionRunStart.card(
            for: session(.failed, error: "OpenCode requires Orbit runner 0.1.82 or newer; update this runner first"),
            runnerName: "longdeMac-mini.local", runnerVersion: "0.1.120"))
        XCTAssertEqual(card.why, "Waiting for a newer runner")
        XCTAssertEqual(card.body, "longdeMac-mini.local runs Orbit runner 0.1.120; OpenCode needs 0.1.82 or newer. "
            + "The runner updates itself when no session is running on it, and this run starts then.")
        XCTAssertEqual(card.actions.map(\.kind), [.openRunner])
        XCTAssertFalse(card.actions[0].primary)
    }

    /// The unversioned twins of that sentence (Antigravity's, Harness's) still draw, and a runner
    /// whose version the client does not know does not invent one.
    func testAnUnversionedUpgradeSentenceDrawsWithoutInventingAVersion() throws {
        let card = try XCTUnwrap(SessionRunStart.card(
            for: session(.failed, error: "Gemini requires a newer Orbit runner; update this runner first"),
            runnerName: nil, runnerVersion: nil))
        XCTAssertEqual(card.body, "this runner runs Orbit runner an unknown version; Gemini needs a newer release. "
            + "The runner updates itself when no session is running on it, and this run starts then.")
    }

    /// A CLI the machine does not have: the engine's name is the runner's own word for it, taken
    /// out of its sentence, and the advice is the app's existing one for this failure.
    func testAnEngineThatIsNotInstalledNamesTheEngineAndTheMachine() throws {
        let runner = "OpenCode isn't installed on this runner and installing it failed (exit 1) "
            + "— run `orbit doctor` on that machine. Tried:  npm i -g opencode"
        let card = try XCTUnwrap(SessionRunStart.card(for: session(.failed, error: runner),
                                                      runnerName: "longdeMac-mini.local"))
        XCTAssertEqual(card.why, "OpenCode isn't installed on longdeMac-mini.local")
        XCTAssertEqual(card.body, "Install it from Infrastructure, then send your message again.")
        XCTAssertEqual(card.body, SessionRunStart.installAdvice)
        XCTAssertEqual(card.actions.map(\.kind), [.openRunner])
    }

    /// An Antigravity or DeepSeek Harness repair is drawn by its own card on this page, with
    /// machinery this one does not carry — so this card says nothing about it.
    func testTheTwoEnginesThatAlreadyHaveACardKeepIt() {
        XCTAssertNotNil(EngineAuth.antigravityRepair("Antigravity CLI isn't installed on workstation"))
        XCTAssertNil(SessionRunStart.card(for: session(.pending, error: "Antigravity CLI isn't installed on workstation")))
        XCTAssertNotNil(DshRuntime.repair("DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner"))
        XCTAssertNil(SessionRunStart.card(for: session(.pending,
                                                       error: "DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner")))
    }

    /// Nothing to say: no error, or an error no reason here recognizes.
    func testASessionWithNoRecognizableReasonDrawsNothing() {
        XCTAssertNil(SessionRunStart.card(for: session(.running)))
        XCTAssertNil(SessionRunStart.card(for: session(.failed, error: "  ")))
        XCTAssertNil(SessionRunStart.card(for: session(.running, error: "rate limit exceeded")))
    }

    // MARK: - decoding

    /// The three columns arrive camelCase like every other field, and a payload written before
    /// they existed reads as "nothing to say" rather than failing the row.
    func testTheSourceColumnsDecodeAndAnOlderPayloadDecodesToo() throws {
        let json = """
        {"id":"s","status":"FAILED","sourceState":"REFUSED","sourceRefusalCode":"BASE_REF_NOT_FOUND",
         "sourceRefusalDetail":{"ref":"refs/heads/project/x","refAuthority":"REMOTE","remoteName":"origin",
                                "stderr":"fatal: couldn't find remote ref refs/heads/project/x","fixAction":"FIX_REF"}}
        """
        let decoded = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.sourceState, "REFUSED")
        XCTAssertEqual(decoded.sourceRefusalCode, "BASE_REF_NOT_FOUND")
        XCTAssertEqual(decoded.sourceRefusalDetail?.fixAction, "FIX_REF")
        XCTAssertEqual(decoded.sourceRefusalDetail?.ref, "refs/heads/project/x")
        XCTAssertEqual(decoded.sourceRefusalDetail?.said,
                       "fatal: couldn't find remote ref refs/heads/project/x")

        let older = try JSONDecoder().decode(Session.self, from: Data(#"{"id":"s","status":"RUNNING"}"#.utf8))
        XCTAssertNil(older.sourceState)
        XCTAssertNil(older.sourceRefusalCode)
        XCTAssertNil(older.sourceRefusalDetail)
        XCTAssertNil(SessionRunStart.card(for: older))
    }

    /// `said` reads the two keys in the server's own order, and blank is unsaid.
    func testTheRunnersWordsComeFromStderrThenReason() {
        XCTAssertEqual(SourceRefusalDetail(reason: "only a reason").said, "only a reason")
        XCTAssertEqual(SourceRefusalDetail(stderr: "  ", reason: "reason").said, "reason")
        XCTAssertNil(SourceRefusalDetail(stderr: "  ").said)
        XCTAssertNil(SourceRefusalDetail().said)
        XCTAssertEqual(SessionRunStart.branchName("refs/heads/project/x"), "project/x")
        XCTAssertEqual(SessionRunStart.branchName("refs/tags/v1"), "refs/tags/v1")
    }
}
