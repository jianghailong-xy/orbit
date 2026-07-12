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

    /// Whether the LaunchAgent plist is on disk. Distinct from `status.running`: an installed but
    /// stopped service still counts as installed (so the UI shows Start, not "Install service").
    var serviceInstalled: Bool { FileManager.default.fileExists(atPath: paths.plistFile.path) }

    /// The `orbit` runner binary bundled inside the .app (Contents/Resources/orbit). Nil under
    /// `swift run` (no bundle) — install only works from a real .app. Falls back to the explicit
    /// Resources path in case `url(forResource:)` misses for a hand-assembled (non-Xcode) bundle.
    private var bundledRunnerURL: URL? {
        if let u = Bundle.main.url(forResource: "orbit", withExtension: nil) { return u }
        let fallback = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/orbit")
        return FileManager.default.fileExists(atPath: fallback.path) ? fallback : nil
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
    /// (copy the bundled binary + write the LaunchAgent) — which also starts it. There's no separate
    /// "Install" step in the UI; Start just does the right thing.
    func start() async {
        if !serviceInstalled {
            await installService()
            return
        }
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

    /// Install + start the background runner service entirely from the app — no Terminal. Copies the
    /// bundled `orbit` binary to a stable, user-writable `~/.orbit/bin/orbit` (so the runner can
    /// self-update it without touching the signed .app), writes the LaunchAgent plist (the Swift
    /// port of `orbit register`'s `installLaunchd`), then bootstraps it (RunAtLoad starts it).
    func installService() async {
        guard let src = bundledRunnerURL else {
            message = "Runner binary missing from the app bundle — reinstall Orbit."
            return
        }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: paths.binFile.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: paths.binFile.path) { try fm.removeItem(at: paths.binFile) }
            try fm.copyItem(at: src, to: paths.binFile)
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: paths.binFile.path)

            let path = LoginPath.assemble(loginPath: await Self.loginShellPath(), home: NSHomeDirectory())
            let plist = LaunchdPlist.make(label: RunnerPaths.launchdLabel, programPath: paths.binFile.path,
                                          orbitHome: paths.home.path, home: NSHomeDirectory(),
                                          path: path, logPath: paths.logFile.path)
            try fm.createDirectory(at: paths.plistFile.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(plist.utf8).write(to: paths.plistFile)
        } catch {
            message = "Install failed — \(error.localizedDescription)"
            return
        }
        // bootout any stale instance first so a reinstall replaces it cleanly; bootstrap loads +
        // starts (RunAtLoad). bootout failing (nothing loaded) is expected and ignored.
        _ = await Self.launchctl(Launchctl.bootout(uid: uid, plistPath: paths.plistFile.path))
        let r = await Self.launchctl(Launchctl.bootstrap(uid: uid, plistPath: paths.plistFile.path))
        await refresh()
        if status.running {
            message = "Runner service installed and started."
        } else {
            let detail = r.output.trimmingCharacters(in: .whitespacesAndNewlines)
            message = detail.isEmpty ? "Runner service installed." : "Service installed; launchctl: \(detail)"
        }
    }

    /// Frozen-runner upkeep. The LaunchAgent disables the runner's network self-update
    /// (ORBIT_NO_SELFUPDATE), so its version tracks the app, not the control plane. Sparkle replaces
    /// the `.app` but not the already-installed `~/.orbit/bin/orbit`, so on launch we compare the
    /// bundled runner's version against the installed copy and, when the app carries a different one
    /// (i.e. it was just updated), re-copy the binary + reload the service via `installService()`.
    /// No-op until this Mac has enrolled (no service installed) or when the versions already match —
    /// so a normal launch costs two quick `version` probes and nothing else.
    func syncBundledRunner() async {
        guard serviceInstalled, let src = bundledRunnerURL else { return }
        guard let bundledVer = await Self.runnerVersion(at: src) else { return }
        let installedVer = await Self.runnerVersion(at: paths.binFile)
        guard installedVer != bundledVer else { return }
        await installService()   // re-copies the bundled binary, rewrites the plist, reloads launchd
        if status.running { message = "Runner updated to \(bundledVer) with the app." }
    }

    /// One-app enrollment: start the device flow, self-approve (we're the signed-in user), poll
    /// for the credential, write config.json, then install + start the bundled runner service —
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
                    await installService()   // copy the bundled runner, write + load the LaunchAgent
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

    /// `<binary> version` → the runner's baked version string (e.g. "0.1.52"), or nil if it can't
    /// be run. Lets `syncBundledRunner` tell whether the installed runner matches this .app's copy.
    nonisolated private static func runnerVersion(at url: URL) async -> String? {
        await Task.detached {
            let process = Process()
            process.executableURL = url
            process.arguments = ["version"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()
            do { try process.run() } catch { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return (s?.isEmpty ?? true) ? nil : s
        }.value
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
