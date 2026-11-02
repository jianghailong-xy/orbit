import Foundation
import XCTest
@testable import OrbitKit

/// The Claude region check as iOS and macOS draw it (docs/claude-region-check-contract.md, board 03):
/// the rules the web's `lib/claudeRegion.ts` keeps, the session card's REGION_UNSUPPORTED cause and its
/// three ways out, a held session's words in the list and the header, Region not supported on the
/// Anthropic credentials of the pickers, the machine page's Claude Code row and note, and the
/// transcript's lines. Each case is the web spec's, ported: `claudeRegion.test.ts`,
/// `RunNeverStartedCard.region.test.tsx`, `sessionProviderChoices.test.ts`,
/// `RunnerEngines.claudeRegion.test.tsx` and `Transcript.claudeRegion.test.tsx`. The words themselves
/// are `ClaudeRegionCopyParityTests`'.
final class ClaudeRegionTests: XCTestCase {

    private let shanghai = TimeZone(identifier: "Asia/Shanghai")!
    /// 2026-10-31 12:00 in Shanghai, and HPC's check two minutes before: the card's "Checked 11:58".
    private let now = Date(timeIntervalSince1970: 1_793_419_200)
    private let checkedAt = "2026-10-31T03:58:00Z"

    private var blocked: RunnerRegionView {
        RunnerRegionView(verdict: "blocked", country: "CN", regionCode: nil, name: "mainland China",
                         viaProxy: false, checkedAt: checkedAt)
    }

    private func refusal(_ machine: String = "HPC", _ region: String = "mainland China") -> String {
        "CLAUDE_REGION_UNSUPPORTED: \(machine)’s connection to Anthropic is in \(region), where Anthropic doesn’t offer Claude."
    }

    private func stopped(_ machine: String = "HPC", _ region: String = "mainland China") -> String {
        "CLAUDE_REGION_UNSUPPORTED: Claude Code stopped on \(machine): its connection to Anthropic is now in \(region), where Anthropic doesn’t offer Claude."
    }

    private func session(_ status: RunStatus = .pending, error: String?, runState: SessionRunState? = nil,
                         lastTurnAt: String? = nil) -> Session {
        Session(id: "s", title: "Fix the flaky login test", status: status, runState: runState, agentId: "w",
                assignedRunnerId: "r", pendingApprovals: nil, branch: nil, updatedAt: nil, error: error,
                lastTurnAt: lastTurnAt)
    }

    private func card(_ session: Session, machine: String = "HPC", region: RunnerRegionView?) -> SessionRunStart.Card? {
        SessionRunStart.card(for: session, runnerName: machine, region: region, now: now, timeZone: shanghai)
    }

    // MARK: - the rules (claudeRegion.test.ts)

    func testOnlyABlockedEffectiveVerdictGates() {
        XCTAssertTrue(ClaudeRegion.blocked(blocked))
        XCTAssertFalse(ClaudeRegion.blocked(nil))
        XCTAssertFalse(ClaudeRegion.blocked(RunnerRegionView(verdict: "allowed", country: "SG", name: "Singapore")))
        XCTAssertFalse(ClaudeRegion.blocked(RunnerRegionView(verdict: nil)))
    }

    func testARegionErrorIsReadByItsCodeAlone() {
        XCTAssertTrue(ClaudeRegion.isRegionError(refusal()))
        XCTAssertTrue(ClaudeRegion.isRegionError("  " + stopped()))
        XCTAssertFalse(ClaudeRegion.isRegionError("runner offline"))
        XCTAssertFalse(ClaudeRegion.isRegionError("HPC: CLAUDE_REGION_UNSUPPORTED somewhere in the middle"))
        XCTAssertFalse(ClaudeRegion.isRegionError(nil))
    }

    func testTheTranscriptDrawsNoLineForARefusalAndTheStoppedSentenceWithoutItsCode() {
        XCTAssertEqual(ClaudeRegion.errorLine(refusal()), .refusal)
        XCTAssertEqual(ClaudeRegion.errorLine(stopped()),
                       .stopped("Claude Code stopped on HPC: its connection to Anthropic is now in mainland China, where Anthropic doesn’t offer Claude."))
        XCTAssertEqual(ClaudeRegion.errorLine("Claude Code needs authentication"), .notRegion)
        // A machine named like the stopped sentence is still a refusal: the shape is the whole sentence.
        XCTAssertEqual(ClaudeRegion.errorLine(refusal("Claude Code stopped on HPC")), .refusal)
    }

    func testAHeldSessionIsQueuedWithARegionErrorAndSaysWhereAnthropicIsUnavailable() {
        let held = session(error: refusal())
        XCTAssertTrue(ClaudeRegion.held(held))
        XCTAssertEqual(ClaudeRegion.heldWords(held, machine: "HPC"), "Anthropic unavailable on HPC")
        // Where the machine is not known, it says nothing of its own.
        XCTAssertNil(ClaudeRegion.heldWords(held, machine: nil))
        XCTAssertNil(ClaudeRegion.heldWords(held, machine: ""))
        // Not queued, or queued for anything else: not held.
        XCTAssertFalse(ClaudeRegion.held(session(.failed, error: refusal())))
        XCTAssertFalse(ClaudeRegion.held(session(error: "Waiting for a slot")))
        XCTAssertTrue(ClaudeRegion.held(status: .pending, error: stopped()))
        XCTAssertFalse(ClaudeRegion.held(status: .awaitingInput, error: stopped()))
    }

    func testAnthropicBoundIsTheSignInAClaudePoolAndAnAnthropicKey() {
        XCTAssertTrue(ClaudeRegion.credentialIsAnthropicBound(.login(engine: "claude")))
        XCTAssertTrue(ClaudeRegion.credentialIsAnthropicBound(.pool(engine: "claude")))
        XCTAssertTrue(ClaudeRegion.credentialIsAnthropicBound(.key(presetSlug: "anthropic")))
        XCTAssertFalse(ClaudeRegion.credentialIsAnthropicBound(.key(presetSlug: "deepseek")))
        XCTAssertFalse(ClaudeRegion.credentialIsAnthropicBound(.key(presetSlug: nil)))
        XCTAssertFalse(ClaudeRegion.credentialIsAnthropicBound(.login(engine: "codex")))
        XCTAssertFalse(ClaudeRegion.credentialIsAnthropicBound(.pool(engine: "codex")))
        XCTAssertFalse(ClaudeRegion.credentialIsAnthropicBound(.opencode))
    }

    func testCheckAgainIsAnsweredOnceACheckAtOrAfterTheRequestIsRecorded() {
        let asked = "2026-10-31T04:00:00.250Z"
        XCTAssertFalse(ClaudeRegion.checkAnswered(checkedAt: "2026-10-31T03:58:00Z", askedAt: asked))
        XCTAssertTrue(ClaudeRegion.checkAnswered(checkedAt: "2026-10-31T04:00:00.250Z", askedAt: asked))
        XCTAssertTrue(ClaudeRegion.checkAnswered(checkedAt: "2026-10-31T04:00:03Z", askedAt: asked))
        XCTAssertFalse(ClaudeRegion.checkAnswered(checkedAt: nil, askedAt: asked))
        XCTAssertEqual(ClaudeRegion.checkPollInterval, 2)
        XCTAssertEqual(ClaudeRegion.checkWait, 30)
    }

    // MARK: - the session card (RunNeverStartedCard.region.test.tsx)

    func testTheCardReadsTheCauseOffTheCodeAndThePlaceOffTheRunner() throws {
        let card = try XCTUnwrap(card(session(error: refusal()), region: blocked))
        XCTAssertEqual(SessionRunStart.title, "This run never started")
        XCTAssertEqual(card.why, "Claude Code can’t use Anthropic on HPC")
        XCTAssertEqual(card.body, "HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.")
        XCTAssertEqual(card.link, SessionRunStart.Link(label: "Supported regions",
                                                       url: "https://www.anthropic.com/legal/supported-regions"))
        XCTAssertEqual(card.lines, ["CLAUDE_REGION_UNSUPPORTED · CN",
                                    "Checked 11:58 · Claude’s connection: mainland China (no proxy)"])
        XCTAssertEqual(card.actions.map(\.kind), [.otherProvider, .moveSession, .checkAgain])
        XCTAssertEqual(card.actions.map(\.label), ["Use another provider", "Move to another machine", "Check again"])
        // Use another provider is the press the card wants: drawn filled, the other two beside it.
        XCTAssertEqual(card.actions.map(\.primary), [true, false, false])
        XCTAssertEqual(card.footer, "No engine ran · your message is still here")
    }

    func testTheCheckLineSaysAProxyWhenTheCheckWentThroughOne() throws {
        let proxied = RunnerRegionView(verdict: "blocked", country: "CN", name: "mainland China", viaProxy: true,
                                       checkedAt: checkedAt)
        XCTAssertEqual(try XCTUnwrap(card(session(error: refusal()), region: proxied)).lines.last,
                       "Checked 11:58 · Claude’s connection: mainland China (through a proxy)")
    }

    func testTheCheckTimeOfAnotherDayCarriesItsWeekday() throws {
        let earlier = RunnerRegionView(verdict: "blocked", country: "CN", name: "mainland China", viaProxy: false,
                                       checkedAt: "2026-10-30T03:58:00Z")
        XCTAssertEqual(try XCTUnwrap(card(session(error: refusal()), region: earlier)).lines.last,
                       "Checked Fri 11:58 · Claude’s connection: mainland China (no proxy)")
    }

    func testAnExcludedRegionOfAListedCountryIsNamedByItsOwnCode() throws {
        let crimea = RunnerRegionView(verdict: "blocked", country: "UA", regionCode: "UA-43", name: "Crimea",
                                      viaProxy: false, checkedAt: checkedAt)
        let card = try XCTUnwrap(card(session(error: refusal("HPC", "Crimea")), region: crimea))
        XCTAssertEqual(card.lines.first, "CLAUDE_REGION_UNSUPPORTED · UA-43")
        XCTAssertEqual(card.body, "HPC’s connection to Anthropic is in Crimea, where Anthropic doesn’t offer Claude.")
    }

    func testThePlaceIsNeverReadOutOfTheSentence() throws {
        // The sentence was written before the last check; the card says where the runner stands now.
        let card = try XCTUnwrap(card(session(error: refusal("HPC", "Russia")), region: blocked))
        XCTAssertTrue(card.body.contains("mainland China"))
        XCTAssertFalse(card.body.contains("Russia"))
    }

    func testARunnerThatNoLongerReadsBlockedKeepsTheServersWordsWithoutTheCode() throws {
        for region in [nil, RunnerRegionView(verdict: "allowed", country: "SG", name: "Singapore")] {
            let card = try XCTUnwrap(card(session(error: refusal()), region: region))
            XCTAssertEqual(card.why, "Claude Code can’t use Anthropic on HPC")
            XCTAssertEqual(card.lines, ["CLAUDE_REGION_UNSUPPORTED"])
            XCTAssertEqual(card.body, "HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.")
            XCTAssertEqual(card.actions.map(\.kind), [.otherProvider, .moveSession, .checkAgain])
        }
    }

    func testTheRegionCauseOutranksEveryCauseReadByPatternWhateverTheMachineIsCalled() throws {
        // "offline", "not signed in" and an upgrade sentence in a machine's name would otherwise pick
        // other cards, and an Antigravity or DeepSeek Harness repair would claim none.
        for machine in ["offline-box", "not signed in", "old runner, update this runner first",
                        "needs authentication"] {
            let card = try XCTUnwrap(card(session(error: refusal(machine, "Russia")), machine: machine, region: nil))
            XCTAssertEqual(card.why, "Claude Code can’t use Anthropic on \(machine)")
            XCTAssertEqual(card.actions.first?.kind, .otherProvider)
        }
    }

    func testAControlPlaneThatPredatesTheHoldFailedTheRunAndTheFootSaysSo() throws {
        let card = try XCTUnwrap(card(session(.failed, error: refusal()), region: blocked))
        XCTAssertEqual(card.footer, "Ended · no engine ran · 0 turns")
    }

    func testAStoppedTurnRanAndDrawsNoCardUnlessAMessageWaitsBehindIt() throws {
        // Parked after the stop, and failed by a control plane that predates the subtypes: no card —
        // its sentence stands in the transcript.
        XCTAssertNil(card(session(.awaitingInput, error: stopped()), region: blocked))
        XCTAssertNil(card(session(.failed, error: stopped()), region: blocked))
        // Queued behind the stopped turn, the next message waits under the same hold.
        XCTAssertEqual(card(session(.pending, error: stopped()), region: blocked)?.why,
                       "Claude Code can’t use Anthropic on HPC")
    }

    // MARK: - a held session's words (sessionLine, statusLabel, StatusIcon)

    func testAHeldSessionSaysAnthropicIsUnavailableInTheListTheHeaderAndTheGlyph() {
        let held = session(error: refusal(), lastTurnAt: "2026-10-31T03:24:00Z")
        XCTAssertEqual(SessionLine.make(for: held, live: true, machine: "HPC"),
                       SessionLine(text: "Anthropic unavailable on HPC", tone: .queued))
        XCTAssertEqual(SessionHeader.statusWord(for: held, machine: "HPC"), "Anthropic unavailable on HPC")
        XCTAssertEqual(SessionHeader.subtitle(for: held, now: now, machine: "HPC"),
                       "Anthropic unavailable on HPC · Open · 36m ago")
        let glyph = SessionStatusGlyph.make(for: held, machine: "HPC")
        XCTAssertEqual(glyph.label, "Anthropic unavailable on HPC")
        XCTAssertEqual(glyph.shape, .symbol("clock"))
        XCTAssertEqual(glyph.tone, .neutral)
    }

    /// Use another provider on a held session: nothing is in flight, so the note under the composer says the
    /// waiting message runs on the pick — never that a turn finishes on Claude Code. The console passes
    /// `liveRun: isLive && !regionHeld` (`ClaudeRegionWiringTests`); this is that expression on the two rows.
    func testAProviderPickOnAHeldSessionSaysTheWaitingMessageRunsOnIt() {
        func note(_ s: Session) -> String? {
            let live = ComposerLogic.isLive(status: s.effectiveRunStatus)
            return TaskRunHandoff.providerSwitchNote(
                from: "Claude Code", to: "DeepSeek",
                liveRun: live && !ClaudeRegion.held(status: s.effectiveRunStatus, error: s.error))
        }
        let held = session(error: refusal())
        XCTAssertTrue(ComposerLogic.isLive(status: held.effectiveRunStatus), "a queued session is live")
        XCTAssertEqual(note(held), "Your next message uses DeepSeek.")
        // A session queued for anything else keeps the note it had.
        XCTAssertEqual(note(session(error: nil)), "The turn in flight finishes on Claude Code. Your next one uses DeepSeek.")
    }

    func testEverySessionElseKeepsItsWordsAndOneWithNoMachineToo() {
        let queued = session(error: nil)
        XCTAssertEqual(SessionLine.make(for: queued, live: true, machine: "HPC").text, "Queued")
        XCTAssertEqual(SessionHeader.statusWord(for: queued, machine: "HPC"), "Queued")
        XCTAssertEqual(SessionStatusGlyph.make(for: queued, machine: "HPC").label, "Queued")
        let held = session(error: refusal())
        XCTAssertEqual(SessionLine.make(for: held, live: true).text, "Queued")
        XCTAssertEqual(SessionHeader.statusWord(for: held), "Queued")
        XCTAssertEqual(SessionStatusGlyph.make(for: held).label, "Queued")
    }

    // MARK: - the pickers (sessionProviderChoices.test.ts, "a runner blocked for the Claude region")

    private let deepseek = ConfiguredProvider(
        slug: "deepseek", label: "DeepSeek", runtime: "claude",
        models: [ConfiguredProviderModel(value: "deepseek-v4-pro", label: "DeepSeek V4 Pro")],
        defaultModel: "deepseek-v4-pro", presetSlug: "deepseek", runsOnOpenCode: true,
        engines: ["claude", "opencode", "dsh"])
    private let personalMax = ConfiguredProvider(
        slug: "anthropic", label: "Personal Max", runtime: "claude", models: [], presetSlug: "anthropic",
        modelsFromRuntime: true, engines: ["claude"])
    private let work = ConfiguredProvider(
        slug: "anthropic-2", label: "Work", runtime: "claude", models: [], presetSlug: "anthropic",
        modelsFromRuntime: true, engines: ["claude"])
    private let vllm = ConfiguredProvider(
        slug: "local-vllm", label: "Local vLLM", runtime: "claude",
        models: [ConfiguredProviderModel(value: "x-1", label: "X 1")],
        defaultModel: "x-1", presetSlug: nil, runsOnOpenCode: true, engines: ["claude", "opencode"])
    private let claudePool = ProviderPool(id: "0196e000-0000-7000-8000-00000000d002", slug: "claude-pool",
                                          label: "Claude Pool")

    private var threeAccounts: [RunnerEngineHealth] {
        [RunnerEngineHealth(engine: "claude", installed: true, auth: "yes",
                            accounts: [RunnerEngineAccount(id: "default", name: "Personal", auth: "yes"),
                                       RunnerEngineAccount(id: "slot-2", name: "Work", auth: "yes"),
                                       RunnerEngineAccount(id: "slot-3", name: "Team", auth: "yes")]),
         RunnerEngineHealth(engine: "codex", installed: true, auth: "yes")]
    }

    private func sources(_ configured: [ConfiguredProvider], pools: [ProviderPool] = [],
                         engines: [RunnerEngineHealth]? = nil, region: RunnerRegionView?) -> ChoiceSources {
        ChoiceSources(configured: configured + ProviderPools.asProviders(pools), engines: engines ?? threeAccounts,
                      pools: pools, region: region)
    }

    private struct Reason: Equatable {
        let unavailable: String?
        let fixEngine: String?
        let regionBlocked: Bool
    }

    private static let region = Reason(unavailable: "Region not supported", fixEngine: "claude", regionBlocked: true)
    private static let none = Reason(unavailable: nil, fixEngine: nil, regionBlocked: false)

    private func reasons(_ rows: [ProviderChoice]) -> [Reason] {
        rows.map { Reason(unavailable: $0.unavailable, fixEngine: $0.fixEngine, regionBlocked: $0.regionBlocked) }
    }

    func testAnthropicCredentialsUnderClaudeCodeReadRegionNotSupportedAndOtherKeysNothing() {
        let rows = SessionProviderChoices.providers(
            for: "claude", sources: sources([deepseek, personalMax, work, vllm], pools: [claudePool], region: blocked))
        XCTAssertEqual(rows.map(\.slug), ["claude", "claude-pool", "deepseek", "anthropic", "anthropic-2", "local-vllm"])
        XCTAssertEqual(reasons(rows), [Self.region, Self.region, Self.none, Self.region, Self.region, Self.none])
        // None of the sign-in's accounts can take a session there, so none is offered under it.
        XCTAssertNil(rows.first?.accounts)
    }

    func testTheRegionOutranksAnyOtherReasonAnAnthropicCredentialHas() {
        let missing = [RunnerEngineHealth(engine: "claude", installed: false, auth: "unknown")]
        let rows = SessionProviderChoices.providers(
            for: "claude", sources: sources([personalMax, deepseek], engines: missing, region: blocked))
        XCTAssertEqual(reasons(rows), [
            Self.region, Self.region,
            // A DeepSeek key keeps its own reason: Claude Code's CLI is what it lacks.
            Reason(unavailable: "Not installed", fixEngine: "claude", regionBlocked: false),
        ])
    }

    func testOnlyClaudeCodeIsGated() {
        let codexPool = ProviderPool(id: "0196e000-0000-7000-8000-00000000d001", slug: "codex-pool",
                                     label: "Codex Pool", engine: "codex")
        let codex = SessionProviderChoices.providers(for: "codex", sources: sources([deepseek], pools: [codexPool],
                                                                                   region: blocked))
        XCTAssertTrue(codex.allSatisfy { !$0.regionBlocked && $0.unavailable == nil })
        let openCode = SessionProviderChoices.providers(for: "opencode", sources: sources([deepseek, personalMax],
                                                                                         region: blocked))
        XCTAssertFalse(openCode.contains { $0.regionBlocked })
    }

    func testARunnerThatReadsNoRegionOrAnAllowedOneListsWhatItListsToday() {
        let configured = [deepseek, personalMax, vllm]
        let today = SessionProviderChoices.providers(for: "claude", sources: sources(configured, pools: [claudePool],
                                                                                    region: nil))
        let allowed = RunnerRegionView(verdict: "allowed", country: "SG", name: "Singapore")
        XCTAssertEqual(SessionProviderChoices.providers(for: "claude", sources: sources(configured, pools: [claudePool],
                                                                                       region: allowed)), today)
        XCTAssertFalse(today.contains { $0.regionBlocked })
    }

    func testTheClaudeCodeEngineRowStaysPickableWhileAnotherCredentialCanRunIt() {
        let engines = SessionProviderChoices.engines(sources: sources([deepseek, personalMax, vllm], region: blocked),
                                                     preferred: [EnginePick(engine: "claude", provider: "claude")])
        let claude = engines.first { $0.slug == "claude" }
        XCTAssertNil(claude?.unavailable)
        XCTAssertEqual(claude?.regionBlocked, false)
        XCTAssertEqual(claude?.provider?.slug, "deepseek")
    }

    func testTheClaudeCodeEngineRowGreysOnlyWhenNoOtherCredentialCanRunIt() {
        let engines = SessionProviderChoices.engines(sources: sources([personalMax], pools: [claudePool], region: blocked))
        let claude = engines.first { $0.slug == "claude" }
        XCTAssertEqual(claude?.unavailable, "Region not supported")
        XCTAssertEqual(claude?.fixEngine, "claude")
        XCTAssertEqual(claude?.regionBlocked, true)
        XCTAssertEqual(claude?.provider?.slug, "claude")
        XCTAssertNil(engines.first { $0.slug == "codex" }?.unavailable)
    }

    func testADraftOnClaudeCodesOwnSignInNamesTheReasonTheHeroExplains() {
        let blockedSources = sources([deepseek], region: blocked)
        let engines = SessionProviderChoices.engines(sources: blockedSources,
                                                     preferred: [EnginePick(engine: "claude", provider: "claude")])
        let current = SessionProviderChoices.currentEngine(engine: "claude", provider: "claude", engines: engines,
                                                           sources: blockedSources)
        XCTAssertEqual(current.provider?.unavailable, "Region not supported")
        XCTAssertEqual(current.provider?.regionBlocked, true)
        XCTAssertEqual(current.unavailable, "Region not supported")
        XCTAssertTrue(current.regionBlocked)
    }

    // MARK: - the machine page (RunnerEngines.claudeRegion.test.tsx, board 03)

    /// HPC as board 03 draws it: Claude Code with three accounts and a usage reading, Codex beside it.
    private func hpc(region: RunnerRegionView?, online: Bool = true) throws -> Runner {
        var object: [String: Any] = [
            "id": "r", "name": "workstation-gpu", "displayName": "HPC", "status": online ? "ONLINE" : "OFFLINE",
            "online": online, "lastHeartbeatAt": "2026-10-31T03:59:50Z",
            "engines": [
                ["engine": "claude", "installed": true, "version": "2.1.302 (Claude Code)", "auth": "yes",
                 "accounts": [["id": "default", "name": "Personal", "home": "/root/.claude", "auth": "yes"],
                              ["id": "slot-2", "name": "Work", "home": "/root/.orbit/claude-accounts/1", "auth": "yes"],
                              ["id": "slot-3", "name": "Team", "home": "/root/.orbit/claude-accounts/2", "auth": "no"]]],
                ["engine": "codex", "installed": true, "version": "codex-cli 0.164.0", "auth": "yes"],
            ],
            "planUsage": ["provider": "claude",
                          "fiveHour": ["utilization": 66, "resetsAt": "2026-10-31T06:00:00Z"],
                          "sevenDay": ["utilization": 12, "resetsAt": "2026-11-04T06:00:00Z"]],
        ]
        if let region {
            let value = { (field: Any?) -> Any in field ?? NSNull() }
            object["region"] = ["verdict": value(region.verdict), "country": value(region.country),
                                "regionCode": value(region.regionCode), "name": value(region.name),
                                "viaProxy": value(region.viaProxy), "checkedAt": value(region.checkedAt)]
        }
        return try JSONDecoder().decode(Runner.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testTheClaudeCodeRowSaysRegionNotSupportedAndReadsNoUsage() throws {
        let runner = try hpc(region: blocked)
        let claude = try XCTUnwrap(runner.engines?.first { $0.engine == "claude" })
        XCTAssertTrue(RunnerPageFormat.claudeRegionBlocked(runner, engine: "claude"))
        XCTAssertEqual(RunnerPageFormat.engineStatus(claude, runner: runner),
                       RunnerPageFormat.Status(text: "Region not supported", tone: .warn))
        XCTAssertEqual(RunnerPageFormat.engineWindows(runner, engine: "claude", now: now), [])
        XCTAssertNil(RunnerPageFormat.engineNextAccount(runner, engine: "claude", now: now))
        XCTAssertFalse(RunnerPageFormat.marksNext(runner, engine: "claude", account: "default", now: now))
        XCTAssertEqual(RunnerPageFormat.accountWindows(runner, engine: "claude", account: "default"), [])
        // No Claude sign-in starts there, so no account is added or signed in again.
        XCTAssertFalse(RunnerPageFormat.canSignIn(runner, engine: "claude"))
        XCTAssertFalse(RunnerPageFormat.canAddAccount(runner, engine: "claude"))
        // Codex on the same machine is untouched.
        let codex = try XCTUnwrap(runner.engines?.first { $0.engine == "codex" })
        XCTAssertFalse(RunnerPageFormat.claudeRegionBlocked(runner, engine: "codex"))
        XCTAssertEqual(RunnerPageFormat.engineStatus(codex, runner: runner)?.text, "Signed in")
        XCTAssertTrue(RunnerPageFormat.canAddAccount(runner, engine: "codex"))
    }

    func testTheNoteSaysWhyAndWhereClaudesConnectionCameOut() throws {
        let note = try XCTUnwrap(RunnerPageFormat.claudeRegionNote(try hpc(region: blocked), now: now))
        XCTAssertEqual(note.note, "Claude’s connection from this machine is in mainland China, where Anthropic doesn’t offer Claude, so Orbit won’t use Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys.")
        XCTAssertEqual(note.checked, "Checked 2m ago · Claude’s connection: mainland China (no proxy)")
        let proxied = RunnerRegionView(verdict: "blocked", country: "CN", name: "mainland China", viaProxy: true,
                                       checkedAt: checkedAt)
        XCTAssertEqual(RunnerPageFormat.claudeRegionNote(try hpc(region: proxied), now: now)?.checked,
                       "Checked 2m ago · Claude’s connection: mainland China (through a proxy)")
    }

    func testAMachineThatReadsNoRegionOrAnAllowedOneDrawsWhatItDrawsToday() throws {
        for region in [nil, RunnerRegionView(verdict: "allowed", country: "SG", name: "Singapore", checkedAt: checkedAt)] {
            let runner = try hpc(region: region)
            let claude = try XCTUnwrap(runner.engines?.first { $0.engine == "claude" })
            XCTAssertFalse(RunnerPageFormat.claudeRegionBlocked(runner, engine: "claude"))
            XCTAssertNil(RunnerPageFormat.claudeRegionNote(runner, now: now))
            XCTAssertEqual(RunnerPageFormat.engineStatus(claude, runner: runner)?.text, "Signed out")
            XCTAssertTrue(RunnerPageFormat.canSignIn(runner, engine: "claude"))
            XCTAssertTrue(RunnerPageFormat.canAddAccount(runner, engine: "claude"))
            XCTAssertFalse(RunnerPageFormat.accountWindows(runner, engine: "claude", account: "default").isEmpty)
        }
    }

    // MARK: - the transcript (Transcript.claudeRegion.test.tsx)

    private func transcript(_ error: String) -> TranscriptReducer {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .user, payload: .object(["text": .string("Now do the same for the sign-up test.")])))
        r.apply(RunEvent(seq: 2, type: .error, payload: .object(["message": .string(error)])))
        r.apply(RunEvent(seq: 3, type: .turnEnd, payload: .object([
            "subtype": .string("error_during_execution"), "numTurns": .int(0), "costUsd": .int(0)])))
        return r
    }

    private func errorLines(_ r: TranscriptReducer) -> [String] {
        r.state.items.compactMap { if case .error(_, let message) = $0 { return message }; return nil }
    }

    func testARefusalDrawsNoLineAndItsTurnCountsAsAnswered() {
        XCTAssertEqual(errorLines(transcript(refusal())), [])
    }

    func testAStoppedTurnSaysItsSentenceWithoutTheCode() {
        XCTAssertEqual(errorLines(transcript(stopped())),
                       ["Claude Code stopped on HPC: its connection to Anthropic is now in mainland China, where Anthropic doesn’t offer Claude."])
    }

    func testOtherErrorsAreDrawnAsBefore() {
        XCTAssertEqual(errorLines(transcript("spawn claude: no such file")), ["spawn claude: no such file"])
    }
}
