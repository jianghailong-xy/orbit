import XCTest

// TEMPORARY evidence probe (never merged; see ../README.md): New workspace on a machine that already has one
// (docs/mocks/new-workspace-form/02-apple-entry, owner A 2026-11-20), driven as a person drives it against stub.py on
// the iPhone's and the Mac's own shells. orbit@austin holds `orbit`, build-box holds `wiki-site`; the + on the
// Workspaces group offers both. A word missing from the screen, a press that goes nowhere or a request the app didn't
// make fails the test; each scene is photographed.
final class NewWorkspaceShotTests: ProbeCase {
    private let hint = "A name in /home/orbit, or a full path. Uses the folder if it exists, otherwise creates it."
    private let found = "Found · git repository · main"
    private let missing = "No such directory on orbit@austin."
    private let repository = "/home/orbit/code/api"

    private func expect(_ app: XCUIApplication, _ words: String, _ scene: String, timeout: TimeInterval = 20) {
        if !appears(app, words, timeout: timeout) {
            write(app.debugDescription, "missing-\(scene).txt")
            XCTFail("\(scene): \"\(words)\" never showed")
        }
    }

    private func absent(_ app: XCUIApplication, _ words: String, _ scene: String) {
        if element(app, containing: words).exists {
            write(app.debugDescription, "present-\(scene).txt")
            XCTFail("\(scene): \"\(words)\" shows, and must not")
        }
    }

    /// The lines of the log with this in them, since this launch put the stub back.
    private func requests(_ line: String) -> [String] {
        let sinceReset = requestsLog().components(separatedBy: "POST /__reset").last ?? ""
        return sinceReset.components(separatedBy: "\n").filter { $0.contains(line) }
    }

    private func plus(_ app: XCUIApplication, _ scene: String) -> XCUIElement? {
        let plus = app.descendants(matching: .any).matching(identifier: "new-workspace").firstMatch
        guard plus.waitForExistence(timeout: 15) else {
            write(app.debugDescription, "no-plus-\(scene).txt")
            XCTFail("\(scene): no + on the Workspaces group")
            return nil
        }
        return plus
    }

    /// The machine's item in the + menu.
    private func menuItem(_ app: XCUIApplication, _ machine: String, _ scene: String) -> XCUIElement? {
        let begins = NSPredicate(format: "label BEGINSWITH %@ OR title BEGINSWITH %@", machine, machine)
        #if os(macOS)
        let item = app.menuItems.matching(begins).firstMatch
        #else
        let item = app.buttons.matching(begins).firstMatch
        #endif
        guard item.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "no-menu-\(scene).txt")
            XCTFail("\(scene): no \(machine) in the + menu")
            return nil
        }
        return item
    }

    private func folderField(_ app: XCUIApplication, _ scene: String) -> XCUIElement? {
        let field = app.textFields.matching(NSPredicate(format: "label == %@ OR identifier == %@", "Folder", "Folder")).firstMatch
        guard field.waitForExistence(timeout: 15) else {
            write(app.debugDescription, "no-folder-\(scene).txt")
            XCTFail("\(scene): no Folder field")
            return nil
        }
        return field
    }

    /// Replace the field's text with `text`.
    private func type(_ field: XCUIElement, _ text: String) {
        #if os(macOS)
        field.click()
        settle(0.4)
        field.typeKey("a", modifierFlags: .command)
        field.typeText(text)
        #else
        // A press at the right edge leaves the caret at the end, so the deletes take everything.
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.96, dy: 0.5)).tap()
        settle(0.6)
        let length = ((field.value as? String) ?? "").count
        if length > 0 { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: length + 2)) }
        field.typeText(text)
        #endif
        settle(0.8)
    }

    private func lowerKeyboard(_ app: XCUIApplication) {
        #if os(iOS)
        guard app.keyboards.firstMatch.exists else { return }
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 400)),
                    withVelocity: .fast, thenHoldForDuration: 0.3)
        settle(1)
        #endif
    }

    private func createButton(_ app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ OR title == %@", "Create workspace", "Create workspace")).firstMatch
    }

    #if os(iOS)
    func test1PhoneLight() throws { try phone(dark: false) }
    func test2PhoneDark() throws { try phone(dark: true) }

    /// The drawer's +, its menu of machines, the card there empty, an existing repository, a missing path, Create.
    private func phone(dark: Bool) throws {
        let look = dark ? "dark" : "light"
        let app = launch(scene: "two", until: "orbit", dark: dark, "\(look)-launch")
        press(app.buttons["Open navigation"])
        settle(1.5)
        expect(app, "wiki-site", "\(look)-drawer")
        guard let plus = plus(app, "\(look)-drawer") else { return }
        shot(app, "\(look)-01-entry")

        press(plus)
        guard let austin = menuItem(app, "orbit@austin", "\(look)-menu") else { return }
        expect(app, "build-box", "\(look)-menu", timeout: 5)
        shot(app, "\(look)-02-menu")

        press(austin)
        settle(1.5)
        expect(app, "New workspace", "\(look)-page")
        expect(app, hint, "\(look)-page")
        absent(app, "New workspace on orbit@austin", "\(look)-page-headless")
        absent(app, "Set up orbit@austin", "\(look)-page")
        shot(app, "\(look)-03-card-empty")

        guard let field = folderField(app, "\(look)-found") else { return }
        type(field, repository)
        expect(app, found, "\(look)-found")
        let name = app.textFields.matching(NSPredicate(format: "label == %@", "Name")).firstMatch
        XCTAssertEqual(name.value as? String, "api", "\(look): the name follows the path's last segment")
        XCTAssertTrue(createButton(app).isEnabled, "\(look): an existing repository can be made a workspace")
        XCTAssertEqual(requests("BODY /api/runners/austin/dir-probe {\"path\": \"\(repository)\"}").count >= 1, true,
                       "\(look): the path is asked about as typed")
        lowerKeyboard(app)
        shot(app, "\(look)-04-found")

        type(field, "~/nowhere")
        expect(app, missing, "\(look)-missing")
        XCTAssertFalse(createButton(app).isEnabled, "\(look): what isn't there can't be made a workspace")
        XCTAssertFalse(requests("BODY /api/runners/austin/dir-probe {\"path\": \"~/nowhere\"}").isEmpty,
                       "\(look): ~ is sent as typed, for the machine to expand")
        lowerKeyboard(app)
        shot(app, "\(look)-05-missing")

        type(field, repository)
        expect(app, found, "\(look)-again")
        lowerKeyboard(app)
        press(createButton(app))
        if !waitUntil(15, { !self.requests("BODY /api/agents {").isEmpty }) {
            XCTFail("\(look): Create sent no POST /api/agents")
        }
        let creates = requests("BODY /api/agents {")
        XCTAssertEqual(creates.count, 1, "\(look): one create: \(creates)")
        for piece in ["\"name\": \"api\"", "\"runnerId\": \"austin\"", "\"workDir\": \"\(repository)\""] {
            XCTAssertTrue(creates.first?.contains(piece) == true, "\(look): the create lacks \(piece): \(creates)")
        }
        XCTAssertFalse(creates.first?.contains("newFolder") == true, "\(look): nothing is made for a full path")
        // The new workspace's new session page: the card is gone, the composer names the machine.
        if !waitUntil(20, { !self.folderFieldExists(app) && !self.element(app, containing: "Create workspace").exists }) {
            write(app.debugDescription, "still-card-\(look).txt")
            XCTFail("\(look): the card stayed after Create")
        }
        expect(app, "api", "\(look)-created")
        settle(2)
        lowerKeyboard(app)
        shot(app, "\(look)-06-created")
    }

    /// Settings → Machines & models → orbit@austin: the row after its workspaces opens the same page.
    func test3MachinePageRow() throws {
        let app = launch(scene: "two", page: ["-probe.runner", "austin"], until: "Workspaces", "machine-page")
        let row = app.buttons.matching(NSPredicate(format: "identifier == %@", "machine-new-workspace")).firstMatch
        bring(app, row, between: 90, and: 760, "machine-row")
        guard row.exists else {
            write(app.debugDescription, "no-machine-row.txt")
            return XCTFail("no New workspace row on the machine page")
        }
        shot(app, "light-08-machine-row")
        press(row)
        settle(2)
        expect(app, hint, "machine-row-page")
        absent(app, "Tap a workspace to open its sessions.", "machine-row-page")
        shot(app, "light-09-from-machine-row")
    }
    #endif

    private func folderFieldExists(_ app: XCUIApplication) -> Bool {
        app.textFields.matching(NSPredicate(format: "label == %@", "Folder")).firstMatch.exists
    }

    #if os(macOS)
    /// The sidebar's +, its menu, and the card with its head (the Mac's content column names no machine).
    func test4Mac() throws {
        let app = launch(scene: "two", until: "wiki-site", "mac-launch")
        guard let plus = plus(app, "mac") else { return }
        shot(app, "mac-01-entry")
        // The sidebar folds its section header and the + into one element as wide as the header (run 44704121881), and
        // under the pointer it narrows to make room for the section's disclosure triangle, the + moving left beside it
        // (run 44710605671). The menu that opens is drawn outside the app's accessibility tree (run 44727358665: on
        // screen, with both machines, but no menu item to query), so it is pictured from the screen and its first
        // machine, orbit@austin, is chosen with the keyboard.
        plus.hover()
        settle(0.8)
        note("mac: hovered + element label=\(plus.label) frame=\(plus.frame)")
        plus.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: -12, dy: 0)).click()
        settle(1.2)
        screen("mac-02-menu")
        app.typeKey(.downArrow, modifierFlags: [])
        settle(0.4)
        app.typeKey(.return, modifierFlags: [])
        settle(1.5)
        if !appears(app, "New workspace on orbit@austin", timeout: 6) {
            // The keys went elsewhere: open it again and click its first machine where run 44727358665 drew it, 53 pt
            // under the + and 80 pt to its right.
            note("mac: the keyboard chose nothing; clicking the first item instead")
            app.typeKey(.escape, modifierFlags: [])
            plus.hover()
            settle(0.8)
            plus.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: -12, dy: 0)).click()
            settle(1.2)
            plus.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: 68, dy: 53)).click()
            settle(1.5)
        } else {
            note("mac: the keyboard chose orbit@austin")
        }
        expect(app, "New workspace on orbit@austin", "mac-page")
        expect(app, hint, "mac-page")
        shot(app, "mac-03-card-empty")
        guard let field = folderField(app, "mac") else { return }
        type(field, repository)
        expect(app, found, "mac-found")
        XCTAssertTrue(createButton(app).isEnabled, "mac: an existing repository can be made a workspace")
        shot(app, "mac-04-found")
        type(field, "~/nowhere")
        expect(app, missing, "mac-missing")
        XCTAssertFalse(createButton(app).isEnabled, "mac: what isn't there can't be made a workspace")
        shot(app, "mac-05-missing")
    }
    #endif
}
