import XCTest

// TEMPORARY evidence probe (see ../../README.md). Drives the real shared sources against stub.py and
// photographs contract revision 29 on this client, light and dark: Delivery on the start card and in
// How it runs, the two items with Accept and Observe again, the task row's observation words, the fifth
// owner item on the needs-you bar and the projects list, and the owner confirmation's AGENT_PUSHED. Every
// state a picture is meant to show is asserted, so a run that never reached it fails rather than leaving
// a picture of something else; what the presses sent is read back from the stub.
final class LandingObservationShotTests: ProbeCase {

    #if os(iOS)
    private let platform = "ios"
    #else
    private let platform = "mac"
    #endif

    private let appearances = [false, true]

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

    /// Bring these words between `top` and `bottom`, then assert them: a lazy list builds a row only
    /// once it comes near the screen, and `bring` scrolls toward it whether or not it exists yet.
    private func show(_ app: XCUIApplication, _ words: String, between top: CGFloat, and bottom: CGFloat,
                      _ name: String) {
        if !appears(app, words, timeout: 8) { note("\(name): \(words.debugDescription) not built yet; scrolling") }
        bring(app, element(app, containing: words), between: top, and: bottom, name)
        expect(app, words, name, timeout: 10)
    }

    /// The picture: the screen on the phone, the whole screen on the Mac (a sheet or a menu is a window
    /// of its own there), named by platform, scene and appearance.
    private func picture(_ app: XCUIApplication, _ scene: String, dark: Bool) {
        let name = "\(platform)-\(scene)-\(dark ? "dark" : "light")"
        #if os(iOS)
        shot(app, name)
        #else
        screen(name)
        #endif
    }

    /// The decoded bodies the stub was sent at this door.
    private func bodies(_ door: String) -> [String] {
        requestsLog().split(separator: "\n").map(String.init).filter { $0.contains("BODY \(door)") }
    }

    /// A conversation's card behind its preview (`ApprovalReviewLayout`): pressed open.
    private func openPreview(_ app: XCUIApplication, _ name: String) {
        let preview = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "View details")).firstMatch
        if preview.waitForExistence(timeout: 25) {
            bring(app, preview, between: 120, and: 760, "\(name)-preview")
            press(preview)
            settle(1.5)
        } else {
            write(app.debugDescription, "no-preview-\(name).txt")
            XCTFail("\(name): the card's preview never showed")
        }
    }

    /// The reason field of a panel, by what it asks — a vertical TextField is a text view on iOS.
    private func field(_ app: XCUIApplication, _ prompt: String) -> XCUIElement? {
        let match = NSPredicate(format: "placeholderValue == %@ OR label == %@", prompt, prompt)
        for query in [app.textViews, app.textFields] {
            let found = query.matching(match).firstMatch
            if found.exists { return found }
        }
        for query in [app.textViews, app.textFields] where query.firstMatch.exists {
            return query.firstMatch
        }
        return nil
    }

    // MARK: Delivery on the start card (§10.5 O-L1, O-L2)

    /// C5's start card on a main line: Delivery offered, its menu with both ways, and the agent's way
    /// chosen — its line, the Automatic sentence without a merge into main asking anybody, and the
    /// start's write carrying it.
    func test0TheStartCardOffersTheAgentsWay() throws {
        for dark in appearances {
            let scene = "start"
            let app = launch(.session("C5"), until: "Start this project?", dark: dark, scene)
            openPreview(app, scene)
            expect(app, "Delivery", "\(scene)-row", timeout: 20)
            expect(app, "The agent doesn’t push to main: Orbit lands its branch once the work is accepted.", "\(scene)-platform")

            // The menu, both ways in it.
            #if os(iOS)
            let menu = button(app, "Orbit lands it", between: 160, and: 640, "\(scene)-menu")
            #else
            let menu = Optional(app.menuButtons.matching(NSPredicate(format: "title BEGINSWITH %@", "Orbit lands it")).firstMatch)
            if let menu, menu.waitForExistence(timeout: 10) {
                bring(app, menu, between: 160, and: 640, "\(scene)-menu")
            } else {
                XCTFail("\(scene): no Delivery menu")
            }
            #endif
            guard let open = menu, open.exists else { continue }
            press(open)
            settle(1.5)
            #if os(iOS)
            let item = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "The agent pushes it")).firstMatch
            #else
            let item = app.menuItems.matching(NSPredicate(format: "title BEGINSWITH %@", "The agent pushes it")).firstMatch
            #endif
            if item.waitForExistence(timeout: 5) {
                picture(app, "start-delivery-menu", dark: dark)
                press(item)
                settle(1.2)
            } else {
                write(app.debugDescription, "no-item-\(scene).txt")
                picture(app, "start-delivery-menu", dark: dark)
                XCTFail("\(scene): the menu has no The agent pushes it")
                continue
            }

            show(app, "The agent pushes to main itself, and Orbit checks the commits are there.",
                 between: 300, and: 700, "\(scene)-agent-push")
            picture(app, "start-delivery-agent-push", dark: dark)
            show(app, "The coordinator decides when each task is done. The agent pushes each task’s work to main itself.",
                 between: 140, and: 420, "\(scene)-automatic")
            expectNo(app, "Each merge into main", "\(scene)-no-merge")
            picture(app, "start-automatic-agent-push", dark: dark)

            guard let go = button(app, "Start the project", between: 100, and: 900, "\(scene)-press") else { continue }
            press(go)
            settle(3)
            let sent = bodies("/api/projects/P5/start")
            note("start bodies: \(sent)")
            XCTAssertTrue(sent.contains { $0.contains("\"deliveryMode\": \"AGENT_PUSH\"") && $0.contains("\"line\": \"MAIN\"") },
                          "Start did not send the agent's way with the main line: \(sent)")
            app.terminate()
        }
    }

    // MARK: Delivery in How it runs

    /// P1 (a main line, the agent pushes): the row with the agent's way chosen, and what the line and
    /// Automatic say under it.
    func test1HowItRunsOnAnAgentPushProject() throws {
        for dark in appearances {
            let scene = "how-it-runs"
            let app = launch(.project("P1"), until: "Payments gateway rollout", dark: dark, scene)
            show(app, "The agent pushes to main itself, and Orbit checks the commits are there.",
                 between: 260, and: 640, "\(scene)-delivery")
            expect(app, "Orbit lands it", "\(scene)-platform")
            expect(app, "For a single task or an urgent fix. The agent pushes each task’s work to main itself.", "\(scene)-line")
            picture(app, "how-it-runs-agent-push", dark: dark)
            show(app, "handles failed tasks and work not seen on main", between: 200, and: 640, "\(scene)-automatic")
            picture(app, "how-it-runs-automatic-agent-push", dark: dark)
            app.terminate()
        }
    }

    /// P3 (a project branch): the agent's way drawn, not offered, saying why.
    func test2HowItRunsOnAProjectBranch() throws {
        for dark in appearances {
            let scene = "project-branch"
            let app = launch(.project("P3"), until: "Checkout redesign", dark: dark, scene)
            show(app, "The agent can push only on a project that lands directly into main.",
                 between: 260, and: 640, "\(scene)-delivery")
            expect(app, "The agent doesn’t push to main: Orbit lands its branch once the work is accepted.", "\(scene)-platform")
            picture(app, "how-it-runs-project-branch", dark: dark)
            app.terminate()
        }
    }

    // MARK: the task row (§10.9)

    func test3TasksWaitingToBeSeenOnMain() throws {
        for dark in appearances {
            let scene = "task-rows"
            let app = launch(.project("P1"), until: "Payments gateway rollout", dark: dark, scene)
            show(app, "Waiting to be seen on main · 9f1c2ab", between: 200, and: 560, scene)
            expect(app, "Retry the export on a timeout", scene)
            expect(app, "On main", scene)
            picture(app, "task-rows", dark: dark)
            app.terminate()
        }
    }

    // MARK: the two items (§10.7) and their doors (§10.8)

    /// C2: work that reached main without the owner's confirmation — its own header and title, the
    /// receipt, Accept leading — and the press, which goes to the item's own door.
    func test4TheLandedCardIsAccepted() throws {
        for dark in appearances {
            let scene = "landed"
            let app = launch(.session("C2"), until: "Reached main without your confirmation", dark: dark, scene)
            // The whole card, down to its foot, above the composer.
            show(app, "Owner: you · waiting 2h", between: 300, and: 720, scene)
            expect(app, "You accept the work as it landed, and this item closes.", scene)
            // The card's own header: the kind word, not an escalation's. (The bar above may name C1's
            // escalation — it is another conversation's.)
            let header = app.staticTexts.matching(NSPredicate(format: "label == %@ OR value == %@",
                                                              "Landed without your confirmation",
                                                              "Landed without your confirmation")).firstMatch
            XCTAssertTrue(header.waitForExistence(timeout: 10), "\(scene): the card's header is not its kind word")
            expect(app, "7d3e9b01c2a4 is on main · seen by Orbit", scene)
            expectNo(app, "Mark as handled", scene)
            picture(app, "card-landed-without-confirmation", dark: dark)

            let accept = buttons(app, beginning: "Accept").first
            if let accept {
                press(accept)
                settle(3)
                let sent = requestsLog().split(separator: "\n").filter { $0.contains("BODY /api/projects/P2/open-items/L1/accept") }
                note("accept: \(sent)")
                XCTAssertFalse(sent.isEmpty, "Accept did not reach the item's own door")
                expect(app, "Accepted", "\(scene)-receipt")
                picture(app, "card-landed-accepted", dark: dark)
            } else {
                XCTFail("\(scene): no Accept")
            }
            app.terminate()
        }
    }

    /// C1: work not seen on its line, handed to the owner — its title under the hand-over heading, the
    /// server's doors with Observe again among them; the question Observe again asks; and, once asked,
    /// the observation handling the item in its own words.
    func test5ObserveAgainAsksWhyAndTheObservationShows() throws {
        for dark in appearances {
            let scene = "unobserved"
            let app = launch(.session("C1"), until: "Not on main yet: Ship the delivery mode picker", dark: dark, scene)
            show(app, "Its commit was not found on the line · delivered 9f1c2ab7e4d0", between: 120, and: 760, scene)
            expect(app, "Now yours — the coordinator handed it over", scene)
            expect(app, "An observation of the line is queued with your reason.", scene)
            picture(app, "card-landing-unobserved", dark: dark)

            guard let observe = buttons(app, beginning: "Observe again").first else {
                XCTFail("\(scene): no Observe again")
                continue
            }
            press(observe)
            settle(1.2)
            expect(app, "Look at the line again?", "\(scene)-panel")
            expect(app, "A runner fetches the line and looks for each finished task’s commit on it.", "\(scene)-panel")
            guard let reason = field(app, "Why look again?") else {
                write(app.debugDescription, "no-field-\(scene).txt")
                XCTFail("\(scene): the panel has no reason field")
                continue
            }
            bring(app, reason, between: 120, and: 720, "\(scene)-field")
            press(reason)
            settle(0.6)
            reason.typeText("I pushed the rebased commit to main by hand")
            settle(0.8)
            picture(app, "observe-panel", dark: dark)

            // The panel's own Observe again: the lower of the two presses with that word.
            let presses = buttons(app, beginning: "Observe again").filter(\.exists)
            guard let confirm = presses.max(by: { $0.frame.minY < $1.frame.minY }) else {
                XCTFail("\(scene): the panel has no Observe again")
                continue
            }
            press(confirm)
            settle(3)
            let sent = bodies("/api/projects/P1/integration/observe")
            note("observe bodies: \(sent)")
            XCTAssertTrue(sent.contains { $0.hasSuffix("{\"reason\": \"I pushed the rebased commit to main by hand\"}") },
                          "Observe again did not send the trimmed reason to the project's door: \(sent)")
            show(app, "Observing main… — queued · asked", between: 120, and: 760, "\(scene)-handling")
            expect(app, "I pushed the rebased commit to main by hand", "\(scene)-reason")
            expectNo(app, "the rerun of the landing", "\(scene)-handling")
            picture(app, "card-observing", dark: dark)
            app.terminate()
        }
    }

    // MARK: the fifth owner item (owner 2026-10-28, §7.6 V13)

    #if os(iOS)
    /// The needs-you bar over the session list: the oldest thing waiting is the fifth kind — its word
    /// on the first line, the project on the second.
    func test6TheNeedsYouBarNamesIt() throws {
        for dark in appearances {
            let scene = "needs-you"
            let app = launch(.page("list"), until: "Landed without your confirmation", dark: dark, scene)
            let bar = app.buttons["needs-you-bar"]
            if bar.waitForExistence(timeout: 20) {
                note("\(scene): bar says \(bar.label.debugDescription)")
                XCTAssertTrue(bar.label.hasPrefix("Landed without your confirmation, Refund service"),
                              "the bar does not name the fifth kind and its project: \(bar.label)")
            } else {
                write(app.debugDescription, "no-bar-\(scene).txt")
                XCTFail("\(scene): no needs-you bar")
            }
            picture(app, "needs-you-bar", dark: dark)
            app.terminate()
        }
    }
    #endif

    /// The projects list: the fifth kind's chip on its project's row.
    func test7TheProjectsListChip() throws {
        for dark in appearances {
            let scene = "projects"
            let app = launch(.page("projects"), until: "Refund service", dark: dark, scene)
            #if os(iOS)
            expect(app, "Needs you · Landed without your confirmation · 2h", scene, timeout: 20)
            #else
            // The Mac's list column cuts a long chip at its end, as it does every chip that long.
            expect(app, "Needs you · Landed without your confirm", scene, timeout: 20)
            #endif
            picture(app, "projects-list", dark: dark)
            app.terminate()
        }
    }

    // MARK: the owner confirmation card (§10.5 O-L2)

    func test8TheConfirmationCardSaysTheAgentPushesIt() throws {
        for dark in appearances {
            let scene = "owner-confirmation"
            let app = launch(.session("S7"), until: "Publish the release notes", dark: dark, scene)
            openPreview(app, scene)
            show(app, "Pushed to main by the agent; Orbit records it once it sees the commit there",
                 between: 200, and: 640, scene)
            expect(app, "confirming doesn’t merge it", scene)
            picture(app, "owner-confirmation-agent-pushed", dark: dark)
            app.terminate()
        }
    }
}
