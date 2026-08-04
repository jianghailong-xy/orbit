import Foundation

// UI-free presentation model for a tool call, mirroring the web transcript's `describeTool`
// (src/web/src/components/Transcript.tsx). Keeping the name→display mapping here — instead of
// inline in the SwiftUI view — means the native console renders each tool the same way as web
// (per-tool icon + colour, abbreviated path, line-range badge, real diff for edits) and the
// whole mapping stays unit-testable on Linux without a SwiftUI compile.

/// Colour family for a tool's icon + the card's left rail. Mapped to concrete colours by the view.
public enum ToolTone: String, Equatable, Sendable {
    case read    // file reads, searches, fetches
    case exec    // Bash / shell
    case write   // Write / Edit
    case agent   // Task / Plan / Question
    case plain   // todos, MCP, unknown
}

/// A file path split into a bold leaf filename + a dimmed, abbreviated parent dir (`…/<dir>/`).
public struct PathParts: Equatable, Sendable {
    public let base: String
    public let dir: String
}

/// One line of a rendered edit diff (or a `gap` marker collapsing unchanged context).
public struct DiffLine: Equatable, Sendable {
    public enum Kind: String, Equatable, Sendable { case ctx, add, del, gap }
    public let kind: Kind
    public let text: String
    /// Number of unchanged lines a `.gap` row stands in for (0 otherwise).
    public let gapCount: Int
    public init(kind: Kind, text: String, gapCount: Int = 0) {
        self.kind = kind
        self.text = text
        self.gapCount = gapCount
    }
}

/// The expandable detail under a tool row.
public enum ToolBody: Equatable, Sendable {
    case none
    case command(String)     // a shell command, rendered with a `$` prompt
    case code(String)        // file content / a monospace blob
    case markdown(String)    // a sub-agent prompt, a plan, a question — rendered as prose
    case diff([[DiffLine]])  // one hunk for Edit, many for MultiEdit
}

/// Everything the view needs to render one tool call's folded row + expanded detail.
public struct ToolDisplay: Equatable, Sendable {
    public let label: String
    public let symbol: String        // SF Symbol name
    public let tone: ToolTone
    public let summary: String?      // inline prose/mono summary (nil when `path` is shown instead)
    public let summaryMono: Bool
    public let path: PathParts?      // a file path → bold filename + dimmed parent dir
    public let meta: String?         // trailing badge (line range, edit count)
    public let body: ToolBody
    /// Whether the card should start expanded (plans, questions, shell, errors).
    public let autoOpen: Bool

    public var hasBody: Bool { body != .none }

    // MARK: - mapping

    /// Map a tool name + raw input + status to its display form. `id` is the toolUseId; a user-run
    /// `!`-shell command is tagged `shell-…` by the runner and rendered as a distinct "Shell" card.
    public static func describe(name: String, input: JSONValue, status: ToolStatus, id: String) -> ToolDisplay {
        let isShell = id.hasPrefix("shell-")
        let isError = status == .error

        if isShell {
            return ToolDisplay(label: "Shell", symbol: "terminal", tone: .exec,
                               summary: input["command"]?.stringValue ?? "", summaryMono: true,
                               path: nil, meta: nil, body: .none, autoOpen: true)
        }

        switch name {
        case "Bash":
            let command = input["command"]?.stringValue ?? ""
            let prose = (input["description"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let bashSummary = prose.isEmpty ? shellCommandSummary(command) : prose
            return ToolDisplay(label: "Bash", symbol: "terminal", tone: .exec,
                               summary: bashSummary.isEmpty ? nil : bashSummary, summaryMono: prose.isEmpty,
                               path: nil, meta: nil,
                               body: .command(command), autoOpen: isError)

        case "Read":
            return ToolDisplay(label: "Read", symbol: "doc.text", tone: .read,
                               summary: nil, summaryMono: false,
                               path: input["file_path"]?.stringValue.map(splitPath),
                               meta: lineMeta(offset: input["offset"]?.intValue, limit: input["limit"]?.intValue),
                               body: .none, autoOpen: isError)

        case "Write":
            let content = input["content"]?.stringValue
            return ToolDisplay(label: "Write", symbol: "doc.badge.plus", tone: .write,
                               summary: nil, summaryMono: false,
                               path: input["file_path"]?.stringValue.map(splitPath), meta: nil,
                               body: (content?.isEmpty == false) ? .code(content!) : .none, autoOpen: isError)

        case "Edit":
            let hunk = collapseCtx(lineDiff(input["old_string"]?.stringValue ?? "",
                                            input["new_string"]?.stringValue ?? ""), ctx: 3)
            return ToolDisplay(label: "Edit", symbol: "pencil", tone: .write,
                               summary: nil, summaryMono: false,
                               path: input["file_path"]?.stringValue.map(splitPath), meta: nil,
                               body: .diff([hunk]), autoOpen: isError)

        case "MultiEdit":
            var edits: [JSONValue] = []
            if case .array(let arr)? = input["edits"] { edits = arr }
            let hunks = edits.map {
                collapseCtx(lineDiff($0["old_string"]?.stringValue ?? "", $0["new_string"]?.stringValue ?? ""), ctx: 3)
            }
            return ToolDisplay(label: "MultiEdit", symbol: "pencil", tone: .write,
                               summary: nil, summaryMono: false,
                               path: input["file_path"]?.stringValue.map(splitPath),
                               meta: "\(edits.count) edits",
                               body: hunks.isEmpty ? .none : .diff(hunks), autoOpen: isError)

        case "Glob":
            return ToolDisplay(label: "Glob", symbol: "folder", tone: .read,
                               summary: joinSummary([input["pattern"], input["path"]]), summaryMono: true,
                               path: nil, meta: nil, body: .none, autoOpen: isError)

        case "Grep":
            return ToolDisplay(label: "Grep", symbol: "magnifyingglass", tone: .read,
                               summary: joinSummary([input["pattern"], input["path"], input["glob"]]), summaryMono: true,
                               path: nil, meta: nil, body: .none, autoOpen: isError)

        case "TodoWrite":
            return ToolDisplay(label: "Todos", symbol: "checklist", tone: .plain,
                               summary: nil, summaryMono: false, path: nil, meta: nil,
                               body: todoBody(input["todos"]), autoOpen: isError)

        case "WebFetch":
            return ToolDisplay(label: "WebFetch", symbol: "globe", tone: .read,
                               summary: input["url"]?.stringValue, summaryMono: true,
                               path: nil, meta: nil, body: .none, autoOpen: isError)

        case "WebSearch":
            return ToolDisplay(label: "WebSearch", symbol: "magnifyingglass", tone: .read,
                               summary: input["query"]?.stringValue, summaryMono: false,
                               path: nil, meta: nil, body: .none, autoOpen: isError)

        case "ToolSearch":
            return ToolDisplay(label: "ToolSearch", symbol: "puzzlepiece.extension", tone: .read,
                               summary: input["query"]?.stringValue, summaryMono: true,
                               path: nil, meta: nil, body: .none, autoOpen: isError)

        case "Task", "Agent":
            let sub = input["subagent_type"]?.stringValue
            let prompt = input["prompt"]?.stringValue
            return ToolDisplay(label: sub.map { "\(name) · \($0)" } ?? name, symbol: "rectangle.3.group", tone: .agent,
                               summary: input["description"]?.stringValue, summaryMono: false, path: nil, meta: nil,
                               body: (prompt?.isEmpty == false) ? .markdown(prompt!) : .none, autoOpen: isError)

        case "ExitPlanMode":
            let plan = input["plan"]?.stringValue
            return ToolDisplay(label: "Plan", symbol: "list.clipboard", tone: .agent,
                               summary: nil, summaryMono: false, path: nil, meta: nil,
                               body: (plan?.isEmpty == false) ? .markdown(plan!) : .none, autoOpen: true)

        case "AskUserQuestion":
            let (summary, body) = questionDisplay(input["questions"])
            return ToolDisplay(label: "Question", symbol: "questionmark.circle", tone: .agent,
                               summary: summary, summaryMono: false, path: nil, meta: nil,
                               body: body, autoOpen: true)

        default:
            if name.hasPrefix("mcp__") {
                let label = String(name.dropFirst(5)).replacingOccurrences(of: "__", with: " · ")
                return ToolDisplay(label: label, symbol: "puzzlepiece.extension", tone: .plain,
                                   summary: kvSummary(input), summaryMono: true,
                                   path: nil, meta: nil, body: .none, autoOpen: isError)
            }
            return ToolDisplay(label: name, symbol: "wrench.and.screwdriver", tone: .plain,
                               summary: kvSummary(input), summaryMono: true,
                               path: nil, meta: nil, body: .none, autoOpen: isError)
        }
    }

    // MARK: - path / meta

    /// Split a path into a bold leaf filename + a dimmed `…/<parent>/` (mirrors web `splitPath`).
    public static func splitPath(_ path: String) -> PathParts {
        var clean = path
        while clean.hasSuffix("/") { clean.removeLast() }
        guard let cut = clean.lastIndex(of: "/") else { return PathParts(base: clean, dir: "") }
        let base = String(clean[clean.index(after: cut)...])
        let segs = clean[..<cut].split(separator: "/").map(String.init)
        return PathParts(base: base, dir: segs.isEmpty ? "/" : "…/\(segs[segs.count - 1])/")
    }

    /// Read's offset/limit → a compact `L240–400` badge (mirrors web `lineMeta`).
    public static func lineMeta(offset: Int?, limit: Int?) -> String? {
        let start = offset ?? 0
        if let limit, limit != 0 { return "L\(start)–\(start + limit)" }
        if start == 0 { return nil }
        return "L\(start)+"
    }

    // MARK: - diff (line-level LCS + context collapse), ported from web

    static func lineDiff(_ oldStr: String, _ newStr: String) -> [DiffLine] {
        let a = oldStr.components(separatedBy: "\n")
        let b = newStr.components(separatedBy: "\n")
        let n = a.count, m = b.count
        // O(n·m) LCS table — bail to a flat del/add dump on pathologically large edits.
        if n * m > 250_000 {
            return a.map { DiffLine(kind: .del, text: $0) } + b.map { DiffLine(kind: .add, text: $0) }
        }
        var dp = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
        if n > 0 && m > 0 {
            for x in stride(from: n - 1, through: 0, by: -1) {
                for y in stride(from: m - 1, through: 0, by: -1) {
                    dp[x][y] = a[x] == b[y] ? dp[x + 1][y + 1] + 1 : max(dp[x + 1][y], dp[x][y + 1])
                }
            }
        }
        var rows: [DiffLine] = []
        var i = 0, j = 0
        while i < n && j < m {
            if a[i] == b[j] { rows.append(DiffLine(kind: .ctx, text: a[i])); i += 1; j += 1 }
            else if dp[i + 1][j] >= dp[i][j + 1] { rows.append(DiffLine(kind: .del, text: a[i])); i += 1 }
            else { rows.append(DiffLine(kind: .add, text: b[j])); j += 1 }
        }
        while i < n { rows.append(DiffLine(kind: .del, text: a[i])); i += 1 }
        while j < m { rows.append(DiffLine(kind: .add, text: b[j])); j += 1 }
        return rows
    }

    /// Collapse long runs of unchanged context, keeping `ctx` lines next to each change.
    static func collapseCtx(_ rows: [DiffLine], ctx: Int) -> [DiffLine] {
        var out: [DiffLine] = []
        var i = 0
        while i < rows.count {
            if rows[i].kind != .ctx { out.append(rows[i]); i += 1; continue }
            var j = i
            while j < rows.count && rows[j].kind == .ctx { j += 1 }
            let run = Array(rows[i..<j])
            let head = i == 0 ? 0 : ctx                 // no leading context before the first change
            let tail = j == rows.count ? 0 : ctx        // none after the last change
            if run.count > head + tail + 1 {
                for k in 0..<head { out.append(run[k]) }
                out.append(DiffLine(kind: .gap, text: "", gapCount: run.count - head - tail))
                for k in (run.count - tail)..<run.count { out.append(run[k]) }
            } else {
                out.append(contentsOf: run)
            }
            i = j
        }
        return out
    }

    /// A diff line paired with its hunk-relative gutter line numbers (mirrors web `Diff`'s oldNo/newNo).
    /// Edit payloads carry no file offset, so these are hunk-local — just enough to keep both sides aligned.
    public struct NumberedDiffLine: Equatable, Sendable {
        public let line: DiffLine
        public let oldNumber: Int?   // shown for context + deletions
        public let newNumber: Int?   // shown for context + additions
    }

    /// Walk a hunk assigning running old/new line numbers; a `.gap` advances both counters but shows none.
    public static func numbered(_ hunk: [DiffLine]) -> [NumberedDiffLine] {
        var oldNo = 0, newNo = 0
        return hunk.map { r in
            switch r.kind {
            case .gap:
                oldNo += r.gapCount; newNo += r.gapCount
                return NumberedDiffLine(line: r, oldNumber: nil, newNumber: nil)
            case .ctx:
                oldNo += 1; newNo += 1
                return NumberedDiffLine(line: r, oldNumber: oldNo, newNumber: newNo)
            case .del:
                oldNo += 1
                return NumberedDiffLine(line: r, oldNumber: oldNo, newNumber: nil)
            case .add:
                newNo += 1
                return NumberedDiffLine(line: r, oldNumber: nil, newNumber: newNo)
            }
        }
    }

    // MARK: - summary helpers

    /// Codex's shell calls carry no `description`, and it wraps every one of them as
    /// `/bin/bash -lc "<command>"` — unwrap that shell (and its outer quoting) so a Bash row can
    /// fall back to the command itself instead of showing a bare "Bash" with nothing beside it.
    /// Whitespace is collapsed because the row is a single truncated line (mirrors web
    /// `shellCommandSummary`).
    static func shellCommandSummary(_ command: String) -> String {
        var text = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let fields = text.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true).map(String.init)
        if fields.count == 3,
           ["sh", "bash", "zsh"].contains(fields[0].split(separator: "/").last.map(String.init) ?? ""),
           fields[1].hasPrefix("-"), fields[1].hasSuffix("c"),
           fields[1].dropFirst().allSatisfy({ $0.isLetter }) {
            var inner = fields[2].trimmingCharacters(in: .whitespacesAndNewlines)
            if let quote = inner.first, quote == "\"" || quote == "'",
               inner.count > 1, inner.hasSuffix(String(quote)) {
                inner = String(inner.dropFirst().dropLast())
            }
            text = inner
        }
        return text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func joinSummary(_ vals: [JSONValue?]) -> String? {
        let parts = vals.compactMap { $0?.stringValue }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: "  ·  ")
    }

    private static func todoBody(_ v: JSONValue?) -> ToolBody {
        guard case .array(let items)? = v, !items.isEmpty else { return .none }
        let lines = items.map { item -> String in
            let content = item["content"]?.stringValue ?? item["activeForm"]?.stringValue ?? ""
            switch item["status"]?.stringValue {
            case "completed":   return "✔ \(content)"
            case "in_progress": return "◐ \(content)"
            default:            return "○ \(content)"
            }
        }
        return .code(lines.joined(separator: "\n"))
    }

    private static func questionDisplay(_ v: JSONValue?) -> (String?, ToolBody) {
        guard case .array(let qs)? = v, !qs.isEmpty else { return (nil, .none) }
        let headers = qs.compactMap { $0["header"]?.stringValue }.filter { !$0.isEmpty }
        let blocks = qs.map { q -> String in
            let question = q["question"]?.stringValue ?? q["header"]?.stringValue ?? ""
            var opts: [String] = []
            if case .array(let arr)? = q["options"] { opts = arr.compactMap { $0["label"]?.stringValue } }
            var block = "**\(question)**"
            if !opts.isEmpty { block += "\n" + opts.map { "- \($0)" }.joined(separator: "\n") }
            return block
        }
        return (headers.isEmpty ? nil : headers.joined(separator: "  ·  "),
                blocks.isEmpty ? .none : .markdown(blocks.joined(separator: "\n\n")))
    }

    private static func kvSummary(_ input: JSONValue) -> String? {
        guard case .object(let obj) = input, !obj.isEmpty else { return nil }
        let parts = obj.sorted { $0.key < $1.key }.compactMap { (k, v) -> String? in
            guard let s = v.asString, !s.isEmpty else { return nil }
            return "\(k): \(s.count > 60 ? String(s.prefix(60)) + "…" : s)"
        }
        return parts.isEmpty ? nil : parts.joined(separator: "  ·  ")
    }
}
