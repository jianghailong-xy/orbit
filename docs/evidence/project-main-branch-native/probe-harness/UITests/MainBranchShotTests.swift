import XCTest

// TEMPORARY evidence probe (see ../README.md). Drives the real shared sources against stub.py and
// photographs the Main branch row as docs/mocks/project-main-branch/02-ios.png draws it, frame by
// frame. Every state a picture is meant to show is asserted, so a run that never reached it fails
// rather than leaving a picture of something else; what the presses sent is read back from the stub.
final class MainBranchShotTests: ProbeCase {

    #if os(iOS)
    private let platform = "ios"
    #else
    private let platform = "mac"
    #endif

    // MARK: helpers

    /// The first button whose label begins with these words, brought between `top` and `bottom`.
    private func button(_ app: XCUIApplication, _ words: String, between top: CGFloat = 140,
                        and bottom: CGFloat = 640, _ name: String) -> XCUIElement? {
        guard waitUntil(20, { !buttons(app, beginning: words).isEmpty }),
              let found = buttons(app, beginning: words).first else {
            write(app.debugDescription, "no-button-\(name).txt")
            XCTFail("\(name): no button beginning \(words.debugDescription)")
            return nil
        }
        bring(app, found, between: top, and: bottom, name)
        return found
    }

    /// Words that must be on screen for the picture about to be taken.
    private func expect(_ app: XCUIApplication, _ words: String, _ name: String, timeout: TimeInterval = 15) {
        if appears(app, words, timeout: timeout) {
            note("\(name): shows \(words.debugDescription)")
        } else {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words.debugDescription) never showed")
        }
    }

    /// Words that must NOT be on screen.
    private func expectNo(_ app: XCUIApplication, _ words: String, _ name: String) {
        if element(app, containing: words).exists {
            write(app.debugDescription, "unexpected-\(name).txt")
            XCTFail("\(name): \(words.debugDescription) is on screen")
        } else {
            note("\(name): no \(words.debugDescription)")
        }
    }

    /// A picture of what is up: the window on the phone, the whole screen on the Mac (a sheet is a
    /// window of its own there).
    private func picture(_ app: XCUIApplication, _ name: String) {
        #if os(iOS)
        shot(app, "\(platform)-\(name)")
        #else
        screen("\(platform)-\(name)")
        #endif
    }

    /// Type into the picker's search field, replacing what it held.
    private func search(_ app: XCUIApplication, _ text: String, _ name: String) {
        // The picker's own field: on the Mac the window's "Search projects" field comes first.
        let field = app.searchFields.matching(NSPredicate(format: "placeholderValue == %@", "Type a branch name")).firstMatch
        guard field.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "no-search-\(name).txt")
            XCTFail("\(name): the picker has no search field")
            return
        }
        press(field)
        settle(0.6)
        #if os(iOS)
        if let current = field.value as? String, !current.isEmpty, current != "Type a branch name" {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        #else
        field.typeKey("a", modifierFlags: .command)
        field.typeKey(XCUIKeyboardKey.delete.rawValue, modifierFlags: [])
        #endif
        field.typeText(text)
        settle(1.2)
    }

    /// A row of the picker by its whole label (a branch, or `Use “…”`), pressed.
    private func pick(_ app: XCUIApplication, _ label: String, _ name: String) {
        let row = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@",
                                                   label, label + ",")).firstMatch
        guard row.waitForExistence(timeout: 10) else {
            write(app.debugDescription, "no-row-\(name).txt")
            XCTFail("\(name): the picker has no row \(label.debugDescription)")
            return
        }
        press(row)
        settle(1.5)
    }

    /// The decoded bodies the stub was sent at this door.
    private func bodies(_ door: String) -> [String] {
        requestsLog().split(separator: "\n").map(String.init).filter { $0.contains("BODY \(door)") }
    }

    // MARK: ① — the coordinator's card, in its conversation

    func test0TheConversationsCardOpensOnTheSuggestedMainBranchAndStartsOnIt() throws {
        let app = launch("P5", session: "C5", until: "Start this project?", "conversation")
        // The card is a preview in the transcript, and its review page is the card.
        let preview = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "View details")).firstMatch
        if preview.waitForExistence(timeout: 20) {
            bring(app, preview, between: 120, and: 760, "01-preview")
            press(preview)
            settle(1.5)
        } else {
            write(app.debugDescription, "no-preview-01.txt")
            XCTFail("01: the card's preview never showed")
        }
        expect(app, "Tasks land on", "01-card", timeout: 20)
        guard let row = button(app, "Main branch", between: 160, and: 560, "01-row") else { return }
        XCTAssertTrue(row.label.contains("master"), "the card does not open on the suggested master: \(row.label)")
        expect(app, "merges into master once the merge check passes", "01-card")
        expectNo(app, "Your last choice for", "01-card")
        picture(app, "01-conversation-card")

        // Start: the main branch on the card rides with the press.
        guard let go = button(app, "Start the project", between: 100, and: 900, "01-start") else { return }
        press(go)
        settle(3)
        let sent = bodies("/api/projects/P5/start")
        note("start bodies: \(sent)")
        XCTAssertTrue(sent.contains { $0.contains("\"upstreamRef\": \"refs/heads/master\"") && $0.contains("\"requestId\": \"I5\"") },
                      "the conversation's Start did not send the main branch on the card: \(sent)")
    }

    // MARK: ② ③ ⑤ ⑦ c ⑫–⑮ — the owner's own Start… on a project nobody started

    func test1TheStartCardOpensOnTheLastChoiceAndSendsWhatIsPicked() throws {
        let app = launch("P2", until: "Refund service", "start")
        guard let start = button(app, "Start…", "start-row") else { return }
        press(start)
        expect(app, "Tasks land on", "start-card", timeout: 30)

        // ② (board 6): the owner's last choice for the repository, said where it came from.
        guard let row = button(app, "Main branch", between: 160, and: 560, "main-branch-row") else { return }
        expect(app, "Your last choice for acme/payments-api", "02-last-choice")
        expect(app, "merges into master once the merge check", "02-last-choice")
        picture(app, "02-start-last-choice")

        // ③ ⑦ (board 3, 7): the picker — the branches the runner reported, the current one ticked,
        // the last choice tagged.
        press(row)
        expect(app, "Branches in payments-api", "03-picker", timeout: 20)
        expect(app, "last chosen", "03-picker")
        expect(app, "Tasks start from it, and the project’s work ends up on it.", "03-picker")
        picture(app, "03-picker-last-chosen")

        // ⑤ (board 5): a name the runner never reported, offered as itself.
        search(app, "release/3.0", "05-typed")
        expect(app, "Use “release/3.0”", "05-typed")
        picture(app, "05-picker-typed")
        search(app, "a..b", "05-refused")
        expectNo(app, "Use “a..b”", "05-refused")

        // c: another branch picked — the row names it, and no longer says it was the last choice.
        search(app, "develop", "06-pick")
        pick(app, "develop", "06-pick")
        expect(app, "merges into develop once the merge check", "06-picked")
        expectNo(app, "Your last choice for", "06-picked")
        _ = button(app, "Main branch", between: 160, and: 560, "06-picked-row")
        picture(app, "06-picked-develop")

        // ⑬ ⑭ ⑮ (board 13–15): Automatic off and the merge check open, all of it said of develop.
        // A switch on the phone; on the Mac SwiftUI's switch is a checkbox to accessibility.
        #if os(iOS)
        let automatic = app.switches.matching(NSPredicate(format: "label == %@", "Automatic")).firstMatch
        #else
        let automatic = app.checkBoxes.matching(NSPredicate(format: "label == %@", "Automatic")).firstMatch
        #endif
        if automatic.waitForExistence(timeout: 10) {
            bring(app, automatic, between: 140, and: 500, "13-automatic")
            press(automatic)
            settle(1)
        } else {
            write(app.debugDescription, "no-switch-13.txt")
            XCTFail("13: no Automatic switch")
        }
        expect(app, "You decide when each task is done and when the branch goes into develop.", "13-off")
        expect(app, "Merging the branch into develop", "14-comes-to-you")
        if let check = button(app, "Merge check", between: 300, and: 700, "15-merge-check") {
            press(check)
            settle(1)
        }
        expect(app, "on the project branch and again before develop.", "15-merge-check")
        let comes = element(app, containing: "Merging the branch into develop")
        if comes.exists { bring(app, comes, between: 120, and: 330, "13-frame") }
        picture(app, "13-automatic-off")

        // ⑫ (board 12): Tasks land on, directly into the main branch on the card.
        #if os(iOS)
        let menu = button(app, "A project branch", between: 200, and: 600, "12-line")
        #else
        // The Mac's borderless menu is a menu button, named by its title.
        let menu = Optional(app.menuButtons.matching(NSPredicate(format: "title BEGINSWITH %@", "A project branch")).firstMatch)
        if let menu, menu.waitForExistence(timeout: 10) {
            bring(app, menu, between: 200, and: 600, "12-line")
        } else {
            XCTFail("12: no Tasks land on menu")
        }
        #endif
        if let line = menu, line.exists {
            press(line)
            settle(1.5)
            #if os(iOS)
            let item = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Directly into develop")).firstMatch
            #else
            let item = app.menuItems.matching(NSPredicate(format: "title BEGINSWITH %@", "Directly into develop")).firstMatch
            #endif
            // The item names the branch on the card; its second line never reaches accessibility, so
            // the picture shows it.
            if item.waitForExistence(timeout: 5) {
                note("12-menu: shows \(item.label.isEmpty ? item.title : item.label)")
                picture(app, "12-line-menu")
                press(item)
                settle(1.2)
            } else {
                write(app.debugDescription, "no-item-12.txt")
                picture(app, "12-line-menu")
                XCTFail("12: the menu has no Directly into develop")
            }
        }
        expect(app, "Each merge into develop", "12-directly")
        picture(app, "12-directly-into-develop")

        // The press: Start sends the main branch on the card, as a full ref.
        guard let go = button(app, "Start the project", between: 100, and: 900, "start-press") else { return }
        press(go)
        settle(3)
        let sent = bodies("/api/projects/P2/start")
        note("start bodies: \(sent)")
        XCTAssertTrue(sent.contains { $0.contains("\"upstreamRef\": \"refs/heads/develop\"") },
                      "Start did not send the main branch on the card: \(sent)")
        XCTAssertTrue(sent.contains { $0.contains("\"line\": \"MAIN\"") && $0.contains("\"automatic\": false") },
                      "Start did not send the card's other settings: \(sent)")

        // And How it runs, now the project is started, stands on it.
        expect(app, "Tasks land on", "07-started", timeout: 30)
        if let started = button(app, "Main branch", between: 160, and: 620, "07-started-row") {
            XCTAssertTrue(started.label.contains("develop"), "How it runs does not stand on develop: \(started.label)")
        }
        picture(app, "07-started-how-it-runs")
    }

    // MARK: ⑧ ⑨ — How it runs on a project that can still move its main branch

    func test2HowItRunsWritesAPickAtOnce() throws {
        let app = launch("P1", until: "Payments gateway rollout", "how-it-runs")
        guard let row = button(app, "Main branch", between: 260, and: 620, "08-row") else { return }
        expect(app, "New projects in acme/payments-api start with your last choice.", "08-how-it-runs")
        expect(app, "Directly into master", "09-line")
        expect(app, "merges the branch into master once the merge check passes", "09-automatic")
        XCTAssertTrue(row.label.contains("master"), "the row does not show master: \(row.label)")
        picture(app, "08-how-it-runs")

        press(row)
        expect(app, "Branches in payments-api", "08-picker", timeout: 20)
        expect(app, "last chosen", "08-picker")
        picture(app, "08-picker")
        pick(app, "develop", "08-pick")
        settle(2)
        let sent = bodies("/api/projects/P1/integration")
        note("integration bodies: \(sent)")
        XCTAssertTrue(sent.contains { $0.hasSuffix("{\"upstreamRef\": \"refs/heads/develop\"}") },
                      "a pick did not write the main branch alone, as a full ref: \(sent)")
        expect(app, "Directly into develop", "08-picked")
        if let picked = button(app, "Main branch", between: 260, and: 620, "08-picked-row") {
            XCTAssertTrue(picked.label.contains("develop"), "the row does not show the pick: \(picked.label)")
        }
        picture(app, "08-picked-develop")

        // ⑨: what Pause stops, said of the branch the project now stands on.
        let pause = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pause project")).firstMatch
        bring(app, pause, between: 200, and: 560, "09-pause")
        expect(app, "Stops new tasks, wake-ups and merges into develop. Running tasks finish.", "09-pause")
        picture(app, "09-pause")
    }

    // MARK: ⑩ ⑪ — a project that started integrating: the line and its main branch locked

    func test3ALockedProjectShowsItsMainBranchLocked() throws {
        let app = launch("P3", until: "Checkout redesign", "locked")
        // ⑪: the integration row under the title names the main branch.
        expect(app, "ahead of master at last measurement", "11-facts")
        expect(app, "synced with master", "11-facts")
        picture(app, "11-header-facts")

        expect(app, "Tasks land on", "10-locked")
        let sentence = element(app, containing: "and its main branch can no longer change")
        if appears(app, "and its main branch can no longer change", timeout: 5) {
            bring(app, sentence, between: 250, and: 650, "10-locked")
        } else {
            let head = element(app, containing: "Escalate after")
            bring(app, head, between: 300, and: 700, "10-locked-scroll")
        }
        expect(app, "and its main branch can no longer change. Merge it into master, or give up the branch",
               "10-locked")
        expectNo(app, "so the line it lands on can no longer change", "10-locked")
        XCTAssertTrue(buttons(app, beginning: "Main branch").isEmpty, "a locked main branch is not a press")
        picture(app, "10-locked")
    }

    // MARK: e — a project with no repository has no row

    func test4AProjectWithNoRepositoryHasNoMainBranchRow() throws {
        let app = launch("P4", until: "Docs site", "no-repository")
        guard let start = button(app, "Start…", "e-start-row") else { return }
        press(start)
        expect(app, "Tasks land on", "e-start-card", timeout: 30)
        _ = button(app, "Merge check", between: 200, and: 650, "e-merge-check")
        expectNo(app, "Main branch", "e-no-row")
        expect(app, "merges into main by itself", "e-main")
        picture(app, "e-no-repository")
    }
}
