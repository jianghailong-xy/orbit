import XCTest
@testable import OrbitKit

final class Phase4LogicTests: XCTestCase {

    // MARK: paths

    func testRunnerPathsResolution() {
        let def = RunnerPaths.resolve(orbitHome: nil, userHome: "/Users/me")
        XCTAssertEqual(def.home.path, "/Users/me/.orbit")
        XCTAssertEqual(def.configFile.lastPathComponent, "config.json")
        XCTAssertEqual(def.logFile.lastPathComponent, "runner.log")
        XCTAssertEqual(def.plistFile.path, "/Users/me/Library/LaunchAgents/com.orbit.runner.plist")

        let custom = RunnerPaths.resolve(orbitHome: "/opt/orbit", userHome: "/Users/me")
        XCTAssertEqual(custom.configFile.path, "/opt/orbit/config.json")
    }

    // MARK: config read (off a temp file — verifies the real parse path)

    func testReadConfigFromDisk() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("orbit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let json = #"{"serverUrl":"https://orbit.example.com","runnerId":"r1","runnerToken":"tok","name":"wikova","labels":["mac"],"maxConcurrent":4}"#
        try Data(json.utf8).write(to: dir.appendingPathComponent("config.json"))

        let paths = RunnerPaths(home: dir, plistFile: dir.appendingPathComponent("x.plist"))
        let cfg = RunnerEnvironment.readConfig(at: paths)
        XCTAssertEqual(cfg?.runnerId, "r1")
        XCTAssertEqual(cfg?.name, "wikova")
        XCTAssertEqual(cfg?.maxConcurrent, 4)
        XCTAssertEqual(cfg?.serverUrl, "https://orbit.example.com")

        // Missing file → nil, not a throw.
        let empty = RunnerPaths(home: dir.appendingPathComponent("nope"), plistFile: paths.plistFile)
        XCTAssertNil(RunnerEnvironment.readConfig(at: empty))
    }

    // MARK: launchctl list parsing

    func testParseLaunchctlList() {
        let running = "PID\tStatus\tLabel\n832\t0\tcom.orbit.runner\n12\t0\tcom.apple.foo\n"
        let s1 = Launchctl.parseList(running)
        XCTAssertTrue(s1.loaded)
        XCTAssertEqual(s1.pid, 832)
        XCTAssertTrue(s1.running)

        let loadedNotRunning = "-\t0\tcom.orbit.runner\n"
        let s2 = Launchctl.parseList(loadedNotRunning)
        XCTAssertTrue(s2.loaded)
        XCTAssertNil(s2.pid)
        XCTAssertFalse(s2.running)

        let absent = "99\t0\tcom.apple.bar\n"
        XCTAssertFalse(Launchctl.parseList(absent).loaded)
    }

    func testLaunchctlCommands() {
        XCTAssertEqual(Launchctl.bootstrap(uid: 501, plistPath: "/p.plist"), ["bootstrap", "gui/501", "/p.plist"])
        XCTAssertEqual(Launchctl.bootout(uid: 501, plistPath: "/p.plist"), ["bootout", "gui/501", "/p.plist"])
        XCTAssertEqual(Launchctl.kickstartRestart(uid: 501), ["kickstart", "-k", "gui/501/com.orbit.runner"])
    }

    func testRunnerStatusLine() {
        XCTAssertEqual(LocalRunnerStatus.line(hasConfig: false, installed: false, status: .notLoaded),
                       "Not set up on this Mac")
        // Enrolled but no plist on disk → genuinely not installed.
        XCTAssertEqual(LocalRunnerStatus.line(hasConfig: true, installed: false, status: .notLoaded),
                       "Service not installed")
        // Installed (plist exists) but not running → "Stopped", not "not installed".
        XCTAssertEqual(LocalRunnerStatus.line(hasConfig: true, installed: true, status: .notLoaded), "Stopped")
        XCTAssertEqual(LocalRunnerStatus.line(hasConfig: true, installed: false,
                       status: ServiceStatus(loaded: true, pid: nil, lastExitCode: 0)), "Stopped")
        XCTAssertEqual(LocalRunnerStatus.line(hasConfig: true, installed: true,
                       status: ServiceStatus(loaded: true, pid: 832, lastExitCode: 0)), "Running · pid 832")
    }

    // MARK: bin path + launchd plist builder + PATH assembly

    func testRunnerBinPath() {
        let p = RunnerPaths.resolve(orbitHome: nil, userHome: "/Users/me")
        XCTAssertEqual(p.binFile.path, "/Users/me/.orbit/bin/orbit")
    }

    func testLaunchdPlistContents() {
        let plist = LaunchdPlist.make(label: "com.orbit.runner", programPath: "/Users/me/.orbit/bin/orbit",
                                      orbitHome: "/Users/me/.orbit", home: "/Users/me",
                                      path: "/usr/local/bin:/usr/bin:/bin", logPath: "/Users/me/.orbit/runner.log")
        XCTAssertTrue(plist.contains("<key>Label</key><string>com.orbit.runner</string>"))
        XCTAssertTrue(plist.contains("<string>/Users/me/.orbit/bin/orbit</string>"))
        XCTAssertTrue(plist.contains("<string>run</string>"))
        XCTAssertTrue(plist.contains("<key>ORBIT_HOME</key><string>/Users/me/.orbit</string>"))
        // Self-update disabled: the app bundles + re-syncs the runner, so its version tracks the app.
        XCTAssertTrue(plist.contains("<key>ORBIT_NO_SELFUPDATE</key><string>1</string>"))
        XCTAssertTrue(plist.contains("<key>RunAtLoad</key><true/>"))
        XCTAssertTrue(plist.contains("<key>KeepAlive</key><true/>"))
        XCTAssertTrue(plist.contains("<key>StandardOutPath</key><string>/Users/me/.orbit/runner.log</string>"))
    }

    func testLoginPathAssembly() {
        // Empty login PATH → sane default with claude/Homebrew dirs prepended.
        let a = LoginPath.assemble(loginPath: nil, home: "/Users/me")
        XCTAssertTrue(a.hasPrefix("/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:"))
        XCTAssertTrue(a.contains("/usr/bin"))
        // Dirs already on the login PATH aren't duplicated; the missing preferred ones are prepended.
        let b = LoginPath.assemble(loginPath: "/opt/homebrew/bin:/usr/bin:/bin", home: "/Users/me")
        XCTAssertEqual(b, "/Users/me/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin")
    }

    // MARK: log tail

    func testLogTail() {
        let text = "l1\nl2\nl3\nl4\n"
        XCTAssertEqual(LogTail.lastLines(text, 2), ["l3", "l4"])
        XCTAssertEqual(LogTail.lastLines(text, 10), ["l1", "l2", "l3", "l4"])
        XCTAssertEqual(LogTail.lastLines("", 5), [])
    }

    // MARK: device enrollment DTOs

    func testDeviceResponsesDecode() throws {
        let start = try JSONDecoder().decode(DeviceStartResponse.self,
            from: Data(#"{"deviceCode":"d1","userCode":"WXYZ","interval":3,"expiresIn":600}"#.utf8))
        XCTAssertEqual(start.userCode, "WXYZ")
        XCTAssertEqual(start.interval, 3)

        let pending = try JSONDecoder().decode(DevicePollResponse.self,
            from: Data(#"{"status":"pending"}"#.utf8))
        XCTAssertEqual(pending.deviceStatus, .pending)
        XCTAssertNil(pending.runnerToken)

        let approved = try JSONDecoder().decode(DevicePollResponse.self,
            from: Data(#"{"status":"approved","runnerId":"r9","runnerToken":"secret","name":"mac"}"#.utf8))
        XCTAssertEqual(approved.deviceStatus, .approved)
        XCTAssertEqual(approved.runnerToken, "secret")
    }
}
