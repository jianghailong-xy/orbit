import Foundation

// The "two-in-one" half: managing the local runner this Mac (optionally) hosts. The runner is
// already macOS-native (launchd `com.orbit.runner`, config at ~/.orbit/config.json, logs at
// $ORBIT_HOME/runner.log). Everything here is pure/IO-light and unit-tested; running launchctl
// via Process is the app's macOS glue.

/// Canonical on-disk locations for the local runner.
public struct RunnerPaths: Equatable, Sendable {
    /// $ORBIT_HOME, else ~/.orbit.
    public let home: URL
    /// ~/Library/LaunchAgents/com.orbit.runner.plist
    public let plistFile: URL

    public init(home: URL, plistFile: URL) {
        self.home = home
        self.plistFile = plistFile
    }

    public var configFile: URL { home.appendingPathComponent("config.json") }
    public var logFile: URL { home.appendingPathComponent("runner.log") }
    /// `<ORBIT_HOME>/bin/orbit` — where the app installs the runner binary it bundles, so the
    /// launchd service runs a stable, user-writable copy. Keeping it out of the signed .app lets
    /// the runner self-update this file without breaking the app's signature.
    public var binFile: URL { home.appendingPathComponent("bin/orbit") }

    public static let launchdLabel = "com.orbit.runner"

    /// Resolve from `$ORBIT_HOME` (nil/empty → `<userHome>/.orbit`) and the user's home dir.
    public static func resolve(orbitHome: String?, userHome: String) -> RunnerPaths {
        let home: URL
        if let h = orbitHome, !h.isEmpty {
            home = URL(fileURLWithPath: h)
        } else {
            home = URL(fileURLWithPath: userHome).appendingPathComponent(".orbit")
        }
        let plist = URL(fileURLWithPath: userHome)
            .appendingPathComponent("Library/LaunchAgents/\(launchdLabel).plist")
        return RunnerPaths(home: home, plistFile: plist)
    }
}

/// The runner's `config.json` (written by `orbit register`).
public struct RunnerConfig: Codable, Equatable, Sendable {
    public let serverUrl: String
    public let runnerId: String
    public let runnerToken: String
    public let name: String
    public let labels: [String]?
    public let maxConcurrent: Int?
    public let workDir: String?
    public init(serverUrl: String, runnerId: String, runnerToken: String, name: String,
                labels: [String]? = nil, maxConcurrent: Int? = nil, workDir: String? = nil) {
        self.serverUrl = serverUrl
        self.runnerId = runnerId
        self.runnerToken = runnerToken
        self.name = name
        self.labels = labels
        self.maxConcurrent = maxConcurrent
        self.workDir = workDir
    }
}

/// Reads the local runner's config + logs. `Data(contentsOf:)` is cross-platform Foundation, so
/// this is testable off a temp file (the file just won't exist on a non-runner machine → nil).
public enum RunnerEnvironment {
    public static func paths(environment: [String: String], userHome: String) -> RunnerPaths {
        RunnerPaths.resolve(orbitHome: environment["ORBIT_HOME"], userHome: userHome)
    }

    public static func readConfig(at paths: RunnerPaths) -> RunnerConfig? {
        guard let data = try? Data(contentsOf: paths.configFile) else { return nil }
        return try? JSONDecoder().decode(RunnerConfig.self, from: data)
    }

    public static func readLogTail(at paths: RunnerPaths, lines: Int = 200) -> [String] {
        guard let data = try? Data(contentsOf: paths.logFile),
              let text = String(data: data, encoding: .utf8) else { return [] }
        return LogTail.lastLines(text, lines)
    }
}

public enum LogTail {
    public static func lastLines(_ text: String, _ n: Int) -> [String] {
        guard n > 0 else { return [] }
        let lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
        let trimmed = lines.last == "" ? Array(lines.dropLast()) : lines   // ignore trailing newline
        return Array(trimmed.suffix(n))
    }
}

/// Local launchd service state for the runner.
public struct ServiceStatus: Equatable, Sendable {
    public let loaded: Bool
    public let pid: Int?
    public let lastExitCode: Int?
    public init(loaded: Bool, pid: Int?, lastExitCode: Int?) {
        self.loaded = loaded
        self.pid = pid
        self.lastExitCode = lastExitCode
    }
    public var running: Bool { pid != nil }
    public static let notLoaded = ServiceStatus(loaded: false, pid: nil, lastExitCode: nil)
}

/// Compact, glanceable status text for the local runner. Shared by the menu-bar tray and the
/// runner manager so both phrase the same launchd states identically.
public enum LocalRunnerStatus {
    /// `installed` is whether the LaunchAgent plist exists on disk — distinct from whether it's
    /// currently loaded/running, so a stopped-but-installed service no longer reads as "not
    /// installed" (which it did before the app could install the service itself).
    public static func line(hasConfig: Bool, installed: Bool, status: ServiceStatus) -> String {
        guard hasConfig else { return "Not set up on this Mac" }
        if status.running { return "Running · pid \(status.pid ?? 0)" }
        if installed || status.loaded { return "Stopped" }
        return "Service not installed"
    }
}

/// `launchctl` output parsing + argument-vector builders. The argv builders capture the exact
/// commands `orbit register`/the app run, so they're verified without a launchd to run them.
public enum Launchctl {
    public static let label = RunnerPaths.launchdLabel

    /// Parse `launchctl list` output. Data lines are `PID<TAB>Status<TAB>Label`; PID is `-`
    /// when the job is loaded but not currently running. A missing label line → not loaded.
    public static func parseList(_ output: String, label: String = label) -> ServiceStatus {
        for line in output.split(omittingEmptySubsequences: true, whereSeparator: \.isNewline) {
            let cols = line.split(whereSeparator: { $0 == "\t" || $0 == " " })
                .map(String.init).filter { !$0.isEmpty }
            guard cols.count >= 3, cols.last == label else { continue }
            return ServiceStatus(loaded: true, pid: Int(cols[0]), lastExitCode: Int(cols[1]))
        }
        return .notLoaded
    }

    // Modern launchctl (macOS 11+). `uid` is the GUI domain (e.g. 501).
    public static func bootstrap(uid: Int, plistPath: String) -> [String] { ["bootstrap", "gui/\(uid)", plistPath] }
    public static func bootout(uid: Int, plistPath: String) -> [String] { ["bootout", "gui/\(uid)", plistPath] }
    public static func kickstartRestart(uid: Int) -> [String] { ["kickstart", "-k", "gui/\(uid)/\(label)"] }
    public static func list() -> [String] { ["list"] }
    public static func printService(uid: Int) -> [String] { ["print", "gui/\(uid)/\(label)"] }
}

/// Builds the runner's LaunchAgent plist. Like `orbit register`'s `installLaunchd` (runner-go) it
/// runs `<orbit> run` with ORBIT_HOME/HOME/PATH baked in (launchd starts agents with a minimal
/// PATH and no HOME, so the `claude` CLI the runner shells out to wouldn't otherwise be found),
/// RunAtLoad + KeepAlive, logging to runner.log. Unlike the CLI's, it also sets ORBIT_NO_SELFUPDATE:
/// the app bundles the runner and re-syncs `~/.orbit/bin` on launch (RunnerControl.syncBundledRunner),
/// so the runner's version tracks the app instead of pulling a separate network self-update from the
/// control plane. Pure string → unit-tested.
public enum LaunchdPlist {
    public static func make(label: String, programPath: String, orbitHome: String,
                            home: String, path: String, logPath: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key><string>\(label)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(programPath)</string>
            <string>run</string>
          </array>
          <key>EnvironmentVariables</key>
          <dict>
            <key>ORBIT_HOME</key><string>\(orbitHome)</string>
            <key>HOME</key><string>\(home)</string>
            <key>PATH</key><string>\(path)</string>
            <key>ORBIT_NO_SELFUPDATE</key><string>1</string>
          </dict>
          <key>RunAtLoad</key><true/>
          <key>KeepAlive</key><true/>
          <key>StandardOutPath</key><string>\(logPath)</string>
          <key>StandardErrorPath</key><string>\(logPath)</string>
        </dict>
        </plist>
        """
    }
}

/// Assembles the PATH baked into the launchd service. A Finder-launched app's PATH is the bare
/// `/usr/bin:/bin:…`, which lacks where `claude`/Homebrew live, so we prepend the common install
/// dirs (and prefer the user's login-shell PATH when we could read it) — same intent as the CLI's
/// install-time PATH capture, but the GUI app has no login shell to inherit from.
public enum LoginPath {
    /// Dirs the official claude installer / Homebrew use that a GUI app's PATH usually misses.
    /// `~/.local/bin` is resolved per-user via `home`.
    public static func assemble(loginPath: String?, home: String) -> String {
        var base = (loginPath ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if base.isEmpty { base = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" }
        let existing = Set(base.split(separator: ":").map(String.init))
        let prefer = ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        let missing = prefer.filter { !existing.contains($0) }
        return (missing + [base]).joined(separator: ":")
    }
}

// MARK: - device enrollment DTOs (one-app runner enroll: start → approve → poll → write config)

public struct DeviceStartRequest: Codable, Sendable {
    public let name: String
    public let hostname: String?
    public let labels: [String]?
    public let maxConcurrent: Int?
    public let version: String?
    public let workDir: String?
    public init(name: String, hostname: String? = nil, labels: [String]? = nil,
                maxConcurrent: Int? = nil, version: String? = nil, workDir: String? = nil) {
        self.name = name
        self.hostname = hostname
        self.labels = labels
        self.maxConcurrent = maxConcurrent
        self.version = version
        self.workDir = workDir
    }
}

public struct DeviceStartResponse: Codable, Sendable {
    public let deviceCode: String
    public let userCode: String
    public let interval: Int
    public let expiresIn: Int
}

public enum DeviceStatus: String, Sendable {
    case pending, expired, approved
}

public struct DevicePollResponse: Codable, Sendable {
    public let status: String
    public let runnerId: String?
    public let runnerToken: String?
    public let name: String?

    public var deviceStatus: DeviceStatus? { DeviceStatus(rawValue: status) }
}
