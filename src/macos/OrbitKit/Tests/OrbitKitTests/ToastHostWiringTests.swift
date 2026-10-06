import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so nothing here compiles the app shell — CI's `client.yml` does.
/// These hold the app to the toast system's rules where `ToastFeedTests` can't reach: every toast goes
/// through the feed, one operation's toasts share a key the app scopes to its session, an approval
/// answered anywhere comes down, and the host draws what waits for you above what passes.
final class ToastHostWiringTests: XCTestCase {
    private struct SourceMissing: Error, CustomStringConvertible {
        let path: String
        var description: String {
            "OrbitApp/Sources/OrbitApp/\(path) wasn't found above this test. If it moved, point this check "
                + "at its new home — don't delete the check."
        }
    }

    /// Found by walking up from this file; never a skip, so the check can't go quiet when a file moves.
    private func source(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
                .appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
            }
            dir.deleteLastPathComponent()
        }
        throw SourceMissing(path: relative)
    }

    /// From the first `start` through the next `end` after it.
    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex),
                                  "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    /// The text without its comment lines, which are free to talk about what the code must not do.
    private func code(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    /// The old host had one slot, so a failure you hadn't read was replaced by the next "Link copied".
    /// Every toast goes through the feed now, which pins what waits for you.
    func testEveryToastGoesThroughTheFeed() throws {
        let model = code(try source("AppModel.swift"))
        let show = try slice(model, from: "func showToast(", to: "\n    }")
        XCTAssertTrue(show.contains("toasts.post(item, at: Date())"), show)
        XCTAssertFalse(model.contains("var toast: Toast?"), "the single slot is gone")
        XCTAssertTrue(model.contains("private(set) var toasts = ToastFeed()"))
    }

    /// A console's operation key is scoped to its session, so one session's merge result can't take
    /// another session's progress pill.
    func testAConsolesKeysAreScopedToItsSession() throws {
        let model = code(try source("AppModel.swift"))
        XCTAssertTrue(model.contains(#"key: request.key.map { "\($0):\(sessionID ?? "")" }, inProgress: request.inProgress)"#))
    }

    /// A retried merge's pill and the result the registry follows it to carry the same key, so the
    /// result lands where the pill stood instead of as a second toast.
    func testAProgressPillAndItsResultShareTheOperationsKey() throws {
        let worktree = code(try source("WorktreeModel.swift"))
        let retry = try slice(worktree, from: "private func surfaceRetry(", to: "static func resultCard(")
        XCTAssertTrue(retry.contains(#"key: "merge", inProgress: true"#), retry)
        XCTAssertTrue(retry.contains(#"key: "commit", inProgress: true"#), retry)
        let results = try slice(worktree, from: "static func resultCard(", to: "private static func failure(")
        let merge = try slice(results, from: "case .merge:", to: "case .commit:")
        XCTAssertEqual(merge.components(separatedBy: #"key: "merge""#).count - 1, 4,
                       "recovery, merged, conflict and error each take the merge's place")
        let commit = String(results[try XCTUnwrap(results.range(of: "case .commit:")).lowerBound...])
        XCTAssertEqual(commit.components(separatedBy: #"key: "commit""#).count - 1, 3,
                       "error, committed and no-change each take the commit's place")
    }

    /// An approval card stands in for a banner, and the approval can be answered anywhere — another
    /// device included — so the snapshot that notices takes the card down.
    func testAnAnsweredApprovalComesDown() throws {
        let model = code(try source("AppModel.swift"))
        XCTAssertTrue(model.contains("toasts.clearApprovals(stillWaiting: needsYou)"))
    }

    /// What waits for you is drawn above what passes, its diagnostic can be selected and copied, and a
    /// pill that names nothing doesn't take the touches meant for the page under it.
    func testTheHostDrawsWhatWaitsAboveWhatPasses() throws {
        let host = code(try source("Views/ToastHost.swift"))
        let column = try slice(host, from: "VStack(alignment: wide ? .trailing : .center, spacing: 8) {", to: ".frame(maxWidth:")
        let pinned = try XCTUnwrap(column.range(of: "pinned"))
        let transient = try XCTUnwrap(column.range(of: "model.toasts.transient"))
        XCTAssertLessThan(pinned.lowerBound, transient.lowerBound)
        XCTAssertTrue(host.contains(".textSelection(.enabled)"))
        XCTAssertTrue(host.contains("PlatformPasteboard.copyString(detail)"))
        XCTAssertTrue(host.contains(".allowsHitTesting(toast.level == .result || toast.opens)"))
    }

    /// A conflict is actionable from the pinned card even when the registry evicted its console;
    /// the branch and target must survive every handoff to the worktree bar's existing resolver.
    func testTheConflictCardResolvesThroughItsSessionsConsole() throws {
        let worktree = code(try source("WorktreeModel.swift"))
        let conflict = try slice(worktree, from: #"case "conflict":"#, to: #"case "error":"#)
        XCTAssertTrue(conflict.contains(#"message: "Couldn't merge into \(target)""#), conflict)
        XCTAssertTrue(conflict.contains("detail: Self.trimmed(detail.mergeError)"), conflict)
        XCTAssertTrue(conflict.contains("WorktreeBarLogic.conflictTarget("), conflict)
        XCTAssertTrue(conflict.contains("mergeTarget: detail.mergeTarget, targets: detail.mergeTargets ?? []"), conflict)
        XCTAssertTrue(conflict.contains("agentDefaultTarget: detail.agent?.defaultMergeTarget"), conflict)
        XCTAssertTrue(conflict.contains("ToastMergeConflict(branch: $0, target: target)"), conflict)
        XCTAssertTrue(conflict.contains(#"tone: .error, key: "merge""#), conflict)

        let model = code(try source("AppModel.swift"))
        XCTAssertTrue(model.contains("mergeConflict: request.mergeConflict"))
        let show = try slice(model, from: "func showToast(", to: "\n    }")
        XCTAssertTrue(show.contains("mergeConflict: mergeConflict"), show)
        let resolve = try slice(model, from: "func resolveToastConflict(", to: "\n    }")
        XCTAssertTrue(resolve.contains("toast.sessionID"), resolve)
        XCTAssertTrue(resolve.contains("toast.mergeConflict"), resolve)
        XCTAssertTrue(resolve.contains("registry.resolveInSession(sessionID: sessionID"), resolve)
        XCTAssertTrue(resolve.contains("branch: conflict.branch, target: conflict.target"), resolve)

        let registry = code(try source("ConsoleRegistry.swift"))
        let handoff = try slice(registry, from: "func resolveInSession(", to: "\n    }")
        XCTAssertTrue(handoff.contains("model(for: sessionID).worktree.resolveInSession(branch: branch, target: target)"), handoff)
        let host = code(try source("Views/ToastHost.swift"))
        XCTAssertTrue(host.contains(#"Button("Resolve in session") { model.resolveToastConflict(toast.id) }"#))
    }

    /// Touch-down cancels the dwell immediately; lift/cancel/unmount restarts it without replacing
    /// the swipe's threshold or taking the copy Button's tap or a pass-through pill's touch.
    func testTransientTouchHoldPreservesTapAndSwipe() throws {
        let host = code(try source("Views/ToastHost.swift"))
        XCTAssertTrue(host.contains("import UIKit.UIGestureRecognizerSubclass"))
        let transient = try slice(host, from: "private func transient(", to: "private func resultCard(")
        XCTAssertTrue(transient.contains("ToastTouchHold { holding in"), transient)
        XCTAssertTrue(transient.contains("holding ? model.holdToast(toast.id) : model.releaseToast(toast.id)"), transient)
        XCTAssertTrue(transient.contains(".simultaneousGesture(swipeAway(toast.id))"), transient)
        XCTAssertTrue(transient.contains(".allowsHitTesting(toast.level == .result || toast.opens)"), transient)
        let swipe = try slice(host, from: "private func swipeAway(", to: "\n    }")
        XCTAssertTrue(swipe.contains("DragGesture(minimumDistance: 10, coordinateSpace: .global)"), swipe)
        XCTAssertTrue(swipe.contains(".onChanged { value in"), swipe)
        XCTAssertTrue(swipe.contains("model.dismissToast(id)"), swipe)

        let observer = try slice(host, from: "private struct ToastTouchHold:", to: "private struct ToastPill:")
        XCTAssertTrue(observer.contains("isUserInteractionEnabled = false"), observer)
        XCTAssertTrue(observer.contains("window?.addGestureRecognizer(observer)"), observer)
        XCTAssertTrue(observer.contains("observer.cancelsTouchesInView = false"), observer)
        XCTAssertTrue(observer.contains("observer.delaysTouchesBegan = false"), observer)
        XCTAssertTrue(observer.contains("observer.delaysTouchesEnded = false"), observer)
        XCTAssertTrue(observer.contains("view.point(inside: $0.location(in: view), with: event)"), observer)
        XCTAssertTrue(observer.contains("onHoldingChanged(true)"), observer)
        XCTAssertTrue(observer.contains("onHoldingChanged(false)"), observer)
        XCTAssertTrue(observer.contains("dismantleUIView(_ view: ToastTouchView, coordinator: ()) { view.detach() }"), observer)
        for method in ["touchesEnded(", "touchesCancelled(", "func detach()", "func reset()"] {
            XCTAssertTrue(try slice(observer, from: method, to: "\n        }").contains("release()"), method)
        }
        for state in [".began", ".changed", ".ended", ".recognized"] {
            XCTAssertFalse(observer.contains("state = \(state)"), "an observer must never recognize a gesture")
        }

        let model = code(try source("AppModel.swift"))
        let hold = try slice(model, from: "func holdToast(", to: "\n    }")
        XCTAssertTrue(hold.contains("heldToastID = id"), hold)
        XCTAssertTrue(hold.contains("toastExpiry?.cancel()"), hold)
        let release = try slice(model, from: "func releaseToast(", to: "\n    }")
        XCTAssertTrue(release.contains("if heldToastID == id { heldToastID = nil }"), release)
        XCTAssertTrue(release.contains("expireToastLater(id, after: dwell)"), release)
        // A same-key progress/result update keeps its id and must also keep the finger's hold.
        let show = try slice(model, from: "func showToast(", to: "\n    }")
        XCTAssertTrue(show.contains("else if let dwell = shown.dwell, heldToastID != id"), show)
    }
}
