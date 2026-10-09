import XCTest

// TEMPORARY evidence probe (see NOTES.md). The SESSION LIST's second line, on the iPhone and on
// the Mac, against stub.py:
//
//   on  — S1's row carries the server's recap under its own label ("Recap · <clock>"), S2's row the
//         raw last reply it always carried, S3 the live "Running Bash…" that outranks both, S4 a
//         recap old enough that the label carries the day; then Settings → Sessions and the
//         "Session recaps" switch those labels answer to.
//   off — the same stub started with `--recaps-off`, which is the same account with that switch
//         off: S1 and S4 fall back to their raw last reply, no "Recap · " label is drawn anywhere,
//         and S3 — live — reads exactly as it did.
//
// Which pass this run is comes from the run script (`TEST_RUNNER_RECAPS_OFF`, reaching the runner as
// `RECAPS_OFF`), because the stub's own mode is fixed when the script starts it: one decision, so a
// pass cannot photograph one mode while its assertions claim the other.
final class RecapShotTests: ProbeCase {
    /// The four strings this probe's claim is made of, each copied from where the app gets it.
    /// `label` is `SessionLine.recapWord` + the separator `SessionLine.recapLabel` builds; `running`
    /// is `SessionLine.make`'s "Running \(tool)…" for the stub's `lastToolUse`; the three sentences
    /// are the stub's own fixture text, served as `recapText` / `lastAssistantText`.
    private let recapRow = "Recap on the session list row"
    private let recapText = "Moved the recap onto the session list row; the three states are covered by tests."
    private let replyOfTheRecappedRow = "Committed the row change."
    private let replyOnlyRow = "Pushed the drawer fix."
    private let otherDayRecap = "Tightened the second line's spacing; the badge waits for the design."
    private let otherDayReply = "Adjusted the row spacing."
    private let label = "Recap · "
    private let running = "Running Bash…"
    /// `SettingsCopy.sessionRecaps` and a tail of its hint, from the same file the views read.
    private let switchTitle = "Session recaps"
    private let switchHintTail = "in place of its raw last reply"

    #if os(iOS)
    func testIPhoneShowsTheRecapOnTheSessionList() { drive("ios") }
    #endif

    #if os(macOS)
    func testMacShowsTheRecapOnTheSessionList() { drive("mac") }
    #endif

    /// Where the run's shots are collected (`TEST_RUNNER_SHOTS_DIR` reaches the runner as
    /// `SHOTS_DIR`). The app writes the Mac window pictures here; the runner only names them.
    private var shotsDir: String {
        ProcessInfo.processInfo.environment["SHOTS_DIR"] ?? "/tmp"
    }

    /// Whether the stub behind this pass was started with `--recaps-off`.
    private var recapsOff: Bool { ProcessInfo.processInfo.environment["RECAPS_OFF"] != nil }

    private func drive(_ platform: String) {
        if recapsOff {
            listWithRecapsOff(platform)
        } else {
            listWithRecap(platform)
            settings(platform)
        }
        write(requestsLog(), "\(platform)-requests.txt")
    }

    /// One launch, landing on the page `settings` names — the list, or Settings. The Mac app writes
    /// its own picture of the window into the shots directory the run uploads (`-probe.shot`),
    /// beside the one the UI test takes: the two are kept because either can come back empty on a
    /// runner whose UI-test sandbox or window server misbehaves, and the pair makes that visible
    /// instead of silent.
    private func open(_ name: String, until label: String, settings: Bool = false) -> XCUIApplication {
        var extra: [String] = []
        if settings { extra.append("-probe.settings") }
        #if os(macOS)
        extra += ["-probe.windowLog", "/tmp/recap-window-\(name).log",
                  "-probe.shot", "\(shotsDir)/mac-window-\(name).png"]
        #endif
        return launch(until: label, timeout: 120, extra: extra, name)
    }

    /// A picture with the tree beside it. A prompt that came up after the launch must not be in the
    /// picture; a window that went away is a note rather than the end of the pass — `screenshot()`
    /// on one that does not exist throws, and that took the tail of a pass with it once already.
    private func picture(_ app: XCUIApplication, _ name: String) {
        dismissSystemPrompts()
        settle(1.2)
        guard app.windows.firstMatch.exists else { note("\(name): no window to photograph"); return }
        shot(app, name)
        write(app.debugDescription, "tree-\(name).txt")
    }

    /// Walk `element` into a band a picture can hold: the Mac's Settings form scrolls inside the
    /// middle column — its ~677-point window shows the Account card and part of the next group —
    /// and the phone's sheet scrolls too. The same drag/scroll `bring` performs for both.
    private func band(_ app: XCUIApplication, _ element: XCUIElement, _ top: CGFloat, _ bottom: CGFloat,
                      _ name: String) {
        guard app.windows.firstMatch.exists else { note("\(name): no window to scroll in"); return }
        bring(app, element, between: top, and: bottom, name)
    }

    /// Whether ONE element carries all of these words within a few seconds — the on-one-row claim,
    /// which is also how its negative is asked (expected to find nothing).
    private func holds(_ app: XCUIApplication, _ words: [String]) -> Bool {
        waitUntil(5) { element(app, containingAll: words).exists }
    }

    /// The list as the recap switch ON draws it.
    private func listWithRecap(_ platform: String) {
        let app = open("\(platform)-list-with-recap", until: recapRow)
        guard appears(app, recapRow, timeout: 5) else { return }
        note("\(platform): \(recapRow) is up; the rows' second lines follow")

        // S1: the label and the recap sentence on ONE element. The row's second line is a single
        // text run — `AgentSessionRow.lineText` concatenates the label and the text — so one element
        // carrying both is the claim "this label belongs to this row", not merely "both are on
        // screen".
        note("\(platform): S1 carries the label and the recap text on one row \(holds(app, [label, recapText]) ? "yes" : "NO")")
        // …and NOT the raw reply it would fall back to. That pairing is what the switch-off pass
        // photographs; finding it here would mean the row is drawn from the reply, not the recap.
        note("\(platform): S1 does NOT show its raw reply beside the label \(holds(app, [label, replyOfTheRecappedRow]) ? "IT DOES" : "confirmed")")
        // The sentence itself, and not just the word "Recap" of the row's own title.
        note("\(platform): S1's recap sentence \(appears(app, "the three states are covered by tests", timeout: 3) ? "shown" : "MISSING")")

        // S2: the row the feature never touched — a raw reply, no label.
        note("\(platform): S2 shows its raw reply \(appears(app, replyOnlyRow, timeout: 3) ? "shown" : "MISSING")")
        note("\(platform): S2 carries no label \(holds(app, [label, replyOnlyRow]) ? "IT DOES" : "confirmed")")

        // S3: live outranks the recap — this row HAS a recap (the stub serves it the same one as
        // S1) and still says what it is doing.
        note("\(platform): S3 shows \(running) \(appears(app, running, timeout: 3) ? "shown" : "MISSING")")
        note("\(platform): S3 is NOT drawn as its recap \(holds(app, [running, recapText]) ? "IT IS" : "confirmed")")

        // S4: a recap from another day — the same label, whose dated face (`Recap · Thu, Aug 6, …`)
        // is the device's own locale and zone, which is why the claim is on the text and the word.
        note("\(platform): S4's older-day recap carries the label too \(holds(app, [label, otherDayRecap]) ? "yes" : "NO")")
        picture(app, "\(platform)-list-with-recap")
        // Ended before the next launch: on the Mac the app is the thing writing its own picture to
        // `-probe.shot`, and the last write must belong to the pass that just photographed, not to
        // an instance the next launch pushed aside.
        app.terminate()
    }

    /// The same list with the account's Session recaps switch off: the stub's `--recaps-off` pass,
    /// where `GET users/me` answers `preferences.recaps: false`. The one line that changes is the
    /// recap; nothing above it on a row moves, so the live row must read exactly as it did.
    private func listWithRecapsOff(_ platform: String) {
        let app = open("\(platform)-list-with-recaps-off", until: recapRow)
        guard appears(app, recapRow, timeout: 5) else { return }
        note("\(platform): \(recapRow) is up; the fallback its line falls back to follows")

        // The raw replies the rows carried before the recap existed, back in place of it.
        note("\(platform): S1 falls back to its raw reply \(appears(app, replyOfTheRecappedRow, timeout: 3) ? "shown" : "MISSING")")
        note("\(platform): S4 falls back to its raw reply \(appears(app, otherDayReply, timeout: 3) ? "shown" : "MISSING")")
        // The label is what the switch removes, so the claim is about the whole list and it FAILS
        // the pass rather than noting it: the picture's entire point is that no row draws one, and a
        // picture claiming otherwise is a picture of the wrong mode.
        let stray = element(app, containing: label).exists
        note("\(platform): no \(label) label anywhere \(stray ? "FOUND ONE" : "confirmed")")
        if stray { XCTFail("\(platform): a Recap label is drawn with the switch off") }
        // Unchanged neighbours: the reply-only row, and the live row the switch never gates.
        note("\(platform): S2 still shows its raw reply \(appears(app, replyOnlyRow, timeout: 3) ? "shown" : "MISSING")")
        note("\(platform): S3 still shows \(running) \(appears(app, running, timeout: 3) ? "shown" : "MISSING")")
        picture(app, "\(platform)-list-with-recaps-off")
        app.terminate()
    }

    /// Settings → Sessions, where the switch the row answers to is drawn. Both sides read the same
    /// `me` (`UserPreferences.recaps`, absent means on), which is why this picture belongs beside
    /// the two list pictures rather than in a probe of its own.
    private func settings(_ platform: String) {
        let app = open("\(platform)-settings-session-recaps", until: switchTitle, settings: true)
        guard appears(app, switchTitle, timeout: 5) else { return }
        note("\(platform): the switch's hint \(appears(app, switchHintTail, timeout: 3) ? "shown" : "MISSING")")
        // Scrolled into view, never pressed: the probe reads the switch, it does not flip it — a flip
        // would PATCH the stub's account, and the pass that photographs the OFF state is the one
        // started with the flag, not a tap.
        // The Mac's form lives in the split view's MIDDLE column (the source list is folded away, so
        // it is the window's left third) — the scroll has to land there, not in the detail pane.
        macScrollX = 0.2
        band(app, element(app, containing: switchTitle), 120, 480, "\(platform)-settings-session-recaps")
        picture(app, "\(platform)-settings-session-recaps")
        app.terminate()
    }
}
