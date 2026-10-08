import Foundation
import XCTest
@testable import OrbitKit

/// The wiki under server execution says the web's words on the native pages (design §2.2, mock 35, P9): Activity's
/// Runs — each run's row and each call's row of its log — the System model's five states, the settings page and
/// Set up while the server runs the account's wiki, and the plan's line under Draft plan (owner's call 2026-10-08).
///
/// Three halves, each a failure — never an `XCTSkip` — when its counterpart goes missing:
/// - the cases in `src/shared/src/wiki-server-execution.fixture.json`, which the web's `lib/wikiRuns.test.ts` reads too;
/// - every word looked up as a declaration in the web file it mirrors (`lib/wikiRuns.ts`, `lib/wikiReviewMode.ts`,
///   `lib/wikiHealth.ts`, `lib/wikiPlan.ts`);
/// - the read's limits and fields held to `contracts/wiki.contract.json` `jobs.read`, `jobs.executor.read` and
///   `systemModel.read`, and the models round-tripping every field the contract names.
final class WikiServerExecutionCopyParityTests: XCTestCase {

    private static let runsLib = "src/web/src/lib/wikiRuns.ts"
    private static let modeLib = "src/web/src/lib/wikiReviewMode.ts"
    private static let healthLib = "src/web/src/lib/wikiHealth.ts"
    private static let planLib = "src/web/src/lib/wikiPlan.ts"
    private static let fixturePath = "src/shared/src/wiki-server-execution.fixture.json"
    private static let contractPath = "contracts/wiki.contract.json"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The server's runs and settings are one half of a pair; if the "
                + "other half moved, move this check with it rather than deleting it."
        }
    }

    private func find(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    /// A web source with string concatenations joined and every run of whitespace as one space.
    private func web(_ relative: String) throws -> String {
        try String(contentsOf: find(relative), encoding: .utf8)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    // MARK: the fixture

    private struct Fixture: Decodable {
        struct Settings: Decodable {
            struct Field: Decodable {
                let label: String
                let note: String
            }
            struct Form: Decodable {
                let fields: [Field]
            }
            struct Model: Decodable {
                struct Status: Decodable {
                    let state: String
                    let model: String?
                }
                let status: Status
                let label: String
                let state: String
                let tone: String
            }
            let rows: [String]
            let form: Form
            let maintenanceNote: String
            let privacy: String
            let automaticNote: String
            let systemModel: String
            let models: [Model]
        }
        struct Runs: Decodable {
            struct Duration: Decodable {
                let seconds: Double
                let says: String
            }
            struct Case: Decodable {
                let name: String
                let job: WikiJob
                let kind: String
                let mark: String
                let tone: String
                let state: String
                let text: String
                let when: String
                let foot: String
            }
            struct Row: Decodable {
                let call: String
                let state: String
                let retries: String?
                let tone: String
                let waited: String
                let ran: String
                let tokens: String
                let line: String
                let error: String?
            }
            struct Call: Decodable {
                let name: String
                let call: WikiJobCall
                let row: Row
            }
            let title: String
            let none: String
            let kinds: [String: String]
            let callsTitle: String
            let columns: [String]
            let durations: [Duration]
            let cases: [Case]
            let calls: [Call]
        }
        /// The plan's line under Draft plan while the server drafts it (owner's call 2026-10-08, mock 35's Plan card).
        struct Plan: Decodable {
            let note: String
        }
        let now: String
        let settings: Settings
        let plan: Plan
        let runs: Runs
    }

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: find(Self.fixturePath)))
    }

    private func now(_ shared: Fixture) throws -> Date {
        try XCTUnwrap(RelativeTime.parse(shared.now), "the fixture's now is an instant")
    }

    /// Each run's row, as `WikiRunsLogic` says it, and the line under its call log.
    func testEveryRunSaysTheFixturesWords() throws {
        let shared = try fixture()
        let now = try now(shared)
        XCTAssertFalse(shared.runs.cases.isEmpty)
        for one in shared.runs.cases {
            let row = WikiRunsLogic.row(one.job, now: now)
            XCTAssertEqual(row.kind, one.kind, one.name)
            XCTAssertEqual(row.mark.rawValue, one.mark, "\(one.name): mark")
            XCTAssertEqual(row.tone.rawValue, one.tone, "\(one.name): tone")
            XCTAssertEqual(row.state, one.state, "\(one.name): state")
            XCTAssertEqual(row.text, one.text, "\(one.name): text")
            XCTAssertEqual(row.when, one.when, "\(one.name): when")
            XCTAssertEqual(WikiRunsLogic.foot(one.job), one.foot, "\(one.name): foot")
        }
        // Every state a run can be in is a case, and every kind has its word.
        XCTAssertEqual(Set(shared.runs.cases.map(\.job.state)), Set(WikiJobState.contractOrder))
        for kind in WikiJobKind.contractOrder {
            XCTAssertEqual(WikiRunsCopy.kind(kind), shared.runs.kinds[kind.rawValue], kind.rawValue)
        }
        XCTAssertEqual(Set(shared.runs.kinds.keys), Set(WikiJobKind.contractOrder.map(\.rawValue)))
        XCTAssertEqual(WikiRunsCopy.runs, shared.runs.title)
        XCTAssertEqual(WikiRunsCopy.none, shared.runs.none)
        XCTAssertFalse(WikiRunsLogic.shown(serverExecutes: false, jobs: []))
        XCTAssertTrue(WikiRunsLogic.shown(serverExecutes: true, jobs: []))
        XCTAssertTrue(WikiRunsLogic.shown(serverExecutes: false, jobs: [shared.runs.cases[0].job]))
    }

    /// Each call's row of a run's log, as `WikiRunsLogic.callRow` says it.
    func testEveryCallSaysTheFixturesWords() throws {
        let shared = try fixture()
        let now = try now(shared)
        XCTAssertFalse(shared.runs.calls.isEmpty)
        for one in shared.runs.calls {
            let row = WikiRunsLogic.callRow(one.call, now: now)
            XCTAssertEqual(row.call, one.row.call, one.name)
            XCTAssertEqual(row.state, one.row.state, "\(one.name): state")
            XCTAssertEqual(row.retries, one.row.retries, "\(one.name): retries")
            XCTAssertEqual(row.tone.rawValue, one.row.tone, "\(one.name): tone")
            XCTAssertEqual(row.waited, one.row.waited, "\(one.name): waited")
            XCTAssertEqual(row.ran, one.row.ran, "\(one.name): ran")
            XCTAssertEqual(row.tokens, one.row.tokens, "\(one.name): tokens")
            XCTAssertEqual(row.line, one.row.line, "\(one.name): line")
            XCTAssertEqual(row.error, one.row.error, "\(one.name): error")
        }
        XCTAssertEqual([WikiRunsCopy.call, WikiRunsCopy.callState, WikiRunsCopy.callWaited, WikiRunsCopy.callRan, WikiRunsCopy.callTokens],
                       shared.runs.columns)
        XCTAssertEqual(WikiRunsCopy.callsTitle, shared.runs.callsTitle, "the log's name, the section a run's page lists its calls under")
        for one in shared.runs.durations {
            XCTAssertEqual(WikiRunsLogic.duration(one.seconds), one.says, "\(one.seconds) s")
        }
    }

    /// The System model's states and name, and the settings page's server words.
    func testTheModelAndTheSettingsSayTheFixturesWords() throws {
        let shared = try fixture()
        XCTAssertEqual(shared.settings.models.map(\.status.state), WikiSystemModelState.contractOrder.map(\.rawValue))
        for one in shared.settings.models {
            let state = try XCTUnwrap(WikiSystemModelState(rawValue: one.status.state))
            XCTAssertEqual(WikiRunsCopy.systemModelLabel(one.status.model), one.label, one.status.state)
            XCTAssertEqual(WikiRunsCopy.modelState(state), one.state, one.status.state)
            XCTAssertEqual(WikiRunsLogic.modelTone(state).rawValue, one.tone, one.status.state)
        }
        XCTAssertEqual(WikiRunsCopy.systemModel, shared.settings.systemModel)
        let settings = shared.settings
        XCTAssertEqual([WikiModeCopy.status, WikiModeCopy.repoFrom, WikiModeCopy.model, WikiModeCopy.dailyLimit, WikiModeCopy.lookback],
                       settings.rows)
        XCTAssertEqual([WikiModeCopy.repoFrom, WikiModeCopy.model, WikiModeCopy.dailyLimit, WikiModeCopy.lookback],
                       settings.form.fields.map(\.label))
        XCTAssertEqual([WikiModeCopy.repoFromNote, WikiModeCopy.modelNote, WikiModeCopy.dailyLimitNote, WikiModeCopy.lookbackNote],
                       settings.form.fields.map(\.note))
        XCTAssertEqual(WikiModeCopy.maintenanceNoteServer, settings.maintenanceNote)
        XCTAssertEqual(WikiModeCopy.privacyNote, settings.privacy)
        XCTAssertEqual(WikiModeCopy.modeNote(.automatic, server: true), settings.automaticNote)
        // Under runner every mode says what it always said; the server changes Automatic's sentence alone.
        for mode in WikiModeLogic.modes {
            XCTAssertEqual(WikiModeCopy.modeNote(mode, server: false), WikiModeCopy.modeNote(mode))
        }
        XCTAssertEqual(WikiModeCopy.modeNote(.tiered, server: true), WikiModeCopy.modeNote(.tiered))
    }

    /// The plan's line under Draft plan: the System model's while the server drafts it, and the runner's own
    /// word for word when it does not — the same line the web's Plan card and empty plan draw.
    func testThePlanSaysTheFixturesLineUnderDraftPlan() throws {
        let shared = try fixture()
        XCTAssertEqual(WikiPlanCopy.noteServer, shared.plan.note)
        XCTAssertEqual(WikiPlanCopy.emptyNote(where: "orbit · wikova", provider: "local-vllm", serverExecutes: true), shared.plan.note)
        XCTAssertEqual(WikiPlanCopy.emptyNote(where: nil, provider: nil, serverExecutes: true), shared.plan.note)
        // Under runner nothing moved: the provider, the place and the usual hours, as `wiki-docs.fixture.json` holds.
        XCTAssertEqual(WikiPlanCopy.emptyNote(where: "orbit · wikova", provider: "local-vllm", serverExecutes: false),
                       "Runs as a task in the Wiki maintenance list, on orbit · wikova with local-vllm — usually 1–2 hours."
                           + " Until you confirm a plan, the Wiki shows its topic articles.")
        // The web says the same line, from the same fixture: the constant, the card's choice and the empty page's.
        let lib = try web(Self.planLib)
        assertDeclared(lib, Self.planLib, [("WIKI_PLAN_NOTE_SERVER", WikiPlanCopy.noteServer)])
        XCTAssertTrue(lib.contains("context.serverExecutes ? WIKI_PLAN_NOTE_SERVER : `${context.provider ?? WIKI_HISTORY_MAINTENANCE} · about 1–2 hours`"),
                      "the web's Plan card no longer takes the server's line under server execution")
        XCTAssertTrue(lib.contains("if (serverExecutes) return WIKI_PLAN_NOTE_SERVER;"),
                      "the web's empty plan no longer takes the server's line under server execution")
    }

    // MARK: the web's declarations

    private func assertDeclared(_ source: String, _ file: String, _ constants: [(String, String)], line: UInt = #line) {
        for (name, value) in constants {
            XCTAssertTrue(source.contains("export const \(name) = '\(value)';"),
                          "\(name) drifted: \(file) no longer declares it as \(value.debugDescription)", line: line)
        }
    }

    /// Every word the Runs band and a run's page say is the web's own declaration, in `lib/wikiRuns.ts`.
    func testEveryRunsWordIsTheWebsDeclaration() throws {
        let lib = try web(Self.runsLib)
        assertDeclared(lib, Self.runsLib, [
            ("WIKI_RUNS", WikiRunsCopy.runs),
            ("WIKI_RUN_QUEUED", WikiRunsCopy.queued),
            ("WIKI_RUN_RUNNING", WikiRunsCopy.running),
            ("WIKI_RUN_WAITING_RUNNER", WikiRunsCopy.waitingRunner),
            ("WIKI_RUN_WAITING_MODEL", WikiRunsCopy.waitingModel),
            ("WIKI_RUN_DONE", WikiRunsCopy.done),
            ("WIKI_RUN_FAILED", WikiRunsCopy.failed),
            ("WIKI_RUN_CANCELLED", WikiRunsCopy.cancelled),
            ("WIKI_RUN_NEXT_IN_LINE", WikiRunsCopy.nextInLine),
            ("WIKI_RUN_STARTING", WikiRunsCopy.starting),
            ("WIKI_RUN_NO_RESULT", WikiRunsCopy.noResult),
            ("WIKI_CALLS", WikiRunsCopy.callsTitle),
            ("WIKI_CALL", WikiRunsCopy.call),
            ("WIKI_CALL_STATE", WikiRunsCopy.callState),
            ("WIKI_CALL_WAITED", WikiRunsCopy.callWaited),
            ("WIKI_CALL_RAN", WikiRunsCopy.callRan),
            ("WIKI_CALL_TOKENS", WikiRunsCopy.callTokens),
            ("WIKI_CALL_QUEUED", WikiRunsCopy.callQueued),
            ("WIKI_CALL_RUNNING", WikiRunsCopy.callRunning),
            ("WIKI_CALL_DONE", WikiRunsCopy.callDone),
            ("WIKI_CALL_FAILED", WikiRunsCopy.callFailed),
            ("WIKI_CALL_CANCELLED", WikiRunsCopy.callCancelled),
            ("WIKI_NO_VALUE", WikiRunsCopy.noValue),
            ("WIKI_RUN_SO_FAR", WikiRunsCopy.soFar),
            ("WIKI_RUNS_NONE", WikiRunsCopy.none),
            ("WIKI_SYSTEM_MODEL", WikiRunsCopy.systemModel),
        ])
        // The kinds and the model's states, each the web's map entry.
        for kind in WikiJobKind.contractOrder {
            XCTAssertTrue(lib.contains("\(kind.rawValue): '\(WikiRunsCopy.kind(kind))',"), "the kind \(kind.rawValue) drifted in \(Self.runsLib)")
        }
        for state in WikiSystemModelState.contractOrder {
            XCTAssertTrue(lib.contains("\(state.rawValue): '\(WikiRunsCopy.modelState(state))',"), "the state \(state.rawValue) drifted in \(Self.runsLib)")
        }
        // The templates, each the web's arrow with its argument where Swift interpolates it.
        let templates: [(String, String)] = [
            ("wikiRunsAhead", "(count: number): string => (count === 1 ? '1 run ahead' : `${count} runs ahead`)"),
            ("wikiWaited", "(duration: string): string => `waited ${duration}`"),
            ("wikiRetryingIn", "(duration: string): string => `retrying in ${duration}`"),
            ("wikiCallsEnded", "(ended: number, total: number): string => `${ended} of ${total} calls ended`"),
            ("wikiNextCall", "(ahead: number, duration: string): string => ahead === 0 ? `next call first in line, waited ${duration}` : `next call ${ahead} ahead, waited ${duration}`"),
            ("wikiCalls", "(count: number): string => (count === 1 ? '1 call' : `${wikiCount(count)} calls`)"),
            ("wikiTokens", "(count: number): string => `${wikiCount(count)} tokens`"),
            ("wikiTook", "(duration: string): string => `took ${duration}`"),
            ("wikiStarted", "(ago: string): string => `started ${ago}`"),
            ("wikiCallAhead", "(ahead: number): string => (ahead === 0 ? 'Queued · next' : `Queued · ${ahead} ahead`)"),
            ("wikiRetries", "(count: number): string => (count === 1 ? '1 retry' : `${count} retries`)"),
            ("wikiCallTokens", "(input: number, output: number): string => `${wikiCount(input)} → ${wikiCount(output)}`"),
            ("wikiRan", "(duration: string): string => `ran ${duration}`"),
            ("wikiRunFoot", "(calls: number, input: number, output: number): string => `${wikiCalls(calls)} · ${wikiCount(input)} tokens in, ${wikiCount(output)} out`"),
            ("wikiShowingLast", "(shown: number): string => `showing the last ${shown}`"),
        ]
        for (name, arrow) in templates {
            XCTAssertTrue(lib.contains("export const \(name) = \(arrow);"), "\(name) drifted in \(Self.runsLib)")
        }
        XCTAssertEqual(WikiRunsCopy.runsAhead(1), "1 run ahead")
        XCTAssertEqual(WikiRunsCopy.runsAhead(3), "3 runs ahead")
        XCTAssertEqual(WikiRunsCopy.waited("{}"), "waited {}")
        XCTAssertEqual(WikiRunsCopy.retryingIn("{}"), "retrying in {}")
        XCTAssertEqual(WikiRunsCopy.callsEnded(3, of: 7), "3 of 7 calls ended")
        XCTAssertEqual(WikiRunsCopy.nextCall(0, waited: "{}"), "next call first in line, waited {}")
        XCTAssertEqual(WikiRunsCopy.nextCall(2, waited: "{}"), "next call 2 ahead, waited {}")
        XCTAssertEqual(WikiRunsCopy.calls(1), "1 call")
        XCTAssertEqual(WikiRunsCopy.calls(1_234), "1,234 calls")
        XCTAssertEqual(WikiRunsCopy.tokens(52_310), "52,310 tokens")
        XCTAssertEqual(WikiRunsCopy.took("{}"), "took {}")
        XCTAssertEqual(WikiRunsCopy.started("{}"), "started {}")
        XCTAssertEqual(WikiRunsCopy.callAhead(0), "Queued · next")
        XCTAssertEqual(WikiRunsCopy.callAhead(2), "Queued · 2 ahead")
        XCTAssertEqual(WikiRunsCopy.retries(1), "1 retry")
        XCTAssertEqual(WikiRunsCopy.retries(2), "2 retries")
        XCTAssertEqual(WikiRunsCopy.callTokens(1_204, 296), "1,204 → 296")
        XCTAssertEqual(WikiRunsCopy.ran("{}"), "ran {}")
        XCTAssertEqual(WikiRunsCopy.foot(7, input: 2_592, output: 607), "7 calls · 2,592 tokens in, 607 out")
        XCTAssertEqual(WikiRunsCopy.showingLast(40), "showing the last 40")
        XCTAssertTrue(lib.contains("model ? `${WIKI_SYSTEM_MODEL} · ${model}` : WIKI_SYSTEM_MODEL"), "the model's label drifted")
    }

    /// The settings page's server words are the web's, in `lib/wikiReviewMode.ts`; the status line's reasons are the
    /// web's, in `lib/wikiHealth.ts`.
    func testTheSettingsWordsAndTheReasonsAreTheWebsDeclarations() throws {
        let mode = try web(Self.modeLib)
        assertDeclared(mode, Self.modeLib, [
            ("WIKI_REPO_FROM", WikiModeCopy.repoFrom),
            ("WIKI_REPO_FROM_NOTE", WikiModeCopy.repoFromNote),
            ("WIKI_MODEL", WikiModeCopy.model),
            ("WIKI_MODEL_NOTE", WikiModeCopy.modelNote),
        ])
        for (name, value) in [("WIKI_MAINTENANCE_NOTE_SERVER", WikiModeCopy.maintenanceNoteServer),
                              ("WIKI_PRIVACY_NOTE", WikiModeCopy.privacyNote),
                              ("WIKI_MODE_NOTE_AUTOMATIC_SERVER", WikiModeCopy.modeNoteAutomaticServer)] {
            XCTAssertTrue(mode.contains("export const \(name) = '\(value)';"), "\(name) drifted in \(Self.modeLib)")
        }
        XCTAssertTrue(mode.contains("server && mode === 'automatic' ? WIKI_MODE_NOTE_AUTOMATIC_SERVER : WIKI_MODE_NOTES[mode]"),
                      "wikiModeNote changes Automatic's sentence alone")
        let health = try web(Self.healthLib)
        assertDeclared(health, Self.healthLib, [
            ("WIKI_REASON_WORKER", WikiHealthCopy.reasonWorker),
            ("WIKI_REASON_UNCONFIGURED", WikiHealthCopy.reasonUnconfigured),
            ("WIKI_REASON_KEY_REFUSED", WikiHealthCopy.reasonKeyRefused),
            ("WIKI_REASON_UNREACHABLE", WikiHealthCopy.reasonUnreachable),
            ("WIKI_REASON_RUNNER_OFFLINE", WikiHealthCopy.reasonRunnerOffline),
            ("WIKI_REASON_RUNNER_UPGRADE", WikiHealthCopy.reasonRunnerUpgrade),
        ])
        // The order the reasons win in is the web's too.
        let reasons = try XCTUnwrap(health.range(of: "export function wikiServerReason(")).lowerBound
        let body = String(health[reasons...].prefix(1_600))
        let order = ["WIKI_REASON_WORKER", "WIKI_REASON_UNCONFIGURED", "WIKI_REASON_KEY_REFUSED", "WIKI_REASON_UNREACHABLE",
                     "WIKI_REASON_RUNNER_OFFLINE", "WIKI_REASON_RUNNER_UPGRADE"].map { body.range(of: "reason(\($0)")?.lowerBound }
        XCTAssertFalse(order.contains(nil), "wikiServerReason lost one of its reasons")
        let found = order.compactMap { $0 }
        XCTAssertEqual(found, found.sorted(), "wikiServerReason no longer says the reasons in their order")
        XCTAssertTrue(body.contains("if (!repo || !(health.maintenance.enabled || repo.pending > 0)) return null;"),
                      "the runner's reasons are said while maintenance is on or a read waits")
    }

    // MARK: the contract

    private func contract() throws -> [String: Any] {
        let data = try Data(contentsOf: find(Self.contractPath))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// The read's route, limits and fields are the contract's, and every field round-trips through the models.
    func testTheReadsAreTheContracts() throws {
        let jobs = try XCTUnwrap(try contract()["jobs"] as? [String: Any])
        let read = try XCTUnwrap(jobs["read"] as? [String: Any], "contract has no jobs.read")
        XCTAssertEqual(read["route"] as? String, "GET /api/wiki/spaces/:id/jobs")
        let limits = try XCTUnwrap(read["limits"] as? [String: Any])
        XCTAssertEqual(limits["jobs"] as? Int, WikiJobsReadLimits.jobs)
        XCTAssertEqual(limits["callsPerJob"] as? Int, WikiJobsReadLimits.callsPerJob)
        XCTAssertEqual(jobs["kinds"] as? [String], WikiJobKind.contractOrder.map(\.rawValue))
        XCTAssertEqual(jobs["states"] as? [String], WikiJobState.contractOrder.map(\.rawValue))
        let job = WikiJob(id: "j", kind: .verify, state: .running, waitingFor: "repo", priority: 1, attempts: 2,
                          createdAt: "a", updatedAt: "b", startedAt: "c", endedAt: "d", nextAttemptAt: "e", failureKind: "infra",
                          error: "f", ahead: 3, progress: WikiJobProgress(step: "reading", done: 1, total: 2),
                          calls: WikiJobCallCounts(total: 1), nextCall: WikiJob.NextCall(ahead: 0, enqueuedAt: "g"),
                          requests: [WikiJobCall(id: "r", step: "verify", unit: "u", attempt: 1, attempts: 1, state: .queued,
                                                 enqueuedAt: "h", startedAt: "i", endedAt: "k", inputTokens: 1, outputTokens: 2,
                                                 httpStatus: 503, error: "l", errorKind: "retryable", ahead: 4)])
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(job)) as? [String: Any])
        XCTAssertEqual(Set(encoded.keys), Set(try XCTUnwrap(read["job"] as? [String])))
        let call = try XCTUnwrap((encoded["requests"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(call.keys), Set(try XCTUnwrap(read["request"] as? [String])))
        XCTAssertEqual(try JSONDecoder().decode(WikiJob.self, from: JSONEncoder().encode(job)), job)
        // The executor's read: the mode and whether the server runs this account's wiki.
        let executor = try XCTUnwrap((jobs["executor"] as? [String: Any])?["read"] as? [String: Any])
        let view = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(WikiExecutorView(mode: .canary, serverExecutes: true))) as? [String: Any])
        XCTAssertEqual(Set(view.keys), Set(try XCTUnwrap(executor["fields"] as? [String])))
        XCTAssertEqual(WikiExecutorMode.allCases.filter { $0 != .unknown }.map(\.rawValue), (jobs["executor"] as? [String: Any])?["modes"] as? [String])
        // The System model's read: its states, and its fields with the executor beside them.
        let model = try XCTUnwrap((try contract()["systemModel"] as? [String: Any])?["read"] as? [String: Any])
        XCTAssertEqual(model["states"] as? [String], WikiSystemModelState.contractOrder.map(\.rawValue))
        let status = WikiSystemModelStatus(state: .up, model: "m", since: "a", checkedAt: "b", workerSeenAt: "c",
                                           executor: WikiExecutorView(mode: .server, serverExecutes: true))
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as? [String: Any])
        XCTAssertEqual(Set(fields.keys), Set(try XCTUnwrap(model["fields"] as? [String])))
        // A read one release apart: an older control plane sends no executor and no new fields, which read as runner.
        let older = try JSONDecoder().decode(WikiSpaceHealth.self, from: Data(#"{"spaceId":"s","entries":3,"maintenance":{"look":"ok","enabled":true}}"#.utf8))
        XCTAssertFalse(older.serverExecutes)
        XCTAssertNil(older.systemModel)
        XCTAssertNil(WikiHealthLogic.serverReason(older))
        let unknown = try JSONDecoder().decode(WikiJob.self, from: Data(#"{"id":"j","kind":"later","state":"paused","createdAt":"a"}"#.utf8))
        XCTAssertEqual([unknown.kind, unknown.state] as [AnyHashable], [WikiJobKind.unknown, WikiJobState.unknown] as [AnyHashable])
        XCTAssertEqual(unknown.calls, WikiJobCallCounts())
    }
}
