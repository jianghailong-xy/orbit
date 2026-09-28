import XCTest

// TEMPORARY evidence probe (see ../../README.md): the shared pool in the new-session provider picker
// and beside the composer's quota gauge, drawn by the app's own views — Generated/AgentIdentity.swift
// is the real `ProviderSwitchSheet`, and the composer's row and pill are cut verbatim out of
// ComposerView.swift. Every test keeps going after a miss, so one run brings back every picture it can.
final class PoolShotTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    private var shotsDir: String? { ProcessInfo.processInfo.environment["SHOTS_DIR"] }

    private func note(_ line: String) {
        print("PROBE: \(line)")
        guard let dir = shotsDir else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("report.txt")
        let text = line + "\n"
        if let fh = try? FileHandle(forWritingTo: url) {
            fh.seekToEndOfFile()
            fh.write(Data(text.utf8))
            try? fh.close()
        } else {
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    private func launch(_ screen: String, dark: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-screen", screen] + (dark ? ["-dark"] : [])
        app.launchEnvironment["TZ"] = "Europe/Berlin"
        app.launch()
        Thread.sleep(forTimeInterval: 2.5)
        return app
    }

    private func shoot(_ name: String) {
        Thread.sleep(forTimeInterval: 0.8)
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let dir = shotsDir else { return }
        do {
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
            note("capture \(name)")
        } catch {
            note("could not write \(name): \(error)")
        }
    }

    private func missing(_ what: String, _ app: XCUIApplication) {
        note("MISSING \(what)")
        if let dir = shotsDir {
            try? app.debugDescription.write(toFile: "\(dir)/missing-\(what).txt", atomically: true, encoding: .utf8)
        }
    }

    /// What the picker drew for the shared pool: the row's own words, and the badge's VoiceOver label
    /// (`SessionProviderChoices.poolBadgeLabel`, which is what says "keys" rather than "accounts").
    private func readPoolRow(_ app: XCUIApplication) {
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Team Codex'")).firstMatch
        note(row.exists ? "picker row: \(row.label)" : "picker row: Team Codex NOT FOUND")
        let badge = app.descendants(matching: .any).matching(NSPredicate(format: "label == '5 keys'")).firstMatch
        note(badge.exists ? "mark badge: '5 keys' (the poolUnit badge's VoiceOver label)"
                          : "mark badge: '5 keys' NOT FOUND")
    }

    // MARK: the picker, on the shared pool

    func test1PickerList() {
        let app = launch("picker")
        shoot("01-1-picker-light")
        readPoolRow(app)
        let list = app.collectionViews.firstMatch
        if list.waitForExistence(timeout: 5) {
            list.swipeUp()
            Thread.sleep(forTimeInterval: 0.6)
            shoot("01-2-picker-light-scrolled")
        } else {
            missing("picker-list", app)
        }
    }

    func test2PickerNoKeys() {
        let app = launch("picker-nokeys")
        shoot("04-1-picker-nokeys")
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'New pool'")).firstMatch
        note(row.exists ? "no-keys row: \(row.label) (enabled: \(row.isEnabled))"
                        : "no-keys row: 'New pool' NOT FOUND")
    }

    func test3Hero() {
        let app = launch("hero")
        shoot("02-1-hero-light")
        note("hero title: " + (app.staticTexts["Team Codex"].exists ? "Team Codex" : "NOT FOUND"))
        _ = launch("hero", dark: true)
        shoot("02-2-hero-dark")
    }

    // MARK: the composer's pool row

    func test4ComposerRow() {
        let app = launch("composer")
        shoot("03-1-composer-pool-key-light")
        // The row's drawn text is the key's label; its accessibility label is
        // `ProviderPools.accountHelp`, which is the sentence web puts in the tooltip.
        let key = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'orbit-org-1'")).firstMatch
        note(key.exists ? "composer account label: \(key.label)" : "composer account label: NOT FOUND")
        let gauge = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Plan usage'")).firstMatch
        note(gauge.exists ? "composer gauge: \(gauge.label)" : "composer gauge: NOT FOUND")
        _ = launch("composer", dark: true)
        shoot("03-2-composer-pool-key-dark")
    }

    func test5PickerDark() {
        let app = launch("picker", dark: true)
        shoot("01-3-picker-dark")
        readPoolRow(app)
    }
}
