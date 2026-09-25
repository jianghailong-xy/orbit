import Foundation
import XCTest
@testable import OrbitKit

/// The composer's `+` menu says the same words on both ends, and this is the tripwire that keeps it
/// saying them.
///
/// The web composer (`WorkspaceView.tsx`'s `menu.items`) and the native one (`ComposerView.swift`'s
/// `addMenu`, shared by the macOS and iOS targets) draw the same five actions. Nothing in a build
/// catches a label re-worded at one end only — the Swift client and the browser bundle share no
/// compiler — so this check reads both sources and compares them.
///
/// Written 2026-09-13, when the web menu still read `Attach image` / `Upload file` against the
/// native menu's `Image` / `File`: the native side had been shortened on 2026-07-07 (`f7f8adef`,
/// "shorten attach menu labels") and the web side was never told. Both ends now carry one word per
/// action, and the two attach items are offered unconditionally on both ends.
///
/// Deliberately NOT compared: the native-only `Paste image` item below the shared five, the
/// web-only `Shell (session unavailable)` variant, and the gates on Command, Skill and Shell. This
/// end offers Shell plain and gates Command and Skill on its catalog; the web gates Shell too and
/// says why in the label. Those are gating decisions rather than copy, and asserting this end's
/// words against the web's gate would pin the gate instead of the language.
final class ComposerMenuCopyParityTests: XCTestCase {

    private static let webComposer = "src/web/src/components/WorkspaceView.tsx"
    private static let nativeComposer = "src/macos/OrbitApp/Sources/OrbitApp/Views/ComposerView.swift"

    /// The five actions, in the order both menus offer them, spelled the way the web's
    /// `menu.items` keys spell them.
    private static let keys = ["command", "skill", "shell", "image", "file"]

    /// The two that hand the runner a file.
    private static let attachKeys = ["image", "file"]

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        case missing(String)
        case unparsed(String)

        var description: String {
            switch self {
            case .noRepo:
                return "\(ComposerMenuCopyParityTests.webComposer) was not found above this test "
                    + "file. The web composer is one half of a pair; if it moved, move this check "
                    + "with it rather than deleting it."
            case .missing(let relative):
                return "\(relative) was not found. The composer's `+` menu is written at both ends; "
                    + "if one moved, move this check with it rather than deleting it."
            case .unparsed(let what):
                return "the composer menu could not be read out of the source: \(what). Fix the "
                    + "parse — a check that cannot read its subject reports green on nothing."
            }
        }
    }

    /// The repo root, found by walking up from this file until the web composer is under foot.
    /// Not a fixed number of `..` hops: the depth of this file is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(
                atPath: dir.appendingPathComponent(Self.webComposer).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`, for the reason in the type's note above.
        throw ParityError.noRepo
    }

    private func source(_ relative: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ParityError.missing(relative)
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: reading the two ends

    /// The native `+` menu: `addMenu` up to its closing brace. Anything after that brace — the
    /// `.help` line, the iOS pickers — is not the menu and is not read.
    private func nativeMenu() throws -> Substring {
        let source = try source(Self.nativeComposer)
        guard let start = source.range(of: "private var addMenu: some View {") else {
            throw ParityError.unparsed("ComposerView.swift has no `addMenu`")
        }
        guard let end = source.range(of: "\n    }\n", range: start.upperBound..<source.endIndex)
        else {
            throw ParityError.unparsed("`addMenu` in ComposerView.swift has no closing brace")
        }
        return source[start.upperBound..<end.lowerBound]
    }

    /// Native items the web has no counterpart for: the iOS-only tail of `addMenu`. Today exactly
    /// one — a `Paste image` item, because the browser pastes an image into the field instead.
    /// A label listed here is expected NOT to be on the web menu; every other label the native
    /// menu offers has to be one of the five both ends draw.
    private static let nativeOnlyLabels = ["Paste image"]

    /// The labels the native menu offers, in order.
    private func nativeLabels() throws -> [String] {
        var labels: [String] = []
        var rest = try nativeMenu()
        while let open = rest.range(of: "Label(\"") {
            let after = rest[open.upperBound...]
            guard let close = after.firstIndex(of: "\"") else {
                throw ParityError.unparsed("an unterminated Label( in the native `addMenu`")
            }
            labels.append(String(after[after.startIndex..<close]))
            rest = after[close...]
        }
        return labels
    }

    /// The labels both ends are supposed to share, in order: the native menu minus its
    /// platform-only tail.
    private func sharedNativeLabels() throws -> [String] {
        try nativeLabels().filter { !Self.nativeOnlyLabels.contains($0) }
    }

    /// Each web menu item's own source, keyed by the item's key. An item is read from its `key:`
    /// line to its closing `},` — the one two spaces left of the `key:`, wherever the JSX around
    /// the menu happens to indent it; an item that no longer ends that way fails the parse rather
    /// than quietly matching nothing.
    private func webItems() throws -> [String: Substring] {
        let source = try source(Self.webComposer)
        var items: [String: Substring] = [:]
        for key in Self.keys {
            let marker = "key: '\(key)',"
            let hits = source.components(separatedBy: marker).count - 1
            guard hits == 1, let start = source.range(of: marker) else {
                throw ParityError.unparsed(
                    "the web composer has \(hits) `menu.items` entries keyed '\(key)'")
            }
            let lineStart = source[..<start.lowerBound].lastIndex(of: "\n")
                .map { source.index(after: $0) } ?? source.startIndex
            let indent = source[lineStart..<start.lowerBound]
            guard indent.count >= 2, indent.allSatisfy({ $0 == " " }) else {
                throw ParityError.unparsed("the web item '\(key)' does not open its own line")
            }
            let closer = "\n" + String(repeating: " ", count: indent.count - 2) + "},"
            guard let end = source.range(of: closer, range: start.upperBound..<source.endIndex)
            else {
                throw ParityError.unparsed("the web item '\(key)' has no `\(closer.debugDescription)`")
            }
            items[key] = source[start.upperBound..<end.lowerBound]
        }
        return items
    }

    /// Every single-quoted string in each item's `label:` expression, in order. The web writes its
    /// labels inline (no constant to anchor on), so the quoted literals are the contract.
    private func webLabels() throws -> [String: [String]] {
        var labels: [String: [String]] = [:]
        for (key, item) in try webItems() {
            guard let label = item.range(of: "label:") else {
                throw ParityError.unparsed("the web item '\(key)' has no `label:`")
            }
            labels[key] = quotedLiterals(in: item[label.upperBound...])
        }
        return labels
    }

    private func quotedLiterals(in text: Substring) -> [String] {
        var literals: [String] = []
        var rest = text
        while let open = rest.firstIndex(of: "'") {
            let after = rest[rest.index(after: open)...]
            guard let close = after.firstIndex(of: "'") else { break }
            literals.append(String(after[after.startIndex..<close]))
            rest = after[after.index(after: close)...]
        }
        return literals
    }

    // MARK: the words

    /// Both ends offer the same five actions under the same words. A rename at either end reddens
    /// this: the expectation is read out of the native menu, and the web side has to match it.
    ///
    /// The two attach items are read in full by the next test, which is why the loop here skips
    /// them — so a word changed at one end reddens exactly one check, and the failure says which.
    func testTheMenuSaysWhatTheNativeMenuSays() throws {
        let native = try sharedNativeLabels()
        let web = try webLabels()

        XCTAssertEqual(native.count, Self.keys.count,
                       "the native `+` menu offers \(native.count) labelled actions, not the "
                           + "\(Self.keys.count) this check reads the web against — a menu this "
                           + "check no longer covers")

        for (key, label) in zip(Self.keys, native) where !Self.attachKeys.contains(key) {
            let literals = web[key] ?? []
            XCTAssertTrue(
                literals.contains(label),
                "the web composer's '\(key)' item says \(literals) where the native `+` menu says "
                    + "\(label.debugDescription)")
        }
    }

    /// The two attach items read one word and nothing else, and are offered unconditionally —
    /// which is how the native menu has always drawn them. A state-dependent label or a gate
    /// reappearing at one end is how the two ends drifted apart in the first place.
    func testTheAttachItemsCarryOneWordAndNoGate() throws {
        let native = try sharedNativeLabels()
        let web = try webLabels()
        let items = try webItems()
        let menu = try nativeMenu()

        for (key, label) in zip(Self.keys, native) where Self.attachKeys.contains(key) {
            XCTAssertEqual(
                web[key], [label],
                "the web composer's '\(key)' item labels itself \(web[key] ?? []) rather than the "
                    + "one word \(label.debugDescription) the native `+` menu uses")
            XCTAssertFalse(
                (items[key] ?? "").contains("disabled"),
                "the web composer gates its '\(key)' item again; a state the upload cannot work in "
                    + "is reported on pick now, and the item stays offered")
        }

        // Read from the attach items onward: the native menu does gate Command and Skill, and that
        // gate is its own business.
        guard let first = menu.range(of: "Label(\"Image\"") else {
            throw ParityError.unparsed("the native `addMenu` offers no `Image` item")
        }
        XCTAssertFalse(
            menu[first.lowerBound...].contains(".disabled"),
            "the native `+` menu gates an attach item again")
    }
}
