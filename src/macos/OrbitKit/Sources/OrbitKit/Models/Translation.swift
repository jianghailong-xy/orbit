import Foundation

// Settings › Translation (board docs/mocks/session-translation/01-board.png, frames 7–8; behaviour
// as frames 4–6). The server owns the feature — it translates with its own DeepSeek key — so this
// file only reads the fields it writes (@orbit/shared translation.ts) and says them in the web's
// words (`TranslationCopyParityTests` reads them back out of the web sources).

/// The one curated list both pickers offer, "Your language" and "Agents work in", in the order of
/// `TRANSLATION_LANGUAGES` (@orbit/shared translation.ts).
public enum TranslationLanguage: String, CaseIterable, Codable, Equatable, Sendable {
    case en
    case zhHans = "zh-Hans"
    case zhHant = "zh-Hant"
    case ja, ko, es, fr, de, ru, pt, it
    case nl, ar, hi, tr, vi, th, id, pl
    case uk, he, sv, cs, da, fi, el, hu
    case ro, ms, bn

    /// What a preference without an owner language means: the board's default pick.
    public static let `default`: TranslationLanguage = .zhHans
    /// What a preference without an agent language means: English, as before it could be chosen
    /// (`DEFAULT_AGENT_LANGUAGE`).
    public static let agentDefault: TranslationLanguage = .en

    /// The language's English name, as Settings lists it (`TRANSLATION_LANGUAGE_NAMES`).
    public var name: String {
        switch self {
        case .en:     return "English"
        case .zhHans: return "Chinese (Simplified)"
        case .zhHant: return "Chinese (Traditional)"
        case .ja:     return "Japanese"
        case .ko:     return "Korean"
        case .es:     return "Spanish"
        case .fr:     return "French"
        case .de:     return "German"
        case .ru:     return "Russian"
        case .pt:     return "Portuguese"
        case .it:     return "Italian"
        case .nl:     return "Dutch"
        case .ar:     return "Arabic"
        case .hi:     return "Hindi"
        case .tr:     return "Turkish"
        case .vi:     return "Vietnamese"
        case .th:     return "Thai"
        case .id:     return "Indonesian"
        case .pl:     return "Polish"
        case .uk:     return "Ukrainian"
        case .he:     return "Hebrew"
        case .sv:     return "Swedish"
        case .cs:     return "Czech"
        case .da:     return "Danish"
        case .fi:     return "Finnish"
        case .el:     return "Greek"
        case .hu:     return "Hungarian"
        case .ro:     return "Romanian"
        case .ms:     return "Malay"
        case .bn:     return "Bengali"
        }
    }

    /// The name without its parenthesis: "Chinese (Simplified)" reads "Chinese".
    public var shortName: String {
        name.range(of: " (").map { String(name[..<$0.lowerBound]) } ?? name
    }

    /// The composer tag (6A): "<Language> → <Agent language>", both without their parenthesis —
    /// "Chinese → English".
    public func tag(to agent: TranslationLanguage) -> String {
        "\(shortName) → \(agent.shortName)"
    }

    /// The composer tag while the server is skipping a failing translator (policy board
    /// docs/ux/translation-failure-policy.html, frame 6): "Chinese → English · unavailable, messages will wait".
    public func tag(to agent: TranslationLanguage, unavailable: Bool) -> String {
        unavailable ? "\(tag(to: agent)) · \(TranslationCopy.unavailableTag)" : tag(to: agent)
    }
}

/// The words every client shows about translation, byte for byte the web's (`TRANSLATION_COPY` in
/// src/web/src/lib/translation.ts and the Translation section of src/web/src/pages/settings/GeneralPage.tsx).
public enum TranslationCopy {
    // MARK: Settings › Translation
    public static let title = "Translation"
    public static let translateConversations = "Translate conversations"
    /// The switch's line, naming the language agents work in (web: `translationEnabledDescription`).
    public static func translateConversationsHint(_ agentLanguage: TranslationLanguage) -> String {
        "Agents read and write in \(agentLanguage.name); you write and read in your language. Your messages are translated before the agent gets them, its replies before you see them. Tool calls, output and code stay as they are."
    }
    public static let yourLanguage = "Your language"
    public static let yourLanguageHint = "What you write in, and what replies are shown in."
    public static let agentsWorkIn = "Agents work in"
    public static let agentsWorkInHint = "What the agent receives and answers in."
    public static let footnote = "Translated by the server's DeepSeek model. Applies to every session from its next message; what's already in a conversation stays as it was."
    /// Board frame 2: the server has no DeepSeek key, so the switch is drawn disabled.
    public static let unavailable = "This server has no DeepSeek key, so it can't translate. Whoever runs it sets DEEPSEEK_API_KEY and restarts it."
    /// Accessibility identifiers of the switch and the language picker: a Mac Form draws a Toggle's
    /// switch with no label of its own, so UI tests find them by these.
    public static let toggleIdentifier = "settings.translation.enabled"
    public static let languageIdentifier = "settings.translation.language"
    public static let agentLanguageIdentifier = "settings.translation.agentLanguage"
    /// "Show both languages" (docs/mocks/session-translation/02-bilingual.png, mark A): shown only
    /// while the switch above is on; the footer gains `bilingualFootnote` (mark B).
    public static let showBothLanguages = "Show both languages"
    public static let bilingualFootnote = "With both languages on, each translated message also shows the words the agent read or wrote, in the language agents work in."
    public static let bilingualIdentifier = "settings.translation.bilingual"

    // MARK: In a conversation (frames 4–6)
    public static let translated = "Translated"
    public static let showOriginal = "Show original"
    /// "Show both languages": hides one message's original, and brings it back (not "Show original",
    /// which swaps the translation for the original).
    public static let hideOriginal = "Hide original"
    public static let showBoth = "Show both"
    public static let showTranslation = "Show translation"
    public static let original = "Original"
    public static let translating = "Translating…"
    public static let sendFailed = "Couldn't translate, so it wasn't sent"
    /// Frame 6 of docs/ux/translation-failure-policy.html: after the composer tag while translation is unavailable.
    public static let unavailableTag = "unavailable, messages will wait"
    public static let retry = "Retry"
    public static let sendAsWritten = "Send as written"
    public static let cancel = "Cancel"
    public static let replyPending = "Translates when the reply is done"
    public static let replyFailed = "Couldn't translate this reply"
    /// Why a held message (or a card answer, `answer: true`) was not sent: the B column of frame 7 of
    /// docs/ux/translation-failure-policy.html, drawn before "· Retry · Send as written". With no
    /// reason, or one the board gives no sentence for (NO_KEY, HTTP without a status), it is the
    /// generic `sendFailed`.
    public static func sendFailed(_ reason: TranslationFailureReason?, httpStatus: Int? = nil,
                                  answer: Bool = false) -> String {
        guard let cause = failureCause(reason, httpStatus: httpStatus) else { return sendFailed }
        return "\(cause), so \(answer ? "your answer" : "it") wasn't sent"
    }

    private static func failureCause(_ reason: TranslationFailureReason?, httpStatus: Int?) -> String? {
        switch reason {
        case .timeout: return "The translator didn't answer in time"
        case .network: return "The translator was unreachable"
        case .http:
            guard let status = httpStatus else { return nil }
            if status == 429 || status >= 500 { return "The translator was unreachable" }
            if (400..<500).contains(status) { return "The translator refused the message" }
            return nil
        case .truncated: return "Too long to translate"
        case .mangled, .empty: return "The translation came back damaged"
        case .unavailable: return "Translation is unavailable right now"
        case .noKey, nil: return nil
        }
    }

    // "Show both languages" in a conversation (02-bilingual.png, frames 2–4).
    public static let sentToAgent = "Sent to the agent in"
    public static let show = "Show"
    public static let lines = "lines"

    /// Under the owner's bilingual message: "Sent to the agent in English", naming the agent
    /// language (web `sentToAgentLabel`).
    public static func sentToAgentLabel(_ agentLanguage: TranslationLanguage) -> String {
        "\(sentToAgent) \(agentLanguage.name)"
    }

    /// The collapsed original's press (frame 3): "Show English · 9 lines", naming the agent language
    /// (web `showEnglishLabel`).
    public static func showEnglishLabel(lines count: Int, _ agentLanguage: TranslationLanguage = .agentDefault) -> String {
        "\(show) \(agentLanguage.name) · \(count) \(lines)"
    }
}

/// "Show both languages" (02-bilingual.png): the English drawn under a translated message, and when
/// a reply's English collapses. The same rule as @orbit/shared `bilingualEnglish` /
/// `bilingualLineCount`, so every client counts the same N.
public enum BilingualEnglish {
    /// Over this many lines a reply's English starts collapsed to a two-line preview (frame 3, B).
    public static let collapseLines = 6
    /// A source line wraps every this many characters, for the count.
    public static let lineChars = 60

    /// The English's prose: a fenced code block is drawn once, in the translation, never again here
    /// (board mark D). An unclosed fence is left as it is.
    public static func prose(_ text: String) -> String {
        let lines = text.components(separatedBy: "\n")
        var out: [String] = []
        var i = 0
        while i < lines.count {
            if let fence = fenceOpener(lines[i]),
               let close = lines[(i + 1)...].firstIndex(where: { isFence($0, fence) }) {
                out.append("")
                i = close + 1
                continue
            }
            out.append(lines[i])
            i += 1
        }
        var joined = out.joined(separator: "\n")
        while joined.contains("\n\n\n") { joined = joined.replacingOccurrences(of: "\n\n\n", with: "\n\n") }
        return joined.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// How many lines `english` runs to: each non-blank source line, wrapped every `lineChars`.
    public static func lineCount(_ english: String) -> Int {
        english.components(separatedBy: "\n").reduce(0) { sum, line in
            let length = line.trimmingCharacters(in: .whitespaces).unicodeScalars.count
            return sum + (length + lineChars - 1) / lineChars
        }
    }

    /// Whether a reply's English starts collapsed.
    public static func collapses(_ english: String) -> Bool { lineCount(english) > collapseLines }

    private static func leadingSpaces(_ line: String) -> Substring? {
        let spaces = line.prefix { $0 == " " }
        return spaces.count <= 3 ? line.dropFirst(spaces.count) : nil
    }

    private static func fenceOpener(_ line: String) -> String? {
        guard let rest = leadingSpaces(line) else { return nil }
        if rest.hasPrefix("```") { return "```" }
        if rest.hasPrefix("~~~") { return "~~~" }
        return nil
    }

    private static func isFence(_ line: String, _ fence: String) -> Bool {
        leadingSpaces(line)?.hasPrefix(fence) == true
    }
}

/// "Show both languages", interleaved (docs/mocks/session-translation/03-interleaved.png): an agent
/// reply drawn block by block, each paragraph, list item, heading or quote in the owner's language with
/// its original right under it. Line for line the rule of @orbit/shared `bilingualPairs` (and Android
/// `Translation.bilingualPairs`), all three walked through `src/shared/src/bilingual-pairs.fixture.json`:
///
///  - Both texts split into blocks by lines: a fenced code block (``` or ~~~ opening and the same fence
///    closing, at most 3 spaces in from the block's column; an unclosed fence is not one), a heading, a
///    list item with the lines that continue it, a quote (consecutive `>` lines), a table (consecutive
///    lines starting with `|`), a thematic break, and otherwise a paragraph.
///  - `depth` is how many list items the block sits inside, by indentation.
///  - Paragraphs, headings, items and quotes pair; code, tables, breaks and image-only paragraphs are
///    `.other`: drawn once, from the translation, and dropped from the original.
///  - The pairable sequences must match in count, kind and depth, or `pairs` is nil and the reply is
///    drawn whole as before (frame 4). Nothing to pair is nil too.
public enum BilingualPairs {
    public enum Kind: String, Codable, Equatable, Sendable {
        case paragraph, heading, item, quote, other
    }

    /// One block of the translation, in order: `text` without its indentation (an item's without its
    /// `marker`, a quote's without its `>`s, a heading's whole line), and `original` the matching block
    /// of the original in the same form — a heading's words alone. `.other` carries no original.
    public struct Pair: Codable, Equatable, Sendable {
        public let kind: Kind
        public let depth: Int
        public let marker: String?
        public let text: String
        public let original: String?

        public init(kind: Kind, depth: Int, marker: String? = nil, text: String, original: String? = nil) {
            self.kind = kind
            self.depth = depth
            self.marker = marker
            self.text = text
            self.original = original
        }

        /// An ordered item's number ("3." → 3); nil for a bullet.
        public var number: Int? {
            guard let marker, let first = marker.first, first.isASCII, first.isNumber else { return nil }
            return Int(marker.dropLast())
        }
    }

    private struct Block {
        let kind: Kind
        let depth: Int
        let marker: String?
        let body: String
        let words: String
    }

    private static func re(_ pattern: String) -> NSRegularExpression {
        // The patterns are literals below; one that does not compile is a programming error.
        try! NSRegularExpression(pattern: pattern)
    }

    private static let fence = re("^ *(```|~~~)")
    private static let heading = re("^ {0,3}(#{1,6})(?: +|$)(.*)$")
    private static let item = re("^( *)([-*+]|[0-9]{1,9}[.)])( +|$)(.*)$")
    private static let breakRule = re("^ {0,3}([-*_])(?: *\\1){2,} *$")
    private static let quote = re("^ {0,3}>")
    private static let table = re("^ *\\|")
    private static let images = re("^(?:!\\[[^\\]]*\\]\\([^)]*\\)\\s*)+$")
    private static let headingClose = re("(?:^| +)#+ *$")
    private static let quoteMark = re("^ {0,3}> ?")

    /// The groups of `pattern`'s first match in `s` ("" for a group that took no part), or nil.
    private static func match(_ pattern: NSRegularExpression, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = pattern.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map {
            let r = m.range(at: $0)
            return r.location == NSNotFound ? "" : ns.substring(with: r)
        }
    }

    private static func test(_ pattern: NSRegularExpression, _ s: String) -> Bool { match(pattern, s) != nil }

    private static func replace(_ pattern: NSRegularExpression, _ s: String, with template: String = "") -> String {
        pattern.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length),
                                         withTemplate: template)
    }

    private static func indentOf(_ line: String) -> Int { line.prefix { $0 == " " }.count }

    private static func dedent(_ line: String, _ n: Int) -> String { String(line.dropFirst(min(n, indentOf(line)))) }

    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private static func isBlank(_ line: String) -> Bool { trimmed(line).isEmpty }

    private static func trimStart(_ s: String) -> Substring {
        s.drop { $0.unicodeScalars.allSatisfy(CharacterSet.whitespacesAndNewlines.contains) }
    }

    private static func startsBlock(_ line: String) -> Bool {
        test(fence, line) || test(heading, line) || test(breakRule, line) || test(item, line)
            || test(quote, line) || test(table, line)
    }

    private static func blocks(_ text: String) -> [Block] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var blocks: [Block] = []
        // The content column of each open list item, innermost last.
        var items: [Int] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if isBlank(line) { i += 1; continue }
            let indent = indentOf(line)
            while let last = items.last, indent < last { items.removeLast() }
            let depth = items.count
            func push(_ kind: Kind, _ body: String, _ words: String? = nil) {
                blocks.append(Block(kind: kind, depth: depth, marker: nil, body: body, words: words ?? body))
            }
            // A fence opens at most 3 spaces in from the column its block sits at, and closes the same way.
            let base = depth > 0 ? items[depth - 1] : 0
            let rest = String(trimStart(line))
            let opener: String? = indent - base <= 3 ? (rest.hasPrefix("```") ? "```" : rest.hasPrefix("~~~") ? "~~~" : nil) : nil
            if let opener {
                var close = i + 1
                while close < lines.count,
                      !(indentOf(lines[close]) - base <= 3 && trimStart(lines[close]).hasPrefix(opener)) {
                    close += 1
                }
                if close < lines.count {
                    push(.other, lines[i...close].map { dedent($0, indent) }.joined(separator: "\n"))
                    i = close + 1
                    continue
                }
            }
            if let h = match(heading, line) {
                push(.heading, trimmed(line), trimmed(replace(headingClose, h[2])))
                i += 1
                continue
            }
            if test(breakRule, line) {
                push(.other, trimmed(line))
                i += 1
                continue
            }
            if let m = match(item, line) {
                let spaces = m[3].count
                let column = indent + m[2].count + (spaces >= 1 && spaces <= 4 ? spaces : 1)
                var body = [m[4]]
                i += 1
                while i < lines.count, !isBlank(lines[i]), !startsBlock(lines[i]) {
                    body.append(dedent(lines[i], column))
                    i += 1
                }
                let joined = body.joined(separator: "\n")
                blocks.append(Block(kind: .item, depth: depth, marker: m[2], body: joined, words: joined))
                items.append(column)
                continue
            }
            if test(quote, line) {
                var body: [String] = []
                while i < lines.count, test(quote, lines[i]) {
                    body.append(replace(quoteMark, lines[i]))
                    i += 1
                }
                push(.quote, body.joined(separator: "\n"))
                continue
            }
            if test(table, line) {
                var body: [String] = []
                while i < lines.count, test(table, lines[i]) {
                    body.append(dedent(lines[i], indent))
                    i += 1
                }
                push(.other, body.joined(separator: "\n"))
                continue
            }
            var body = [dedent(line, indent)]
            i += 1
            while i < lines.count, !isBlank(lines[i]), !startsBlock(lines[i]) {
                body.append(dedent(lines[i], indent))
                i += 1
            }
            let joined = body.joined(separator: "\n")
            push(test(images, trimmed(joined)) ? .other : .paragraph, joined)
        }
        return blocks
    }

    /// The translation's blocks with the original's matched under them, or nil when the two do not
    /// split into the same pairable blocks (draw the reply whole, as before; frame 4).
    public static func pairs(_ translation: String, _ original: String) -> [Pair]? {
        let ours = blocks(translation)
        let theirs = blocks(original).filter { $0.kind != .other }
        let pairable = ours.filter { $0.kind != .other }
        guard !pairable.isEmpty, pairable.count == theirs.count else { return nil }
        for (a, b) in zip(pairable, theirs) where a.kind != b.kind || a.depth != b.depth { return nil }
        var k = 0
        return ours.map { (b: Block) -> Pair in
            guard b.kind != .other else { return Pair(kind: b.kind, depth: b.depth, marker: b.marker, text: b.body) }
            defer { k += 1 }
            return Pair(kind: b.kind, depth: b.depth, marker: b.marker, text: b.body, original: theirs[k].words)
        }
    }
}

/// Where one of the owner's messages is in translation (`TurnTranslationState`).
public enum TurnTranslationState: String, Codable, Equatable, Sendable {
    /// Being translated; not delivered to the engine yet ("Translating…").
    case translating = "TRANSLATING"
    /// Failed or timed out (20 s); NOT delivered (1A): Retry / Send as written.
    case failed = "FAILED"
    /// Delivered in English; `original` is what the owner wrote.
    case done = "DONE"
    /// Delivered untranslated at the owner's word.
    case sentAsWritten = "SENT_AS_WRITTEN"
}

/// Why translating the owner's words failed (`TranslationFailureReason`, @orbit/shared translation.ts):
/// on a FAILED turn's `failureReason` and on the 422 TRANSLATION_FAILED answer. A value this client
/// does not know reads as no reason (the generic failure line).
public enum TranslationFailureReason: String, Codable, CaseIterable, Equatable, Sendable {
    case timeout = "TIMEOUT"
    case network = "NETWORK"
    case http = "HTTP"
    case empty = "EMPTY"
    case truncated = "TRUNCATED"
    case mangled = "MANGLED"
    case noKey = "NO_KEY"
    case unavailable = "UNAVAILABLE"
}

/// The `translation` of a translated turn — on the queued/active turn list, a send's answer, and
/// the runner's `user` event. Absent on every message translation was not involved in.
public struct TurnTranslation: Codable, Equatable, Sendable {
    public var state: TurnTranslationState
    /// The language the owner wrote in. The target is the account's agent language.
    public var from: TranslationLanguage
    /// What the owner typed, as typed.
    public var original: String
    /// Why it failed, on a FAILED turn the server stored a reason for.
    public var failureReason: TranslationFailureReason?
    /// The translator's HTTP status, beside `failureReason == .http`.
    public var httpStatus: Int?

    public init(state: TurnTranslationState, from: TranslationLanguage, original: String,
                failureReason: TranslationFailureReason? = nil, httpStatus: Int? = nil) {
        self.state = state
        self.from = from
        self.original = original
        self.failureReason = failureReason
        self.httpStatus = httpStatus
    }

    private enum CodingKeys: String, CodingKey { case state, from, original, failureReason, httpStatus }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(TurnTranslationState.self, forKey: .state)
        from = try c.decode(TranslationLanguage.self, forKey: .from)
        original = try c.decode(String.self, forKey: .original)
        // An unknown reason, or a stray value, is no reason rather than a failed decode.
        failureReason = (try? c.decodeIfPresent(String.self, forKey: .failureReason))
            .flatMap { $0 }.flatMap(TranslationFailureReason.init(rawValue:))
        httpStatus = (try? c.decodeIfPresent(Int.self, forKey: .httpStatus)) ?? nil
    }

    /// Read off a payload's raw `translation`; nil unless every field is one this client knows,
    /// so a stray value never draws a foot that lies (web: `turnTranslationOf`). An unknown
    /// `failureReason` is dropped, not refused.
    public static func parse(_ value: JSONValue?) -> TurnTranslation? {
        guard let value,
              let state = value["state"]?.stringValue.flatMap(TurnTranslationState.init(rawValue:)),
              let from = value["from"]?.stringValue.flatMap(TranslationLanguage.init(rawValue:)),
              let original = value["original"]?.stringValue else { return nil }
        let reason = value["failureReason"]?.stringValue.flatMap(TranslationFailureReason.init(rawValue:))
        let status = value["httpStatus"]?.intValue
        return TurnTranslation(state: state, from: from, original: original, failureReason: reason, httpStatus: status)
    }

    /// Still waiting on its translation, so not delivered to the engine.
    public var held: Bool { state == .translating || state == .failed }
}

/// The answer to Retry and to Send as written on a held message.
public struct TranslationActionResponse: Decodable, Sendable {
    public let turnId: String
    public let translation: TurnTranslation
}

/// The `translation` key of a translated `assistant` or `prompt_suggestion` event's payload, and
/// the live `translation` event's (`TranslationEventPayload`, plus `of`). Exactly one of `text` and
/// `failed`.
public struct ReplyTranslation: Codable, Equatable, Sendable {
    public var lang: TranslationLanguage
    public var text: String?
    public var failed: Bool

    public init(lang: TranslationLanguage, text: String? = nil, failed: Bool = false) {
        self.lang = lang
        self.text = text
        self.failed = failed
    }

    public static func parse(_ value: JSONValue?) -> ReplyTranslation? {
        guard let value, let lang = value["lang"]?.stringValue.flatMap(TranslationLanguage.init(rawValue:)) else {
            return nil
        }
        if let text = value["text"]?.stringValue { return ReplyTranslation(lang: lang, text: text) }
        if value["failed"]?.boolValue == true { return ReplyTranslation(lang: lang, failed: true) }
        return nil
    }

    /// Whether the translation came back as the reply itself: the agent already wrote in the
    /// owner's language. Such a reply is drawn as it is, with no foot (web `translationUnchanged`).
    public func unchanged(from original: String) -> Bool {
        guard let text else { return false }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
            == original.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// One AskUserQuestion question as shown in the owner's language, index for index with
/// `input.questions[i]`.
public struct TranslatedQuestion: Codable, Equatable, Sendable {
    public struct Option: Codable, Equatable, Sendable {
        public var label: String
        public var description: String?
    }
    public var question: String
    public var header: String?
    public var options: [Option]
}

/// An approval card's `translation` (ApprovalInfo and the live `approval_request`): what the card
/// shows, in the owner's language (3A). `input` itself stays the English the engine sent.
public struct ApprovalTranslation: Codable, Equatable, Sendable {
    public var lang: TranslationLanguage
    /// The card could not be translated: draw it in English.
    public var failed: Bool
    public var description: String?
    public var plan: String?
    public var questions: [TranslatedQuestion]?
    // Orbit's own cards (orbit_task_create, orbit_task_batch, orbit_project_create,
    // orbit_blocker_resolve, orbit_dag_change): each the input field of the same name translated,
    // present only when the original has text; arrays go index for index with the input's.
    /// `input.title` (orbit_task_create, orbit_project_create).
    public var title: String?
    /// `input.acceptanceCriteria` (orbit_task_create).
    public var acceptanceCriteria: String?
    /// `input.tasks` (orbit_task_batch): `tasks[i]` is `input.tasks[i]` and `input.preview.tasks[i]`.
    public var tasks: [TranslatedTaskBody]?
    /// `input.goal` (orbit_project_create).
    public var goal: String?
    /// `input.instructions` (orbit_project_create).
    public var instructions: String?
    /// `input.acceptanceCriteriaItems` (orbit_project_create), index for index.
    public var acceptanceCriteriaItems: [TranslatedCriterionItem]?
    /// `input.reason` (orbit_blocker_resolve).
    public var reason: String?
    /// `input.note` (orbit_dag_change).
    public var note: String?

    public init(lang: TranslationLanguage, failed: Bool = false, description: String? = nil,
                plan: String? = nil, questions: [TranslatedQuestion]? = nil,
                title: String? = nil, acceptanceCriteria: String? = nil,
                tasks: [TranslatedTaskBody]? = nil, goal: String? = nil, instructions: String? = nil,
                acceptanceCriteriaItems: [TranslatedCriterionItem]? = nil,
                reason: String? = nil, note: String? = nil) {
        self.lang = lang
        self.failed = failed
        self.description = description
        self.plan = plan
        self.questions = questions
        self.title = title
        self.acceptanceCriteria = acceptanceCriteria
        self.tasks = tasks
        self.goal = goal
        self.instructions = instructions
        self.acceptanceCriteriaItems = acceptanceCriteriaItems
        self.reason = reason
        self.note = note
    }

    public static func parse(_ value: JSONValue?) -> ApprovalTranslation? {
        guard let value, let lang = value["lang"]?.stringValue.flatMap(TranslationLanguage.init(rawValue:)) else {
            return nil
        }
        var questions: [TranslatedQuestion]?
        if case .array(let qs)? = value["questions"] {
            questions = qs.map { q in
                var options: [TranslatedQuestion.Option] = []
                if case .array(let os)? = q["options"] {
                    options = os.map { .init(label: $0["label"]?.stringValue ?? "", description: $0["description"]?.stringValue) }
                }
                return TranslatedQuestion(question: q["question"]?.stringValue ?? "",
                                          header: q["header"]?.stringValue, options: options)
            }
        }
        var tasks: [TranslatedTaskBody]?
        if case .array(let ts)? = value["tasks"] {
            tasks = ts.map {
                TranslatedTaskBody(title: $0["title"]?.stringValue, description: $0["description"]?.stringValue,
                                   acceptanceCriteria: $0["acceptanceCriteria"]?.stringValue)
            }
        }
        var items: [TranslatedCriterionItem]?
        if case .array(let cs)? = value["acceptanceCriteriaItems"] {
            items = cs.map {
                TranslatedCriterionItem(text: $0["text"]?.stringValue,
                                        verificationMethod: $0["verificationMethod"]?.stringValue)
            }
        }
        return ApprovalTranslation(lang: lang, failed: value["failed"]?.boolValue == true,
                                   description: value["description"]?.stringValue,
                                   plan: value["plan"]?.stringValue, questions: questions,
                                   title: value["title"]?.stringValue,
                                   acceptanceCriteria: value["acceptanceCriteria"]?.stringValue,
                                   tasks: tasks, goal: value["goal"]?.stringValue,
                                   instructions: value["instructions"]?.stringValue,
                                   acceptanceCriteriaItems: items,
                                   reason: value["reason"]?.stringValue, note: value["note"]?.stringValue)
    }

    /// The card's `input` as it is shown: the questions, a tool card's description and a plan in the
    /// owner's language, wherever the server translated them, and the English everywhere else. Answers
    /// are keyed by what is shown; the server maps a translated question and label back to the
    /// original before the engine reads them (web: `shownQuestions`).
    public static func shownInput(_ input: JSONValue?, _ translation: ApprovalTranslation?) -> JSONValue? {
        guard let translation, !translation.failed, case .object(var obj)? = input else { return input }
        if let d = nonEmpty(translation.description), obj["description"] != nil { obj["description"] = .string(d) }
        if let p = nonEmpty(translation.plan), obj["plan"] != nil { obj["plan"] = .string(p) }
        // Orbit's own cards: each field over its original, and only where the original has one.
        put(&obj, "title", translation.title)
        put(&obj, "acceptanceCriteria", translation.acceptanceCriteria)
        put(&obj, "goal", translation.goal)
        put(&obj, "instructions", translation.instructions)
        put(&obj, "reason", translation.reason)
        put(&obj, "note", translation.note)
        if let translated = translation.tasks {
            // A batch card draws `preview.tasks[i]` and opens `tasks[i]`: the same task twice.
            func tasks(_ value: JSONValue?) -> JSONValue? {
                guard case .array(let ts)? = value else { return value }
                return .array(ts.enumerated().map { i, t in
                    guard i < translated.count, case .object(var to) = t else { return t }
                    put(&to, "title", translated[i].title)
                    put(&to, "description", translated[i].description)
                    put(&to, "acceptanceCriteria", translated[i].acceptanceCriteria)
                    return .object(to)
                })
            }
            if obj["tasks"] != nil { obj["tasks"] = tasks(obj["tasks"]) }
            if case .object(var preview)? = obj["preview"], preview["tasks"] != nil {
                preview["tasks"] = tasks(preview["tasks"])
                obj["preview"] = .object(preview)
            }
        }
        if let translated = translation.acceptanceCriteriaItems, case .array(let cs)? = obj["acceptanceCriteriaItems"] {
            obj["acceptanceCriteriaItems"] = .array(cs.enumerated().map { i, c in
                guard i < translated.count, case .object(var co) = c else { return c }
                put(&co, "text", translated[i].text)
                put(&co, "verificationMethod", translated[i].verificationMethod)
                return .object(co)
            })
        }
        if let translated = translation.questions, case .array(let qs)? = obj["questions"] {
            obj["questions"] = .array(qs.enumerated().map { i, q in
                guard i < translated.count, case .object(var qo) = q else { return q }
                let t = translated[i]
                if let s = nonEmpty(t.question) { qo["question"] = .string(s) }
                if qo["header"] != nil, let h = nonEmpty(t.header) { qo["header"] = .string(h) }
                if case .array(let os)? = qo["options"] {
                    qo["options"] = .array(os.enumerated().map { j, o in
                        guard j < t.options.count, case .object(var oo) = o else { return o }
                        if let l = nonEmpty(t.options[j].label) { oo["label"] = .string(l) }
                        if oo["description"] != nil, let d = nonEmpty(t.options[j].description) {
                            oo["description"] = .string(d)
                        }
                        return .object(oo)
                    })
                }
                return .object(qo)
            })
        }
        return .object(obj)
    }

    /// An AskUserQuestion's questions as its card showed them: translated, index for index, where the
    /// server translated them, so an answered question's record keeps the owner's language. The
    /// answer is read off the English beforehand; options keep their index (web: `shownQuestions`).
    public static func shownQuestions(_ questions: [AskQuestion], _ translation: ApprovalTranslation?) -> [AskQuestion] {
        guard let translation, !translation.failed, let translated = translation.questions else { return questions }
        return questions.enumerated().map { i, q in
            guard i < translated.count else { return q }
            let t = translated[i]
            let options = q.options.enumerated().map { j, o in
                guard j < t.options.count else { return o }
                return AskOption(label: nonEmpty(t.options[j].label) ?? o.label,
                                 description: o.description == nil ? nil : nonEmpty(t.options[j].description) ?? o.description)
            }
            return AskQuestion(header: q.header == nil ? nil : nonEmpty(t.header) ?? q.header,
                               question: nonEmpty(t.question) ?? q.question,
                               options: options,
                               multiSelect: q.multiSelect)
        }
    }

    /// The translated question cards of a session, by their call's tool_use id.
    public static func byToolUse(_ approvals: [ApprovalInfo]) -> [String: ApprovalTranslation] {
        var out: [String: ApprovalTranslation] = [:]
        for a in approvals where Approvals.isQuestion(toolName: a.toolName ?? "") {
            if let id = a.toolUseId, let t = parse(a.translation) { out[id] = t }
        }
        return out
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    /// `obj[key]` = `value`, when both the original and its translation have text.
    private static func put(_ obj: inout [String: JSONValue], _ key: String, _ value: String?) {
        if let v = nonEmpty(value), obj[key] != nil { obj[key] = .string(v) }
    }
}

/// One task of a batch card as shown in the owner's language (`ApprovalTranslation.tasks`).
public struct TranslatedTaskBody: Codable, Equatable, Sendable {
    public var title: String?
    public var description: String?
    public var acceptanceCriteria: String?

    public init(title: String? = nil, description: String? = nil, acceptanceCriteria: String? = nil) {
        self.title = title
        self.description = description
        self.acceptanceCriteria = acceptanceCriteria
    }
}

/// One of a new project's criteria as shown in the owner's language
/// (`ApprovalTranslation.acceptanceCriteriaItems`).
public struct TranslatedCriterionItem: Codable, Equatable, Sendable {
    public var text: String?
    public var verificationMethod: String?

    public init(text: String? = nil, verificationMethod: String? = nil) {
        self.text = text
        self.verificationMethod = verificationMethod
    }
}

/// What the account's translation setting comes to, and what a translated message says under it.
public enum SessionTranslation {
    /// The language the account writes and reads in; absent (or unknown) is the default pick.
    public static func language(_ prefs: UserPreferences?) -> TranslationLanguage {
        prefs?.translationLanguage.flatMap(TranslationLanguage.init(rawValue:)) ?? .default
    }

    /// The language agents work in ("Agents work in"); absent (or unknown) is English.
    public static func agentLanguage(_ prefs: UserPreferences?) -> TranslationLanguage {
        prefs?.translationAgentLanguage.flatMap(TranslationLanguage.init(rawValue:)) ?? .agentDefault
    }

    /// Whether the owner's messages are being translated now: switched on, and the server able to.
    public static func isOn(_ user: User?) -> Bool {
        user?.preferences?.translationEnabled == true && user?.translationAvailable == true
    }

    /// Whether translated messages also show their English ("Show both languages"): the account's
    /// switch, drawn only while translation itself is switched on (web: `bilingualOn`).
    public static func bilingual(_ prefs: UserPreferences?) -> Bool {
        prefs?.translationEnabled == true && prefs?.translationBilingual == true
    }

    /// The English under the owner's message with both languages on: what the agent got, once
    /// delivered in translation. Nil draws no block (held, failed, sent as written, or off).
    public static func userEnglish(_ text: String, _ translation: TurnTranslation?, bilingual: Bool) -> String? {
        guard bilingual, translation?.state == .done else { return nil }
        let english = BilingualEnglish.prose(text)
        return english.isEmpty ? nil : english
    }

    /// The English under an agent reply with both languages on, drawn whole under the divider: the
    /// event's own text, once there is a translation to sit above it and only when the two do not pair
    /// block by block (`replyPairs`). Nil draws no block (pending, failed, off, or interleaved).
    public static func replyEnglish(_ text: String, _ translation: ReplyTranslation?, bilingual: Bool) -> String? {
        guard bilingual, let translated = translation?.text, BilingualPairs.pairs(translated, text) == nil else { return nil }
        let english = BilingualEnglish.prose(text)
        return english.isEmpty ? nil : english
    }

    /// An agent reply with both languages on, block by block (03-interleaved.png): the translation's
    /// blocks with the original's under them. Nil draws the reply as before (pending, failed, off, or
    /// the two not pairing, frame 4).
    public static func replyPairs(_ text: String, _ translation: ReplyTranslation?, bilingual: Bool) -> [BilingualPairs.Pair]? {
        guard bilingual, let translated = translation?.text else { return nil }
        return BilingualPairs.pairs(translated, text)
    }

    /// Whether Settings draws the switch disabled with the notice (board frame 2). Only a `me` that
    /// says so: a login payload (no field at all) is not a server without a key.
    public static func unavailable(_ user: User?) -> Bool {
        user?.translationAvailable == false
    }

    /// Until when the server is skipping a failing translator (`translationUnavailableUntil`, board frame 6), or nil
    /// when it is not, the instant has passed, or the value does not parse. Non-nil: the composer tag reads
    /// "unavailable, messages will wait". The server does not say when it passes: draw the ordinary tag again then.
    public static func temporarilyUnavailableUntil(_ user: User?, now: Date = Date()) -> Date? {
        guard let raw = user?.translationUnavailableUntil else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let until = fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw), until > now else { return nil }
        return until
    }

    /// Whether a refusal is the 422 TRANSLATION_FAILED a decision whose owner's words could not be
    /// translated is answered with (1A): nothing was recorded, and the card offers Retry and Send as
    /// written instead of reporting a failure.
    public static func refusedUntranslated(_ error: Error) -> Bool {
        guard case APIError.http(let status, let body)? = error as? APIError, status == 422 else { return false }
        return body?.contains("TRANSLATION_FAILED") == true
    }

    /// Why the server could not translate the owner's words, read off that 422's body
    /// (`TranslationFailedBody`): the reason and, beside HTTP, the translator's status. Nil for any
    /// other error, or a refusal from a server that does not say why.
    public static func refusalReason(_ error: Error) -> (reason: TranslationFailureReason, httpStatus: Int?)? {
        guard refusedUntranslated(error),
              case APIError.http(_, let body)? = error as? APIError,
              let data = body?.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let reason = (object["failureReason"] as? String).flatMap(TranslationFailureReason.init(rawValue:))
        else { return nil }
        return (reason, (object["httpStatus"] as? NSNumber)?.intValue)
    }

    /// The line under a card answer the server refused with 422 TRANSLATION_FAILED (frame 5): why,
    /// naming "your answer", then Retry and Send as written. `.retryTurn` sends the answer again and
    /// `.sendAsWritten` sends it with `sendAsWritten: true`.
    public static func refusedAnswerFoot(_ reason: TranslationFailureReason?, httpStatus: Int? = nil) -> [FootPart] {
        [.text(TranslationCopy.sendFailed(reason, httpStatus: httpStatus, answer: true)),
         .action(TranslationCopy.retry, .retryTurn),
         .action(TranslationCopy.sendAsWritten, .sendAsWritten)]
    }

    /// The same line read straight off the refusal (`refusalReason`); the generic line when the
    /// server did not say why.
    public static func refusedAnswerFoot(after error: Error) -> [FootPart] {
        let why = refusalReason(error)
        return refusedAnswerFoot(why?.reason, httpStatus: why?.httpStatus)
    }

    /// One piece of the line under a translated message.
    public enum FootPart: Equatable, Sendable {
        /// Plain words ("Translated", "Couldn't translate, so it wasn't sent").
        case text(String)
        /// The grey chip ("Translating…", "Translates when the reply is done").
        case chip(String)
        /// A link-styled press.
        case action(String, FootAction)
    }

    public enum FootAction: Equatable, Sendable {
        case flip, retryTurn, sendAsWritten, retryReply
        /// Withdraw a held message that failed to translate (`offersCancel`).
        case cancelTurn
        /// "Show both languages": hide this message's original, or bring it back.
        case hideOriginal
    }

    /// The line under the owner's message (frames 4–6): "Show original" ↔ "Show translation" once
    /// delivered, the press alone — it shares the copy/time line, and having an original already says
    /// it was translated (docs/mocks/translation-foot-one-line, B); the "Translating…" chip while held; and,
    /// held because the translation failed (1A), "Couldn't translate, so it wasn't sent · Retry ·
    /// Send as written", then "· Cancel" where `cancellable` (`offersCancel`). Nothing for a message sent as written.
    /// With both languages on (`bilingual`) a delivered message's English is in the bubble, so its foot
    /// reads "Sent to the agent in English" (naming `agentLanguage`) and offers no flip (02-bilingual.png, mark C),
    /// but "Hide original" ↔ "Show both" for its English (`originalHidden`, docs/mocks/translation-hide-original).
    public static func userFoot(_ translation: TurnTranslation?, flipped: Bool, bilingual: Bool = false,
                                agentLanguage: TranslationLanguage = .agentDefault,
                                originalHidden: Bool = false, cancellable: Bool = false) -> [FootPart] {
        guard let translation else { return [] }
        if bilingual, translation.state == .done {
            return [.text(TranslationCopy.sentToAgentLabel(agentLanguage)), hideOriginalAction(originalHidden)]
        }
        switch translation.state {
        case .translating:
            return [.chip(TranslationCopy.translating)]
        case .failed:
            return [.text(TranslationCopy.sendFailed(translation.failureReason, httpStatus: translation.httpStatus)),
                    .action(TranslationCopy.retry, .retryTurn),
                    .action(TranslationCopy.sendAsWritten, .sendAsWritten)]
                + (cancellable ? [.action(TranslationCopy.cancel, .cancelTurn)] : [])
        case .done:
            return [flipped ? .action(TranslationCopy.showTranslation, .flip)
                            : .action(TranslationCopy.showOriginal, .flip)]
        case .sentAsWritten:
            return []
        }
    }

    /// Whether a held message's failed line offers Cancel: it has the turn id the DELETE keys on, and
    /// is not the session's opening prompt, which the server keeps (web: `canCancelTurn`).
    public static func offersCancel(_ bubble: UserBubble) -> Bool {
        bubble.translation?.state == .failed && bubble.turnId != nil && !bubble.opening
    }

    /// The line under an agent reply: "Translated · Show original" ↔ "Original · Show translation";
    /// failed (2A), "Couldn't translate this reply · Retry"; still to come, the chip "Translates when
    /// the reply is done".
    /// With both languages on, a translated reply's foot is "Translated · Hide original" ↔ "Translated ·
    /// Show both" (`originalHidden`, docs/mocks/translation-hide-original).
    public static func replyFoot(_ translation: ReplyTranslation?, pending: Bool, flipped: Bool,
                                 bilingual: Bool = false, originalHidden: Bool = false) -> [FootPart] {
        if let translation, translation.failed {
            return [.text(TranslationCopy.replyFailed), .action(TranslationCopy.retry, .retryReply)]
        }
        if bilingual, translation?.text != nil {
            return [.text(TranslationCopy.translated), hideOriginalAction(originalHidden)]
        }
        if translation?.text != nil {
            return flipped
                ? [.text(TranslationCopy.original), .action(TranslationCopy.showTranslation, .flip)]
                : [.text(TranslationCopy.translated), .action(TranslationCopy.showOriginal, .flip)]
        }
        return pending ? [.chip(TranslationCopy.replyPending)] : []
    }

    /// "Hide original", or "Show both" once this message's original is hidden.
    private static func hideOriginalAction(_ hidden: Bool) -> FootPart {
        .action(hidden ? TranslationCopy.showBoth : TranslationCopy.hideOriginal, .hideOriginal)
    }

    /// The words the owner's bubble shows: what they wrote, unless a delivered message is flipped to
    /// the English the agent got (`text`). Copy hands back the same.
    public static func shownUserText(_ text: String, _ translation: TurnTranslation?, flipped: Bool) -> String {
        guard let translation else { return text }
        if translation.state == .done { return flipped ? text : translation.original }
        // Held, or sent as written: what they wrote is all there is to show.
        return translation.original.isEmpty ? text : translation.original
    }

    /// The words a reply shows: its translation, unless flipped (or there is none).
    public static func shownReplyText(_ text: String, _ translation: ReplyTranslation?, flipped: Bool) -> String {
        guard let t = translation?.text, !flipped else { return text }
        return t
    }
}

/// An owner card that lives outside a session (board 04-owner-cards.html), in the owner's language:
/// a coordinator's question, start or done request (`ProjectOpenItemRow.translation`,
/// `ProjectClosedQuestion.translation`), an owner request, an owner-confirmation review or PROBLEMS
/// record, a crossing or a criteria-change proposal (@orbit/shared `OwnerCardTranslation`). Each field
/// is the card's field of the same name translated, present only when the original has text; arrays go
/// index for index with the card's. Read leniently: a field this build cannot read is a field it does
/// not draw, never a card that fails to decode. `lang` is kept as the server spelled it, so one this
/// build does not know is a translation that matches no owner language.
public struct OwnerCardTranslation: Codable, Equatable, Sendable {
    public struct Option: Codable, Equatable, Sendable {
        public var label: String?
        public var description: String?
        public init(label: String? = nil, description: String? = nil) {
            self.label = label
            self.description = description
        }
    }
    /// A step's, a PROBLEMS record's problem's or any other entry's `text`.
    public struct Text: Codable, Equatable, Sendable {
        public var text: String?
        public init(text: String? = nil) { self.text = text }
    }
    public struct Gap: Codable, Equatable, Sendable {
        public var title: String?
        public var whyNotProven: String?
        public var coordinatorChecked: String?
        public init(title: String? = nil, whyNotProven: String? = nil, coordinatorChecked: String? = nil) {
            self.title = title
            self.whyNotProven = whyNotProven
            self.coordinatorChecked = coordinatorChecked
        }
    }
    public struct NeedsYou: Codable, Equatable, Sendable {
        public var text: String?
        public var options: [Option]?
        public init(text: String? = nil, options: [Option]? = nil) {
            self.text = text
            self.options = options
        }
    }

    public var lang: String
    /// The card could not be translated: draw it as the agent wrote it. Nothing else is set.
    public var failed: Bool
    public var question: String?
    public var options: [Option]?
    public var ifUnanswered: String?
    public var title: String?
    public var why: String?
    public var steps: [Text]?
    public var verifyHint: String?
    public var judgment: String?
    public var gaps: [Gap]?
    public var needsYou: [NeedsYou]?
    public var reason: String?
    public var problems: [Text]?
    public var proposed: [TranslatedCriterionItem]?
    /// An open coordinator question's `detailLine` built from the translated `ifUnanswered`, served by the
    /// open-items read beside a whole translation in the owner's language. Absent from an older server.
    public var detailLine: String?
    /// An open item's `handoverNote`: the coordinator's reason for handing it to the owner. Absent from
    /// an older server.
    public var handoverNote: String?

    public init(lang: String, failed: Bool = false, question: String? = nil, options: [Option]? = nil,
                ifUnanswered: String? = nil, title: String? = nil, why: String? = nil,
                steps: [Text]? = nil, verifyHint: String? = nil, judgment: String? = nil,
                gaps: [Gap]? = nil, needsYou: [NeedsYou]? = nil, reason: String? = nil,
                problems: [Text]? = nil, proposed: [TranslatedCriterionItem]? = nil,
                detailLine: String? = nil, handoverNote: String? = nil) {
        self.lang = lang
        self.failed = failed
        self.question = question
        self.options = options
        self.ifUnanswered = ifUnanswered
        self.title = title
        self.why = why
        self.steps = steps
        self.verifyHint = verifyHint
        self.judgment = judgment
        self.gaps = gaps
        self.needsYou = needsYou
        self.reason = reason
        self.problems = problems
        self.proposed = proposed
        self.detailLine = detailLine
        self.handoverNote = handoverNote
    }

    private enum CodingKeys: String, CodingKey {
        case lang, failed, question, options, ifUnanswered, title, why, steps, verifyHint, judgment
        case gaps, needsYou, reason, problems, proposed, detailLine, handoverNote
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lang = (try? c.decodeIfPresent(String.self, forKey: .lang)) ?? ""
        failed = ((try? c.decodeIfPresent(Bool.self, forKey: .failed)) ?? nil) == true
        question = (try? c.decodeIfPresent(String.self, forKey: .question)) ?? nil
        options = (try? c.decodeIfPresent([Option].self, forKey: .options)) ?? nil
        ifUnanswered = (try? c.decodeIfPresent(String.self, forKey: .ifUnanswered)) ?? nil
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        why = (try? c.decodeIfPresent(String.self, forKey: .why)) ?? nil
        steps = (try? c.decodeIfPresent([Text].self, forKey: .steps)) ?? nil
        verifyHint = (try? c.decodeIfPresent(String.self, forKey: .verifyHint)) ?? nil
        judgment = (try? c.decodeIfPresent(String.self, forKey: .judgment)) ?? nil
        gaps = (try? c.decodeIfPresent([Gap].self, forKey: .gaps)) ?? nil
        needsYou = (try? c.decodeIfPresent([NeedsYou].self, forKey: .needsYou)) ?? nil
        reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil
        problems = (try? c.decodeIfPresent([Text].self, forKey: .problems)) ?? nil
        proposed = (try? c.decodeIfPresent([TranslatedCriterionItem].self, forKey: .proposed)) ?? nil
        detailLine = (try? c.decodeIfPresent(String.self, forKey: .detailLine)) ?? nil
        handoverNote = (try? c.decodeIfPresent(String.self, forKey: .handoverNote)) ?? nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(lang, forKey: .lang)
        if failed { try c.encode(true, forKey: .failed) }
        try c.encodeIfPresent(question, forKey: .question)
        try c.encodeIfPresent(options, forKey: .options)
        try c.encodeIfPresent(ifUnanswered, forKey: .ifUnanswered)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(why, forKey: .why)
        try c.encodeIfPresent(steps, forKey: .steps)
        try c.encodeIfPresent(verifyHint, forKey: .verifyHint)
        try c.encodeIfPresent(judgment, forKey: .judgment)
        try c.encodeIfPresent(gaps, forKey: .gaps)
        try c.encodeIfPresent(needsYou, forKey: .needsYou)
        try c.encodeIfPresent(reason, forKey: .reason)
        try c.encodeIfPresent(problems, forKey: .problems)
        try c.encodeIfPresent(proposed, forKey: .proposed)
        try c.encodeIfPresent(detailLine, forKey: .detailLine)
        try c.encodeIfPresent(handoverNote, forKey: .handoverNote)
    }
}

/// A completion-evidence revision's `claim` and `gaps` in the owner's language (`translation` on a
/// pending evidence judgment, @orbit/shared `EvidenceTranslation`). `gaps` goes index for index.
public struct EvidenceTranslation: Codable, Equatable, Sendable {
    public var lang: String
    public var failed: Bool
    public var claim: String?
    public var gaps: [String]?

    public init(lang: String, failed: Bool = false, claim: String? = nil, gaps: [String]? = nil) {
        self.lang = lang
        self.failed = failed
        self.claim = claim
        self.gaps = gaps
    }

    private enum CodingKeys: String, CodingKey { case lang, failed, claim, gaps }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lang = (try? c.decodeIfPresent(String.self, forKey: .lang)) ?? ""
        failed = ((try? c.decodeIfPresent(Bool.self, forKey: .failed)) ?? nil) == true
        claim = (try? c.decodeIfPresent(String.self, forKey: .claim)) ?? nil
        gaps = (try? c.decodeIfPresent([String].self, forKey: .gaps)) ?? nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(lang, forKey: .lang)
        if failed { try c.encode(true, forKey: .failed) }
        try c.encodeIfPresent(claim, forKey: .claim)
        try c.encodeIfPresent(gaps, forKey: .gaps)
    }
}

/// A project's title and its criteria's text in the owner's language (`translation` on
/// `GET /projects/:id`, @orbit/shared `ProjectTextTranslation`): what "Is this project done?", its
/// Done when list and the why-not-done card draw. Served only in the owner's current language while
/// it matches the project's words, and with translation on. `criteria` is keyed by the criterion's
/// `id`, never by position. Read leniently, like `OwnerCardTranslation`: a field this build cannot
/// read is one it does not draw.
public struct ProjectTextTranslation: Codable, Equatable, Sendable {
    public struct Criterion: Codable, Equatable, Sendable {
        public var id: String
        public var text: String
        public init(id: String, text: String) {
            self.id = id
            self.text = text
        }
    }

    public var lang: String
    /// The project's words could not be translated: draw them as the agent wrote them.
    public var failed: Bool
    public var title: String?
    public var criteria: [Criterion]?

    public init(lang: String, failed: Bool = false, title: String? = nil, criteria: [Criterion]? = nil) {
        self.lang = lang
        self.failed = failed
        self.title = title
        self.criteria = criteria
    }

    private enum CodingKeys: String, CodingKey { case lang, failed, title, criteria }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lang = (try? c.decodeIfPresent(String.self, forKey: .lang)) ?? ""
        failed = ((try? c.decodeIfPresent(Bool.self, forKey: .failed)) ?? nil) == true
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil
        criteria = ((try? c.decodeIfPresent([LossyDecodable<Criterion>].self, forKey: .criteria)) ?? nil)?
            .compactMap(\.value)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(lang, forKey: .lang)
        if failed { try c.encode(true, forKey: .failed) }
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(criteria, forKey: .criteria)
    }
}
