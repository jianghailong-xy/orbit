import Foundation

/// The body of a plain tool-call approval: what the call does, not its input as JSON
/// (docs/mocks/tool-call-card). A command is shown as the command, a file tool as its path and
/// change, a fetch as its URL; any other tool as its fields, with the raw input one press away.
/// Web parity: `ToolCallBody.tsx`, rule for rule.
public struct ToolCallPreview: Equatable, Sendable {
    /// Lines of a command or a file's content shown before the fold.
    public static let foldLines = 12
    public static let showRawInput = "Show raw input"
    public static let hideRawInput = "Hide raw input"

    public struct Chip: Equatable, Sendable, Identifiable {
        public let label: String
        /// Changes the risk for the worse (`sandbox off`): drawn in the warning tone.
        public let warn: Bool
        public var id: String { label }
        public init(_ label: String, warn: Bool = false) {
            self.label = label
            self.warn = warn
        }
    }

    public struct Field: Equatable, Sendable, Identifiable {
        public let key: String
        public let value: String
        /// An object or an array, printed as indented JSON.
        public let block: Bool
        public var id: String { key }
    }

    public enum Body: Equatable, Sendable {
        case command(String)
        /// Edit and MultiEdit: the path and one hunk per edit, in the transcript's own diff form.
        case edit(path: String, hunks: [[DiffLine]])
        case write(path: String, content: String)
        /// Read and NotebookEdit.
        case path(String)
        /// A fetch's URL, a search's query, a grep's pattern.
        case line(String)
        /// Any other tool: its top-level fields but the description, and the raw input.
        case fields([Field], raw: String)
    }

    /// The card's question: what the call is about to do.
    public let heading: String
    /// The one description line: the owner's language where the server translated it, else the
    /// agent's own words; a fetch's prompt when it has no description.
    public let description: String?
    /// The agent's own words, in grey after a translation that differs from them.
    public let originalDescription: String?
    public let body: Body
    public let chips: [Chip]

    public static func heading(toolName: String?, input: JSONValue?) -> String {
        switch toolName {
        case "Bash": return "Run a command?"
        case "Edit", "MultiEdit": return "Edit a file?"
        case "Write": return "Write a file?"
        case "Read": return "Read a file?"
        case "NotebookEdit": return "Edit a notebook?"
        case "WebFetch": return "Fetch a web page?"
        case "WebSearch": return "Search the web?"
        case "Grep", "Glob": return "Search files?"
        default: return text(input?["command"]).isEmpty ? "Approve tool call?" : "Run a command?"
        }
    }

    /// `ms` as the chip says it: whole minutes as `N min`, else one decimal; under a minute `N s`.
    public static func duration(ms: Int) -> String {
        if ms >= 60_000 && ms % 60_000 == 0 { return "\(ms / 60_000) min" }
        if ms >= 60_000 {
            let tenths = Int((Double(ms) / 6_000).rounded())
            return tenths % 10 == 0 ? "\(tenths / 10) min" : "\(tenths / 10).\(tenths % 10) min"
        }
        return "\(Int((Double(ms) / 1_000).rounded())) s"
    }

    /// A path inside an Orbit worktree, from the worktree's root (web `relPath`).
    public static func relPath(_ path: String) -> String {
        guard let r = path.range(of: #"\.orbit/worktrees/[^/]+/"#, options: .regularExpression) else { return path }
        let rest = String(path[r.upperBound...])
        return rest.isEmpty ? path : rest
    }

    public static func make(toolName: String?, input: JSONValue?, translation: ApprovalTranslation?) -> ToolCallPreview {
        let i = input ?? .object([:])
        let original = text(i["description"]).trimmingCharacters(in: .whitespacesAndNewlines)
        let translated = translation.flatMap { $0.failed ? nil : $0.description } ?? ""
        var description: String? = !translated.isEmpty ? translated : (original.isEmpty ? nil : original)
        let originalDescription = !translated.isEmpty && !original.isEmpty && translated != original ? original : nil

        let body: Body
        var chips: [Chip] = []
        let command = text(i["command"])
        let filePath = text(i["file_path"])
        let notebookPath = text(i["notebook_path"])
        if toolName == "Bash" || (!command.isEmpty && !["Edit", "MultiEdit", "Write"].contains(toolName ?? "")) {
            body = .command(command)
            if let timeout = number(i["timeout"]), timeout > 0 { chips.append(Chip("timeout \(duration(ms: timeout))")) }
            if i["run_in_background"]?.boolValue == true { chips.append(Chip("runs in background")) }
            if i["dangerouslyDisableSandbox"]?.boolValue == true { chips.append(Chip("sandbox off", warn: true)) }
        } else if toolName == "Edit" {
            let sides = i["old_string"] != nil || i["new_string"] != nil
            body = .edit(path: filePath, hunks: sides ? [hunk(text(i["old_string"]), text(i["new_string"]))] : [])
            if i["replace_all"]?.boolValue == true { chips.append(Chip("Every occurrence")) }
        } else if toolName == "MultiEdit" {
            var edits: [JSONValue] = []
            if case .array(let arr)? = i["edits"] { edits = arr }
            body = .edit(path: filePath, hunks: edits.map { hunk(text($0["old_string"]), text($0["new_string"])) })
            chips.append(Chip(plural(edits.count, "edit")))
        } else if toolName == "Write" {
            let content = text(i["content"])
            body = .write(path: filePath, content: content)
            chips.append(Chip(plural(content.isEmpty ? 0 : content.components(separatedBy: "\n").count, "line")))
        } else if toolName == "Read" || toolName == "NotebookEdit", !filePath.isEmpty || !notebookPath.isEmpty {
            body = .path(filePath.isEmpty ? notebookPath : filePath)
            let offset = number(i["offset"])
            let limit = number(i["limit"])
            if (offset ?? 0) != 0 || (limit ?? 0) != 0 {
                let from = offset ?? 1
                let limit = limit ?? 0
                chips.append(Chip(limit != 0 ? "lines \(from)–\(from + limit - 1)" : "from line \(from)"))
            }
        } else if toolName == "WebFetch", !text(i["url"]).isEmpty {
            let prompt = text(i["prompt"]).trimmingCharacters(in: .whitespacesAndNewlines)
            if description == nil && !prompt.isEmpty { description = prompt }
            body = .line(text(i["url"]))
        } else if toolName == "WebSearch", !text(i["query"]).isEmpty {
            body = .line(text(i["query"]))
        } else if toolName == "Grep" || toolName == "Glob", !text(i["pattern"]).isEmpty {
            body = .line(text(i["pattern"]))
            if !text(i["path"]).isEmpty { chips.append(Chip("in \(relPath(text(i["path"])))")) }
            if !text(i["glob"]).isEmpty { chips.append(Chip(text(i["glob"]))) }
        } else {
            var fields: [Field] = []
            if case .object(let obj) = i {
                for (key, value) in obj.sorted(by: { $0.key < $1.key }) where key != "description" {
                    switch value {
                    case .object, .array:
                        fields.append(Field(key: key, value: Approvals.rawInput(value) ?? "", block: true))
                    case .null:
                        fields.append(Field(key: key, value: "null", block: false))
                    default:
                        fields.append(Field(key: key, value: value.asString ?? "", block: false))
                    }
                }
            }
            body = .fields(fields, raw: Approvals.rawInput(i) ?? "{}")
        }
        return ToolCallPreview(heading: heading(toolName: toolName, input: i), description: description,
                               originalDescription: originalDescription, body: body, chips: chips)
    }

    private static func text(_ v: JSONValue?) -> String { v?.stringValue ?? "" }

    /// A JSON number as a whole number; a string or a bool is not one.
    private static func number(_ v: JSONValue?) -> Int? {
        switch v {
        case .int(let n)?: return n
        case .double(let d)?: return Int(d)
        default: return nil
        }
    }

    /// One edit as the transcript draws it (`ToolDisplay`'s Edit card).
    private static func hunk(_ old: String, _ new: String) -> [DiffLine] {
        ToolDisplay.collapseCtx(ToolDisplay.lineDiff(old, new), ctx: 3)
    }

    private static func plural(_ n: Int, _ one: String) -> String { "\(n) \(one)\(n == 1 ? "" : "s")" }
}
