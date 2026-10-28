import XCTest
import UIKit

// Evidence probe (task 34no050naUDViWDBEtXaZ): the iPhone app's Add Runner sheet deciding the request
// `orbit register` made, against stub.py — Settings → Machines & models → Add Runner, the code typed in,
// then Deny beside Approve; the request denied here, and one already denied; a refusal said in the
// server's words; a runner already of the name, and approving it. The web /enroll page's words have to be
// on screen: a missing word, an Approve where there should be none, or a press that never reaches the stub
// is a failure, not a note.
final class ArdShotTests: ProbeCase {

    private static let code = "ABCDE-FGH23"
    private static let denied = "Request denied"
    private static let deniedDetail =
        "Nothing was added to your account. orbit register in that terminal stops and says the request was denied."
    private static let approved = "Machine registered"
    private static let approvedDetail =
        "devbox is on your account. Go back to the terminal — it finishes setting up by itself."
    private static let nameTaken = "\"devbox\" is already on your account"
    private static let nameTakenDetail = "Approving gives it a new credential and the old one stops working; its "
        + "workspaces and history stay. A different computer with the same name? Deny, then run orbit register "
        + "--name <new-name> on it."
    private static let refusal = "This registration request was denied — run `orbit register` again"

    private func exactButton(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func expectText(_ app: XCUIApplication, _ words: [String], _ name: String) {
        for text in words where !containing(app, text).exists {
            XCTFail("\(name): nothing says \(text)")
        }
    }

    /// Every decision the app has sent the stub so far, in order: the request lines the stub logged
    /// (`"POST /api/runners/device/ABCDE-FGH23/deny HTTP/1.1" 201 -`), as `POST /api/…/deny`.
    private func decisions() -> [String] {
        requestsLog().split(separator: "\n").compactMap { line -> String? in
            guard let start = line.range(of: "\"POST /api/runners/device/"),
                  let end = line.range(of: " HTTP/", range: start.upperBound..<line.endIndex) else { return nil }
            return String(line[line.index(after: start.lowerBound)..<end.lowerBound])
        }
    }

    /// Launch onto Settings with the stub set to `state`, open Machines & models and then Add Runner, type
    /// the code, and wait for the machine it names.
    private func lookUp(state: String? = nil, dark: Bool = false, _ name: String) -> XCUIApplication {
        resetStub()
        if let state { setStub(state) }
        let app = XCUIApplication()
        app.launchArguments = ["-orbit.instance", "http://127.0.0.1:8765", "-ApplePersistenceIgnoreState", "YES",
                               "-probe.fresh"] + (dark ? ["-dark"] : [])
        app.launch()
        let machines = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Machines & models'")).firstMatch
        if !machines.waitForExistence(timeout: 30) {
            // Not up yet: press what a person would (the drawer's Settings), then wait again.
            let settings = app.buttons.matching(NSPredicate(format: "label == 'Settings'")).firstMatch
            note("\(name): Settings not up after 30 s; pressing Settings \(describe(settings))")
            if settings.exists { settings.tap() }
        }
        guard machines.waitForExistence(timeout: 30) else {
            write(app.debugDescription, "missing-settings-\(name).txt")
            XCTFail("\(name): Settings showed no Machines & models row")
            return app
        }
        bring(app, machines, between: 120, and: 780, missingIsAbove: false, "\(name)-settings-row")
        machines.tap()
        let add = exactButton(app, "Add Runner")
        guard add.waitForExistence(timeout: 30) else {
            write(app.debugDescription, "missing-add-\(name).txt")
            XCTFail("\(name): Machines & models showed no Add Runner")
            return app
        }
        bring(app, add, between: 120, and: 780, missingIsAbove: false, "\(name)-add")
        add.tap()
        guard appears(app, "Waiting for a new runner", timeout: 20) else {
            write(app.debugDescription, "missing-sheet-\(name).txt")
            XCTFail("\(name): Add Runner's sheet never opened")
            return app
        }
        settle(1)
        let field = app.textFields.firstMatch
        bring(app, field, between: 150, and: 760, missingIsAbove: false, "\(name)-code")
        note("\(name): code field \(describe(field))")
        field.tap()
        // Return, as on the keyboard: it puts the keyboard away (and reads the code once more).
        field.typeText(Self.code + "\n")
        guard appears(app, "vmi3337007", timeout: 30) else {
            write(app.debugDescription, "missing-machine-\(name).txt")
            XCTFail("\(name): the code never showed its machine")
            return app
        }
        settle(2)
        return app
    }

    // MARK: Deny

    /// A request still to decide offers Deny beside Approve; while Deny is in flight both wait; then the
    /// sheet says nothing was added, in the web page's words, and offers neither press again.
    func test1APendingRequestOffersDenyAndDenyingSaysNothingWasAdded() {
        let sent = decisions()
        let app = lookUp("pending")
        let approve = exactButton(app, "Approve")
        let deny = exactButton(app, "Deny")
        bring(app, deny, between: 200, and: 820, missingIsAbove: false, "pending-deny")
        note("pending: \(describe(approve)); \(describe(deny))")
        if !approve.exists { XCTFail("pending: no Approve") }
        if !deny.exists { XCTFail("pending: no Deny beside Approve") }
        if containing(app, Self.denied).exists { XCTFail("pending: says denied before anything was pressed") }
        shot("ios-01-pending-approve-and-deny")
        tree(app, "pending")

        // The stub holds the answer 20 s: a query on the simulator takes a second or more, and the first
        // run's 6 s hold ran out between two of them.
        setStub(#"{"hold": 20}"#)
        deny.tap()
        let approveEnabled = approve.isEnabled
        let denyEnabled = deny.isEnabled
        shot("ios-02-deny-in-flight")
        note("in flight: Approve enabled \(approveEnabled), Deny enabled \(denyEnabled)")
        if approveEnabled { XCTFail("in flight: Approve can still be pressed while Deny is in flight") }
        if denyEnabled { XCTFail("in flight: Deny can still be pressed while it is in flight") }

        guard appears(app, Self.denied, timeout: 45) else {
            write(app.debugDescription, "missing-denied.txt")
            return XCTFail("denied: the sheet never said \(Self.denied)")
        }
        settle(1.5)
        expectText(app, [Self.denied, Self.deniedDetail, "devbox", "vmi3337007"], "denied")
        if exactButton(app, "Approve").exists { XCTFail("denied: Approve is still offered") }
        if exactButton(app, "Deny").exists { XCTFail("denied: Deny is still offered") }
        note("denied: decisions sent \(decisions().dropFirst(sent.count))")
        if Array(decisions().dropFirst(sent.count)) != ["POST /api/runners/device/\(Self.code)/deny"] {
            XCTFail("denied: the app sent \(decisions().dropFirst(sent.count)), not one POST …/deny")
        }
        bring(app, containing(app, Self.deniedDetail), between: 250, and: 800, missingIsAbove: false, "denied")
        shot("ios-03-denied")
        tree(app, "denied")
    }

    /// A request already denied — in a browser, say — opens denied: the same words, and no Approve.
    func test2ARequestAlreadyDeniedOpensDeniedWithNoApprove() {
        for dark in [false, true] {
            let name = dark ? "denied-on-open-dark" : "denied-on-open"
            let sent = decisions()
            let app = lookUp(state: #"{"status": "DENIED"}"#, dark: dark, name)
            guard appears(app, Self.denied, timeout: 20) else {
                write(app.debugDescription, "missing-\(name).txt")
                return XCTFail("\(name): a denied request did not open denied")
            }
            expectText(app, [Self.denied, Self.deniedDetail], name)
            for press in ["Approve", "Re-register", "Deny"] where exactButton(app, press).exists {
                XCTFail("\(name): a denied request offers \(press)")
            }
            if decisions() != sent { XCTFail("\(name): opening it sent \(decisions().dropFirst(sent.count))") }
            bring(app, containing(app, Self.deniedDetail), between: 250, and: 800, missingIsAbove: false, name)
            shot(dark ? "ios-05-denied-on-open-dark" : "ios-04-denied-on-open")
            tree(app, name)
            app.terminate()
        }
    }

    /// Denied in a browser after the sheet read it: Approve is refused, the server's sentence shows where
    /// failures do, and the request stays to decide.
    func test3ARefusedApprovalSaysTheServersWords() {
        let sent = decisions()
        let app = lookUp(state: #"{"status": "DENIED", "stale": true}"#, "refused")
        let approve = exactButton(app, "Approve")
        bring(app, exactButton(app, "Deny"), between: 200, and: 820, missingIsAbove: false, "refused-deny")
        approve.tap()
        guard appears(app, Self.refusal, timeout: 20) else {
            write(app.debugDescription, "missing-refusal.txt")
            return XCTFail("refused: the server's sentence never showed")
        }
        settle(1.5)
        note("refused: \(describe(approve)); \(describe(exactButton(app, "Deny")))")
        if !approve.isEnabled { XCTFail("refused: Approve stayed disabled after the refusal") }
        if !exactButton(app, "Deny").isEnabled { XCTFail("refused: Deny stayed disabled after the refusal") }
        if containing(app, Self.approved).exists { XCTFail("refused: says registered though it was refused") }
        if Array(decisions().dropFirst(sent.count)) != ["POST /api/runners/device/\(Self.code)/approve"] {
            XCTFail("refused: the app sent \(decisions().dropFirst(sent.count)), not one POST …/approve")
        }
        bring(app, containing(app, Self.refusal), between: 250, and: 800, missingIsAbove: false, "refused")
        shot("ios-06-refused")
        tree(app, "refused")
    }

    // MARK: the page's other words

    /// A runner of the account already called devbox: the notice says when it was last online, the press
    /// reads Re-register, Deny sits beside it; approving it says the machine is registered.
    func test4ARunnerOfTheSameNameThenApproving() {
        let sent = decisions()
        let app = lookUp(state: #"{"conflict": true, "lastSeenMinutes": 4380}"#, "same-name")
        expectText(app, [Self.nameTaken, "Last online 3d ago. \(Self.nameTakenDetail)"], "same-name")
        let reregister = exactButton(app, "Re-register")
        bring(app, exactButton(app, "Deny"), between: 300, and: 820, missingIsAbove: false, "same-name-deny")
        note("same-name: \(describe(reregister)); \(describe(exactButton(app, "Deny")))")
        if !reregister.exists { XCTFail("same-name: no Re-register") }
        if !exactButton(app, "Deny").exists { XCTFail("same-name: no Deny beside Re-register") }
        for old in ["Re-register machine", "Approve"] where exactButton(app, old).exists {
            XCTFail("same-name: the press reads \(old)")
        }
        shot("ios-07-same-name")
        tree(app, "same-name")

        reregister.tap()
        guard appears(app, Self.approved, timeout: 20) else {
            write(app.debugDescription, "missing-approved.txt")
            return XCTFail("approved: the sheet never said \(Self.approved)")
        }
        settle(1.5)
        expectText(app, [Self.approved, Self.approvedDetail], "approved")
        for press in ["Approve", "Re-register", "Deny"] where exactButton(app, press).exists {
            XCTFail("approved: \(press) is still offered")
        }
        if Array(decisions().dropFirst(sent.count)) != ["POST /api/runners/device/\(Self.code)/approve"] {
            XCTFail("approved: the app sent \(decisions().dropFirst(sent.count)), not one POST …/approve")
        }
        bring(app, containing(app, Self.approvedDetail), between: 250, and: 800, missingIsAbove: false, "approved")
        shot("ios-08-approved")
        tree(app, "approved")
    }
}
