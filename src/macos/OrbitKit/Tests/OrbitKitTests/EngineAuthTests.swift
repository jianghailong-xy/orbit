import XCTest
@testable import OrbitKit

/// A sign-in failure has to become a remedy card, not another line of prose: the transcript keys on
/// the runtime's own `Failed to authenticate` prefix, folds the repeat a re-dispatch produces, and
/// the card asks for the right remedy for the session's provider.
final class EngineAuthTests: XCTestCase {

    private let expired = "Failed to authenticate: OAuth session expired and could not be refreshed"
    private let signedOut =
        "Failed to authenticate: Claude Code is installed on this runner but not signed in — sign in from here, or run `claude auth login` on that machine."

    // MARK: recognizing one

    func testRecognizesTheRuntimesOwnPrefix() {
        XCTAssertTrue(EngineAuth.isAuthErrorText(expired))
        XCTAssertTrue(EngineAuth.isAuthErrorText(signedOut))
        XCTAssertTrue(EngineAuth.isAuthErrorText("  Failed to authenticate: invalid API key"))
        XCTAssertFalse(EngineAuth.isAuthErrorText("API Error: 500"))
        XCTAssertFalse(EngineAuth.isAuthErrorText("all good"))
        XCTAssertFalse(EngineAuth.isAuthErrorText(nil))
    }

    // MARK: what to do about it

    func testRemedyPerProvider() {
        XCTAssertEqual(EngineAuth.remedy(forProvider: "claude"), .signIn(.claude))
        XCTAssertEqual(EngineAuth.remedy(forProvider: "codex"), .signIn(.codex))
        XCTAssertEqual(EngineAuth.remedy(forProvider: "kimi"), .signIn(.kimi))
        // OpenCode's login picks its provider interactively, so it can't be relayed from here.
        XCTAssertEqual(EngineAuth.remedy(forProvider: "opencode"), .runCommand("opencode auth login"))
        // Antigravity connects the encrypted Gemini key in Providers.
        XCTAssertEqual(EngineAuth.remedy(forProvider: "antigravity"), .connectGemini)
        // Any other slug is a control-plane–configured provider, i.e. a key to fix.
        XCTAssertEqual(EngineAuth.remedy(forProvider: "my-vendor"), .apiKey(slug: "my-vendor"))
    }

    func testAntigravityRepairsRecognizeQueueAndRuntimeFailures() {
        XCTAssertEqual(EngineAuth.antigravityRepair("Antigravity requires a newer Orbit runner; update this runner first"), .updateRunner)
        XCTAssertEqual(EngineAuth.antigravityRepair("Antigravity CLI isn't installed on workstation"), .notInstalled)
        XCTAssertEqual(EngineAuth.antigravityRepair("Antigravity CLI (\"agy\") not found on this runner's PATH — run `orbit doctor` on the runner to install it and sign in."), .notInstalled)
        XCTAssertNil(EngineAuth.antigravityRepair("Codex CLI isn't installed"))
        XCTAssertNil(EngineAuth.antigravityRepair(nil))
    }

    func testAntigravityMissingKeyFailureKeepsItsOriginalRepairAfterSwitchingToGemini() {
        let message = "Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), and neither this session nor the runner has one — set GEMINI_API_KEY in the runner's environment, or give the session a Gemini API key; Google-account sign-in is not supported."
        XCTAssertEqual(EngineAuth.antigravityRepair(message), .needsKey,
                       "the original missing key failure must not become a rejection of the newly connected key")
        XCTAssertEqual(EngineAuth.remedy(forProvider: "gemini"), .apiKey(slug: "gemini"))
        XCTAssertNil(EngineAuth.antigravityRepair("Failed to authenticate: invalid Gemini API key"),
                     "a rejected BYOK key still earns its own key-rejection remedy")
    }

    func testAntigravityCardsNameTheRunnerAndOfferEncryptedKeys() {
        XCTAssertEqual(EngineAuth.antigravityTitle(.needsKey, runnerName: "HPC"), "Antigravity needs a Gemini API key")
        XCTAssertEqual(EngineAuth.antigravityBody(.needsKey, runnerName: nil, runnerVersion: nil),
                       "Connect Gemini in Providers. Orbit stores the key encrypted, and this conversation can continue on it.")
        XCTAssertEqual(EngineAuth.antigravityTitle(.updateRunner, runnerName: "HPC"), "Waiting for a newer runner")
        XCTAssertEqual(EngineAuth.antigravityBody(.updateRunner, runnerName: "HPC", runnerVersion: "0.1.208"),
                       "HPC runs Orbit runner 0.1.208; Antigravity needs 0.1.209 or newer. The runner updates itself when no session is running on it, and this session starts then.")
        XCTAssertEqual(EngineAuth.antigravityTitle(.notInstalled, runnerName: "workstation"),
                       "Antigravity CLI isn't installed on workstation")
        XCTAssertEqual(EngineAuth.antigravityBody(.notInstalled, runnerName: "workstation", runnerVersion: nil),
                       "Install it from Providers, then send your message again.")
        XCTAssertEqual(EngineAuth.antigravityTitle(.notInstalled, runnerName: nil), "Antigravity CLI isn't installed on this runner")
        XCTAssertTrue(EngineAuth.antigravityBody(.updateRunner, runnerName: "", runnerVersion: "").contains("this runner runs Orbit runner an unknown version"))
    }

    // MARK: the transcript

    func testAssistantAuthTextBecomesARemedyCard() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .user, payload: .object(["text": .string("hi")])))
        r.apply(RunEvent(seq: 2, type: .assistant, payload: .object(["text": .string(expired)])))

        XCTAssertEqual(r.state.items.count, 2)
        guard case .authError(_, let message) = r.state.items[1] else {
            return XCTFail("expected an authError item, got \(r.state.items[1])")
        }
        XCTAssertEqual(message, expired)
    }

    /// The failure often streams in as deltas first; finalizing must replace that bubble rather
    /// than leave the same text on screen twice.
    func testStreamedAuthTextLeavesNoAssistantBubbleBehind() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 0, type: .textDelta, payload: .object(["delta": .string(expired)])))
        r.apply(RunEvent(seq: 3, type: .assistant, payload: .object([:])))   // no text of its own

        XCTAssertEqual(r.state.items.count, 1)
        guard case .authError(_, let message) = r.state.items[0] else {
            return XCTFail("expected the streaming bubble to become an authError item")
        }
        XCTAssertEqual(message, expired)
    }

    /// The runner reports a signed-out engine as an `error` event — it never got to spawn a model —
    /// but the remedy is the same human action, so it earns the same card.
    func testErrorEventWithAuthTextBecomesTheSameCard() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .error, payload: .object(["message": .string(signedOut)])))

        guard case .authError(_, let message) = r.state.items.first else {
            return XCTFail("expected an authError item, got \(String(describing: r.state.items.first))")
        }
        XCTAssertEqual(message, signedOut)
    }

    /// An error a re-send would reproduce: a transient provider failure (a 5xx) is a pause the server
    /// retries, drawn as the auto-retry card rather than as either of these.
    func testOrdinaryErrorsStayErrors() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .error, payload: .object([
            "message": .string("API Error: 400 prompt is too long")])))
        guard case .error = r.state.items.first else {
            return XCTFail("a non-auth error must not become a sign-in card")
        }
    }

    /// A session picked up again reports the identical failure seconds later. Two cards would mean
    /// two live copies of a sign-in there is only one of — two codes to read, two Cancels.
    func testIdenticalRepeatFoldsIntoTheCardAboveIt() {
        var r = TranscriptReducer()
        r.apply(RunEvent(seq: 1, type: .error, payload: .object(["message": .string(signedOut)])))
        r.apply(RunEvent(seq: 2, type: .error, payload: .object(["message": .string(signedOut)])))
        XCTAssertEqual(r.state.items.count, 1, "the repeat must fold into the card above it")

        // A *different* failure is news, and gets its own card.
        r.apply(RunEvent(seq: 3, type: .assistant, payload: .object(["text": .string(expired)])))
        XCTAssertEqual(r.state.items.count, 2)
    }

    // MARK: the relay's wire shape

    func testLoginStateDecodesAndTolerantOfAnUnknownStatus() throws {
        let awaiting = """
        {"status":"awaiting_code","engine":"claude","url":"https://claude.ai/oauth","userCode":null,"message":null}
        """
        let state = try JSONDecoder().decode(RunnerLoginState.self, from: Data(awaiting.utf8))
        XCTAssertEqual(state.status, .awaitingCode)
        XCTAssertEqual(state.engine, "claude")
        XCTAssertEqual(state.url, "https://claude.ai/oauth")
        XCTAssertTrue(state.status?.inFlight == true)

        let idle = try JSONDecoder().decode(RunnerLoginState.self, from: Data("{\"status\":null}".utf8))
        XCTAssertNil(idle.status)

        // A status this client doesn't know reads as "nothing in flight", never as a throw that
        // would take the whole card down.
        let future = try JSONDecoder().decode(RunnerLoginState.self,
                                              from: Data("{\"status\":\"reticulating\"}".utf8))
        XCTAssertNil(future.status)

        let done = try JSONDecoder().decode(RunnerLoginState.self, from: Data("{\"status\":\"done\"}".utf8))
        XCTAssertEqual(done.status, .done)
        XCTAssertFalse(done.status?.inFlight == true)
    }

    /// A fourth engine on a newer server must not fail the decode of the whole runner row.
    func testRunnerEnginesDecodeAndUnknownEngineIsHarmless() throws {
        let json = """
        {"id":"r1","name":"wikova","engines":[
          {"engine":"claude","installed":true,"version":"2.1.220","auth":"yes"},
          {"engine":"codex","installed":true,"auth":"no"},
          {"engine":"someday","installed":true,"auth":"unknown"}]}
        """
        let runner = try JSONDecoder().decode(Runner.self, from: Data(json.utf8))
        XCTAssertEqual(runner.engines?.count, 3)
        XCTAssertEqual(runner.engineHealth(.claude)?.signedIn, true)
        XCTAssertEqual(runner.engineHealth(.codex)?.signedIn, false)
        XCTAssertEqual(runner.engineHealth(.kimi), nil)
    }

    func testPersonalGeminiProviderDecodesItsEditorID() throws {
        let provider = try JSONDecoder().decode(ConfiguredProvider.self, from: Data(#"{"id":"provider-id","slug":"gemini-key","label":"Gemini","runtime":"antigravity","models":[],"presetSlug":"gemini"}"#.utf8))
        XCTAssertEqual(provider.providerID, "provider-id")
        XCTAssertEqual(provider.id, "gemini-key", "the picker still identifies a choice by slug")
    }

    func testInstallRelayRemainsBusyAfterTheRequestReturnsUntilTheRunnerSettlesIt() throws {
        for status in ["pending", "installing"] {
            for engine in ["antigravity", "kimi"] {
                let relay = try JSONDecoder().decode(RunnerInstallState.self,
                                                     from: Data("{\"status\":\"\(status)\",\"engine\":\"\(engine)\"}".utf8))
                XCTAssertTrue(relay.inFlight, "another engine's active install occupies the same runner relay")
            }
        }
        for status in ["done", "failed", "reticulating"] {
            let relay = try JSONDecoder().decode(RunnerInstallState.self,
                                                 from: Data("{\"status\":\"\(status)\"}".utf8))
            XCTAssertFalse(relay.inFlight)
        }
        XCTAssertFalse(try JSONDecoder().decode(RunnerInstallState.self,
                                                from: Data("{\"status\":null}".utf8)).inFlight)
    }
}
