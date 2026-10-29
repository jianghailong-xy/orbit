import XCTest

// Evidence probe (see ../../../README.md). Opens conversation C1, whose agent waits on two single-task
// create cards, in the iPhone and Mac apps built from the real shared sources against stub.py, light and
// dark. It photographs the card nothing would start (Create and start right after Create it) and the card
// a startNow create raises (no Create and start), presses Create and start on the first and Create it on
// the second, and reads back from the stub what each press sent. Every state a picture is meant to show
// is asserted first, so a run that never reached it fails rather than leaving a picture of something else.
final class CreateAndStartShotTests: ProbeCase {

    #if os(iOS)
    private let platform = "ios"
    /// Where a card's answers are brought before a picture: low enough that the card's head is not under
    /// the navigation bar, high enough to be clear of the composer.
    private let band: (CGFloat, CGFloat) = (420, 760)
    #else
    private let platform = "mac"
    private let band: (CGFloat, CGFloat) = (330, 620)
    #endif

    private let appearances = [false, true]

    /// The heads of the two cards' consequence lines (stub.py): ap2's forecast, which nothing would start
    /// ("— nothing will trigger it" is drawn under it, on a line of its own), and ap1's, filed with
    /// startNow.
    private let manualStart = "1 needs a manual start"
    private let startingNow = "1 starts running within the minute"

    // MARK: helpers

    /// Every element that reads these words. A consequence row combines its two lines into one
    /// accessibility element: on the phone its label holds both; on the Mac the words are a text's
    /// value. Never ask every element on the Mac for its value: run 40827181630 lost the app on that
    /// query, right after a press the app had drawn correctly.
    private func texts(_ app: XCUIApplication, containing words: String) -> [XCUIElement] {
        var found = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", words)).allElementsBoundByIndex
        #if os(macOS)
        if !found.contains(where: \.exists) {
            found = app.staticTexts.matching(NSPredicate(format: "value CONTAINS %@", words)).allElementsBoundByIndex
        }
        #endif
        return found.filter(\.exists)
    }

    /// Words that must be on screen for the picture about to be taken.
    private func expect(_ app: XCUIApplication, _ words: String, _ name: String, timeout: TimeInterval = 15) {
        if waitUntil(timeout, { !self.texts(app, containing: words).isEmpty }) {
            note("\(name): shows \(words.debugDescription)")
        } else {
            write(app.debugDescription, "missing-\(name).txt")
            XCTFail("\(name): \(words.debugDescription) never showed")
        }
    }

    /// Words that must NOT be on screen.
    private func expectNo(_ app: XCUIApplication, _ words: String, _ name: String) {
        if !texts(app, containing: words).isEmpty {
            write(app.debugDescription, "unexpected-\(name).txt")
            XCTFail("\(name): \(words.debugDescription) is on screen")
        } else {
            note("\(name): no \(words.debugDescription)")
        }
    }

    /// The picture, named by platform, scene and appearance: the screen on the phone, the window on the
    /// Mac.
    private func picture(_ app: XCUIApplication, _ scene: String, dark: Bool) {
        shot(app, "\(platform)-\(scene)-\(dark ? "dark" : "light")")
    }

    /// Buttons whose whole label is these words.
    private func buttons(_ app: XCUIApplication, labeled words: String) -> [XCUIElement] {
        app.buttons.matching(NSPredicate(format: "label == %@ OR title == %@", words, words))
            .allElementsBoundByIndex.filter(\.exists)
    }

    /// How many lines the stub has logged: what a launch's presses are read after.
    private func logMark() -> Int {
        requestsLog().split(separator: "\n").count
    }

    /// What the stub was sent for one card since `mark`: `BODY`, the body as it decoded it (sorted keys),
    /// or `RAW`, the bytes as they came.
    private func sent(_ kind: String, _ approval: String, since mark: Int) -> [String] {
        let door = "\(kind) /api/sessions/C1/approvals/\(approval)/decision "
        return requestsLog().split(separator: "\n").dropFirst(mark).map(String.init).compactMap { line in
            line.range(of: door).map { String(line[$0.upperBound...]) }
        }
    }

    /// The Create it that Create and start comes right after: under it on the phone, where a card's
    /// answers stack, and beside it on the Mac, where they share a row.
    private func createIt(before offered: XCUIElement, in app: XCUIApplication) -> XCUIElement? {
        let target = offered.frame
        return buttons(app, labeled: "Create it").first { candidate in
            let f = candidate.frame
            #if os(iOS)
            return abs(f.minX - target.minX) < 2 && target.minY > f.maxY && target.minY - f.maxY < 24
            #else
            return abs(f.midY - target.midY) < 4 && target.minX > f.maxX && target.minX - f.maxX < 24
            #endif
        }
    }

    /// The consequence line nearest above `element`: the line of the card it is drawn in.
    private func line(above element: XCUIElement, in app: XCUIApplication) -> String? {
        let y = element.frame.minY
        return [manualStart, startingNow].flatMap { words -> [(String, CGRect)] in
            texts(app, containing: words).map { (words, $0.frame) }
        }
        .filter { $0.1.maxY <= y }
        .max { $0.1.minY < $1.1.minY }?.0
    }

    // MARK: the two cards

    /// C1's two cards. The one nothing would start offers Create and start, right after its Create it;
    /// the one a startNow create raises does not. Create and start sends the yes with startAfterCreate and
    /// nothing else; Create it sends the yes with no startAfterCreate at all.
    func test0CreateAndStartIsOfferedWhereNothingWouldStartTheTaskAndSendsTheStart() throws {
        for dark in appearances {
            let scene = dark ? "dark" : "light"
            let app = launch(.session("C1"), until: "Create and start", dark: dark, scene)
            let mark = logMark()

            // ① Both cards: one Create and start, right after the Create it of the card nothing would start.
            expect(app, "Create 1 task?", scene)
            let offered = buttons(app, labeled: "Create and start")
            guard offered.count == 1, let start = offered.first else {
                write(app.debugDescription, "offered-\(scene).txt")
                XCTFail("\(scene): \(offered.count) Create and start in the conversation, not 1")
                app.terminate()
                continue
            }
            bring(app, start, between: band.0, and: band.1, "\(scene)-start")
            if let createIt = createIt(before: start, in: app) {
                note("\(scene): Create it at \(createIt.frame), Create and start at \(start.frame)")
            } else {
                write(app.debugDescription, "placement-\(scene).txt")
                XCTFail("\(scene): Create and start (\(start.frame)) is not right after a Create it "
                            + "(\(buttons(app, labeled: "Create it").map(\.frame)))")
            }
            XCTAssertEqual(line(above: start, in: app), manualStart,
                           "\(scene): Create and start is not on the card nothing would start")
            note("\(scene): Create it buttons in the tree: \(buttons(app, labeled: "Create it").count)")
            picture(app, "01-both-cards", dark: dark)

            // ② Create and start: its card goes, and the stub was sent the yes with the start, nothing else.
            press(start)
            settle(3)
            XCTAssertEqual(sent("BODY", "ap2", since: mark), [#"{"behavior": "allow", "startAfterCreate": true}"#],
                           "\(scene): Create and start did not send exactly the yes with startAfterCreate")
            note("\(scene): Create and start sent \(sent("RAW", "ap2", since: mark))")
            XCTAssertEqual(sent("BODY", "ap1", since: mark), [], "\(scene): the other card was answered too")
            XCTAssertTrue(waitUntil(10) { self.buttons(app, labeled: "Create and start").isEmpty },
                          "\(scene): the card answered with Create and start is still there")

            // ③ Left: the card a startNow create raises, with one yes and no Create and start.
            if !waitUntil(8, { !self.texts(app, containing: self.startingNow).isEmpty }) {
                note("\(scene): the startNow card not built yet; scrolling")
            }
            bring(app, texts(app, containing: startingNow).first ?? element(app, containing: startingNow),
                  between: 120, and: band.1, "\(scene)-startnow")
            expect(app, startingNow, scene, timeout: 10)
            let left = buttons(app, labeled: "Create it")
            XCTAssertEqual(left.count, 1, "\(scene): \(left.count) Create it left, not 1")
            XCTAssertTrue(buttons(app, labeled: "Create and start").isEmpty,
                          "\(scene): the card a startNow create raises offers Create and start")
            expectNo(app, manualStart, scene)
            guard let only = left.first else {
                write(app.debugDescription, "no-create-it-\(scene).txt")
                app.terminate()
                continue
            }
            bring(app, only, between: band.0, and: band.1, "\(scene)-create-it")
            XCTAssertEqual(line(above: only, in: app), startingNow, "\(scene): the Create it left is not the startNow card's")
            picture(app, "02-startnow-card", dark: dark)

            // ④ Create it: its card goes, and the stub was sent the yes with no startAfterCreate in it.
            press(only)
            settle(3)
            XCTAssertEqual(sent("BODY", "ap1", since: mark), [#"{"behavior": "allow"}"#],
                           "\(scene): Create it did not send exactly the plain yes")
            let raw = sent("RAW", "ap1", since: mark)
            note("\(scene): Create it sent \(raw)")
            XCTAssertFalse(raw.isEmpty || raw.contains { $0.contains("startAfterCreate") },
                           "\(scene): Create it's request carries startAfterCreate: \(raw)")
            XCTAssertTrue(waitUntil(10) { self.buttons(app, labeled: "Create it").isEmpty },
                          "\(scene): the card answered with Create it is still there")
            app.terminate()
        }
    }
}
