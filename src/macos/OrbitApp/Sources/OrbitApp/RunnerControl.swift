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
    /// An install (download → verify → unpack → LaunchAgent) is under way.
    private(set) var installing = false
    /// Why the last install put nothing in place, said for the runner manager's Try Again row.
    private(set) var installError: String?

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

    /// Whether the LaunchAgent plist is on disk. Distinct from `status.running`: an installed but
    /// stopped service still counts as installed (so the UI shows Start, not "Install service").
    var serviceInstalled: Bool { FileManager.default.fileExists(atPath: paths.plistFile.path) }

    /// Where launchd has the agent on disk: its plist says (`LaunchdPlist.domain`).
    private var domain: String {
        LaunchdPlist.domain(installed: try? String(contentsOf: paths.plistFile, encoding: .utf8), uid: uid)
    }

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

    /// Start the runner. First run on this Mac: the service isn't installed yet, so install it
    /// (download the runner + write the LaunchAgent) — which also starts it. There's no separate
    /// "Install" step in the UI; Start just does the right thing.
    func start() async {
        if !serviceInstalled {
            await installService()
            return
        }
        _ = await Self.launchctl(Launchctl.bootstrap(domain: domain, plistPath: paths.plistFile.path))
        await refresh()
    }

    // bootout and kickstart wait for the runner to leave, and with work in flight it first finishes
    // what it can: up to a minute (`LaunchdPlist.exitTimeOut`).
    func stop() async {
        message = "Stopping. A runner with work in flight can take up to a minute."
        _ = await Self.launchctl(Launchctl.bootout(domain: domain, plistPath: paths.plistFile.path))
        message = nil
        await refresh()
    }

    func restart() async {
        message = "Restarting. A runner with work in flight can take up to a minute."
        _ = await Self.launchctl(Launchctl.kickstartRestart(domain: domain))
        message = nil
        await refresh()
    }

    /// Install + start the background runner service entirely from the app — no Terminal. Downloads
    /// the runner from this server's /dl (`APIClient.downloadRunner`: version.json, then this Mac's
    /// `orbit-darwin-<arch>.gz`, checked against the manifest's sha256), unpacks it to the
    /// user-writable `~/.orbit/bin/orbit` that the runner then updates itself, writes the LaunchAgent
    /// plist (the Swift port of `orbit register`'s `installLaunchd`), then bootstraps it (RunAtLoad
    /// starts it). A failed download or check installs nothing and leaves `installError`, which the
    /// runner manager shows beside Try Again — this, once more.
    func installService() async {
        guard !installing else { return }
        installing = true
        installError = nil
        message = nil
        defer { installing = false }
        let staleDomain = domain   // the plist below replaces the record of where the old agent is
        do {
            let machine = Self.machineArchitecture()
            guard let platformKey = RunnerDownload.platformKey(machine: machine) else {
                throw RunnerDownloadError.unsupportedMachine(machine)
            }
            let gzip = try await api.downloadRunner(platformKey: platformKey)
            let binFile = paths.binFile
            try await Task.detached { try RunnerDownload.unpack(gzip, to: binFile) }.value

            let path = LoginPath.assemble(loginPath: await Self.loginShellPath(), home: NSHomeDirectory())
            let plist = LaunchdPlist.make(label: RunnerPaths.launchdLabel, programPath: paths.binFile.path,
                                          orbitHome: paths.home.path, home: NSHomeDirectory(),
                                          path: path, logPath: paths.logFile.path)
            try FileManager.default.createDirectory(at: paths.plistFile.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try Data(plist.utf8).write(to: paths.plistFile)
        } catch let error as RunnerDownloadError {
            installError = error.errorDescription
            return
        } catch {
            installError = "Install failed — \(error.localizedDescription)"
            return
        }
        // bootout any stale instance first so a reinstall replaces it cleanly; bootstrap loads +
        // starts (RunAtLoad). bootout failing (nothing loaded) is expected and ignored.
        _ = await Self.launchctl(Launchctl.bootout(domain: staleDomain, plistPath: paths.plistFile.path))
        let r = await Self.launchctl(Launchctl.bootstrap(domain: domain, plistPath: paths.plistFile.path))
        await refresh()
        if status.running {
            message = "Runner service installed and started."
        } else {
            let detail = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
            message = detail.isEmpty ? "Runner service installed." : "Service installed; launchctl: \(detail)"
        }
        await refreshUntilOnline()
    }

    /// The server reads this machine online from its first heartbeat, a moment after the service
    /// starts, and nothing else refreshes this pane: look again until it has, but not for long.
    private func refreshUntilOnline() async {
        for _ in 0..<10 where status.running && serverRunner?.online != true {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            await refresh()
        }
    }

    /// Launch-time upkeep for a Mac an older app enrolled. That app either bundled the runner, so its
    /// LaunchAgent set ORBIT_NO_SELFUPDATE and the app put its own runner back whenever the versions
    /// differed, or wrote a plist with no ExitTimeOut, so launchd kills the runner 5 s into any stop.
    /// This rewrites the plist (`LaunchdPlist.migrated`) and reloads the service if it's loaded. The
    /// binary isn't replaced: the runner updates it at its next check. No-op when no service is
    /// installed, once rewritten, and for the CLI's plist. A stopped service picks the new plist up at
    /// its next start.
    ///
    /// The plist is written once the runner has drained, so an app that quits during the drain has
    /// changed nothing and the next launch starts over.
    func migrateLaunchAgent() async {
        let installed = try? String(contentsOf: paths.plistFile, encoding: .utf8)   // nil: no service
        guard let plist = LaunchdPlist.migrated(from: installed) else { return }
        let list = await Self.launchctl(Launchctl.list())
        let service = Launchctl.parseList(list.output)
        guard service.loaded else {
            try? Data(plist.utf8).write(to: paths.plistFile)
            return
        }
        let plistPath = paths.plistFile.path
        let domain = self.domain
        let bootedOut = await Self.drainAndBootOut(domain: domain, plistPath: plistPath, pid: service.pid)
        try? Data(plist.utf8).write(to: paths.plistFile)
        // Nothing to boot out: the owner stopped the runner while it drained, and it stays stopped.
        guard bootedOut else { return }
        // bootout can return while the runner is still draining, and bootstrap fails until it has
        // exited, so keep trying a little longer.
        for _ in 0..<30 {
            if await Self.launchctl(Launchctl.bootstrap(domain: domain, plistPath: plistPath)).status == 0 { break }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        await refresh()
    }

    /// The reload is launchd's own stop, which the plist being replaced may limit to 5 s. A SIGTERM from
    /// here starts no clock, so the runner finishes what it can and leaves: within 3 minutes, for a runner
    /// from before Macs had a stop budget of their own. launchd then starts it again at once (KeepAlive),
    /// and that one heartbeats and is handed work within half a second (measured), so the bootout has to
    /// go the moment the first has left, before there is anything to cut off. Off the main actor, which
    /// is busy while the app launches. Returns whether there was a service to boot out.
    nonisolated private static func drainAndBootOut(domain: String, plistPath: String, pid: Int?) async -> Bool {
        await Task.detached {
            if let pid, await launchctl(Launchctl.terminate(domain: domain)).status == 0 {
                let giveUp = Date().addingTimeInterval(180)
                while kill(pid_t(pid), 0) == 0, Date() < giveUp {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
            }
            return await launchctl(Launchctl.bootout(domain: domain, plistPath: plistPath)).status == 0
        }.value
    }

    /// One-app enrollment: start the device flow, self-approve (we're the signed-in user), poll
    /// for the credential, write config.json, then download, install + start the runner service —
    /// the whole "set up a runner on this Mac" with no Terminal.
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
                    await installService()   // download + verify the runner, write + load the LaunchAgent
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
            message = "Enrollment failed — \(APIClient.failureReason(error))"
        }
    }

    private func writeConfig(_ cfg: RunnerConfig) throws {
        try FileManager.default.createDirectory(at: paths.home, withIntermediateDirectories: true)
        try JSONEncoder().encode(cfg).write(to: paths.configFile)
    }

    /// The user's login-shell PATH (`$SHELL -lc 'printf %s "$PATH"'`), so the launchd service can
    /// find `claude`/Homebrew tools the Finder-launched app's bare PATH lacks. Nil if it can't be
    /// read; `LoginPath.assemble` then falls back to a sane default.
    nonisolated private static func loginShellPath() async -> String? {
        await Task.detached {
            let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            let process = Process()
            process.executableURL = URL(fileURLWithPath: shell)
            process.arguments = ["-lc", "printf %s \"$PATH\""]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()
            do { try process.run() } catch { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return (s?.isEmpty ?? true) ? nil : s
        }.value
    }

    /// This Mac's CPU as `uname -m` names it, asked of the hardware (`hw.optional.arm64`) rather
    /// than of this process, which under Rosetta says x86_64 on an Apple-silicon Mac.
    nonisolated private static func machineArchitecture() -> String {
        var arm64: Int32 = 0
        var size = MemoryLayout<Int32>.size
        guard sysctlbyname("hw.optional.arm64", &arm64, &size, nil, 0) == 0, arm64 == 1 else { return "x86_64" }
        return "arm64"
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
