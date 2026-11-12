import Foundation

// Settings › Translation (board docs/mocks/session-translation/01-board.png, frames 7–8; behaviour
// as frames 4–6). The server owns the feature — it translates with its own DeepSeek key — so this
// file only reads the fields it writes (@orbit/shared translation.ts) and says them in the web's
// words (`TranslationCopyParityTests` reads them back out of the web sources).

/// "Your language": the seven the owner may write and read in (decision 5A), in the web's order.
/// "Agents work in" is fixed to English and is not a choice.
public enum TranslationLanguage: String, CaseIterable, Codable, Equatable, Sendable {
    case zhHans = "zh-Hans"
    case zhHant = "zh-Hant"
    case ja, ko, es, fr, de

    /// What a preference without a language means: the board's default pick.
    public static let `default`: TranslationLanguage = .zhHans

    /// The language's English name, as Settings lists it (`TRANSLATION_LANGUAGE_NAMES`).
    public var name: String {
        switch self {
        case .zhHans: return "Chinese (Simplified)"
        case .zhHant: return "Chinese (Traditional)"
        case .ja:     return "Japanese"
        case .ko:     return "Korean"
        case .es:     return "Spanish"
        case .fr:     return "French"
        case .de:     return "German"
        }
    }

    /// The composer tag (6A): "<Language> → English", the language without its parenthesis —
    /// "Chinese → English".
    public var tag: String {
        let bare = name.range(of: " (").map { String(name[..<$0.lowerBound]) } ?? name
        return "\(bare) → English"
    }
}

/// The words every client shows about translation, byte for byte the web's (`TRANSLATION_COPY` in
/// src/web/src/lib/translation.ts and the Translation card of src/web/src/pages/SettingsPage.tsx).
public enum TranslationCopy {
    // MARK: Settings › Translation
    public static let title = "Translation"
    public static let translateConversations = "Translate conversations"
    public static let translateConversationsHint = "Agents read and write in English; you write and read in your language. Your messages are translated before the agent gets them, its replies before you see them. Tool calls, output and code stay as they are."
    public static let yourLanguage = "Your language"
    public static let yourLanguageHint = "What you write in, and what replies are shown in."
    public static let agentsWorkIn = "Agents work in"
    public static let agentsWorkInHint = "What the agent receives and answers in."
    public static let english = "English"
    public static let footnote = "Translated by the server's DeepSeek model. Applies to every session from its next message; what's already in a conversation stays as it was."
    /// Board frame 2: the server has no DeepSeek key, so the switch is drawn disabled.
    public static let unavailable = "This server has no DeepSeek key, so it can't translate. Whoever runs it sets DEEPSEEK_API_KEY and restarts it."

    // MARK: In a conversation (frames 4–6)
    public static let translated = "Translated"
    public static let showOriginal = "Show original"
    public static let showTranslation = "Show translation"
    public static let sentInEnglish = "Sent to the agent in English"
    public static let original = "Original"
    public static let translating = "Translating…"
    public static let sendFailed = "Couldn't translate, so it wasn't sent"
    public static let retry = "Retry"
    public static let sendAsWritten = "Send as written"
    public static let replyPending = "Translates when the reply is done"
    public static let replyFailed = "Couldn't translate this reply"
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

/// The `translation` of a translated turn — on the queued/active turn list, a send's answer, and
/// the runner's `user` event. Absent on every message translation was not involved in.
public struct TurnTranslation: Codable, Equatable, Sendable {
    public var state: TurnTranslationState
    /// The language the owner wrote in. The target is always English.
    public var from: TranslationLanguage
    /// What the owner typed, as typed.
    public var original: String

    public init(state: TurnTranslationState, from: TranslationLanguage, original: String) {
        self.state = state
        self.from = from
        self.original = original
    }

    /// Read off a payload's raw `translation`; nil unless every field is one this client knows,
    /// so a stray value never draws a foot that lies (web: `turnTranslationOf`).
    public static func parse(_ value: JSONValue?) -> TurnTranslation? {
        guard let value,
              let state = value["state"]?.stringValue.flatMap(TurnTranslationState.init(rawValue:)),
              let from = value["from"]?.stringValue.flatMap(TranslationLanguage.init(rawValue:)),
              let original = value["original"]?.stringValue else { return nil }
        return TurnTranslation(state: state, from: from, original: original)
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

    public init(lang: TranslationLanguage, failed: Bool = false, description: String? = nil,
                plan: String? = nil, questions: [TranslatedQuestion]? = nil) {
        self.lang = lang
        self.failed = failed
        self.description = description
        self.plan = plan
        self.questions = questions
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
        return ApprovalTranslation(lang: lang, failed: value["failed"]?.boolValue == true,
                                   description: value["description"]?.stringValue,
                                   plan: value["plan"]?.stringValue, questions: questions)
    }

    /// The card's `input` as it is shown: the questions, a tool card's description and a plan in the
    /// owner's language, wherever the server translated them, and the English everywhere else. Answers
    /// are keyed by what is shown; the server maps a translated question and label back to the
    /// original before the engine reads them (web: `shownQuestions`).
    public static func shownInput(_ input: JSONValue?, _ translation: ApprovalTranslation?) -> JSONValue? {
        guard let translation, !translation.failed, case .object(var obj)? = input else { return input }
        if let d = nonEmpty(translation.description), obj["description"] != nil { obj["description"] = .string(d) }
        if let p = nonEmpty(translation.plan), obj["plan"] != nil { obj["plan"] = .string(p) }
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

    private static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}

/// What the account's translation setting comes to, and what a translated message says under it.
public enum SessionTranslation {
    /// The language the account writes and reads in; absent (or unknown) is the default pick.
    public static func language(_ prefs: UserPreferences?) -> TranslationLanguage {
        prefs?.translationLanguage.flatMap(TranslationLanguage.init(rawValue:)) ?? .default
    }

    /// Whether the owner's messages are being translated now: switched on, and the server able to.
    public static func isOn(_ user: User?) -> Bool {
        user?.preferences?.translationEnabled == true && user?.translationAvailable == true
    }

    /// Whether Settings draws the switch disabled with the notice (board frame 2). Only a `me` that
    /// says so: a login payload (no field at all) is not a server without a key.
    public static func unavailable(_ user: User?) -> Bool {
        user?.translationAvailable == false
    }

    /// Whether a refusal is the 422 TRANSLATION_FAILED a decision whose owner's words could not be
    /// translated is answered with (1A): nothing was recorded, and the card offers Retry and Send as
    /// written instead of reporting a failure.
    public static func refusedUntranslated(_ error: Error) -> Bool {
        guard case APIError.http(let status, let body)? = error as? APIError, status == 422 else { return false }
        return body?.contains("TRANSLATION_FAILED") == true
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
    }

    /// The line under the owner's message (frames 4–6): "Translated · Show original" ↔ "Sent to the
    /// agent in English · Show translation" once delivered; the "Translating…" chip while held; and,
    /// held because the translation failed (1A), "Couldn't translate, so it wasn't sent · Retry ·
    /// Send as written". Nothing for a message sent as written.
    public static func userFoot(_ translation: TurnTranslation?, flipped: Bool) -> [FootPart] {
        guard let translation else { return [] }
        switch translation.state {
        case .translating:
            return [.chip(TranslationCopy.translating)]
        case .failed:
            return [.text(TranslationCopy.sendFailed),
                    .action(TranslationCopy.retry, .retryTurn),
                    .action(TranslationCopy.sendAsWritten, .sendAsWritten)]
        case .done:
            return flipped
                ? [.text(TranslationCopy.sentInEnglish), .action(TranslationCopy.showTranslation, .flip)]
                : [.text(TranslationCopy.translated), .action(TranslationCopy.showOriginal, .flip)]
        case .sentAsWritten:
            return []
        }
    }

    /// The line under an agent reply: "Translated · Show original" ↔ "Original · Show translation";
    /// failed (2A), "Couldn't translate this reply · Retry"; still to come, the chip "Translates when
    /// the reply is done".
    public static func replyFoot(_ translation: ReplyTranslation?, pending: Bool, flipped: Bool) -> [FootPart] {
        if let translation, translation.failed {
            return [.text(TranslationCopy.replyFailed), .action(TranslationCopy.retry, .retryReply)]
        }
        if translation?.text != nil {
            return flipped
                ? [.text(TranslationCopy.original), .action(TranslationCopy.showTranslation, .flip)]
                : [.text(TranslationCopy.translated), .action(TranslationCopy.showOriginal, .flip)]
        }
        return pending ? [.chip(TranslationCopy.replyPending)] : []
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
