import Foundation
import OrbitKit

/// Manages the local runner this Mac may host — the native-only half. Reads ~/.orbit/config.json
/// and runner.log, drives `launchctl` via `Process`, and can enroll this Mac in one app (device
/// flow + self-approve, since we're already signed in as the user). All parsing/path logic is in
/// OrbitKit and unit-tested; this is the IO/Process glue (macOS-only, hence Developer-ID, not MAS).
@MainActor
@Observable
final class RunnerControl {
    private(set) var config: RunnerConfig?
    private(set) var status: ServiceStatus = .notLoaded
    private(set) var serverRunner: Runner?
    private(set) var logLines: [String] = []

    var enrolling = false
    var enrollUserCode: String?
    var message: String?

    private let paths: RunnerPaths
    private let uid: Int
    private let api: APIClient
    private let baseURL: URL

    init(baseURL: URL, tokenStore: TokenStore) {
        self.baseURL = baseURL
        self.api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        self.paths = RunnerEnvironment.paths(environment: ProcessInfo.processInfo.environment,
                                             userHome: NSHomeDirectory())
        self.uid = Int(getuid())
        // Read the local config up front (a tiny file read) so `hasLocalRunner` is correct on the
        // first render — the tray shows the runner's name immediately and the manager doesn't flash
        // its enroll screen before the async `refresh()` lands.
        self.config = RunnerEnvironment.readConfig(at: paths)
    }

    var hasLocalRunner: Bool { config != nil }

    /// Re-read config + log, query the service state, and (if enrolled) the server-side record.
    func refresh() async {
        config = RunnerEnvironment.readConfig(at: paths)
        logLines = RunnerEnvironment.readLogTail(at: paths, lines: 200)
        let result = await Self.launchctl(Launchctl.list())
        status = Launchctl.parseList(result.output)
        if let id = config?.runnerId {
            serverRunner = try? await api.runner(id)
        }
    }

    func start() async {
        _ = await Self.launchctl(Launchctl.bootstrap(uid: uid, plistPath: paths.plistFile.path))
        await refresh()
    }

    func stop() async {
        _ = await Self.launchctl(Launchctl.bootout(uid: uid, plistPath: paths.plistFile.path))
        await refresh()
    }

    func restart() async {
        _ = await Self.launchctl(Launchctl.kickstartRestart(uid: uid))
        await refresh()
    }

    /// One-app enrollment: start the device flow, self-approve (we're the signed-in user), poll
    /// for the credential, and write config.json. The launchd *service* (binary + plist) is still
    /// installed by `orbit register` / install.sh — this gets the credential and seeds config.
    func enroll(name: String) async {
        enrolling = true
        defer { enrolling = false; enrollUserCode = nil }
        do {
            let start = try await api.deviceStart(
                DeviceStartRequest(name: name, hostname: name, maxConcurrent: 4, version: "macos-client"))
            enrollUserCode = start.userCode
            try await api.approveDevice(userCode: start.userCode)

            let interval = max(1, start.interval)
            let rounds = max(1, start.expiresIn / interval)
            for _ in 0..<rounds {
                try await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000_000)
                let poll = try await api.devicePoll(deviceCode: start.deviceCode)
                switch poll.deviceStatus {
                case .approved:
                    guard let rid = poll.runnerId, let token = poll.runnerToken else { continue }
                    let cfg = RunnerConfig(serverUrl: baseURL.absoluteString, runnerId: rid,
                                           runnerToken: token, name: poll.name ?? name,
                                           labels: nil, maxConcurrent: 4, workDir: nil)
                    try writeConfig(cfg)
                    config = cfg
                    message = "Enrolled. Install the runner service to start it (orbit register / install.sh)."
                    return
                case .expired:
                    message = "Enrollment expired — try again."
                    return
                case .pending, .none:
                    continue
                }
            }
            message = "Enrollment timed out."
        } catch {
            message = "Enrollment failed — \(error)"
        }
    }

    private func writeConfig(_ cfg: RunnerConfig) throws {
        try FileManager.default.createDirectory(at: paths.home, withIntermediateDirectories: true)
        try JSONEncoder().encode(cfg).write(to: paths.configFile)
    }

    /// Run `/bin/launchctl` off the main actor; returns (exit code, combined output).
    nonisolated private static func launchctl(_ args: [String]) async -> (status: Int32, output: String) {
        await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            do { try process.run() } catch { return (Int32(-1), "") }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
        }.value
    }
}
