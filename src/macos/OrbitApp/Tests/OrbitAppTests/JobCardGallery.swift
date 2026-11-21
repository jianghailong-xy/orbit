import SwiftUI
import OrbitKit
#if canImport(OrbitApp)
@testable import OrbitApp
#endif

/// The real `JobCardView` in each state the owner's job-card board draws (file 350t1lTONlrPMjilBdXx7,
/// part ②, under rulings R1-R4), fed made-up jobs through the same `JobCardHost` a console hands it.
/// `JobCardShotsTests` photographs it on the Mac; the iPhone probe (docs/evidence/bg-job-card-apple)
/// compiles this same file into the app and photographs it on an iPhone simulator.
struct JobCardGallery: View {
    enum Page { case folded, opened, tray }
    let page: Page

    var body: some View {
        let fixtures = JobCardFixtures(now: Date())
        VStack(alignment: .leading, spacing: 14) {
            switch page {
            case .folded:
                ForEach(fixtures.folded, id: \.label) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                        JobCardView(card: item.card)
                    }
                }
            case .opened:
                Text("OPENED").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                JobCardView(card: fixtures.opened, startsOpen: true)
            case .tray:
                // The Background row (R1): a failed job counted in red; opened, each job's row, Stop on the
                // running one behind its confirmation (R3).
                Text("BACKGROUND").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                BackgroundTrayView(procs: fixtures.trayProcs,
                                   row: BackgroundRowRule.row(fixtures.trayProcs, items: [], sessionLive: true),
                                   revealJob: { _ in false }, stopJob: { _ in })
            }
        }
        .environment(\.jobCardHost, fixtures.host)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct JobCardFixtures {
    struct Item {
        let label: String
        let card: ToolCard
    }

    let folded: [Item]
    let opened: ToolCard
    let host: JobCardHost
    /// The Background list: a failed job, a running one its runner can stop, one that finished.
    let trayProcs: [BackgroundProc]

    init(now: Date) {
        let iso = ISO8601DateFormatter()
        func at(_ secondsAgo: TimeInterval) -> String { iso.string(from: now.addingTimeInterval(-secondsAgo)) }

        var procs: [String: BackgroundProc] = [:]
        var wakes: [String: [BgJobCard.WakeSeen]] = [:]
        var tails: [String: BackgroundJobTail] = [:]
        var dontSend: [String: @MainActor () -> Void] = [:]

        func card(_ id: String, _ description: String, _ command: String, kind: String, startedAgo: TimeInterval) -> ToolCard {
            let input: JSONValue = .object(["command": .string(command), "description": .string(description),
                                            "kind": .string(kind)])
            let receipt = "{\"jobId\":\"\(id)\",\"status\":\"running\",\"startedAt\":\"\(at(startedAgo))\"}"
            return ToolCard(id: "toolu_\(id)", name: BgJobCard.toolName, input: input, result: receipt, status: .ok)
        }
        func proc(_ id: String, _ status: String, startedAgo: TimeInterval, endedAgo: TimeInterval? = nil,
                  exitCode: Int? = nil, reason: String? = nil, output: String = "") {
            procs[id] = BackgroundProc(id: id, command: nil, description: nil, status: status, outputTail: output,
                                       startedAt: at(startedAgo), kind: "job", taskId: id,
                                       endedAt: endedAgo.map(at), reason: reason, exitCode: exitCode,
                                       stoppable: status == "running" ? true : nil)
        }
        func wake(_ id: String, kind: String, command: String, description: String, trigger: String, tail: [String],
                  stall: Bool = false, ago: TimeInterval, read: Bool = true) {
            let tag = stall ? "background-job-stall" : "background-job-wake"
            let block = (["<\(tag)>",
                          "  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:",
                          "    \(id)｜\(kind)｜\(command)｜\(description)"]
                         + (stall ? ["      gone quiet｜still running｜running for 22m 0s when this was sent",
                                     "      no new output for 10m 0s"] : ["      \(trigger)"])
                         + ["      output /root/.orbit/runs/4f50733a/\(id).output｜this covers bytes 0–900",
                            "      output tail:"]
                         + tail.map { "        \($0)" }
                         + ["  The control plane recorded this for you; the user did not say it.", "</\(tag)>"])
                .joined(separator: "\n")
            guard let job = BackgroundWakeText.parse(block)?.jobs.first else { return }
            wakes[id, default: []].append(BgJobCard.WakeSeen(job: job, text: block, ts: at(ago), readAt: read ? at(ago - 2) : nil))
        }

        // RUNNING: a spinner and the newest line, read live from the tail route (R2).
        let running = card("bgj_running01", "Full web test suite", "npm test --workspace src/web", kind: "job", startedAgo: 190)
        proc("bgj_running01", "running", startedAgo: 190)
        tails["bgj_running01"] = BackgroundJobTail(jobId: "bgj_running01", status: "running", exitCode: nil,
                                                   lines: ["✓ src/lib/bgJobCard.test.ts (21 tests) 0.4s",
                                                           "✓ src/components/Transcript.test.tsx (412 tests) 9.8s"])
        // EXIT 0: a check, its last two lines grey.
        let done = card("bgj_done00001", "Full web test suite", "npm test --workspace src/web", kind: "job", startedAgo: 600)
        proc("bgj_done00001", "completed", startedAgo: 600, endedAgo: 600 - 242, exitCode: 0,
             output: "Test Files  641 passed (641)\n     Tests  8723 passed (8723)\n")
        // EXIT N: a red chip, a cross, its last two lines red.
        let failed = card("bgj_failed001", "Build apiserver image", "docker build -t apiserver .", kind: "job", startedAgo: 900)
        proc("bgj_failed001", "failed", startedAgo: 900, endedAgo: 900 - 70, exitCode: 1,
             output: "npm error network ECONNRESET\nERROR: process \"/bin/sh -c npm ci\" did not complete: exit code 1\n")
        // QUIET: an amber chip, still running.
        let quiet = card("bgj_quiet0001", "Deploy 5dd308afd", "./deploy.sh 5dd308afd", kind: "job", startedAgo: 22 * 60)
        proc("bgj_quiet0001", "running", startedAgo: 22 * 60)
        wake("bgj_quiet0001", kind: "job", command: "./deploy.sh 5dd308afd", description: "Deploy 5dd308afd", trigger: "",
             tail: ["Waiting for apiserver-next to pass its health check…"], stall: true, ago: 60)
        tails["bgj_quiet0001"] = BackgroundJobTail(jobId: "bgj_quiet0001", status: "running", exitCode: nil,
                                                   lines: ["Waiting for apiserver-next to pass its health check…"])
        // KILLED: grey, and who stopped it (R3).
        let killed = card("bgj_killed001", "Android unit tests", "./gradlew :app:testDebugUnitTest", kind: "job", startedAgo: 1200)
        proc("bgj_killed001", "killed", startedAgo: 1200, endedAgo: 1200 - 360, reason: "stopped_by_owner")
        // SERVICE: never ends.
        let service = card("bgj_service01", "npm run dev", "npm run dev", kind: "service", startedAgo: 40 * 60)
        tails["bgj_service01"] = BackgroundJobTail(jobId: "bgj_service01", status: "running", exitCode: nil,
                                                   lines: ["  ➜  Local:   http://localhost:5173/"])
        // NEW OUTPUT: still running, the tail refreshed, no chip.
        let output = card("bgj_output001", "Watch PR #212 checks", "gh pr checks 212 --watch", kind: "watch", startedAgo: 8 * 60)
        proc("bgj_output001", "running", startedAgo: 8 * 60)
        wake("bgj_output001", kind: "watch", command: "gh pr checks 212 --watch", description: "Watch PR #212 checks",
             trigger: "new output｜running", tail: ["check \"Swift\" → success (3 of 6 done)"], ago: 30)
        // ENDED, NOT YET READ: Waiting for the agent to read it · Don't send (E1).
        let ci = "gh run watch 19632123456 --exit-status --interval 30"
        let unread = card("bgj_unread001", "Wait for CI JavaScript job on 4c8f5a8a1b", ci, kind: "watch", startedAgo: 800)
        wake("bgj_unread001", kind: "watch", command: ci, description: "Wait for CI JavaScript job on 4c8f5a8a1b",
             trigger: "ended｜failed｜exit code 1", tail: ["X JavaScript in 11m58s — cancelled",
                                                          "run ended before JavaScript finished: completed cancelled"],
             ago: 800 - 760, read: false)
        dontSend["bgj_unread001"] = {}
        // OPENED: the command, where it ran, the last 40 of 214 lines, and the one time it woke the agent.
        let opened = card("bgj_9f3a2c1d0e", "Wait for CI JavaScript job on 4c8f5a8a1b", ci, kind: "watch", startedAgo: 1800)
        let lines = ["Refreshing run status every 30 seconds."]
            + (1...209).map { "  waiting · \($0 * 30)s" }
            + ["✓ Swift in 6m12s", "✓ Android in 9m40s", "X JavaScript in 11m58s — cancelled",
               "run ended before JavaScript finished: completed cancelled"]
        wake("bgj_9f3a2c1d0e", kind: "watch", command: ci, description: "Wait for CI JavaScript job on 4c8f5a8a1b",
             trigger: "ended｜failed｜exit code 1", tail: lines, ago: 1800 - 760)

        folded = [
            Item(label: "RUNNING", card: running),
            Item(label: "EXIT 0", card: done),
            Item(label: "EXIT ≠ 0", card: failed),
            Item(label: "QUIET", card: quiet),
            Item(label: "KILLED", card: killed),
            Item(label: "SERVICE", card: service),
            Item(label: "NEW OUTPUT", card: output),
            Item(label: "ENDED, NOT YET READ", card: unread),
        ]
        self.opened = opened
        trayProcs = [
            BackgroundProc(id: "bgj_tray_done", command: "npm test --workspace src/web", description: "Full web test suite",
                           status: "completed", outputTail: "", startedAt: at(900), kind: "job", taskId: "bgj_tray_done",
                           endedAt: at(600), exitCode: 0),
            BackgroundProc(id: "bgj_tray_fail", command: "docker build -t apiserver .", description: "Build apiserver image",
                           status: "failed", outputTail: "", startedAt: at(500), kind: "job", taskId: "bgj_tray_fail",
                           endedAt: at(430), exitCode: 1),
            BackgroundProc(id: "bgj_tray_run", command: "./deploy.sh 5dd308afd", description: "Deploy 5dd308afd",
                           status: "running", outputTail: "", startedAt: at(300), kind: "job", taskId: "bgj_tray_run",
                           stoppable: true),
        ]
        let tailsByJob = tails
        host = JobCardHost(procs: procs, wakes: wakes, dontSend: dontSend, live: true, place: "workstation",
                           tail: { id in
                               guard let tail = tailsByJob[id] else { throw APIError.http(status: 409, body: nil) }
                               return tail
                           },
                           stop: { _ in })
    }
}
