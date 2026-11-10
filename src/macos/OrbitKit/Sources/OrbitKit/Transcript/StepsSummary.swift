import Foundation

/// What a steps line says: the settled stretch of work between two replies as one sentence
/// ("Thought for 15s, listed 1 directory, ran 2 shell commands"), how many of its calls failed, and
/// the calls still in flight, which are drawn under the line until they answer.
///
/// Mirrors web's `stepsSummary` / `StepsLine` (src/web/src/components/Transcript.tsx), word for
/// word. Kept out of the view so the wording is unit-testable off-device, which is the only way it
/// gets tested at all before a TestFlight build.
public struct StepsSummary: Equatable, Sendable {
    /// The sentence for everything settled; empty while the only step is a call still in flight.
    public let line: String
    /// Settled calls that failed: the line ends in a red ` · N failed`, and nothing unfolds.
    public let failed: Int
    /// The calls still running, in order.
    public let live: [Live]

    /// A call in flight: what it is doing, then — for a shell call that says what it is doing —
    /// the command it runs.
    public struct Live: Equatable, Sendable, Identifiable {
        public let id: String
        public let text: String
        public let mono: Bool
        public let command: String?

        public init(id: String, text: String, mono: Bool, command: String?) {
            self.id = id
            self.text = text
            self.mono = mono
            self.command = command
        }
    }

    public init(line: String, failed: Int, live: [Live]) {
        self.line = line
        self.failed = failed
        self.live = live
    }

    public static func make(_ items: [TranscriptItem]) -> StepsSummary {
        var settled: [TranscriptItem] = []
        var live: [Live] = []
        for item in items {
            if case .toolCall(let card) = item, card.status == .running {
                live.append(liveLine(card))
            } else {
                settled.append(item)
            }
        }
        let failed = settled.filter { if case .toolCall(let c) = $0 { return c.status == .error }; return false }.count
        return StepsSummary(line: sentence(settled), failed: failed, live: live)
    }

    /// The thinking first, then each kind of call in the order it first came.
    public static func sentence(_ items: [TranscriptItem]) -> String {
        var thought = false
        var thinkSeconds: TimeInterval = 0
        var order: [Verb] = []
        var calls: [Verb: Int] = [:]
        var files: [Verb: Set<String>] = [:]
        var unnamed: [Verb: Int] = [:]
        for item in items {
            switch item {
            case .thinking(let block):
                thought = true
                if let ms = block.thinkingMs, ms > 0 {
                    thinkSeconds += Double(ms) / 1000
                } else if let seconds = ThinkingSummary.elapsed(from: block.startedTs, to: block.finishedTs) {
                    thinkSeconds += seconds
                }
            case .toolCall(let card):
                let verb = Verb.of(card)
                if calls[verb] == nil { order.append(verb) }
                calls[verb, default: 0] += 1
                if verb.countsFiles, let file = (card.input["file_path"] ?? card.input["path"])?.stringValue, !file.isEmpty {
                    files[verb, default: []].insert(file)
                } else {
                    unnamed[verb, default: 0] += 1
                }
            default:
                continue
            }
        }
        var parts = order.map { verb in
            verb.phrase(verb.countsFiles ? (files[verb]?.count ?? 0) + (unnamed[verb] ?? 0) : (calls[verb] ?? 0))
        }
        if thought { parts.insert(thinkSeconds > 0 ? "Thought for \(ThinkingSummary.duration(thinkSeconds))" : "Thought", at: 0) }
        let line = parts.joined(separator: ", ")
        return line.prefix(1).uppercased() + line.dropFirst()
    }

    private static func liveLine(_ card: ToolCard) -> Live {
        let d = ToolDisplay.describe(name: card.name, input: card.input, status: card.status, id: card.id)
        let description = (card.input["description"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let command = card.name == "Bash" && !description.isEmpty
            ? ToolDisplay.shellCommandSummary(card.input["command"]?.stringValue ?? "")
            : nil
        if let path = d.path { return Live(id: card.id, text: path.base, mono: true, command: command) }
        if let summary = d.summary, !summary.isEmpty {
            return Live(id: card.id, text: summary, mono: d.summaryMono, command: command)
        }
        if let meta = d.meta { return Live(id: card.id, text: meta, mono: true, command: command) }
        return Live(id: card.id, text: d.label, mono: false, command: command)
    }

    /// What one kind of call adds to the sentence.
    private enum Verb: Hashable {
        case list, shell, read, search, edit, write, fetch, web, todo, other

        static func of(_ card: ToolCard) -> Verb {
            switch card.name {
            case "Bash":
                let command = ToolDisplay.shellCommandSummary(card.input["command"]?.stringValue ?? "")
                let word = command.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
                return ["ls", "tree", "find"].contains(word) ? .list : .shell
            case "Read": return .read
            case "Grep", "Glob": return .search
            case "Edit", "MultiEdit", "apply_patch": return .edit
            case "Write": return .write
            case "WebFetch": return .fetch
            case "WebSearch": return .web
            case "TodoWrite": return .todo
            default: return .other
            }
        }

        /// Three edits to one file are one file edited.
        var countsFiles: Bool { self == .read || self == .edit || self == .write }

        func phrase(_ n: Int) -> String {
            func plural(_ one: String, _ many: String) -> String { "\(n) \(n == 1 ? one : many)" }
            switch self {
            case .list:   return "listed \(plural("directory", "directories"))"
            case .shell:  return "ran \(plural("shell command", "shell commands"))"
            case .read:   return "read \(plural("file", "files"))"
            case .search: return "searched \(plural("time", "times"))"
            case .edit:   return "edited \(plural("file", "files"))"
            case .write:  return "wrote \(plural("file", "files"))"
            case .fetch:  return "fetched \(plural("page", "pages"))"
            case .web:    return "searched the web \(plural("time", "times"))"
            case .todo:   return "updated the plan"
            case .other:  return "used \(plural("tool", "tools"))"
            }
        }
    }
}
