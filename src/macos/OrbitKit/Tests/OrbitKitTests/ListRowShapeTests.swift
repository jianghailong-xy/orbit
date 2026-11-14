import Foundation
import XCTest

/// SwiftUI doesn't exist on Linux, so no test here compiles the app shells. This one reads them
/// instead: every `List` in OrbitApp draws its rows through a `ForEach`, and no `ForEach` closure
/// under a `List` holds an `if` or a second `ForEach`. That conditional row shape is what aborted the
/// outline list's row reload (beta.242, `-NSLayoutConstraint setActive:` under
/// `OutlineListCoordinator`); the sidebar fix established the flat row array, and this holds every
/// other list to it. A List's rows are often built by a `@ViewBuilder` the List calls (the
/// sidebar's `workspaceRows` is one), so the scan follows those builders too — otherwise putting the
/// branch back into the helper would pass unseen. Comments and string literals are blanked before
/// the scan, so prose about the unsafe shape can't fail it.
final class ListRowShapeTests: XCTestCase {
    // MARK: the real sources

    func testEveryListDrawsItsRowsThroughOneUnconditionalForEach() throws {
        let files = try appSources()
        XCTAssertFalse(files.isEmpty, "no OrbitApp sources were found to scan")
        var violations: [String] = []
        for (path, source) in files.sorted(by: { $0.key < $1.key }) {
            violations += scan(path: path, source: source)
        }
        XCTAssertTrue(violations.isEmpty,
                      "Lists whose rows are not one flat ForEach:\n" + violations.joined(separator: "\n"))
    }

    // MARK: the scanner's own behaviour

    /// A comment or a string that talks about `if`/`ForEach` inside the closure is not code.
    func testCommentsAndStringsAreBlankedBeforeScanning() {
        let source = """
        struct A: View {
            var body: some View {
                List {
                    ForEach(rows) { row in
                        // an if here would be the unsafe shape
                        /* a second ForEach here too */
                        Text("if this string says ForEach, it is still text \\(row.title)")
                    }
                }
            }
        }
        """
        XCTAssertEqual(scan(path: "Fixture.swift", source: source), [])
    }

    /// The scan catches both shapes the fix removed: an `if` in the closure and a nested `ForEach`.
    func testTheScanFindsAnIfAndANestedForEachInAClosure() {
        let conditional = """
        struct A: View {
            var body: some View {
                List {
                    ForEach(sections) { section in
                        if section == .wiki { row(section) }
                    }
                }
            }
        }
        """
        XCTAssertEqual(scan(path: "Conditional.swift", source: conditional).count, 1)

        let nested = """
        struct B: View {
            var body: some View {
                List {
                    ForEach(groups) { group in
                        Section {
                            ForEach(group.rows) { row($0) }
                        }
                    }
                }
            }
        }
        """
        XCTAssertEqual(scan(path: "Nested.swift", source: nested).count, 1)
    }

    /// A List with no ForEach at all is the same shape by another road: its rows are not one array.
    func testTheScanFindsAListWithNoForEach() {
        let source = """
        struct C: View {
            var body: some View {
                List {
                    Section { header }
                    if trashed > 0 { Section { trashRow } }
                }
            }
        }
        """
        XCTAssertEqual(scan(path: "Static.swift", source: source).count, 1)
    }

    /// A List's rows often come from a builder it calls. Putting the branch back into that builder is
    /// the same defect (the sidebar's `workspaceRows` is one of them), so the scan follows it.
    func testTheScanFollowsTheBuildersAListCalls() {
        let source = """
        struct D: View {
            var body: some View {
                List(selection: $selected) {
                    Section {
                        rows
                    }
                }
            }

            @ViewBuilder private var rows: some View {
                ForEach(itemList) { item in
                    if item.id != firstID {
                        Row(item: item)
                    } else {
                        Row(item: item).bold()
                    }
                }
            }
        }
        """
        XCTAssertEqual(scan(path: "Builder.swift", source: source).count, 1)
    }

    // MARK: - the scan

    /// One line per violation, naming the file, the line and what is wrong.
    private func scan(path: String, source: String) -> [String] {
        let text = Array(stripped(source))
        let builders = viewBuilders(text)
        var violations: [String] = []
        for start in listStarts(text) {
            let line = lineNumber(of: start, in: text)
            guard let body = listBody(text, nameAt: start) else { continue }
            // The List's row areas: its own content, and the builders it calls directly (outside a
            // ForEach closure), recursively.
            let areas = [("List", body)] + reachableBuilders(body, in: builders, seen: [], depth: 0)
            var forEachCount = 0
            for (area, areaBody) in areas {
                let forEaches = forEachStarts(areaBody)
                forEachCount += forEaches.count
                for forEach in forEaches {
                    guard let closure = forEachClosure(areaBody, nameAt: forEach) else { continue }
                    if containsIf(closure) {
                        violations.append("\(path):\(line) an `if` sits inside a ForEach closure in \(area)")
                    }
                    if hasForEach(closure) {
                        violations.append("\(path):\(line) a second ForEach sits inside a ForEach closure in \(area)")
                    }
                }
            }
            if forEachCount == 0 {
                violations.append("\(path):\(line) List draws no rows through a ForEach")
            }
        }
        return violations
    }

    /// The `@ViewBuilder` funcs and `some View` properties in the file, by name: the helpers a List
    /// can hand its rows to.
    private func viewBuilders(_ text: [Character]) -> [String: [Character]] {
        var builders: [String: [Character]] = [:]
        for start in identifierStarts("func", in: text) {
            var i = skipSpace(text, start + 4)
            let nameStart = i
            while i < text.count, isIdent(text[i]) { i += 1 }
            guard i > nameStart else { continue }
            let name = String(text[nameStart..<i])
            i = skipSpace(text, i)
            guard i < text.count, text[i] == "(", let afterParams = matching(text, i, open: "(", close: ")")
            else { continue }
            guard let open = nextIndex(of: "{", in: text, from: afterParams),
                  let end = matching(text, open, open: "{", close: "}") else { continue }
            builders[name] = Array(text[(open + 1)..<(end - 1)])
        }
        for start in identifierStarts("var", in: text) {
            var i = skipSpace(text, start + 3)
            let nameStart = i
            while i < text.count, isIdent(text[i]) { i += 1 }
            guard i > nameStart else { continue }
            let name = String(text[nameStart..<i])
            i = skipSpace(text, i)
            guard i < text.count, text[i] == ":" else { continue }
            guard let open = nextIndex(of: "{", in: text, from: i) else { continue }
            // A `some View` property: the type between the colon and the brace says View.
            let type = String(text[i..<open])
            guard type.contains("View") else { continue }
            guard let end = matching(text, open, open: "{", close: "}") else { continue }
            builders[name] = Array(text[(open + 1)..<(end - 1)])
        }
        return builders
    }

    /// The builders `body` calls outside any ForEach closure, and what those call in turn. A builder
    /// called *inside* a ForEach closure is a row's own view, not a row area, so it is not followed.
    private func reachableBuilders(_ body: [Character], in builders: [String: [Character]],
                                   seen: Set<String>, depth: Int) -> [(String, [Character])] {
        guard depth < 5 else { return [] }
        let direct = directText(body)
        var found: [(String, [Character])] = []
        var visited = seen
        for (name, builderBody) in builders.sorted(by: { $0.key < $1.key }) {
            guard !visited.contains(name), !identifierStarts(name, in: direct).isEmpty else { continue }
            visited.insert(name)
            found.append((name, builderBody))
            found += reachableBuilders(builderBody, in: builders, seen: visited, depth: depth + 1)
        }
        return found
    }

    /// The body with every ForEach closure blanked: what the List draws directly, rather than hands
    /// to a row.
    private func directText(_ body: [Character]) -> [Character] {
        var out = body
        for start in forEachStarts(body) {
            guard let range = forEachClosureRange(body, nameAt: start) else { continue }
            for i in range where out[i] != "\n" { out[i] = " " }
        }
        return out
    }

    private func nextIndex(of c: Character, in text: [Character], from: Int) -> Int? {
        var i = from
        while i < text.count {
            if text[i] == c { return i }
            i += 1
        }
        return nil
    }

    /// `List`, `List(...)`, `List<...>(...)` — never `Foo.List` and never a name that merely starts
    /// with it (`ListLoadState`).
    private func listStarts(_ text: [Character]) -> [Int] {
        identifierStarts("List", in: text)
    }

    private func forEachStarts(_ text: [Character]) -> [Int] {
        identifierStarts("ForEach", in: text)
    }

    private func hasForEach(_ text: [Character]) -> Bool { !forEachStarts(text).isEmpty }

    private func containsIf(_ text: [Character]) -> Bool {
        let s = String(text)
        // `#if` is compile-time, not a conditional row.
        return s.range(of: "(?<!#)\\bif\\b", options: .regularExpression) != nil
    }

    private func identifierStarts(_ name: String, in text: [Character]) -> [Int] {
        let needle = Array(name)
        guard text.count >= needle.count else { return [] }
        var found: [Int] = []
        for i in 0...(text.count - needle.count) {
            guard Array(text[i..<(i + needle.count)]) == needle else { continue }
            if i > 0 {
                let before = text[i - 1]
                if isIdent(before) || before == "." { continue }
            }
            let afterIndex = i + needle.count
            if afterIndex < text.count, isIdent(text[afterIndex]) { continue }
            found.append(i)
        }
        return found
    }

    private func isIdent(_ c: Character) -> Bool {
        c.isLetter || c.isNumber || c == "_"
    }

    /// The text between the braces of the List's trailing closure, or nil when the name isn't a List
    /// call at all (a comment or a plain mention that survived the blanking).
    private func listBody(_ text: [Character], nameAt start: Int) -> [Character]? {
        var i = skipSpace(text, start + 4)
        if i < text.count, text[i] == "<" {
            guard let after = matching(text, i, open: "<", close: ">") else { return nil }
            i = skipSpace(text, after)
        }
        if i < text.count, text[i] == "(" {
            guard let after = matching(text, i, open: "(", close: ")") else { return nil }
            i = skipSpace(text, after)
        }
        guard i < text.count, text[i] == "{" else { return nil }
        guard let end = matching(text, i, open: "{", close: "}") else { return nil }
        return Array(text[(i + 1)..<(end - 1)])
    }

    /// The closure of a `ForEach(...)` call, or nil when the name isn't one.
    private func forEachClosure(_ text: [Character], nameAt start: Int) -> [Character]? {
        guard let range = forEachClosureRange(text, nameAt: start) else { return nil }
        return Array(text[(range.lowerBound + 1)..<(range.upperBound - 1)])
    }

    /// The braces of a `ForEach(...)` call's closure, `{` through `}`.
    private func forEachClosureRange(_ text: [Character], nameAt start: Int) -> Range<Int>? {
        var i = skipSpace(text, start + 7)
        guard i < text.count, text[i] == "(" else { return nil }
        guard let after = matching(text, i, open: "(", close: ")") else { return nil }
        i = skipSpace(text, after)
        guard i < text.count, text[i] == "{" else { return nil }
        guard let end = matching(text, i, open: "{", close: "}") else { return nil }
        return i..<end
    }

    private func skipSpace(_ text: [Character], _ from: Int) -> Int {
        var i = from
        while i < text.count, text[i] == " " || text[i] == "\n" || text[i] == "\t" || text[i] == "\r" {
            i += 1
        }
        return i
    }

    /// The index just after the bracket matching the one at `start`.
    private func matching(_ text: [Character], _ start: Int, open: Character, close: Character) -> Int? {
        var depth = 0
        var i = start
        while i < text.count {
            if text[i] == open { depth += 1 }
            else if text[i] == close {
                depth -= 1
                if depth == 0 { return i + 1 }
            }
            i += 1
        }
        return nil
    }

    private func lineNumber(of index: Int, in text: [Character]) -> Int {
        text[0..<min(index, text.count)].reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
    }

    // MARK: - blanks

    /// The source with comments and string literals replaced by spaces, newlines kept so line numbers
    /// still point at the real file.
    private func stripped(_ source: String) -> String {
        let chars = Array(source)
        var out = chars
        let n = chars.count
        func at(_ i: Int, _ c: Character) -> Bool { i < n && chars[i] == c }
        func blank(_ range: Range<Int>) {
            for j in range where chars[j] != "\n" { out[j] = " " }
        }
        var i = 0
        while i < n {
            if at(i, "/") && at(i + 1, "/") {
                var j = i
                while j < n && chars[j] != "\n" { j += 1 }
                blank(i..<j)
                i = j
            } else if at(i, "/") && at(i + 1, "*") {
                var depth = 0
                var j = i
                while j < n {
                    if at(j, "/") && at(j + 1, "*") { depth += 1; j += 2 }
                    else if at(j, "*") && at(j + 1, "/") {
                        depth -= 1
                        j += 2
                        if depth == 0 { break }
                    } else { j += 1 }
                }
                blank(i..<min(j, n))
                i = j
            } else if at(i, "#") && at(i + 1, "\"") {
                var j = i + 2
                while j < n {
                    if at(j, "\"") && at(j + 1, "#") { j += 2; break }
                    j += 1
                }
                blank(i..<min(j, n))
                i = j
            } else if at(i, "\"") {
                var j: Int
                if at(i + 1, "\"") && at(i + 2, "\"") {
                    j = i + 3
                    while j < n {
                        if at(j, "\"") && at(j + 1, "\"") && at(j + 2, "\"") { j += 3; break }
                        j += 1
                    }
                } else {
                    j = i + 1
                    while j < n {
                        if chars[j] == "\\" { j += 2; continue }
                        if chars[j] == "\"" { j += 1; break }
                        j += 1
                    }
                }
                blank(i..<min(j, n))
                i = j
            } else {
                i += 1
            }
        }
        return String(out)
    }

    // MARK: - files

    private struct SourceMissing: Error { let path: String }

    /// Every `.swift` under OrbitApp's sources, keyed by its path from the repo root.
    private func appSources() throws -> [String: String] {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var root: URL?
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent("src/macos/OrbitApp/Sources/OrbitApp")
            if FileManager.default.fileExists(atPath: candidate.path) {
                root = candidate
                break
            }
            dir.deleteLastPathComponent()
        }
        let app = try XCTUnwrap(root, "OrbitApp's sources weren't found above this test")
        let repoRoot = app.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        var files: [String: String] = [:]
        let walker = FileManager.default.enumerator(at: app, includingPropertiesForKeys: [.isRegularFileKey])
        while let url = walker?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let path = url.path.replacingOccurrences(of: repoRoot.path + "/", with: "")
            files[path] = try String(contentsOf: url, encoding: .utf8)
        }
        if files.isEmpty { throw SourceMissing(path: app.path) }
        return files
    }
}
