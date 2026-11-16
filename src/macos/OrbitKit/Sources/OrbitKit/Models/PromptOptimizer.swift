import Foundation

// Prompt optimizer (design docs/prompt-optimizer-design.md, board docs/mocks/prompt-optimizer/01-board.png).
// The server owns the feature — it calls DeepSeek with its own key — so this file only reads and
// writes the fields of @orbit/shared prompt-optimizer.ts, says them in the board's words, and holds
// the composer's rules: when ✦ Optimize shows, what Use and Undo do to the box, and when a send
// carries `skipTranslation` or `optimizedTranslation`. The views (ComposerView, Settings) draw what this decides.

// MARK: - Wire

/// `POST /prompt-optimizations`. A session supplies its own workspace and project; a brand-new
/// draft has no session yet, so it names the workspace (and project) the composer picked.
public struct PromptOptimizationRequest: Codable, Equatable, Sendable {
    public let draft: String
    public let sessionId: String?
    public let workspaceId: String?
    public let projectId: String?
    public init(draft: String, sessionId: String? = nil, workspaceId: String? = nil, projectId: String? = nil) {
        self.draft = draft
        self.sessionId = sessionId
        self.workspaceId = workspaceId
        self.projectId = projectId
    }
}

/// One run of the optimized prompt. `added` marks text drawn from context, which the card tints.
public struct PromptOptimizationSegment: Codable, Equatable, Sendable {
    public let text: String
    public let added: Bool
    public init(text: String, added: Bool) {
        self.text = text
        self.added = added
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        added = (try? c.decodeIfPresent(Bool.self, forKey: .added)) ?? false
    }
    private enum CodingKeys: String, CodingKey { case text, added }
}

/// One source of context the optimization read: a "Used: …" chip.
public enum PromptOptimizationContext: Equatable, Sendable, Decodable {
    case turns(count: Int)
    case recap
    case project(title: String)
    case wiki(count: Int)
    case workspace(name: String)
    /// A kind this client does not know yet: decoded rather than failing the whole answer, drawn as nothing.
    case unknown(String)

    private enum CodingKeys: String, CodingKey { case kind, count, title, name }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "TURNS":     self = .turns(count: (try? c.decode(Int.self, forKey: .count)) ?? 0)
        case "RECAP":     self = .recap
        case "PROJECT":   self = .project(title: (try? c.decode(String.self, forKey: .title)) ?? "")
        case "WIKI":      self = .wiki(count: (try? c.decode(Int.self, forKey: .count)) ?? 0)
        case "WORKSPACE": self = .workspace(name: (try? c.decode(String.self, forKey: .name)) ?? "")
        default:          self = .unknown(kind)
        }
    }

    /// The chip's words, or nil for a kind the card does not draw.
    public var chip: String? {
        switch self {
        case .turns(let n):        return n == 1 ? "this session's last turn" : "this session's last \(n) turns"
        case .recap:               return "session recap"
        case .project(let title):  return "project \"\(title)\" goal"
        case .wiki(let n):         return n == 1 ? "1 wiki entry" : "\(n) wiki entries"
        case .workspace(let name): return "workspace \"\(name)\""
        case .unknown:             return nil
        }
    }
}

/// The 200 answer of `POST /prompt-optimizations`.
public struct PromptOptimization: Decodable, Equatable, Sendable {
    /// Concatenated, they are the optimized prompt.
    public let segments: [PromptOptimizationSegment]
    /// The concatenation of `segments`.
    public let text: String
    /// The account's agent language ("Agents work in", English by default) when the owner's
    /// Translation is on; otherwise the draft's own language. A `TranslationLanguage` raw value.
    public let language: String
    /// Present only when Translation is on: the same prompt in the owner's language, for reading.
    public let gloss: String?
    /// Exactly the sources that contributed, in the order the card draws them.
    public let contextUsed: [PromptOptimizationContext]

    public init(segments: [PromptOptimizationSegment], text: String? = nil, language: String,
                gloss: String? = nil, contextUsed: [PromptOptimizationContext] = []) {
        self.segments = segments
        self.text = text ?? segments.map(\.text).joined()
        self.language = language
        self.gloss = gloss
        self.contextUsed = contextUsed
    }

    private enum CodingKeys: String, CodingKey { case segments, text, language, gloss, contextUsed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let segments = try c.decode([PromptOptimizationSegment].self, forKey: .segments)
        self.segments = segments
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? segments.map(\.text).joined()
        language = try c.decodeIfPresent(String.self, forKey: .language) ?? "en"
        let g = try c.decodeIfPresent(String.self, forKey: .gloss)
        gloss = (g?.isEmpty ?? true) ? nil : g
        contextUsed = (try? c.decodeIfPresent([PromptOptimizationContext].self, forKey: .contextUsed)) ?? []
    }

    /// The prompt's language, or nil for a code this client does not know.
    public var promptLanguage: TranslationLanguage? { TranslationLanguage(rawValue: language) }

    /// Whether the prompt was written in the agent language for a translating account (D2): the
    /// server writes a gloss exactly then. The card then opens on the gloss, and Use inserts it.
    public var isInAgentLanguage: Bool { gloss != nil }

    /// What Use puts in the box (D2): the owner-language reading copy when there is one, else the prompt.
    public var insertText: String { gloss ?? text }

    /// The "Used: …" chips, in the server's order.
    public var chips: [String] { contextUsed.compactMap(\.chip) }
}

// MARK: - Copy

/// Every word the iOS and macOS clients show about the optimizer (board frames 1–6).
public enum PromptOptimizerCopy {
    // Settings (frames 1 and 1b)
    public static let title = "Prompt optimizer"
    public static let hint = "Show an Optimize button in the composer. DeepSeek rewrites your draft with this session's context; you review it before it replaces the draft."
    public static let unavailable = "This server has no DeepSeek key (DEEPSEEK_API_KEY), so it cannot optimize prompts."
    /// The switch's accessibility identifier: a Mac Form draws a Toggle with no label of its own.
    public static let toggleIdentifier = "settings.promptOptimizer.enabled"

    // Composer (frames 2–3)
    public static let optimize = "Optimize"
    public static let optimizing = "Optimizing…"
    public static let optimizeHelp = "Have DeepSeek improve this draft before you send it · Tab · ⌘⇧O"
    public static let cancelHelp = "Stop optimizing"
    public static let buttonIdentifier = "composer.optimize"

    // The suggestion (frame 4)
    public static let cardTitle = "Optimized prompt"
    public static let basedOnEarlierDraft = "Based on an earlier draft"
    public static let used = "Used:"
    public static let use = "Use"
    public static let editThenUse = "Edit, then use"
    /// A phone's shorter "Edit, then use".
    public static let edit = "Edit"
    /// A phone's line under the gloss (as under a bilingual message): "Sent to the agent in English",
    /// and its Show / Hide for the prompt beneath.
    public static func sentToAgent(_ language: TranslationLanguage?) -> String {
        TranslationCopy.sentToAgentLabel(language ?? .agentDefault)
    }
    public static let show = "Show"
    public static let hide = "Hide"
    /// A phone's "Used:" chips as one line: "Used this session's last 106 turns · session recap".
    public static func usedLine(_ chips: [String]) -> String { "Used " + chips.joined(separator: " · ") }
    public static let tryAgain = "Try again"
    public static let dismiss = "Dismiss"
    /// The Mac card's keys: Tab in the box is Use (as it takes a reply suggestion), Esc dismisses.
    public static let keysHint = "Tab uses it · Esc dismisses · your draft is kept"
    /// The key drawn inside Use on a Mac.
    public static let useKey = "Tab"
    /// From the gloss the card opens on to the prompt the agent receives: the prompt's own language
    /// ("Show in English"), or "Show original" for a code this client does not know.
    public static func showPrompt(_ language: TranslationLanguage?) -> String {
        language.map(showIn) ?? TranslationCopy.showOriginal
    }
    public static func showIn(_ language: TranslationLanguage) -> String { "Show in \(language.bareName)" }
    /// Under a gloss (D2): which language the agent gets, so the reader knows what they are not reading.
    public static func agentReceives(_ language: TranslationLanguage?) -> String {
        "The agent receives the \(language?.bareName ?? "translated") version."
    }

    // After Use (frame 5) and failure (frame 6)
    public static let replaced = "Draft replaced with the optimized prompt"
    public static let undo = "Undo"
    public static let failed = "Couldn't optimize this draft."
}

extension TranslationLanguage {
    /// The language's name without its parenthesis: "Chinese", as "Show in Chinese" says it.
    public var bareName: String {
        name.range(of: " (").map { String(name[..<$0.lowerBound]) } ?? name
    }
}

// MARK: - Rules

public enum PromptOptimizer {
    /// The account's switch: absent means on, and only an explicit `false` turns it off.
    public static func switchedOn(_ preferences: UserPreferences?) -> Bool {
        preferences?.promptOptimizer != false
    }

    /// Whether the account offers ✦ Optimize: switched on, and the server able to.
    public static func isOn(_ user: User?) -> Bool {
        switchedOn(user?.preferences) && user?.promptOptimizerAvailable == true
    }

    /// Whether Settings draws the switch disabled with frame 1b's notice. Only a `me` that says so:
    /// a login payload (no field at all) is not a server without a key.
    public static func unavailable(_ user: User?) -> Bool {
        user?.promptOptimizerAvailable == false
    }

    /// Whether the composer shows ✦ Optimize for this draft (frame 2, the web's rules): the account
    /// has it on, and the box holds words — not empty, not a `!` shell command, and not only a
    /// `/command`.
    public static func showsButton(on: Bool, text: String) -> Bool {
        guard on else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.hasPrefix("!") else { return false }
        if trimmed.hasPrefix("/"), !trimmed.contains(where: { $0.isWhitespace }) { return false }
        return true
    }

    /// The line a failed press shows (frame 6). Every failure says the same: the draft is untouched.
    public static func failureLine(_ error: Error) -> String { PromptOptimizerCopy.failed }

    /// One drawn run of the card's text: what it says, whether context added it (tinted), and
    /// whether it was a `code` span (monospaced, the backticks dropped).
    public struct Run: Equatable, Sendable {
        public let text: String
        public let added: Bool
        public let code: Bool
        public init(text: String, added: Bool, code: Bool) {
            self.text = text
            self.added = added
            self.code = code
        }
    }

    /// The segments cut at their backticks, so `returnTo` draws monospaced as on the board. An
    /// unmatched backtick stays as written.
    public static func runs(_ segments: [PromptOptimizationSegment]) -> [Run] {
        segments.flatMap { seg -> [Run] in
            let parts = seg.text.components(separatedBy: "`")
            // An odd number of backticks: the segment stays as the server wrote it.
            guard parts.count % 2 == 1 else {
                return seg.text.isEmpty ? [] : [Run(text: seg.text, added: seg.added, code: false)]
            }
            return parts.enumerated().compactMap { i, part in
                part.isEmpty ? nil : Run(text: part, added: seg.added, code: i % 2 == 1)
            }
        }
    }
}

/// The composer's optimizer, as a value: what the card shows and what Use, Undo and Send do with the
/// box. ConsoleModel holds one and runs the request; everything that decides is here.
public struct PromptOptimizerState: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case idle
        /// The press is out; `draft` is what was sent (frame 3). The box stays editable.
        case optimizing(draft: String)
        /// The suggestion (frame 4). `draft` is what it was made from.
        case suggestion(PromptOptimization, draft: String)
        /// Frame 6: the draft is untouched; Try again sends `draft` again.
        case failed(draft: String)
    }

    public private(set) var phase: Phase = .idle
    /// Frame 4's "Show in <language>": flipped, the card shows the agent-language prompt instead of the
    /// gloss it opens on (D2). Without a gloss there is nothing to flip.
    public var showingPrompt = false
    /// After Use: the owner's own draft (Undo puts it back) and the text Use put in the box.
    public private(set) var undoDraft: String?
    public private(set) var inserted: String?
    /// D2: with a gloss inserted, the optimizer's agent-language prompt an unedited send carries as its
    /// translation; nil when Use inserted the prompt itself.
    private var insertedTranslation: String?
    /// The box's text when its card was last used or dismissed: Tab has had its go at that draft, so
    /// until it changes Tab moves focus again (Tab, Esc, Tab reaches the toolbar).
    public private(set) var spent: String?

    public init() {}

    /// Whether a bare Tab in the box optimizes: ✦ could take this draft, no card is open, no press is
    /// out, and Tab has not had its go at this exact text. Otherwise Tab moves focus as it always has.
    public func tabOptimizes(on: Bool, text: String) -> Bool {
        switch phase {
        case .idle, .failed: return text != spent && PromptOptimizer.showsButton(on: on, text: text)
        case .optimizing, .suggestion: return false
        }
    }

    public var isOptimizing: Bool { if case .optimizing = phase { return true } else { return false } }
    public var suggestion: PromptOptimization? {
        if case .suggestion(let s, _) = phase { return s } else { return nil }
    }
    public var failed: Bool { if case .failed = phase { return true } else { return false } }

    /// The press: the draft goes out. Pressing while busy cancels instead (`cancel`).
    public mutating func start(draft: String) {
        phase = .optimizing(draft: draft)
        showingPrompt = false
    }

    public mutating func cancel() {
        if isOptimizing { phase = .idle }
    }

    public mutating func succeeded(_ result: PromptOptimization) {
        guard case .optimizing(let draft) = phase else { return }
        phase = .suggestion(result, draft: draft)
        showingPrompt = false
    }

    public mutating func failedNow() {
        guard case .optimizing(let draft) = phase else { return }
        phase = .failed(draft: draft)
    }

    /// Frame 4's "Based on an earlier draft": the box changed while the press was out.
    public func basedOnEarlierDraft(current: String) -> Bool {
        guard case .suggestion(_, let draft) = phase else { return false }
        return draft != current
    }

    /// × / Esc: the card goes, the draft stays; so does the failure line. `current`, the box's text,
    /// is then spent for Tab; Try again dismisses without it.
    public mutating func dismiss(current: String? = nil) {
        switch phase {
        case .suggestion, .failed:
            phase = .idle
            if let current { spent = current }
        default: break
        }
        showingPrompt = false
    }

    /// Use (and Edit, then use): the text the box now holds, or nil with no suggestion. `current` is
    /// what the box holds now — the owner's draft Undo puts back.
    public mutating func use(current: String) -> String? {
        guard let s = suggestion else { return nil }
        undoDraft = current
        inserted = s.insertText
        spent = s.insertText
        insertedTranslation = s.gloss != nil ? s.text : nil
        phase = .idle
        showingPrompt = false
        return s.insertText
    }

    /// Whether frame 5's Undo is offered: Use happened and the box still holds what it put there.
    public func offersUndo(current: String) -> Bool {
        undoDraft != nil && inserted == current
    }

    /// Undo: the owner's own draft, or nil when there is nothing to undo.
    public mutating func undo(current: String) -> String? {
        guard offersUndo(current: current), let draft = undoDraft else { return nil }
        undoDraft = nil
        inserted = nil
        insertedTranslation = nil
        return draft
    }

    /// The toast went (timed out, or the box changed): Undo is no longer offered, but a send of the
    /// unedited text still needs no translator.
    public mutating func forgetUndo() { undoDraft = nil }

    /// Whether `raw` is still exactly what Use put in the box. Edited by one character, it is not.
    private func sendsInserted(_ raw: String) -> Bool {
        guard let inserted else { return false }
        return raw.trimmingCharacters(in: .whitespacesAndNewlines)
            == inserted.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// D2: a send carries `skipTranslation` only when its text is still exactly the optimized prompt
    /// Use put in the box with no gloss beside it. Edited, it is translated as usual.
    public func skipTranslation(sending raw: String) -> Bool {
        insertedTranslation == nil && sendsInserted(raw)
    }

    /// D2: the `optimizedTranslation` a send carries — the optimizer's agent-language prompt — when its
    /// text is still exactly the gloss Use put in the box; nil otherwise, and once edited.
    public func optimizedTranslation(sending raw: String) -> String? {
        sendsInserted(raw) ? insertedTranslation : nil
    }

    /// After a send: the optimized text is spent.
    public mutating func sent() {
        undoDraft = nil
        inserted = nil
        insertedTranslation = nil
    }
}
